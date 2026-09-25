import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { paths, readJson, writeJson, type SessionInfo } from '../session/layout.js';
import { formatOffset, type TranscriptLine } from '../transcript/merge.js';
import { mapLimit } from '../util/retry.js';
import { chunkTranscript, formatChunk } from './chunk.js';
import { loadTemplate, render } from './prompts.js';
import type { Extraction, SummaryModel, Usage } from './model.js';

export const summaryPaths = {
  dir: (s: string) => join(s, 'summary'),
  extraction: (s: string, i: number) => join(s, 'summary', 'extract', `${String(i).padStart(3, '0')}.json`),
  meta: (s: string) => join(s, 'summary', 'meta.json'),
  markdown: (s: string) => join(s, 'summary.md'),
};

type Item = Extraction['items'][number];

interface ExtractionCache {
  key: string;
  model: string;
  items: Item[];
  usage: Usage;
}

const DETAIL_GUIDANCE: Record<Config['summary']['detail'], string> = {
  low: 'Keep it short: only the few points that matter most, at most three to five bullets per section, one line each. Someone should be able to read it in under a minute.',
  medium: 'Cover every meaningful point, concisely: a bullet per distinct point, a sentence or two each. Merge minor related points. Aim for something readable in a few minutes.',
  high: 'Be thorough: keep every relevant point, with the reasoning, numbers and who-said-what behind it. Use sub-bullets where it helps. Completeness matters more than brevity.',
};

