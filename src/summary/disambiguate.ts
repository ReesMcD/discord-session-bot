import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedAccounts, type Config, type Identity } from '../config/schema.js';
import { paths, readJson, writeJson, type SessionInfo } from '../session/layout.js';
import { formatOffset, joinLines, renderMarkdown, type TranscriptLine } from '../transcript/merge.js';
import { mapLimit } from '../util/retry.js';
import { chunkTranscript, formatLine, type Chunk } from './chunk.js';
import { contextBlock } from './context.js';
import type { Labels, SummaryModel, Usage } from './model.js';
import { loadTemplate, render } from './prompts.js';

/** A shared account's identities, numbered globally so one answer can't pick another account's. */
interface NumberedIdentity extends Identity {
  number: number;
  userId: string;
}

interface LabelCache {
  key: string;
  model: string;
  labels: Labels['labels'];
  usage: Usage;
}

export interface DisambiguationResult {
  /** Lines with shared accounts relabelled, re-joined into turns for readability. */
  lines: TranscriptLine[];
  stats: { labelled: number; confident: number; guessed: number; unclear: number };
  modelsUsed: string[];
  usage: Usage;
  promptVersion: string;
  chunks: number;
  chunksFromCache: number;
}

export interface DisambiguateOptions {
  concurrency?: number;
  force?: boolean;
  log?: (msg: string) => void;
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

function accountsBlock(accounts: ReadonlyMap<string, NumberedIdentity[]>, names: ReadonlyMap<string, string>): string {
  return [...accounts]
    .map(([userId, ids]) => [`Account "${names.get(userId) ?? userId}":`, ...ids.map((i) => `  ${i.number}. ${i.description}`)].join('\n'))
    .join('\n\n');
}

function formatSection(chunk: Chunk, total: number, ids: ReadonlyMap<TranscriptLine, number>, targets: ReadonlySet<string>): string {
  const body = [
    ...chunk.context.map((l) => formatLine(l, '(context) ')),
    ...chunk.lines.map((l) => (targets.has(l.userId) ? `#${ids.get(l)} ${formatLine(l)}` : formatLine(l))),
  ].join('\n');
  return `<transcript_section number="${chunk.index + 1}" of="${total}" from="${formatOffset(chunk.startMs)}" to="${formatOffset(chunk.endMs)}">\n${body}\n</transcript_section>`;
}

/**
 * Optional pass for Discord accounts shared by several people (or one person in several roles):
 * Claude reads the conversation and labels each of that account's lines with one of the identities
 * listed under `speakers.<id>.disambiguate`. Other speakers pass through unchanged.
 * Expects un-joined lines for shared accounts (mergeSession keeps them separate).
 */
export async function disambiguateLines(
  lines: readonly TranscriptLine[],
  config: Config,
  model: SummaryModel,
  sessionDir: string,
  session: SessionInfo,
  opts: DisambiguateOptions,
): Promise<DisambiguationResult> {
  const log = opts.log ?? console.log;
  const shared = sharedAccounts(config);
  const present = new Set(lines.map((l) => l.userId));
  const accounts = new Map<string, NumberedIdentity[]>();
  const byNumber = new Map<number, NumberedIdentity>();
  let n = 0;
  for (const [userId, identities] of shared) {
    if (!present.has(userId)) continue;
    const numbered = identities.map((i) => ({ ...i, number: ++n, userId }));
    accounts.set(userId, numbered);
    for (const i of numbered) byNumber.set(i.number, i);
  }

  const template = loadTemplate('disambiguate', config.summary.prompts_dir);
  const promptVersion = `${template.version}#${template.hash}`;
  const empty: DisambiguationResult = {
    lines: [...lines],
    stats: { labelled: 0, confident: 0, guessed: 0, unclear: 0 },
    modelsUsed: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    promptVersion,
    chunks: 0,
    chunksFromCache: 0,
  };
  if (accounts.size === 0) return empty;

  const names = new Map<string, string>();
  for (const l of lines) if (accounts.has(l.userId) && !names.has(l.userId)) names.set(l.userId, l.speaker);
  const context = contextBlock(session, lines, config.summary.context, config.transcript.timezone);
  const system = render(template.text, { context, accounts: accountsBlock(accounts, names) });

  const ids = new Map<TranscriptLine, number>();
  lines.forEach((l, i) => ids.set(l, i + 1));
  const targets = new Set(accounts.keys());
  const s = config.summary;
  const allChunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  const chunks = allChunks.filter((c) => c.lines.some((l) => targets.has(l.userId)));
  log(`Labelling speakers on ${accounts.size} shared account(s) in ${chunks.length} chunk(s)…`);

  const used = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let fromCache = 0;
  const results = await mapLimit(chunks, opts.concurrency ?? 3, async (chunk) => {
    const user = formatSection(chunk, allChunks.length, ids, targets);
    const key = hash(s.model, s.extract_effort, system, user);
    const cacheFile = join(sessionDir, 'summary', 'disambiguate', `${String(chunk.index).padStart(3, '0')}.json`);
    const cached = opts.force ? undefined : readJson<LabelCache>(cacheFile);
    if (cached?.key === key) {
      fromCache++;
      used.add(cached.model);
      return cached.labels;
    }
    const r = await model.disambiguate({ model: s.model, effort: s.extract_effort, system, user });
    writeJson(cacheFile, { key, model: r.model, labels: r.value.labels, usage: r.usage } satisfies LabelCache);
    used.add(r.model);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r.value.labels;
  });

  const labelFor = new Map<number, Labels['labels'][number]>();
  for (const l of results.flat()) labelFor.set(l.line, l);

  const stats = { labelled: 0, confident: 0, guessed: 0, unclear: 0 };
  const relabelled = lines.map((line): TranscriptLine => {
    if (!accounts.has(line.userId)) return line;
    stats.labelled++;
    const label = labelFor.get(ids.get(line)!);
    const identity = label ? byNumber.get(label.speaker) : undefined;
    // Missing, 0, or an identity from a different account → unclear; keep the account's own name.
    if (!label || !identity || identity.userId !== line.userId) {
      stats.unclear++;
      return { ...line, inferred: { account: line.speaker, confidence: 'unclear' } };
    }
    if (label.confident) stats.confident++;
    else stats.guessed++;
    return { ...line, speaker: identity.label, inferred: { account: line.speaker, confidence: label.confident ? 'high' : 'low' } };
  });

  return {
    lines: joinLines(relabelled, { mergeGapMs: config.transcript.merge_gap_seconds * 1000, maxLineMs: config.transcript.max_line_seconds * 1000 }),
    stats,
    modelsUsed: [...used].sort(),
    usage,
    promptVersion,
    chunks: chunks.length,
    chunksFromCache: fromCache,
  };
}

/** Runs the pass on a session and writes segments.speakers.json + transcript.speakers.md. */
export async function disambiguateSession(
  sessionDir: string,
  config: Config,
  model: SummaryModel,
  opts: DisambiguateOptions,
): Promise<DisambiguationResult & { session: SessionInfo; file?: string }> {
  const data = readJson<{ session: SessionInfo; lines: TranscriptLine[] }>(paths.segments(sessionDir));
  if (!data) throw new Error(`No transcript in ${sessionDir}; run transcribe (or merge) first`);
  const result = await disambiguateLines(data.lines, config, model, sessionDir, data.session, opts);
  if (result.stats.labelled === 0) return { ...result, session: data.session };
  writeJson(paths.disambiguatedSegments(sessionDir), { session: data.session, lines: result.lines, stats: result.stats, promptVersion: result.promptVersion });
  const file = paths.disambiguatedTranscript(sessionDir);
  writeFileSync(file, renderMarkdown(data.session, result.lines, config.transcript.timezone));
  return { ...result, session: data.session, file };
}
