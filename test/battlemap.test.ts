import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankMap, canPlace, cellsOf, distanceFeet, doorsAt, footprint, isDifficult, moveToken, nearestFree, placeToken, playersMap, readMap, setDifficult, setDoor, tokenAt, type BattleMap } from '../src/shared/battlemap.js';
import { applyAction, newEncounter, makeCombatant } from '../src/encounter/rules.js';
import { playerAction, playerView } from '../src/play/view.js';
import type { EncounterState } from '../src/shared/types.js';

/** 8×6: a wall along the top with a locked door, a deep well, a barrel, a stage; Ari and an ogre. */
const RAW = {
  v: 1,
  width: 8,
  height: 6,
  ground: 'stone',
  art: { style: 'room', decals: [{ asset: 'blood', at: [4, 4] }, { at: [1, 1] }] },
  terrain: [
    { kind: 'wall', rect: [0, 0, 8, 1] },
    { kind: 'door', cells: [[3, 0]], state: 'locked', label: 'cellar door', asset: 'door' },
    { kind: 'water', rect: [5, 3, 2, 2], depth: 'deep' },
    { kind: 'cover', cells: [[2, 3]], cover: 'half', asset: 'barrel' },
    { kind: 'difficult', rect: [0, 4, 2, 2] },
    { kind: 'lava', cells: [[1, 1]] },
  ],
  tokens: [
    { id: 'ari', name: 'Ari', kind: 'pc', size: 'medium', at: [1, 2] },
    { id: 'ogre', name: 'Ogre', kind: 'monster', size: 'large', at: [6, 1] },
    { id: 'lurker', name: 'Lurker', kind: 'monster', size: 'giant', at: [0, 3], hidden: true },
    { name: 'no id', at: [0, 0] },
  ],
  notes: [{ at: [3, 0], text: 'DC 15 to pick' }],
};
const map = () => readMap(RAW)!;

test('reads the wiki format: unknown kinds and broken tokens are left out, the art layer kept', () => {
  const m = map();
  assert.equal(m.terrain.length, 5, 'lava is not a kind');
  assert.deepEqual(m.tokens.map((t) => [t.id, t.size]), [['ari', 'medium'], ['ogre', 'large'], ['lurker', 'medium']]);
  assert.deepEqual(m.art, { style: 'room', decals: [{ asset: 'blood', at: [4, 4] }] });
  assert.equal(m.ground, 'stone');
  assert.equal(m.terrain[1]!.asset, 'door');
  assert.equal(readMap({ width: 0, height: 5 }), null);
  assert.equal(readMap({ width: 81, height: 5 }), null);
  assert.equal(readMap('nope'), null);
});

test('squares, sizes, distances and difficult ground', () => {
  assert.deepEqual(cellsOf({ kind: 'floor', polygon: [[0, 0], [4, 0], [0, 4]] }, 10, 10).length, 6, 'squares whose centres are inside');
  assert.deepEqual(cellsOf({ kind: 'floor', rect: [6, 4, 4, 4] }, 8, 6), [[6, 4], [7, 4], [6, 5], [7, 5]], 'clipped to the grid');
  assert.deepEqual(footprint([2, 2], 'large'), [[2, 2], [3, 2], [2, 3], [3, 3]]);
  assert.equal(distanceFeet([0, 0], [3, 4]), 20, 'diagonals count 5 ft');
  assert.equal(isDifficult(map(), [1, 5]), true);
  assert.equal(isDifficult(map(), [3, 3]), false);
});

test('a token stands only inside the grid, off walls, closed doors, deep water and other tokens', () => {
  const m = map();
  assert.deepEqual(canPlace(m, 'ari', 'medium', [2, 2]), { ok: true });
  assert.deepEqual(canPlace(m, 'ari', 'medium', [2, 3]), { ok: true }, 'cover does not block');
  assert.equal((canPlace(m, 'ari', 'medium', [3, 0]) as { reason: string }).reason, 'Something is in the way there');
  assert.equal((canPlace(m, 'ari', 'medium', [5, 3]) as { reason: string }).reason, 'Something is in the way there');
  assert.equal((canPlace(m, 'ari', 'medium', [7, 2]) as { reason: string }).reason, 'Someone is already there', 'the ogre fills 6–7, 1–2');
  assert.equal((canPlace(m, 'ogre', 'large', [7, 3]) as { reason: string }).reason, 'That’s off the map');
  assert.equal((canPlace(m, 'ari', 'medium', [1.5, 2] as never) as { reason: string }).reason, 'That’s off the map');
  assert.deepEqual(moveToken(m, 'ari', [2, 2]).tokens[0]!.at, [2, 2]);
  assert.throws(() => moveToken(m, 'ari', [3, 0]), /in the way/);
  assert.throws(() => moveToken(m, 'nobody', [2, 2]), /isn’t on the map/);
  assert.deepEqual(nearestFree(m, 'new', 'medium', [6, 1]), [5, 1], 'next to the ogre');
  assert.equal(tokenAt(m, [7, 2])?.id, 'ogre');
  assert.equal(tokenAt(m, [4, 4]), undefined);
});

