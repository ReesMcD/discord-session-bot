import type { Segment } from './types.js';

/**
 * Phrases Whisper is known to invent over silence or noise (learned from video subtitles).
 * Only dropped when they make up the entire segment.
 */
const HALLUCINATIONS = [
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'thanks for watching and see you next time',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'please like and subscribe',
  'subtitles by the amara org community',
  'transcription by castingwords',
  'you',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export type DropReason = 'empty' | 'no_speech' | 'repetition' | 'known_hallucination';

/** Why a segment should be discarded, or undefined to keep it. */
export function dropReason(segment: Segment): DropReason | undefined {
  const text = normalize(segment.text);
  if (!text) return 'empty';
  // Whisper's own heuristic: likely silence and low confidence.
  if ((segment.noSpeechProb ?? 0) > 0.6 && (segment.avgLogprob ?? 0) < -1) return 'no_speech';
  // Highly compressible text means a repetition loop ("the the the the...").
  if ((segment.compressionRatio ?? 0) > 2.4) return 'repetition';
  if (HALLUCINATIONS.includes(text)) return 'known_hallucination';
  return undefined;
}
