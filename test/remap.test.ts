import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remapToUtterances } from '../src/transcription/remap.js';
import type { PlacedClip } from '../src/transcription/batching.js';

// Two utterances: real times 10:00:00 and 10:05:00, placed at 0s and 4s in the batch.
const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 1, 10, 5, 0);
const clips: PlacedClip[] = [
  { file: 'a.ogg', startMs: T1, durationSec: 3, offsetSec: 0 },
  { file: 'b.ogg', startMs: T2, durationSec: 5, offsetSec: 4 },
];

test('segments inside one utterance keep their text and map to absolute time', () => {
  const out = remapToUtterances(
    {
      segments: [
        { start: 0.5, end: 2.5, text: 'Hello there.' },
        { start: 4.2, end: 6, text: 'Second, one!' },
      ],
      words: [],
    },
    clips,
  );
  assert.deepEqual(out, [
    { startMs: T1 + 500, endMs: T1 + 2500, text: 'Hello there.', utteranceStartMs: T1 },
    { startMs: T2 + 200, endMs: T2 + 2000, text: 'Second, one!', utteranceStartMs: T2 },
  ]);
});

test('a segment straddling two utterances is split using word timestamps', () => {
  const out = remapToUtterances(
    {
      segments: [{ start: 1, end: 5.5, text: 'end of one start of two' }],
      words: [
        { word: 'end', start: 1, end: 1.4 },
        { word: 'of', start: 1.5, end: 1.7 },
        { word: 'one.', start: 1.8, end: 2.2 },
        { word: 'start', start: 4.1, end: 4.5 },
        { word: 'of', start: 4.6, end: 4.8 },
        { word: 'two', start: 4.9, end: 5.5 },
      ],
    },
    clips,
  );
  assert.deepEqual(out.map((s) => [s.text, s.startMs - s.utteranceStartMs, s.utteranceStartMs]), [
    ['end of one.', 1000, T1],
    ['start of two', 100, T2],
  ]);
});

test('times in the silent gap are clamped to the nearest utterance', () => {
  const [a] = remapToUtterances({ segments: [{ start: 3.2, end: 3.4, text: 'hm' }], words: [] }, clips);
  assert.equal(a!.utteranceStartMs, T1);
  assert.equal(a!.startMs, T1 + 3000);
});

test('words without segments are still mapped and split per utterance', () => {
  const out = remapToUtterances(
    { segments: [], words: [{ word: 'hi', start: 0.5, end: 0.8 }, { word: 'there', start: 4.5, end: 5 }] },
    clips,
  );
  assert.deepEqual(out.map((s) => [s.text, s.utteranceStartMs]), [['hi', T1], ['there', T2]]);
});
