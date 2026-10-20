import { parseIdentity, speakerNames, type Config, type Identity } from './schema.js';
import type { SessionInfo } from '../session/layout.js';
import type { TranscriptLine, UnpairedSpeaker } from '../shared/types.js';

export interface Character extends Identity {
  userId: string;
  dndbeyond?: number;
}

export interface Campaign {
  channelId: string;
  name?: string;
  context?: string;
  dndbeyond?: number;
  characters: Character[];
  guests: string[];
}

type CharacterEntry = Config['campaigns'][string]['characters'][string];

/** Either way of writing a character, as a name (`label`) and the full hint (`description`). */
export function parseCharacter(userId: string, entry: CharacterEntry): Character {
  if (typeof entry === 'string') return { userId, ...parseIdentity(entry) };
  return {
    userId,
    label: entry.name,
    description: entry.description ? `${entry.name} — ${entry.description}` : entry.name,
    ...(entry.dndbeyond ? { dndbeyond: entry.dndbeyond } : {}),
  };
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
    ...(c.dndbeyond ? { dndbeyond: c.dndbeyond } : {}),
    characters: Object.entries(c.characters).map(([userId, entry]) => parseCharacter(userId, entry)),
    guests: c.guests,
  };
}

/** "- Thorin — dwarf fighter (played by Sam)" per character: the real name, else the Discord name. */
export function partyBlock(campaign: Campaign, config: Pick<Config, 'speakers'>, discordNames: ReadonlyMap<string, string>): string {
  const realNames = speakerNames(config);
  return campaign.characters
    .map((c) => {
      const player = realNames[c.userId] ?? discordNames.get(c.userId);
      return `- ${c.description}${player ? ` (played by ${player})` : ''}`;
    })
    .join('\n');
}

/** Who spoke in this session but is neither on the campaign's roster nor one of its guests. */
export function unpairedSpeakers(campaign: Campaign | undefined, lines: readonly TranscriptLine[]): UnpairedSpeaker[] {
  if (!campaign) return [];
  const known = new Set([...campaign.characters.map((c) => c.userId), ...campaign.guests]);
  const out = new Map<string, UnpairedSpeaker>();
  for (const l of lines) {
    if (known.has(l.userId) || out.has(l.userId)) continue;
    out.set(l.userId, { userId: l.userId, name: l.player ?? l.inferred?.account ?? l.speaker });
  }
  return [...out.values()];
}
