import { spawn } from 'node:child_process';
import { PCM_RATE, decodeToPcm16k } from '../audio/decode.js';

export interface Clip {
  /** Absolute path to the utterance file. */
  file: string;
  /** Epoch ms when the utterance started. */
  startMs: number;
  durationSec: number;
}

export interface PlacedClip extends Clip {
  /** Where the clip starts inside the batch audio, in seconds. */
  offsetSec: number;
}

export interface BatchPlan {
  userId: string;
  index: number;
  clips: PlacedClip[];
  durationSec: number;
}

/** Silence inserted between utterances in a batch; gives Whisper a clean segment boundary. */
export const GAP_SEC = 1;

/**
 * Packs one speaker's utterances, in time order, into batches of at most `maxSec` of audio.
 * Sending batches instead of individual utterances avoids per-request minimum billing and
 * gives Whisper enough context to avoid hallucinating on very short clips.
 */
export function planBatches(userId: string, clips: readonly Clip[], maxSec: number, gapSec = GAP_SEC): BatchPlan[] {
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
  const batches: BatchPlan[] = [];
  let current: BatchPlan | undefined;
  for (const clip of sorted) {
    const needed = (current?.clips.length ? gapSec : 0) + clip.durationSec;
    if (!current || (current.clips.length > 0 && current.durationSec + needed > maxSec)) {
      current = { userId, index: batches.length, clips: [], durationSec: 0 };
      batches.push(current);
    }
    const offsetSec = current.clips.length ? current.durationSec + gapSec : 0;
    current.clips.push({ ...clip, offsetSec });
    current.durationSec = offsetSec + clip.durationSec;
  }
  return batches;
}

/** Decodes a batch's clips and lays them out on one 16 kHz mono timeline at their planned offsets. */
export async function renderBatchPcm(plan: BatchPlan): Promise<Int16Array> {
  const out = new Int16Array(Math.ceil(plan.durationSec * PCM_RATE));
  for (const clip of plan.clips) {
    const pcm = await decodeToPcm16k(clip.file);
    const start = Math.round(clip.offsetSec * PCM_RATE);
    const length = Math.min(pcm.length, Math.round(clip.durationSec * PCM_RATE), out.length - start);
    out.set(pcm.subarray(0, Math.max(0, length)), start);
  }
  return out;
}

/** Encodes 16 kHz mono PCM to FLAC (lossless, ~half the size of WAV). */
export function encodeFlac(pcm: Int16Array, outFile: string, ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg'): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', '-y', '-f', 's16le', '-ar', String(PCM_RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', outFile], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.once('error', reject);
    proc.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg flac encode failed (${code}): ${stderr.trim()}`))));
    proc.stdin.on('error', () => {}); // surfaced via close code
    proc.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
}
