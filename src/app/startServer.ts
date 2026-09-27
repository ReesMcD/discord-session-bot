import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './api.js';
import { ConfigStore } from './configStore.js';
import { JobRunner } from './jobs.js';
import { pipelineRunner } from './steps.js';
import { PROVIDERS } from '../transcription/openaiCompatible.js';
import type { BotService } from '../bot/BotService.js';

export interface ServerOptions {
  password: string;
  port?: number;
  host?: string;
  dataDir: string;
  configPath: string;
  /** Folder with the built web UI (index.html). */
  webDist: string;
  corsOrigins?: string[];
  /** The Discord bot, when it runs in this process. */
  bot?: BotService;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  url: string;
  jobs: JobRunner;
  configStore: ConfigStore;
  close(): Promise<void>;
}

/** Starts the API + web UI. Used by `npm run app` and by the Mac app. */
export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? console.log;
  const configStore = new ConfigStore(opts.configPath);
  const jobs = new JobRunner(pipelineRunner({ dataDir: opts.dataDir, configPath: configStore.path }));
  jobs.on('job', (j) => {
    if (j.status === 'done' || j.status === 'failed') log(`[job] ${j.step} ${j.sessionId}: ${j.status}${j.error ? ` (${j.error})` : ''}`);
  });
  opts.bot?.attachJobs(jobs, configStore);

  const app = new Hono();
  app.route(
    '/api',
    createApi({
      password: opts.password,
      dataDir: opts.dataDir,
      configStore,
      jobs,
      ...(opts.bot ? { bot: opts.bot } : {}),
      ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
      keys: () => {
        const provider = configStore.read().config?.transcription.provider ?? 'groq';
        return {
          discord: !!process.env.DISCORD_TOKEN,
          transcription: !!(process.env.TRANSCRIBE_API_KEY || process.env[PROVIDERS[provider].keyEnv]),
          anthropic: !!process.env.ANTHROPIC_API_KEY,
        };
      },
    }),
  );

  const webDist = resolve(opts.webDist);
  if (existsSync(resolve(webDist, 'index.html'))) {
    app.use('/*', serveStatic({ root: webDist }));
    app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
  } else {
    app.get('/', (c) => c.text('Web UI not built yet: run `npm run web:build`, then restart.'));
  }

  return new Promise((resolvePromise, reject) => {
    let server: ServerType;
    try {
      server = serve({ fetch: app.fetch, port: opts.port ?? 4400, hostname: opts.host ?? '0.0.0.0' }, (info: AddressInfo) => {
        resolvePromise({
          port: info.port,
          url: `http://localhost:${info.port}`,
          jobs,
          configStore,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
      server.once('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}
