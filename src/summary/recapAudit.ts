import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { readJson, writeJson } from '../session/layout.js';
import type { TranscriptLine } from '../transcript/merge.js';
import { mapLimit } from '../util/retry.js';
import { chunkTranscript, formatChunk } from './chunk.js';
import type { AuditFindings, SummaryModel, Usage } from './model.js';
import { loadTemplate, render } from './prompts.js';

type Finding = AuditFindings['missing'][number];

interface AuditCache {
  key: string;
  model: string;
  missing: Finding[];
  usage: Usage;
}

export interface RecapAuditResult {
  body: string;
  /** What the audit found missing (after removing duplicates). */
  missing: Finding[];
  /** How the findings were added: by Claude's revision, appended as a section, or not at all. */
  applied: 'none' | 'revised' | 'appended';
  modelsUsed: string[];
  usage: { audit: Usage; revise: Usage };
  promptVersions: { audit: string; revise: string };
  chunks: number;
  chunksFromCache: number;
}

export interface RecapAuditOptions {
  context: string;
  citationGuidance: string;
  sessionDir: string;
  concurrency?: number;
  force?: boolean;
  log?: (msg: string) => void;
}

/** A revision shorter than this share of the original lost content, so it isn't trusted. */
const MIN_REVISION_LENGTH = 0.9;

const SECTION_TITLE: Record<Finding['section'], string> = { npcs: 'NPCs', locations: 'Locations', events: 'What happened', combat: 'Combat', other: 'Other' };

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}

function formatFindings(missing: readonly Finding[]): string {
  return missing.map((m) => `- (${m.section}) [${m.time}] ${m.detail}`).join('\n');
}

/** The deterministic fallback when a revision can't be trusted: list the findings in their own section. */
export function appendFindings(body: string, missing: readonly Finding[]): string {
  const bullets = missing.map((m) => `- **${SECTION_TITLE[m.section]}** [${m.time}]: ${m.detail}`).join('\n');
  return `${body.trimEnd()}\n\n## Also mentioned\n\n_Found by the completeness check; move these where they belong._\n\n${bullets}\n`;
}

/**
 * Checks the recap got everything: per chunk, Claude lists what that part of the transcript has that
 * the recap is missing, then one revision pass adds the findings. If the revision looks like it
 * dropped content, the findings are appended in their own section instead.
 */
export async function auditRecap(body: string, lines: readonly TranscriptLine[], config: Config, model: SummaryModel, opts: RecapAuditOptions): Promise<RecapAuditResult> {
  const log = opts.log ?? console.log;
  const s = config.summary;
  const auditT = loadTemplate('audit', s.prompts_dir);
  const reviseT = loadTemplate('revise', s.prompts_dir);
  const system = render(auditT.text, { context: opts.context, recap: body });
  const chunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  log(`Checking the recap against ${chunks.length} chunk(s) of the transcript…`);

  const used = new Set<string>();
  const auditUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let fromCache = 0;
  const results = await mapLimit(chunks, opts.concurrency ?? 3, async (chunk) => {
    const user = formatChunk(chunk, chunks.length);
    const key = hash(s.model, s.extract_effort, system, user);
    const cacheFile = join(opts.sessionDir, 'summary', 'audit', 'recap', `${String(chunk.index).padStart(3, '0')}.json`);
    const cached = opts.force ? undefined : readJson<AuditCache>(cacheFile);
    if (cached?.key === key) {
      fromCache++;
      used.add(cached.model);
      return cached.missing;
    }
    const r = await model.audit({ model: s.model, effort: s.extract_effort, system, user });
    const missing = r.value.missing.filter((m) => m.detail.trim());
    writeJson(cacheFile, { key, model: r.model, missing, usage: r.usage } satisfies AuditCache);
    used.add(r.model);
    auditUsage.inputTokens += r.usage.inputTokens;
    auditUsage.outputTokens += r.usage.outputTokens;
    return missing;
  });

  const seen = new Set<string>();
  const missing = results.flat().filter((m) => {
    const k = m.detail.trim().toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const result = (b: string, applied: RecapAuditResult['applied'], reviseUsage: Usage = { inputTokens: 0, outputTokens: 0 }): RecapAuditResult => ({
    body: b,
    missing,
    applied,
    modelsUsed: [...used].sort(),
    usage: { audit: auditUsage, revise: reviseUsage },
    promptVersions: { audit: `${auditT.version}#${auditT.hash}`, revise: `${reviseT.version}#${reviseT.hash}` },
    chunks: chunks.length,
    chunksFromCache: fromCache,
  });
  if (!missing.length) {
    log('  Nothing missing.');
    return result(body, 'none');
  }

  log(`  ${missing.length} item(s) missing; adding them to the recap…`);
  const reviseSystem = render(reviseT.text, { context: opts.context, citation_guidance: opts.citationGuidance });
  const r = await model.synthesize({ model: s.model, effort: s.synthesize_effort, system: reviseSystem, user: `<recap>\n${body}\n</recap>\n\n<missing>\n${formatFindings(missing)}\n</missing>` });
  used.add(r.model);
  if (r.value.trim().length < body.trim().length * MIN_REVISION_LENGTH) {
    log('  The revision came back shorter than the original, so the missing items were appended in their own section instead.');
    return result(appendFindings(body, missing), 'appended', r.usage);
  }
  return result(r.value.trim(), 'revised', r.usage);
}
