import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { emptyTrash, trashSession } from '../src/app/sessions.js';
import { campaignFor } from '../src/config/roster.js';
import { configSchema } from '../src/config/schema.js';
import { paths, writeJson } from '../src/session/layout.js';
import { sessionTitle } from '../src/session/title.js';
import type { SessionDetail, SessionSummary } from '../src/shared/types.js';

const TIDE = '111111111111111111';
const ONESHOT = '222222222222222222';
const T0 = Date.UTC(2026, 9, 22, 23, 5);
const config = (extra: object = {}) =>
  configSchema.parse({ transcript: { timezone: 'UTC' }, campaigns: { tide: { name: 'Crimson Tide', channels: [TIDE] }, oneshot: { name: 'One-shot', channels: [ONESHOT] } }, ...extra });

test('names: campaign and date by default, #channel without a campaign, a hand-given name wins', () => {
  const c = config();
  assert.equal(sessionTitle({ id: 's', startedAt: T0, channelId: TIDE, channelName: 'game-night' }, c), 'Crimson Tide — Oct 22, 2026');
  assert.equal(sessionTitle({ id: 's', startedAt: T0, channelId: '333333333333333333', channelName: 'lobby' }, c), '#lobby — Oct 22, 2026');
  assert.equal(sessionTitle({ id: 's', startedAt: T0, title: '  The Siege of Phandalin ' }, c), 'The Siege of Phandalin');
  const custom = config({ sessions: { title: '{campaign} · {date} {time} ({channel})' } });
  assert.equal(sessionTitle({ id: 's', startedAt: T0, channelId: TIDE, channelName: 'game-night' }, custom), 'Crimson Tide · Oct 22, 2026 11:05 PM (#game-night)');
  assert.throws(() => config({ sessions: { title: '{campaign} {weather}' } }), /only \{campaign\}/);
});

test('a campaign picked after the fact wins over the voice channel', () => {
  const c = config();
  assert.equal(campaignFor(c, { channelId: TIDE })!.name, 'Crimson Tide');
  assert.equal(campaignFor(c, { channelId: TIDE, campaign: 'oneshot' })!.name, 'One-shot');
  assert.equal(campaignFor(c, { channelId: TIDE, campaign: 'gone' })!.name, 'Crimson Tide', 'a removed campaign falls back to the channel');
  assert.equal(sessionTitle({ id: 's', startedAt: T0, channelId: TIDE, campaign: 'oneshot' }, c), 'One-shot — Oct 22, 2026');
});

function app(opts: { recording?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'names-'));
  const dataDir = join(root, 'data');
  writeFileSync(join(root, 'config.yaml'), `transcript:\n  timezone: UTC\ncampaigns:\n  "${TIDE}":\n    name: Crimson Tide\n  "${ONESHOT}":\n    name: One-shot\n`);
  const dir = join(dataDir, 'sessions', 's1');
  writeJson(paths.session(dir), { id: 's1', startedAt: T0, stoppedAt: T0 + 60_000, channelId: TIDE, channelName: 'game-night' });
  const ran: string[] = [];
  const jobs = new JobRunner(async (job) => void ran.push(job.step));
  const bot = opts.recording
    ? { status: () => ({ state: 'ready' as const, recording: { sessionId: opts.recording } as never }), guilds: () => [], join: async () => ({}) as never, stop: async () => ({ sessionId: '' }), on: () => bot, off: () => bot }
    : undefined;
  const api = createApi({ password: 'pw', dataDir, configStore: new ConfigStore(join(root, 'config.yaml')), jobs, ...(bot ? { bot } : {}) });
  const call = (method: string, path: string, body?: unknown) =>
    api.request(path, { method, headers: { Authorization: 'Bearer pw', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { dataDir, dir, call, ran };
}

test('rename a session and pick its campaign afterwards; null puts either back', async () => {
  const { dir, call, ran } = app();
  const list = (await (await call('GET', '/sessions')).json()) as SessionSummary[];
  assert.deepEqual([list[0]!.title, list[0]!.customTitle, list[0]!.campaign], ['Crimson Tide — Oct 22, 2026', false, { key: 'crimson-tide', name: 'Crimson Tide', picked: false }]);

  let d = (await (await call('PATCH', '/sessions/s1', { title: 'The Siege' })).json()) as SessionDetail;
  assert.deepEqual([d.title, d.customTitle], ['The Siege', true]);
  d = (await (await call('PATCH', '/sessions/s1', { campaign: 'one-shot', title: null })).json()) as SessionDetail;
  assert.deepEqual([d.title, d.campaign], ['One-shot — Oct 22, 2026', { key: 'one-shot', name: 'One-shot', picked: true }]);
  assert.deepEqual(ran, [], 'no transcript yet: nothing to rebuild');

  mkdirSync(paths.transcriptsDir(dir), { recursive: true });
  d = (await (await call('PATCH', '/sessions/s1', { campaign: null })).json()) as SessionDetail;
  assert.equal(d.campaign!.name, 'Crimson Tide');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ['merge'], 'names in the transcript follow the new roster');
  assert.equal((await call('PATCH', '/sessions/s1', { campaign: '999999999999999999' })).status, 400);
  assert.equal((await call('PATCH', '/sessions/nope', { title: 'x' })).status, 404);
});

test('delete moves a session to the trash; not while it records; the trash empties after 30 days', async () => {
  const busy = app({ recording: 's1' });
  assert.equal((await busy.call('DELETE', '/sessions/s1')).status, 409);

  const { dataDir, call } = app();
  assert.equal((await call('DELETE', '/sessions/s1')).status, 200);
  assert.equal((await call('GET', '/sessions/s1')).status, 404);
  assert.deepEqual(await (await call('GET', '/sessions')).json(), []);
  const [trashed] = readdirSync(join(dataDir, 'trash'));
  assert.match(trashed!, /^\d+--s1$/);
  assert.equal((await call('DELETE', '/sessions/s1')).status, 404);

  const now = Number(trashed!.split('--')[0]);
  assert.deepEqual(emptyTrash(dataDir, now + 29 * 86_400_000), []);
  assert.deepEqual(emptyTrash(dataDir, now + 31 * 86_400_000), ['s1']);
  assert.ok(!existsSync(join(dataDir, 'trash', trashed!)));
  assert.throws(() => trashSession(dataDir, '../etc'), /not found/);
});
