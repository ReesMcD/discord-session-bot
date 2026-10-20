import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { readJson, writeJson, type SessionInfo } from '../session/layout.js';
import { formatOffset, type TranscriptLine } from '../transcript/merge.js';
import { mapLimit } from '../util/retry.js';
import { campaignFor } from './campaign.js';
import { chunkTranscript, formatLine, type Chunk } from './chunk.js';
import { auditCleanup, type CleanupAuditReport, type Proposal } from './cleanupAudit.js';
import { contextBlock } from './context.js';
import type { Cleanup, SummaryModel, Usage } from './model.js';
import { loadTemplate, render } from './prompts.js';

interface CleanupCache {
  key: string;
  model: string;
  result: Cleanup;
  usage: Usage;
}

export interface CleanupResult {
  lines: TranscriptLine[];
  stats: { edited: number; dropped: number; chunks: number; chunksFromCache: number };
  /** Present when summary.cleanup_audit is on. */
  audit?: CleanupAuditReport;
  modelsUsed: string[];
  usage: Usage;
  promptVersion: string;
}

export interface CleanupOptions {
  concurrency?: number;
  force?: boolean;
  log?: (msg: string) => void;
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

/** Names Claude should expect: the transcription vocabulary hint and the party's characters. */
function vocabulary(config: Config, session: SessionInfo): string {
  const characters = campaignFor(config, session)?.characters.map((c) => c.label) ?? [];
  const parts = [...(config.transcription.prompt ? [config.transcription.prompt.trim()] : []), ...(characters.length ? [`Characters: ${characters.join(', ')}`] : [])];
  return parts.length ? parts.join('\n') : '(none given; use the context above)';
}

function formatSection(chunk: Chunk, total: number, ids: ReadonlyMap<TranscriptLine, number>): string {
  const body = [...chunk.context.map((l) => formatLine(l, '(context) ')), ...chunk.lines.map((l) => `#${ids.get(l)} ${formatLine(l)}`)].join('\n');
  return `<transcript_section number="${chunk.index + 1}" of="${total}" from="${formatOffset(chunk.startMs)}" to="${formatOffset(chunk.endMs)}">\n${body}\n</transcript_section>`;
}

/**
 * Claude's clean-up pass: per chunk it returns only the lines to correct (misheard names and words)
 * and the filler lines to drop. With summary.cleanup_audit on, drastic changes are reverted. Speakers
 * and timestamps never change, and the input lines aren't modified.
 */
export async function cleanTranscript(
  lines: readonly TranscriptLine[],
  session: SessionInfo,
  config: Config,
  model: SummaryModel,
  sessionDir: string,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const log = opts.log ?? console.log;
  const s = config.summary;
  const template = loadTemplate('cleanup', s.prompts_dir);
  const system = render(template.text, { context: contextBlock(session, lines, config), vocabulary: vocabulary(config, session) });
  const ids = new Map<TranscriptLine, number>();
  lines.forEach((l, i) => ids.set(l, i + 1));

  const chunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  log(`Cleaning up the transcript in ${chunks.length} chunk(s)…`);
  const used = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let fromCache = 0;
  const results = await mapLimit(chunks, opts.concurrency ?? 3, async (chunk) => {
    const user = formatSection(chunk, chunks.length, ids);
    const key = hash(s.model, s.extract_effort, system, user);
    const cacheFile = join(sessionDir, 'summary', 'cleanup', `${String(chunk.index).padStart(3, '0')}.json`);
    const cached = opts.force ? undefined : readJson<CleanupCache>(cacheFile);
    if (cached?.key === key) {
      fromCache++;
      used.add(cached.model);
      return cached.result;
    }
    const r = await model.cleanup({ model: s.model, effort: s.extract_effort, system, user });
    writeJson(cacheFile, { key, model: r.model, result: r.value, usage: r.usage } satisfies CleanupCache);
    used.add(r.model);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r.value;
  });

  // Only the chunk's own lines may change, never its context lines or numbers Claude made up.
  const proposals = new Map<number, Proposal>();
  const chunkLines = chunks.map((c) => ({ index: c.index, lineNumbers: c.lines.map((l) => ids.get(l)!) }));
  results.forEach((r, i) => {
    const own = new Set(chunkLines[i]!.lineNumbers);
    for (const e of r.edits) if (own.has(e.line) && e.text.trim() !== lines[e.line - 1]!.text.trim()) proposals.set(e.line, { kind: 'edit', text: e.text.trim() });
    for (const n of r.drops) if (own.has(n)) proposals.set(n, { kind: 'drop' });
  });

  let accepted: ReadonlyMap<number, Proposal> = proposals;
  let audit: CleanupAuditReport | undefined;
  if (s.cleanup_audit) {
    ({ accepted, report: audit } = auditCleanup(lines, proposals, chunkLines));
    log(`  Clean-up audit: kept ${audit.accepted.edits} edits and ${audit.accepted.drops} drops, reverted ${audit.reverted.length}`);
  }

  const out: TranscriptLine[] = [];
  let edited = 0;
  let dropped = 0;
  lines.forEach((line, i) => {
    const p = accepted.get(i + 1);
    if (p?.kind === 'drop') dropped++;
    else if (p?.kind === 'edit') {
      edited++;
      out.push({ ...line, text: p.text });
    } else out.push({ ...line });
  });
  return {
    lines: out,
    stats: { edited, dropped, chunks: chunks.length, chunksFromCache: fromCache },
    ...(audit ? { audit } : {}),
    modelsUsed: [...used].sort(),
    usage,
    promptVersion: `${template.version}#${template.hash}`,
  };
}
