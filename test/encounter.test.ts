import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { configSchema } from '../src/config/schema.js';
import { applyAction, EncounterError, newEncounter, sortOrder, type RuleDeps } from '../src/encounter/rules.js';
import { EncounterStore } from '../src/encounter/store.js';
import { encounterFromWiki, encountersUrl, WikiEncounters } from '../src/encounter/wiki.js';
import type { EncounterAction, EncounterState, WikiEncounter } from '../src/shared/types.js';

/** A fixed clock and scripted d20 rolls. */
function deps(rolls: number[] = []): RuleDeps {
  let t = Date.UTC(2026, 9, 22, 20);
  return { now: () => (t += 1000), d20: () => rolls.shift() ?? 10 };
}

/** Applies actions in order. */
function run(state: EncounterState, actions: EncounterAction[], d = deps()): EncounterState {
  return actions.reduce((s, a) => applyAction(s, a, d), state);
}

/** Aria (PC), Brom (PC) and two goblins, initiative set, not yet begun. */
function party(): EncounterState {
  return run(newEncounter('e1', 'Ambush', 0), [
    { type: 'add', combatant: { name: 'Aria', kind: 'pc', ac: 15, hp: 20, dex: 14 } },
    { type: 'add', combatant: { name: 'Brom', kind: 'pc', ac: 18, hp: 30, dex: 10 } },
    { type: 'add', combatant: { name: 'Goblin', ac: 15, hp: 7, dex: 14, count: 2 } },
    { type: 'initiative', id: 'aria', value: 15 },
    { type: 'initiative', id: 'brom', value: 12 },
    { type: 'initiative', id: 'goblin-1', value: 15 },
    { type: 'initiative', id: 'goblin-2', value: 8 },
  ]);
}

test('initiative order: highest first; a tie goes to higher Dexterity, then PCs; unrolled last', () => {
  const s = party();
  assert.deepEqual(s.order, ['aria', 'goblin-1', 'brom', 'goblin-2'], 'Aria and Goblin 1 tie on 15 and Dex 14: the PC goes first');
  const withDex = run(s, [{ type: 'update', id: 'goblin-1', name: 'Goblin Boss' }, { type: 'add', combatant: { name: 'Wolf', dex: 15 } }]);
  assert.equal(sortOrder(withDex.combatants).at(-1), 'wolf', 'no initiative yet');
  const quick = run(s, [{ type: 'add', combatant: { name: 'Scout', dex: 16 } }, { type: 'initiative', id: 'scout', value: 15 }]);
  assert.deepEqual(quick.order.slice(0, 3), ['scout', 'aria', 'goblin-1'], 'higher Dex wins the tie');
});

test('monsters roll their own initiative; players type theirs, and the fight waits for them', () => {
  let s = run(newEncounter('e', 'Fight', 0), [
    { type: 'add', combatant: { name: 'Aria', kind: 'pc' } },
    { type: 'add', combatant: { name: 'Orc', initiativeBonus: 1, count: 2 } },
  ]);
  s = applyAction(s, { type: 'rollInitiative' }, deps([17, 3]));
  assert.deepEqual(s.combatants.map((c) => c.initiative), [null, 18, 4]);
  assert.throws(() => applyAction(s, { type: 'begin' }, deps()), /waiting on initiative: Aria/);
  s = run(s, [{ type: 'initiative', id: 'aria', value: 9 }, { type: 'begin' }]);
  assert.deepEqual([s.status, s.round, s.turn], ['running', 1, 'orc-1']);
});

test('turns wrap into the next round; Previous steps back but never before round 1', () => {
  let s = run(party(), [{ type: 'begin' }]);
  assert.equal(s.turn, 'aria');
  assert.throws(() => applyAction(s, { type: 'damage', id: 'nobody', amount: 1 }, deps()), EncounterError);
  s = run(s, [{ type: 'previous' }]);
  assert.deepEqual([s.round, s.turn], [1, 'aria'], 'nothing before the first turn');
  s = run(s, [{ type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }]);
  assert.deepEqual([s.round, s.turn], [2, 'aria']);
  assert.ok(s.log.some((l) => l.text === 'Round 2'));
  s = run(s, [{ type: 'previous' }]);
  assert.deepEqual([s.round, s.turn], [1, 'goblin-2']);
});

