import { Hono, type Context } from 'hono';
import { normalizeUrl, type MusicControl, type MusicStatus } from '../music/control.js';
import { MAX_SOUND_BYTES, MusicLibrary, NotFound } from '../music/library.js';

/**
 * /music: the Mac app's built-in browser, plus saved scenes and soundboard effects. Without the Mac
 * app (`npm run app`) the status and the library answer, but nothing plays.
 */
export function musicRoutes(control: MusicControl | undefined, library: MusicLibrary): Hono {
  const music = new Hono();
  const needsMac = { error: 'Music needs the Mac app' };
  /** Library changes answer with the whole library; a bad request with its reason. */
  const libraryCall = async (c: Context, change: () => unknown) => {
    try {
      await change();
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof NotFound ? 404 : 400);
    }
    return c.json(library.read());
  };
  const noMusic: MusicStatus = { available: false, inChannel: false, master: 1, monitor: true, tabs: [], playingSounds: [] };
  const unit = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
  music.get('/', (c) => c.json(control?.status() ?? noMusic));
  music.post('/tabs', async (c) => {
    if (!control) return c.json(needsMac, 409);
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    try {
      control.openTab(normalizeUrl(typeof url === 'string' ? url : ''));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(control.status());
  });
  music.patch('/tabs/:id', async (c) => {
    if (!control) return c.json(needsMac, 409);
    const id = c.req.param('id');
    if (!control.status().tabs.some((t) => t.id === id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { volume?: unknown; muted?: unknown; active?: unknown };
    if (body.volume !== undefined && unit(body.volume) === undefined) return c.json({ error: 'volume must be between 0 and 1' }, 400);
    control.updateTab(id, {
      ...(body.volume !== undefined ? { volume: body.volume as number } : {}),
      ...(typeof body.muted === 'boolean' ? { muted: body.muted } : {}),
      ...(body.active === true ? { active: true } : {}),
    });
    return c.json(control.status());
  });
  music.delete('/tabs/:id', (c) => {
    if (!control) return c.json(needsMac, 409);
    control.closeTab(c.req.param('id'));
    return c.json(control.status());
  });
  music.patch('/', async (c) => {
    if (!control) return c.json(needsMac, 409);
    const body = (await c.req.json().catch(() => ({}))) as { master?: unknown; monitor?: unknown };
    if (body.master !== undefined && unit(body.master) === undefined) return c.json({ error: 'master must be between 0 and 1' }, 400);
    control.update({ ...(body.master !== undefined ? { master: body.master as number } : {}), ...(typeof body.monitor === 'boolean' ? { monitor: body.monitor } : {}) });
    return c.json(control.status());
  });


  // --- Scenes and soundboard ----------------------------------------------------------------------
  music.get('/library', (c) => c.json(library.read()));

  /** Saves a scene: the tabs given, or the tabs open now. */
  music.post('/scenes', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; tabs?: unknown };
    return libraryCall(c, () => library.addScene(String(body.name ?? ''), sceneTabs(body.tabs) ?? currentTabs()));
  });
  music.patch('/scenes/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; tabs?: unknown; fromCurrent?: unknown };
    const tabs = body.fromCurrent === true ? currentTabs() : sceneTabs(body.tabs);
    return libraryCall(c, () => library.updateScene(c.req.param('id'), { ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(tabs ? { tabs } : {}) }));
  });
  music.delete('/scenes/:id', (c) => libraryCall(c, () => library.deleteScene(c.req.param('id'))));
  music.post('/scenes/:id/play', async (c) => {
    if (!control) return c.json(needsMac, 409);
    const scene = library.scene(c.req.param('id'));
    if (!scene) return c.json({ error: 'not found' }, 404);
    const { fadeSeconds } = (await c.req.json().catch(() => ({}))) as { fadeSeconds?: unknown };
    const seconds = typeof fadeSeconds === 'number' && fadeSeconds >= 0 && fadeSeconds <= 30 ? fadeSeconds : 3;
    control.playScene(scene.tabs, seconds * 1000);
    return c.json(control.status());
  });

  /** Adds a sound: JSON { name, url } downloads it once; an audio body (?name=…&file=…) is an upload. */
  music.post('/sounds', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (type.startsWith('application/json')) {
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; url?: unknown };
      return libraryCall(c, () => library.addSoundFromUrl(String(body.name ?? ''), String(body.url ?? '')));
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_SOUND_BYTES) return c.json({ error: 'Sound effects can be up to 10 MB' }, 413);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    return libraryCall(c, () => library.addSound(c.req.query('name') ?? '', audio, type, c.req.query('file') ?? ''));
  });
  music.patch('/sounds/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; volume?: unknown };
    if (body.volume !== undefined && unit(body.volume) === undefined) return c.json({ error: 'volume must be between 0 and 1' }, 400);
    return libraryCall(c, () =>
      library.updateSound(c.req.param('id'), { ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(body.volume !== undefined ? { volume: body.volume as number } : {}) }),
    );
  });
  music.delete('/sounds/:id', (c) => libraryCall(c, () => library.deleteSound(c.req.param('id'))));
  music.post('/sounds/stop', (c) => {
    if (!control) return c.json(needsMac, 409);
    control.stopSounds();
    return c.json(control.status());
  });
  music.post('/sounds/:id/play', (c) => {
    if (!control) return c.json(needsMac, 409);
    try {
      const { sound, audio } = library.soundAudio(c.req.param('id'));
      control.playSound(sound.id, audio, sound.volume);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(control.status());
  });

  /** A scene's tabs from a request body, or undefined when none were given. */
  function sceneTabs(input: unknown): { url: string; volume: number }[] | undefined {
    if (!Array.isArray(input)) return undefined;
    return input.map((t: { url?: unknown; volume?: unknown }) => ({ url: String(t?.url ?? ''), volume: unit(t?.volume) ?? 1 }));
  }
  /** The tabs open now, as a scene (muted ones are left out). */
  function currentTabs(): { url: string; volume: number }[] {
    return (control?.status().tabs ?? []).filter((t) => !t.muted).map((t) => ({ url: t.url, volume: t.volume }));
  }

  return music;
}
