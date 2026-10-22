import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config/schema.js';
import type { UtteranceRecord } from '../src/recording/UtteranceRecorder.js';
import { paths, writeJson } from '../src/session/layout.js';
import type { TranscriptLine } from '../src/shared/types.js';
import { LiveTranscriber } from '../src/transcription/live.js';
import type { BatchPlan } from '../src/transcription/batching.js';
import type { Segment, Transcriber, TranscriptionResult } from '../src/transcription/types.js';

const T0 = 1_760_000_000_000;
const SAM = '111111111111111111';
const REES = '222222222222222222';
const CHANNEL = '333333333333333333';

/** Answers each request with the next result; records which speakers' batches it got. */
class FakeTranscriber implements Transcriber {
  readonly id = 'fake';
  calls: string[] = [];
  constructor(private readonly results: (TranscriptionResult | Error)[]) {}
  async transcribe(file: string): Promise<TranscriptionResult> {
    this.calls.push(file.split('/').pop()!.split('-')[0]!);
    const next = this.results.shift() ?? { text: '', segments: [], words: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

const result = (...segments: Segment[]): TranscriptionResult => ({ text: segments.map((s) => s.text).join(' '), segments, words: [] });

function setup(transcriber: Transcriber) {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  writeJson(paths.session(dir), { id: 's1', startedAt: T0, channelId: CHANNEL, channelName: 'game-night' });
  writeJson(paths.participants(dir), { [SAM]: { displayName: 'Sam' }, [REES]: { displayName: 'Rees' } });
  const config = configSchema.parse({
    speakers: { sam: { name: 'Sam', discord: [SAM] } },
    campaigns: { game: { name: 'Game', channels: [CHANNEL] } },
    characters: { thorin: { name: 'Thorin', description: 'dwarf fighter', campaign: 'game', speaker: 'sam' } },
  });
  const rendered: BatchPlan[] = [];
  const live = new LiveTranscriber({
    sessionDir: dir,
    config,
    transcriber,
    renderBatch: async (plan, work) => {
      rendered.push(plan);
      const file = join(work, `${plan.userId}-${plan.index}.flac`);
      writeFileSync(file, 'audio');
      return file;
    },
  });
  return { dir, live, rendered };
}

const utterance = (userId: string, atSec: number, durationMs = 2000, extra: Partial<UtteranceRecord> = {}): UtteranceRecord => ({
  userId,
  startMs: T0 + atSec * 1000,
  endMs: T0 + atSec * 1000 + durationMs,
  durationMs,
  packets: durationMs / 20,
  fillerFrames: 0,
  bytes: 1000,
  file: `audio/${userId}/${T0 + atSec * 1000}.ogg`,
  ...extra,
});

test('finished utterances become named lines, in order, saved to live.jsonl and announced', async () => {
  const fake = new FakeTranscriber([result({ start: 0, end: 1.5, text: ' I attack the goblin.' }), result({ start: 0, end: 2, text: 'Roll for it.' })]);
  const { dir, live } = setup(fake);
  const announced: TranscriptLine[][] = [];
  live.on('lines', (added: TranscriptLine[]) => announced.push(added));

  live.add(utterance(SAM, 65));
  live.add(utterance(REES, 61));
  await live.flush();

  const lines = live.snapshot().lines;
  assert.deepEqual(
    lines.map((l) => [l.speaker, l.player, l.offsetMs, l.text]),
    [
      ['Rees', undefined, 61_000, 'Roll for it.'],
      ['Thorin', 'Sam', 65_000, 'I attack the goblin.'],
    ],
    'characters in campaign sessions, real names otherwise; sorted by time',
  );
  assert.equal(announced.length, 1);
  const saved = readFileSync(paths.live(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptLine);
  assert.equal(saved.length, 2);
  await live.stop();
});

test('short, broken and silent utterances cost nothing; hallucinations are dropped', async () => {
  const fake = new FakeTranscriber([result({ start: 0, end: 1, text: 'Thanks for watching!' }, { start: 1, end: 2, text: 'Next round.' })]);
  const { live } = setup(fake);
  live.add(utterance(SAM, 1, 200)); // shorter than min_utterance_ms
  live.add(utterance(SAM, 2, 2000, { error: 'decrypt failed' }));
  await live.flush();
  assert.equal(fake.calls.length, 0, 'nothing worth sending');

  live.add(utterance(SAM, 10));
  await live.flush();
  assert.deepEqual(live.snapshot().lines.map((l) => l.text), ['Next round.']);
  await live.stop();
});

test('a failed batch is reported and the next one carries on', async () => {
  const fake = new FakeTranscriber([new Error('429 rate limited'), result({ start: 0, end: 1, text: 'Back again.' })]);
  const { live } = setup(fake);
  live.add(utterance(REES, 5));
  await live.flush();
  assert.equal(live.snapshot().error, 'Some live lines were skipped: 429 rate limited');
  live.add(utterance(REES, 20));
  await live.flush();
  assert.deepEqual(live.snapshot(), { lines: [live.snapshot().lines[0]!] });
  assert.equal(live.snapshot().lines[0]!.text, 'Back again.');
  await live.stop();
});

test('one flush at a time; what arrives meanwhile waits for the next; nothing after stop', async () => {
  const fake = new FakeTranscriber([result({ start: 0, end: 1, text: 'One.' }), result({ start: 0, end: 1, text: 'Two.' })]);
  const { live, rendered } = setup(fake);
  live.add(utterance(SAM, 1));
  const first = live.flush();
  live.add(utterance(SAM, 30));
  assert.equal(live.flush(), first, 'a second call joins the running flush');
  await first;
  assert.equal(rendered.length, 1);
  await live.flush();
  assert.equal(rendered.length, 2);
  assert.deepEqual(live.snapshot().lines.map((l) => l.text), ['One.', 'Two.']);

  await live.stop();
  live.add(utterance(SAM, 60));
  await live.flush();
  assert.equal(rendered.length, 2);
});

test('a speaker’s utterances in one flush go out as one batch, at their real times', async () => {
  const fake = new FakeTranscriber([result({ start: 0, end: 1.8, text: 'First.' }, { start: 3, end: 4.5, text: 'Second.' })]);
  const { live, rendered } = setup(fake);
  live.add(utterance(REES, 10));
  live.add(utterance(REES, 40));
  await live.flush();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0]!.clips.length, 2);
  assert.deepEqual(live.snapshot().lines.map((l) => [l.offsetMs, l.text]), [
    [10_000, 'First.'],
    [40_000, 'Second.'],
  ]);
  await live.stop();
});

test('GET /bot/live: empty without a recording or bot', async () => {
  const { createApi } = await import('../src/app/api.js');
  const { ConfigStore } = await import('../src/app/configStore.js');
  const { JobRunner } = await import('../src/app/jobs.js');
  const root = mkdtempSync(join(tmpdir(), 'live-api-'));
  const api = createApi({ password: 'pw-12345678', dataDir: root, configStore: new ConfigStore(join(root, 'c.yaml')), jobs: new JobRunner(async () => {}) });
  const res = await api.request('/bot/live', { headers: { Authorization: 'Bearer pw-12345678' } });
  assert.deepEqual(await res.json(), { sessionId: null, lines: [] });
});