test('condition timers count down on the right turn and run out', () => {
  // Brom frightens Goblin 1 until the end of Brom's next turn (1 round, ticking on Brom's turn end).
  let s = run(party(), [{ type: 'begin' }, { type: 'condition', id: 'goblin-1', name: 'Frightened', rounds: 1, tick: { on: 'end', of: 'brom' } }]);
  // Poisoned for 2 rounds, ticking at the start of its own turn.
  s = run(s, [{ type: 'condition', id: 'goblin-2', name: 'Poisoned', rounds: 2, tick: { on: 'start', of: 'goblin-2' } }]);
  s = run(s, [{ type: 'next' }]); // Goblin 1's turn
  assert.ok(s.combatants.find((c) => c.id === 'goblin-1')!.conditions.some((c) => c.name === 'Frightened'));
  s = run(s, [{ type: 'next' }, { type: 'next' }]); // end of Brom's turn → Goblin 2's turn starts
  const g1 = s.combatants.find((c) => c.id === 'goblin-1')!;
  const g2 = s.combatants.find((c) => c.id === 'goblin-2')!;
  assert.equal(g1.conditions.length, 0, 'Frightened ended with Brom\'s turn');
  assert.equal(g2.conditions[0]!.rounds, 1, 'Poisoned ticked once at the start of its turn');
  s = run(s, [{ type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }]);
  assert.equal(s.combatants.find((c) => c.id === 'goblin-2')!.conditions.length, 0);
  assert.ok(s.log.some((l) => l.text === 'Goblin 2 is no longer Poisoned'));
  // Without rounds a condition stays until removed; Exhaustion keeps a level.
  s = run(s, [{ type: 'condition', id: 'brom', name: 'Exhaustion', level: 9 }]);
  assert.deepEqual(s.combatants.find((c) => c.id === 'brom')!.conditions, [{ name: 'Exhaustion', level: 6 }]);
});

test('damage takes temporary HP first; a PC at 0 falls unconscious and healing wakes them', () => {
  let s = run(party(), [{ type: 'tempHp', id: 'aria', amount: 5 }, { type: 'tempHp', id: 'aria', amount: 3 }]);
  assert.equal(s.combatants[0]!.tempHp, 5, 'temporary HP don\'t stack: the higher stays');
  s = run(s, [{ type: 'damage', id: 'aria', amount: 8 }]);
  assert.deepEqual([s.combatants[0]!.tempHp, s.combatants[0]!.hp], [0, 17]);
  s = run(s, [{ type: 'damage', id: 'aria', amount: 40 }]);
  assert.equal(s.combatants[0]!.hp, 0);
  assert.deepEqual(s.combatants[0]!.conditions, [{ name: 'Unconscious' }]);
  s = run(s, [{ type: 'heal', id: 'aria', amount: 50 }]);
  assert.deepEqual([s.combatants[0]!.hp, s.combatants[0]!.conditions], [20, []], 'healed up to max HP and awake');
  assert.throws(() => run(s, [{ type: 'damage', id: 'aria', amount: -3 }]), /whole number/);
});

test('concentration: damage asks for a save at DC 10 or half the damage; failing it ends the spell', () => {
  let s = run(party(), [{ type: 'concentrate', id: 'aria', spell: 'Bless' }, { type: 'damage', id: 'aria', amount: 6 }]);
  assert.equal(s.combatants[0]!.concentrationCheck, 10);
  s = run(s, [{ type: 'concentrationResult', id: 'aria', kept: true }, { type: 'damage', id: 'aria', amount: 13 }]);
  assert.equal(s.combatants[0]!.concentrationCheck, 10, 'half of 13 rounds down to 6: still DC 10');
  s = run(s, [{ type: 'concentrationResult', id: 'aria', kept: false }]);
  assert.deepEqual([s.combatants[0]!.concentrating, s.combatants[0]!.concentrationCheck], [null, null]);
});

test('removing whoever\'s turn it is passes the turn on; a new arrival joins at the end of the round', () => {
  let s = run(party(), [{ type: 'begin' }, { type: 'next' }]);
  assert.equal(s.turn, 'goblin-1');
  s = run(s, [{ type: 'remove', id: 'goblin-1' }, { type: 'add', combatant: { name: 'Wolf' } }]);
  assert.equal(s.turn, 'brom');
  assert.deepEqual(s.order, ['aria', 'brom', 'goblin-2', 'wolf']);
  assert.throws(() => run(s, [{ type: 'reorder', order: ['aria', 'brom'] }]), /every combatant once/);
});

