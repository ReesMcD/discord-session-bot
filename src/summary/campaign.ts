import { parseIdentity, speakerNames, type Config, type Identity } from '../config/schema.js';
import type { SessionInfo } from '../session/layout.js';

export interface Character extends Identity {
  userId: string;
}

export interface Campaign {
  channelId: string;
  name?: string;
  context?: string;
  characters: Character[];
}

/**
 * The campaign a session belongs to: the one configured for its voice channel. Sessions without a
 * channel (Craig imports) use the only campaign when exactly one is configured.
 */
export function campaignFor(config: Pick<Config, 'campaigns'>, session: Pick<SessionInfo, 'channelId'>): Campaign | undefined {
  const entries = Object.entries(config.campaigns);
  const match = session.channelId ? entries.find(([id]) => id === session.channelId) : entries.length === 1 ? entries[0] : undefined;
  if (!match) return undefined;
  const [channelId, c] = match;
  return {
    channelId,
    ...(c.name ? { name: c.name } : {}),
    ...(c.context ? { context: c.context } : {}),
    characters: Object.entries(c.characters).map(([userId, text]) => ({ userId, ...parseIdentity(text) })),
  };
}

/** "- Thorin — dwarf fighter (played by Sam)" per character, naming players as the transcript does. */
export function partyBlock(campaign: Campaign, config: Pick<Config, 'speakers'>, spokenNames: ReadonlyMap<string, string>): string {
  const aliases = speakerNames(config);
  return campaign.characters
    .map((c) => {
      const player = spokenNames.get(c.userId) ?? aliases[c.userId];
      return `- ${c.description}${player ? ` (played by ${player})` : ''}`;
    })
    .join('\n');
}
