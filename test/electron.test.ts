import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMenu, elapsed, type MenuItem, type MenuState } from '../electron/menuModel.js';
import { bundlePath, checkForUpdate, compareVersions, downloadVerified, parseManifest, planUpdate, stageCommands, swapScript, type Release } from '../electron/updates.js';
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
  recent: [{ id: 's1', title: 'Crimson Tide — Sep 20, 2026', customTitle: false, campaign: null, startedAt: Date.UTC(2026, 8, 20), channelName: 'game-night', speakers: [], utterances: 3, has: { audio: true, transcript: true, speakerLabels: false, summary: true } }],
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
  assert.match(menu.find((i) => i.label === 'Recent Sessions')!.submenu![0]!.label!, /^Crimson Tide — Sep 20, 2026 ✓$/);
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
  assert.ok(labels(menu).includes('Install Update (0.4.0)…'));
  assert.ok(labels(menu).includes('What’s New in 0.4.0'));
  const busy = buildMenu({ ...base, update: { version: '0.4.0', url: 'u' }, updating: 'Downloading 0.4.0… 40%' });
  assert.deepEqual(busy.find((i) => i.label?.startsWith('Downloading')), { label: 'Downloading 0.4.0… 40%', enabled: false });
  assert.ok(!labels(busy).includes('Install Update (0.4.0)…'), 'no second install while one runs');
});

test('version comparison and update check', async () => {
  assert.ok(compareVersions('v0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.3.0') === 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  const fake = (tag: string) => (async () => Response.json({ tag_name: tag, html_url: 'https://example/r' })) as unknown as typeof fetch;
  assert.deepEqual(await checkForUpdate('0.3.0', fake('v0.4.0')), { version: '0.4.0', url: 'https://example/r', full: null, app: null, manifest: null });
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

const SHA = 'a'.repeat(64);
const asset = (name: string, sha256: string | null = SHA) => ({ name, url: `https://dl/${name}`, size: 10, sha256 });

test('updates: the release\'s assets and checksums, from GitHub', async () => {
  const fake = (async () =>
    Response.json({
      tag_name: 'v0.4.0',
      html_url: 'https://example/r',
      assets: [
        { name: 'Session-Bot-0.4.0-arm64.dmg', browser_download_url: 'https://dl/dmg', size: 150, digest: `sha256:${SHA}` },
        { name: 'Session-Bot-0.4.0-arm64-mac.zip', browser_download_url: 'https://dl/full', size: 145, digest: `sha256:${SHA}` },
        { name: 'Session-Bot-0.4.0-arm64-app.zip', browser_download_url: 'https://dl/app', size: 4, digest: `sha256:${SHA}` },
        { name: 'update.json', browser_download_url: 'https://dl/manifest', size: 1, digest: null },
      ],
    })) as unknown as typeof fetch;
  const r = (await checkForUpdate('0.3.0', fake))!;
  assert.deepEqual([r.full?.url, r.app?.url, r.manifest?.url, r.manifest?.sha256], ['https://dl/full', 'https://dl/app', 'https://dl/manifest', null]);
});

test('updates: the small one when Electron matches, else the whole app; never without a checksum', () => {
  const release: Release = { version: '0.4.0', url: 'u', full: asset('full.zip'), app: asset('x-app.zip'), manifest: asset('update.json') };
  const manifest = parseManifest({ version: '0.4.0', electron: '44.0.0' });
  assert.equal(planUpdate(release, manifest, '44.0.0')!.kind, 'app');
  assert.equal(planUpdate(release, manifest, '43.1.0')!.kind, 'full', 'Electron changed: the whole app');
  assert.equal(planUpdate(release, null, '44.0.0')!.kind, 'full', 'no manifest: play safe');
  assert.equal(planUpdate({ ...release, app: asset('x-app.zip', null) }, manifest, '44.0.0')!.kind, 'full');
  assert.equal(planUpdate({ ...release, app: null, full: asset('full.zip', null) }, manifest, '44.0.0'), null, 'nothing verifiable: the release page instead');
  assert.equal(parseManifest({ version: 1 }), null);
});

test('updates: a download is kept only if it matches its checksum', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const body = Buffer.from('the new app');
  const good = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const serve = (async () => new Response(body)) as unknown as typeof fetch;
  const progress: number[] = [];
  await downloadVerified({ name: 'a.zip', url: 'u', size: body.length, sha256: good }, join(dir, 'a.zip'), serve, (f) => progress.push(f));
  assert.equal(readFileSync(join(dir, 'a.zip')).toString(), 'the new app');
  assert.equal(progress.at(-1), 1);
  await assert.rejects(downloadVerified({ name: 'b.zip', url: 'u', size: 1, sha256: 'b'.repeat(64) }, join(dir, 'b.zip'), serve), /doesn't match its checksum/);
  await assert.rejects(downloadVerified({ name: 'c.zip', url: 'u', size: 1, sha256: null }, join(dir, 'c.zip'), serve), /no published checksum/);
});

test('updates: staging replaces only our Resources, re-signs, and the swap script restores on failure', () => {
  const small = stageCommands({ kind: 'app', zip: '/u/app.zip', currentApp: '/Applications/Session Bot.app', staging: '/u/staging', version: '0.4.0' });
  const flat = small.map((c) => c.join(' '));
  assert.ok(flat.includes('/usr/bin/ditto /Applications/Session Bot.app /u/staging/Session Bot.app'));
  assert.ok(flat.some((c) => c.startsWith('/bin/rm -rf /u/staging/Session Bot.app/Contents/Resources/app.asar ')));
  assert.ok(!flat.some((c) => c.includes('Frameworks')), 'Electron itself is kept');
  assert.ok(flat.includes('/usr/bin/plutil -replace CFBundleShortVersionString -string 0.4.0 /u/staging/Session Bot.app/Contents/Info.plist'));
  assert.deepEqual(small.at(-2), ['/usr/bin/codesign', '--force', '--deep', '--sign', '-', '/u/staging/Session Bot.app']);
  const full = stageCommands({ kind: 'full', zip: '/u/full.zip', currentApp: '/A/S.app', staging: '/u/staging', version: '0.4.0' }).map((c) => c.join(' '));
  assert.ok(full.includes('/usr/bin/ditto -x -k /u/full.zip /u/staging'));

  const script = swapScript({ pid: 42, appPath: "/Applications/Session Bot.app", newApp: '/u/staging/Session Bot.app', previous: '/u/previous.app', marker: "/u/it's/launched-version", version: '0.4.0' });
  assert.match(script, /kill -0 42/);
  assert.match(script, /APP='\/Applications\/Session Bot.app'/);
  assert.match(script, /MARK='\/u\/it'\\''s\/launched-version'/, 'quotes survive');
  assert.match(script, /grep -qx '0.4.0' "\$MARK"/);
  assert.match(script, /mv "\$OLD" "\$APP"\n\/usr\/bin\/open "\$APP" --args --update-failed\n$/, 'puts the old one back if the new one never starts');
  assert.equal(bundlePath('/Applications/Session Bot.app/Contents/MacOS/Session Bot'), '/Applications/Session Bot.app');
  assert.equal(bundlePath('/usr/local/bin/node'), null);
});
