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
  /** A name given by hand; otherwise sessions.title makes one. */
  title?: string;
  /** The campaign picked for this session (its key in `campaigns`); wins over the voice channel's. */
  campaign?: string;
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
  /** Its name: given by hand, or from the sessions.title template. */
  title: string;
  /** True when the name was given by hand. */
  customTitle: boolean;
  /** The campaign it belongs to (key and name), picked or from its voice channel. */
  campaign: { key: string; name: string | null; picked: boolean } | null;
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
  /** The last upload to the wiki, if any. */
  upload: RecapUpload | null;
  /** The host the recap would be uploaded to (Settings → Upload), or null when uploading is off. */
  uploadTo: string | null;
}

/** When the recap was last uploaded, and whether it was edited since. */
export interface RecapUpload {
  uploadedAt: string;
  /** The wiki page, if the endpoint returned one. */
  url?: string;
  changedSince: boolean;
}

/** POST /upload/test */
export interface UploadTestResult {
  ok: boolean;
  status?: number;
  message: string;
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

export type JobStep = 'transcribe' | 'merge' | 'disambiguate' | 'summarize' | 'upload';
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
  /** Set when the live transcript is on for this recording. */
  live?: boolean;
}

/** The "live" event: only the lines added since the last one (GET /bot/live has them all). */
export interface LiveUpdate {
  sessionId: string;
  added: TranscriptLine[];
  error?: string;
}

/** GET /bot/live: lines transcribed during the recording. */
export interface LiveTranscript {
  lines: TranscriptLine[];
  /** The last batch that failed, if the latest one did. */
  error?: string;
}

export interface BotStatus {
  state: 'off' | 'connecting' | 'ready' | 'error';
  user?: string;
  error?: string;
  recording: RecordingStatus | null;
  /**
   * Slash commands: registered in every server, or a server refused them because the bot was added
   * without the applications.commands scope; `inviteUrl` re-adds it with everything it needs.
   */
  commands?: 'ready' | 'needs-invite';
  inviteUrl?: string;
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

/** A saved set of tabs to switch to, crossfading. */
export interface MusicScene {
  id: string;
  name: string;
  tabs: { url: string; volume: number }[];
}

/** A soundboard effect: an audio file in <data>/music/sounds/, played once over the music. */
export interface MusicSound {
  id: string;
  name: string;
  volume: number;
  file: string;
}

export interface MusicLibraryState {
  scenes: MusicScene[];
  sounds: MusicSound[];
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
  /** Soundboard effects playing now (their IDs). */
  playingSounds: string[];
}

// --- Encounters ----------------------------------------------------------------------------------

/** The 2024 conditions (Exhaustion has levels). */
export type ConditionName =
  | 'Blinded'
  | 'Charmed'
  | 'Deafened'
  | 'Exhaustion'
  | 'Frightened'
  | 'Grappled'
  | 'Incapacitated'
  | 'Invisible'
  | 'Paralyzed'
  | 'Petrified'
  | 'Poisoned'
  | 'Prone'
  | 'Restrained'
  | 'Stunned'
  | 'Unconscious';

export interface Condition {
  name: ConditionName;
  /** Exhaustion only: 1–6. */
  level?: number;
  /** Rounds left. Absent: until removed. */
  rounds?: number;
  /** When `rounds` counts down: at the start or end of this combatant's turn (often the caster's). */
  tick?: { on: 'start' | 'end'; of: string };
}

export type CombatantKind = 'pc' | 'monster' | 'npc';

export interface Combatant {
  id: string;
  name: string;
  kind: CombatantKind;
  /** Null until rolled or typed in. */
  initiative: number | null;
  initiativeBonus: number;
  /** Dexterity score: breaks initiative ties. */
  dex: number | null;
  ac: number | null;
  hp: number | null;
  maxHp: number | null;
  tempHp: number;
  conditions: Condition[];
  /** The spell being concentrated on, if any. */
  concentrating: string | null;
  /** Set when damage calls for a Concentration save: its DC. Cleared when the DM records the result. */
  concentrationCheck: number | null;
  /** Hidden from players until revealed (an ambusher). */
  hidden: boolean;
  /** Monsters: the stat block's name (Bestiary page or SRD). */
  ref?: string;
  /** The battle map token this combatant moves. */
  tokenId?: string;
  /** PCs: who plays them. */
  player?: string | null;
}

/** A monster's numbers from the wiki, for the stat block view. */
export interface EncounterStatBlock {
  name: string;
  source: 'bestiary' | 'srd' | 'unknown';
  cr?: string;
  xp?: number;
  size?: string;
  type?: string;
  ac?: number;
  hp?: number;
  hit_dice?: string;
  speed?: Record<string, number | boolean>;
  initiative?: number;
  abilities?: number[];
  senses?: string;
  languages?: string;
  resistances?: string;
  immunities?: string;
  traits?: Array<{ name: string; desc: string }>;
  actions?: Array<{ name: string; kind: string; desc: string }>;
  stat_block?: string;
}

/** An encounter in the wiki's list (ReesMcD/dnd-wiki, GET /api/encounters). */
export interface WikiEncounterSummary {
  id: string;
  title: string;
  campaign: string;
  place: string | null;
  difficulty: string | null;
  party_level: number | null;
  xp: number | null;
  status: string;
  run: boolean;
  updated: string | null;
}

/** One encounter from the wiki, ready to run (GET /api/encounters/<id>). */
export interface WikiEncounter extends WikiEncounterSummary {
  summary: string | null;
  read_aloud: string | null;
  setup: string | null;
  tactics: string | null;
  changes: string | null;
  treasure: string | null;
  creatures: Array<EncounterStatBlock & { count: number }>;
  /** The battle map, in the wiki's docs/battlemap.md format (v1). */
  map: Record<string, unknown> | null;
  map_error?: string;
  party: Array<{ name: string; player: string | null; level: number | null; class: string | null; race: string | null; ac: number | null; hp: number | null; passive_perception: number | null }>;
}

export interface EncounterLogEntry {
  at: number;
  round: number;
  text: string;
}

export interface EncounterState {
  id: string;
  title: string;
  /** setup: adding combatants and initiative; running: turns; ended: over. */
  status: 'setup' | 'running' | 'ended';
  round: number;
  /** Whose turn it is (a combatant id), while running. */
  turn: string | null;
  /** Combatant ids in turn order. */
  order: string[];
  combatants: Combatant[];
  /** Where it came from, when loaded from the wiki. */
  source?: { wikiId: string; campaign: string };
  /** DM text from the wiki: read-aloud, setup, tactics, treasure. */
  notes?: Pick<WikiEncounter, 'summary' | 'read_aloud' | 'setup' | 'tactics' | 'changes' | 'treasure'>;
  statBlocks: Record<string, EncounterStatBlock>;
  map: Record<string, unknown> | null;
  startedAt: number;
  endedAt?: number;
  log: EncounterLogEntry[];
  /** The players' join link (its secret code) and who has joined. */
  join?: { code: string; players: JoinedPlayer[] };
}

/** A device that joined through the link. Only a hash of its token is kept. */
export interface JoinedPlayer {
  tokenHash: string;
  /** The PC they play, or null for a guest who watches. */
  combatantId: string | null;
  joinedAt: number;
}

/** What happened, kept when an encounter ends. */
export interface EncounterOutcome {
  id: string;
  title: string;
  rounds: number;
  startedAt: number;
  endedAt: number;
  /** Monsters and NPCs at 0 HP. */
  defeated: string[];
  /** PCs at 0 HP or unconscious. */
  downed: string[];
  /** Monsters and NPCs still standing. */
  standing: string[];
  text: string;
}

/** Changes to a running encounter, sent by the DM's views. */
export type EncounterAction =
  | { type: 'add'; combatant: { name: string; kind?: CombatantKind; ac?: number | null; hp?: number | null; initiativeBonus?: number; dex?: number | null; hidden?: boolean; ref?: string; count?: number } }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; name?: string; ac?: number | null; hp?: number | null; maxHp?: number | null }
  | { type: 'initiative'; id: string; value: number | null }
  | { type: 'rollInitiative'; ids?: string[] }
  | { type: 'reorder'; order: string[] }
  | { type: 'begin' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'damage'; id: string; amount: number }
  | { type: 'heal'; id: string; amount: number }
  | { type: 'tempHp'; id: string; amount: number }
  | { type: 'condition'; id: string; name: ConditionName; remove?: boolean; level?: number; rounds?: number; tick?: { on: 'start' | 'end'; of: string } }
  | { type: 'concentrate'; id: string; spell: string | null }
  | { type: 'concentrationResult'; id: string; kept: boolean }
  | { type: 'reveal'; id: string; hidden?: boolean };

