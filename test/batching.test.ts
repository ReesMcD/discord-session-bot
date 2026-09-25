import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBatches } from '../src/transcription/batching.js';

const clip = (startMs: number, durationSec: number) => ({ file: `${startMs}.ogg`, startMs, durationSec });

test('packs clips in time order with a gap between them', () => {
  const [b] = planBatches('u', [clip(5000, 2), clip(1000, 3)], 600);
  assert.ok(b);
  assert.deepEqual(b.clips.map((c) => [c.startMs, c.offsetSec]), [[1000, 0], [5000, 4]]);
  assert.equal(b.durationSec, 6);
});

test('starts a new batch when the limit would be exceeded', () => {
  const batches = planBatches('u', [clip(0, 4), clip(10_000, 4), clip(20_000, 4)], 9);
  assert.deepEqual(batches.map((b) => b.clips.length), [2, 1]);
  assert.deepEqual(batches.map((b) => b.index), [0, 1]);
  assert.equal(batches[1]!.clips[0]!.offsetSec, 0);
});

test('a single clip longer than the limit still gets its own batch', () => {
  const batches = planBatches('u', [clip(0, 2), clip(5000, 50), clip(90_000, 2)], 10);
  assert.deepEqual(batches.map((b) => b.clips.length), [1, 1, 1]);
});
