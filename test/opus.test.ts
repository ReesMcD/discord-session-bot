import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENCE_FRAME, opusPacketSamples } from '../src/audio/opus.js';

test('Discord silence frame is 20 ms (960 samples)', () => {
  assert.equal(opusPacketSamples(SILENCE_FRAME), 960);
});

test('TOC decoding covers SILK, hybrid, CELT and frame-count codes', () => {
  assert.equal(opusPacketSamples(Buffer.from([(1 << 3) | 0])), 960); // SILK 20 ms
  assert.equal(opusPacketSamples(Buffer.from([(3 << 3) | 0])), 2880); // SILK 60 ms
  assert.equal(opusPacketSamples(Buffer.from([(13 << 3) | 1])), 1920); // hybrid 20 ms x2
  assert.equal(opusPacketSamples(Buffer.from([(16 << 3) | 0])), 120); // CELT 2.5 ms
  assert.equal(opusPacketSamples(Buffer.from([(31 << 3) | 3, 3])), 2880); // CELT 20 ms x3 (code 3)
  assert.equal(opusPacketSamples(Buffer.from([])), 0);
  assert.equal(opusPacketSamples(Buffer.from([(31 << 3) | 3])), 0); // code 3 missing count byte
});
