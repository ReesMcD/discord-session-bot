import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOffset, mergeSegments, renderMarkdown } from '../src/transcript/merge.js';

const start = Date.UTC(2026, 8, 25, 23, 0, 0);
const s = (sec: number, dur: number, text: string) => ({ startMs: start + sec * 1000, endMs: start + (sec + dur) * 1000, text, utteranceStartMs: start });
const opts = {
  sessionStartMs: start,
  aliases: { '111': 'Rees' },
  participants: { '111': { displayName: 'rees_d' }, '222': { displayName: 'Sam' } },
  mergeGapMs: 2000,
  maxLineMs: 60_000,
};

test('formats offsets as HH:MM:SS', () => {
  assert.equal(formatOffset(0), '00:00:00');
  assert.equal(formatOffset(3_725_999), '01:02:05');
  assert.equal(formatOffset(-50), '00:00:00');
});

test('interleaves speakers chronologically, joins short pauses, names via alias then display name', () => {
  const lines = mergeSegments(
    new Map([
      ['111', [s(1, 2, 'Hi all.'), s(3.5, 1, 'Ready?'), s(20, 2, 'Okay.')]],
      ['222', [s(5, 2, 'Yep.'), s(333, 1, '')], ],
      ['333', [s(8, 1, 'Me too.')]],
    ]),
    opts,
  );
  assert.deepEqual(
    lines.map((l) => `[${formatOffset(l.offsetMs)}] ${l.speaker}: ${l.text}`),
    ['[00:00:01] Rees: Hi all. Ready?', '[00:00:05] Sam: Yep.', '[00:00:08] 333: Me too.', '[00:00:20] Rees: Okay.'],
  );
});

test('does not join past max line length', () => {
  const segs = Array.from({ length: 10 }, (_, i) => s(i * 10, 9, `part ${i}.`));
  const lines = mergeSegments(new Map([['111', segs]]), { ...opts, maxLineMs: 30_000 });
  assert.equal(lines.length, 4);
});

test('renders a markdown transcript with header', () => {
  const lines = mergeSegments(new Map([['111', [s(65, 2, 'Hello.')]]]), opts);
  const md = renderMarkdown({ id: 'test', startedAt: start, stoppedAt: start + 3_600_000, channelName: 'general' }, lines, 'America/New_York');
  assert.match(md, /^# Transcript: test/);
  assert.match(md, /\*\*Date:\*\* Sep 25, 2026, 7:00\s?PM/);
  assert.match(md, /\*\*Duration:\*\* 01:00:00/);
  assert.match(md, /\*\*Speakers:\*\* Rees/);
  assert.match(md, /\n\[00:01:05\] Rees: Hello\.\n$/);
});
