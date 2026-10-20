import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJson, writeJson, type SessionInfo } from './layout.js';

const DAY_MS = 86_400_000;

/**
 * Deletes the audio of sessions that were transcribed and stopped more than `days` ago (0 = keep
 * forever). Transcripts, recaps and everything else stay. Returns the ids that were pruned.
 */
export function pruneOldAudio(dataDir: string, days: number, now = Date.now()): string[] {
  const root = join(dataDir, 'sessions');
  if (days <= 0 || !existsSync(root)) return [];
  const pruned: string[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const info = readJson<SessionInfo>(paths.session(dir));
    const hasAudio = existsSync(paths.audioDir(dir)) || existsSync(paths.batchesDir(dir));
    if (!info?.stoppedAt || !hasAudio || !existsSync(paths.segments(dir))) continue;
    if (now - info.stoppedAt < days * DAY_MS) continue;
    rmSync(paths.audioDir(dir), { recursive: true, force: true });
    rmSync(paths.batchesDir(dir), { recursive: true, force: true });
    writeJson(paths.session(dir), { ...info, audioDeletedAt: now });
    pruned.push(id);
  }
  return pruned;
}
