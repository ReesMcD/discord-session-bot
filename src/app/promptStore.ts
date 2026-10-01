import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTemplate, render, type PromptName } from '../summary/prompts.js';

export const PROMPT_NAMES: PromptName[] = ['extract', 'synthesize', 'disambiguate'];

/** The placeholders the code fills in for each prompt; a custom template may only use these. */
export const PLACEHOLDERS: Record<PromptName, string[]> = {
  extract: ['context', 'include_rules', 'exclude_rules'],
  synthesize: ['context', 'include_rules', 'exclude_rules', 'detail', 'detail_guidance', 'citation_guidance'],
  disambiguate: ['context', 'accounts'],
};

/** Where app-edited prompts go when config.yaml doesn't name a folder (git-ignored). */
export const DEFAULT_PROMPTS_DIR = 'prompts.local';

export interface PromptInfo {
  name: PromptName;
  placeholders: string[];
  builtIn: string;
  custom: string | null;
}

export function readPrompts(promptsDir: string | undefined): PromptInfo[] {
  return PROMPT_NAMES.map((name) => {
    const file = promptsDir ? join(resolve(promptsDir), `${name}.md`) : undefined;
    return {
      name,
      placeholders: PLACEHOLDERS[name],
      builtIn: loadTemplate(name).text,
      custom: file && existsSync(file) ? readFileSync(file, 'utf8') : null,
    };
  });
}

/** Checks a template only uses known placeholders. Returns an error message or undefined. */
export function checkTemplate(name: PromptName, text: string): string | undefined {
  if (!text.trim()) return 'The prompt is empty';
  const vars = Object.fromEntries(PLACEHOLDERS[name].map((k) => [k, '']));
  try {
    render(text, vars);
    return undefined;
  } catch (err) {
    return `${(err as Error).message}. Available: ${PLACEHOLDERS[name].map((p) => `{{${p}}}`).join(', ')}`;
  }
}

export function writePrompt(promptsDir: string, name: PromptName, text: string): void {
  mkdirSync(resolve(promptsDir), { recursive: true });
  writeFileSync(join(resolve(promptsDir), `${name}.md`), text.endsWith('\n') ? text : `${text}\n`);
}

export function deletePrompt(promptsDir: string, name: PromptName): void {
  rmSync(join(resolve(promptsDir), `${name}.md`), { force: true });
}
