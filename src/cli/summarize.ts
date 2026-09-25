/**
 * npm run summarize -- <sessionDir|sessionId> [--force]
 *
 * Summarizes a transcribed session with Claude using the rules in config.yaml. Re-run any time
 * after editing the rules; unchanged chunks are reused. --force re-extracts every chunk.
 */
import { setup, resolveSessionDir } from './common.js';
import { runSummaryStep } from './summaryStep.js';

const loaded = setup();
const sessionDir = resolveSessionDir(process.argv[2], 'Usage: npm run summarize -- <sessionDir|sessionId> [--force]');
if (!(await runSummaryStep(sessionDir, loaded, process.argv.includes('--force')))) process.exit(1);
