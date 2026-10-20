import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedAccounts, type Config } from '../config/schema.js';
import { paths, readJson, writeJson, type SessionInfo } from '../session/layout.js';
import { formatOffset, renderMarkdown, type TranscriptLine } from '../transcript/merge.js';
import { campaignFor } from './campaign.js';
import { chunkTranscript, formatChunk } from './chunk.js';
import { runChunkPass } from './chunkPass.js';
import { cleanTranscript, type CleanupResult } from './cleanup.js';
import type { CleanupAuditReport } from './cleanupAudit.js';
import { contextBlock } from './context.js';
import { disambiguateSession } from './disambiguate.js';
import type { Extraction, SummaryModel, Usage } from './model.js';
import { loadTemplate, render } from './prompts.js';
import { countNotes, formatNotes, insertKillCount, tallyKills } from './recap.js';
import { auditRecap, type RecapAuditResult } from './recapAudit.js';
import { recapPaths, writeGeneratedRecap } from './recapEdits.js';

export const summaryPaths = {
  dir: (s: string) => join(s, 'summary'),
  extraction: (s: string, i: number) => join(s, 'summary', 'extract', `${String(i).padStart(3, '0')}.json`),
  meta: (s: string) => join(s, 'summary', 'meta.json'),
  cleanupAudit: (s: string) => join(s, 'summary', 'audit', 'cleanup.json'),
  recapAudit: (s: string) => join(s, 'summary', 'audit', 'recap.json'),
  markdown: recapPaths.markdown,
};

const DETAIL_GUIDANCE: Record<Config['summary']['detail'], string> = {
  low: 'Keep it short: only what matters most, one line per bullet, at most five bullets per section. Someone should be able to read it in under a minute.',
  medium: 'Cover every meaningful point, concisely: a bullet per distinct point, a sentence or two each. Merge minor related points. Aim for something readable in a few minutes.',
  high: 'Be thorough: keep every relevant point, with the specifics behind it. Use sub-bullets where it helps. Completeness matters more than brevity.',
};

function numbered(rules: readonly string[]): string {
  return rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none)';
}

function bullets(rules: readonly string[], none: string): string {
  return rules.length ? rules.map((r) => `- ${r}`).join('\n') : none;
}

const add = (a: Usage, b: Usage) => {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
};

export interface SummarizeOptions {
  concurrency?: number;
  log?: (msg: string) => void;
  /** Ignore every cached step (speaker labels, clean-up, extraction, audit). */
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
  /** Total notes extracted, all kinds. */
  items: number;
  notes: ReturnType<typeof countNotes>;
  kills: [string, number][];
  usage: { extract: Usage; synthesize: Usage; disambiguate?: Usage; cleanup?: Usage; audit?: Usage; revise?: Usage };
  /** Present when shared accounts were relabelled before the recap. */
  speakerLabels?: { labelled: number; confident: number; guessed: number; unclear: number };
  cleanup?: { edited: number; dropped: number; reverted?: number };
  recapAudit?: { missing: number; applied: RecapAuditResult['applied'] };
  /** Where a hand-edited recap was moved before this one replaced it. */
  editedBackup?: string;
}

/** One line on what a recap run did and cost, for the CLI and the app's job log. */
export function describeRun(meta: SummaryMeta): string {
  const n = meta.notes;
  const tokens = Object.entries(meta.usage)
    .filter(([, u]) => u && (u.inputTokens || u.outputTokens))
    .map(([step, u]) => `${step} ${u!.inputTokens}/${u!.outputTokens}`)
    .join(', ');
  return [
    `${n.npcs} NPC, ${n.locations} location, ${n.events} event and ${n.combats} fight notes from ${meta.chunks} chunks (${meta.chunksFromCache} cached)`,
    ...(meta.cleanup ? [`clean-up: ${meta.cleanup.edited} corrected, ${meta.cleanup.dropped} dropped${meta.cleanup.reverted ? `, ${meta.cleanup.reverted} reverted by the audit` : ''}`] : []),
    ...(meta.recapAudit ? [`completeness check: ${meta.recapAudit.missing} missing item(s)${meta.recapAudit.applied === 'none' ? '' : ` ${meta.recapAudit.applied}`}`] : []),
    ...(tokens ? [`tokens in/out: ${tokens}`] : []),
  ].join(' · ');
}

