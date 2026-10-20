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
import type { BotControl, BotStatus } from '../bot/types.js';
import { normalizeUrl, type MusicControl, type MusicStatus } from '../music/control.js';

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
  /** Throttles wrong passwords (tests pass their own clock). */
  signInLimiter?: SignInLimiter;
}

const STEPS: JobStep[] = ['transcribe', 'merge', 'disambiguate', 'summarize'];

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
    }),
  );

  // --- Bot / recording --------------------------------------------------------------------------
  const noBot: BotStatus = { state: 'off', recording: null };
  api.get('/bot', (c) => c.json(opts.bot?.status() ?? noBot));
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

  // --- Music (the Mac app's built-in browser) -----------------------------------------------------
  const noMusic: MusicStatus = { available: false, inChannel: false, master: 1, monitor: true, tabs: [] };
  const unit = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
  api.get('/music', (c) => c.json(opts.music?.status() ?? noMusic));
  api.post('/music/tabs', async (c) => {
    if (!opts.music) return c.json({ error: 'Music needs the Mac app' }, 409);
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    try {
      opts.music.openTab(normalizeUrl(typeof url === 'string' ? url : ''));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(opts.music.status());
  });
  api.patch('/music/tabs/:id', async (c) => {
    if (!opts.music) return c.json({ error: 'Music needs the Mac app' }, 409);
    const id = c.req.param('id');
    if (!opts.music.status().tabs.some((t) => t.id === id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { volume?: unknown; muted?: unknown; active?: unknown };
    if (body.volume !== undefined && unit(body.volume) === undefined) return c.json({ error: 'volume must be between 0 and 1' }, 400);
    opts.music.updateTab(id, {
      ...(body.volume !== undefined ? { volume: body.volume as number } : {}),
      ...(typeof body.muted === 'boolean' ? { muted: body.muted } : {}),
      ...(body.active === true ? { active: true } : {}),
    });
    return c.json(opts.music.status());
  });
  api.delete('/music/tabs/:id', (c) => {
    if (!opts.music) return c.json({ error: 'Music needs the Mac app' }, 409);
    opts.music.closeTab(c.req.param('id'));
    return c.json(opts.music.status());
  });
  api.patch('/music', async (c) => {
    if (!opts.music) return c.json({ error: 'Music needs the Mac app' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { master?: unknown; monitor?: unknown };
    if (body.master !== undefined && unit(body.master) === undefined) return c.json({ error: 'master must be between 0 and 1' }, 400);
    opts.music.update({ ...(body.master !== undefined ? { master: body.master as number } : {}), ...(typeof body.monitor === 'boolean' ? { monitor: body.monitor } : {}) });
    return c.json(opts.music.status());
  });

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
