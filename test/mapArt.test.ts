import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { artPlan } from '../src/battlemap/artPlan.js';
import { AssetLibrary, entryFor, nameWords } from '../src/battlemap/assets.js';
import { MapArt } from '../src/battlemap/library.js';
import { readMap } from '../src/shared/battlemap.js';
import { EncounterStore } from '../src/encounter/store.js';
import { newEncounter } from '../src/encounter/rules.js';
import { playerApp } from '../src/play/playerServer.js';

/** A fake art folder: empty files with Forgotten Adventures-style names (no real art in the repo). */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-'));
  for (const f of [
    'Textures/Grass/Grass_Texture_A1.png',
    'Textures/Grass/Grass_Texture_B1.png',
    'Textures/Road/Dirt_Road_Texture_A1.jpg',
    'Textures/Water/Water_Deep_Texture_A1.png',
    'Props/Trees/Tree_Oak_A1_2x2.png',
    'Props/Trees/Tree_Oak_B1_2x2.png',
    'Props/Trees/Tree_Pine_A1_1x1.png',
    'Props/Trees/Tree_Dead_Burnt_A1_1x1.png',
    'Props/Vehicles/Cart_Wooden_A1_2x1.png',
    'Props/Decals/Blood_Splatter_A1.png',
    'Props/Forest/Bush_Forest_A1.webp',
    'Notes.txt',
    '.hidden/Tree_Secret.png',
  ]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

test('names become words and footprints', () => {
  assert.deepEqual(nameWords('Cart_Wooden_A1_2x1'), ['cart', 'wooden']);
  assert.deepEqual(nameWords('BigTrees-Bushes 02'), ['big', 'tree', 'bush']);
  const e = entryFor('Props/Vehicles/Cart_Wooden_A1_2x1.png');
  assert.deepEqual([e.words, e.w, e.h, e.name], [['cart', 'wooden', 'prop', 'vehicle'], 2, 1, 'cart_wooden_a1_2x1']);
  assert.equal(e.id.length, 16);
});

test('the folder index: images only, no hidden folders; the best match, varied among equals', () => {
  const lib = AssetLibrary.load(folder());
  assert.equal(lib.entries.length, 11);
  assert.equal(lib.find({ words: ['cart'], seed: 'x' })?.name, 'cart_wooden_a1_2x1');
  assert.equal(lib.find({ file: 'Tree_Pine_A1_1x1', words: ['tree'], seed: 'x' })?.name, 'tree_pine_a1_1x1', 'an exact file name wins');
  assert.equal(lib.find({ words: ['dragon'], seed: 'x' }), undefined, 'a missing asset is just no picture');
  assert.equal(lib.find({ words: ['tree'], size: [1, 1], seed: 'x' })?.name, 'tree_pine_a1_1x1', 'the footprint that fits, the plainest name');
  const oaks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((seed) => lib.find({ words: ['tree'], size: [2, 2], seed })?.name));
  assert.deepEqual([...oaks].sort(), ['tree_oak_a1_2x2', 'tree_oak_b1_2x2'], 'equally good oaks vary by seed');
  assert.equal(lib.find({ words: ['bush'], seed: 'x' })?.name, 'bush_forest_a1');
  assert.equal(lib.path('nope'), undefined);
});

test('a map’s plan: ground and floors from textures, props sized to their squares, decals; plain where nothing fits', () => {
  const lib = AssetLibrary.load(folder());
  const map = readMap({
    v: 1,
    width: 10,
    height: 8,
    art: { style: 'forest-road', decals: [{ asset: 'blood', at: [2, 2] }, { asset: 'scorch', at: [3, 3] }] },
    terrain: [
      { kind: 'floor', rect: [0, 3, 10, 2], ground: 'road' },
      { kind: 'water', rect: [0, 6, 3, 2], depth: 'deep' },
      { kind: 'object', cells: [[1, 1], [5, 1]], asset: 'tree' },
      { kind: 'object', rect: [6, 6, 2, 2], asset: 'tree' },
      { kind: 'cover', rect: [4, 3, 2, 1], asset: 'cart' },
      { kind: 'object', cells: [[8, 1]], asset: 'statue' },
      { kind: 'wall', rect: [9, 0, 1, 3] },
    ],
    tokens: [],
  })!;
  const plan = artPlan(map, lib);
  const name = (id: string | undefined) => (id ? lib.get(id)?.name : undefined);
  assert.match(name(plan.ground)!, /^grass_texture_/);
  assert.equal(name(plan.tiles[0]), 'dirt_road_texture_a1');
  assert.equal(name(plan.tiles[1]), 'water_deep_texture_a1');
  assert.equal(name(plan.props[2]?.id), 'tree_pine_a1_1x1');
  assert.equal(plan.props[2]?.each, true, 'two separate trees: a picture each');
  assert.match(name(plan.props[3]?.id)!, /^tree_oak_/, 'a 2×2 tree');
  assert.deepEqual([name(plan.props[4]?.id), plan.props[4]?.each], ['cart_wooden_a1_2x1', false]);
  assert.equal(plan.props[5], undefined, 'no statue art: drawn plainly');
  assert.deepEqual(plan.decals.map((d) => [name(d.id), d.at]), [['blood_splatter_a1', [2, 2]]]);
  assert.equal(new Set(plan.ids).size, plan.ids.length);
});

test('players fetch only the pictures their map uses; no folder, no art', async () => {
  const dir = folder();
  const data = mkdtempSync(join(tmpdir(), 'art-data-'));
  const store = new EncounterStore(data);
  const s = newEncounter('e1', 'Road', 0);
  s.map = readMap({ v: 1, width: 5, height: 5, terrain: [{ kind: 'cover', cells: [[1, 1]], asset: 'cart' }], tokens: [] });
  store.start(s);
  const code = store.newJoinLink().join!.code;
  const art = new MapArt(() => dir);
  const app = playerApp(store, { webDist: data, art });
  const plan = (await (await app.request(`/p/${code}/art`)).json()) as { ids: string[] };
  assert.equal(plan.ids.length, 2, 'the grass ground and the cart');
  const cart = plan.ids.find((id) => art.file(id)?.path.endsWith('Cart_Wooden_A1_2x1.png'))!;
  const res = await app.request(`/p/${code}/art/${cart}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  await res.arrayBuffer();
  const lib = AssetLibrary.load(dir);
  const notUsed = lib.entries.find((e) => e.name.startsWith('blood'))!.id;
  assert.equal((await app.request(`/p/${code}/art/${notUsed}`)).status, 404, 'not on this map');
  assert.equal((await app.request(`/p/wrong-code/art/${cart}`)).status === 200, false);

  assert.equal(new MapArt(() => undefined).plan(s.map), null);
  assert.match(new MapArt(() => join(dir, 'nope')).status().error!, /Couldn't read/);
});
