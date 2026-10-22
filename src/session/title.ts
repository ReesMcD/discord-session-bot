import { campaignFor } from '../config/roster.js';
import type { Config } from '../config/schema.js';
import type { SessionInfo } from '../shared/types.js';

/**
 * A session's name: the one given by hand, else sessions.title filled in. {campaign} falls back to
 * #channel, then "Session", so a recording with no campaign still reads well.
 */
export function sessionTitle(info: SessionInfo, config: Pick<Config, 'speakers' | 'campaigns' | 'characters' | 'sessions' | 'transcript'>): string {
  if (info.title?.trim()) return info.title.trim();
  const tz = config.transcript.timezone ? { timeZone: config.transcript.timezone } : {};
  const channel = info.channelName ? `#${info.channelName}` : '';
  const values: Record<string, string> = {
    campaign: campaignFor(config, info)?.name ?? (channel || 'Session'),
    channel: channel || 'Session',
    date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tz }).format(info.startedAt),
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', ...tz }).format(info.startedAt),
  };
  return config.sessions.title.replace(/\{(campaign|channel|date|time)\}/g, (_, k: string) => values[k]!).trim() || 'Session';
}
