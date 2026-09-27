import { z } from 'zod';

const snowflake = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z.string().regex(/^\d{15,22}$/, 'must be a Discord ID (15–22 digits)'),
);

const sharedSpeaker = z
  .object({
    name: z.string().min(1).optional(),
    /**
     * The people/roles who talk on this account, e.g. "DM — narrates the world and NPCs". The text
     * before " — ", " – ", " - " or ":" is the label used in transcripts; the rest is a hint for Claude.
     */
    disambiguate: z.array(z.string().min(1)).min(2, 'list at least two identities to choose between').optional(),
  })
  .strict();

export const configSchema = z
  .object({
    recording: z
      .object({
        /** User IDs never to subscribe to (e.g. a music bot). */
        ignore_users: z.array(snowflake).default([]),
        /** Skip every bot account. */
        ignore_bots: z.boolean().default(true),
        /** An utterance ends after this much silence. */
        silence_ms: z.number().int().min(200).max(10_000).default(1000),
        /** Delete local audio this many days after a session is processed. 0 = keep forever. */
        audio_retention_days: z.number().int().min(0).default(30),
        /** What to do automatically when a recording stops. */
        after_stop: z.enum(['nothing', 'transcribe', 'summarize']).default('transcribe'),
        /** Post "recording started/stopped" in the voice channel's chat, so everyone knows. */
        announce: z.boolean().default(true),
      })
      .strict()
      .prefault({}),

    /**
     * Discord user ID → name to use in transcripts (falls back to the Discord display name), or an
     * object for an account several people share: `{ name, disambiguate: [identities…] }`.
     */
    speakers: z.record(snowflake, z.union([z.string().min(1), sharedSpeaker])).default({}),

    transcription: z
      .object({
        provider: z.enum(['groq', 'openai']).default('groq'),
        /** Must support verbose_json timestamps (Groq: whisper-large-v3-turbo / whisper-large-v3; OpenAI: whisper-1). */
        model: z.string().optional(),
        /** Override the provider's API base URL (any OpenAI-compatible /audio/transcriptions endpoint). */
        base_url: z.url().optional(),
        /** ISO-639-1 code; omit to auto-detect. Setting it improves accuracy and speed. */
        language: z.string().length(2).optional(),
        /** Vocabulary hint: names, places, jargon Whisper should spell correctly. */
        prompt: z.string().max(800).optional(),
        /** Utterances are joined into per-speaker batches up to this long before upload (~1 MB/min as FLAC; Groq's free tier caps uploads at 25 MB). */
        batch_minutes: z.number().min(1).max(20).default(10),
        /** Parallel API requests. */
        concurrency: z.number().int().min(1).max(8).default(2),
        /** Skip utterances shorter than this (coughs, clicks; also a common source of hallucinations). */
        min_utterance_ms: z.number().int().min(0).default(400),
      })
      .strict()
      .default({ provider: 'groq', batch_minutes: 10, concurrency: 2, min_utterance_ms: 400 }),

    transcript: z
      .object({
        /** Join consecutive lines from the same speaker when the pause between them is at most this. */
        merge_gap_seconds: z.number().min(0).max(30).default(2),
        /** Never join lines into one longer than this, so timestamps stay useful. */
        max_line_seconds: z.number().min(5).max(600).default(60),
        /** IANA time zone for dates in the transcript header and session names. Defaults to the machine's. */
        timezone: z.string().optional(),
      })
      .strict()
      .default({ merge_gap_seconds: 2, max_line_seconds: 60 }),

    summary: z
      .object({
        /** Any Claude model ID. */
        model: z.string().default('claude-opus-5'),
        /** Thinking/effort for the per-chunk extraction pass and the final write-up. */
        extract_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
        synthesize_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
        /** If Claude declines a request, let the API retry it on Anthropic's recommended fallback model. */
        fallbacks: z.boolean().default(true),
        /** low = a few highlights; medium = organised notes; high = thorough, nothing relevant left out. */
        detail: z.enum(['low', 'medium', 'high']).default('medium'),
        /** Put [HH:MM:SS] references next to points in the summary. */
        cite_timestamps: z.boolean().default(true),
        /** What the summary should capture. Each rule becomes a section. */
        include: z
          .array(z.string().min(1))
          .min(1)
          .default(['Main topics discussed', 'Decisions made', 'Action items and who owns them', 'Open questions and unresolved issues']),
        /** What to leave out even if it matches an include rule. */
        exclude: z.array(z.string().min(1)).default([]),
        /** Background Claude should know: what these calls are, who people are, recurring names. */
        context: z.string().optional(),
        /** Transcript is processed in chunks of this many minutes. */
        chunk_minutes: z.number().min(5).max(60).default(20),
        /** Folder with prompt templates overriding the built-in ones (extract.md / synthesize.md / disambiguate.md). */
        prompts_dir: z.string().optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

export interface Identity {
  /** Short label used in transcripts, e.g. "DM". */
  label: string;
  /** The full hint as written in the config. */
  description: string;
}

/** Splits "DM — narrates the world" into a label ("DM") and the full description. */
export function parseIdentity(text: string): Identity {
  const m = /^(.+?)\s+[—–-]\s+|^(.+?):\s*/.exec(text);
  const label = (m?.[1] ?? m?.[2] ?? text).trim();
  return { label, description: text.trim() };
}

/** userId → transcript name, for every configured speaker that has one. */
export function speakerNames(config: Pick<Config, 'speakers'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(config.speakers)) {
    const name = typeof v === 'string' ? v : v.name;
    if (name) out[id] = name;
  }
  return out;
}

/** userId → identities, for accounts configured with `disambiguate`. */
export function sharedAccounts(config: Pick<Config, 'speakers'>): Map<string, Identity[]> {
  const out = new Map<string, Identity[]>();
  for (const [id, v] of Object.entries(config.speakers)) {
    if (typeof v !== 'string' && v.disambiguate) out.set(id, v.disambiguate.map(parseIdentity));
  }
  return out;
}
