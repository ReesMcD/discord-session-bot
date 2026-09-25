/**
 * Renders a recorded session to WAVs for listening:
 *   <sessionDir>/render/<userId>.wav  one track per speaker, utterances placed at their real start time
 *   <sessionDir>/render/mix.wav       all speakers mixed
 *
 *   npm run spike:mix -- <sessionDir>
 *
 * Uses the filenames (audio/<userId>/<startEpochMs>.ogg) as the source of truth, so it also
 * works on sessions that crashed before utterances.jsonl was written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PCM_RATE, decodeToPcm16k, pcmToWav } from '../audio/decode.js';
import { listUtterances } from '../session/layout.js';

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error('Usage: npm run spike:mix -- <sessionDir>');
  process.exit(1);
}

const clips = listUtterances(sessionDir).map((u) => ({ userId: u.userId, startMs: u.startMs, file: u.path }));
if (clips.length === 0) {
  console.error(`No clips under ${join(sessionDir, 'audio')}`);
  process.exit(1);
}

const t0 = Math.min(...clips.map((c) => c.startMs));
const tracks = new Map<string, Int16Array[]>();
const placed: { userId: string; offset: number; pcm: Int16Array }[] = [];
let totalSamples = 0;
let failures = 0;

for (const clip of clips) {
  try {
    const pcm = await decodeToPcm16k(clip.file);
    const offset = Math.round(((clip.startMs - t0) / 1000) * PCM_RATE);
    placed.push({ userId: clip.userId, offset, pcm });
    totalSamples = Math.max(totalSamples, offset + pcm.length);
  } catch (err) {
    failures++;
    console.error(`decode failed: ${clip.file}: ${(err as Error).message}`);
  }
}

const mix = new Float32Array(totalSamples);
for (const { userId, offset, pcm } of placed) {
  let track = tracks.get(userId)?.[0];
  if (!track) {
    track = new Int16Array(totalSamples);
    tracks.set(userId, [track]);
  }
  for (let i = 0; i < pcm.length; i++) {
    track[offset + i] = pcm[i]!;
    mix[offset + i]! += pcm[i]!;
  }
}

const outDir = join(sessionDir, 'render');
mkdirSync(outDir, { recursive: true });
for (const [userId, [track]] of tracks) writeFileSync(join(outDir, `${userId}.wav`), pcmToWav(track!));
const mixed = Int16Array.from(mix, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
writeFileSync(join(outDir, 'mix.wav'), pcmToWav(mixed));

console.log(`${clips.length} clips (${failures} failed to decode), ${tracks.size} speakers, ${(totalSamples / PCM_RATE).toFixed(1)}s timeline`);
console.log(`Wrote ${outDir}/mix.wav and one WAV per speaker`);
