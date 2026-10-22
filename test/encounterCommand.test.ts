import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { COMMANDS } from '../src/bot/commands.js';
import { encounterChoices, runEncounterCommand, type EncounterCommandDeps, type EncounterPost } from '../src/bot/encounterCommand.js';
import type { BotStatus } from '../src/bot/types.js';
import { EncounterStore } from '../src/encounter/store.js';
import type { WikiEncounter, WikiEncounterSummary } from '../src/shared/types.js';

const SUMMARY: WikiEncounterSummary = { id: 'ambush', title: 'Ambush at Long Wade', campaign: 'Crimson Tide', place: 'Long Wade Post', difficulty: 'moderate', party_level: 3, xp: 450, status: 'ready', run: false, updated: null };
const WIKI: WikiEncounter = {
  ...SUMMARY,
  summary: null,
  read_aloud: null,
  setup: null,
  tactics: null,
  changes: null,
  treasure: null,
  creatures: [{ name: 'Bandit', source: 'srd', ac: 12, hp: 11, count: 2 }],
  map: { tokens: [{ id: 'bandit', name: 'Bandit', kind: 'monster', hidden: true }] },
  party: [{ name: 'Aria', player: 'Rees', level: 3, class: null, race: null, ac: 16, hp: 28, passive_perception: null }],
};

function deps(publicUrl: string | null = 'https://mac.tail1234.ts.net') {
  const store = new EncounterStore(mkdtempSync(join(tmpdir(), 'cmd-')), undefined, () => {});
  const asked: string[] = [];
  const d: EncounterCommandDeps = {
    store,
    wiki: {
      list: async () => [SUMMARY, { ...SUMMARY, id: 'old', title: 'Wolves', run: true }],
      get: async (id, campaign) => {
        asked.push(`${campaign}/${id}`);
        if (id !== 'ambush') throw new (await import('../src/encounter/wiki.js')).WikiEncountersError('No encounter "x".', 404);
        return WIKI;
      },
    },
    joinUrl: () => (publicUrl && store.current()?.join ? `${publicUrl}/play/${store.current()!.join!.code}` : null),
  };
  return { d, store, asked };
}

test('/encounter is registered for the DM (Manage Server), with start, link and end', () => {
  const cmd = COMMANDS.find((c) => c.name === 'encounter')!;
  assert.equal(cmd.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.deepEqual(cmd.options!.map((o) => o.name), ['start', 'link', 'end']);
});

test('autocomplete lists prepared encounters not yet run, matching what is typed', () => {
  const list = [SUMMARY, { ...SUMMARY, id: 'old', title: 'Wolves', run: true }, { ...SUMMARY, id: 'b', title: 'Bridge troll', campaign: 'Other', place: null }];
  assert.deepEqual(encounterChoices('', list).map((c) => c.name), ['Ambush at Long Wade · Long Wade Post (Crimson Tide)', 'Bridge troll (Other)']);
  assert.deepEqual(encounterChoices('wade', list).map((c) => c.value), ['wiki:Crimson Tide\nambush']);
  assert.equal(encounterChoices('', Array.from({ length: 40 }, (_, i) => ({ ...SUMMARY, id: `e${i}` }))).length, 25, 'Discord takes 25 at most');
});

test('/encounter start: a wiki encounter posts its join link; a blank one by name; one at a time', async () => {
  const { d, store, asked } = deps();
  const r = await runEncounterCommand('start', 'wiki:Crimson Tide\nambush', d);
  assert.deepEqual(asked, ['Crimson Tide/ambush']);
  assert.match(r.reply, /^Started \*\*Ambush at Long Wade\*\*/);
  const code = store.current()!.join!.code;
  assert.deepEqual(r.post, {
    title: '⚔️ Ambush at Long Wade',
    description: 'Long Wade Post. Tap **Join** to follow the fight and take your turns: on your phone or in a browser, nothing to install.',
    url: `https://mac.tail1234.ts.net/play/${code}`,
  });
  assert.equal(store.current()!.combatants.length, 3);
  assert.match((await runEncounterCommand('start', 'Another', d)).reply, /still running/);
  assert.equal((await runEncounterCommand('link', undefined, d)).post!.url, r.post!.url);

  const blank = deps();
  assert.equal((await runEncounterCommand('start', 'Tavern brawl', blank.d)).post!.title, '⚔️ Tavern brawl');
  assert.match((await runEncounterCommand('start', 'wiki:Crimson Tide\nx', deps().d)).reply, /^Couldn't: No encounter/);
});

test('without a public address the DM is told how to set it up, and nothing is posted', async () => {
  const { d } = deps(null);
  const r = await runEncounterCommand('start', 'Brawl', d);
  assert.equal(r.post, undefined);
  assert.match(r.reply, /Tailscale Funnel.*Settings → Players/);
  assert.match((await runEncounterCommand('link', undefined, d)).reply, /Settings → Players/);
});

test('/encounter end: the DM gets the summary; players only hear it is over (no hidden foes named)', async () => {
  const { d } = deps();
  assert.equal((await runEncounterCommand('end', undefined, d)).reply, 'No encounter is running.');
  await runEncounterCommand('start', 'wiki:Crimson Tide\nambush', d);
  const r = await runEncounterCommand('end', undefined, d);
  assert.match(r.reply, /^Ended\. Ambush at Long Wade: 0 rounds\. Still standing: Bandit 1, Bandit 2\.$/);
  assert.deepEqual(r.post, { title: 'Ambush at Long Wade is over', description: 'After 0 rounds. The join link no longer works.' });
  assert.ok(!JSON.stringify(r.post).includes('Bandit'));
  assert.equal(d.store.current(), null);
});

test('the app\'s Post to Discord: needs a public address and the bot; posts the join link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'post-'));
  writeFileSync(join(root, 'config.yaml'), 'players:\n  public_url: https://mac.tail1234.ts.net\n');
  const store = new EncounterStore(join(root, 'data'), undefined, () => {});
  const posts: EncounterPost[] = [];
  const bot = {
    status: (): BotStatus => ({ state: 'ready', recording: null }),
    guilds: () => [],
    join: async () => {
      throw new Error('unused');
    },
    stop: async () => ({ sessionId: '' }),
    on: () => bot,
    off: () => bot,
    postEncounter: async (post: EncounterPost) => (posts.push(post), { channelName: 'game-night' }),
  };
  const api = createApi({ password: 'pw', dataDir: join(root, 'data'), configStore: new ConfigStore(join(root, 'config.yaml')), jobs: new JobRunner(async () => {}), encounters: store, bot });
  const post = () => api.request('/encounter/post', { method: 'POST', headers: { Authorization: 'Bearer pw' } });
  assert.equal((await post()).status, 400, 'nothing running');
  const code = store.start({ title: 'Brawl' }).join!.code;
  const ok = await post();
  assert.deepEqual(await ok.json(), { message: 'Posted in #game-night' });
  assert.equal(posts[0]!.url, `https://mac.tail1234.ts.net/play/${code}`);
});
