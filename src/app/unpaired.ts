import { campaignFor } from '../config/roster.js';
import type { Config } from '../config/schema.js';
import { readJson, readSessionInfo, writeJson } from '../session/layout.js';
import { rosterId } from '../shared/ids.js';
import type { UnpairedSpeaker } from '../shared/types.js';
import { summaryPaths } from '../summary/summarizeSession.js';

/**
 * What to do about a Discord account no speaker is linked to: link it to a speaker you have, add a
 * new speaker (and the character they play in this session's campaign), or ignore it this time.
 */
export type UnpairedAction = { action: 'link'; speaker: string } | { action: 'new'; name: string; character?: string } | { action: 'ignore' };

/** The session's unpaired accounts that still need a decision under the current speakers. */
export function pendingUnpaired(sessionDir: string, config: Config | null): UnpairedSpeaker[] {
  const all = readJson<UnpairedSpeaker[]>(summaryPaths.unpaired(sessionDir)) ?? [];
  const linked = new Set(config ? Object.values(config.speakers).flatMap((s) => s.discord) : []);
  return all.filter((u) => !u.dismissed && !linked.has(u.userId));
}

/**
 * Applies a decision. Linking and adding change the returned config (the caller saves it);
 * "ignore" only marks the account for this session.
 */
export function resolveUnpaired(sessionDir: string, config: Config, userId: string, decision: UnpairedAction): Config | undefined {
  if (decision.action === 'ignore') {
    const all = readJson<UnpairedSpeaker[]>(summaryPaths.unpaired(sessionDir)) ?? [];
    writeJson(summaryPaths.unpaired(sessionDir), all.map((u) => (u.userId === userId ? { ...u, dismissed: true } : u)));
    return undefined;
  }
  const next = structuredClone(config);
  if (decision.action === 'link') {
    const speaker = next.speakers[decision.speaker];
    if (!speaker) throw new Error('No such speaker');
    if (!speaker.discord.includes(userId)) speaker.discord.push(userId);
    return next;
  }
  const name = decision.name.trim();
  if (!name) throw new Error('Give the speaker a name');
  const speakerId = rosterId(name, (id) => id in next.speakers);
  next.speakers[speakerId] = { name, discord: [userId] };
  const character = decision.character?.trim();
  if (character) {
    const campaign = campaignFor(next, readSessionInfo(sessionDir));
    if (!campaign) throw new Error('This session has no campaign, so the character has nowhere to go. Pick the campaign first.');
    next.characters[rosterId(character, (id) => id in next.characters)] = { name: character, campaign: campaign.id, speaker: speakerId };
  }
  return next;
}
