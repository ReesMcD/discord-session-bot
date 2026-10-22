import { useEffect, useRef } from 'react';
import { canPlace, cellsOf, distanceFeet, SIZE_SQUARES, tokenAt, type BattleMap, type Cell, type MapToken, type Terrain } from '../../../src/shared/battlemap';
import type { ArtPlan } from '../../../src/shared/types';
import './map.css';

/** What the tracker knows about a token's combatant, for drawing it. */
export interface TokenInfo {
  name: string;
  /** Whose turn it is. */
  current?: boolean;
  /** HP bar: shown only when both are known (the DM sees all; players see the party's). */
  hp?: number | null;
  maxHp?: number | null;
  /** Hidden from players (the DM sees it faded). */
  hidden?: boolean;
  /** This device's own token. */
  mine?: boolean;
}

interface Props {
  map: BattleMap;
  info: Record<string, TokenInfo>;
  canMove: (tokenId: string) => boolean;
  onMove: (tokenId: string, at: Cell) => void;
  /** A tap (not a drag) on a square, with the token there if any. */
  onTap?: (at: Cell, token: MapToken | undefined) => void;
  selected?: string | null;
  /** The DM's notes on the map. */
  showNotes?: boolean;
  label: string;
  /** Pictures from the DM's art folder, and how to fetch one. Without them the map is drawn plainly. */
  art?: ArtPlan | null;
  loadArt?: (id: string) => Promise<Blob>;
}

/** Decoded pictures, shared by every map on the page (ids are stable per file). */
const images = new Map<string, ImageBitmap | 'loading' | 'failed'>();

type View = { scale: number; ox: number; oy: number };
type Drag = { pointer: number; tokenId: string; from: Cell; to: Cell; startX: number; startY: number; moved: boolean };
type Gesture = { kind: 'pan'; pointer: number; startX: number; startY: number; view: View; moved: boolean } | { kind: 'pinch'; distance: number; mid: [number, number]; view: View };

const DRAW_ORDER: Terrain['kind'][] = ['floor', 'elevation', 'water', 'difficult', 'cover', 'object', 'wall', 'door'];
const TAP_SLOP = 6;
/** Squares smaller than this (CSS px) are too fiddly to drag a token onto. */
const MIN_TOUCH_SQUARE = 22;

/**
 * The battle map on a canvas (fast on big maps and old phones). Drag a token you may move: it
 * snaps to squares and shows the distance. Drag the map to pan; pinch or scroll to zoom.
 */
