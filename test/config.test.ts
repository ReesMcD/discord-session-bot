import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../src/config/load.js';

test('empty config yields full defaults', () => {
  const { config, hash } = parseConfig('');
  assert.equal(config.recording.ignore_bots, true);
  assert.equal(config.recording.silence_ms, 1000);
  assert.equal(config.transcription.provider, 'groq');
  assert.equal(config.transcript.merge_gap_seconds, 2);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('unquoted Discord IDs keep full precision as keys and values', () => {
  const { config } = parseConfig(`
recording:
  ignore_users: [234395307759108106, "334395307759108107"]
speakers:
  123456789012345678: Rees
`);
  assert.deepEqual(config.recording.ignore_users, ['234395307759108106', '334395307759108107']);
  assert.deepEqual(config.speakers, { '123456789012345678': 'Rees' });
});

test('typos and bad values produce a readable ConfigError', () => {
  assert.throws(() => parseConfig('recording:\n  ignore_user: []'), (e: Error) => e instanceof ConfigError && /ignore_user/.test(e.message));
  assert.throws(() => parseConfig('transcription:\n  provider: whisperx'), ConfigError);
  assert.throws(() => parseConfig('recording:\n  ignore_users: [12]'), /Discord ID/);
  assert.throws(() => parseConfig('transcript:\n  timezone: Mars/Olympus'), /time zone/);
  assert.throws(() => parseConfig('recording: [unclosed'), /invalid YAML/);
});

test('the example config is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const { config } = parseConfig(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  assert.equal(config.transcription.provider, 'groq');
});
