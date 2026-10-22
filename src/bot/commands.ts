import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { BotControl, RecordingStatus } from './types.js';
import { ENCOUNTER_COMMAND } from './encounterCommand.js';

/**
 * What the bot needs in a server: View Channels, Send Messages and Attach Files (notices and
 * transcripts), Embed Links (the encounter join post), Connect (to record) and Speak (to play music).
 */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak;

/** The link that (re-)adds the bot with slash commands and every permission it needs. */
export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
}

/**
 * /record, /stop and /encounter default to people with Manage Server (who can allow other roles under Server
 * Settings → Integrations); /status is open to everyone, so anyone can check they're being recorded.
 */
export const COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Join a voice channel and start recording')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('Which voice channel (default: the one you are in)').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
    .toJSON(),
  new SlashCommandBuilder().setName('stop').setDescription('Stop recording').setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  new SlashCommandBuilder().setName('status').setDescription('Is this server being recorded, and who is in it?').setContexts(InteractionContextType.Guild).toJSON(),
  ENCOUNTER_COMMAND,
];

export type CommandName = 'record' | 'stop' | 'status';

export interface CommandRequest {
  name: CommandName;
  guildId: string;
  /** The voice channel the person is in, if any. */
  memberVoiceChannelId?: string;
  /** The channel picked in /record's option. */
  channelId?: string;
  /** recording.after_stop, to say what happens next. */
  afterStop?: 'nothing' | 'transcribe' | 'summarize';
  now?: number;
}

const elapsed = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

function describe(rec: RecordingStatus, now: number): string {
  const lines = [`🔴 Recording **#${rec.channelName}** for ${elapsed(now - rec.startedAt)}.`];
  if (rec.participants.length) lines.push(`Recorded: ${rec.participants.map((p) => p.name).join(', ')}.`);
  if (rec.skipped.length) lines.push(`Not recorded: ${rec.skipped.map((p) => p.name).join(', ')}.`);
  return lines.join('\n');
}

/** Runs a slash command against the bot; the answer is shown only to whoever ran it. */
export async function runCommand(req: CommandRequest, bot: Pick<BotControl, 'status' | 'join' | 'stop'>): Promise<string> {
  const now = req.now ?? Date.now();
  const recording = bot.status().recording;
  const elsewhere = recording && recording.guildId !== req.guildId;

  switch (req.name) {
    case 'status':
      if (!recording || elsewhere) return 'Not recording in this server.';
      return describe(recording, now);

    case 'record': {
      if (recording) return elsewhere ? 'The bot is already recording in another server.' : `Already recording **#${recording.channelName}**. Use /stop first.`;
      const channelId = req.channelId ?? req.memberVoiceChannelId;
      if (!channelId) return 'Join a voice channel first, or pick one: `/record channel:`';
      try {
        const started = await bot.join(channelId);
        return `🔴 Recording **#${started.channelName}**. Use /stop when you're done.`;
      } catch (err) {
        return `Couldn't start: ${(err as Error).message}`;
      }
    }

    case 'stop': {
      if (!recording || elsewhere) return 'Not recording in this server.';
      try {
        await bot.stop();
        const next = { nothing: '', transcribe: ' The transcript follows in the app.', summarize: ' The transcript and recap follow in the app.' }[req.afterStop ?? 'transcribe'];
        return `⏹️ Stopped after ${elapsed(now - recording.startedAt)}.${next}`;
      } catch (err) {
        return `Couldn't stop: ${(err as Error).message}`;
      }
    }
  }
}
