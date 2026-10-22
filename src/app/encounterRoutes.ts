import { Hono, type Context } from 'hono';
import { EncounterError } from '../encounter/rules.js';
import type { EncounterStore } from '../encounter/store.js';
import { encounterFromWiki, WikiEncountersError, type WikiEncounters } from '../encounter/wiki.js';
import type { EncounterAction } from '../shared/types.js';

/**
 * The DM's encounter API (behind the app password):
 *   GET  /encounters/wiki[?campaign=]       prepared encounters in the wiki
 *   GET  /encounters/wiki/:id[?campaign=]   one, to preview
 *   GET  /encounter                          the one running, or null
 *   POST /encounter                          start: { wikiId, campaign? } or { title }
 *   POST /encounter/actions                  one change (EncounterAction)
 *   POST /encounter/end                      end it; answers with the summary
 */
export function encounterRoutes(store: EncounterStore, wiki: WikiEncounters): Hono {
  const r = new Hono();
  const failed = (c: Context, err: unknown) => {
    if (err instanceof WikiEncountersError) return c.json({ error: err.message }, err.status as 404 | 409 | 502);
    if (err instanceof EncounterError) return c.json({ error: err.message }, 400);
    throw err;
  };

  r.get('/encounters/wiki', async (c) => {
    try {
      return c.json(await wiki.list(c.req.query('campaign') || undefined));
    } catch (err) {
      return failed(c, err);
    }
  });
  r.get('/encounters/wiki/:id', async (c) => {
    try {
      return c.json(await wiki.get(c.req.param('id'), c.req.query('campaign') || undefined));
    } catch (err) {
      return failed(c, err);
    }
  });

  r.get('/encounter', (c) => c.json(store.current()));
  r.post('/encounter', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wikiId?: unknown; campaign?: unknown; title?: unknown };
    try {
      if (typeof body.wikiId === 'string' && body.wikiId) {
        const prepared = await wiki.get(body.wikiId, typeof body.campaign === 'string' && body.campaign ? body.campaign : undefined);
        return c.json(store.start(encounterFromWiki(prepared, store.newId(), Date.now())), 201);
      }
      if (typeof body.title !== 'string') return c.json({ error: 'Send wikiId (a prepared encounter) or title (a blank one)' }, 400);
      return c.json(store.start({ title: body.title }), 201);
    } catch (err) {
      if (err instanceof EncounterError && /still running/.test(err.message)) return c.json({ error: err.message }, 409);
      return failed(c, err);
    }
  });
  r.post('/encounter/actions', async (c) => {
    const action = (await c.req.json().catch(() => null)) as EncounterAction | null;
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return c.json({ error: 'Send an action: { "type": "next" }' }, 400);
    try {
      return c.json(store.act(action));
    } catch (err) {
      return failed(c, err);
    }
  });
  r.post('/encounter/end', (c) => {
    try {
      return c.json(store.end());
    } catch (err) {
      return failed(c, err);
    }
  });
  return r;
}
