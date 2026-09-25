import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/load.js';
import { transcribeSession } from '../src/transcription/transcribeSession.js';
import { mergeSession } from '../src/transcript/merge.js';
import { writeJson, paths } from '../src/session/layout.js';
import { OggOpusWriter } from '../src/audio/OggOpusWriter.js';
import { SILENCE_FRAME } from '../src/audio/opus.js';
import type { Transcriber, TranscriptionResult } from '../src/transcription/types.js';
import type { BatchPlan } from '../src/transcription/batching.js';
import { hasFfmpeg } from './helpers/ffmpeg.js';

const T0 = Date.UTC(2026, 8, 25, 23, 0, 0);

function writeClip(sessionDir: string, userId: string, startMs: number, seconds: number): void {
  mkdirSync(join(sessionDir, 'audio', userId), { recursive: true });
  const w = new OggOpusWriter(join(sessionDir, 'audio', userId, `${startMs}.ogg`));
  for (let i = 0; i < seconds * 50; i++) w.write(SILENCE_FRAME);
  w.close();
}

/** Pretends to transcribe: emits one segment per utterance, using the batch plan written beside the audio. */
class FakeTranscriber implements Transcriber {
  readonly id = 'fake:1';
  calls = 0;
  async transcribe(file: string): Promise<TranscriptionResult> {
    this.calls++;
    const plan = JSON.parse(readFileSync(file.replace(/\.flac$/, '.json'), 'utf8')) as BatchPlan;
    const segments = plan.clips.map((c) => ({ start: c.offsetSec + 0.2, end: c.offsetSec + c.durationSec - 0.1, text: `utterance at ${c.startMs - T0}` }));
    segments.push({ start: 0, end: 0.1, text: 'Thanks for watching!' });
    return { text: '', segments, words: [] };
  }
}

test('transcribes a session end to end, caches batches, and merges a transcript', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-'));
  writeJson(paths.session(dir), { id: 'test-session', startedAt: T0, stoppedAt: T0 + 60_000 });
  writeJson(paths.participants(dir), { '111111111111111111': { displayName: 'Alice' }, '222222222222222222': { displayName: 'Bob' } });
  writeClip(dir, '111111111111111111', T0 + 1000, 3);
  writeClip(dir, '222222222222222222', T0 + 5000, 2);
  writeClip(dir, '111111111111111111', T0 + 30_000, 4);
  writeClip(dir, '111111111111111111', T0 + 40_000, 0.2); // too short: skipped

  const { config } = parseConfig('speakers:\n  "222222222222222222": Robert\ntranscription:\n  batch_minutes: 1');
  const fake = new FakeTranscriber();
  const stats = await transcribeSession(dir, config.transcription, fake, () => {});
  assert.equal(stats.utterances, 4);
  assert.equal(stats.skippedShort, 1);
  assert.equal(stats.batches, 2);
  assert.equal(stats.dropped, 2);
  assert.equal(fake.calls, 2);
  assert.ok(existsSync(join(dir, 'transcription', 'batches', '111111111111111111-000.flac')));

  const again = await transcribeSession(dir, config.transcription, fake, () => {});
  assert.equal(again.batchesFromCache, 2);
  assert.equal(fake.calls, 2, 'second run is served from cache');

  const merged = mergeSession(dir, config);
  assert.equal(merged.lines, 3);
  const md = readFileSync(merged.file, 'utf8');
  const body = md.split('---\n')[1]!.trim().split('\n');
  assert.deepEqual(body, [
    '[00:00:01] Alice: utterance at 1000',
    '[00:00:05] Robert: utterance at 5000',
    '[00:00:30] Alice: utterance at 30000',
  ]);
});
