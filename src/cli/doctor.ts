/**
 * npm run doctor [-- --online]
 *
 * Checks that this machine is set up: Node, ffmpeg (with the Opus and FLAC encoders), unzip,
 * voice/DAVE libraries, .env keys, config.yaml and the data folder. With --online it also tries
 * each API key against Discord, Groq/OpenAI and Anthropic.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { generateDependencyReport } from '@discordjs/voice';
import { ConfigError, loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { PROVIDERS } from '../transcription/openaiCompatible.js';
import { loadDotEnv } from '../util/env.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, status: Status, detail: string): void => {
  checks.push({ name, status, detail });
};

loadDotEnv();
const online = process.argv.includes('--online');

// --- Local checks -----------------------------------------------------------------------------

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 12)) add('Node.js', 'ok', `v${process.versions.node}`);
else add('Node.js', 'fail', `v${process.versions.node}; need 22.12 or newer (brew upgrade node)`);

const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffv = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
if (ffv.status !== 0) {
  add('ffmpeg', 'fail', `not found (${ffmpegPath}); brew install ffmpeg, or set FFMPEG_PATH`);
} else {
  const enc = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  const missing = ['libopus', 'flac'].filter((e) => !new RegExp(`\\s${e}\\s`).test(enc));
  const version = ffv.stdout.split('\n')[0]?.replace(/ Copyright.*/, '') ?? '';
  if (missing.length) add('ffmpeg', 'fail', `${version}, but missing encoder(s): ${missing.join(', ')}`);
  else add('ffmpeg', 'ok', version);
}

const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
add('unzip', unzip.status === 0 ? 'ok' : 'warn', unzip.status === 0 ? 'found' : 'not found; unzip Craig exports yourself and pass the folder');

const report = generateDependencyReport();
const davey = /@snazzah\/davey: (\S+)/.exec(report)?.[1];
const aes = /native crypto support for aes-256-gcm: yes/.test(report);
if (davey && davey !== 'not' && aes) add('Voice libraries', 'ok', `DAVE ${davey}, AES-GCM native`);
else add('Voice libraries', 'fail', `DAVE: ${davey ?? 'missing'}, AES-GCM: ${aes ? 'yes' : 'no'}; try rm -rf node_modules && npm install`);

if (!existsSync('.env')) add('.env', 'warn', 'no .env file here; cp .env.example .env (and run commands from the project folder)');
else add('.env', 'ok', 'found');

let config: Config | undefined;
try {
  const loaded = loadConfig();
  config = loaded.config;
  add('config.yaml', loaded.path ? 'ok' : 'warn', loaded.path ? `valid (${loaded.path})` : 'not found, using defaults; cp config.example.yaml config.yaml');
} catch (err) {
  add('config.yaml', 'fail', err instanceof ConfigError ? err.message : String(err));
}

const dataDir = resolve(process.env.DATA_DIR ?? './data');
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
  add('Data folder', 'ok', dataDir);
} catch (err) {
  add('Data folder', 'fail', `${dataDir} is not writable: ${(err as Error).message}`);
}

const provider = config?.transcription.provider ?? 'groq';
const transcribeKey = process.env.TRANSCRIBE_API_KEY || process.env[PROVIDERS[provider].keyEnv];
const keys: [string, string | undefined, string][] = [
  ['DISCORD_TOKEN', process.env.DISCORD_TOKEN, 'needed to record with the bot (not for Craig imports)'],
  [PROVIDERS[provider].keyEnv, transcribeKey, 'needed to transcribe'],
  ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY, 'needed to summarize'],
];
for (const [name, value, why] of keys) add(name, value ? 'ok' : 'warn', value ? 'set' : `not set; ${why}`);

// --- Online checks ----------------------------------------------------------------------------

async function checkDiscord(token: string): Promise<void> {
  const headers = { Authorization: `Bot ${token}` };
  const me = await fetch('https://discord.com/api/v10/users/@me', { headers, signal: AbortSignal.timeout(15_000) });
  if (me.status === 401) return add('Discord token', 'fail', 'rejected; reset the token in the Developer Portal → Bot');
  if (!me.ok) return add('Discord token', 'fail', `HTTP ${me.status}${me.status === 403 ? ' (blocked by a firewall, VPN or proxy?)' : ''}`);
  const user = (await me.json()) as { username: string };
  const guilds = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers, signal: AbortSignal.timeout(15_000) });
  const list = guilds.ok ? ((await guilds.json()) as { name: string }[]) : [];
  if (!list.length) add('Discord token', 'warn', `valid (${user.username}), but the bot isn't in any server yet; use the OAuth2 invite URL`);
  else add('Discord token', 'ok', `valid (${user.username}), in: ${list.map((g) => g.name).join(', ')}`);
}

async function checkTranscription(key: string, cfg: Config['transcription']): Promise<void> {
  const base = (cfg.base_url ?? PROVIDERS[cfg.provider].baseUrl).replace(/\/$/, '');
  const model = cfg.model ?? PROVIDERS[cfg.provider].model;
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) return add(`${cfg.provider} key`, 'fail', 'rejected; create a new key');
  if (!res.ok) return add(`${cfg.provider} key`, 'fail', `HTTP ${res.status} from ${base}/models${res.status === 403 ? ' (blocked by a firewall, VPN or proxy?)' : ''}`);
  const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  if (ids.length && !ids.includes(model)) add(`${cfg.provider} key`, 'warn', `valid, but model "${model}" isn't listed; check transcription.model`);
  else add(`${cfg.provider} key`, 'ok', `valid, model ${model} available`);
}

async function checkAnthropic(key: string, model: string): Promise<void> {
  try {
    const info = await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 }).models.retrieve(model);
    add('Anthropic key', 'ok', `valid, model ${info.id} available`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) add('Anthropic key', 'fail', 'rejected; create a new key at platform.claude.com/settings/keys');
    else if (err instanceof Anthropic.NotFoundError) add('Anthropic key', 'fail', `valid, but model "${model}" not found; check summary.model`);
    else throw err;
  }
}

if (online) {
  const tasks: [string, () => Promise<void>][] = [];
  if (process.env.DISCORD_TOKEN) tasks.push(['Discord token', () => checkDiscord(process.env.DISCORD_TOKEN!)]);
  if (transcribeKey && config) tasks.push([`${provider} key`, () => checkTranscription(transcribeKey, config!.transcription)]);
  if (process.env.ANTHROPIC_API_KEY && config) tasks.push(['Anthropic key', () => checkAnthropic(process.env.ANTHROPIC_API_KEY!, config!.summary.model)]);
  await Promise.all(
    tasks.map(([name, run]) => run().catch((err: Error) => add(name, 'fail', `couldn't reach the API: ${err.cause instanceof Error ? err.cause.message : err.message}`))),
  );
}

// --- Report -----------------------------------------------------------------------------------

const icon: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };
const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) console.log(`${icon[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
const fails = checks.filter((c) => c.status === 'fail').length;
const warns = checks.filter((c) => c.status === 'warn').length;
console.log(`\n${fails ? `${fails} problem(s) to fix` : 'No problems'}${warns ? `, ${warns} warning(s)` : ''}.${online ? '' : ' Run with --online to test the API keys.'}`);
process.exit(fails ? 1 : 0);
