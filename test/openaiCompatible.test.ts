import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleTranscriber } from '../src/transcription/openaiCompatible.js';
import { createTranscriber } from '../src/transcription/factory.js';
import { parseConfig } from '../src/config/load.js';

const file = join(mkdtempSync(join(tmpdir(), 'oa-')), 'batch.flac');
writeFileSync(file, Buffer.from('fLaC fake'));

test('sends a verbose_json request with word+segment timestamps and normalizes the response', async () => {
  let seen: { url: string; auth: string | null; form: FormData } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get('authorization'), form: init.body as FormData };
    return Response.json({
      text: ' Hello world. ',
      language: 'english',
      segments: [{ start: 0, end: 1.2, text: ' Hello world.', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 }],
      words: [{ word: ' Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.6, end: 1.2 }],
    });
  }) as unknown as typeof fetch;

  const t = new OpenAICompatibleTranscriber({ provider: 'groq', apiKey: 'k', fetch: fakeFetch });
  assert.equal(t.id, 'groq:whisper-large-v3-turbo');
  const r = await t.transcribe(file, { language: 'en', prompt: 'Faerûn' });

  assert.equal(seen!.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(seen!.auth, 'Bearer k');
  assert.equal(seen!.form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(seen!.form.get('response_format'), 'verbose_json');
  assert.deepEqual(seen!.form.getAll('timestamp_granularities[]'), ['word', 'segment']);
  assert.equal(seen!.form.get('language'), 'en');
  assert.equal(seen!.form.get('prompt'), 'Faerûn');
  assert.equal((seen!.form.get('file') as File).type, 'audio/flac');

  assert.equal(r.text, 'Hello world.');
  assert.deepEqual(r.segments, [{ start: 0, end: 1.2, text: 'Hello world.', noSpeechProb: 0.01, avgLogprob: -0.2, compressionRatio: 1.1 }]);
  assert.deepEqual(r.words.map((w) => w.word), ['Hello', 'world.']);
});

test('retries 429 using Retry-After, fails fast on 401', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    return calls === 1 ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ text: 'ok', segments: [] });
  }) as unknown as typeof fetch;
  const t = new OpenAICompatibleTranscriber({ provider: 'openai', apiKey: 'k', fetch: flaky, retry: { sleep: async () => {} } });
  assert.equal((await t.transcribe(file)).text, 'ok');
  assert.equal(calls, 2);

  const denied = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
  const t2 = new OpenAICompatibleTranscriber({ provider: 'groq', apiKey: 'bad', fetch: denied, retry: { sleep: async () => {} } });
  await assert.rejects(t2.transcribe(file), /401.*bad key/);
});

test('factory reads the key from the environment and honours overrides', () => {
  const { config } = parseConfig('transcription:\n  provider: openai\n  base_url: http://localhost:8000/v1\n  model: large-v3');
  assert.throws(() => createTranscriber(config.transcription, {}), /OPENAI_API_KEY/);
  assert.equal(createTranscriber(config.transcription, { OPENAI_API_KEY: 'x' }).id, 'openai:large-v3');
});
