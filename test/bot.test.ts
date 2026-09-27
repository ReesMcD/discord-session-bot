import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotService, recoverInterrupted, sessionIdFor } from '../src/bot/BotService.js';
import type { BotControl, BotStatus, GuildInfo, RecordingStatus } from '../src/bot/types.js';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner, type Job } from '../src/app/jobs.js';
import { paths, writeJson } from '../src/session/layout.js';
import { OggOpusWriter } from '../src/audio/OggOpusWriter.js';
import { SILENCE_FRAME } from '../src/audio/opus.js';
import { parseConfig } from '../src/config/load.js';

test('session ids are sortable, readable, filesystem-safe and unique', () => {
  const t = Date.UTC(2026, 8, 27, 21, 5);
  assert.equal(sessionIdFor(t, 'Game Night 🎲', 'UTC', () => false), '2026-09-27-2105-game-night');
  assert.equal(sessionIdFor(t, 'Game Night', 'America/New_York', () => false), '2026-09-27-1705-game-night');
  const taken = new Set(['2026-09-27-2105-general', '2026-09-27-2105-general-2']);
  assert.equal(sessionIdFor(t, 'general', 'UTC', (id) => taken.has(id)), '2026-09-27-2105-general-3');
  assert.equal(sessionIdFor(t, '!!!', 'UTC', () => false), '2026-09-27-2105-voice');
});

test('config: after_stop and announce default on', () => {
  const { config } = parseConfig('');
  assert.equal(config.recording.after_stop, 'transcribe');
  assert.equal(config.recording.announce, true);
  assert.throws(() => parseConfig('recording:\n  after_stop: explode'), /after_stop/);
});

function interruptedSession(dataDir: string, id: string, source = 'bot') {
  const dir = join(dataDir, 'sessions', id);
  writeJson(paths.session(dir), { id, startedAt: 1_000, source });
  const audio = join(dir, 'audio', '111111111111111111');
  writeJson(join(audio, 'x.json'), {}); // creates the folder
  const w = new OggOpusWriter(join(audio, '2000.ogg'));
  w.write(SILENCE_FRAME);
  w.close();
  return dir;
}

test('interrupted bot recordings are closed and flagged; imports and finished ones are left alone', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rec-'));
  const crashed = interruptedSession(dataDir, 'crashed');
  interruptedSession(dataDir, 'craig-x', 'craig');
  const done = interruptedSession(dataDir, 'done');
  writeJson(paths.session(done), { id: 'done', startedAt: 1_000, stoppedAt: 5_000, source: 'bot' });

  assert.deepEqual(recoverInterrupted(dataDir), ['crashed']);
  const info = JSON.parse(readFileSync(paths.session(crashed), 'utf8'));
  assert.equal(info.interrupted, true);
  assert.ok(info.stoppedAt > 1_000);
  assert.deepEqual(recoverInterrupted(dataDir), [], 'second pass finds nothing');
});

test('recovered recordings are queued for processing according to after_stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  const dataDir = join(root, 'data');
  interruptedSession(dataDir, 'crashed');
  const configPath = join(root, 'config.yaml');
  writeFileSync(configPath, 'recording:\n  after_stop: summarize\n');
  const steps: string[] = [];
  const jobs = new JobRunner(async (job: Job) => void steps.push(`${job.step}:${job.sessionId}`));
  const bot = new BotService({ dataDir, configPath, log: () => {} });
  bot.attachJobs(jobs, new ConfigStore(configPath));
  await jobs.idle();
  assert.deepEqual(steps, ['transcribe:crashed', 'summarize:crashed']);
  assert.deepEqual(bot.status(), { state: 'off', recording: null });
  await assert.rejects(bot.join('123456789012345678'), /not connected/);
});

class FakeBot extends EventEmitter implements BotControl {
  recording: RecordingStatus | null = null;
  status(): BotStatus {
    return { state: 'ready', user: 'SessionBot#0001', recording: this.recording };
  }
  guilds(): GuildInfo[] {
    return [{ id: '1', name: 'The Table', channels: [{ id: '222222222222222222', name: 'game-night', members: [{ id: '3', name: 'Rees', bot: false }] }] }];
  }
  async join(channelId: string) {
    if (this.recording) throw new Error('Already recording');
    this.recording = {
      sessionId: 's1',
      guildId: '1',
      guildName: 'The Table',
      channelId,
      channelName: 'game-night',
      startedAt: 1,
      state: 'recording',
      participants: [],
      skipped: [],
      reconnects: 0,
    };
    this.emit('status', this.status());
    return this.recording;
  }
  async stop() {
    if (!this.recording) throw new Error('Not recording');
    this.recording = null;
    return { sessionId: 's1' };
  }
}

test('API: bot status, channels, join and stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'api-'));
  const bot = new FakeBot();
  const api = createApi({
    password: 'pw-12345678',
    dataDir: join(root, 'data'),
    configStore: new ConfigStore(join(root, 'config.yaml')),
    jobs: new JobRunner(async () => {}),
    bot,
  });
  const req = (path: string, init: RequestInit = {}) =>
    api.request(path, { ...init, headers: { Authorization: 'Bearer pw-12345678', 'Content-Type': 'application/json' } });

  assert.equal(((await (await req('/bot')).json()) as BotStatus).state, 'ready');
  assert.equal(((await (await req('/bot/guilds')).json()) as GuildInfo[])[0]!.channels[0]!.name, 'game-night');
  assert.equal((await req('/bot/join', { method: 'POST', body: JSON.stringify({ channelId: 'nope' }) })).status, 400);
  const joined = await req('/bot/join', { method: 'POST', body: JSON.stringify({ channelId: '222222222222222222' }) });
  assert.equal(joined.status, 200);
  assert.equal(((await joined.json()) as RecordingStatus).channelName, 'game-night');
  const again = await req('/bot/join', { method: 'POST', body: JSON.stringify({ channelId: '222222222222222222' }) });
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { error: string }).error, /Already recording/);
  assert.deepEqual(await (await req('/bot/stop', { method: 'POST' })).json(), { sessionId: 's1' });
  assert.equal((await req('/bot/stop', { method: 'POST' })).status, 409);
});

test('API without a bot reports it as off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'api-'));
  const api = createApi({ password: 'pw-12345678', dataDir: root, configStore: new ConfigStore(join(root, 'c.yaml')), jobs: new JobRunner(async () => {}) });
  const res = await api.request('/bot', { headers: { Authorization: 'Bearer pw-12345678' } });
  assert.deepEqual(await res.json(), { state: 'off', recording: null });
  const join_ = await api.request('/bot/join', { method: 'POST', headers: { Authorization: 'Bearer pw-12345678' }, body: '{"channelId":"222222222222222222"}' });
  assert.equal(join_.status, 409);
});
