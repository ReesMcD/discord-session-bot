import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listUtterances, paths, readJson, readParticipants, readSessionInfo, type Participant, type SessionInfo } from '../session/layout.js';
import type { TranscriptLine } from '../transcript/merge.js';
import { summaryPaths, type SummaryMeta } from '../summary/summarizeSession.js';

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

export interface SessionSummary {
  id: string;
  startedAt: number;
  stoppedAt?: number;
  channelName?: string;
  guildName?: string;
  source?: string;
  speakers: string[];
  utterances: number;
  has: { audio: boolean; transcript: boolean; speakerLabels: boolean; summary: boolean };
}

function segmentsOf(dir: string, file: string): { session?: SessionInfo; lines: TranscriptLine[] } {
  return readJson<{ session?: SessionInfo; lines: TranscriptLine[] }>(file) ?? { lines: [] };
}

export function describeSession(dataDir: string, id: string): SessionSummary | undefined {
  const dir = sessionDirFor(dataDir, id);
  if (!dir) return undefined;
  const info = readSessionInfo(dir) as SessionInfo & { source?: string };
  const participants = readParticipants(dir);
  const utterances = listUtterances(dir);
  const lines = segmentsOf(dir, paths.segments(dir)).lines;
  const speakers = lines.length
    ? [...new Set(lines.map((l) => l.speaker))]
    : [...new Set(utterances.map((u) => participants[u.userId]?.displayName ?? u.userId))];
  return {
    id,
    startedAt: info.startedAt,
    ...(info.stoppedAt ? { stoppedAt: info.stoppedAt } : {}),
    ...(info.channelName ? { channelName: info.channelName } : {}),
    ...(info.guildName ? { guildName: info.guildName } : {}),
    ...(info.source ? { source: info.source } : {}),
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

export function listSessions(dataDir: string): SessionSummary[] {
  const root = sessionsRoot(dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => describeSession(dataDir, id))
    .filter((s): s is SessionSummary => !!s)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export interface SessionDetail extends SessionSummary {
  participants: Record<string, Participant>;
  lines: TranscriptLine[];
  speakerLines: TranscriptLine[] | null;
  summary: string | null;
  summaryMeta: SummaryMeta | null;
}

export function sessionDetail(dataDir: string, id: string): SessionDetail | undefined {
  const base = describeSession(dataDir, id);
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
  };
}

export interface Person {
  id: string;
  names: string[];
  sessions: number;
  lastSeen: number;
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
  'summary.md': (dir: string) => summaryPaths.markdown(dir),
} as const;
