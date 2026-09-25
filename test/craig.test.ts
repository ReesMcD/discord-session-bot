import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCraigInfo, importCraig } from '../src/import/craig.js';
import { parseSilenceDetect, speechRegions } from '../src/import/silence.js';
import { listUtterances, paths } from '../src/session/layout.js';
import { parseConfig } from '../src/config/load.js';
import { FFMPEG, ffmpeg, hasFfmpeg } from './helpers/ffmpeg.js';

// Matches what Craig's kitchen writes (apps/kitchen/src/util/recording.ts), CRLF line endings included.
const INFO = [
  'Recording aBcD1234',
  '',
  'Guild:\t\tThe Table (111111111111111111)',
  'Channel:\tgame-night (222222222222222222)',
  'Requester:\trees#0 (333333333333333333)',
  'Start time:\t2026-09-20T23:00:00.000Z',
  '',
  'Tracks:',
  '\trees#0 (333333333333333333)',
  '\tsam#0 (444444444444444444)',
  '\tGroovy#7043 (555555555555555555)',
  '',
  'Notes:',
  '\t0:10:00.00: combat starts',
  '',
].join('\r\n');

test('parses Craig info.txt', () => {
  const info = parseCraigInfo(INFO);
  assert.equal(info.recordingId, 'aBcD1234');
  assert.equal(info.startTime, Date.UTC(2026, 8, 20, 23));
  assert.equal(info.guild, 'The Table');
  assert.equal(info.channel, 'game-night');
  assert.deepEqual(info.tracks, [
    { track: 1, username: 'rees', userId: '333333333333333333' },
    { track: 2, username: 'sam', userId: '444444444444444444' },
    { track: 3, username: 'Groovy', userId: '555555555555555555' },
  ]);
  assert.throws(() => parseCraigInfo('Recording x\r\n'), /Start time/);
});

test('parses silencedetect output, including silence running to the end', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 0',
    '[silencedetect @ 0x1] silence_end: 1.02 | silence_duration: 1.02',
    '[silencedetect @ 0x1] silence_start: 3.5',
    '[silencedetect @ 0x1] silence_end: 6 | silence_duration: 2.5',
    '[silencedetect @ 0x1] silence_start: 8.1',
  ].join('\n');
  assert.deepEqual(parseSilenceDetect(stderr, 10), [
    { startSec: 0, endSec: 1.02 },
    { startSec: 3.5, endSec: 6 },
    { startSec: 8.1, endSec: 10 },
  ]);
});

test('speech regions are padded, joined across tiny gaps, and short blips dropped', () => {
  const silences = [
    { startSec: 0, endSec: 1 },
    { startSec: 3, endSec: 3.2 }, // tiny pause: joined
    { startSec: 5, endSec: 9 },
    { startSec: 9.1, endSec: 20 }, // 0.1 s blip at 9.0–9.1: dropped
  ];
  const regions = speechRegions(silences, 20, { padSec: 0.1, minSec: 0.4, joinGapSec: 0.3 });
  assert.equal(regions.length, 1);
  assert.ok(Math.abs(regions[0]!.startSec - 0.9) < 1e-9 && Math.abs(regions[0]!.endSec - 5.1) < 1e-9);
});

function tone(out: string, freq: number, windows: [number, number][], seconds = 12): void {
  const enable = windows.map(([a, b]) => `between(t,${a},${b})`).join('+');
  const r = ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`, '-af', `volume=enable='not(${enable})':volume=0`, '-c:a', 'flac', out]);
  assert.equal(r.status, 0, r.stderr);
}

test('imports a Craig export (zip) into the session layout, honouring ignore_users', { skip: !hasFfmpeg && `no ffmpeg (${FFMPEG})` }, async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'craig-export-'));
  writeFileSync(join(exportDir, 'info.txt'), INFO);
  tone(join(exportDir, '1-rees_0.flac'), 300, [[1, 3], [6, 8]]);
  tone(join(exportDir, '2-sam_0.flac'), 500, [[4, 5.5]]);
  tone(join(exportDir, '3-Groovy_7043.flac'), 800, [[0, 12]]);
  const zip = join(mkdtempSync(join(tmpdir(), 'craig-zip-')), 'craig.zip');
  execFileSync('zip', ['-q', '-j', zip, ...['info.txt', '1-rees_0.flac', '2-sam_0.flac', '3-Groovy_7043.flac'].map((f) => join(exportDir, f))]);

  const dataDir = mkdtempSync(join(tmpdir(), 'data-'));
  const { config } = parseConfig('recording:\n  ignore_users: ["555555555555555555"]');
  const result = await importCraig(zip, dataDir, config, () => {});

  assert.equal(result.sessionId, 'craig-aBcD1234');
  assert.deepEqual(result.speakers.map((s) => [s.name, s.utterances, s.skipped]), [
    ['rees', 2, undefined],
    ['sam', 1, undefined],
    ['Groovy', 0, 'ignored_user'],
  ]);

  const start = Date.UTC(2026, 8, 20, 23);
  const utts = listUtterances(result.sessionDir).map((u) => [u.userId, (u.startMs - start) / 1000]);
  assert.equal(utts.length, 3);
  for (const [userId, expected] of [['333333333333333333', 1], ['444444444444444444', 4], ['333333333333333333', 6]] as const) {
    assert.ok(
      utts.some(([id, t]) => id === userId && Math.abs((t as number) - expected) < 0.3),
      `utterance for ${userId} near ${expected}s in ${JSON.stringify(utts)}`,
    );
  }
  const session = JSON.parse(readFileSync(paths.session(result.sessionDir), 'utf8'));
  assert.equal(session.startedAt, start);
  assert.equal(session.channelName, 'game-night');
  assert.deepEqual(JSON.parse(readFileSync(paths.participants(result.sessionDir), 'utf8'))['444444444444444444'], { displayName: 'sam', username: 'sam' });

  await assert.rejects(importCraig(zip, dataDir, config, () => {}), /already has audio/);
});
