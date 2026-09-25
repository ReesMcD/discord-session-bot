/** npm run transcribe -- <sessionDir|sessionId> [--no-merge] [--summarize] */
import { setup, resolveSessionDir, die } from './common.js';
import { createTranscriber } from '../transcription/factory.js';
import { transcribeSession } from '../transcription/transcribeSession.js';
import { mergeSession } from '../transcript/merge.js';
import { runSummaryStep } from './summaryStep.js';

const loaded = setup();
const { config } = loaded;
const sessionDir = resolveSessionDir(process.argv[2], 'Usage: npm run transcribe -- <sessionDir|sessionId> [--no-merge] [--summarize]');
let transcriber;
try {
  transcriber = createTranscriber(config.transcription);
} catch (err) {
  die((err as Error).message);
}
console.log(`Transcribing ${sessionDir} with ${transcriber.id}`);
const stats = await transcribeSession(sessionDir, config.transcription, transcriber);
console.log(
  `Done: ${stats.segments} segments from ${stats.speakers} speakers (${stats.batches} batches, ${stats.batchesFromCache} cached, ${stats.dropped} dropped as likely hallucinations)`,
);
if (!process.argv.includes('--no-merge')) {
  const merged = mergeSession(sessionDir, config);
  console.log(`Transcript: ${merged.file} (${merged.lines} lines)`);
  if (process.argv.includes('--summarize') && !(await runSummaryStep(sessionDir, loaded))) process.exit(1);
}