/**
 * The session recap, step by step (each step cached per chunk):
 *  1. label speakers on shared accounts (only if configured)
 *  2. clean-up: Claude fixes misheard words and drops filler (summary.cleanup),
 *     then a deterministic audit reverts drastic changes (summary.cleanup_audit)
 *  3. extract: NPCs, locations, events, fights and extra-rule items per ~20-minute chunk
 *  4. synthesize: the recap in Markdown, plus a kill count tallied in code
 *  5. audit: Claude checks each chunk against the recap and missing items are added (summary.recap_audit)
 */
export async function summarizeSession(sessionDir: string, config: Config, configHash: string, model: SummaryModel, opts: SummarizeOptions = {}): Promise<{ file: string; meta: SummaryMeta }> {
  const log = opts.log ?? console.log;
  const s = config.summary;
  const passOpts = { ...(opts.concurrency ? { concurrency: opts.concurrency } : {}), ...(opts.force ? { force: true } : {}), log };
  const data = readJson<{ session: SessionInfo; lines: TranscriptLine[] }>(paths.segments(sessionDir));
  if (!data) throw new Error(`No transcript in ${sessionDir}; run transcribe (or merge) first`);
  const { session } = data;
  let lines = data.lines;
  if (!lines.length) throw new Error('The transcript is empty; nothing to summarize');
  const used = new Set<string>();
  const promptVersions: Record<string, string> = {};

  // 1. Relabel lines on shared Discord accounts (speakers.<id>.disambiguate).
  let labelling: Awaited<ReturnType<typeof disambiguateSession>> | undefined;
  if ([...sharedAccounts(config).keys()].some((id) => lines.some((l) => l.userId === id))) {
    labelling = await disambiguateSession(sessionDir, config, model, passOpts);
    lines = labelling.lines;
    for (const m of labelling.modelsUsed) used.add(m);
    promptVersions.disambiguate = labelling.promptVersion;
    const st = labelling.stats;
    log(`  ${st.labelled} lines on shared accounts: ${st.confident} confident, ${st.guessed} guessed, ${st.unclear} unclear → ${labelling.file}`);
  }

  // 2. Clean-up, with its audit.
  let cleanup: CleanupResult | undefined;
  if (s.cleanup) {
    cleanup = await cleanTranscript(lines, session, config, model, sessionDir, passOpts);
    lines = cleanup.lines;
    for (const m of cleanup.modelsUsed) used.add(m);
    promptVersions.cleanup = cleanup.promptVersion;
    writeJson(paths.cleanSegments(sessionDir), { session, lines, stats: cleanup.stats });
    writeFileSync(paths.cleanTranscript(sessionDir), renderMarkdown(session, lines, config.transcript.timezone));
    if (cleanup.audit) writeJson(summaryPaths.cleanupAudit(sessionDir), cleanup.audit satisfies CleanupAuditReport);
    log(`  Cleaned up: ${cleanup.stats.edited} lines corrected, ${cleanup.stats.dropped} filler lines dropped`);
    if (!lines.length) throw new Error('The clean-up dropped every line; turn off summary.cleanup and try again');
  }

  // 3. Extract notes per chunk.
  const about = contextBlock(session, lines, config);
  const exclude = bullets(s.exclude, '- (no extra exclusions)');
  const extractT = loadTemplate('extract', s.prompts_dir);
  const synthT = loadTemplate('synthesize', s.prompts_dir);
  promptVersions.extract = `${extractT.version}#${extractT.hash}`;
  promptVersions.synthesize = `${synthT.version}#${synthT.hash}`;
  const extractSystem = render(extractT.text, { context: about, include_rules: numbered(s.include), exclude_rules: exclude });

  const chunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  log(`Extracting from ${chunks.length} chunk(s) with ${s.model}…`);
  const extraction = await runChunkPass({
    chunks,
    model: s.model,
    effort: s.extract_effort,
    system: extractSystem,
    user: (chunk) => formatChunk(chunk, chunks.length),
    cacheFile: (chunk) => summaryPaths.extraction(sessionDir, chunk.index),
    call: async (o) => {
      const r = await model.extract(o);
      // Items for a rule that doesn't exist are dropped before they're cached.
      return { ...r, value: { ...r.value, items: r.value.items.filter((it) => it.rule >= 1 && it.rule <= s.include.length && it.detail.trim()) } };
    },
    onAnswer: (chunk, n) => {
      const c = countNotes([n]);
      log(`  chunk ${chunk.index + 1}/${chunks.length} (${formatOffset(chunk.startMs)}–${formatOffset(chunk.endMs)}): ${c.npcs} NPCs, ${c.locations} locations, ${c.events} events, ${c.combats} fights`);
    },
    ...(opts.force ? { force: true } : {}),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
  });
  const notes: Extraction[] = extraction.values;
  for (const m of extraction.modelsUsed) used.add(m);
  const extractUsage = extraction.usage;
  const counts = countNotes(notes);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // 4. Write the recap.
  const citationGuidance = s.cite_timestamps
    ? 'After each point, cite where it came from with its timestamp in square brackets, e.g. "[01:23:45]". Cite at most three timestamps per point; use the earliest relevant one when several notes were combined.'
    : "Don't include timestamps.";
  const synthSystem = render(synthT.text, {
    context: about,
    include_rules: numbered(s.include),
    exclude_rules: exclude,
    detail: s.detail,
    detail_guidance: DETAIL_GUIDANCE[s.detail],
    citation_guidance: citationGuidance,
  });
  let body: string;
  const synthUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  if (total === 0) {
    body = '_Nothing in this session matched what the recap looks for._';
  } else {
    log(`Writing the recap from ${total} notes…`);
    const r = await model.synthesize({ model: s.model, effort: s.synthesize_effort, system: synthSystem, user: `<notes>\n${formatNotes(notes, s.include)}\n</notes>` });
    body = r.value;
    add(synthUsage, r.usage);
    used.add(r.model);
  }

  // 5. Completeness audit.
  let audit: RecapAuditResult | undefined;
  if (s.recap_audit && total > 0) {
    audit = await auditRecap(body, lines, config, model, { ...passOpts, context: about, citationGuidance, sessionDir });
    body = audit.body;
    for (const m of audit.modelsUsed) used.add(m);
    promptVersions.audit = audit.promptVersions.audit;
    if (audit.applied === 'revised') promptVersions.revise = audit.promptVersions.revise;
    writeJson(summaryPaths.recapAudit(sessionDir), { missing: audit.missing, applied: audit.applied });
  }

  // The kill count is tallied in code so it's exact, and added last so no rewrite can change it.
  const kills = tallyKills(notes, campaignFor(config, session)?.characters);
  body = insertKillCount(body, kills);

  const endMs = session.stoppedAt ?? lines.at(-1)!.endMs;
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', ...(config.transcript.timezone ? { timeZone: config.transcript.timezone } : {}) }).format(session.startedAt);
  const campaign = campaignFor(config, session);
  const md = [
    `# Recap: ${campaign?.name ?? session.id}`,
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
  const editedBackup = writeGeneratedRecap(sessionDir, md);
  if (editedBackup) log(`  Your edited recap was kept at ${editedBackup}`);

  const meta: SummaryMeta = {
    generatedAt: new Date().toISOString(),
    requestedModel: s.model,
    modelsUsed: [...used].sort(),
    promptVersions,
    configHash,
    detail: s.detail,
    chunks: chunks.length,
    chunksFromCache: extraction.fromCache,
    items: total,
    notes: counts,
    kills,
    usage: {
      extract: extractUsage,
      synthesize: synthUsage,
      ...(labelling ? { disambiguate: labelling.usage } : {}),
      ...(cleanup ? { cleanup: cleanup.usage } : {}),
      ...(audit ? { audit: audit.usage.audit, revise: audit.usage.revise } : {}),
    },
    ...(labelling ? { speakerLabels: labelling.stats } : {}),
    ...(cleanup ? { cleanup: { edited: cleanup.stats.edited, dropped: cleanup.stats.dropped, ...(cleanup.audit ? { reverted: cleanup.audit.reverted.length } : {}) } } : {}),
    ...(audit ? { recapAudit: { missing: audit.missing.length, applied: audit.applied } } : {}),
    ...(editedBackup ? { editedBackup } : {}),
  };
  writeJson(summaryPaths.meta(sessionDir), meta);
  return { file, meta };
}
