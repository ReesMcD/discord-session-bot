import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropReason } from '../src/transcription/filter.js';

const seg = (text: string, extra = {}) => ({ start: 0, end: 1, text, ...extra });

test('keeps normal speech', () => {
  assert.equal(dropReason(seg('Thank you, that works.')), undefined);
  assert.equal(dropReason(seg('Thanks for watching my back in that fight.')), undefined);
});

test('drops empty, no-speech, repetition loops and known subtitle hallucinations', () => {
  assert.equal(dropReason(seg('  ')), 'empty');
  assert.equal(dropReason(seg('Hmm', { noSpeechProb: 0.9, avgLogprob: -1.5 })), 'no_speech');
  assert.equal(dropReason(seg('Hmm', { noSpeechProb: 0.9, avgLogprob: -0.2 })), undefined);
  assert.equal(dropReason(seg('the the the the', { compressionRatio: 3.1 })), 'repetition');
  assert.equal(dropReason(seg('Thanks for watching!')), 'known_hallucination');
  assert.equal(dropReason(seg('Subtitles by the Amara.org community')), 'known_hallucination');
});
