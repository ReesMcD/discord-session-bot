import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from '../session/layout.js';
import type { RecapState } from '../shared/types.js';

export const recapPaths = {
  markdown: (s: string) => join(s, 'summary.md'),
  /** The generated recap, kept once it has been edited. */
  generated: (s: string) => join(s, 'summary', 'generated.md'),
  editState: (s: string) => join(s, 'summary', 'edit.json'),
  editedBackup: (s: string, at: Date) => join(s, 'summary', `edited-${at.toISOString().replace(/[:.]/g, '-')}.md`),
};

export interface EditState {
  editedAt: string;
}

export type { RecapState };

export function recapState(sessionDir: string): RecapState | null {
  if (!existsSync(recapPaths.markdown(sessionDir))) return null;
  return existsSync(recapPaths.editState(sessionDir)) ? 'edited' : 'generated';
}

export function readEditState(sessionDir: string): EditState | null {
  return readJson<EditState>(recapPaths.editState(sessionDir)) ?? null;
}

/** Saves a hand-edited recap. The first edit keeps the generated version at summary/generated.md. */
export function saveRecapEdit(sessionDir: string, markdown: string, now = new Date()): EditState {
  const file = recapPaths.markdown(sessionDir);
  if (!existsSync(file)) throw new Error('This session has no recap to edit yet');
  if (!markdown.trim()) throw new Error('The recap is empty');
  if (recapState(sessionDir) === 'generated') {
    mkdirSync(dirname(recapPaths.generated(sessionDir)), { recursive: true });
    copyFileSync(file, recapPaths.generated(sessionDir));
  }
  writeFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  const state: EditState = { editedAt: now.toISOString() };
  writeJson(recapPaths.editState(sessionDir), state);
  return state;
}

/**
 * Writes a newly generated recap. If the current one was edited by hand, it's moved to
 * summary/edited-<time>.md first, so regenerating never loses edits. Returns that backup's path.
 */
export function writeGeneratedRecap(sessionDir: string, markdown: string, now = new Date()): string | undefined {
  const file = recapPaths.markdown(sessionDir);
  let backup: string | undefined;
  if (recapState(sessionDir) === 'edited') {
    backup = recapPaths.editedBackup(sessionDir, now);
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(file, backup);
  }
  rmSync(recapPaths.editState(sessionDir), { force: true });
  rmSync(recapPaths.generated(sessionDir), { force: true });
  writeFileSync(file, markdown);
  return backup;
}

export function readRecap(sessionDir: string): string | null {
  const file = recapPaths.markdown(sessionDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
