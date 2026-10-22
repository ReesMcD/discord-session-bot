import { cellsOf, type BattleMap } from '../shared/battlemap.js';
import type { ArtPlan } from '../shared/types.js';
import type { AssetLibrary } from './assets.js';

const INDOOR_STYLES = new Set(['cave', 'room', 'dungeon', 'tavern', 'house', 'temple']);

/**
 * Which pictures a map gets from the asset folder, most specific first: the file a feature names,
 * then its `asset` words, then (for ground) the map's style. Anything without a match keeps the
 * plain drawing. The rules always come from the terrain, never from the art.
 */
export function artPlan(map: BattleMap, library: AssetLibrary): ArtPlan {
  const style = map.art?.style;
  const styleWords = style ? style.split(/[^a-z]+/i).filter(Boolean) : [];
  const indoor = style ? INDOOR_STYLES.has(style) : false;
  const plan: ArtPlan = { tiles: {}, props: {}, decals: [], ids: [] };
  const used = new Set<string>();
  const remember = (id: string | undefined) => (id ? (used.add(id), id) : undefined);

  const groundWord = map.ground ?? (indoor ? 'stone' : 'grass');
  const ground = remember(library.find({ words: [groundWord], prefer: ['texture', 'tile', 'ground', 'floor', ...styleWords], seed: `ground:${groundWord}` })?.id);
  if (ground) plan.ground = ground;

  map.terrain.forEach((t, i) => {
    if ((t.kind === 'floor' && t.ground) || t.kind === 'water') {
      const word = t.kind === 'water' ? 'water' : t.ground!;
      const tile = remember(library.find({ words: [word], prefer: ['texture', 'tile', ...(t.kind === 'water' && t.depth === 'deep' ? ['deep'] : []), ...styleWords], seed: `tile:${word}` })?.id);
      if (tile) plan.tiles[i] = tile;
      return;
    }
    if (t.kind !== 'object' && t.kind !== 'cover') return;
    const name = t.asset ?? t.label;
    if (!name) return;
    const cells = cellsOf(t, map.width, map.height);
    if (!cells.length) return;
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
    // A row of single trees is many props; one wagon two squares long is one.
    const single = cells.length > 1 && box[2] * box[3] !== cells.length;
    const size: [number, number] = single ? [1, 1] : [box[2], box[3]];
    const found = library.find({ file: name, words: [name], prefer: styleWords, size, seed: `prop:${i}` });
    if (found) plan.props[i] = { id: remember(found.id)!, each: single || (found.w === 1 && found.h === 1 && cells.length > 1) };
  });

  for (const d of map.art?.decals ?? []) {
    const found = library.find({ file: d.asset, words: [d.asset], prefer: styleWords, seed: `decal:${d.at.join(',')}` });
    if (found) plan.decals.push({ id: remember(found.id)!, at: d.at, size: d.size ?? [1, 1], rotate: d.rotate ?? 0 });
  }
  plan.ids = [...used];
  return plan;
}
