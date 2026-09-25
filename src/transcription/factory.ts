import type { Config } from '../config/schema.js';
import { OpenAICompatibleTranscriber, PROVIDERS } from './openaiCompatible.js';
import type { Transcriber } from './types.js';

/** Builds the configured transcriber. API keys come from the environment, never the config file. */
export function createTranscriber(config: Config['transcription'], env: NodeJS.ProcessEnv = process.env): Transcriber {
  const provider = PROVIDERS[config.provider];
  const apiKey = env.TRANSCRIBE_API_KEY || env[provider.keyEnv];
  if (!apiKey) throw new Error(`No API key for ${config.provider}: set TRANSCRIBE_API_KEY (or ${provider.keyEnv}) in .env`);
  return new OpenAICompatibleTranscriber({
    provider: config.provider,
    apiKey,
    ...(config.model ? { model: config.model } : {}),
    ...(config.base_url ? { baseUrl: config.base_url } : {}),
  });
}
