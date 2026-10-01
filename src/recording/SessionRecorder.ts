import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import { paths, writeJson, type Participant, type SessionInfo } from '../session/layout.js';
import type { RecordingStatus } from '../bot/types.js';
import { skipReason, type RecordFilterConfig } from './filters.js';
import { UtteranceRecorder, type UtteranceRecord } from './UtteranceRecorder.js';

export interface SessionRecorderOptions {
  sessionId: string;
  sessionDir: string;
  guild: Guild;
  channel: VoiceBasedChannel;
  filter: RecordFilterConfig;
  silenceMs: number;
  log?: (msg: string) => void;
}

interface ParticipantState {
  name: string;
  utterances: number;
  audioMs: number;
  speaking: boolean;
}

/**
 * One recording: joins a voice channel, records each allowed speaker's utterances to
 * audio/<userId>/<startMs>.ogg, keeps session.json / participants.json / utterances.jsonl up to
 * date (so a crash loses at most the utterance in progress), reconnects on drops, and emits
 * "update" whenever its status changes.
 */
export class SessionRecorder extends EventEmitter {
  readonly startedAt = Date.now();
  private connection: VoiceConnection | undefined;
  private state: RecordingStatus['state'] = 'connecting';
  private readonly participants = new Map<string, ParticipantState>();
  private readonly participantFile: Record<string, Participant> = {};
  private readonly skipped = new Map<string, { name: string; reason: string }>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly resolving = new Set<string>();
  private reconnects = 0;
  private stopping = false;
  private readonly info: SessionInfo & { source: string };
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SessionRecorderOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.info = {
      id: opts.sessionId,
      startedAt: this.startedAt,
      guildId: opts.guild.id,
      guildName: opts.guild.name,
      channelId: opts.channel.id,
      channelName: opts.channel.name,
      source: 'bot',
    };
  }

  status(): RecordingStatus {
    return {
      sessionId: this.opts.sessionId,
      guildId: this.opts.guild.id,
      guildName: this.opts.guild.name,
      channelId: this.opts.channel.id,
      channelName: this.opts.channel.name,
      startedAt: this.startedAt,
      state: this.state,
      participants: [...this.participants].map(([id, p]) => ({ id, ...p })),
      skipped: [...this.skipped].map(([id, s]) => ({ id, ...s })),
      reconnects: this.reconnects,
    };
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.sessionDir, { recursive: true });
    writeJson(paths.session(this.opts.sessionDir), this.info);
    const { guild, channel } = this.opts;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;
    this.wire(connection);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      connection.destroy();
      throw new Error(`Couldn't connect to #${channel.name} within 30s. Does the bot have View Channel and Connect there?`);
    }
    this.setState('recording');
    this.log(`Recording #${channel.name} in ${guild.name} → ${this.opts.sessionId}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.setState('stopping');
    const connection = this.connection;
    if (connection) for (const stream of connection.receiver.subscriptions.values()) stream.destroy();
    await Promise.all(this.active.values());
    connection?.destroy();
    this.info.stoppedAt = Date.now();
    writeJson(paths.session(this.opts.sessionDir), this.info);
    this.log(`Stopped ${this.opts.sessionId}`);
  }

  private setState(state: RecordingStatus['state']): void {
    this.state = state;
    this.emit('update');
  }

  private wire(connection: VoiceConnection): void {
    connection.on('error', (err) => this.log(`voice connection error: ${err.message}`));
    connection.on('stateChange', async (oldState, newState) => {
      if (oldState.status === newState.status || this.stopping) return;
      if (newState.status === VoiceConnectionStatus.Ready) this.setState('recording');
      if (newState.status !== VoiceConnectionStatus.Disconnected) return;
      this.setState('reconnecting');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.reconnects++;
        this.log(`voice disconnected; rejoining (attempt ${this.reconnects})`);
        if (this.reconnects > 10 || !connection.rejoin()) {
          this.log('giving up on reconnecting');
          this.emit('lost');
        }
      }
    });

    const speaking = connection.receiver.speaking;
    speaking.on('end', (userId) => {
      const p = this.participants.get(userId);
      if (p?.speaking) {
        p.speaking = false;
        this.emit('update');
      }
    });
    speaking.on('start', (userId) => {
      const p = this.participants.get(userId);
      if (p && !p.speaking) {
        p.speaking = true;
        this.emit('update');
      }
      if (this.stopping || this.active.has(userId) || this.resolving.has(userId) || this.skipped.has(userId)) return;
      this.resolving.add(userId);
      void this.admit(connection, userId).finally(() => this.resolving.delete(userId));
    });
  }

  /** Decides whether to record a speaker (ignore list, bots, self), then starts recording them. */
  private async admit(connection: VoiceConnection, userId: string): Promise<void> {
    const { guild } = this.opts;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => undefined));
    const name = member?.displayName ?? userId;
    const reason = skipReason({ id: userId, bot: member?.user.bot ?? false }, this.opts.filter);
    if (reason) {
      this.skipped.set(userId, { name, reason });
      this.log(`not recording ${name}: ${reason}`);
      this.emit('update');
      return;
    }
    if (!this.participants.has(userId)) {
      this.participants.set(userId, { name, utterances: 0, audioMs: 0, speaking: true });
      this.participantFile[userId] = { displayName: name, ...(member ? { username: member.user.username } : {}) };
      writeJson(paths.participants(this.opts.sessionDir), this.participantFile);
      this.emit('update');
    }
    this.record(connection, userId);
  }

  private record(connection: VoiceConnection, userId: string): void {
    if (this.stopping || this.active.has(userId)) return;
    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: this.opts.silenceMs } });
    const recorder = new UtteranceRecorder({ sessionDir: this.opts.sessionDir, userId, maxFillMs: this.opts.silenceMs + 500 });
    const done = recorder.record(stream).then((rec) => {
      this.active.delete(userId);
      if (rec) this.onUtterance(rec);
      // A decrypt error (e.g. during a DAVE key change) can end the stream while the person is still
      // talking; "speaking start" won't fire again until they pause, so resubscribe now.
      if (rec?.error && !this.stopping && connection.receiver.speaking.users.has(userId)) {
        this.log(`resubscribing ${userId} after stream error: ${rec.error}`);
        this.record(connection, userId);
      }
    });
    this.active.set(userId, done);
  }

  private onUtterance(rec: UtteranceRecord): void {
    appendFileSync(join(this.opts.sessionDir, 'utterances.jsonl'), JSON.stringify(rec) + '\n');
    const p = this.participants.get(rec.userId);
    if (p) {
      p.utterances++;
      p.audioMs += rec.durationMs;
      this.emit('update');
    }
  }
}
