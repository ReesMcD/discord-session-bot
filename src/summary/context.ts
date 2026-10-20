import type { Config } from '../config/schema.js';
import type { SessionInfo } from '../session/layout.js';
import type { TranscriptLine } from '../transcript/merge.js';
import { campaignFor, partyBlock } from '../config/campaign.js';

/**
 * The "About this call" block every prompt starts with: date, channel, speakers, the campaign's
 * playable characters, and the user's context.
 */
export function contextBlock(session: SessionInfo, lines: readonly TranscriptLine[], config: Pick<Config, 'summary' | 'transcript' | 'campaigns' | 'speakers'>): string {
  const spoken = new Map<string, string>();
  for (const l of lines) if (!spoken.has(l.userId)) spoken.set(l.userId, l.inferred?.account ?? l.speaker);
  const speakers = [...new Set(lines.map((l) => l.speaker))].join(', ');
  const timeZone = config.transcript.timezone;
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', ...(timeZone ? { timeZone } : {}) }).format(session.startedAt);
  const campaign = campaignFor(config, session);
  const party = campaign?.characters.length ? partyBlock(campaign, config, spoken) : '';
  return [
    '## About this call',
    '',
    `- Date: ${date}`,
    ...(session.channelName ? [`- Channel: #${session.channelName}${session.guildName ? ` in ${session.guildName}` : ''}`] : []),
    ...(campaign?.name ? [`- Campaign: ${campaign.name}`] : []),
    `- Speakers: ${speakers}`,
    ...(party ? ['', '## Party', '', 'The playable characters, and who plays them. They are not NPCs.', '', party] : []),
    ...(config.summary.context ? ['', config.summary.context.trim()] : []),
    ...(campaign?.context ? ['', campaign.context.trim()] : []),
  ].join('\n');
}
