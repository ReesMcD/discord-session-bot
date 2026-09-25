import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OggOpusWriter } from '../src/audio/OggOpusWriter.js';
import { SILENCE_FRAME } from '../src/audio/opus.js';
import { PCM_RATE, decodeToPcm16k } from '../src/audio/decode.js';
import { readOgg } from './helpers/oggReader.js';
import { FFMPEG, ffmpeg, hasFfmpeg } from './helpers/ffmpeg.js';

const dir = mkdtempSync(join(tmpdir(), 'ogg-test-'));

test('writes valid pages: BOS head, tags, audio, EOS; CRCs and granules correct', () => {
  const path = join(dir, 'silence.ogg');
  const w = new OggOpusWriter(path, { packetsPerPage: 10 });
  for (let i = 0; i < 25; i++) w.write(SILENCE_FRAME);
  assert.equal(w.samples, 25 * 960);
  w.close();

  const pages = readOgg(readFileSync(path));
  assert.ok(pages.every((p) => p.crcOk), 'all CRCs valid');
  assert.ok(pages.every((p, i) => p.sequence === i), 'sequential page numbers');
  assert.equal(new Set(pages.map((p) => p.serial)).size, 1);
  assert.equal(pages[0]!.flags, 0x02);
  assert.equal(pages[0]!.packets[0]!.toString('ascii', 0, 8), 'OpusHead');
  assert.equal(pages[1]!.packets[0]!.toString('ascii', 0, 8), 'OpusTags');
  const audio = pages.slice(2);
  assert.deepEqual(audio.map((p) => p.packets.length), [10, 10, 5]);
  assert.deepEqual(audio.map((p) => p.granule), [9600n, 19200n, 24000n]);
  assert.equal(audio.at(-1)!.flags, 0x04);
});

test('handles packets whose length is a multiple of 255 (needs a 0 lacing value)', () => {
  const path = join(dir, 'lacing.ogg');
  const w = new OggOpusWriter(path);
  const big = Buffer.alloc(510, 0);
  big[0] = 0xf8; // CELT 20 ms TOC
  w.write(big);
  w.write(SILENCE_FRAME);
  w.close();
  const audio = readOgg(readFileSync(path)).slice(2);
  assert.deepEqual(audio.flatMap((p) => p.packets.map((x) => x.length)), [510, 3]);
});

test('empty utterance still produces a well-formed file', () => {
  const path = join(dir, 'empty.ogg');
  new OggOpusWriter(path).close();
  const pages = readOgg(readFileSync(path));
  assert.equal(pages.length, 3);
  assert.equal(pages[2]!.flags, 0x04);
});

test('refuses to overwrite an existing file', () => {
  const path = join(dir, 'exists.ogg');
  writeFileSync(path, 'x');
  assert.throws(() => new OggOpusWriter(path));
});

test('round-trips real Opus through ffmpeg, including a crash-truncated file', { skip: !hasFfmpeg && `no ffmpeg (${FFMPEG})` }, async () => {
  const source = join(dir, 'source.ogg');
  const r = ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', '-frame_duration', '20', '-b:a', '64k', source]);
  assert.equal(r.status, 0, r.stderr);
  const packets = readOgg(readFileSync(source)).flatMap((p) => p.packets).slice(2);
  assert.ok(packets.length >= 149, `got ${packets.length} packets`);

  const out = join(dir, 'remuxed.ogg');
  const w = new OggOpusWriter(out);
  for (const p of packets) w.write(p);
  w.close();

  const pcm = await decodeToPcm16k(out);
  const seconds = pcm.length / PCM_RATE;
  assert.ok(Math.abs(seconds - packets.length * 0.02) < 0.05, `decoded ${seconds}s`);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 1500, `audio is not silent (peak ${peak})`);

  // Simulate a crash: file cut off mid-page, no EOS.
  const truncated = join(dir, 'truncated.ogg');
  const bytes = readFileSync(out);
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const partial = await decodeToPcm16k(truncated);
  // Pages hold 1 s of audio, so everything up to the last complete page survives.
  assert.ok(partial.length / PCM_RATE >= 0.99, `truncated file still decodes ${partial.length / PCM_RATE}s`);
});
