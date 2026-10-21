import type { BotStatus, GuildInfo, LiveTranscript, LiveUpdate, RecordingStatus } from '../shared/types.js';

export type { LiveUpdate };

export type { BotStatus, GuildInfo, RecordingStatus, VoiceChannelInfo } from '../shared/types.js';

/** What the API and menu bar need from the bot (a fake implements this in tests). */
export interface BotControl {
  status(): BotStatus;
  guilds(): GuildInfo[];
  join(channelId: string): Promise<RecordingStatus>;
  stop(): Promise<{ sessionId: string }>;
  on(event: 'status', listener: (s: BotStatus) => void): unknown;
  off(event: 'status', listener: (s: BotStatus) => void): unknown;
  /** The current recording's live transcript; "live" events carry only the new lines. */
  liveTranscript?(): LiveSnapshot;
  on(event: 'live', listener: (u: LiveUpdate) => void): unknown;
  off(event: 'live', listener: (u: LiveUpdate) => void): unknown;
}

export type LiveSnapshot = LiveTranscript & { sessionId: string | null };
