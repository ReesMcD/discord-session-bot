import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedAccounts, speakerNames, type Config } from '../config/schema.js';
import { paths, readJson, readParticipants, readSessionInfo, writeJson, type Participant, type SessionInfo } from '../session/layout.js';
import type { SpeakerTranscript } from '../transcription/transcribeSession.js';
import type { SpeakerSegment } from '../transcription/remap.js';

export interface TranscriptLine {
  userId: string;
  speaker: string;
  /** Milliseconds from session start. */
  offsetMs: number;
  startMs: number;
  endMs: number;
  text: string;
  /**
   * Set when the speaker was inferred by the disambiguation pass for a shared account:
   * `account` is the account's own name, `confidence` how sure Claude was.
   */
  inferred?: { account: string; confidence: 'high' | 'low' | 'unclear' };
}

/** Transcript name for a user: config alias → Discord display name at recording time → raw ID. */
export function speakerName(userId: string, aliases: Record<string, string>, participants: Record<string, Participant>): string {
  return aliases[userId] ?? participants[userId]?.displayName ?? userId;
}

/**
 * How a line's speaker is written in transcripts: inferred speakers carry their confidence, e.g.
 * "Hamqueef (?)" for a low-confidence guess or "Rees (unclear)" when Claude couldn't tell.
 */
export function displaySpeaker(line: Pick<TranscriptLine, 'speaker' | 'inferred'>): string {
  if (line.inferred?.confidence === 'low') return `${line.speaker} (?)`;
  if (line.inferred?.confidence === 'unclear') return `${line.speaker} (unclear)`;
  return line.speaker;
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface JoinOptions {
  mergeGapMs: number;
  maxLineMs: number;
  /** Accounts whose lines are never joined (shared accounts, so each line can be relabelled). */
  noJoin?: ReadonlySet<string>;
}

export interface MergeOptions extends JoinOptions {
  sessionStartMs: number;
  aliases: Record<string, string>;
  participants: Record<string, Participant>;
}

/** Joins consecutive lines from the same speaker when the pause is short. Input must be time-ordered. */
export function joinLines(lines: readonly TranscriptLine[], opts: JoinOptions): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.userId === line.userId &&
      prev.speaker === line.speaker &&
      prev.inferred?.confidence === line.inferred?.confidence &&
      !opts.noJoin?.has(line.userId) &&
      line.startMs - prev.endMs <= opts.mergeGapMs &&
      line.endMs - prev.startMs <= opts.maxLineMs
    ) {
      prev.text = `${prev.text} ${line.text}`;
      prev.endMs = Math.max(prev.endMs, line.endMs);
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/**
 * Interleaves every speaker's segments chronologically, joining consecutive segments from the
 * same speaker when the pause is short, so the transcript reads as turns rather than fragments.
 */
export function mergeSegments(bySpeaker: ReadonlyMap<string, readonly SpeakerSegment[]>, opts: MergeOptions): TranscriptLine[] {
  const all = [...bySpeaker].flatMap(([userId, segs]) => segs.map((s) => ({ userId, ...s })));
  all.sort((a, b) => a.startMs - b.startMs || a.userId.localeCompare(b.userId));

  const lines: TranscriptLine[] = all
    .filter((seg) => seg.text.trim())
    .map((seg) => ({
      userId: seg.userId,
      speaker: speakerName(seg.userId, opts.aliases, opts.participants),
      offsetMs: seg.startMs - opts.sessionStartMs,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text.trim(),
    }));
  return joinLines(lines, opts);
}

function formatDate(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

export function renderMarkdown(session: SessionInfo, lines: readonly TranscriptLine[], timeZone?: string): string {
  const endMs = session.stoppedAt ?? lines.reduce((m, l) => Math.max(m, l.endMs), session.startedAt);
  const speakers = [...new Set(lines.filter((l) => l.inferred?.confidence !== 'unclear').map((l) => l.speaker))];
  const header = [
    `# Transcript: ${session.id}`,
    '',
    `- **Date:** ${formatDate(session.startedAt, timeZone)}`,
    `- **Duration:** ${formatOffset(endMs - session.startedAt)}`,
    ...(session.channelName ? [`- **Channel:** #${session.channelName}${session.guildName ? ` (${session.guildName})` : ''}`] : []),
    `- **Speakers:** ${speakers.join(', ') || 'none'}`,
    '',
    '---',
    '',
  ];
  const body = lines.map((l) => `[${formatOffset(l.offsetMs)}] ${displaySpeaker(l)}: ${l.text}`);
  return [...header, ...body, ''].join('\n');
}

export interface MergeResult {
  lines: number;
  speakers: number;
  file: string;
}

/** Reads transcripts/*.json and writes segments.json + transcript.md. */
export function mergeSession(sessionDir: string, config: Config): MergeResult {
  const dir = paths.transcriptsDir(sessionDir);
  if (!existsSync(dir)) throw new Error(`No transcripts in ${sessionDir}; run transcribe first`);
  const bySpeaker = new Map<string, SpeakerSegment[]>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const t = readJson<SpeakerTranscript>(join(dir, name));
    if (t) bySpeaker.set(t.userId, t.segments);
  }
  const session = readSessionInfo(sessionDir);
  const lines = mergeSegments(bySpeaker, {
    sessionStartMs: session.startedAt,
    aliases: speakerNames(config),
    participants: readParticipants(sessionDir),
    mergeGapMs: config.transcript.merge_gap_seconds * 1000,
    maxLineMs: config.transcript.max_line_seconds * 1000,
    noJoin: new Set(sharedAccounts(config).keys()),
  });
  writeJson(paths.segments(sessionDir), { session, lines });
  const file = paths.transcript(sessionDir);
  writeFileSync(file, renderMarkdown(session, lines, config.transcript.timezone));
  return { lines: lines.length, speakers: new Set(lines.map((l) => l.userId)).size, file };
}
