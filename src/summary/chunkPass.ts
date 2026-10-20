import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../session/layout.js';
import { mapLimit } from '../util/retry.js';
import type { CallOptions, CallResult, Effort, Usage } from './model.js';

interface PassCache<T> {
  key: string;
  model: string;
  value: T;
  usage: Usage;
}

export interface ChunkPassOptions<C, T> {
  chunks: readonly C[];
  model: string;
  effort: Effort;
  system: string;
  /** The user message for one chunk. */
  user: (chunk: C) => string;
  /** Where one chunk's answer is cached. */
  cacheFile: (chunk: C) => string;
  call: (opts: CallOptions) => Promise<CallResult<T>>;
  /** Called for each answer that came from the API (not the cache), e.g. to log progress. */
  onAnswer?: (chunk: C, value: T) => void;
  force?: boolean;
  concurrency?: number;
}

export interface ChunkPassResult<T> {
  /** One answer per chunk, in chunk order. */
  values: T[];
  modelsUsed: string[];
  usage: Usage;
  fromCache: number;
}

/**
 * Runs one Claude call per chunk, a few at a time, caching each answer under a key of everything
 * that shapes it (model, effort, prompts), so re-runs only pay for chunks whose inputs changed.
 */
export async function runChunkPass<C, T>(opts: ChunkPassOptions<C, T>): Promise<ChunkPassResult<T>> {
  const used = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let fromCache = 0;
  const values = await mapLimit(opts.chunks, opts.concurrency ?? 3, async (chunk) => {
    const user = opts.user(chunk);
    const key = hash(opts.model, opts.effort, opts.system, user);
    const file = opts.cacheFile(chunk);
    const cached = opts.force ? undefined : readJson<PassCache<T>>(file);
    if (cached?.key === key && cached.value !== undefined) {
      fromCache++;
      used.add(cached.model);
      return cached.value;
    }
    const r = await opts.call({ model: opts.model, effort: opts.effort, system: opts.system, user });
    writeJson(file, { key, model: r.model, value: r.value, usage: r.usage } satisfies PassCache<T>);
    used.add(r.model);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    opts.onAnswer?.(chunk, r.value);
    return r.value;
  });
  return { values, modelsUsed: [...used].sort(), usage, fromCache };
}

function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
}
