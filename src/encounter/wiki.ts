import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config/schema.js';
import type { Combatant, EncounterState, WikiEncounter, WikiEncounterSummary } from '../shared/types.js';
import { readMap } from '../shared/battlemap.js';
import { combatantId, makeCombatant, newEncounter, sortOrder } from './rules.js';

/**
 * The Ardent Weave wiki's encounters (ReesMcD/dnd-wiki, mcp/src/encounters-api.ts). It's the
 * same wiki recaps are uploaded to, and it takes the same key (its ENCOUNTERS_TOKEN falls back
 * to SESSION_INGEST_TOKEN).
 */
export class WikiEncountersError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** /api/encounters on the wiki recaps go to, or an explanation of what to set up. */
export function encountersUrl(config: Config): URL {
  const { url, format } = config.upload;
  if (!url || format !== 'ardent-weave') throw new WikiEncountersError('Set Settings → Upload to your Ardent Weave wiki first: encounters come from the same wiki and key', 409);
  return new URL('/api/encounters', url);
}

async function getJson<T>(url: URL, token: string | undefined, doFetch: typeof fetch): Promise<T> {
  if (!token) throw new WikiEncountersError('The wiki key is missing: add it under Settings → Keys (the same key as recap uploads)', 409);
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ScryingEye' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new WikiEncountersError(`Couldn't reach the wiki: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (res.status === 401 || res.status === 403) throw new WikiEncountersError('The wiki refused the key (Settings → Keys)', 502);
  if (!res.ok || !body) throw new WikiEncountersError(typeof body?.error === 'string' ? body.error : `The wiki answered ${res.status}`, res.status === 404 ? 404 : 502);
  return body;
}

const cacheFile = (dataDir: string, campaign: string | undefined, id: string) => join(dataDir, 'encounters', 'wiki', `${(campaign ?? 'any').replace(/[^\w-]+/g, '_')}--${id.replace(/[^\w-]+/g, '_')}.json`);

export class WikiEncounters {
  constructor(
    private readonly dataDir: string,
    private readonly config: () => Config,
    private readonly token: () => string | undefined,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async list(campaign?: string): Promise<WikiEncounterSummary[]> {
    const url = encountersUrl(this.config());
    if (campaign) url.searchParams.set('campaign', campaign);
    return (await getJson<{ encounters: WikiEncounterSummary[] }>(url, this.token(), this.doFetch)).encounters;
  }

  /** One encounter. Kept on disk, so one loaded before is still there if the wiki is unreachable. */
  async get(id: string, campaign?: string): Promise<WikiEncounter & { cached?: true }> {
    const url = encountersUrl(this.config());
    url.pathname += `/${encodeURIComponent(id)}`;
    if (campaign) url.searchParams.set('campaign', campaign);
    const file = cacheFile(this.dataDir, campaign, id);
    try {
      const encounter = await getJson<WikiEncounter>(url, this.token(), this.doFetch);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(encounter));
      renameSync(`${file}.tmp`, file);
      return encounter;
    } catch (err) {
      // Unreachable (not refused or missing): use the copy from last time, if there is one.
      if (err instanceof WikiEncountersError && err.status === 502 && !/refused/.test(err.message) && existsSync(file)) {
        return { ...(JSON.parse(readFileSync(file, 'utf8')) as WikiEncounter), cached: true };
      }
      throw err;
    }
  }
}


/** An encounter ready to set up: the party, every creature (one per copy), stat blocks, the map and the DM's notes. */
export function encounterFromWiki(w: WikiEncounter, id: string, now: number): EncounterState {
  const s = newEncounter(id, w.title, now);
  s.source = { wikiId: w.id, campaign: w.campaign };
  s.notes = { summary: w.summary, read_aloud: w.read_aloud, setup: w.setup, tactics: w.tactics, changes: w.changes, treasure: w.treasure };
  s.map = readMap(w.map);
  const tokens = s.map?.tokens ?? [];
  const used = new Set<string>();
  /** The map token for a combatant: the same name, else the next unused one of its kind whose name starts the same. */
  const tokenFor = (name: string, base: string, kind: string) => {
    const exact = tokens.find((t) => !used.has(t.id) && t.name === name);
    const t = exact ?? tokens.find((t) => !used.has(t.id) && t.kind === kind && t.name.toLowerCase().startsWith(base.toLowerCase()));
    if (t) used.add(t.id);
    return t;
  };
  const taken = new Set<string>();
  const add = (c: Combatant) => {
    taken.add(c.id);
    s.combatants.push(c);
  };
  for (const p of w.party) {
    const t = tokenFor(p.name, p.name, 'pc');
    add(makeCombatant(combatantId(p.name, taken), { name: p.name, kind: 'pc', ac: p.ac, hp: p.hp, player: p.player, ...(t ? { tokenId: t.id } : {}) }));
  }
  for (const creature of w.creatures) {
    const { count, ...block } = creature;
    s.statBlocks[block.name] = block;
    for (let i = 1; i <= count; i++) {
      const name = count > 1 ? `${block.name} ${i}` : block.name;
      const t = tokenFor(name, block.name, 'monster');
      add(
        makeCombatant(combatantId(name, taken), {
          name,
          kind: 'monster',
          ac: block.ac ?? null,
          hp: block.hp ?? null,
          ...(block.initiative !== undefined ? { initiativeBonus: block.initiative } : {}),
          dex: block.abilities?.[1] ?? null,
          ref: block.name,
          hidden: t?.hidden === true,
          ...(t ? { tokenId: t.id } : {}),
        }),
      );
    }
  }
  s.order = sortOrder(s.combatants);
  return s;
}
