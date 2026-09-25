import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The on-disk session folder is the contract between phases (recording → transcription →
 * transcript → summary → publish). Everything downstream of recording reads only this.
 */
export const paths = {
  session: (dir: string) => join(dir, 'session.json'),
  participants: (dir: string) => join(dir, 'participants.json'),
  audioDir: (dir: string) => join(dir, 'audio'),
  utterances: (dir: string) => join(dir, 'utterances.jsonl'),
  batchesDir: (dir: string) => join(dir, 'transcription', 'batches'),
  rawDir: (dir: string) => join(dir, 'transcription', 'raw'),
  speakerTranscript: (dir: string, userId: string) => join(dir, 'transcripts', `${userId}.json`),
  transcriptsDir: (dir: string) => join(dir, 'transcripts'),
  segments: (dir: string) => join(dir, 'segments.json'),
  transcript: (dir: string) => join(dir, 'transcript.md'),
};

export interface SessionInfo {
  id: string;
  startedAt: number;
  stoppedAt?: number;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
}

export interface Participant {
  displayName: string;
  username?: string;
}

export interface UtteranceFile {
  userId: string;
  /** Epoch ms of the utterance's first packet (from the filename). */
  startMs: number;
  path: string;
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Lists utterance audio by scanning audio/<userId>/<startEpochMs>.ogg. Filenames are the source
 * of truth, so a session that crashed before writing its indexes is still fully recoverable.
 */
export function listUtterances(sessionDir: string): UtteranceFile[] {
  const audioDir = paths.audioDir(sessionDir);
  if (!existsSync(audioDir)) return [];
  const out: UtteranceFile[] = [];
  for (const userId of readdirSync(audioDir)) {
    if (!/^\d+$/.test(userId)) continue;
    for (const name of readdirSync(join(audioDir, userId))) {
      const m = /^(\d+)\.ogg$/.exec(name);
      if (m) out.push({ userId, startMs: Number(m[1]), path: join(audioDir, userId, name) });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.userId.localeCompare(b.userId));
}

export function readSessionInfo(sessionDir: string): SessionInfo {
  const info = readJson<SessionInfo>(paths.session(sessionDir));
  if (info) return info;
  // Older/crashed sessions: derive from the audio.
  const first = listUtterances(sessionDir)[0];
  return { id: sessionDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'session', startedAt: first?.startMs ?? Date.now() };
}

export function readParticipants(sessionDir: string): Record<string, Participant> {
  return readJson<Record<string, Participant>>(paths.participants(sessionDir)) ?? {};
}
