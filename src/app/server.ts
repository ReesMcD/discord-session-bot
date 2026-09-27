/**
 * npm run app
 *
 * Serves the web app and its API. Open http://localhost:4400 (or the Mac's Tailscale name from
 * your phone). Requires APP_PASSWORD in .env.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { loadDotEnv } from '../util/env.js';
import { createApi } from './api.js';
import { ConfigStore } from './configStore.js';
import { JobRunner } from './jobs.js';
import { pipelineRunner } from './steps.js';
import { PROVIDERS } from '../transcription/openaiCompatible.js';

loadDotEnv();
const password = process.env.APP_PASSWORD;
if (!password || password.length < 8) {
  console.error('Set APP_PASSWORD in .env (at least 8 characters). The app controls a recording bot, so it always needs a password.');
  process.exit(1);
}
const port = Number(process.env.APP_PORT ?? 4400);
const host = process.env.APP_HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const configStore = new ConfigStore();
const jobs = new JobRunner(pipelineRunner({ dataDir, configPath: configStore.path }));
jobs.on('job', (j) => {
  if (j.status === 'done' || j.status === 'failed') console.log(`[job] ${j.step} ${j.sessionId}: ${j.status}${j.error ? ` (${j.error})` : ''}`);
});

const app = new Hono();
app.route(
  '/api',
  createApi({
    password,
    dataDir,
    configStore,
    jobs,
    corsOrigins: (process.env.APP_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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

const webDist = resolve('web/dist');
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: 'web/dist' }));
  app.get('*', serveStatic({ root: 'web/dist', path: 'index.html' }));
} else {
  app.get('/', (c) => c.text('Web UI not built yet: run `npm run web:build`, then restart `npm run app`.'));
}

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Session bot app on http://localhost:${info.port}  (listening on ${host})`);
  console.log('From your phone: http://<this Mac\'s Tailscale name>:' + info.port);
});
