/**
 * npm run import:craig -- <craig-export.zip | extracted folder> [--no-transcribe] [--summarize]
 *
 * Turns a Craig multi-track recording into a session folder, then transcribes it.
 */
import { resolve } from 'node:path';
import { setup, die } from './common.js';
import { importCraig } from '../import/craig.js';
import { createTranscriber } from '../transcription/factory.js';
import { transcribeSession } from '../transcription/transcribeSession.js';
import { mergeSession } from '../transcript/merge.js';
import { runSummaryStep } from './summaryStep.js';

const loaded = setup();
const { config } = loaded;
const input = process.argv[2];
if (!input || input.startsWith('--')) die('Usage: npm run import:craig -- <craig-export.zip | folder> [--no-transcribe] [--summarize]');
const dataDir = resolve(process.env.DATA_DIR ?? './data');

let result;
try {
  result = await importCraig(resolve(input), dataDir, config);
} catch (err) {
  die((err as Error).message);
}
console.log(`Imported to ${result.sessionDir}`);

if (process.argv.includes('--no-transcribe')) {
  console.log(`Transcribe later with: npm run transcribe -- ${result.sessionId}`);
} else {
  let transcriber;
  try {
    transcriber = createTranscriber(config.transcription);
  } catch (err) {
    die(`${(err as Error).message}\nAudio is imported; run "npm run transcribe -- ${result.sessionId}" once the key is set.`);
  }
  const stats = await transcribeSession(result.sessionDir, config.transcription, transcriber);
  console.log(`Transcribed: ${stats.segments} segments (${stats.dropped} dropped as likely hallucinations)`);
  const merged = mergeSession(result.sessionDir, config);
  console.log(`Transcript: ${merged.file}`);
  if (process.argv.includes('--summarize') && !(await runSummaryStep(result.sessionDir, loaded))) process.exit(1);
}
