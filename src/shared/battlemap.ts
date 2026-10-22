/**
 * The wiki's battle map format (ReesMcD/dnd-wiki docs/battlemap.md, v1) and the maths the tracker
 * and both map views share: which squares a feature covers, what blocks movement, where a token
 * fits, and distances. No Node imports: the web pages use it too.
 *
 * Squares are 5 ft; x runs left to right from 0, y top to bottom from 0.
 */
export type Cell = [number, number];
export type TerrainKind = 'floor' | 'wall' | 'door' | 'difficult' | 'water' | 'cover' | 'elevation' | 'object';
export type TokenSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';

export interface Terrain {
  kind: TerrainKind;
  /** One shape: squares, a rectangle [x, y, w, h], or a polygon of grid corners. */
  cells?: Cell[];
  rect?: [number, number, number, number];
  polygon?: Cell[];
  state?: 'open' | 'closed' | 'locked';
  depth?: 'shallow' | 'deep';
  cover?: 'half' | 'three-quarters';
  height?: number;
  label?: string;
}

export interface MapToken {
  id: string;
  name: string;
  kind: 'pc' | 'monster' | 'npc';
  size: TokenSize;
  /** The top-left square it fills. */
  at: Cell;
  hidden?: boolean;
  ref?: string;
}

export interface BattleMap {
  v: 1;
  width: number;
  height: number;
  background?: { file: string; scale?: number; offset?: Cell };
  terrain: Terrain[];
  tokens: MapToken[];
  notes: Array<{ at: Cell; text: string }>;
}

export const SIZE_SQUARES: Record<TokenSize, number> = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
const KINDS: TerrainKind[] = ['floor', 'wall', 'door', 'difficult', 'water', 'cover', 'elevation', 'object'];
export const MAX_SIDE = 80;

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isCell = (c: unknown): c is Cell => Array.isArray(c) && c.length === 2 && isInt(c[0]) && isInt(c[1]);

/**
 * A map from the wiki, as far as this app understands it: features and tokens it can't read are
 * left out (the wiki already checked the map; a newer version may add fields). Null when it isn't a map.
 */
export function readMap(raw: unknown): BattleMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.width) || !isInt(r.height) || r.width < 1 || r.height < 1 || r.width > MAX_SIDE || r.height > MAX_SIDE) return null;
  const terrain = (Array.isArray(r.terrain) ? r.terrain : []).filter(
    (t): t is Terrain =>
      !!t && typeof t === 'object' && KINDS.includes((t as Terrain).kind) && (Array.isArray((t as Terrain).cells) ? (t as Terrain).cells!.every(isCell) : true) && (!!(t as Terrain).cells || Array.isArray((t as Terrain).rect) || Array.isArray((t as Terrain).polygon)),
  );
  const tokens = (Array.isArray(r.tokens) ? r.tokens : [])
    .filter((t): t is MapToken => !!t && typeof t === 'object' && typeof (t as MapToken).id === 'string' && typeof (t as MapToken).name === 'string' && isCell((t as MapToken).at))
    .map((t) => ({ ...t, size: t.size in SIZE_SQUARES ? t.size : 'medium', kind: t.kind === 'pc' || t.kind === 'npc' ? t.kind : 'monster' }) as MapToken);
  const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n): n is { at: Cell; text: string } => !!n && isCell((n as { at: unknown }).at) && typeof (n as { text: unknown }).text === 'string');
  const bg = r.background as BattleMap['background'] | undefined;
  return { v: 1, width: r.width, height: r.height, ...(bg && typeof bg.file === 'string' ? { background: bg } : {}), terrain, tokens, notes };
}

function insidePolygon(x: number, y: number, poly: Cell[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The squares a feature covers, inside the grid. A polygon covers the squares whose centres it holds. */
export function cellsOf(t: Terrain, width: number, height: number): Cell[] {
  const out: Cell[] = [];
  const add = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) out.push([x, y]);
  };
  if (t.cells) for (const [x, y] of t.cells) add(x, y);
  else if (t.rect) {
    const [x0, y0, w, h] = t.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) add(x, y);
  } else if (t.polygon && t.polygon.length >= 3) {
    const xs = t.polygon.map((p) => p[0]);
    const ys = t.polygon.map((p) => p[1]);
    for (let y = Math.max(0, Math.min(...ys)); y < Math.min(height, Math.max(...ys)); y++)
      for (let x = Math.max(0, Math.min(...xs)); x < Math.min(width, Math.max(...xs)); x++) if (insidePolygon(x + 0.5, y + 0.5, t.polygon)) add(x, y);
  }
  return out;
}

/** Walls, closed or locked doors, deep water and solid objects: nothing stands there. */
export function blocks(t: Terrain): boolean {
  return t.kind === 'wall' || t.kind === 'object' || (t.kind === 'door' && t.state !== 'open') || (t.kind === 'water' && t.depth === 'deep');
}

const key = (x: number, y: number) => `${x},${y}`;

/** The squares a token of this size fills from its top-left square. */
export function footprint(at: Cell, size: TokenSize): Cell[] {
  const n = SIZE_SQUARES[size];
  const out: Cell[] = [];
  for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) out.push([at[0] + dx, at[1] + dy]);
  return out;
}

export type PlaceCheck = { ok: true } | { ok: false; reason: string };

/** Whether a token can stand at `at`: inside the grid, not on anything blocking, not on another token. */
export function canPlace(map: BattleMap, tokenId: string, size: TokenSize, at: Cell): PlaceCheck {
  const n = SIZE_SQUARES[size];
  if (!isCell(at) || at[0] < 0 || at[1] < 0 || at[0] + n > map.width || at[1] + n > map.height) return { ok: false, reason: 'That’s off the map' };
  const blocked = new Set<string>();
  for (const t of map.terrain) if (blocks(t)) for (const [x, y] of cellsOf(t, map.width, map.height)) blocked.add(key(x, y));
  const taken = new Set<string>();
  for (const t of map.tokens) if (t.id !== tokenId) for (const [x, y] of footprint(t.at, t.size)) taken.add(key(x, y));
  for (const [x, y] of footprint(at, size)) {
    if (blocked.has(key(x, y))) return { ok: false, reason: 'Something is in the way there' };
    if (taken.has(key(x, y))) return { ok: false, reason: 'Someone is already there' };
  }
  return { ok: true };
}

/** Distance in feet between two squares, 2024 rules: every square counts 5 ft, diagonals too. */
export function distanceFeet(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) * 5;
}

/** Whether a square is difficult terrain (difficult, shallow water) for the move preview. */
export function isDifficult(map: BattleMap, at: Cell): boolean {
  return map.terrain.some((t) => (t.kind === 'difficult' || (t.kind === 'water' && t.depth !== 'deep')) && cellsOf(t, map.width, map.height).some(([x, y]) => x === at[0] && y === at[1]));
}

/** The map as players may see it: no hidden tokens, no DM notes, no background file name. */
export function playersMap(map: BattleMap, hiddenTokens: ReadonlySet<string>): BattleMap {
  return { v: 1, width: map.width, height: map.height, terrain: map.terrain, tokens: map.tokens.filter((t) => !hiddenTokens.has(t.id)), notes: [] };
}
