/** Live state of a recording, shared by the API, web UI and menu bar. */
export interface RecordingStatus {
  sessionId: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  startedAt: number;
  state: 'connecting' | 'recording' | 'reconnecting' | 'stopping';
  participants: { id: string; name: string; utterances: number; audioMs: number; speaking: boolean }[];
  skipped: { id: string; name: string; reason: string }[];
  reconnects: number;
}

export interface BotStatus {
  state: 'off' | 'connecting' | 'ready' | 'error';
  user?: string;
  error?: string;
  recording: RecordingStatus | null;
}

export interface VoiceChannelInfo {
  id: string;
  name: string;
  members: { id: string; name: string; bot: boolean }[];
}

export interface GuildInfo {
  id: string;
  name: string;
  channels: VoiceChannelInfo[];
}

/** What the API and menu bar need from the bot (a fake implements this in tests). */
export interface BotControl {
  status(): BotStatus;
  guilds(): GuildInfo[];
  join(channelId: string): Promise<RecordingStatus>;
  stop(): Promise<{ sessionId: string }>;
  on(event: 'status', listener: (s: BotStatus) => void): unknown;
  off(event: 'status', listener: (s: BotStatus) => void): unknown;
}