// --- The player view (the public join link) ------------------------------------------------------

/** How a monster or NPC looks to players: never its numbers. */
export type Health = 'healthy' | 'bloodied' | 'down';

export interface PlayerCombatant {
  id: string;
  name: string;
  kind: CombatantKind;
  current: boolean;
  /** The PCs' numbers; null for monsters and NPCs. */
  hp: number | null;
  maxHp: number | null;
  tempHp: number;
  /** Monsters and NPCs: how hurt they look. */
  health: Health | null;
  conditions: Condition[];
  concentrating: string | null;
}

/** What one player's device gets: no hidden combatants, no monster numbers, no DM notes. */
export interface PlayerView {
  title: string;
  status: EncounterState['status'];
  round: number;
  /** Whose turn it is, when that combatant is visible. */
  turn: string | null;
  /** The PC this device plays, or null for a guest. */
  me: string | null;
  order: PlayerCombatant[];
  /** For the join screen: the PCs, and whether a device already plays each. */
  party: Array<{ id: string; name: string; taken: boolean }>;
  /** My own initiative, while the DM is collecting them. */
  myInitiative: number | null;
  /** My AC (only mine). */
  myAc: number | null;
}

/** What a player may change, and only on their own PC. */
export type PlayerRequest =
  | { type: 'initiative'; value: number }
  | { type: 'damage' | 'heal' | 'tempHp'; amount: number }
  | { type: 'condition'; name: ConditionName; remove?: boolean };

/** GET /encounter/link: where players join. */
export interface JoinLink {
  /** The public link (Tailscale Funnel), when players.public_url is set. */
  url: string | null;
  /** The same page on this Mac, for trying it out. */
  local: string | null;
  publicUrlSet: boolean;
}
