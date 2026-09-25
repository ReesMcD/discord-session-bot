import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from '../util/retry.js';
import type { Segment, TranscribeOptions, Transcriber, TranscriptionResult, Word } from './types.js';

export const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyEnv: 'GROQ_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', keyEnv: 'OPENAI_API_KEY' },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export interface OpenAICompatibleOptions {
  provider: ProviderName;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  retry?: RetryOptions;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface VerboseJson {
  text?: string;
  language?: string;
  segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }[];
  words?: { word: string; start: number; end: number }[];
}

const MIME: Record<string, string> = { flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm' };

/**
 * Any OpenAI-compatible `/audio/transcriptions` endpoint that supports `verbose_json` with
 * word + segment timestamps (Groq, OpenAI whisper-1, self-hosted servers).
 */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly id: string;
  private readonly url: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    const defaults = PROVIDERS[options.provider];
    this.model = options.model ?? defaults.model;
    this.url = `${(options.baseUrl ?? defaults.baseUrl).replace(/\/$/, '')}/audio/transcriptions`;
    this.id = `${options.provider}:${this.model}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async transcribe(file: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const bytes = await readFile(file);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return withRetry(async () => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: MIME[ext] ?? 'application/octet-stream' }), basename(file));
      form.append('model', this.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      form.append('temperature', '0');
      if (opts.language) form.append('language', opts.language);
      if (opts.prompt) form.append('prompt', opts.prompt);

      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 500);
        throw new HttpError(res.status, `${this.id} transcription failed (${res.status}): ${body}`, parseRetryAfter(res.headers.get('retry-after')));
      }
      return normalize((await res.json()) as VerboseJson);
    }, this.options.retry);
  }
}

export function normalize(json: VerboseJson): TranscriptionResult {
  const segments: Segment[] = (json.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    ...(s.no_speech_prob !== undefined ? { noSpeechProb: s.no_speech_prob } : {}),
    ...(s.avg_logprob !== undefined ? { avgLogprob: s.avg_logprob } : {}),
    ...(s.compression_ratio !== undefined ? { compressionRatio: s.compression_ratio } : {}),
  }));
  const words: Word[] = (json.words ?? []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
  return { text: (json.text ?? '').trim(), ...(json.language ? { language: json.language } : {}), segments, words };
}
