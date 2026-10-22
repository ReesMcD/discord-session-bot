import { z } from 'zod';
import { ROSTER_ID_RE } from '../shared/ids.js';
import { migrateRoster } from './migrate.js';

const snowflake = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z.string().regex(/^\d{15,22}$/, 'must be a Discord ID (15–22 digits)'),
);

const dndbeyondId = z.number().int().positive();
const rosterKey = z.string().regex(ROSTER_ID_RE, 'must be lowercase letters, digits and dashes, starting with a letter');

/** Someone who talks in sessions: a real person, named as they should appear in transcripts. */
const speaker = z
  .object({
    name: z.string().min(1),
    /**
     * The Discord accounts they talk on. Several speakers on one account (a shared mic): Claude
     * labels each of its lines with the right speaker before the recap.
     */
    discord: z.array(snowflake).default([]),
    /** e.g. "DM, narrates the world and voices NPCs": helps Claude tell speakers on a shared mic apart. */
    description: z.string().min(1).optional(),
  })
  .strict();

const campaign = z
  .object({
    name: z.string().min(1),
    /** Background for this campaign, added to the prompts after summary.context. */
    context: z.string().optional(),
    /** The campaign's D&D Beyond ID, from its URL. */
    dndbeyond: dndbeyondId.optional(),
    /** Voice channels where a recording belongs to this campaign unless another one is picked. */
    channels: z.array(snowflake).default([]),
  })
  .strict();

const character = z
  .object({
    name: z.string().min(1),
    /** e.g. "dwarf fighter 5": a hint for Claude, shown next to the name. */
    description: z.string().min(1).optional(),
    /** The character's D&D Beyond ID, from its sheet's URL. */
    dndbeyond: dndbeyondId.optional(),
    /** The campaign they're in (an ID under `campaigns`). */
    campaign: rosterKey.optional(),
    /** Who plays them (an ID under `speakers`). */
    speaker: rosterKey.optional(),
  })
  .strict();

