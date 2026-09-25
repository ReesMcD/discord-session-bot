import { z } from 'zod';

const snowflake = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z.string().regex(/^\d{15,22}$/, 'must be a Discord ID (15–22 digits)'),
);

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
      })
      .strict()
      .default({ ignore_users: [], ignore_bots: true, silence_ms: 1000, audio_retention_days: 30 }),

    /** Discord user ID → name to use in transcripts. Falls back to the Discord display name. */
    speakers: z.record(snowflake, z.string().min(1)).default({}),

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
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
