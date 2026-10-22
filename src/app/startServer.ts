import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi, wikiEncountersFor } from './api.js';
import { publicJoinUrl } from './encounterRoutes.js';
import type { PasswordSource } from './auth.js';
import { networkGuard } from './network.js';
import { pruneOldAudio } from '../session/retention.js';
import { emptyTrash } from './sessions.js';
import { ConfigStore } from './configStore.js';
import { JobRunner } from './jobs.js';
import { pipelineRunner } from './steps.js';
import { PROVIDERS } from '../transcription/openaiCompatible.js';
import type { BotService } from '../bot/BotService.js';
import { UPLOAD_TOKEN_ENV } from '../upload/recapUpload.js';
import type { MusicControl } from '../music/control.js';
import { EncounterStore } from '../encounter/store.js';
import { startPlayerServer } from '../play/playerServer.js';

export interface ServerOptions {
  /** Pass a function when the password can change while the server runs. */
  password: PasswordSource;
  port?: number;
  host?: string;
  dataDir: string;
  configPath: string;
  /** Folder with the built web UI (index.html). */
  webDist: string;
  corsOrigins?: string[];
  /** Answer devices on the local network too, not just this Mac and Tailscale. */
  allowLan?: boolean;
  /** The Discord bot, when it runs in this process. */
  bot?: BotService;
  /** The Mac app's music browser. */
  music?: MusicControl;
  /** The players' server (#47) on players.port; false turns it off (tests). */
  players?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  url: string;
  jobs: JobRunner;
  configStore: ConfigStore;
  encounters: EncounterStore;
  /** The players' server's port, when it started. */
  playerPort: number | null;
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

  // recording.audio_retention_days: on start, then daily.
  const pruneAudio = () => {
    const emptied = emptyTrash(opts.dataDir);
    if (emptied.length) log(`Deleted ${emptied.length} session(s) from the trash (kept 30 days)`);
    const days = configStore.read().config?.recording.audio_retention_days;
    if (days === undefined) return;
    const pruned = pruneOldAudio(opts.dataDir, days);
    if (pruned.length) log(`Deleted the audio of ${pruned.length} session(s) older than ${days} days (transcripts and recaps kept)`);
  };
  pruneAudio();
  const pruneTimer = setInterval(pruneAudio, 86_400_000);
  pruneTimer.unref();

  const encounters = new EncounterStore(opts.dataDir, undefined, log);
  const wikiEncounters = wikiEncountersFor(opts.dataDir, configStore);
  opts.bot?.attachEncounters({
    store: encounters,
    wiki: wikiEncounters,
    joinUrl: () => {
      const code = encounters.current()?.join?.code;
      const players = configStore.read().config?.players;
      return code && players ? publicJoinUrl({ publicUrl: players.public_url, port: players.port }, code) : null;
    },
  });

  const app = new Hono();
  app.use('*', networkGuard(opts.allowLan ?? false));
  app.route(
    '/api',
    createApi({
      password: opts.password,
      dataDir: opts.dataDir,
      configStore,
      jobs,
      encounters,
      wikiEncounters,
      ...(opts.bot ? { bot: opts.bot } : {}),
      ...(opts.music ? { music: opts.music } : {}),
      ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
      keys: () => {
        const provider = configStore.read().config?.transcription.provider ?? 'groq';
        return {
          discord: !!process.env.DISCORD_TOKEN,
          transcription: !!(process.env.TRANSCRIBE_API_KEY || process.env[PROVIDERS[provider].keyEnv]),
          anthropic: !!process.env.ANTHROPIC_API_KEY,
          upload: !!process.env[UPLOAD_TOKEN_ENV],
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

  // The players' page: a separate server that Tailscale Funnel exposes. A busy port doesn't stop the app.
  const playerPort = configStore.read().config?.players.port ?? 4410;
  const players =
    opts.players === false
      ? Promise.resolve(null)
      : startPlayerServer(encounters, { port: playerPort, webDist }).catch((err: Error) => {
          log(`The players' page couldn't start on port ${playerPort}: ${err.message}. Change players.port in Settings.`);
          return null;
        });

  return new Promise((resolvePromise, reject) => {
    let server: ServerType;
    try {
      server = serve({ fetch: app.fetch, port: opts.port ?? 4400, hostname: opts.host ?? '0.0.0.0' }, (info: AddressInfo) => {
        void players.then((playerServer) =>
          resolvePromise({
            port: info.port,
            url: `http://localhost:${info.port}`,
            jobs,
            configStore,
            encounters,
            playerPort: playerServer?.port ?? null,
            close: async () => {
              clearInterval(pruneTimer);
              await playerServer?.close();
              await new Promise<void>((r) => server.close(() => r()));
            },
          }),
        );
      });
      server.once('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}
