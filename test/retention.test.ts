import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, readJson, writeJson, type SessionInfo } from '../src/session/layout.js';
import { pruneOldAudio } from '../src/session/retention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20);

function session(root: string, id: string, opts: { stoppedDaysAgo?: number; transcribed?: boolean }) {
  const dir = join(root, 'sessions', id);
  mkdirSync(join(paths.audioDir(dir), '123456789012345678'), { recursive: true });
  writeFileSync(join(paths.audioDir(dir), '123456789012345678', '1.ogg'), 'x');
  mkdirSync(paths.batchesDir(dir), { recursive: true });
  writeJson(paths.session(dir), { id, startedAt: 0, ...(opts.stoppedDaysAgo !== undefined ? { stoppedAt: NOW - opts.stoppedDaysAgo * DAY } : {}) });
  if (opts.transcribed) writeJson(paths.segments(dir), { lines: [] });
  writeFileSync(join(dir, 'summary.md'), '# Recap');
  return dir;
}

test('deletes the audio of transcribed sessions past the retention period, keeping the text', () => {
  const root = mkdtempSync(join(tmpdir(), 'ret-'));
  const old = session(root, 'old', { stoppedDaysAgo: 31, transcribed: true });
  const recent = session(root, 'recent', { stoppedDaysAgo: 5, transcribed: true });
  const untranscribed = session(root, 'untranscribed', { stoppedDaysAgo: 90 });
  const recording = session(root, 'recording', { transcribed: true });

  assert.deepEqual(pruneOldAudio(root, 30, NOW), ['old']);
  assert.equal(existsSync(paths.audioDir(old)), false);
  assert.equal(existsSync(paths.batchesDir(old)), false);
  assert.ok(existsSync(join(old, 'summary.md')) && existsSync(paths.segments(old)));
  assert.equal(readJson<SessionInfo>(paths.session(old))!.audioDeletedAt, NOW);
  for (const kept of [recent, untranscribed, recording]) assert.ok(existsSync(paths.audioDir(kept)), kept);

  assert.deepEqual(pruneOldAudio(root, 30, NOW), [], 'already pruned');
  assert.deepEqual(pruneOldAudio(root, 0, NOW + 1000 * DAY), [], '0 keeps audio forever');
});
