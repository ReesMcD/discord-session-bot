import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { BOT_PERMISSIONS, COMMANDS, inviteUrl, runCommand } from '../src/bot/commands.js';
import type { BotStatus, RecordingStatus } from '../src/bot/types.js';

const GUILD = '111111111111111111';
const T0 = 1_000_000;

function recording(over: Partial<RecordingStatus> = {}): RecordingStatus {
  return {
    sessionId: 's1',
    guildId: GUILD,
    guildName: 'The Table',
    channelId: 'vc1',
    channelName: 'game-night',
    startedAt: T0,
    state: 'recording',
    participants: [
      { id: 'a', name: 'Rees', utterances: 3, audioMs: 1000, speaking: false },
      { id: 'b', name: 'Sam', utterances: 1, audioMs: 500, speaking: true },
    ],
    skipped: [{ id: 'c', name: 'Groovy', reason: 'bot' }],
    reconnects: 0,
    ...over,
  };
}

class FakeBot {
  rec: RecordingStatus | null = null;
  joined: string[] = [];
  stops = 0;
  failJoin: string | undefined;
  status(): BotStatus {
    return { state: 'ready', recording: this.rec };
  }
  async join(channelId: string): Promise<RecordingStatus> {
    if (this.failJoin) throw new Error(this.failJoin);
    this.joined.push(channelId);
    this.rec = recording({ channelId, channelName: channelId === 'vc2' ? 'one-shot' : 'game-night' });
    return this.rec;
  }
  async stop() {
    this.stops++;
    this.rec = null;
    return { sessionId: 's1' };
  }
}

test('/record joins the voice channel you are in, or the one picked', async () => {
  const bot = new FakeBot();
  assert.equal(await runCommand({ name: 'record', guildId: GUILD, memberVoiceChannelId: 'vc1' }, bot), '🔴 Recording **#game-night**. Use /stop when you\'re done.');
  assert.deepEqual(bot.joined, ['vc1']);

  const other = new FakeBot();
  await runCommand({ name: 'record', guildId: GUILD, memberVoiceChannelId: 'vc1', channelId: 'vc2' }, other);
  assert.deepEqual(other.joined, ['vc2'], 'the option wins');
});

test('/record explains what is wrong instead of failing', async () => {
  const bot = new FakeBot();
  assert.match(await runCommand({ name: 'record', guildId: GUILD }, bot), /Join a voice channel first/);
  bot.failJoin = 'That voice channel is not visible to the bot';
  assert.equal(await runCommand({ name: 'record', guildId: GUILD, memberVoiceChannelId: 'vc1' }, bot), "Couldn't start: That voice channel is not visible to the bot");
  bot.rec = recording();
  assert.equal(await runCommand({ name: 'record', guildId: GUILD, memberVoiceChannelId: 'vc1' }, bot), 'Already recording **#game-night**. Use /stop first.');
  bot.rec = recording({ guildId: 'elsewhere' });
  assert.equal(await runCommand({ name: 'record', guildId: GUILD, memberVoiceChannelId: 'vc1' }, bot), 'The bot is already recording in another server.');
  assert.deepEqual(bot.joined, []);
});

test('/status says who is and isn’t recorded, and for how long', async () => {
  const bot = new FakeBot();
  assert.equal(await runCommand({ name: 'status', guildId: GUILD }, bot), 'Not recording in this server.');
  bot.rec = recording();
  assert.equal(
    await runCommand({ name: 'status', guildId: GUILD, now: T0 + 83 * 60_000 }, bot),
    '🔴 Recording **#game-night** for 1 h 23 min.\nRecorded: Rees, Sam.\nNot recorded: Groovy.',
  );
  bot.rec = recording({ guildId: 'elsewhere' });
  assert.equal(await runCommand({ name: 'status', guildId: GUILD }, bot), 'Not recording in this server.', 'another server’s recording is not shown');
});

test('/stop stops this server’s recording and says what happens next', async () => {
  const bot = new FakeBot();
  assert.equal(await runCommand({ name: 'stop', guildId: GUILD }, bot), 'Not recording in this server.');
  bot.rec = recording({ guildId: 'elsewhere' });
  assert.equal(await runCommand({ name: 'stop', guildId: GUILD }, bot), 'Not recording in this server.');
  assert.equal(bot.stops, 0, 'never stops another server’s recording');

  for (const [afterStop, tail] of [
    ['summarize', ' The transcript and recap follow in the app.'],
    ['transcribe', ' The transcript follows in the app.'],
    ['nothing', ''],
  ] as const) {
    bot.rec = recording();
    assert.equal(await runCommand({ name: 'stop', guildId: GUILD, afterStop, now: T0 + 45 * 60_000 }, bot), `⏹️ Stopped after 45 min.${tail}`);
  }
  assert.equal(bot.stops, 3);
});

test('commands: guild only; /record and /stop default to Manage Server, /status to everyone', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['record', 'status', 'stop']);
  for (const c of COMMANDS) assert.deepEqual(c.contexts, [0], `${c.name} works in servers only`);
  assert.equal(byName.record!.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(byName.stop!.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(byName.status!.default_member_permissions, undefined);
  assert.equal(byName.record!.options?.[0]?.name, 'channel');
});

test('the invite link asks for slash commands and every permission, Speak included', () => {
  const url = new URL(inviteUrl('999'));
  assert.equal(url.searchParams.get('client_id'), '999');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  const perms = BigInt(url.searchParams.get('permissions')!);
  assert.equal(perms, BOT_PERMISSIONS);
  for (const p of ['ViewChannel', 'SendMessages', 'AttachFiles', 'Connect', 'Speak'] as const) assert.ok(perms & PermissionFlagsBits[p], p);
});
