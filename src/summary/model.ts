import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const extractionSchema = z.object({
  items: z.array(
    z.object({
      time: z.string().describe('Timestamp copied from the transcript, HH:MM:SS'),
      rule: z.number().int().describe('Number of the include rule this matches'),
      speakers: z.array(z.string()),
      detail: z.string(),
    }),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CallResult<T> {
  value: T;
  /** Model that actually produced the answer (differs from the requested one after a fallback). */
  model: string;
  usage: Usage;
}

export interface CallOptions {
  model: string;
  effort: Effort;
  system: string;
  user: string;
}

/** The two model calls the summarizer makes; swapped for a fake in tests. */
export interface SummaryModel {
  extract(opts: CallOptions): Promise<CallResult<Extraction>>;
  synthesize(opts: CallOptions): Promise<CallResult<string>>;
}

export class SummaryError extends Error {
  override name = 'SummaryError';
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function usageOf(u: Anthropic.Beta.BetaUsage): Usage {
  return { inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens };
}

function checkStop(msg: Anthropic.Beta.BetaMessage, step: string): void {
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details;
    throw new SummaryError(`Claude declined the ${step} step${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new SummaryError(`The ${step} step ran out of output tokens; lower summary.chunk_minutes or summary.detail`);
}

export interface AnthropicSummaryModelOptions {
  apiKey?: string;
  fallbacks: boolean;
  client?: Anthropic;
}

export class AnthropicSummaryModel implements SummaryModel {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicSummaryModelOptions) {
    // The SDK retries 408/409/429/5xx and connection errors with backoff, honouring retry-after.
    this.client = options.client ?? new Anthropic({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), maxRetries: 6 });
  }

  private fallbackParams() {
    return this.options.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {};
  }

  async extract(opts: CallOptions): Promise<CallResult<Extraction>> {
    const msg = await this.client.beta.messages.parse({
      model: opts.model,
      max_tokens: 16_000,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      output_config: { effort: opts.effort, format: betaZodOutputFormat(extractionSchema) },
      ...this.fallbackParams(),
    });
    checkStop(msg, 'extraction');
    if (!msg.parsed_output) throw new SummaryError('Extraction returned no parseable JSON');
    return { value: msg.parsed_output, model: msg.model, usage: usageOf(msg.usage) };
  }

  async synthesize(opts: CallOptions): Promise<CallResult<string>> {
    // Streamed: long outputs at high effort can exceed non-streaming HTTP timeouts.
    const msg = await this.client.beta.messages
      .stream({
        model: opts.model,
        max_tokens: 32_000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        output_config: { effort: opts.effort },
        ...this.fallbackParams(),
      })
      .finalMessage();
    checkStop(msg, 'summary');
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) throw new SummaryError('Summary step returned no text');
    return { value: text, model: msg.model, usage: usageOf(msg.usage) };
  }
}
