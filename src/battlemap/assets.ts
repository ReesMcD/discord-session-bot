import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

/**
 * A folder of map art on this Mac (Forgotten Adventures packs, or anything named the same way),
 * indexed by the words in its file and folder names: "Props/Cart_Wooden_A1_2x1.png" is a
 * wooden cart, two squares by one. The files are never copied: they stay in the folder and are
 * served to our own game's browsers only (#61).
 */
export interface AssetEntry {
  /** Short and stable: what browsers ask for, so paths never leave the Mac. */
  id: string;
  /** Relative to the folder. */
  file: string;
  /** The file name without its extension, lowercased. */
  name: string;
  /** Words from the file and folder names, lowercased and singular. */
  words: string[];
  /** Footprint in squares, from "_2x1" in the name; 1×1 otherwise. */
  w: number;
  h: number;
}

const IMAGE = new Set(['.png', '.webp', '.jpg', '.jpeg']);
/** Stops a mis-set folder (the whole disk) from taking forever. */
const MAX_FILES = 200_000;

/** "Trees" → "tree", "Bushes" → "bush": close enough to match a map's asset names. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('es') && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Words in a name: split on _ - . spaces and camelCase; variant codes (A1, B, 02) and footprints dropped. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 2 && /[a-z]/i.test(w) && !/^[a-z]\d+$/i.test(w) && !/^\d+x\d+$/i.test(w))
    .map(stem);
}

/** One file's entry: its words (file name first, then folders) and footprint. */
export function entryFor(file: string): AssetEntry {
  const parts = file.split(/[\\/]/);
  const base = parts.at(-1)!.replace(/\.[^.]+$/, '');
  const size = /(?:^|[^0-9])(\d{1,2})x(\d{1,2})(?:[^0-9]|$)/i.exec(base);
  const words = [...new Set([...nameWords(base), ...parts.slice(0, -1).flatMap(nameWords)])];
  return {
    id: createHash('sha256').update(file).digest('hex').slice(0, 16),
    file,
    name: base.toLowerCase(),
    words,
    w: size ? Math.max(1, Number(size[1])) : 1,
    h: size ? Math.max(1, Number(size[2])) : 1,
  };
}

/** Walks the folder for images. Throws if it can't be read. */
export function indexFolder(dir: string): AssetEntry[] {
  const root = resolve(dir);
  const out: AssetEntry[] = [];
  const walk = (folder: string) => {
    for (const d of readdirSync(folder, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (d.name.startsWith('.')) continue;
      const full = join(folder, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.isFile() && IMAGE.has(extname(d.name).toLowerCase())) out.push(entryFor(relative(root, full).split(sep).join('/')));
    }
  };
  walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export interface AssetQuery {
  /** An exact file name (without extension), when the map names one. */
  file?: string;
  /** Every one of these must be in the name. */
  words: string[];
  /** Nice to have: the map's style, "texture" for ground. */
  prefer?: string[];
  /** Footprint wanted, in squares. */
  size?: [number, number];
  /** Picks among equally good matches, so twelve trees aren't all the same tree. */
  seed: string;
}

/** The library as the resolver and the image routes use it. */
export class AssetLibrary {
  private readonly byId = new Map<string, AssetEntry>();
  private readonly byWord = new Map<string, AssetEntry[]>();

  constructor(
    readonly dir: string,
    readonly entries: AssetEntry[],
    readonly indexedAt = Date.now(),
  ) {
    for (const e of entries) {
      this.byId.set(e.id, e);
      for (const w of e.words) this.byWord.set(w, [...(this.byWord.get(w) ?? []), e]);
    }
  }

  static load(dir: string): AssetLibrary {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder`);
    return new AssetLibrary(resolve(dir), indexFolder(dir));
  }

  get(id: string): AssetEntry | undefined {
    return this.byId.get(id);
  }

  /** The image's full path, only for files in the index (never anything else in or outside the folder). */
  path(id: string): string | undefined {
    const e = this.byId.get(id);
    return e ? join(this.dir, ...e.file.split('/')) : undefined;
  }

  /** The best match, or undefined: a missing picture is never an error (the plain drawing stays). */
  find(q: AssetQuery): AssetEntry | undefined {
    if (q.file) {
      const name = q.file.toLowerCase().replace(/\.[a-z]+$/, '');
      const exact = this.entries.find((e) => e.name === name || e.file.toLowerCase() === q.file!.toLowerCase());
      if (exact) return exact;
    }
    const words = q.words.flatMap(nameWords);
    if (!words.length) return undefined;
    const pool = this.byWord.get(words[0]!) ?? [];
    const matches = pool.filter((e) => words.every((w) => e.words.includes(w)));
    if (!matches.length) return undefined;
    const prefer = (q.prefer ?? []).flatMap(nameWords);
    const score = (e: AssetEntry) =>
      prefer.filter((w) => e.words.includes(w)).length * 10 +
      (q.size && e.w === q.size[0] && e.h === q.size[1] ? 5 : q.size && e.w * e.h <= q.size[0] * q.size[1] ? 1 : 0) -
      // Fewer extra words: a plain "Tree" beats "Tree Dead Burnt".
      (e.words.length - words.length) * 0.1;
    let best = -Infinity;
    let top: AssetEntry[] = [];
    for (const e of matches) {
      const s = score(e);
      if (s > best + 1e-9) {
        best = s;
        top = [e];
      } else if (Math.abs(s - best) <= 1e-9) top.push(e);
    }
    return top[hashIndex(q.seed, top.length)];
  }
}

function hashIndex(seed: string, n: number): number {
  return parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % n;
}
