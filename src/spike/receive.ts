/**
 * M0 spike: verify DAVE voice RECEIVE works with @discordjs/voice.
 *
 *   npm run spike:receive -- --channel <voiceChannelId> [--minutes 10]
 *
 * Joins the voice channel, records each speaker's utterances to Ogg Opus files, logs every
 * connection/DAVE debug line, and writes a report when stopped (Ctrl+C or --minutes elapsed).
 * Then run `npm run spike:mix -- <sessionDir>` to render one WAV per speaker plus a mix,
 * aligned on real time, to listen for gaps/garbling.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import { UtteranceRecorder, type UtteranceRecord } from '../recording/UtteranceRecorder.js';
import { skipReason, type RecordFilterConfig } from '../recording/filters.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { paths, writeJson, type Participant, type SessionInfo } from '../session/layout.js';
import { loadDotEnv } from '../util/env.js';

loadDotEnv();
let config;
try {
  config = loadConfig().config;
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  throw err;
}

const { values: args } = parseArgs({
  options: {
    channel: { type: 'string' },
    minutes: { type: 'string' },
    'silence-ms': { type: 'string' },
  },
});

const token = process.env.DISCORD_TOKEN;
if (!token) fail('DISCORD_TOKEN is not set (put it in .env)');
if (!args.channel) fail('Pass --channel <voiceChannelId> (Discord developer mode → right-click channel → Copy Channel ID)');
const channelId = args.channel;
const silenceMs = args['silence-ms'] ? Number(args['silence-ms']) : config.recording.silence_ms;
const ignoreUserIds = new Set(config.recording.ignore_users);
const ignoreBots = config.recording.ignore_bots;

const sessionId = `spike-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sessionDir = resolve(process.env.DATA_DIR ?? './data', 'sessions', sessionId);
mkdirSync(sessionDir, { recursive: true });
const debugLog = join(sessionDir, 'debug.log');
const t0 = Date.now();
const sessionInfo: SessionInfo = { id: sessionId, startedAt: t0 };
const participants: Record<string, Participant> = {};

function stamp(): string {
  const s = (Date.now() - t0) / 1000;
  return `+${s.toFixed(3)}s`;
}
function log(msg: string): void {
  const line = `${stamp()} ${msg}`;
  console.log(line);
  appendFileSync(debugLog, line + '\n');
}
function debug(msg: string): void {
  appendFileSync(debugLog, `${stamp()} [debug] ${msg}\n`);
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

interface SpeakerStats {
  name: string;
  utterances: number;
  audioMs: number;
  packets: number;
  fillerFrames: number;
  errors: string[];
}

const stats = new Map<string, SpeakerStats>();
const skipped = new Map<string, { name: string; reason: string }>();
const events: { at: string; event: string }[] = [];
const active = new Map<string, Promise<void>>();
const resolving = new Set<string>();
let decryptFailureLines = 0;
let daveLines = 0;
let reconnects = 0;
let stopping = false;

function event(e: string): void {
  events.push({ at: stamp(), event: e });
  log(e);
}

log(`Session dir: ${sessionDir}`);
log(`Dependency report:\n${generateDependencyReport()}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (ready) => {
  log(`Logged in as ${ready.user.tag}`);
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) fail(`Channel ${channelId} is not a voice channel the bot can see`);
  const guild = channel.guild;
  const filter: RecordFilterConfig = { ignoreUserIds, ignoreBots, selfId: ready.user.id };

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    debug: true,
  });
  wireConnection(connection, guild, filter);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    connection.destroy();
    fail('Voice connection did not become Ready within 30s');
  }
  Object.assign(sessionInfo, { guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name });
  writeJson(paths.session(sessionDir), sessionInfo);
  event(`Joined #${channel.name} in ${guild.name}. Recording — Ctrl+C to stop.`);

  const minutes = args.minutes ? Number(args.minutes) : undefined;
  if (minutes) setTimeout(() => void stop(connection), minutes * 60_000);
  process.once('SIGINT', () => void stop(connection));
  process.once('SIGTERM', () => void stop(connection));
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.channelId === after.channelId) return;
  const name = after.member?.displayName ?? after.id;
  if (after.channelId === channelId) event(`member joined: ${name} (${after.id})`);
  else if (before.channelId === channelId) event(`member left: ${name} (${after.id})`);
});

function wireConnection(connection: VoiceConnection, guild: Guild, filter: RecordFilterConfig): void {
  connection.on('debug', (msg) => {
    debug(msg);
    if (/fail(ed)? to decrypt/i.test(msg)) decryptFailureLines++;
    if (/dave|transition|epoch|mls/i.test(msg)) daveLines++;
  });
  connection.on('error', (err) => event(`connection error: ${err.message}`));
  connection.on('stateChange', async (oldState, newState) => {
    if (oldState.status === newState.status) return;
    event(`connection: ${oldState.status} → ${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Disconnected && !stopping) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        event('connection recovering on its own');
      } catch {
        reconnects++;
        event(`rejoining (attempt ${reconnects})`);
        if (reconnects > 5 || !connection.rejoin()) {
          event('giving up on reconnect');
          void stop(connection);
        }
      }
    }
  });

  connection.receiver.speaking.on('start', (userId) => {
    if (stopping || active.has(userId) || resolving.has(userId) || skipped.has(userId)) return;
    resolving.add(userId);
    void (async () => {
      try {
        const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => undefined));
        const name = member?.displayName ?? userId;
        const reason = skipReason({ id: userId, bot: member?.user.bot ?? false }, filter);
        if (reason) {
          skipped.set(userId, { name, reason });
          event(`not recording ${name} (${userId}): ${reason}`);
          return;
        }
        if (!participants[userId]) {
          participants[userId] = { displayName: name, ...(member ? { username: member.user.username } : {}) };
          writeJson(paths.participants(sessionDir), participants);
        }
        if (stopping || active.has(userId)) return;
        const stream = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
        });
        const recorder = new UtteranceRecorder({ sessionDir, userId, maxFillMs: silenceMs + 500 });
        const done = recorder.record(stream).then((rec) => {
          active.delete(userId);
          if (rec) onUtterance(rec, name);
        });
        active.set(userId, done);
      } finally {
        resolving.delete(userId);
      }
    })();
  });
}

function onUtterance(rec: UtteranceRecord, name: string): void {
  appendFileSync(join(sessionDir, 'utterances.jsonl'), JSON.stringify(rec) + '\n');
  const s = stats.get(rec.userId) ?? { name, utterances: 0, audioMs: 0, packets: 0, fillerFrames: 0, errors: [] };
  s.utterances++;
  s.audioMs += rec.durationMs;
  s.packets += rec.packets;
  s.fillerFrames += rec.fillerFrames;
  if (rec.error) s.errors.push(rec.error);
  stats.set(rec.userId, s);
  console.log(
    `${stamp()} ${name}: ${(rec.durationMs / 1000).toFixed(1)}s, ${rec.packets} pkts` +
      (rec.fillerFrames ? `, ${rec.fillerFrames} filler` : '') +
      (rec.error ? `, ERROR ${rec.error}` : ''),
  );
}

async function stop(connection: VoiceConnection): Promise<void> {
  if (stopping) return;
  stopping = true;
  event('stopping');
  for (const stream of connection.receiver.subscriptions.values()) stream.destroy();
  await Promise.all(active.values());
  connection.destroy();
  sessionInfo.stoppedAt = Date.now();
  writeJson(paths.session(sessionDir), sessionInfo);

  const report = {
    sessionId,
    durationSec: Math.round((Date.now() - t0) / 1000),
    speakers: Object.fromEntries(stats),
    skipped: Object.fromEntries(skipped),
    decryptFailureDebugLines: decryptFailureLines,
    daveDebugLines: daveLines,
    reconnects,
    events,
  };
  writeFileSync(join(sessionDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n===== M0 receive report =====');
  console.log(`Duration: ${report.durationSec}s  Reconnects: ${reconnects}  Decrypt-failure debug lines: ${decryptFailureLines}`);
  for (const [id, s] of stats) {
    console.log(
      `  REC  ${s.name} (${id}): ${s.utterances} utterances, ${(s.audioMs / 1000).toFixed(1)}s audio, ` +
        `${s.packets} packets, ${s.fillerFrames} filler frames` + (s.errors.length ? `, ${s.errors.length} stream errors` : ''),
    );
  }
  for (const [id, s] of skipped) console.log(`  SKIP ${s.name} (${id}): ${s.reason}`);
  if (stats.size === 0) console.log('  No audio captured from anyone — receive is NOT working.');
  console.log(`\nFiles + debug.log + report.json in ${sessionDir}`);
  console.log(`Next: npm run spike:mix -- "${sessionDir}"`);
  console.log(`  and: npm run transcribe -- "${sessionDir}"`);
  await client.destroy();
  process.exit(0);
}

await client.login(token).catch((err: Error) => fail(`Discord login failed: ${err.message} — check DISCORD_TOKEN`));
