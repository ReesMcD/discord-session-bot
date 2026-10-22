import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { applyAction, newEncounter, type RuleDeps } from '../src/encounter/rules.js';
import { EncounterStore } from '../src/encounter/store.js';
import { playerApp, RateLimiter } from '../src/play/playerServer.js';
import { healthOf, playerAction, playerView } from '../src/play/view.js';
import type { EncounterAction, EncounterState, JoinLink, PlayerView } from '../src/shared/types.js';

function deps(): RuleDeps {
  let t = Date.UTC(2026, 9, 22, 20);
  return { now: () => (t += 1000), d20: () => 10 };
}

/** Aria and Brom (PCs), a goblin, and a hidden ogre; DM notes and a stat block the players must never see. */
function fight(): EncounterState {
  let s = newEncounter('e1', 'Ambush', 0);
  const steps: EncounterAction[] = [
    { type: 'add', combatant: { name: 'Aria', kind: 'pc', ac: 16, hp: 20 } },
    { type: 'add', combatant: { name: 'Brom', kind: 'pc', ac: 18, hp: 30 } },
    { type: 'add', combatant: { name: 'Goblin', ac: 15, hp: 10, ref: 'Goblin' } },
    { type: 'add', combatant: { name: 'Ogre', ac: 11, hp: 59, hidden: true } },
    { type: 'initiative', id: 'aria', value: 15 },
    { type: 'initiative', id: 'brom', value: 3 },
    { type: 'initiative', id: 'goblin', value: 12 },
    { type: 'initiative', id: 'ogre', value: 20 },
  ];
  for (const a of steps) s = applyAction(s, a, deps());
  return { ...s, notes: { summary: 'SECRET-SUMMARY', read_aloud: null, setup: 'SECRET-SETUP', tactics: 'SECRET-TACTICS', changes: null, treasure: 'SECRET-TREASURE' }, statBlocks: { Goblin: { name: 'Goblin', source: 'srd', ac: 15, hp: 10 } } };
}

test('what players see: no hidden combatants, no monster numbers, no DM notes', () => {
  let s = applyAction(fight(), { type: 'begin' }, deps());
  assert.equal(s.turn, 'ogre', 'the hidden ogre goes first');
  s = applyAction(s, { type: 'damage', id: 'goblin', amount: 6 }, deps());
  const v = playerView(s, 'aria');
  assert.deepEqual(v.order.map((c) => c.id), ['aria', 'goblin', 'brom']);
  assert.equal(v.turn, null, 'a hidden combatant\'s turn shows as nobody');
  const goblin = v.order.find((c) => c.id === 'goblin')!;
  assert.deepEqual([goblin.hp, goblin.maxHp, goblin.health], [null, null, 'bloodied']);
  assert.deepEqual([v.order[0]!.hp, v.order[0]!.maxHp, v.myAc], [20, 20, 16]);
  const json = JSON.stringify(v);
  for (const secret of ['SECRET', 'Ogre', 'ogre', 'statBlocks', 'tokenHash', '"ac"', 'initiative":1']) assert.ok(!json.includes(secret), `leaks ${secret}`);
  assert.equal(healthOf({ ...s.combatants[2]!, hp: 0 }), 'down');
  // Revealed: now it shows, its turn too.
  const revealed = applyAction(s, { type: 'reveal', id: 'ogre' }, deps());
  assert.equal(playerView(revealed, 'aria').turn, 'ogre');
});

test('players change only their own PC; initiative only while the DM collects it', () => {
  const s = fight();
  assert.deepEqual(playerAction(s, 'aria', { type: 'damage', amount: 4 }), { type: 'damage', id: 'aria', amount: 4 });
  assert.throws(() => playerAction(s, null, { type: 'heal', amount: 1 }), /Pick your character/);
  assert.throws(() => playerAction(s, 'goblin', { type: 'heal', amount: 1 }), /Pick your character/, 'a monster is never "yours"');
  assert.throws(() => playerAction(s, 'aria', { type: 'condition', name: 'Sleepy' as never }), /Unknown condition/);
  assert.throws(() => playerAction(s, 'aria', { type: 'concentrate' } as never), /Unknown request/);
  const running = applyAction(s, { type: 'begin' }, deps());
  assert.throws(() => playerAction(running, 'aria', { type: 'initiative', value: 20 }), /ask the DM/);
});

