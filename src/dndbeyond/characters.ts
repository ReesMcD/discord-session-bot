import type { DndBeyondCharacter } from '../shared/types.js';

/**
 * Reads a public D&D Beyond character: its name, a short description ("Hill Dwarf Fighter 5") and,
 * when it's in a campaign, that campaign's other characters, so they can be added in one go.
 * D&D Beyond has no official API; this is the character service its own sheet uses, which works
 * without signing in for characters set to Public. It may change, so everything is read defensively.
 */
export async function lookupCharacter(id: number, fetchImpl: typeof fetch = fetch): Promise<DndBeyondCharacter> {
  let res: Response;
  try {
    res = await fetchImpl(`https://character-service.dndbeyond.com/character/v5/character/${id}`, {
      headers: { accept: 'application/json', 'user-agent': 'scrying-eye' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DndBeyondError("Couldn't reach D&D Beyond. Try again in a minute.");
  }
  const notPublic = `Character ${id} isn't public. In D&D Beyond: open it → Character Settings → Character Privacy → Public.`;
  if (res.status === 401 || res.status === 403) throw new DndBeyondError(notPublic);
  if (res.status === 404) throw new DndBeyondError(`D&D Beyond has no character ${id}. Check the link.`);
  if (res.status === 429) throw new DndBeyondError('D&D Beyond is rate-limiting requests. Try again in a few minutes.');
  if (!res.ok) throw new DndBeyondError(`D&D Beyond answered ${res.status} for character ${id}.`);
  const json = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: Sheet } | null;
  if (!json?.data || json.success === false) throw new DndBeyondError(/private|permission|access/i.test(json?.message ?? '') ? notPublic : `D&D Beyond couldn't load character ${id}.`);
  return toCharacter(id, json.data);
}

export class DndBeyondError extends Error {}

interface Sheet {
  id?: number;
  name?: string;
  race?: { fullName?: string; baseName?: string };
  classes?: Array<{ level?: number; definition?: { name?: string } }>;
  campaign?: {
    id?: number;
    name?: string;
    characters?: Array<{ characterId?: number; characterName?: string; username?: string }>;
  } | null;
}

function toCharacter(id: number, sheet: Sheet): DndBeyondCharacter {
  const classes = (sheet.classes ?? []).filter((c) => c.definition?.name).map((c) => `${c.definition!.name} ${c.level ?? ''}`.trim());
  const description = [sheet.race?.fullName ?? sheet.race?.baseName, classes.join(' / ')].filter(Boolean).join(' ');
  const c = sheet.campaign;
  return {
    id,
    name: sheet.name?.trim() || `Character ${id}`,
    ...(description ? { description } : {}),
    ...(c?.id
      ? {
          campaign: {
            id: c.id,
            name: c.name?.trim() || `Campaign ${c.id}`,
            characters: (c.characters ?? [])
              .filter((x) => x.characterId && x.characterName)
              .map((x) => ({ id: x.characterId!, name: x.characterName!.trim(), ...(x.username ? { player: x.username } : {}) })),
          },
        }
      : {}),
  };
}
