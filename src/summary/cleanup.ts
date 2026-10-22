import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import type { SessionInfo } from '../session/layout.js';
import { formatOffset, type TranscriptLine } from '../transcript/merge.js';
import { campaignFor, unpairedSpeakers } from '../config/roster.js';
import { chunkTranscript, formatLine, type Chunk } from './chunk.js';
import { runChunkPass } from './chunkPass.js';
import { auditCleanup, type CleanupAuditReport, type Proposal } from './cleanupAudit.js';
import { contextBlock } from './context.js';
import type { Cleanup, SummaryModel, Usage } from './model.js';
import type { UnpairedSpeaker } from '../shared/types.js';
import { loadTemplate, render } from './prompts.js';

export interface CleanupResult {
  lines: TranscriptLine[];
  stats: { edited: number; dropped: number; chunks: number; chunksFromCache: number };
  /** Present when summary.cleanup_audit is on. */
  audit?: CleanupAuditReport;
  /** People not on the campaign's roster, with Claude's guess at who they are where it had one. */
  unpaired: UnpairedSpeaker[];
  modelsUsed: string[];
  usage: Usage;
  promptVersion: string;
}

export interface CleanupOptions {
  concurrency?: number;
  force?: boolean;
  log?: (msg: string) => void;
}

/** Names Claude should expect: the transcription vocabulary hint and the party's characters. */
function vocabulary(config: Config, session: SessionInfo): string {
  const characters = campaignFor(config, session)?.characters.map((c) => c.label) ?? [];
  const parts = [...(config.transcription.prompt ? [config.transcription.prompt.trim()] : []), ...(characters.length ? [`Characters: ${characters.join(', ')}`] : [])];
  return parts.length ? parts.join('\n') : '(none given; use the context above)';
}

function unpairedBlock(unpaired: readonly UnpairedSpeaker[]): string {
  return unpaired.length ? unpaired.map((u, i) => `U${i + 1}: ${u.name}`).join('\n') : '(none: everyone who speaks is on the roster; return an empty `unpaired` list)';
}

/**
 * One guess per person from the per-chunk answers: the role most chunks gave, the character name
 * given most often, and the earliest line that shows that role.
 */
export function combineGuesses(unpaired: readonly UnpairedSpeaker[], answers: readonly Cleanup['unpaired'][]): UnpairedSpeaker[] {
  return unpaired.map((person, i) => {
    const mine = answers.flat().filter((a) => a.speaker === i + 1);
    if (!mine.length) return person;
    const players = mine.filter((a) => a.role === 'new_player');
    const role = players.length >= mine.length - players.length ? 'new_player' : 'guest';
    const counts = new Map<string, { name: string; n: number }>();
    for (const a of mine) {
      const name = a.character.trim();
      if (!name) continue;
      const entry = counts.get(name.toLowerCase()) ?? { name, n: 0 };
      entry.n++;
      counts.set(name.toLowerCase(), entry);
    }
    const character = role === 'new_player' ? [...counts.values()].sort((a, b) => b.n - a.n)[0]?.name : undefined;
    const time = mine.filter((a) => a.role === role).map((a) => a.time).sort()[0];
    return { ...person, role, ...(character ? { character } : {}), ...(time ? { time } : {}) };
  });
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
  const unpaired = unpairedSpeakers(config, lines);
  const system = render(template.text, { context: contextBlock(session, lines, config), vocabulary: vocabulary(config, session), unpaired: unpairedBlock(unpaired) });
  const ids = new Map<TranscriptLine, number>();
  lines.forEach((l, i) => ids.set(l, i + 1));

  const chunks = chunkTranscript(lines, { chunkMs: s.chunk_minutes * 60_000, contextMs: 60_000, maxChars: 60_000 });
  log(`Cleaning up the transcript in ${chunks.length} chunk(s)…`);
  const pass = await runChunkPass({
    chunks,
    model: s.model,
    effort: s.extract_effort,
    system,
    user: (chunk) => formatSection(chunk, chunks.length, ids),
    cacheFile: (chunk) => join(sessionDir, 'summary', 'cleanup', `${String(chunk.index).padStart(3, '0')}.json`),
    call: (o) => model.cleanup(o),
    ...(opts.force ? { force: true } : {}),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
  });

  // Only the chunk's own lines may change, never its context lines or numbers Claude made up.
  const proposals = new Map<number, Proposal>();
  const chunkLines = chunks.map((c) => ({ index: c.index, lineNumbers: c.lines.map((l) => ids.get(l)!) }));
  pass.values.forEach((r, i) => {
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
    stats: { edited, dropped, chunks: chunks.length, chunksFromCache: pass.fromCache },
    ...(audit ? { audit } : {}),
    unpaired: combineGuesses(unpaired, pass.values.map((v) => v.unpaired ?? [])),
    modelsUsed: pass.modelsUsed,
    usage: pass.usage,
    promptVersion: `${template.version}#${template.hash}`,
  };
}
