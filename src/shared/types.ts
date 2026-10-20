/**
 * The JSON shapes the API sends and receives. Type-only and free of Node imports, so the web UI
 * (web/src/types.ts) imports these same definitions instead of keeping copies.
 */
import type { Config } from '../config/schema.js';

export type { Config };

// --- Sessions and transcripts --------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  startedAt: number;
  stoppedAt?: number;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  /** Set when the audio was deleted under recording.audio_retention_days (the text is kept). */
  audioDeletedAt?: number;
}

export interface Participant {
  displayName: string;
  username?: string;
}

export interface TranscriptLine {
  userId: string;
  speaker: string;
  /** Milliseconds from session start. */
  offsetMs: number;
  startMs: number;
  endMs: number;
  text: string;
  /** The real name of whoever spoke, when `speaker` is their character's name (campaign sessions). */
  player?: string;
  /**
   * Set when the speaker was inferred by the disambiguation pass for a shared account:
   * `account` is the account's own name, `confidence` how sure Claude was.
   */
  inferred?: { account: string; confidence: 'high' | 'low' | 'unclear' };
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  stoppedAt?: number;
  channelName?: string;
  guildName?: string;
  source?: string;
  /** Closed by crash recovery rather than a normal stop. */
  interrupted?: boolean;
  /** When the audio was deleted under recording.audio_retention_days. */
  audioDeletedAt?: number;
  speakers: string[];
  utterances: number;
  has: { audio: boolean; transcript: boolean; speakerLabels: boolean; summary: boolean };
}

export interface SessionDetail extends SessionSummary {
  participants: Record<string, Participant>;
  lines: TranscriptLine[];
  speakerLines: TranscriptLine[] | null;
  summary: string | null;
  summaryMeta: SummaryMeta | null;
  /** Whether the recap is as generated or was edited by hand, and when. */
  recapState: RecapState | null;
  editedAt: string | null;
  /** People to pair (still unpaired under the current roster, not dismissed). */
  unpaired: UnpairedSpeaker[];
}

/** GET /sessions/:id also lists the session's jobs. */
export type SessionDetailWithJobs = SessionDetail & { jobs: Job[] };

export interface Person {
  id: string;
  names: string[];
  sessions: number;
  lastSeen: number;
}

/**
 * Someone who spoke in a campaign session without being on its roster (or its guests). The guess
 * comes from the clean-up pass when it ran.
 */
export interface UnpairedSpeaker {
  userId: string;
  /** Their name as the transcript shows it. */
  name: string;
  role?: 'new_player' | 'guest';
  /** The character they seem to play, when the transcript says. */
  character?: string;
  /** The line that shows it, HH:MM:SS. */
  time?: string;
  /** Set when "Ignore" was pressed for this session. */
  dismissed?: boolean;
}

// --- The recap -----------------------------------------------------------------------------------

export type RecapState = 'generated' | 'edited';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** How the completeness check's findings were added: by Claude's revision, appended, or not at all. */
export type RecapAuditApplied = 'none' | 'revised' | 'appended';

export interface SummaryMeta {
  generatedAt: string;
  requestedModel: string;
  modelsUsed: string[];
  promptVersions: Record<string, string>;
  configHash: string;
  detail: string;
  chunks: number;
  chunksFromCache: number;
  /** Total notes extracted, all kinds. */
  items: number;
  /** Missing in recaps written before the recap format. */
  notes?: { npcs: number; locations: number; events: number; combats: number; items: number };
  kills?: [string, number][];
  usage: { extract: Usage; synthesize: Usage; disambiguate?: Usage; cleanup?: Usage; audit?: Usage; revise?: Usage };
  /** Present when shared accounts were relabelled before the recap. */
  speakerLabels?: { labelled: number; confident: number; guessed: number; unclear: number };
  cleanup?: { edited: number; dropped: number; reverted?: number };
  recapAudit?: { missing: number; applied: RecapAuditApplied };
  /** Where a hand-edited recap was moved before this one replaced it. */
  editedBackup?: string;
}

export type PromptName = 'disambiguate' | 'cleanup' | 'extract' | 'synthesize' | 'audit' | 'revise';

export interface PromptInfo {
  name: PromptName;
  placeholders: string[];
  builtIn: string;
  custom: string | null;
}

// --- Jobs ----------------------------------------------------------------------------------------

export type JobStep = 'transcribe' | 'merge' | 'disambiguate' | 'summarize';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  sessionId: string;
  step: JobStep;
  force: boolean;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  logs: string[];
  error?: string;
  /** Runs only if this earlier job succeeded (e.g. the recap after transcription). */
  after?: string;
}

// --- Config --------------------------------------------------------------------------------------

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

// --- The bot -------------------------------------------------------------------------------------

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

// --- Music ---------------------------------------------------------------------------------------

/** A browser tab in the Mac app whose audio is played into the voice channel. */
export interface MusicTab {
  id: string;
  title: string;
  url: string;
  /** 0–1. */
  volume: number;
  muted: boolean;
  /** Making sound right now. */
  audible: boolean;
  /** The tab shown in the Music page's browser. */
  active: boolean;
}

export interface MusicStatus {
  /** Only the Mac app has the built-in browser; `npm run app` reports false. */
  available: boolean;
  /** The bot is in a voice channel, so the music is heard there. */
  inChannel: boolean;
  /** 0–1, applied to the whole mix. */
  master: number;
  /** Also play the mix on this Mac (capturing a tab silences it locally otherwise). */
  monitor: boolean;
  tabs: MusicTab[];
}
