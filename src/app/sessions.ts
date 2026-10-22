import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listUtterances, paths, readJson, readParticipants, readSessionInfo, writeJson, type Participant, type SessionInfo } from '../session/layout.js';
import { sessionTitle } from '../session/title.js';
import { campaignFor } from '../config/campaign.js';
import { configSchema } from '../config/schema.js';
import type { TranscriptLine } from '../transcript/merge.js';
import { readEditState, recapState, type RecapState } from '../summary/recapEdits.js';
import { uploadStatus } from '../upload/recapUpload.js';
import { summaryPaths, type SummaryMeta } from '../summary/summarizeSession.js';
import type { Person, SessionDetail, SessionSummary } from '../shared/types.js';
import type { Config } from '../config/schema.js';
import { pendingUnpaired } from './unpaired.js';

export type { Person, SessionDetail, SessionSummary };

const SESSION_ID = /^[\w.-]+$/;

export function sessionsRoot(dataDir: string): string {
  return join(dataDir, 'sessions');
}

/** Resolves a session id to its folder, refusing anything that could escape the sessions root. */
export function sessionDirFor(dataDir: string, id: string): string | undefined {
  if (!SESSION_ID.test(id) || id === '.' || id === '..') return undefined;
  const dir = join(sessionsRoot(dataDir), id);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

function segmentsOf(dir: string, file: string): { session?: SessionInfo; lines: TranscriptLine[] } {
  return readJson<{ session?: SessionInfo; lines: TranscriptLine[] }>(file) ?? { lines: [] };
}

/** Settings to name sessions by; the defaults while config.yaml has an error. */
const settings = (config: Config | null) => config ?? configSchema.parse({});

export function describeSession(dataDir: string, id: string, config: Config | null = null): SessionSummary | undefined {
  const dir = sessionDirFor(dataDir, id);
  if (!dir) return undefined;
  const info = readSessionInfo(dir) as SessionInfo & { source?: string; interrupted?: boolean };
  const cfg = settings(config);
  const campaign = campaignFor(cfg, info);
  const participants = readParticipants(dir);
  const utterances = listUtterances(dir);
  const lines = segmentsOf(dir, paths.segments(dir)).lines;
  const speakers = lines.length
    ? [...new Set(lines.map((l) => l.speaker))]
    : [...new Set(utterances.map((u) => participants[u.userId]?.displayName ?? u.userId))];
  return {
    id,
    title: sessionTitle(info, cfg),
    customTitle: !!info.title?.trim(),
    campaign: campaign ? { key: campaign.channelId, name: campaign.name ?? null, picked: !!info.campaign && info.campaign === campaign.channelId } : null,
    startedAt: info.startedAt,
    ...(info.stoppedAt ? { stoppedAt: info.stoppedAt } : {}),
    ...(info.channelName ? { channelName: info.channelName } : {}),
    ...(info.guildName ? { guildName: info.guildName } : {}),
    ...(info.source ? { source: info.source } : {}),
    ...(info.interrupted ? { interrupted: true } : {}),
    ...(info.audioDeletedAt ? { audioDeletedAt: info.audioDeletedAt } : {}),
    speakers,
    utterances: utterances.length,
    has: {
      audio: utterances.length > 0,
      transcript: existsSync(paths.transcript(dir)),
      speakerLabels: existsSync(paths.disambiguatedTranscript(dir)),
      summary: existsSync(summaryPaths.markdown(dir)),
    },
  };
}

export function listSessions(dataDir: string, config: Config | null = null): SessionSummary[] {
  const root = sessionsRoot(dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => describeSession(dataDir, id, config))
    .filter((s): s is SessionSummary => !!s)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function sessionDetail(dataDir: string, id: string, config: Config | null = null): SessionDetail | undefined {
  const base = describeSession(dataDir, id, config);
  const dir = sessionDirFor(dataDir, id);
  if (!base || !dir) return undefined;
  const summaryFile = summaryPaths.markdown(dir);
  return {
    ...base,
    participants: readParticipants(dir),
    lines: segmentsOf(dir, paths.segments(dir)).lines,
    speakerLines: existsSync(paths.disambiguatedSegments(dir)) ? segmentsOf(dir, paths.disambiguatedSegments(dir)).lines : null,
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : null,
    summaryMeta: readJson<SummaryMeta>(summaryPaths.meta(dir)) ?? null,
    recapState: recapState(dir),
    editedAt: readEditState(dir)?.editedAt ?? null,
    upload: uploadStatus(dir),
    uploadTo: config?.upload.url ? new URL(config.upload.url).host : null,
    unpaired: pendingUnpaired(dir, config),
  };
}

/**
 * Renames a session or picks its campaign, after the fact. null puts either back: the name to the
 * sessions.title template, the campaign to the voice channel's. The folder (and id) never change.
 */
export function updateSession(dir: string, change: { title?: string | null; campaign?: string | null }, config: Config | null): void {
  const info = readSessionInfo(dir);
  const next: SessionInfo = { ...info };
  if (change.title !== undefined) {
    const title = change.title?.trim().slice(0, 120);
    if (title) next.title = title;
    else delete next.title;
  }
  if (change.campaign !== undefined) {
    if (change.campaign && !settings(config).campaigns[change.campaign]) throw new Error('No such campaign');
    if (change.campaign) next.campaign = change.campaign;
    else delete next.campaign;
  }
  writeJson(paths.session(dir), next);
}

const TRASH_DAYS = 30;
const trashRoot = (dataDir: string) => join(dataDir, 'trash');

/** Moves a session to <data>/trash; it's deleted for good after 30 days (see emptyTrash). */
export function trashSession(dataDir: string, id: string, now = Date.now()): void {
  const dir = sessionDirFor(dataDir, id);
  if (!dir) throw new Error('not found');
  mkdirSync(trashRoot(dataDir), { recursive: true });
  renameSync(dir, join(trashRoot(dataDir), `${now}--${id}`));
}

/** Deletes sessions trashed more than 30 days ago. Returns their ids. */
export function emptyTrash(dataDir: string, now = Date.now()): string[] {
  const root = trashRoot(dataDir);
  if (!existsSync(root)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(root)) {
    const m = /^(\d+)--(.+)$/.exec(name);
    if (!m || now - Number(m[1]) < TRASH_DAYS * 86_400_000) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    gone.push(m[2]!);
  }
  return gone;
}

/** Everyone seen in any session (from participants.json), for picking people by name in Settings. */
export function knownPeople(dataDir: string): Person[] {
  const root = sessionsRoot(dataDir);
  if (!existsSync(root)) return [];
  const people = new Map<string, Person>();
  for (const id of readdirSync(root)) {
    const dir = sessionDirFor(dataDir, id);
    if (!dir) continue;
    const started = readSessionInfo(dir).startedAt;
    for (const [userId, p] of Object.entries(readParticipants(dir))) {
      const person = people.get(userId) ?? { id: userId, names: [], sessions: 0, lastSeen: 0 };
      for (const n of [p.displayName, p.username]) if (n && !person.names.includes(n)) person.names.push(n);
      person.sessions++;
      person.lastSeen = Math.max(person.lastSeen, started);
      people.set(userId, person);
    }
  }
  return [...people.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Downloadable text outputs of a session. */
export const SESSION_FILES = {
  'transcript.md': (dir: string) => paths.transcript(dir),
  'transcript.speakers.md': (dir: string) => paths.disambiguatedTranscript(dir),
  'transcript.clean.md': (dir: string) => paths.cleanTranscript(dir),
  'summary.md': (dir: string) => summaryPaths.markdown(dir),
} as const;
