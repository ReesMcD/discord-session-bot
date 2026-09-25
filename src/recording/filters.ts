export interface RecordFilterConfig {
  ignoreUserIds: ReadonlySet<string>;
  ignoreBots: boolean;
  /** The bot's own user id; never recorded. */
  selfId: string;
}

export interface SpeakerInfo {
  id: string;
  bot: boolean;
}

export type SkipReason = 'self' | 'ignored_user' | 'bot';

/** Decides, before subscribing, whether a speaker may be recorded. */
export function skipReason(speaker: SpeakerInfo, config: RecordFilterConfig): SkipReason | undefined {
  if (speaker.id === config.selfId) return 'self';
  if (config.ignoreUserIds.has(speaker.id)) return 'ignored_user';
  if (config.ignoreBots && speaker.bot) return 'bot';
  return undefined;
}
