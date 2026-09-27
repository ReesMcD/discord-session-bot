import type { SessionInfo } from '../session/layout.js';
import type { TranscriptLine } from '../transcript/merge.js';

/** The "About this call" block every prompt starts with: date, channel, speakers, user context. */
export function contextBlock(session: SessionInfo, lines: readonly TranscriptLine[], context: string | undefined, timeZone: string | undefined): string {
  const speakers = [...new Set(lines.map((l) => l.speaker))].join(', ');
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', ...(timeZone ? { timeZone } : {}) }).format(session.startedAt);
  return [
    '## About this call',
    '',
    `- Date: ${date}`,
    ...(session.channelName ? [`- Channel: #${session.channelName}${session.guildName ? ` in ${session.guildName}` : ''}`] : []),
    `- Speakers: ${speakers}`,
    ...(context ? ['', context.trim()] : []),
  ].join('\n');
}
