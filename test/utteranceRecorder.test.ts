import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { UtteranceRecorder } from '../src/recording/UtteranceRecorder.js';
import { SILENCE_FRAME } from '../src/audio/opus.js';
import { readOgg } from './helpers/oggReader.js';

function fakeClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('writes audio/<userId>/<start>.ogg and fills pauses so file time matches wall time', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'utt-'));
  const clock = fakeClock(1_700_000_000_000);
  const stream = new PassThrough({ objectMode: true });
  const done = new UtteranceRecorder({ sessionDir, userId: 'alice', now: clock.now }).record(stream);

  const frame = Buffer.from([0xfc, 0x01, 0x02]); // CELT 20 ms
  for (let i = 0; i < 50; i++) {
    stream.write(frame);
    await new Promise((r) => setImmediate(r));
    clock.advance(20);
  }
  clock.advance(500); // speaker paused; Discord sends nothing
  for (let i = 0; i < 25; i++) {
    stream.write(frame);
    await new Promise((r) => setImmediate(r));
    clock.advance(20);
  }
  stream.end();
  const rec = await done;

  assert.ok(rec);
  assert.equal(rec.file, join('audio', 'alice', '1700000000000.ogg'));
  assert.ok(existsSync(join(sessionDir, rec.file)));
  assert.equal(rec.packets, 75);
  assert.equal(rec.fillerFrames, 25);
  const wallMs = rec.endMs - rec.startMs + 20;
  assert.ok(Math.abs(rec.durationMs - wallMs) <= 20, `file ${rec.durationMs}ms vs wall ${wallMs}ms`);

  const packets = readOgg(readFileSync(join(sessionDir, rec.file))).flatMap((p) => p.packets).slice(2);
  assert.equal(packets.filter((p) => p.equals(SILENCE_FRAME)).length, 25);
});

test('small jitter is not filled, and huge gaps are capped', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'utt-'));
  const clock = fakeClock(0);
  const stream = new PassThrough({ objectMode: true });
  const done = new UtteranceRecorder({ sessionDir, userId: 'bob', now: clock.now, maxFillMs: 1000 }).record(stream);
  const frame = Buffer.from([0xfc]);
  stream.write(frame);
  await new Promise((r) => setImmediate(r));
  clock.advance(80); // 60 ms late: jitter
  stream.write(frame);
  await new Promise((r) => setImmediate(r));
  clock.advance(10_000); // way longer than the end-of-utterance timeout could allow
  stream.write(frame);
  await new Promise((r) => setImmediate(r));
  stream.end();
  const rec = await done;
  assert.ok(rec);
  assert.equal(rec.fillerFrames, 50); // capped at 1000 ms, not ~10 s
});

test('a stream that ends with no packets writes nothing', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'utt-'));
  const stream = new PassThrough({ objectMode: true });
  const done = new UtteranceRecorder({ sessionDir, userId: 'carol' }).record(stream);
  stream.end();
  stream.resume();
  assert.equal(await done, undefined);
  assert.equal(existsSync(join(sessionDir, 'audio')), false);
});

test('a stream error is reported on the record, and the file is closed', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'utt-'));
  const stream = new PassThrough({ objectMode: true });
  const done = new UtteranceRecorder({ sessionDir, userId: 'dave' }).record(stream);
  stream.write(Buffer.from([0xfc]));
  await new Promise((r) => setImmediate(r));
  stream.destroy(new Error('Failed to decrypt'));
  const rec = await done;
  assert.equal(rec?.error, 'Failed to decrypt');
  assert.equal(readOgg(readFileSync(join(sessionDir, rec!.file))).at(-1)!.flags, 0x04);
});
