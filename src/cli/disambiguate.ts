/**
 * npm run disambiguate -- <sessionDir|sessionId> [--force]
 *
 * Runs only the speaker-labelling pass for shared accounts (speakers.<id>.disambiguate in
 * config.yaml) and writes transcript.speakers.md, so you can check the labels before
 * summarizing. `npm run summarize` runs this pass automatically.
 */
import Anthropic from '@anthropic-ai/sdk';
import { sharedAccounts } from '../config/roster.js';
import { setup, resolveSessionDir, die } from './common.js';
import { AnthropicSummaryModel, SummaryError } from '../summary/model.js';
import { disambiguateSession } from '../summary/disambiguate.js';

const { config } = setup();
const sessionDir = resolveSessionDir(process.argv[2], 'Usage: npm run disambiguate -- <sessionDir|sessionId> [--force]');
if (sharedAccounts(config).size === 0) die('No shared mics: list the same Discord account under two or more speakers in config.yaml (see README → Shared mics)');
if (!process.env.ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY is not set (add it to .env)');

try {
  const r = await disambiguateSession(sessionDir, config, new AnthropicSummaryModel({ fallbacks: config.summary.fallbacks }), {
    force: process.argv.includes('--force'),
  });
  if (!r.file) die('None of the shared accounts in config.yaml speak in this session');
  const st = r.stats;
  console.log(`${st.labelled} lines labelled: ${st.confident} confident, ${st.guessed} guessed (?), ${st.unclear} unclear`);
  console.log(`Transcript: ${r.file}`);
  console.log(`Tokens in/out: ${r.usage.inputTokens}/${r.usage.outputTokens} (${r.chunksFromCache}/${r.chunks} chunks cached)`);
} catch (err) {
  if (err instanceof SummaryError) die(err.message);
  if (err instanceof Anthropic.APIError) die(`Anthropic API error ${err.status}: ${err.message}`);
  throw err;
}
