/**
 * M0 spike: verify DAVE voice RECEIVE works with @discordjs/voice.
 *
 *   npm run spike:receive -- --channel <voiceChannelId> [--minutes 10]
 *
 * Records the channel with the same SessionRecorder the app uses, logs every connection/DAVE debug
 * line, and writes a report when stopped (Ctrl+C or --minutes elapsed). Then run
 * `npm run spike:mix -- <sessionDir>` to render one WAV per speaker plus a mix, aligned on real
 * time, to listen for gaps/garbling.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateDependencyReport } from '@discordjs/voice';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { SessionRecorder } from '../recording/SessionRecorder.js';
import type { UtteranceRecord } from '../recording/UtteranceRecorder.js';
import { ConfigError, loadConfig } from '../config/load.js';
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

const sessionId = `spike-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sessionDir = resolve(process.env.DATA_DIR ?? './data', 'sessions', sessionId);
mkdirSync(sessionDir, { recursive: true });
const debugLog = join(sessionDir, 'debug.log');
const t0 = Date.now();

function stamp(): string {
  const s = (Date.now() - t0) / 1000;
  return `+${s.toFixed(3)}s`;
}
function log(msg: string): void {
  const line = `${stamp()} ${msg}`;
  console.log(line);
  appendFileSync(debugLog, line + '\n');
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
const events: { at: string; event: string }[] = [];
let decryptFailureLines = 0;
let daveLines = 0;
let resubscribes = 0;
let recorder: SessionRecorder | undefined;
let stopping = false;

function event(e: string): void {
  events.push({ at: stamp(), event: e });
  log(e);
}

function debug(msg: string): void {
  appendFileSync(debugLog, `${stamp()} [debug] ${msg}\n`);
  if (/fail(ed)? to decrypt/i.test(msg)) decryptFailureLines++;
  if (/dave|transition|epoch|mls/i.test(msg)) daveLines++;
}

log(`Session dir: ${sessionDir}`);
log(`Dependency report:\n${generateDependencyReport()}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (ready) => {
  log(`Logged in as ${ready.user.tag}`);
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) fail(`Channel ${channelId} is not a voice channel the bot can see`);

  recorder = new SessionRecorder({
    sessionId,
    sessionDir,
    guild: channel.guild,
    channel,
    filter: { ignoreUserIds: new Set(config.recording.ignore_users), ignoreBots: config.recording.ignore_bots, selfId: ready.user.id },
    silenceMs,
    log: event,
    debug,
    source: 'spike',
  });
  recorder.on('utterance', (rec: UtteranceRecord) => onUtterance(rec));
  recorder.on('resubscribe', () => resubscribes++);
  recorder.on('lost', () => void stop());
  try {
    await recorder.start();
  } catch (err) {
    fail((err as Error).message);
  }
  event(`Joined #${channel.name} in ${channel.guild.name}. Recording — Ctrl+C to stop.`);

  const minutes = args.minutes ? Number(args.minutes) : undefined;
  if (minutes) setTimeout(() => void stop(), minutes * 60_000);
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.channelId === after.channelId) return;
  const name = after.member?.displayName ?? after.id;
  if (after.channelId === channelId) event(`member joined: ${name} (${after.id})`);
  else if (before.channelId === channelId) event(`member left: ${name} (${after.id})`);
});

function onUtterance(rec: UtteranceRecord): void {
  const name = recorder?.status().participants.find((p) => p.id === rec.userId)?.name ?? rec.userId;
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

async function stop(): Promise<void> {
  if (stopping || !recorder) return;
  stopping = true;
  event('stopping');
  await recorder.stop();
  const status = recorder.status();
  const skipped = new Map(status.skipped.map((s) => [s.id, { name: s.name, reason: s.reason }]));

  const report = {
    sessionId,
    durationSec: Math.round((Date.now() - t0) / 1000),
    speakers: Object.fromEntries(stats),
    skipped: Object.fromEntries(skipped),
    decryptFailureDebugLines: decryptFailureLines,
    daveDebugLines: daveLines,
    reconnects: status.reconnects,
    resubscribes,
    events,
  };
  writeFileSync(join(sessionDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n===== M0 receive report =====');
  console.log(`Duration: ${report.durationSec}s  Reconnects: ${report.reconnects}  Resubscribes: ${resubscribes}  Decrypt-failure debug lines: ${decryptFailureLines}`);
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
