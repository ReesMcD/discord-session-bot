import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump when the built-in templates change meaningfully; recorded in each summary's metadata. */
export const PROMPT_VERSION = 'v1';

const BUILT_IN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export type PromptName = 'extract' | 'synthesize';

export interface Template {
  name: PromptName;
  /** "v1" for built-ins, or the override file path. */
  version: string;
  text: string;
  /** sha256 of the template text, so a tweaked override is traceable. */
  hash: string;
}

/** Loads a prompt template: `<overrideDir>/<name>.md` if present, else the built-in versioned file. */
export function loadTemplate(name: PromptName, overrideDir?: string): Template {
  const override = overrideDir ? join(resolve(overrideDir), `${name}.md`) : undefined;
  const file = override && existsSync(override) ? override : join(BUILT_IN_DIR, `${name}.${PROMPT_VERSION}.md`);
  const text = readFileSync(file, 'utf8');
  return { name, version: file === override ? `custom:${override}` : PROMPT_VERSION, text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

/** Replaces {{name}} placeholders. Unknown placeholders are an error, so typos in custom templates surface. */
export function render(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt template uses unknown placeholder {{${key}}}`);
    return vars[key]!;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
