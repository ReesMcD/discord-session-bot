// Mirrors of the server's JSON shapes (src/app/*, src/config/schema.ts).

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SharedSpeaker = { name?: string; disambiguate?: string[] };

export interface Config {
  recording: {
    ignore_users: string[];
    ignore_bots: boolean;
    silence_ms: number;
    audio_retention_days: number;
    after_stop: 'nothing' | 'transcribe' | 'summarize';
    announce: boolean;
  };
  speakers: Record<string, string | SharedSpeaker>;
  transcription: {
    provider: 'groq' | 'openai';
    model?: string;
    base_url?: string;
    language?: string;
    prompt?: string;
    batch_minutes: number;
    concurrency: number;
    min_utterance_ms: number;
  };
  transcript: { merge_gap_seconds: number; max_line_seconds: number; timezone?: string };
  summary: {
    model: string;
    extract_effort: Effort;
    synthesize_effort: Effort;
    fallbacks: boolean;
    detail: 'low' | 'medium' | 'high';
    cite_timestamps: boolean;
    include: string[];
    exclude: string[];
    context?: string;
    chunk_minutes: number;
    prompts_dir?: string;
  };
}

export interface ConfigState {
  path: string;
  exists: boolean;
  yaml: string;
  config: Config | null;
  error: string | null;
}

export interface FieldError {
  path: string;
  message: string;
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  stoppedAt?: number;
  channelName?: string;
  guildName?: string;
  source?: string;
  interrupted?: boolean;
  speakers: string[];
  utterances: number;
  has: { audio: boolean; transcript: boolean; speakerLabels: boolean; summary: boolean };
}

export interface TranscriptLine {
  userId: string;
  speaker: string;
  offsetMs: number;
  startMs: number;
  endMs: number;
  text: string;
  inferred?: { account: string; confidence: 'high' | 'low' | 'unclear' };
}

export type JobStep = 'transcribe' | 'merge' | 'disambiguate' | 'summarize';
export interface Job {
  id: string;
  sessionId: string;
  step: JobStep;
  force: boolean;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  logs: string[];
  error?: string;
}

export interface SummaryMeta {
  generatedAt: string;
  requestedModel: string;
  modelsUsed: string[];
  items: number;
  chunks: number;
  usage: Record<string, { inputTokens: number; outputTokens: number }>;
  speakerLabels?: { labelled: number; confident: number; guessed: number; unclear: number };
}

export interface SessionDetail extends SessionSummary {
  participants: Record<string, { displayName: string; username?: string }>;
  lines: TranscriptLine[];
  speakerLines: TranscriptLine[] | null;
  summary: string | null;
  summaryMeta: SummaryMeta | null;
  jobs: Job[];
}

export interface Person {
  id: string;
  names: string[];
  sessions: number;
  lastSeen: number;
}

export interface PromptInfo {
  name: 'extract' | 'synthesize' | 'disambiguate';
  placeholders: string[];
  builtIn: string;
  custom: string | null;
}

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

export interface GuildInfo {
  id: string;
  name: string;
  channels: { id: string; name: string; members: { id: string; name: string; bot: boolean }[] }[];
}

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
