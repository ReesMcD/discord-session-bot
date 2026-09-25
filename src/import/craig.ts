import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Config } from '../config/schema.js';
import { paths, writeJson, type Participant, type SessionInfo } from '../session/layout.js';
import { mapLimit } from '../util/retry.js';
import { detectSilence, extractOpus, speechRegions } from './silence.js';

export interface CraigTrack {
  track: number;
  username: string;
  userId?: string;
}

export interface CraigInfo {
  recordingId: string;
  startTime: number;
  guild?: string;
  channel?: string;
  tracks: CraigTrack[];
}

/**
 * Parses Craig's info.txt:
 *   Recording <id> / Guild: <name> (<id>) / Channel: ... / Start time: <ISO> / Tracks: \t<user>#<discrim> (<id>)
 * Tracks are listed in track-number order.
 */
export function parseCraigInfo(text: string): CraigInfo {
  const lines = text.split(/\r?\n/);
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const recordingId = /^Recording (\S+)/.exec(lines[0] ?? '')?.[1] ?? 'unknown';
  const start = field('Start time');
  const startTime = start ? Date.parse(start) : NaN;
  if (Number.isNaN(startTime)) throw new Error(`info.txt has no valid "Start time" (got ${JSON.stringify(start)})`);

  const tracks: CraigTrack[] = [];
  const at = lines.findIndex((l) => l.trim() === 'Tracks:');
  for (const line of at >= 0 ? lines.slice(at + 1) : []) {
    if (!/^\s+\S/.test(line)) break;
    const m = /^\s+(.+?)(?:#(\d+))?(?: \((\d+)\))?\s*$/.exec(line);
    if (!m) continue;
    tracks.push({ track: tracks.length + 1, username: m[1]!, ...(m[3] ? { userId: m[3] } : {}) });
  }
  const guild = field('Guild')?.replace(/ \(\d+\)$/, '');
  const channel = field('Channel')?.replace(/ \(\d+\)$/, '');
  return { recordingId, startTime, ...(guild ? { guild } : {}), ...(channel ? { channel } : {}), tracks };
}

const AUDIO_EXT = /\.(flac|ogg|opus|m4a|aac|wav|mp3)$/i;

/** Finds track audio files named "<track>-<username>.<ext>" (Craig's naming). */
export function findTrackFiles(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)-.+/.exec(name);
    if (m && AUDIO_EXT.test(name)) out.set(Number(m[1]), join(dir, name));
  }
  return out;
}

function unzip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-q', '-o', zip, '-d', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.once('error', (err) => reject(new Error(`could not run unzip (${err.message}); unzip the export yourself and pass the folder`)));
    proc.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip failed: ${stderr.trim()}`))));
  });
}

export interface ImportResult {
  sessionDir: string;
  sessionId: string;
  speakers: { track: number; name: string; userId: string; utterances: number; speechSec: number; skipped?: string }[];
}

/**
 * Converts a Craig multi-track export (zip or extracted folder) into a session folder:
 * each track is split into utterances at silences and written as audio/<userId>/<startMs>.ogg,
 * the same layout the bot records, so the normal transcribe/merge steps apply unchanged.
 */
export async function importCraig(
  input: string,
  dataDir: string,
  config: Config,
  log: (msg: string) => void = console.log,
): Promise<ImportResult> {
  let dir = input;
  let tmp: string | undefined;
  if (statSync(input).isFile()) {
    tmp = mkdtempSync(join(tmpdir(), 'craig-'));
    log(`Unzipping ${basename(input)}…`);
    await unzip(input, tmp);
    dir = tmp;
    // Some zips wrap everything in one folder.
    const entries = readdirSync(dir);
    if (entries.length === 1 && statSync(join(dir, entries[0]!)).isDirectory()) dir = join(dir, entries[0]!);
  }

  try {
    const infoPath = join(dir, 'info.txt');
    if (!existsSync(infoPath)) throw new Error(`No info.txt in ${input}; is this a Craig multi-track export?`);
    const info = parseCraigInfo(readFileSync(infoPath, 'utf8'));
    const files = findTrackFiles(dir);
    if (files.size === 0) throw new Error(`No track files (like "1-name.flac") in ${input}`);

    const sessionId = `craig-${info.recordingId}`;
    const sessionDir = join(dataDir, 'sessions', sessionId);
    if (existsSync(paths.audioDir(sessionDir))) throw new Error(`${sessionDir} already has audio; delete it to re-import`);
    mkdirSync(sessionDir, { recursive: true });

    const ignore = new Set(config.recording.ignore_users);
    const participants: Record<string, Participant> = {};
    const speakers: ImportResult['speakers'] = [];
    let longestSec = 0;

    for (const [track, file] of [...files].sort((a, b) => a[0] - b[0])) {
      const meta = info.tracks[track - 1];
      const username = meta?.username ?? basename(file).replace(/^\d+-/, '').replace(AUDIO_EXT, '');
      const userId = meta?.userId ?? `track${track}`;
      if (ignore.has(userId)) {
        speakers.push({ track, name: username, userId, utterances: 0, speechSec: 0, skipped: 'ignored_user' });
        log(`  track ${track} ${username}: skipped (in recording.ignore_users)`);
        continue;
      }
      participants[userId] = { displayName: username, username };

      log(`  track ${track} ${username}: finding speech…`);
      const { silences, totalSec } = await detectSilence(file, { minSilenceSec: config.recording.silence_ms / 1000 });
      longestSec = Math.max(longestSec, totalSec);
      const regions = speechRegions(silences, totalSec, { padSec: 0.15, minSec: config.transcription.min_utterance_ms / 1000, joinGapSec: 0.3 });
      const outDir = join(paths.audioDir(sessionDir), userId);
      mkdirSync(outDir, { recursive: true });
      await mapLimit(regions, 4, (r) => extractOpus(file, r, join(outDir, `${Math.round(info.startTime + r.startSec * 1000)}.ogg`)));
      const speechSec = regions.reduce((n, r) => n + r.endSec - r.startSec, 0);
      speakers.push({ track, name: username, userId, utterances: regions.length, speechSec });
      log(`  track ${track} ${username}: ${regions.length} utterances, ${(speechSec / 60).toFixed(1)} min of speech`);
    }

    const session: SessionInfo = {
      id: sessionId,
      startedAt: info.startTime,
      stoppedAt: Math.round(info.startTime + longestSec * 1000),
      ...(info.guild ? { guildName: info.guild } : {}),
      ...(info.channel ? { channelName: info.channel } : {}),
    };
    writeJson(paths.session(sessionDir), { ...session, source: 'craig' });
    writeJson(paths.participants(sessionDir), participants);
    return { sessionDir, sessionId, speakers };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
