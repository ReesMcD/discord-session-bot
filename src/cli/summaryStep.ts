import Anthropic from '@anthropic-ai/sdk';
import type { LoadedConfig } from '../config/load.js';
import { AnthropicSummaryModel, SummaryError } from '../summary/model.js';
import { summarizeSession } from '../summary/summarizeSession.js';

/** Shared by the CLIs: runs the summary step and prints a one-line result. Returns false on failure. */
export async function runSummaryStep(sessionDir: string, { config, hash }: LoadedConfig, force = false): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (add it to .env); skipping the summary');
    return false;
  }
  try {
    const { file, meta } = await summarizeSession(sessionDir, config, hash, new AnthropicSummaryModel({ fallbacks: config.summary.fallbacks }), { force });
    const u = meta.usage;
    console.log(`Summary: ${file}`);
    console.log(
      `  ${meta.modelsUsed.join(', ') || meta.requestedModel} · ${meta.items} items from ${meta.chunks} chunks (${meta.chunksFromCache} cached) · ` +
        `tokens in/out: extract ${u.extract.inputTokens}/${u.extract.outputTokens}, summary ${u.synthesize.inputTokens}/${u.synthesize.outputTokens}`,
    );
    return true;
  } catch (err) {
    if (err instanceof SummaryError) console.error(err.message);
    else if (err instanceof Anthropic.AuthenticationError) console.error('Anthropic rejected the API key (check ANTHROPIC_API_KEY)');
    else if (err instanceof Anthropic.NotFoundError) console.error(`Model not found: ${config.summary.model} (check summary.model)`);
    else if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}: ${err.message}`);
    else throw err;
    return false;
  }
}