/** A store with the fight running, and the player server in front of it. */
function server(limiter?: RateLimiter) {
  const dataDir = mkdtempSync(join(tmpdir(), 'play-'));
  const web = join(dataDir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>DM app</title>');
  writeFileSync(join(web, 'assets', 'play-x.js'), 'console.log(1)');
  const store = new EncounterStore(dataDir, deps(), () => {});
  const code = store.start(fight()).join!.code;
  const app = playerApp(store, { webDist: web, ...(limiter ? { limiter } : {}) });
  const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    });
  return { store, code, call, dataDir };
}

test('the player server serves the player page and its API, and nothing of the DM app', async () => {
  const { code, call } = server();
  for (const path of ['/api/health', '/api/encounter', '/api/config', '/api/events', '/encounter', '/index.html', '/', '/sessions', '/api/encounter/actions']) {
    assert.equal((await call(path)).status, 404, path);
  }
  assert.equal((await call('/api/encounter/actions', { body: { type: 'next' } })).status, 404);
  const page = await call(`/play/${code}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>play<\/title>/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer', 'the code in the URL never leaks as a referrer');
  assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'no CORS');
  const asset = await call('/assets/play-x.js');
  assert.deepEqual([asset.status, await asset.text()], [200, 'console.log(1)']);
  assert.equal((await call('/health')).status, 200);
});

test('joining: one device per PC, guests welcome, and only your own PC changes', async () => {
  const { store, code, call } = server();
  assert.equal((await call('/p/wrong-code/view')).status, 410);
  const guestView = (await (await call(`/p/${code}/view`)).json()) as PlayerView;
  assert.deepEqual(guestView.party, [{ id: 'aria', name: 'Aria', taken: false }, { id: 'brom', name: 'Brom', taken: false }]);

  const aria = (await (await call(`/p/${code}/join`, { body: { combatantId: 'aria' } })).json()) as { token: string; view: PlayerView };
  assert.equal(aria.view.me, 'aria');
  assert.match(aria.token, /^[\w-]{22}$/);
  assert.equal((await call(`/p/${code}/join`, { body: { combatantId: 'aria' } })).status, 409, 'Aria is taken');
  assert.equal((await call(`/p/${code}/join`, { body: { combatantId: 'goblin' } })).status, 409, 'not a PC');
  const guest = (await (await call(`/p/${code}/join`, { body: { combatantId: null } })).json()) as { token: string };
  assert.ok(!JSON.stringify(store.current()).includes(aria.token), 'only a hash of the token is kept');

  const after = (await (await call(`/p/${code}/act`, { token: aria.token, body: { type: 'damage', amount: 5 } })).json()) as PlayerView;
  assert.equal(after.order.find((c) => c.id === 'aria')!.hp, 15);
  assert.equal(store.current()!.combatants.find((c) => c.id === 'aria')!.hp, 15, 'the DM sees it');
  const guestTry = await call(`/p/${code}/act`, { token: guest.token, body: { type: 'heal', amount: 5 } });
  assert.deepEqual([guestTry.status, await guestTry.json()], [400, { error: 'Pick your character first' }]);
  assert.equal((await call(`/p/${code}/act`, { body: { type: 'heal', amount: 5 } })).status, 401, 'no token');
  assert.equal((await call(`/p/${code}/act`, { token: 'x'.repeat(22), body: { type: 'heal', amount: 5 } })).status, 401, 'a made-up token');
  assert.equal((await call(`/p/${code}/view`, { token: 'x'.repeat(22) })).status, 401, 'a stale token: join again');
  assert.equal((await call(`/p/${code}/act`, { token: aria.token, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await call(`/p/${code}/act`, { token: aria.token, body: 'not json' })).status, 400);
});

test('a new link or the end of the encounter closes the old link', async () => {
  const { store, code, call } = server();
  const { token } = (await (await call(`/p/${code}/join`, { body: { combatantId: 'brom' } })).json()) as { token: string };
  const next = store.newJoinLink().join!.code;
  assert.notEqual(next, code);
  assert.equal((await call(`/p/${code}/view`, { token })).status, 410);
  assert.equal((await call(`/p/${code}/act`, { token, body: { type: 'heal', amount: 1 } })).status, 410);
  assert.equal((await call(`/p/${next}/view`, { token })).status, 401, 'everyone joins again');
  store.end();
  assert.equal((await call(`/p/${next}/view`)).status, 410);
  assert.equal((await call(`/p/${next}/join`, { body: { combatantId: 'brom' } })).status, 410);
});

test('live updates stream each change and say when it ends', async () => {
  const { store, code, call } = server();
  const { token } = (await (await call(`/p/${code}/join`, { body: { combatantId: 'aria' } })).json()) as { token: string };
  const res = await call(`/p/${code}/events`, { token });
  assert.equal(res.status, 200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const until = async (re: RegExp) => {
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed before ${re}: ${text}`);
      text += value;
    }
  };
  await until(/event: view/);
  store.act({ type: 'damage', id: 'aria', amount: 3 });
  await until(/"hp":17/);
  store.end();
  await until(/event: ended/);
  await reader.cancel();
});