test('doors open and shut, never on someone; difficult squares can be marked and cleared', () => {
  let m = map();
  assert.deepEqual(doorsAt(m, [3, 0]), [1]);
  m = setDoor(m, 1, 'open');
  assert.deepEqual(canPlace(m, 'ari', 'medium', [3, 0]), { ok: true }, 'an open door lets you through the wall it sits in');
  m = moveToken(m, 'ari', [3, 0]);
  assert.throws(() => setDoor(m, 1, 'closed'), /in the doorway/);
  assert.throws(() => setDoor(m, 0, 'open'), /isn’t a door/);

  m = setDifficult(m, [4, 2], true);
  assert.equal(isDifficult(m, [4, 2]), true);
  m = setDifficult(m, [0, 4], false);
  assert.equal(isDifficult(m, [0, 4]), false, 'cleared out of the 2×2 area');
  assert.equal(isDifficult(m, [1, 5]), true, 'the rest of the area stays');
  assert.throws(() => setDifficult(m, [9, 9], true), /off the map/);
  assert.throws(() => setDifficult(m, 'x' as never, true), /off the map/);
});

test('players never see hidden tokens or the DM’s notes', () => {
  const p = playersMap(map(), new Set(['ogre']));
  assert.deepEqual(p.tokens.map((t) => t.id), ['ari'], 'the lurker is hidden on the map, the ogre by its combatant');
  assert.deepEqual(p.notes, []);
  assert.equal('background' in p, false);
});

test('placing by hand finds room; a blank map has limits', () => {
  const m = placeToken(map(), { id: 'bob', name: 'Bob', kind: 'pc', size: 'medium' }, [1, 2]);
  assert.deepEqual(m.tokens.at(-1)!.at, [0, 1], 'Ari is there, so the nearest free square');
  assert.deepEqual(blankMap(20, 15), { v: 1, width: 20, height: 15, terrain: [], tokens: [], notes: [] });
  assert.throws(() => blankMap(2, 15), /3 to 80/);
});

const deps = { now: () => 1000, d20: () => 10 };

function fight(): EncounterState {
  const s = newEncounter('e1', 'Cellar', 0);
  s.map = map();
  s.combatants = [
    makeCombatant('ari', { name: 'Ari', kind: 'pc', hp: 20, tokenId: 'ari' }),
    makeCombatant('ogre', { name: 'Ogre', hp: 59, tokenId: 'ogre', hidden: true }),
    makeCombatant('bob', { name: 'Bob', kind: 'pc', hp: 12 }),
  ];
  s.order = ['ari', 'ogre', 'bob'];
  return s;
}

test('the tracker moves tokens, places combatants, works doors and terrain, and shows a revealed token', () => {
  let s = fight();
  s = applyAction(s, { type: 'move', token: 'ari', at: [2, 2] }, deps);
  assert.deepEqual(s.map!.tokens[0]!.at, [2, 2]);
  assert.throws(() => applyAction(s, { type: 'move', token: 'ari', at: [0, 0] }, deps), /in the way/);
  s = applyAction(s, { type: 'place', id: 'bob', at: [2, 2] }, deps);
  assert.equal(s.combatants[2]!.tokenId, 'bob');
  assert.deepEqual(s.map!.tokens.find((t) => t.id === 'bob')!.at, [1, 1], 'next to Ari');
  s = applyAction(s, { type: 'door', index: 1, state: 'open' }, deps);
  s = applyAction(s, { type: 'difficult', at: [4, 2], on: true }, deps);
  assert.equal(isDifficult(s.map!, [4, 2]), true);

  assert.deepEqual(playerView(s, 'ari').map!.tokens.map((t) => t.id), ['ari', 'bob'], 'the ogre is hidden');
  s = applyAction(s, { type: 'reveal', id: 'ogre' }, deps);
  assert.deepEqual(playerView(s, 'ari').map!.tokens.map((t) => t.id), ['ari', 'ogre', 'bob']);
  assert.deepEqual(playerView(s, 'ari').tokens, { ari: 'ari', ogre: 'ogre', bob: 'bob' });

  const blank = newEncounter('e2', 'Tavern', 0);
  assert.throws(() => applyAction(blank, { type: 'move', token: 'x', at: [0, 0] }, deps), /no map/);
  assert.equal(applyAction(blank, { type: 'newMap', width: 20, height: 15 }, deps).map!.width, 20);
  assert.throws(() => applyAction(s, { type: 'newMap', width: 20, height: 15 }, deps), /already has a map/);
});

test('a player moves only their own token', () => {
  const s = fight();
  assert.deepEqual(playerAction(s, 'ari', { type: 'move', at: [2, 2] }), { type: 'move', token: 'ari', at: [2, 2] });
  assert.throws(() => playerAction(s, 'bob', { type: 'move', at: [2, 2] }), /not on the map yet/);
  assert.throws(() => playerAction(s, null, { type: 'move', at: [2, 2] }), /Pick your character/);
});
