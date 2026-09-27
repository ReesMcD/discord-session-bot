import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { requirePassword } from './auth.js';
import { ConfigStore } from './configStore.js';
import { JobRunner, type Job, type JobStep } from './jobs.js';
import { DEFAULT_PROMPTS_DIR, PROMPT_NAMES, checkTemplate, deletePrompt, readPrompts, writePrompt } from './promptStore.js';
import { SESSION_FILES, knownPeople, listSessions, sessionDetail, sessionDirFor } from './sessions.js';
import { existsSync, readFileSync } from 'node:fs';
import type { PromptName } from '../summary/prompts.js';

export interface ApiOptions {
  password: string;
  dataDir: string;
  configStore: ConfigStore;
  jobs: JobRunner;
  /** Extra origins allowed to call the API (e.g. a Vercel-hosted UI). Same-origin always works. */
  corsOrigins?: string[];
  /** Reports which API keys are configured, without revealing them. */
  keys?: () => Record<string, boolean>;
}

const STEPS: JobStep[] = ['transcribe', 'merge', 'disambiguate', 'summarize'];

export function createApi(opts: ApiOptions): Hono {
  const api = new Hono();
  if (opts.corsOrigins?.length) {
    api.use('*', cors({ origin: opts.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));
  }
  api.use('*', requirePassword(opts.password));

  api.get('/health', (c) => c.json({ ok: true, keys: opts.keys?.() ?? {} }));

  // --- Sessions ---------------------------------------------------------------------------------
  api.get('/sessions', (c) => c.json(listSessions(opts.dataDir)));

  api.get('/sessions/:id', (c) => {
    const detail = sessionDetail(opts.dataDir, c.req.param('id'));
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json({ ...detail, jobs: opts.jobs.list(detail.id) });
  });

  api.get('/sessions/:id/files/:name', (c) => {
    const dir = sessionDirFor(opts.dataDir, c.req.param('id'));
    const name = c.req.param('name') as keyof typeof SESSION_FILES;
    const file = dir && name in SESSION_FILES ? SESSION_FILES[name](dir) : undefined;
    if (!file || !existsSync(file)) return c.json({ error: 'not found' }, 404);
    return c.body(readFileSync(file, 'utf8'), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${c.req.param('id')}-${name}"`,
    });
  });

  api.get('/people', (c) => c.json(knownPeople(opts.dataDir)));

  api.post('/sessions/:id/jobs', async (c) => {
    const id = c.req.param('id');
    if (!sessionDirFor(opts.dataDir, id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { step?: string; force?: boolean };
    if (!STEPS.includes(body.step as JobStep)) return c.json({ error: `step must be one of ${STEPS.join(', ')}` }, 400);
    return c.json(opts.jobs.enqueue(id, body.step as JobStep, !!body.force), 202);
  });

  // --- Jobs -------------------------------------------------------------------------------------
  api.get('/jobs', (c) => c.json(opts.jobs.list(c.req.query('session'))));
  api.get('/jobs/:id', (c) => {
    const job = opts.jobs.get(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'not found' }, 404);
  });

  /** Server-sent events: one "job" event per job update. */
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (job: Job) => void stream.writeSSE({ event: 'job', data: JSON.stringify(job) });
      opts.jobs.on('job', send);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      opts.jobs.off('job', send);
    }),
  );

  // --- Config -----------------------------------------------------------------------------------
  api.get('/config', (c) => c.json(opts.configStore.read()));

  api.put('/config', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { config?: unknown; yaml?: string } | null;
    if (!body) return c.json({ errors: [{ path: '', message: 'invalid JSON' }] }, 400);
    const result = typeof body.yaml === 'string' ? opts.configStore.writeRaw(body.yaml) : opts.configStore.write(body.config);
    if (result.errors.length) return c.json(result, 400);
    return c.json(opts.configStore.read());
  });

  // --- Prompts ----------------------------------------------------------------------------------
  const promptsDir = () => opts.configStore.read().config?.summary.prompts_dir;

  api.get('/prompts', (c) => c.json({ dir: promptsDir() ?? null, prompts: readPrompts(promptsDir()) }));

  api.put('/prompts/:name', async (c) => {
    const name = c.req.param('name') as PromptName;
    if (!PROMPT_NAMES.includes(name)) return c.json({ error: 'unknown prompt' }, 404);
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    const problem = checkTemplate(name, text ?? '');
    if (problem) return c.json({ error: problem }, 400);
    let dir = promptsDir();
    if (!dir) {
      // First custom prompt: create the folder and point config.yaml at it.
      const state = opts.configStore.read();
      if (!state.config) return c.json({ error: `Fix config.yaml first: ${state.error}` }, 400);
      dir = DEFAULT_PROMPTS_DIR;
      const saved = opts.configStore.write({ ...state.config, summary: { ...state.config.summary, prompts_dir: dir } });
      if (saved.errors.length) return c.json({ error: saved.errors[0]!.message }, 400);
    }
    writePrompt(dir, name, text!);
    return c.json({ dir, prompts: readPrompts(dir) });
  });

  api.delete('/prompts/:name', (c) => {
    const name = c.req.param('name') as PromptName;
    if (!PROMPT_NAMES.includes(name)) return c.json({ error: 'unknown prompt' }, 404);
    const dir = promptsDir();
    if (dir) deletePrompt(dir, name);
    return c.json({ dir: dir ?? null, prompts: readPrompts(dir) });
  });

  return api;
}
