import { campaignFor } from '../config/campaign.js';
import type { Config } from '../config/schema.js';
import { readJson, readSessionInfo, writeJson } from '../session/layout.js';
import type { UnpairedSpeaker } from '../shared/types.js';
import { summaryPaths } from '../summary/summarizeSession.js';

export type UnpairedAction = { action: 'pair'; character: string } | { action: 'guest' } | { action: 'ignore' };

/** The session's unpaired speakers that still need a decision under the current roster. */
export function pendingUnpaired(sessionDir: string, config: Config | null): UnpairedSpeaker[] {
  const all = readJson<UnpairedSpeaker[]>(summaryPaths.unpaired(sessionDir)) ?? [];
  const campaign = config ? campaignFor(config, readSessionInfo(sessionDir)) : undefined;
  const known = new Set([...(campaign?.characters.map((c) => c.userId) ?? []), ...(campaign?.guests ?? [])]);
  return all.filter((u) => !u.dismissed && !known.has(u.userId));
}

/**
 * Applies a decision. Pairing and "guest" change the campaign in the returned config (the caller
 * saves it); "ignore" only marks the person for this session.
 */
export function resolveUnpaired(sessionDir: string, config: Config, userId: string, decision: UnpairedAction): Config | undefined {
  if (decision.action === 'ignore') {
    const all = readJson<UnpairedSpeaker[]>(summaryPaths.unpaired(sessionDir)) ?? [];
    writeJson(summaryPaths.unpaired(sessionDir), all.map((u) => (u.userId === userId ? { ...u, dismissed: true } : u)));
    return undefined;
  }
  const campaign = campaignFor(config, readSessionInfo(sessionDir));
  if (!campaign) throw new Error('This session has no campaign; set one up under Settings → Campaigns first');
  const next = structuredClone(config);
  const entry = next.campaigns[campaign.channelId]!;
  if (decision.action === 'pair') {
    const name = decision.character.trim();
    if (!name) throw new Error('Give the character a name');
    entry.characters[userId] = { name };
    entry.guests = entry.guests.filter((g) => g !== userId);
  } else if (!entry.guests.includes(userId)) {
    entry.guests.push(userId);
  }
  return next;
}
