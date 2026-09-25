import type { PlacedClip } from './batching.js';
import type { Segment, TranscriptionResult, Word } from './types.js';

/** A transcribed line with absolute wall-clock times. */
export interface SpeakerSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Start of the utterance this line came from (identifies audio/<userId>/<startMs>.ogg). */
  utteranceStartMs: number;
}

function clipFor(clips: readonly PlacedClip[], t: number): number {
  // Inside a clip → that clip; in a gap → the nearest clip.
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const dist = t < c.offsetSec ? c.offsetSec - t : t > c.offsetSec + c.durationSec ? t - (c.offsetSec + c.durationSec) : 0;
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
    if (dist === 0) break;
  }
  return best;
}

function toAbsolute(clip: PlacedClip, t: number): number {
  const within = Math.min(Math.max(t - clip.offsetSec, 0), clip.durationSec);
  return Math.round(clip.startMs + within * 1000);
}

function joinWords(words: readonly Word[]): string {
  return words
    .map((w) => w.word)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

/**
 * Maps a batch transcription back onto the original utterances. A segment that falls inside one
 * utterance keeps Whisper's punctuated text; one that straddles utterances is split using word
 * timestamps (or assigned by its midpoint when the provider returned no words).
 */
export function remapToUtterances(result: Pick<TranscriptionResult, 'words'> & { segments: readonly Segment[] }, clips: readonly PlacedClip[]): SpeakerSegment[] {
  if (clips.length === 0) return [];
  const out: SpeakerSegment[] = [];
  const wordClip = result.words.map((w) => clipFor(clips, (w.start + w.end) / 2));
  // Some providers may return words without segments; treat the words as one segment to split.
  const segments =
    result.segments.length || !result.words.length
      ? result.segments
      : [{ start: result.words[0]!.start, end: result.words.at(-1)!.end, text: joinWords(result.words) }];

  for (const seg of segments) {
    const idx: number[] = [];
    for (let i = 0; i < result.words.length; i++) {
      const w = result.words[i]!;
      const mid = (w.start + w.end) / 2;
      if (mid >= seg.start && mid <= seg.end) idx.push(i);
    }
    const clipIdxs = new Set(idx.map((i) => wordClip[i]!));

    if (clipIdxs.size <= 1) {
      const clip = clips[idx.length ? wordClip[idx[0]!]! : clipFor(clips, (seg.start + seg.end) / 2)]!;
      out.push({ startMs: toAbsolute(clip, seg.start), endMs: toAbsolute(clip, seg.end), text: seg.text, utteranceStartMs: clip.startMs });
      continue;
    }

    // Split at utterance boundaries.
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const clip = clips[wordClip[group[0]!]!]!;
      const words = group.map((i) => result.words[i]!);
      out.push({
        startMs: toAbsolute(clip, words[0]!.start),
        endMs: toAbsolute(clip, words.at(-1)!.end),
        text: joinWords(words),
        utteranceStartMs: clip.startMs,
      });
      group = [];
    };
    for (const i of idx) {
      if (group.length && wordClip[i] !== wordClip[group[0]!]) flush();
      group.push(i);
    }
    flush();
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
