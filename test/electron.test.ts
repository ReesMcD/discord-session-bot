import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMenu, elapsed, type MenuItem, type MenuState } from '../electron/menuModel.js';
import { checkForUpdate, compareVersions } from '../electron/updates.js';
import { applyToEnv, generatePassword, SecretStore } from '../electron/secrets.js';

const labels = (items: MenuItem[]) => items.map((i) => i.label ?? '---');
const base: MenuState = {
  bot: { state: 'ready', user: 'Bot#1', recording: null },
  guilds: [
    {
      id: '1',
      name: 'The Table',
      channels: [
        { id: '10', name: 'lobby', members: [] },
        { id: '11', name: 'game-night', members: [{ id: 'a', name: 'Rees', bot: false }, { id: 'b', name: 'Groovy', bot: true }] },
      ],
    },
  ],
  recent: [{ id: 's1', startedAt: Date.UTC(2026, 8, 20), channelName: 'game-night', speakers: [], utterances: 3, has: { audio: true, transcript: true, speakerLabels: false, summary: true } }],
  openAtLogin: false,
  update: null,
  now: 0,
  missingKeys: [],
};

test('idle menu: join submenu lists busiest channels first with who is there', () => {
  const menu = buildMenu(base);
  assert.equal(menu[0]!.label, 'Join & Record');
  assert.deepEqual(labels(menu[0]!.submenu!), ['game-night — Rees', 'lobby']);
  assert.deepEqual(menu[0]!.submenu![0]!.action, { kind: 'join', channelId: '11' });
  assert.ok(labels(menu).includes('Recent Sessions'));
  assert.match(menu.find((i) => i.label === 'Recent Sessions')!.submenu![0]!.label!, /^#game-night · .* ✓$/);
  assert.deepEqual(menu.at(-1)!.action, { kind: 'quit' });
});

test('recording menu: status, participants, stop', () => {
  const menu = buildMenu({
    ...base,
    now: 3_725_000,
    bot: {
      state: 'ready',
      recording: {
        sessionId: 's2',
        guildId: '1',
        guildName: 'The Table',
        channelId: '11',
        channelName: 'game-night',
        startedAt: 0,
        state: 'recording',
        participants: [{ id: 'a', name: 'Rees', utterances: 3, audioMs: 1000, speaking: true }],
        skipped: [],
        reconnects: 0,
      },
    },
  });
  assert.deepEqual(labels(menu).slice(0, 4), ['● Recording #game-night — 1:02:05', '    🗣 Rees', 'Stop Recording', 'Show Recording…']);
  assert.equal(elapsed(65_000), '01:05');
});

test('missing keys and updates are surfaced; disconnected bot says why', () => {
  const menu = buildMenu({ ...base, missingKeys: ['Discord token'], update: { version: '0.4.0', url: 'u' }, bot: { state: 'error', error: 'Discord rejected the bot token', recording: null } });
  assert.equal(menu[0]!.label, '⚠︎ Set up: Discord token…');
  assert.deepEqual(menu[0]!.action, { kind: 'open', route: 'settings/keys' });
  assert.ok(labels(menu).includes('Discord: Discord rejected the bot token'));
  assert.ok(labels(menu).includes('Update Available (0.4.0)…'));
});

test('version comparison and update check', async () => {
  assert.ok(compareVersions('v0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.3.0') === 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  const fake = (tag: string) => (async () => Response.json({ tag_name: tag, html_url: 'https://example/r' })) as unknown as typeof fetch;
  assert.deepEqual(await checkForUpdate('0.3.0', fake('v0.4.0')), { version: '0.4.0', url: 'https://example/r' });
  assert.equal(await checkForUpdate('0.4.0', fake('v0.4.0')), null);
  assert.equal(await checkForUpdate('0.4.0', (async () => new Response('', { status: 404 })) as unknown as typeof fetch), null);
});

test('secret store: creates a password, encrypts at rest, updates and clears keys', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sec-')), 'secrets.bin');
  const cipher = { encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const store = new SecretStore(file, cipher);
  const first = store.read();
  assert.match(first.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.equal(store.read().password, first.password, 'stable across reads');
  assert.ok(!readFileSync(file).toString().includes(first.password), 'not stored in plain text');

  store.update({ discord: ' token ', groq: 'g' });
  assert.deepEqual({ ...store.read(), password: 'x' }, { password: 'x', discord: 'token', groq: 'g' });
  store.update({ groq: '' });
  assert.equal(store.read().groq, undefined);

  writeFileSync(file, 'garbage');
  assert.match(store.read().password, /-/, 'unreadable file starts fresh instead of crashing');

  const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'old' };
  applyToEnv({ password: 'p', discord: 'd' }, env);
  assert.deepEqual(env, { DISCORD_TOKEN: 'd' });
  assert.notEqual(generatePassword(), generatePassword());
});
