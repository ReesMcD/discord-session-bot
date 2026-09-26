import { formatOffset, type TranscriptLine } from '../transcript/merge.js';

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
  /** Lines from just before the chunk, shown for continuity but not extracted from. */
  context: TranscriptLine[];
  lines: TranscriptLine[];
}

export interface ChunkOptions {
  chunkMs: number;
  contextMs: number;
  /** Split further if a time window holds more text than this (very dense talk). */
  maxChars: number;
}

/** Splits a transcript into consecutive time windows (by session offset). */
export function chunkTranscript(lines: readonly TranscriptLine[], opts: ChunkOptions): Chunk[] {
  const windows: TranscriptLine[][] = [];
  for (const line of lines) {
    const slot = Math.floor(line.offsetMs / opts.chunkMs);
    (windows[slot] ??= []).push(line);
  }
  // Break any window that is too long in characters into smaller pieces.
  const groups: TranscriptLine[][] = [];
  for (const w of windows) {
    if (!w?.length) continue;
    let current: TranscriptLine[] = [];
    let chars = 0;
    for (const line of w) {
      const len = line.text.length + line.speaker.length + 14;
      if (current.length && chars + len > opts.maxChars) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(line);
      chars += len;
    }
    if (current.length) groups.push(current);
  }

  return groups.map((group, index) => {
    const startMs = group[0]!.offsetMs;
    const before = index > 0 ? groups[index - 1]! : [];
    return {
      index,
      startMs,
      endMs: group.at(-1)!.offsetMs,
      context: before.filter((l) => l.offsetMs >= startMs - opts.contextMs),
      lines: group,
    };
  });
}

export function formatLine(line: TranscriptLine, prefix = ''): string {
  return `${prefix}[${formatOffset(line.offsetMs)}] ${line.speaker}: ${line.text}`;
}

export function formatChunk(chunk: Chunk, total: number): string {
  const body = [...chunk.context.map((l) => formatLine(l, '(context) ')), ...chunk.lines.map((l) => formatLine(l))].join('\n');
  return `<transcript_section number="${chunk.index + 1}" of="${total}" from="${formatOffset(chunk.startMs)}" to="${formatOffset(chunk.endMs)}">\n${body}\n</transcript_section>`;
}
