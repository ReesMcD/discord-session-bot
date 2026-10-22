import { existsSync, readFileSync } from 'node:fs';
import { campaignFor } from '../config/campaign.js';
import type { Config } from '../config/schema.js';
import { paths, readJson, readSessionInfo } from '../session/layout.js';
import type { TranscriptLine } from '../shared/types.js';

/**
 * The Ardent Weave wiki's session recorder endpoint (`POST /api/sessions` in ReesMcD/dnd-wiki,
 * mcp/src/ingest.ts). It files the recap as `Sessions/Session Recap NNN - <date>` and the
 * transcript as a DM-only log, marked for "process session". It rejects unknown fields, so this
 * sends exactly its contract.
 */
export interface WikiSession {
  campaign: string;
  /** YYYY-MM-DD */
  date: string;
  /** The recap's bold one-line summary. */
  summary: string;
  body: string;
  /** The recording's id: posting it again updates the same page. */
  source_id: string;
  players_present?: string[];
  transcript?: string;
  dry_run?: boolean;
}

/** The wiki refuses bodies over 512 KB; leave room for the JSON around the text. */
export const WIKI_MAX_BYTES = 500 * 1024;

/** Our recap headings → the wiki recap template's (`_templates/session-recap.md`). Others are kept. */
const HEADINGS: Record<string, string> = {
  npcs: 'NPCs Met',
  'what happened': 'Events',
  'loot, rewards and purchases': 'Loot & Rewards',
  'quests, hooks and open threads': 'Quest Updates',
};

/** The recap without the app's own header (`# Recap: …`, date, duration, speakers, `---`). */
function withoutHeader(markdown: string): string {
  if (!markdown.startsWith('# ')) return markdown;
  const rule = /^---[ \t]*$/m.exec(markdown);
  return rule ? markdown.slice(rule.index + rule[0].length) : markdown.replace(/^# .*\n?/, '');
}

/**
 * The bold one-line summary the recap starts with (recap prompt v3). Older recaps have none:
 * then the first point under "What happened", else a dated placeholder.
 */
export function recapSummary(markdown: string, date: string): string {
  const body = withoutHeader(markdown).trim();
  const bold = /^\*\*(.+?)\*\*\s*$/m.exec(body.split(/\n##\s/)[0] ?? '');
  if (bold) return bold[1]!.trim();
  const happened = /^##[ \t]+what happened[ \t]*\n+\s*[-*\d.]+\s+(.+)$/im.exec(body);
  const first = happened?.[1]?.replace(/\s*\[\d{1,2}:\d{2}:\d{2}\]/g, '').replace(/\*\*/g, '').trim();
  if (first) return first.length > 200 ? `${first.slice(0, 197).trimEnd()}…` : first;
  return `Session on ${date}`;
}

/** The recap's sections for the wiki: no header, no summary line, headings renamed to the template's. */
export function wikiBody(markdown: string): string {
  const body = withoutHeader(markdown).trim().replace(/^\*\*.+\*\*[ \t]*\n+/, '');
  return body.replace(/^##[ \t]+(.+?)[ \t]*$/gm, (line, title: string) => {
    const mapped = HEADINGS[title.toLowerCase()];
    return mapped ? `## ${mapped}` : line;
  });
}

/** Builds the wiki's request body from a session folder. The transcript is left out if it won't fit. */
export function toWikiSession(sessionDir: string, config: Config, recap: { id: string; date: string; markdown: string }, log: (msg: string) => void = () => {}): WikiSession {
  const info = readSessionInfo(sessionDir);
  const campaign = campaignFor(config, info)?.name;
  if (!campaign) {
    throw new Error("This session's voice channel has no campaign name. Set it under Settings → Campaigns, spelled as the wiki's campaign is.");
  }
  const lines = readJson<{ lines: TranscriptLine[] }>(paths.segments(sessionDir))?.lines ?? [];
  const players = [...new Set(lines.map((l) => l.speaker))];
  const session: WikiSession = {
    campaign,
    date: recap.date,
    summary: recapSummary(recap.markdown, recap.date),
    body: wikiBody(recap.markdown),
    source_id: recap.id,
    ...(players.length ? { players_present: players } : {}),
  };
  const transcriptFile = [paths.cleanTranscript(sessionDir), paths.transcript(sessionDir)].find((f) => existsSync(f));
  if (transcriptFile) {
    const withTranscript = { ...session, transcript: readFileSync(transcriptFile, 'utf8') };
    if (Buffer.byteLength(JSON.stringify(withTranscript)) <= WIKI_MAX_BYTES) return withTranscript;
    log('  The transcript is left out: it is over the wiki’s 512 KB limit (the recap is sent)');
  }
  return session;
}

/** A dry run the wiki checks but doesn't save: proves the address, the key and the campaign name. */
export function wikiConnectionTest(campaign: string, now = new Date()): WikiSession {
  return {
    campaign,
    date: now.toISOString().slice(0, 10),
    summary: 'Connection test from Scrying Eye',
    body: '',
    source_id: 'scrying-eye-connection-test',
    dry_run: true,
  };
}
