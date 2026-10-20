import { test } from 'node:test';
import assert from 'node:assert/strict';
import prism from 'prism-media';
import { opusPacketSamples } from '../src/audio/opus.js';
import { FRAME_BYTES, FRAME_SAMPLES, MusicBroadcast } from '../src/music/broadcast.js';

function sine(frames: number): Buffer {
  const pcm = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < FRAME_SAMPLES * frames; i++) {
    const v = Math.round(Math.sin((i / 48_000) * 2 * Math.PI * 440) * 8000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

test('the encoder turns 20 ms PCM frames into Discord-sized Opus packets', async () => {
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: FRAME_SAMPLES });
  const packets: Buffer[] = [];
  encoder.on('data', (p: Buffer) => packets.push(p));
  encoder.write(sine(5));
  await new Promise((r) => setImmediate(r));
  assert.equal(packets.length, 5);
  for (const p of packets) assert.equal(opusPacketSamples(p), FRAME_SAMPLES, 'each packet is 20 ms at 48 kHz');
});

test('the broadcast starts playing on the first frame, rejects partial frames, and stops cleanly', () => {
  const music = new MusicBroadcast();
  assert.equal(music.playing, false);
  assert.throws(() => music.write(Buffer.alloc(FRAME_BYTES - 2)), /whole 20 ms frames/);
  music.write(sine(2));
  assert.equal(music.playing, true);
  music.stop();
  assert.equal(music.playing, false);
});
