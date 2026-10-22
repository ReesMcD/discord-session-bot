import type { Character } from '../config/roster.js';
import type { Extraction } from './model.js';

type Combat = Extraction['combats'][number];

function toMs(time: string): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time.trim());
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : 0;
}

const byTime = <T>(time: (x: T) => string) => (a: T, b: T) => toMs(time(a)) - toMs(time(b));
const attr = (s: string) => s.replace(/"/g, "'");

/** The extracted notes from every chunk, grouped by recap section, as the input for the write-up. */
export function formatNotes(notes: readonly Extraction[], include: readonly string[]): string {
  const all = {
    npcs: notes.flatMap((n) => n.npcs).sort(byTime((x) => x.time)),
    locations: notes.flatMap((n) => n.locations).sort(byTime((x) => x.time)),
    events: notes.flatMap((n) => n.events).sort(byTime((x) => x.time)),
    combats: notes.flatMap((n) => n.combats).sort(byTime((x) => x.start)),
    items: notes.flatMap((n) => n.items).sort(byTime((x) => x.time)),
  };
  const named = (xs: typeof all.npcs) => xs.map((x) => `[${x.time}] ${x.name}${x.details.length ? `: ${x.details.join(' / ')}` : ''}`).join('\n');
  const sections: string[] = [];
  if (all.npcs.length) sections.push(`<npcs>\n${named(all.npcs)}\n</npcs>`);
  if (all.locations.length) sections.push(`<locations>\n${named(all.locations)}\n</locations>`);
  if (all.events.length) sections.push(`<events>\n${all.events.map((e) => `[${e.time}] ${e.text}`).join('\n')}\n</events>`);
  if (all.combats.length) {
    const fight = (c: Combat) =>
      `[${c.start}–${c.end}] vs. ${c.opponents.join(', ') || 'unknown'}: ${c.summary}` +
      (c.deaths.length ? ` Died: ${c.deaths.join(', ')}.` : '') +
      (c.kills.length ? ` Killing blows: ${c.kills.map((k) => `${k.by} → ${k.target}`).join(', ')}.` : '');
    sections.push(`<combats>\n${all.combats.map(fight).join('\n')}\n</combats>`);
  }
  include.forEach((rule, i) => {
    const matching = all.items.filter((it) => it.rule === i + 1);
    if (matching.length) sections.push(`<rule number="${i + 1}" text="${attr(rule)}">\n${matching.map((it) => `[${it.time}] ${it.detail}`).join('\n')}\n</rule>`);
  });
  return sections.join('\n\n');
}

export function countNotes(notes: readonly Extraction[]): { npcs: number; locations: number; events: number; combats: number; items: number } {
  const sum = (f: (n: Extraction) => unknown[]) => notes.reduce((t, n) => t + f(n).length, 0);
  return { npcs: sum((n) => n.npcs), locations: sum((n) => n.locations), events: sum((n) => n.events), combats: sum((n) => n.combats), items: sum((n) => n.items) };
}

/**
 * Killing blows per character, most first. Names are matched to the party's characters ignoring
 * case and anything after the name ("Thorin the dwarf" → Thorin); others are kept as written.
 */
export function tallyKills(notes: readonly Extraction[], characters: readonly Pick<Character, 'label'>[] = []): [string, number][] {
  const canonical = (name: string) => {
    const n = name.trim().toLowerCase();
    return characters.find((c) => n === c.label.toLowerCase() || n.startsWith(`${c.label.toLowerCase()} `))?.label ?? name.trim();
  };
  const counts = new Map<string, { name: string; kills: number }>();
  for (const k of notes.flatMap((n) => n.combats.flatMap((c) => c.kills))) {
    if (!k.by.trim()) continue;
    const name = canonical(k.by);
    const entry = counts.get(name.toLowerCase()) ?? { name, kills: 0 };
    entry.kills++;
    counts.set(name.toLowerCase(), entry);
  }
  return [...counts.values()].sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)).map((e) => [e.name, e.kills]);
}

/** The `##` section titled `title` (case-insensitive): [start of heading, end of section). */
function findSection(md: string, title: string): [number, number] | undefined {
  const heading = new RegExp(`^##[ \\t]+${title}[ \\t]*$`, 'im').exec(md);
  if (!heading) return undefined;
  const next = /^##\s/m.exec(md.slice(heading.index + heading[0].length));
  return [heading.index, next ? heading.index + heading[0].length + next.index : md.length];
}

/** Adds "- **Kill count:** Thorin 2, Elara 1" at the end of the Combat section, creating it if needed. */
export function insertKillCount(recap: string, tally: readonly [string, number][]): string {
  // Only the computed count is trusted: drop any the model wrote despite being told not to.
  const md = recap.replace(/^[-*]\s+\*\*Kill count:?\*\*.*(?:\n|$)/gim, '');
  if (!tally.length) return md;
  const bullet = `- **Kill count:** ${tally.map(([name, n]) => `${name} ${n}`).join(', ')}`;
  const combat = findSection(md, 'Combat');
  if (combat) {
    const [, end] = combat;
    return `${md.slice(0, end).trimEnd()}\n${bullet}\n${end < md.length ? `\n${md.slice(end)}` : ''}`;
  }
  // No Combat section: add one after What happened (or at the end).
  const after = findSection(md, 'What happened');
  const at = after ? after[1] : md.length;
  return `${md.slice(0, at).trimEnd()}\n\n## Combat\n\n${bullet}\n${at < md.length ? `\n${md.slice(at)}` : ''}`;
}