/** What the wiki's GET /api/encounters/<id> answers (ReesMcD/dnd-wiki, encounters-api.ts). */
const WIKI: WikiEncounter = {
  id: 'ambush-at-long-wade',
  title: 'Ambush at Long Wade',
  campaign: 'Crimson Tide',
  place: 'Long Wade Post',
  difficulty: 'moderate',
  party_level: 3,
  xp: 450,
  status: 'ready',
  run: false,
  updated: '2026-10-22',
  summary: 'Bandits wait at the ford.',
  read_aloud: 'The river runs wide and shallow here.',
  setup: 'Two bandits in the reeds.',
  tactics: 'They want the toll, not a fight.',
  changes: null,
  treasure: '12 gp',
  creatures: [
    { name: 'Bandit', source: 'srd', ac: 12, hp: 11, initiative: 1, abilities: [11, 12, 12, 10, 10, 10], count: 2 },
    { name: 'Bandit Captain', source: 'srd', ac: 15, hp: 52, initiative: 3, abilities: [15, 16, 14, 14, 11, 14], count: 1 },
  ],
  map: {
    v: 1,
    width: 10,
    height: 8,
    terrain: [],
    tokens: [
      { id: 'aria', name: 'Aria', kind: 'pc', at: [0, 0] },
      { id: 'bandit', name: 'Bandit', kind: 'monster', at: [5, 5], hidden: true },
      { id: 'bandit-2', name: 'Bandit', kind: 'monster', at: [6, 5] },
      { id: 'captain', name: 'Bandit Captain', kind: 'monster', at: [8, 5] },
    ],
  },
  party: [{ name: 'Aria', player: 'Rees', level: 3, class: 'Fighter', race: 'Elf', ac: 16, hp: 28, passive_perception: 12 }],
};

test('a wiki encounter becomes a tracker: the party, one per creature, stat blocks, tokens and hidden ambushers', () => {
  const s = encounterFromWiki(WIKI, 'e1', 0);
  assert.deepEqual(
    s.combatants.map((c) => [c.id, c.kind, c.ac, c.hp, c.initiativeBonus, c.tokenId, c.hidden]),
    [
      ['aria', 'pc', 16, 28, 0, 'aria', false],
      ['bandit-1', 'monster', 12, 11, 1, 'bandit', true],
      ['bandit-2', 'monster', 12, 11, 1, 'bandit-2', false],
      ['bandit-captain', 'monster', 15, 52, 3, 'captain', false],
    ],
  );
  assert.equal(s.combatants[0]!.player, 'Rees');
  assert.equal(s.combatants[1]!.dex, 12);
  assert.equal(s.statBlocks['Bandit Captain']!.hp, 52);
  assert.deepEqual(s.source, { wikiId: 'ambush-at-long-wade', campaign: 'Crimson Tide' });
  assert.equal(s.notes!.tactics, 'They want the toll, not a fight.');
});

test('encounters come from the wiki recaps go to; without it, the DM is told what to set', () => {
  const cfg = (upload: object) => configSchema.parse({ upload });
  assert.equal(encountersUrl(cfg({ url: 'https://wiki.example/api/sessions', format: 'ardent-weave' })).href, 'https://wiki.example/api/encounters');
  assert.throws(() => encountersUrl(cfg({ url: 'https://wiki.example/hook', format: 'json' })), /Ardent Weave wiki first/);
});

const TOKEN = 'k'.repeat(24);

/** A fake wiki: answers like encounters-api.ts, or fails like a network outage. */
function fakeWiki() {
  const state = { down: false, seen: [] as string[] };
  const doFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    state.seen.push(`${url.pathname}${url.search} ${(init?.headers as Record<string, string>)?.Authorization ?? ''}`);
    if (state.down) throw new TypeError('fetch failed');
    if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${TOKEN}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (url.pathname === '/api/encounters') return Response.json({ encounters: [{ ...WIKI, creatures: undefined }] });
    if (url.pathname === '/api/encounters/ambush-at-long-wade') return Response.json(WIKI);
    return Response.json({ error: 'No encounter "x".' }, { status: 404 });
  };
  return { state, doFetch };
}
const WIKI_CONFIG = configSchema.parse({ upload: { url: 'https://wiki.example/api/sessions', format: 'ardent-weave' } });

test('the wiki client: the list, one encounter, a refused key, and the last copy when the wiki is down', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'enc-'));
  const { state, doFetch } = fakeWiki();
  const wiki = new WikiEncounters(dataDir, () => WIKI_CONFIG, () => TOKEN, doFetch);
  assert.equal((await wiki.list('Crimson Tide'))[0]!.id, 'ambush-at-long-wade');
  assert.match(state.seen[0]!, /^\/api\/encounters\?campaign=Crimson\+Tide Bearer k+$/);
  assert.equal((await wiki.get('ambush-at-long-wade')).creatures.length, 2);
  await assert.rejects(wiki.get('x'), /No encounter "x"/);
  await assert.rejects(new WikiEncounters(dataDir, () => WIKI_CONFIG, () => 'wrong', doFetch).list(), /refused the key/);
  await assert.rejects(new WikiEncounters(dataDir, () => WIKI_CONFIG, () => undefined, doFetch).list(), /key is missing/);
  state.down = true;
  const offline = await wiki.get('ambush-at-long-wade');
  assert.equal(offline.cached, true, 'loaded before: still there');
  await assert.rejects(wiki.list(), /Couldn't reach the wiki/);
});

