import { Hono, type Context } from 'hono';
import { EncounterError } from '../encounter/rules.js';
import type { EncounterStore } from '../encounter/store.js';
import { encounterFromWiki, WikiEncountersError, type WikiEncounters } from '../encounter/wiki.js';
import type { EncounterAction } from '../shared/types.js';
import type { BotControl } from '../bot/types.js';
import { joinPost } from '../bot/encounterCommand.js';

/**
 * The DM's encounter API (behind the app password):
 *   GET  /encounters/wiki[?campaign=]       prepared encounters in the wiki
 *   GET  /encounters/wiki/:id[?campaign=]   one, to preview
 *   GET  /encounter                          the one running, or null
 *   POST /encounter                          start: { wikiId, campaign? } or { title }
 *   POST /encounter/actions                  one change (EncounterAction)
 *   POST /encounter/end                      end it; answers with the summary
 *   GET  /encounter/link                     the players' join link
 *   POST /encounter/link                     a new link (the old one stops working)
 *   POST /encounter/post                     post the join link in Discord
 *   POST /players/check                      { public_url }: does the public address reach the players' page?
 */
/** Where players join: the public address (Funnel) when set, and this Mac's own address for testing. */
export interface JoinLinks {
  publicUrl: string | undefined;
  port: number;
}

/** The public join link for a code, when a public address is set. */
export const publicJoinUrl = (links: JoinLinks, code: string) => (links.publicUrl ? new URL(`/play/${code}`, links.publicUrl).href : null);

export function encounterRoutes(store: EncounterStore, wiki: WikiEncounters, links: () => JoinLinks, doFetch: typeof fetch = fetch, bot?: BotControl): Hono {
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
  const linkFor = () => {
    const code = store.current()?.join?.code;
    const { publicUrl, port } = links();
    if (!code) return { url: null, local: null, publicUrlSet: !!publicUrl };
    return { url: publicJoinUrl({ publicUrl, port }, code), local: `http://localhost:${port}/play/${code}`, publicUrlSet: !!publicUrl };
  };
  r.get('/encounter/link', (c) => c.json(linkFor()));
  r.post('/encounter/link', (c) => {
    try {
      store.newJoinLink();
      return c.json(linkFor());
    } catch (err) {
      return failed(c, err);
    }
  });

  r.post('/encounter/post', async (c) => {
    const state = store.current();
    if (!state?.join) return c.json({ error: 'No encounter is running' }, 400);
    const url = publicJoinUrl(links(), state.join.code);
    if (!url) return c.json({ error: 'Set the public address first (Settings → Players): players can’t open a link to this Mac' }, 409);
    if (!bot?.postEncounter || bot.status().state !== 'ready') return c.json({ error: 'The Discord bot isn’t connected' }, 409);
    try {
      const where = await bot.postEncounter(joinPost(state, url));
      return c.json({ message: `Posted in #${where.channelName}` });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  r.post('/players/check', async (c) => {
    const { public_url } = (await c.req.json().catch(() => ({}))) as { public_url?: unknown };
    let url: URL;
    try {
      url = new URL('/health', typeof public_url === 'string' ? public_url : '');
      if (url.protocol !== 'https:') throw new Error();
    } catch {
      return c.json({ ok: false, message: 'Enter the https:// address Tailscale Funnel shows' });
    }
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (res.ok && body?.ok === true) return c.json({ ok: true, message: 'Players can reach it' });
      return c.json({ ok: false, message: `It answered ${res.status}, but not as the players' page: is Funnel pointing at port ${links().port}?` });
    } catch (err) {
      return c.json({ ok: false, message: `Couldn't reach it: ${(err as Error).message}. Is Funnel on? (tailscale funnel --bg ${links().port})` });
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
