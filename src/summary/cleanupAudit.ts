import type { TranscriptLine } from '../transcript/merge.js';

/** A change the clean-up pass proposed for one line. */
export type Proposal = { kind: 'edit'; text: string } | { kind: 'drop' };

export interface Reverted {
  offsetMs: number;
  speaker: string;
  kind: Proposal['kind'];
  original: string;
  proposed?: string;
  reason: string;
}

export interface CleanupAuditReport {
  accepted: { edits: number; drops: number };
  reverted: Reverted[];
  /** Chunks whose clean-up was thrown away entirely because it changed too much. */
  discardedChunks: number[];
}

/** Below this character-level similarity an edit counts as a rewrite, not a correction. */
const MIN_EDIT_SIMILARITY = 0.6;
/** A dropped line with more words than this said something, unless it's a repetition loop. */
const MAX_DROP_WORDS = 6;
/** If more than this share of a chunk's lines changed, the clean-up of that chunk is discarded. */
const MAX_CHANGED_SHARE = 0.6;
const MIN_LINES_FOR_SHARE_CHECK = 10;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** 1 - (Levenshtein distance / longer length), on lower-cased text. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

/** Whisper's hallucination loops ("thank you thank you thank you…") have few distinct words. */
function isRepetitive(ws: string[]): boolean {
  return ws.length >= 8 && new Set(ws).size / ws.length < 0.3;
}

function reasonToRevert(line: TranscriptLine, p: Proposal): string | undefined {
  if (p.kind === 'drop') {
    const ws = words(line.text);
    return ws.length > MAX_DROP_WORDS && !isRepetitive(ws) ? `dropped a line with ${ws.length} words` : undefined;
  }
  if (!p.text.trim()) return 'edit left the line empty';
  const sim = similarity(line.text, p.text);
  return sim < MIN_EDIT_SIMILARITY ? `edit changed too much (${Math.round(sim * 100)}% similar)` : undefined;
}

/**
 * Checks the clean-up pass didn't do anything drastic, without calling any API: edits that rewrite
 * a line rather than correct it are reverted, drops of lines with real content are restored, and a
 * chunk where most lines changed is left as it was. `chunks` holds each chunk's line numbers.
 */
export function auditCleanup(
  lines: readonly TranscriptLine[],
  proposals: ReadonlyMap<number, Proposal>,
  chunks: readonly { index: number; lineNumbers: readonly number[] }[],
): { accepted: Map<number, Proposal>; report: CleanupAuditReport } {
  const accepted = new Map<number, Proposal>();
  const report: CleanupAuditReport = { accepted: { edits: 0, drops: 0 }, reverted: [], discardedChunks: [] };
  const revert = (n: number, p: Proposal, reason: string) => {
    const line = lines[n - 1]!;
    report.reverted.push({ offsetMs: line.offsetMs, speaker: line.speaker, kind: p.kind, original: line.text, ...(p.kind === 'edit' ? { proposed: p.text } : {}), reason });
  };

  for (const chunk of chunks) {
    const ok = new Map<number, Proposal>();
    for (const n of chunk.lineNumbers) {
      const p = proposals.get(n);
      if (!p) continue;
      const reason = reasonToRevert(lines[n - 1]!, p);
      if (reason) revert(n, p, reason);
      else ok.set(n, p);
    }
    if (chunk.lineNumbers.length >= MIN_LINES_FOR_SHARE_CHECK && ok.size / chunk.lineNumbers.length > MAX_CHANGED_SHARE) {
      report.discardedChunks.push(chunk.index);
      for (const [n, p] of ok) revert(n, p, `the clean-up changed ${ok.size} of ${chunk.lineNumbers.length} lines in this part`);
      continue;
    }
    for (const [n, p] of ok) {
      accepted.set(n, p);
      report.accepted[p.kind === 'edit' ? 'edits' : 'drops']++;
    }
  }
  return { accepted, report };
}