test('the store survives a restart, sets a damaged file aside, and keeps ended encounters in history', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'enc-'));
  const logs: string[] = [];
  const store = new EncounterStore(dataDir, deps(), (m) => logs.push(m));
  const events: (EncounterState | null)[] = [];
  store.on('encounter', (s) => events.push(s));
  store.start(party());
  store.act({ type: 'begin' });
  assert.equal(new EncounterStore(dataDir, deps()).current()!.status, 'running', 'restored after a restart');
  assert.throws(() => store.start({ title: 'Another' }), /still running/);
  store.act({ type: 'damage', id: 'goblin-1', amount: 7 });
  const outcome = store.end();
  assert.deepEqual(outcome.defeated, ['Goblin 1']);
  assert.deepEqual(outcome.standing, ['Goblin 2']);
  assert.match(outcome.text, /^Ambush: 1 round\. Defeated: Goblin 1\. Still standing: Goblin 2\.$/);
  assert.equal(store.current(), null);
  assert.equal(events.at(-1), null);
  assert.deepEqual(readdirSync(join(dataDir, 'encounters', 'history')), ['e1.json']);
  assert.equal(store.start({ title: 'Next fight' }).title, 'Next fight');

  writeFileSync(join(dataDir, 'encounters', 'current.json'), '{"id": "e2", "comb');
  const recovered = new EncounterStore(dataDir, deps(), (m) => logs.push(m));
  assert.equal(recovered.current(), null);
  assert.match(logs.at(-1)!, /couldn't be read/);
  assert.ok(readdirSync(join(dataDir, 'encounters')).some((f) => f.startsWith('current.json.damaged-')));
});

test('the API: start from the wiki, run turns, refuse a second encounter, end it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'enc-api-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'config.yaml'), 'upload:\n  url: https://wiki.example/api/sessions\n  format: ardent-weave\n');
  const { doFetch } = fakeWiki();
  const old = process.env.WIKI_UPLOAD_TOKEN;
  process.env.WIKI_UPLOAD_TOKEN = TOKEN;
  try {
    const api = createApi({ password: 'pw', dataDir: join(root, 'data'), configStore: new ConfigStore(join(root, 'config.yaml')), jobs: new JobRunner(async () => {}), httpFetch: doFetch });
    const call = (path: string, body?: unknown) =>
      api.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer pw', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    assert.equal(((await (await call('/encounters/wiki')).json()) as unknown[]).length, 1);
    assert.equal(await (await call('/encounter')).json(), null);
    const started = (await (await call('/encounter', { wikiId: 'ambush-at-long-wade' })).json()) as EncounterState;
    assert.equal(started.combatants.length, 4);
    assert.equal((await call('/encounter', { title: 'Another' })).status, 409);
    await call('/encounter/actions', { type: 'initiative', id: 'aria', value: 14 });
    const rolled = (await (await call('/encounter/actions', { type: 'rollInitiative' })).json()) as EncounterState;
    assert.ok(rolled.combatants.every((c) => c.initiative !== null));
    const begun = (await (await call('/encounter/actions', { type: 'begin' })).json()) as EncounterState;
    assert.equal(begun.status, 'running');
    const bad = await call('/encounter/actions', { type: 'damage', id: 'nobody', amount: 3 });
    assert.deepEqual([bad.status, await bad.json()], [400, { error: 'No such combatant' }]);
    assert.equal((await call('/encounter/actions', 'nonsense')).status, 400);
    const ended = (await (await call('/encounter/end', {})).json()) as { rounds: number };
    assert.equal(ended.rounds, 1);
    assert.equal((await call('/encounter/end', {})).status, 400);
    assert.equal((await call('/encounters/wiki/missing')).status, 404);
    assert.equal((await call('/encounters/wiki', undefined)).status, 200);
    assert.ok(existsSync(join(root, 'data', 'encounters', 'wiki')), 'the loaded encounter is cached');
  } finally {
    if (old === undefined) delete process.env.WIKI_UPLOAD_TOKEN;
    else process.env.WIKI_UPLOAD_TOKEN = old;
  }
});
