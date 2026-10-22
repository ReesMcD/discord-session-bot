import type { Config } from '../config/schema.js';
import type { SessionInfo } from '../session/layout.js';
import type { TranscriptLine, UnpairedSpeaker } from '../shared/types.js';
import { campaignFor, othersBlock, partyBlock } from '../config/roster.js';

/** How the prompts should treat people who aren't on the roster yet, from the clean-up's guesses. */
function unpairedLines(unpaired: readonly UnpairedSpeaker[]): string {
  return unpaired
    .map((u) =>
      u.role === 'guest'
        ? `- ${u.name}: a guest, not playing. What they say is table talk, never something a character does.`
        : u.role === 'new_player'
          ? `- ${u.name}: probably a new player${u.character ? `, playing ${u.character}` : ''} (not confirmed yet). Treat ${u.character ?? 'their character'} as part of the party, not an NPC.`
          : `- ${u.name}: not on the roster; could be a new player or a guest.`,
    )
    .join('\n');
}

/**
 * The "About this call" block every prompt starts with: date, channel, speakers, the campaign's
 * playable characters (plus anyone not on the roster yet), and the user's context.
 */
export function contextBlock(
  session: SessionInfo,
  lines: readonly TranscriptLine[],
  config: Pick<Config, 'summary' | 'transcript' | 'campaigns' | 'speakers' | 'characters'>,
  unpaired: readonly UnpairedSpeaker[] = [],
): string {
  const speakers = [...new Set(lines.map((l) => l.speaker))].join(', ');
  const timeZone = config.transcript.timezone;
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', ...(timeZone ? { timeZone } : {}) }).format(session.startedAt);
  const campaign = campaignFor(config, session);
  const party = campaign?.characters.length ? partyBlock(campaign) : '';
  const others = othersBlock(config, campaign, new Set(lines.map((l) => l.userId)));
  return [
    '## About this call',
    '',
    `- Date: ${date}`,
    ...(session.channelName ? [`- Channel: #${session.channelName}${session.guildName ? ` in ${session.guildName}` : ''}`] : []),
    ...(campaign?.name ? [`- Campaign: ${campaign.name}`] : []),
    `- Speakers: ${speakers}`,
    ...(party ? ['', '## Party', '', 'The playable characters, and who plays them. They are not NPCs.', '', party] : []),
    ...(others ? ['', '## Also at the table', '', 'Speakers who play no character here (the DM, guests).', '', others] : []),
    ...(unpaired.length ? ['', '## Not on the roster yet', '', unpairedLines(unpaired)] : []),
    ...(config.summary.context ? ['', config.summary.context.trim()] : []),
    ...(campaign?.context ? ['', campaign.context.trim()] : []),
  ].join('\n');
}