export function BattleMapView(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 32, ox: 0, oy: 0 });
  const fitted = useRef<string>('');
  const drag = useRef<Drag | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, [number, number]>());
  const latest = useRef(props);
  latest.current = props;
  const frame = useRef(0);

  // Fetch the pictures the plan uses; redraw as each arrives.
  const artIds = props.art?.ids.join(',') ?? '';
  useEffect(() => {
    const load = latest.current.loadArt;
    if (!load) return;
    let live = true;
    for (const id of latest.current.art?.ids ?? []) {
      if (images.has(id)) continue;
      images.set(id, 'loading');
      load(id)
        .then((blob) => createImageBitmap(blob))
        .then(
          (bitmap) => images.set(id, bitmap),
          () => images.set(id, 'failed'),
        )
        .then(() => live && redraw());
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artIds]);

  const redraw = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => draw());
  };

  /**
   * Fits the whole map in the box. On a small screen a big map would make squares too small to
   * touch, so it zooms to a usable size instead, centred on my token (or whoever's turn it is).
   */
  const fit = () => {
    const el = wrap.current;
    if (!el) return;
    const { map, info } = latest.current;
    const whole = Math.min(el.clientWidth / map.width, el.clientHeight / map.height);
    // A mouse can hit small squares; a finger can't.
    const smallest = window.matchMedia?.('(pointer: coarse)').matches ? MIN_TOUCH_SQUARE : 10;
    if (whole >= smallest) {
      view.current = { scale: whole, ox: (el.clientWidth - map.width * whole) / 2, oy: (el.clientHeight - map.height * whole) / 2 };
      return;
    }
    const scale = smallest;
    const focus = map.tokens.find((t) => info[t.id]?.mine) ?? map.tokens.find((t) => info[t.id]?.current);
    const [fx, fy] = focus ? [focus.at[0] + SIZE_SQUARES[focus.size] / 2, focus.at[1] + SIZE_SQUARES[focus.size] / 2] : [map.width / 2, map.height / 2];
    view.current = { scale, ox: el.clientWidth / 2 - fx * scale, oy: el.clientHeight / 2 - fy * scale };
  };

  const draw = () => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { map, info, selected, showNotes, art } = latest.current;
    const picture = (id: string | undefined) => {
      const img = id ? images.get(id) : undefined;
      return img && img !== 'loading' && img !== 'failed' ? img : undefined;
    };
    const colors = palette(el);
    const { scale: s, ox, oy } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(ox, oy);

    // Ground, then terrain in the format's order: pictures where the art folder has them.
    ctx.fillStyle = groundColor(map.ground, colors);
    ctx.fillRect(0, 0, map.width * s, map.height * s);
    const groundImage = picture(art?.ground);
    if (groundImage) for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) ctx.drawImage(groundImage, x * s, y * s, s, s);
    for (const kind of DRAW_ORDER) {
      map.terrain.forEach((t, i) => {
        if (t.kind !== kind) return;
        const cells = cellsOf(t, map.width, map.height);
        const tile = picture(art?.tiles[i]);
        const prop = art?.props[i];
        const sprite = picture(prop?.id);
        if (tile) for (const [x, y] of cells) ctx.drawImage(tile, x * s, y * s, s, s);
        else if (sprite && prop) {
          if (prop.each) for (const [x, y] of cells) ctx.drawImage(sprite, x * s, y * s, s, s);
          else {
            const xs = cells.map((c) => c[0]);
            const ys = cells.map((c) => c[1]);
            const x0 = Math.min(...xs);
            const y0 = Math.min(...ys);
            ctx.drawImage(sprite, x0 * s, y0 * s, (Math.max(...xs) - x0 + 1) * s, (Math.max(...ys) - y0 + 1) * s);
          }
        } else for (const [x, y] of cells) paintCell(ctx, t, x, y, s, colors);
        // Difficult ground stays visible over any picture: it's a rule.
        if (kind === 'difficult' && tile) for (const [x, y] of cells) paintCell(ctx, t, x, y, s, colors);
      });
    }
    for (const d of art?.decals ?? []) {
      const img = picture(d.id);
      if (!img) continue;
      const [w, h] = d.size;
      ctx.save();
      ctx.translate((d.at[0] + w / 2) * s, (d.at[1] + h / 2) * s);
      ctx.rotate((d.rotate * Math.PI) / 180);
      ctx.drawImage(img, (-w / 2) * s, (-h / 2) * s, w * s, h * s);
      ctx.restore();
    }

    // Grid.
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= map.width; x++) {
      ctx.moveTo(x * s + 0.5, 0);
      ctx.lineTo(x * s + 0.5, map.height * s);
    }
    for (let y = 0; y <= map.height; y++) {
      ctx.moveTo(0, y * s + 0.5);
      ctx.lineTo(map.width * s, y * s + 0.5);
    }
    ctx.stroke();

    if (showNotes) {
      for (const n of map.notes) {
        ctx.fillStyle = colors.warn;
        ctx.beginPath();
        ctx.arc((n.at[0] + 0.85) * s, (n.at[1] + 0.15) * s, Math.max(3, s * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const d = drag.current;
    for (const t of map.tokens) {
      const ti = info[t.id];
      if (d?.moved && d.tokenId === t.id) {
        paintToken(ctx, t, t.at, s, ti, colors, { faded: true });
        continue;
      }
      paintToken(ctx, t, t.at, s, ti, colors, { selected: selected === t.id });
    }

    // The token being dragged: where it would land, how far, and whether it can.
    if (d?.moved) {
      const t = map.tokens.find((x) => x.id === d.tokenId);
      if (t) {
        const ok = canPlace(map, t.id, t.size, d.to).ok;
        const half = (SIZE_SQUARES[t.size] * s) / 2;
        ctx.strokeStyle = ok ? colors.accent : colors.bad;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(d.from[0] * s + half, d.from[1] * s + half);
        ctx.lineTo(d.to[0] * s + half, d.to[1] * s + half);
        ctx.stroke();
        ctx.setLineDash([]);
        paintToken(ctx, t, d.to, s, info[t.id], colors, { invalid: !ok });
        const label = `${distanceFeet(d.from, d.to)} ft`;
        ctx.font = `600 ${Math.max(11, Math.min(16, s * 0.4))}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width;
        const lx = d.to[0] * s + half - tw / 2 - 6;
        const ly = d.to[1] * s - 26;
        ctx.fillStyle = colors.surface;
        ctx.fillRect(lx, ly, tw + 12, 20);
        ctx.fillStyle = ok ? colors.text : colors.bad;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 6, ly + 10);
      }
    }
  };

  // Redraw on any change; refit when the map's size changes.
  useEffect(() => {
    const key = `${props.map.width}x${props.map.height}`;
    if (fitted.current !== key) {
      fitted.current = key;
      fit();
    }
    redraw();
  });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      fit();
      redraw();
    });
    observer.observe(el);
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener?.('change', redraw);
    return () => {
      observer.disconnect();
      scheme?.removeEventListener?.('change', redraw);
      cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const cellAt = ([px, py]: [number, number]): Cell => {
    const { scale, ox, oy } = view.current;
    return [Math.floor((px - ox) / scale), Math.floor((py - oy) / scale)];
  };
  const zoomAt = (factor: number, [px, py]: [number, number], from = view.current) => {
    const scale = Math.max(8, Math.min(120, from.scale * factor));
    const k = scale / from.scale;
    view.current = { scale, ox: px - (px - from.ox) * k, oy: py - (py - from.oy) * k };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    canvas.current!.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      // Second finger: pinch (and abandon any drag).
      drag.current = null;
      const [a, b] = [...pointers.current.values()] as [[number, number], [number, number]];
      gesture.current = { kind: 'pinch', distance: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], view: { ...view.current } };
      redraw();
      return;
    }
    const { map, canMove } = latest.current;
    const cell = cellAt(p);
    const t = tokenAt(map, cell);
    if (t && canMove(t.id)) drag.current = { pointer: e.pointerId, tokenId: t.id, from: t.at, to: t.at, startX: p[0], startY: p[1], moved: false };
    else gesture.current = { kind: 'pan', pointer: e.pointerId, startX: p[0], startY: p[1], view: { ...view.current }, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g?.kind === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [[number, number], [number, number]];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      zoomAt(Math.hypot(a[0] - b[0], a[1] - b[1]) / g.distance, g.mid, g.view);
      view.current = { ...view.current, ox: view.current.ox + mid[0] - g.mid[0], oy: view.current.oy + mid[1] - g.mid[1] };
      redraw();
      return;
    }
    const d = drag.current;
    if (d && d.pointer === e.pointerId) {
      if (!d.moved && Math.hypot(p[0] - d.startX, p[1] - d.startY) < TAP_SLOP) return;
      d.moved = true;
      const t = latest.current.map.tokens.find((x) => x.id === d.tokenId);
      const n = t ? SIZE_SQUARES[t.size] : 1;
      // Snap by the token's centre, so big tokens land where they're held.
      const { scale, ox, oy } = view.current;
      d.to = [Math.round((p[0] - ox) / scale - n / 2), Math.round((p[1] - oy) / scale - n / 2)];
      redraw();
      return;
    }
    if (g?.kind === 'pan' && g.pointer === e.pointerId) {
      if (!g.moved && Math.hypot(p[0] - g.startX, p[1] - g.startY) < TAP_SLOP) return;
      g.moved = true;
      view.current = { ...g.view, ox: g.view.ox + p[0] - g.startX, oy: g.view.oy + p[1] - g.startY };
      redraw();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    const g = gesture.current;
    if (d && d.pointer === e.pointerId) {
      drag.current = null;
      if (d.moved) {
        if (d.to[0] !== d.from[0] || d.to[1] !== d.from[1]) latest.current.onMove(d.tokenId, d.to);
      } else if (p) tap(p);
      redraw();
      return;
    }
    if (g?.kind === 'pinch') {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (g?.kind === 'pan' && g.pointer === e.pointerId) {
      gesture.current = null;
      if (!g.moved && p) tap(p);
    }
  };

  const tap = (p: [number, number]) => {
    const { map, onTap } = latest.current;
    const cell = cellAt(p);
    if (cell[0] < 0 || cell[1] < 0 || cell[0] >= map.width || cell[1] >= map.height) return;
    onTap?.(cell, tokenAt(map, cell));
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    zoomAt(Math.exp(-e.deltaY * 0.0015), local(e));
    redraw();
  };

  return (
    <div className="battle-map" ref={wrap}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={props.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
      <div className="battle-map-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => (zoomAt(1.25, centre(wrap.current)), redraw())}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => (zoomAt(0.8, centre(wrap.current)), redraw())}>
          −
        </button>
        <button type="button" aria-label="Fit the map" onClick={() => (fit(), redraw())}>
          ⤢
        </button>
      </div>
    </div>
  );
}

const centre = (el: HTMLElement | null): [number, number] => [(el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2];

type Palette = Record<'surface' | 'text' | 'muted' | 'accent' | 'good' | 'warn' | 'bad' | 'grid' | 'ground', string>;

/** The app's colours (light or dark), read from its CSS custom properties. */
function palette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--surface', '#131722'),
    text: v('--text', '#e7e9f0'),
    muted: v('--muted', '#8d93a8'),
    accent: v('--accent', '#7fe7d4'),
    good: v('--good', '#6ee7a8'),
    warn: v('--warn', '#f5b85a'),
    bad: v('--bad', '#ff7a85'),
    grid: v('--map-grid', 'rgba(127,127,127,0.25)'),
    ground: v('--map-ground', '#1b2130'),
  };
}

const GROUND: Record<string, string> = {
  grass: '#55743f',
  dirt: '#7a5c3c',
  road: '#8a7354',
  stone: '#6b6f78',
  wood: '#86623d',
  sand: '#c2a76b',
  snow: '#d8dee6',
  cave: '#4a4740',
  mud: '#5d4a35',
  water: '#3f6f9a',
};

function groundColor(ground: string | undefined, p: Palette): string {
  return (ground && GROUND[ground]) ?? p.ground;
}

function paintCell(ctx: CanvasRenderingContext2D, t: Terrain, x: number, y: number, s: number, p: Palette) {
  const px = x * s;
  const py = y * s;
  switch (t.kind) {
    case 'floor':
      ctx.fillStyle = (t.ground && GROUND[t.ground]) ?? 'rgba(160,140,110,0.55)';
      ctx.fillRect(px, py, s, s);
      break;
    case 'elevation':
      ctx.fillStyle = 'rgba(170,150,220,0.35)';
      ctx.fillRect(px, py, s, s);
      break;
    case 'water':
      ctx.fillStyle = t.depth === 'deep' ? 'rgba(40,90,170,0.85)' : 'rgba(80,140,210,0.6)';
      ctx.fillRect(px, py, s, s);
      break;
    case 'difficult':
      // Hatched, so it reads as "slow" over any ground.
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, s, s);
      ctx.clip();
      ctx.strokeStyle = 'rgba(245,184,90,0.7)';
      ctx.lineWidth = Math.max(1, s * 0.06);
      for (let i = -s; i < s; i += Math.max(4, s / 4)) {
        ctx.beginPath();
        ctx.moveTo(px + i, py + s);
        ctx.lineTo(px + i + s, py);
        ctx.stroke();
      }
      ctx.restore();
      break;
    case 'cover':
      ctx.fillStyle = 'rgba(140,140,150,0.75)';
      ctx.fillRect(px + s * 0.18, py + s * 0.18, s * 0.64, s * 0.64);
      break;
    case 'object':
      ctx.fillStyle = t.asset === 'tree' || t.asset === 'bush' || t.asset === 'reeds' ? 'rgba(40,90,45,0.95)' : 'rgba(70,70,78,0.95)';
      ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
      break;
    case 'wall':
      ctx.fillStyle = p.text;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px, py, s, s);
      ctx.globalAlpha = 1;
      break;
    case 'door': {
      ctx.fillStyle = groundColor(undefined, p);
      ctx.fillRect(px, py, s, s);
      ctx.fillStyle = '#a0703c';
      if (t.state === 'open') {
        ctx.fillRect(px, py, s * 0.18, s);
      } else {
        ctx.fillRect(px + 1, py + s * 0.3, s - 2, s * 0.4);
        if (t.state === 'locked') {
          ctx.fillStyle = p.warn;
          ctx.fillRect(px + s * 0.42, py + s * 0.4, s * 0.16, s * 0.2);
        }
      }
      break;
    }
  }
}

function paintToken(ctx: CanvasRenderingContext2D, t: MapToken, at: Cell, s: number, info: TokenInfo | undefined, p: Palette, o: { faded?: boolean; selected?: boolean; invalid?: boolean }) {
  const n = SIZE_SQUARES[t.size];
  const r = (n * s) / 2;
  const cx = at[0] * s + r;
  const cy = at[1] * s + r;
  const fill = t.kind === 'pc' ? p.accent : t.kind === 'npc' ? p.warn : p.bad;
  ctx.save();
  ctx.globalAlpha = o.faded || info?.hidden ? 0.4 : 1;
  if (info?.current) {
    ctx.strokeStyle = p.text;
    ctx.lineWidth = Math.max(2, s * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = o.invalid ? p.bad : fill;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(4, r - Math.max(3, s * 0.12)), 0, Math.PI * 2);
  ctx.fill();
  if (info?.hidden) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = p.text;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.selected || info?.mine) {
    ctx.strokeStyle = o.selected ? p.text : p.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Initials.
  if (s * n >= 18) {
    ctx.fillStyle = '#0b0d12';
    ctx.font = `700 ${Math.max(9, Math.min(22, r * 0.75))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(info?.name ?? t.name), cx, cy + 0.5);
  }
  // HP bar.
  if (info?.hp != null && info.maxHp) {
    const frac = Math.max(0, Math.min(1, info.hp / info.maxHp));
    const bw = n * s * 0.8;
    const bx = cx - bw / 2;
    const by = at[1] * s + n * s - Math.max(4, s * 0.12);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, Math.max(3, s * 0.09));
    ctx.fillStyle = frac === 0 ? p.muted : frac <= 0.25 ? p.bad : frac <= 0.5 ? p.warn : p.good;
    ctx.fillRect(bx, by, bw * frac, Math.max(3, s * 0.09));
  }
  ctx.restore();
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const last = words.at(-1) ?? '';
  // "Goblin 2" → "G2"; "Ari" → "AR".
  if (words.length > 1 && /^\d+$/.test(last)) return `${words[0]![0]!.toUpperCase()}${last}`;
  return words.length > 1 ? `${words[0]![0]}${words[1]![0]}`.toUpperCase() : name.slice(0, 2).toUpperCase();
}