test('too many requests from one client are refused for a minute', async () => {
  let now = 0;
  const { code, call } = server(new RateLimiter(3, 1000, () => now));
  for (let i = 0; i < 3; i++) assert.equal((await call(`/p/${code}/view`)).status, 200);
  const limited = await call(`/p/${code}/view`);
  assert.deepEqual([limited.status, limited.headers.get('retry-after')], [429, '60']);
  now += 61_000;
  assert.equal((await call(`/p/${code}/view`)).status, 200);
});

test('the DM gets the join link (public when set) and can check the public address', async () => {
  const root = mkdtempSync(join(tmpdir(), 'play-api-'));
  writeFileSync(join(root, 'config.yaml'), 'players:\n  public_url: https://mac.tail1234.ts.net\n  port: 4455\n');
  const seen: string[] = [];
  const httpFetch: typeof fetch = async (input) => {
    seen.push(String(input));
    return String(input).startsWith('https://mac.tail1234.ts.net/') ? Response.json({ ok: true }) : Response.json({}, { status: 502 });
  };
  const store = new EncounterStore(join(root, 'data'), deps(), () => {});
  const api = createApi({ password: 'pw', dataDir: join(root, 'data'), configStore: new ConfigStore(join(root, 'config.yaml')), jobs: new JobRunner(async () => {}), encounters: store, httpFetch });
  const call = (path: string, body?: unknown) => api.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer pw', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  assert.deepEqual(await (await call('/encounter/link')).json(), { url: null, local: null, publicUrlSet: true });
  const code = store.start({ title: 'Brawl' }).join!.code;
  const link = (await (await call('/encounter/link')).json()) as JoinLink;
  assert.deepEqual(link, { url: `https://mac.tail1234.ts.net/play/${code}`, local: `http://localhost:4455/play/${code}`, publicUrlSet: true });
  const fresh = (await (await call('/encounter/link', {})).json()) as JoinLink;
  assert.notEqual(fresh.url, link.url);

  assert.deepEqual(await (await call('/players/check', { public_url: 'https://mac.tail1234.ts.net' })).json(), { ok: true, message: 'Players can reach it' });
  assert.equal(seen[0], 'https://mac.tail1234.ts.net/health');
  assert.match(((await (await call('/players/check', { public_url: 'https://elsewhere.example' })).json()) as { message: string }).message, /not as the players' page/);
  assert.match(((await (await call('/players/check', { public_url: 'http://insecure.example' })).json()) as { message: string }).message, /https/);
});