/** The settings without reading older files (use configSchema to parse). */
export const configObject = z
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

    /** Who talks in sessions, and on which Discord accounts. */
    speakers: z.record(rosterKey, speaker).default({}),

    /** The campaigns you run. */
    campaigns: z.record(rosterKey, campaign).default({}),

    /** Player characters, each in a campaign and played by a speaker. */
    characters: z.record(rosterKey, character).default({}),

    sessions: z
      .object({
        /**
         * How sessions are named unless renamed by hand: {campaign} (or #channel without one),
         * {channel}, {date} ("Oct 22, 2026") and {time} ("7:02 PM"), in transcript.timezone.
         */
        title: z
          .string()
          .min(1)
          .max(120)
          .refine((t) => (t.match(/\{[^}]*\}/g) ?? []).every((p) => ['{campaign}', '{channel}', '{date}', '{time}'].includes(p)), 'use only {campaign}, {channel}, {date} and {time}')
          .default('{campaign} — {date}'),
      })
      .strict()
      .prefault({}),

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
        /** Also transcribe while recording, so lines show up in the app during the call (a preview: costs a second pass). */
        live: z.boolean().default(false),
      })
      .strict()
      .default({ provider: 'groq', batch_minutes: 10, concurrency: 2, min_utterance_ms: 400, live: false }),

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
        /**
         * Extra recap sections after NPCs, Locations, What happened and Combat: each rule becomes a
         * section, in this order.
         */
        include: z.array(z.string().min(1)).default(['Loot, rewards and purchases', 'Quests, hooks and open threads']),
        /** What to leave out even if it matches an include rule. */
        exclude: z.array(z.string().min(1)).default([]),
        /** Background Claude should know: what these calls are, who people are, recurring names. */
        context: z.string().optional(),
        /** Claude fixes misheard words and drops filler before the recap is written. */
        cleanup: z.boolean().default(true),
        /** Reverts clean-up edits that changed a line too much or dropped real content. No API calls. */
        cleanup_audit: z.boolean().default(true),
        /** Claude re-reads the transcript against the recap and adds anything it missed. */
        recap_audit: z.boolean().default(true),
        /** Transcript is processed in chunks of this many minutes. */
        chunk_minutes: z.number().min(5).max(60).default(20),
        /** Folder with prompt templates overriding the built-in ones (extract.md, synthesize.md, cleanup.md, audit.md, revise.md, disambiguate.md). */
        prompts_dir: z.string().optional(),
      })
      .strict()
      .prefault({}),

    /**
     * Sends the recap to your wiki (or anything that accepts an HTTP request). The key, if the
     * endpoint needs one, is WIKI_UPLOAD_TOKEN: in .env, or Settings → Keys in the Mac app.
     */
    upload: z
      .object({
        /** Where the recap is sent. Empty = uploading is off. */
        url: z.url({ protocol: /^https?$/ }).optional(),
        method: z.enum(['POST', 'PUT']).default('POST'),
        /**
         * json: { id, title, date, campaign, markdown, … }; markdown: the recap with YAML front matter;
         * ardent-weave: the Ardent Weave wiki's /api/sessions (a Session Recap page plus the transcript).
         */
        format: z.enum(['json', 'markdown', 'ardent-weave']).default('json'),
        /** bearer: "Authorization: Bearer <key>"; header: "<header_name>: <key>"; none: no key. */
        auth: z.enum(['bearer', 'header', 'none']).default('bearer'),
        header_name: z.string().regex(/^[A-Za-z0-9-]+$/, 'letters, digits and dashes only').default('X-Api-Key'),
        /** Upload as soon as a recording's recap is written. Off: review and edit it first. */
        auto: z.boolean().default(false),
      })
      .strict()
      .prefault({}),

    /**
     * The players' join link (#47). Scrying Eye serves only the player page on this port, on this
     * Mac alone (127.0.0.1); Tailscale Funnel makes it public: `tailscale funnel --bg <port>`.
     */
    players: z
      .object({
        /** The public address Funnel gives this Mac, e.g. https://my-mac.tail1234.ts.net. */
        public_url: z.url({ protocol: /^https$/ }).optional(),
        port: z.number().int().min(1024).max(65535).default(4410),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [id, ch] of Object.entries(c.characters)) {
      if (ch.campaign && !c.campaigns[ch.campaign]) ctx.addIssue({ code: 'custom', path: ['characters', id, 'campaign'], message: `no campaign "${ch.campaign}"` });
      if (ch.speaker && !c.speakers[ch.speaker]) ctx.addIssue({ code: 'custom', path: ['characters', id, 'speaker'], message: `no speaker "${ch.speaker}"` });
    }
    const owner = new Map<string, string>();
    for (const [id, k] of Object.entries(c.campaigns)) {
      for (const channel of k.channels) {
        const other = owner.get(channel);
        if (other) ctx.addIssue({ code: 'custom', path: ['campaigns', id, 'channels'], message: `channel ${channel} is already the default for "${c.campaigns[other]!.name}"` });
        owner.set(channel, id);
      }
    }
  });

/** config.yaml: older files (speakers keyed by Discord ID, campaigns by voice channel) are read in the new shape. */
export const configSchema = z.preprocess(migrateRoster, configObject);

export type Config = z.infer<typeof configSchema>;

/**
 * Zod reports a bad map key (speakers, campaigns, characters) as "Invalid key in record" and hides
 * our message; put the key and the reason back. Mutates and returns the error.
 */
export function explainKeyErrors(error: z.ZodError): z.ZodError {
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_key') continue;
    const key = String(issue.path.at(-1));
    (issue as { message: string }).message = `"${key}" ${issue.issues[0]?.message ?? 'is not a valid key'}`; // issues are plain objects; the type is read-only
  }
  return error;
}
