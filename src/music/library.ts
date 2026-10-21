import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../session/layout.js';
import type { MusicLibraryState, MusicScene, MusicSound } from '../shared/types.js';
import { normalizeUrl } from './control.js';

export type { MusicLibraryState, MusicScene, MusicSound } from '../shared/types.js';

/** Sound effects are short; this keeps the library (and each play over IPC) small. */
export const MAX_SOUND_BYTES = 10 * 1024 * 1024;

/** Audio types a browser can decode, and the extension each is stored with. */
const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};
const EXTENSION_TYPES: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };

const clampVolume = (v: number) => Math.min(1, Math.max(0, v));
const cleanName = (name: string) => {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error('Give it a name');
  return n;
};

/** The base media type: "audio/mpeg; charset=…" → "audio/mpeg". */
function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Saved music scenes (sets of tabs to switch between) and soundboard effects (audio files played
 * once over the music). Stored in <data>/music/: library.json and sounds/<id>.<ext>. A sound added
 * from a link is downloaded once, so it plays instantly during a session.
 */
export class MusicLibrary {
  private readonly file: string;
  private readonly soundsDir: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'music', 'library.json');
    this.soundsDir = join(dataDir, 'music', 'sounds');
  }

  read(): MusicLibraryState {
    const saved = readJson<Partial<MusicLibraryState>>(this.file);
    return { scenes: saved?.scenes ?? [], sounds: saved?.sounds ?? [] };
  }

  addScene(name: string, tabs: { url: string; volume: number }[]): MusicScene {
    if (!tabs.length) throw new Error('A scene needs at least one tab: open the pages you want first');
    const scene: MusicScene = { id: randomUUID().slice(0, 8), name: cleanName(name), tabs: tabs.map((t) => ({ url: normalizeUrl(t.url), volume: clampVolume(t.volume) })) };
    this.save((s) => s.scenes.push(scene));
    return scene;
  }

  updateScene(id: string, patch: { name?: string; tabs?: { url: string; volume: number }[] }): MusicScene {
    let updated: MusicScene | undefined;
    this.save((s) => {
      const scene = s.scenes.find((x) => x.id === id);
      if (!scene) return;
      if (patch.name !== undefined) scene.name = cleanName(patch.name);
      if (patch.tabs) {
        if (!patch.tabs.length) throw new Error('A scene needs at least one tab');
        scene.tabs = patch.tabs.map((t) => ({ url: normalizeUrl(t.url), volume: clampVolume(t.volume) }));
      }
      updated = scene;
    });
    if (!updated) throw new NotFound();
    return updated;
  }

  deleteScene(id: string): void {
    this.save((s) => void (s.scenes = s.scenes.filter((x) => x.id !== id)));
  }

  scene(id: string): MusicScene | undefined {
    return this.read().scenes.find((x) => x.id === id);
  }

  /** Adds a sound from an uploaded file. */
  addSound(name: string, audio: Uint8Array, contentType: string, fileName = ''): MusicSound {
    const type = mediaType(contentType);
    const ext = AUDIO_TYPES[type] ?? EXTENSION_TYPES[fileName.split('.').pop()?.toLowerCase() ?? ''];
    if (!ext) throw new Error('That isn’t an audio file this app can play (MP3, OGG, WAV, M4A, WebM or FLAC)');
    if (audio.byteLength === 0) throw new Error('The file is empty');
    if (audio.byteLength > MAX_SOUND_BYTES) throw new Error('Sound effects can be up to 10 MB');
    const id = randomUUID().slice(0, 8);
    const sound: MusicSound = { id, name: cleanName(name), volume: 0.8, file: `${id}.${ext}` };
    mkdirSync(this.soundsDir, { recursive: true });
    writeFileSync(join(this.soundsDir, sound.file), audio);
    this.save((s) => s.sounds.push(sound));
    return sound;
  }

  /** Downloads a sound from a link, once. */
  async addSoundFromUrl(name: string, link: string, doFetch: typeof fetch = fetch): Promise<MusicSound> {
    const url = normalizeUrl(link);
    const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Couldn't download it: ${res.status} ${res.statusText}`.trim());
    const audio = await readUpTo(res, MAX_SOUND_BYTES);
    const fileName = new URL(url).pathname.split('/').pop() ?? '';
    return this.addSound(name, audio, res.headers.get('content-type') ?? '', fileName);
  }

  updateSound(id: string, patch: { name?: string; volume?: number }): MusicSound {
    let updated: MusicSound | undefined;
    this.save((s) => {
      const sound = s.sounds.find((x) => x.id === id);
      if (!sound) return;
      if (patch.name !== undefined) sound.name = cleanName(patch.name);
      if (patch.volume !== undefined) sound.volume = clampVolume(patch.volume);
      updated = sound;
    });
    if (!updated) throw new NotFound();
    return updated;
  }

  deleteSound(id: string): void {
    const sound = this.read().sounds.find((x) => x.id === id);
    if (sound) rmSync(join(this.soundsDir, sound.file), { force: true });
    this.save((s) => void (s.sounds = s.sounds.filter((x) => x.id !== id)));
  }

  /** The sound and its audio bytes, to play. */
  soundAudio(id: string): { sound: MusicSound; audio: Uint8Array } {
    const sound = this.read().sounds.find((x) => x.id === id);
    const file = sound && join(this.soundsDir, sound.file);
    if (!sound || !file || !existsSync(file)) throw new NotFound();
    return { sound, audio: new Uint8Array(readFileSync(file)) };
  }

  private save(change: (state: MusicLibraryState) => void): void {
    const state = this.read();
    change(state);
    writeJson(this.file, state);
  }
}

/** The response body, refusing more than `limit` bytes (the server may not say how big it is). */
async function readUpTo(res: Response, limit: number): Promise<Uint8Array> {
  if (Number(res.headers.get('content-length') ?? 0) > limit) throw new Error('Sound effects can be up to 10 MB');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.byteLength;
    if (total > limit) throw new Error('Sound effects can be up to 10 MB');
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.byteLength));
  return out;
}

export class NotFound extends Error {
  override name = 'NotFound';
  constructor() {
    super('not found');
  }
}
