import type { BotStatus, GuildInfo, RecordingStatus } from '../shared/types.js';

export type { BotStatus, GuildInfo, RecordingStatus, VoiceChannelInfo } from '../shared/types.js';

/** What the API and menu bar need from the bot (a fake implements this in tests). */
export interface BotControl {
  status(): BotStatus;
  guilds(): GuildInfo[];
  join(channelId: string): Promise<RecordingStatus>;
  stop(): Promise<{ sessionId: string }>;
  on(event: 'status', listener: (s: BotStatus) => void): unknown;
  off(event: 'status', listener: (s: BotStatus) => void): unknown;
}
