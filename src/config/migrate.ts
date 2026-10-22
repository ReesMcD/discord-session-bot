import { rosterId } from '../shared/ids.js';

/**
 * Before 0.5, config.yaml tied everything to Discord: `speakers` was keyed by Discord account,
 * `campaigns` by voice channel, and each campaign's `characters` by the account of whoever played
 * them. This reads that shape into the current one, where speakers, campaigns and characters
 * stand on their own and point at each other. Anything else passes through untouched; the app
 * writes the new shape the next time settings are saved.
 */
export function migrateRoster(raw: unknown): unknown {
  if (!isObject(raw) || !isLegacy(raw)) return raw;
  const oldSpeakers = isObject(raw.speakers) ? raw.speakers : {};
  const oldCampaigns = isObject(raw.campaigns) ? raw.campaigns : {};

  const speakers: Record<string, Speaker> = {};
  const campaigns: Record<string, Campaign> = {};
  const characters: Record<string, Character> = {};

  /** The speaker with this name (any case), else a new one. */
  const speakerNamed = (name: string): string => {
    const found = Object.entries(speakers).find(([, s]) => s.name.toLowerCase() === name.toLowerCase());
    if (found) return found[0];
    const id = rosterId(name, (x) => x in speakers);
    speakers[id] = { name, discord: [] };
    return id;
  };
  const link = (speakerId: string, account: string) => {
    const s = speakers[speakerId]!;
    if (!s.discord.includes(account)) s.discord.push(account);
  };
  const speakersOn = (account: string) => Object.keys(speakers).filter((id) => speakers[id]!.discord.includes(account));

  for (const [account, v] of Object.entries(oldSpeakers)) {
    if (typeof v === 'string') link(speakerNamed(v), account);
    else if (isObject(v) && Array.isArray(v.disambiguate)) {
      // A shared account: each identity becomes a speaker on it.
      for (const text of v.disambiguate.filter((t): t is string => typeof t === 'string')) {
        const { label, rest } = splitLabel(text);
        const id = speakerNamed(label);
        link(id, account);
        if (rest && !speakers[id]!.description) speakers[id]!.description = rest;
      }
    } else if (isObject(v) && typeof v.name === 'string') link(speakerNamed(v.name), account);
  }

  for (const [channel, c] of Object.entries(oldCampaigns)) {
    if (!isObject(c)) continue;
    const name = typeof c.name === 'string' && c.name.trim() ? c.name : `Campaign ${Object.keys(campaigns).length + 1}`;
    const campaignId = rosterId(name, (x) => x in campaigns);
    campaigns[campaignId] = {
      name,
      ...(typeof c.context === 'string' ? { context: c.context } : {}),
      ...(typeof c.dndbeyond === 'number' ? { dndbeyond: c.dndbeyond } : {}),
      channels: [channel],
    };
    for (const [account, entry] of Object.entries(isObject(c.characters) ? c.characters : {})) {
      const ch = readCharacter(entry);
      if (!ch) continue;
      let players = speakersOn(account);
      if (!players.length) {
        players = [speakerNamed(isGameMaster(ch.name) ? 'DM' : `${ch.name}’s player`)];
        link(players[0]!, account);
      }
      if (isGameMaster(ch.name)) {
        // "DM" was written as a character; it's a role.
        for (const id of players) {
          const about = [speakers[id]!.description, ch.description].filter(Boolean).join(', ');
          speakers[id]!.description = about ? `DM, ${about}` : 'DM';
        }
        continue;
      }
      // On a shared account, the speaker whose own account it is (listed there first) plays it.
      const player = players.length === 1 ? players[0] : players.find((id) => speakers[id]!.discord[0] === account);
      characters[rosterId(ch.name, (x) => x in characters)] = { ...ch, campaign: campaignId, ...(player ? { speaker: player } : {}) };
    }
    for (const guest of Array.isArray(c.guests) ? c.guests : []) {
      const account = String(guest);
      if (speakersOn(account).length) continue;
      link(speakerNamed(`Guest ${account.slice(-4)}`), account);
    }
  }

  return { ...raw, speakers, campaigns, characters: { ...(isObject(raw.characters) ? raw.characters : {}), ...characters } };
}

interface Speaker {
  name: string;
  discord: string[];
  description?: string;
}
interface Campaign {
  name: string;
  context?: string;
  dndbeyond?: number;
  channels: string[];
}
interface Character {
  name: string;
  description?: string;
  dndbeyond?: number;
  campaign?: string;
  speaker?: string;
}

const DISCORD_ID = /^\d{15,22}$/;

/** The old shape: campaigns keyed by voice channel or with `characters`/`guests`, speakers keyed by Discord ID. */
function isLegacy(raw: Record<string, unknown>): boolean {
  const campaigns = isObject(raw.campaigns) ? Object.entries(raw.campaigns) : [];
  if (campaigns.some(([key, c]) => DISCORD_ID.test(key) || (isObject(c) && ('characters' in c || 'guests' in c)))) return true;
  const speakers = isObject(raw.speakers) ? Object.entries(raw.speakers) : [];
  return speakers.some(([key, v]) => typeof v === 'string' || (isObject(v) && 'disambiguate' in v) || (DISCORD_ID.test(key) && isObject(v) && !('discord' in v)));
}

/** "DM — narrates the world" → label "DM", rest "narrates the world". */
function splitLabel(text: string): { label: string; rest?: string } {
  const m = /^(.+?)\s+[—–-]\s+(.*)$|^(.+?):\s*(.*)$/.exec(text.trim());
  const label = (m?.[1] ?? m?.[3] ?? text).trim();
  const rest = (m?.[2] ?? m?.[4])?.trim();
  return rest ? { label, rest } : { label };
}

function readCharacter(entry: unknown): Omit<Character, 'campaign' | 'speaker'> | null {
  if (typeof entry === 'string') {
    const { label, rest } = splitLabel(entry);
    return label ? { name: label, ...(rest ? { description: rest } : {}) } : null;
  }
  if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return null;
  return {
    name: entry.name,
    ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
    ...(typeof entry.dndbeyond === 'number' ? { dndbeyond: entry.dndbeyond } : {}),
  };
}

const isGameMaster = (name: string) => /^(dm|gm|dungeon master|game master)$/i.test(name.trim());

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
