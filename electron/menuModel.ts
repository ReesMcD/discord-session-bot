import type { BotStatus, GuildInfo } from '../src/bot/types.js';
import type { SessionSummary } from '../src/app/sessions.js';

/** A plain description of the menu bar dropdown; main.ts turns it into an Electron Menu. */
export interface MenuItem {
  label?: string;
  type?: 'separator' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  action?: MenuAction;
  submenu?: MenuItem[];
}

export type MenuAction =
  | { kind: 'join'; channelId: string }
  | { kind: 'stop' }
  | { kind: 'open'; route?: string }
  | { kind: 'toggleLogin' }
  | { kind: 'update'; url: string }
  | { kind: 'checkUpdates' }
  | { kind: 'quit' };

export interface MenuState {
  bot: BotStatus;
  guilds: GuildInfo[];
  recent: SessionSummary[];
  openAtLogin: boolean;
  update: { version: string; url: string } | null;
  now: number;
  missingKeys: string[];
}

export function elapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const sep: MenuItem = { type: 'separator' };

function channelItems(guild: GuildInfo): MenuItem[] {
  const channels = [...guild.channels].sort((a, b) => b.members.length - a.members.length);
  return channels.map((c) => {
    const people = c.members.filter((m) => !m.bot).map((m) => m.name);
    return {
      label: people.length ? `${c.name} — ${people.slice(0, 3).join(', ')}${people.length > 3 ? ` +${people.length - 3}` : ''}` : c.name,
      action: { kind: 'join', channelId: c.id },
    };
  });
}

export function buildMenu(s: MenuState): MenuItem[] {
  const items: MenuItem[] = [];
  const rec = s.bot.recording;

  if (s.missingKeys.length) {
    items.push({ label: `⚠︎ Set up: ${s.missingKeys.join(', ')}…`, action: { kind: 'open', route: 'settings/keys' } }, sep);
  }

  if (rec) {
    const verb = rec.state === 'recording' ? 'Recording' : rec.state === 'reconnecting' ? 'Reconnecting' : rec.state === 'connecting' ? 'Connecting' : 'Stopping';
    items.push({ label: `● ${verb} #${rec.channelName} — ${elapsed(s.now - rec.startedAt)}`, enabled: false });
    for (const p of rec.participants) items.push({ label: `    ${p.speaking ? '🗣' : '·'} ${p.name}`, enabled: false });
    if (rec.participants.length === 0) items.push({ label: '    Nobody has spoken yet', enabled: false });
    items.push({ label: 'Stop Recording', action: { kind: 'stop' }, enabled: rec.state !== 'stopping' }, { label: 'Show Recording…', action: { kind: 'open', route: 'record' } });
  } else if (s.bot.state === 'ready') {
    const guilds = s.guilds.filter((g) => g.channels.length);
    if (guilds.length === 0) items.push({ label: 'No voice channels (invite the bot to a server)', enabled: false });
    else if (guilds.length === 1) items.push({ label: 'Join & Record', submenu: channelItems(guilds[0]!) });
    else items.push({ label: 'Join & Record', submenu: guilds.map((g) => ({ label: g.name, submenu: channelItems(g) })) });
  } else {
    const label = s.bot.state === 'connecting' ? 'Connecting to Discord…' : s.bot.state === 'error' ? `Discord: ${s.bot.error ?? 'error'}` : 'Discord bot is off';
    items.push({ label, enabled: false });
  }

  items.push(sep, { label: 'Open Session Bot', action: { kind: 'open' } });
  if (s.recent.length) {
    items.push({
      label: 'Recent Sessions',
      submenu: s.recent.slice(0, 6).map((r) => ({
        label: `${r.channelName ? `#${r.channelName}` : r.id} · ${new Date(r.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${r.has.summary ? ' ✓' : ''}`,
        action: { kind: 'open', route: `sessions/${encodeURIComponent(r.id)}` },
      })),
    });
  }
  items.push({ label: 'Settings…', action: { kind: 'open', route: 'settings' } }, sep);
  items.push({ label: 'Open at Login', type: 'checkbox', checked: s.openAtLogin, action: { kind: 'toggleLogin' } });
  items.push(s.update ? { label: `Update Available (${s.update.version})…`, action: { kind: 'update', url: s.update.url } } : { label: 'Check for Updates', action: { kind: 'checkUpdates' } });
  items.push(sep, { label: 'Quit Session Bot', action: { kind: 'quit' } });
  return items;
}
