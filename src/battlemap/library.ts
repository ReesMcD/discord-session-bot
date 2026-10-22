import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { BattleMap } from '../shared/battlemap.js';
import type { ArtPlan, ArtStatus } from '../shared/types.js';
import { artPlan } from './artPlan.js';
import { AssetLibrary } from './assets.js';

const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/**
 * The art folder from the settings, indexed once (and again when the folder changes or on
 * request), and what each map gets from it. Shared by the DM's API and the players' server.
 */
export class MapArt {
  private library: AssetLibrary | null = null;
  private loadedDir: string | undefined;
  private error: string | null = null;

  constructor(private readonly dirOf: () => string | undefined) {}

  private current(): AssetLibrary | null {
    const dir = this.dirOf();
    if (dir !== this.loadedDir) {
      this.loadedDir = dir;
      this.library = null;
      this.error = null;
      if (dir) {
        try {
          this.library = AssetLibrary.load(dir);
        } catch (err) {
          this.error = `Couldn't read ${dir}: ${(err as Error).message}`;
        }
      }
    }
    return this.library;
  }

  /** Walks the folder again (after adding packs). */
  reindex(): ArtStatus {
    this.loadedDir = undefined;
    return this.status();
  }

  status(): ArtStatus {
    const lib = this.current();
    return { dir: this.dirOf() ?? null, files: lib?.entries.length ?? 0, indexedAt: lib?.indexedAt ?? null, error: this.error };
  }

  /** The map's pictures, or null with no folder set (or no map). */
  plan(map: BattleMap | null): ArtPlan | null {
    const lib = this.current();
    return lib && map ? artPlan(map, lib) : null;
  }

  /** An image's path and type, if it's in the index (and, for players, in `allowed`). */
  file(id: string, allowed?: ReadonlySet<string>): { path: string; type: string } | undefined {
    if (allowed && !allowed.has(id)) return undefined;
    const path = this.current()?.path(id);
    return path ? { path, type: TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' } : undefined;
  }
}

/** An image from the art folder as a response, cached by the browser (the id changes if the file does). */
export function artImage(file: { path: string; type: string } | undefined): Response {
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream;
    return new Response(body, { headers: { 'Content-Type': file.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