function numbered(rules: readonly string[]): string {
  return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

function bullets(rules: readonly string[], none: string): string {
  return rules.length ? rules.map((r) => `- ${r}`).join('\n') : none;
}

function contextBlock(session: SessionInfo, lines: readonly TranscriptLine[], context: string | undefined, timeZone: string | undefined): string {
  const speakers = [...new Set(lines.map((l) => l.speaker))].join(', ');
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', ...(timeZone ? { timeZone } : {}) }).format(session.startedAt);
  return [
    '## About this call',
    '',
    `- Date: ${date}`,
    ...(session.channelName ? [`- Channel: #${session.channelName}${session.guildName ? ` in ${session.guildName}` : ''}`] : []),
    `- Speakers: ${speakers}`,
    ...(context ? ['', context.trim()] : []),
  ].join('\n');
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

function toMs(time: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time.trim());
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : undefined;
}

/** Groups extracted items by rule, in time order, as the input for the final write-up. */
export function formatExtractions(items: readonly Item[], include: readonly string[]): string {
  const sections: string[] = [];
  include.forEach((rule, i) => {
    const matching = items.filter((it) => it.rule === i + 1).sort((a, b) => (toMs(a.time) ?? 0) - (toMs(b.time) ?? 0));
    if (!matching.length) return;
    sections.push(`<rule number="${i + 1}" text="${rule.replace(/"/g, "'")}">\n${matching.map((it) => `[${it.time}] (${it.speakers.join(', ') || 'unknown'}) ${it.detail}`).join('\n')}\n</rule>`);
  });
  return sections.join('\n\n');
}

export interface SummarizeOptions {
  concurrency?: number;
  log?: (msg: string) => void;
  /** Ignore cached extractions. */
  force?: boolean;
}

export interface SummaryMeta {
  generatedAt: string;
  requestedModel: string;
  modelsUsed: string[];
  promptVersions: Record<string, string>;
  configHash: string;
  detail: string;
  chunks: number;
  chunksFromCache: number;
  items: number;
  usage: { extract: Usage; synthesize: Usage };
}

/**
 * Two-pass summary of a session's transcript:
 *  1. extract: each ~20-minute chunk → items matching the include rules (cached per chunk)
 *  2. synthesize: all items → summary.md at the configured detail level
 * Re-running after changing only detail/citation settings reuses the extractions.
 */
export async function summarizeSession(sessionDir: string, config: Config, configHash: string, model: SummaryModel, opts: SummarizeOptions = {}): Promise<{ file: string; meta: SummaryMeta }> {
  const log = opts.log ?? console.log;
  const s = config.summary;
  const data = readJson<{ session: SessionInfo; lines: TranscriptLine[] }>(paths.segments(sessionDir));
  if (!data) throw new Error(`No transcript in ${sessionDir}; run transcribe (or merge) first`);
  const { session, lines } = data;
  if (!lines.length) throw new Error('The transcript is empty; nothing to summarize');

  const about = contextBlock(session, lines, s.context, config.transcript.timezone);
  const exclude = bullets(s.exclude, '- (no extra exclusions)');
  const extractT = loadTemplate('extract', s.prompts_dir);
  const synthT = loadTemplate('synthesize', s.prompts_dir);
  const extractSystem = render(extractT.text, { context: about, include_rules: numbered(s.include), exclude_rules: exclude });

  const chunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  log(`Extracting from ${chunks.length} chunk(s) with ${s.model}…`);

  let fromCache = 0;
  const used = new Set<string>();
  const extractUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  const results = await mapLimit(chunks, opts.concurrency ?? 3, async (chunk) => {
    const user = formatChunk(chunk, chunks.length);
    const key = hash(s.model, s.extract_effort, extractSystem, user);
    const cacheFile = summaryPaths.extraction(sessionDir, chunk.index);
    const cached = opts.force ? undefined : readJson<ExtractionCache>(cacheFile);
    if (cached?.key === key) {
      fromCache++;
      used.add(cached.model);
      return cached.items;
    }
    const r = await model.extract({ model: s.model, effort: s.extract_effort, system: extractSystem, user });
    const items = r.value.items.filter((it) => it.rule >= 1 && it.rule <= s.include.length && it.detail.trim());
    writeJson(cacheFile, { key, model: r.model, items, usage: r.usage } satisfies ExtractionCache);
    used.add(r.model);
    extractUsage.inputTokens += r.usage.inputTokens;
    extractUsage.outputTokens += r.usage.outputTokens;
    log(`  chunk ${chunk.index + 1}/${chunks.length} (${formatOffset(chunk.startMs)}–${formatOffset(chunk.endMs)}): ${items.length} items`);
    return items;
  });
  const items = results.flat();

  const synthSystem = render(synthT.text, {
    context: about,
    include_rules: numbered(s.include),
    exclude_rules: exclude,
    detail: s.detail,
    detail_guidance: DETAIL_GUIDANCE[s.detail],
    citation_guidance: s.cite_timestamps
      ? 'After each point, cite where it came from with its timestamp in square brackets, e.g. "[01:23:45]". Cite at most three timestamps per point; use the earliest relevant one when several notes were combined.'
      : "Don't include timestamps.",
  });
  let body: string;
  let synthUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  if (items.length === 0) {
    body = '_Nothing in this call matched the summary rules._';
  } else {
    log(`Writing summary from ${items.length} items…`);
    const r = await model.synthesize({ model: s.model, effort: s.synthesize_effort, system: synthSystem, user: `<notes>\n${formatExtractions(items, s.include)}\n</notes>` });
    body = r.value;
    synthUsage = r.usage;
    used.add(r.model);
  }

  const endMs = session.stoppedAt ?? lines.at(-1)!.endMs;
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', ...(config.transcript.timezone ? { timeZone: config.transcript.timezone } : {}) }).format(session.startedAt);
  const md = [
    `# Summary: ${session.id}`,
    '',
    `- **Date:** ${date}`,
    `- **Duration:** ${formatOffset(endMs - session.startedAt)}`,
    `- **Speakers:** ${[...new Set(lines.map((l) => l.speaker))].join(', ')}`,
    '',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
  const file = summaryPaths.markdown(sessionDir);
  writeFileSync(file, md);

  const meta: SummaryMeta = {
    generatedAt: new Date().toISOString(),
    requestedModel: s.model,
    modelsUsed: [...used].sort(),
    promptVersions: { extract: `${extractT.version}#${extractT.hash}`, synthesize: `${synthT.version}#${synthT.hash}` },
    configHash,
    detail: s.detail,
    chunks: chunks.length,
    chunksFromCache: fromCache,
    items: items.length,
    usage: { extract: extractUsage, synthesize: synthUsage },
  };
  writeJson(summaryPaths.meta(sessionDir), meta);
  return { file, meta };
}

