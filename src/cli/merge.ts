/** npm run merge -- <sessionDir|sessionId>   (re-run after changing speaker names or merge settings) */
import { setup, resolveSessionDir } from './common.js';
import { mergeSession } from '../transcript/merge.js';

const { config } = setup();
const sessionDir = resolveSessionDir(process.argv[2], 'Usage: npm run merge -- <sessionDir|sessionId>');
const merged = mergeSession(sessionDir, config);
console.log(`Transcript: ${merged.file} (${merged.lines} lines, ${merged.speakers} speakers)`);
