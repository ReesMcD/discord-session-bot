import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType, Client, Events, GatewayIntentBits, type VoiceBasedChannel } from 'discord.js';
import { loadConfig } from '../config/load.js';
import { listUtterances, paths, readJson, writeJson, type SessionInfo } from '../session/layout.js';
import { SessionRecorder } from '../recording/SessionRecorder.js';
import type { ConfigStore } from '../app/configStore.js';
import type { JobRunner } from '../app/jobs.js';
import type { BotControl, BotStatus, GuildInfo, RecordingStatus } from './types.js';

export interface BotServiceOptions {
  dataDir: string;
  configPath: string;
  log?: (msg: string) => void;
}

/** A filesystem-safe, sortable session id like "2026-09-27-2130-game-night". */
export function sessionIdFor(startedAt: number, channelName: string, timeZone: string | undefined, exists: (id: string) => boolean): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
      .formatToParts(startedAt)
      .map((p) => [p.type, p.value]),
  );
  const slug = channelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'voice';
  const base = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}-${slug}`;
  let id = base;
  for (let n = 2; exists(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Finds bot recordings that never got a stop time (app crashed or the Mac restarted mid-call),
 * closes them at their last audio, and marks them interrupted. Returns their ids.
 */
export function recoverInterrupted(dataDir: string): string[] {
  const root = join(dataDir, 'sessions');
  if (!existsSync(root)) return [];
  const recovered: string[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const info = readJson<SessionInfo & { source?: string; interrupted?: boolean }>(paths.session(dir));
    if (!info || info.source !== 'bot' || info.stoppedAt) continue;
    const last = listUtterances(dir).reduce((m, u) => Math.max(m, statSync(u.path).mtimeMs), info.startedAt);
    writeJson(paths.session(dir), { ...info, stoppedAt: Math.round(last), interrupted: true });
    recovered.push(id);
  }
  return recovered;
}

/**
 * The always-on Discord bot: stays logged in, lists voice channels, and runs one recording at a
 * time. Status changes are emitted as "status" events for the API, web UI and menu bar.
 */
export class BotService extends EventEmitter implements BotControl {
  private client: Client | undefined;
  private state: BotStatus['state'] = 'off';
  private error: string | undefined;
  private recorder: SessionRecorder | undefined;
  private jobs: JobRunner | undefined;
  private configStore: ConfigStore | undefined;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | undefined;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: BotServiceOptions) {
    super();
    this.log = opts.log ?? ((m) => console.log(`[bot] ${m}`));
  }

  /** Lets the bot queue transcribe/summarize after a recording stops. */
  attachJobs(jobs: JobRunner, configStore: ConfigStore): void {
    this.jobs = jobs;
    this.configStore = configStore;
    for (const id of recoverInterrupted(this.opts.dataDir)) {
      this.log(`recovered interrupted recording ${id}`);
      this.afterStop(id);
    }
  }

  status(): BotStatus {
    return {
      state: this.state,
      ...(this.client?.user ? { user: this.client.user.tag } : {}),
      ...(this.error ? { error: this.error } : {}),
      recording: this.recorder?.status() ?? null,
    };
  }

  async start(token: string): Promise<void> {
    if (this.client) return;
    this.setState('connecting');
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.on(Events.ClientReady, (c) => {
      this.log(`logged in as ${c.user.tag}`);
      this.setState('ready');
    });
    client.on(Events.VoiceStateUpdate, () => this.emitStatus());
    client.on(Events.Error, (err) => this.log(`discord error: ${err.message}`));
    client.on(Events.ShardDisconnect, () => this.setState('connecting'));
    client.on(Events.ShardResume, () => this.setState('ready'));
    try {
      await client.login(token);
    } catch (err) {
      this.client = undefined;
      this.error = /token/i.test((err as Error).message) ? 'Discord rejected the bot token' : (err as Error).message;
      this.setState('error');
      throw err;
    }
  }

  guilds(): GuildInfo[] {
    if (!this.client || this.state !== 'ready') return [];
    return [...this.client.guilds.cache.values()]
      .map((g) => ({
        id: g.id,
        name: g.name,
        channels: [...g.channels.cache.values()]
          .filter((c): c is VoiceBasedChannel => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
          .filter((c) => c.viewable)
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .map((c) => ({
            id: c.id,
            name: c.name,
            members: [...c.members.values()].filter((m) => m.id !== this.client?.user?.id).map((m) => ({ id: m.id, name: m.displayName, bot: m.user.bot })),
          })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async join(channelId: string): Promise<RecordingStatus> {
    if (!this.client || this.state !== 'ready') throw new Error('The bot is not connected to Discord');
    if (this.recorder) throw new Error(`Already recording #${this.recorder.status().channelName}; stop that first`);
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isVoiceBased()) throw new Error('That voice channel is not visible to the bot');

    const { config } = loadConfig(this.opts.configPath);
    const sessionsRoot = join(this.opts.dataDir, 'sessions');
    const sessionId = sessionIdFor(Date.now(), channel.name, config.transcript.timezone, (id) => existsSync(join(sessionsRoot, id)));
    const recorder = new SessionRecorder({
      sessionId,
      sessionDir: join(sessionsRoot, sessionId),
      guild: channel.guild,
      channel,
      filter: { ignoreUserIds: new Set(config.recording.ignore_users), ignoreBots: config.recording.ignore_bots, selfId: this.client.user!.id },
      silenceMs: config.recording.silence_ms,
      log: this.log,
    });
    this.recorder = recorder;
    recorder.on('update', () => this.emitStatus());
    recorder.on('lost', () => void this.stop().catch(() => {}));
    try {
      await recorder.start();
    } catch (err) {
      this.recorder = undefined;
      this.emitStatus(true);
      throw err;
    }
    if (config.recording.announce) {
      await channel.send('🔴 **Recording started.** This call is being recorded and transcribed.').catch(() => this.log('could not post the start notice (needs Send Messages)'));
    }
    this.emitStatus(true);
    return recorder.status();
  }

  async stop(): Promise<{ sessionId: string }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Not recording');
    const { sessionId, channelId, startedAt } = recorder.status();
    await recorder.stop();
    this.recorder = undefined;
    this.emitStatus(true);
    const { config } = loadConfig(this.opts.configPath);
    if (config.recording.announce) {
      const channel = await this.client?.channels.fetch(channelId).catch(() => null);
      const minutes = Math.round((Date.now() - startedAt) / 60000);
      if (channel?.isSendable()) await channel.send(`⏹️ **Recording stopped** after ${minutes} min.`).catch(() => {});
    }
    this.afterStop(sessionId);
    return { sessionId };
  }

  async shutdown(): Promise<void> {
    if (this.recorder) await this.stop().catch(() => {});
    await this.client?.destroy();
    this.client = undefined;
    this.setState('off');
  }

  private afterStop(sessionId: string): void {
    if (!this.jobs || !this.configStore) return;
    const config = this.configStore.read().config;
    const mode = config?.recording.after_stop ?? 'transcribe';
    if (mode === 'nothing') return;
    this.jobs.enqueue(sessionId, 'transcribe');
    if (mode === 'summarize') this.jobs.enqueue(sessionId, 'summarize');
  }

  private setState(state: BotStatus['state']): void {
    this.state = state;
    if (state !== 'error') this.error = undefined;
    this.emitStatus(true);
  }

  /** Emits status at most ~4×/s (speaking indicators change constantly). */
  private emitStatus(now = false): void {
    const fire = () => {
      this.emitTimer = undefined;
      this.lastEmit = Date.now();
      this.emit('status', this.status());
    };
    if (now) {
      clearTimeout(this.emitTimer);
      return fire();
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(fire, Math.max(0, 250 - (Date.now() - this.lastEmit)));
  }
}
