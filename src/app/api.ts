import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { requirePassword, SignInLimiter, type PasswordSource } from './auth.js';
import { ConfigStore } from './configStore.js';
import { JobRunner, type Job, type JobStep } from './jobs.js';
import { DEFAULT_PROMPTS_DIR, PROMPT_NAMES, checkTemplate, deletePrompt, readPrompts, writePrompt } from './promptStore.js';
import { SESSION_FILES, knownPeople, listSessions, sessionDetail, sessionDirFor } from './sessions.js';
import { existsSync, readFileSync } from 'node:fs';
import type { PromptName } from '../summary/prompts.js';
import { saveRecapEdit } from '../summary/recapEdits.js';
import { resolveUnpaired, type UnpairedAction } from './unpaired.js';
import type { BotControl, BotStatus, LiveUpdate } from '../bot/types.js';
import type { MusicControl, MusicStatus } from '../music/control.js';
import { musicRoutes } from './musicRoutes.js';
import { MusicLibrary } from '../music/library.js';
import { UPLOAD_TOKEN_ENV, testUpload } from '../upload/recapUpload.js';
import { configSchema } from '../config/schema.js';

export interface ApiOptions {
  password: PasswordSource;
  dataDir: string;
  configStore: ConfigStore;
  jobs: JobRunner;
  /** Extra origins allowed to call the API (e.g. a Vercel-hosted UI). Same-origin always works. */
  corsOrigins?: string[];
  /** Reports which API keys are configured, without revealing them. */
  keys?: () => Record<string, boolean>;
  /** The Discord bot, when running in this process. */
  bot?: BotControl;
  /** The Mac app's music browser; absent under `npm run app`. */
  music?: MusicControl;
  /** For tests: the HTTP client the upload test uses. */
  uploadFetch?: typeof fetch;
  /** Throttles wrong passwords (tests pass their own clock). */
  signInLimiter?: SignInLimiter;
}

const STEPS: JobStep[] = ['transcribe', 'merge', 'disambiguate', 'summarize', 'upload'];

export function createApi(opts: ApiOptions): Hono {
  const api = new Hono();
  if (opts.corsOrigins?.length) {
    api.use('*', cors({ origin: opts.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
  }
  api.use('*', requirePassword(opts.password, opts.signInLimiter));

  api.get('/health', (c) => c.json({ ok: true, keys: opts.keys?.() ?? {} }));

  // --- Sessions ---------------------------------------------------------------------------------
  api.get('/sessions', (c) => c.json(listSessions(opts.dataDir)));

  api.get('/sessions/:id', (c) => {
    const detail = sessionDetail(opts.dataDir, c.req.param('id'), opts.configStore.read().config);
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

  /** Saves a hand-edited recap (summary.md). The generated version is kept alongside. */
  api.put('/sessions/:id/summary', async (c) => {
    const id = c.req.param('id');
    const dir = sessionDirFor(opts.dataDir, id);
    if (!dir) return c.json({ error: 'not found' }, 404);
    if (opts.jobs.list(id).some((j) => j.step === 'summarize' && (j.status === 'queued' || j.status === 'running'))) {
      return c.json({ error: 'The recap is being regenerated; wait for it to finish, then edit' }, 409);
    }
    const { markdown } = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
    if (typeof markdown !== 'string') return c.json({ error: 'markdown is required' }, 400);
    try {
      saveRecapEdit(dir, markdown);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ ...sessionDetail(opts.dataDir, id, opts.configStore.read().config)!, jobs: opts.jobs.list(id) });
  });

  /** Pair someone who isn't on the roster yet, mark them a guest, or ignore them for this session. */
  api.post('/sessions/:id/unpaired/:userId', async (c) => {
    const id = c.req.param('id');
    const dir = sessionDirFor(opts.dataDir, id);
    if (!dir) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Partial<UnpairedAction> & { character?: unknown };
    if (body.action !== 'pair' && body.action !== 'guest' && body.action !== 'ignore') return c.json({ error: 'action must be pair, guest or ignore' }, 400);
    const decision = (body.action === 'pair' ? { action: 'pair', character: typeof body.character === 'string' ? body.character : '' } : { action: body.action }) as UnpairedAction;
    const state = opts.configStore.read();
    if (!state.config) return c.json({ error: `Fix config.yaml first: ${state.error}` }, 400);
    try {
      const next = resolveUnpaired(dir, state.config, c.req.param('userId'), decision);
      if (next) {
        const saved = opts.configStore.write(next);
        if (saved.errors.length) return c.json({ error: saved.errors[0]!.message }, 400);
        // Names in the transcript follow the roster.
        if (decision.action === 'pair') opts.jobs.enqueue(id, 'merge');
      }
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ ...sessionDetail(opts.dataDir, id, opts.configStore.read().config)!, jobs: opts.jobs.list(id) });
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

  /** Server-sent events: "job" per job update, "bot" per bot/recording status change. */
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (job: Job) => void stream.writeSSE({ event: 'job', data: JSON.stringify(job) });
      const sendBot = (status: BotStatus) => void stream.writeSSE({ event: 'bot', data: JSON.stringify(status) });
      const sendMusic = (status: MusicStatus) => void stream.writeSSE({ event: 'music', data: JSON.stringify(status) });
      const sendLive = (update: LiveUpdate) => void stream.writeSSE({ event: 'live', data: JSON.stringify(update) });
      opts.bot?.on('live', sendLive);
      opts.jobs.on('job', send);
      opts.bot?.on('status', sendBot);
      opts.music?.on('status', sendMusic);
      if (opts.bot) sendBot(opts.bot.status());
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      opts.jobs.off('job', send);
      opts.bot?.off('status', sendBot);
      opts.music?.off('status', sendMusic);
      opts.bot?.off('live', sendLive);
    }),
  );

  // --- Bot / recording --------------------------------------------------------------------------
  const noBot: BotStatus = { state: 'off', recording: null };
  api.get('/bot', (c) => c.json(opts.bot?.status() ?? noBot));
  api.get('/bot/live', (c) => c.json(opts.bot?.liveTranscript?.() ?? { sessionId: null, lines: [] }));
  api.get('/bot/guilds', (c) => c.json(opts.bot?.guilds() ?? []));
  api.post('/bot/join', async (c) => {
    if (!opts.bot) return c.json({ error: 'The Discord bot is not running (no DISCORD_TOKEN)' }, 409);
    const { channelId } = (await c.req.json().catch(() => ({}))) as { channelId?: string };
    if (!channelId || !/^\d{15,22}$/.test(channelId)) return c.json({ error: 'channelId is required' }, 400);
    try {
      return c.json(await opts.bot.join(channelId));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });
  api.post('/bot/stop', async (c) => {
    if (!opts.bot) return c.json({ error: 'The Discord bot is not running' }, 409);
    try {
      return c.json(await opts.bot.stop());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  api.route('/music', musicRoutes(opts.music, new MusicLibrary(opts.dataDir)));

  // --- Config -----------------------------------------------------------------------------------
  /** Sends a test request with the upload settings given (unsaved edits included). */
  api.post('/upload/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { upload?: unknown; campaign?: unknown };
    const parsed = configSchema.shape.upload.safeParse(body.upload ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid upload settings' }, 400);
    if (!parsed.data.url) return c.json({ error: 'Set the address first' }, 400);
    return c.json(await testUpload(parsed.data, process.env[UPLOAD_TOKEN_ENV], opts.uploadFetch, typeof body.campaign === 'string' ? body.campaign : undefined));
  });

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
