// The API's JSON shapes come from the server's own definitions (type-only: nothing from the server
// ends up in the bundle). Only what's specific to the browser is declared here.
import type { Config, SessionDetailWithJobs } from '../../src/shared/types';

export type {
  BotStatus,
  Config,
  ConfigState,
  FieldError,
  GuildInfo,
  Job,
  JobStep,
  Person,
  PromptInfo,
  RecordingStatus,
  SessionSummary,
  SummaryMeta,
  TranscriptLine,
} from '../../src/shared/types';

/** A session as GET /sessions/:id returns it, with its jobs. */
export type SessionDetail = SessionDetailWithJobs;
export type Effort = Config['summary']['extract_effort'];
export type SharedSpeaker = Exclude<Config['speakers'][string], string>;
export type Campaign = Config['campaigns'][string];

/** Present only inside the Mac app (see electron/preload.cts). */
export interface DesktopBridge {
  version(): Promise<string>;
  getKeys(): Promise<Record<'discord' | 'groq' | 'anthropic' | 'password', boolean>>;
  setKeys(keys: Partial<Record<'discord' | 'groq' | 'anthropic', string>>): Promise<{ restarted: boolean }>;
  getPhoneAccess(): Promise<{ password: string; port: number }>;
  resetPassword(): Promise<{ password: string }>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  dataFolder(): Promise<string>;
  revealDataFolder(): Promise<void>;
}

declare global {
  interface Window {
    sessionBot?: DesktopBridge;
  }
}
