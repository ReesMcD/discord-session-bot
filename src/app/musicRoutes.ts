import { Hono } from 'hono';
import { normalizeUrl, type MusicControl, type MusicStatus } from '../music/control.js';

/** /music: the Mac app's built-in browser. Without it (`npm run app`) only the status answers. */
export function musicRoutes(control: MusicControl | undefined): Hono {
  const music = new Hono();
  const noMusic: MusicStatus = { available: false, inChannel: false, master: 1, monitor: true, tabs: [] };
  const unit = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
  music.get('/', (c) => c.json(control?.status() ?? noMusic));
  music.post('/tabs', async (c) => {
    if (!control) return c.json({ error: 'Music needs the Mac app' }, 409);
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    try {
      control.openTab(normalizeUrl(typeof url === 'string' ? url : ''));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(control.status());
  });
  music.patch('/tabs/:id', async (c) => {
    if (!control) return c.json({ error: 'Music needs the Mac app' }, 409);
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
    if (!control) return c.json({ error: 'Music needs the Mac app' }, 409);
    control.closeTab(c.req.param('id'));
    return c.json(control.status());
  });
  music.patch('/', async (c) => {
    if (!control) return c.json({ error: 'Music needs the Mac app' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { master?: unknown; monitor?: unknown };
    if (body.master !== undefined && unit(body.master) === undefined) return c.json({ error: 'master must be between 0 and 1' }, 400);
    control.update({ ...(body.master !== undefined ? { master: body.master as number } : {}), ...(typeof body.monitor === 'boolean' ? { monitor: body.monitor } : {}) });
    return c.json(control.status());
  });

  return music;
}
