/** Pure helpers for editing a recap's Markdown (tested in test/recapEditing.test.ts). */

/** summary.md starts with a title and a date/duration block the page already shows. */
export function splitHeader(md: string): { header: string; body: string } {
  if (!md.startsWith('# ')) return { header: '', body: md };
  const rule = /^---[ \t]*$/m.exec(md);
  if (rule) {
    const end = rule.index + rule[0].length;
    return { header: md.slice(0, end), body: md.slice(end).replace(/^\s*\n/, '') };
  }
  const title = /^# .*\n?/.exec(md)!;
  return { header: title[0].trimEnd(), body: md.slice(title[0].length).replace(/^\s*\n/, '') };
}

/** The `## ` section titles, in order. */
export function sectionsOf(md: string): string[] {
  return [...md.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]!);
}

/**
 * Adds a bullet at the end of a `## ` section, creating the section at the end if it's missing.
 * Multi-line notes become one bullet with the extra lines indented under it.
 */
export function appendToSection(md: string, section: string, note: string): string {
  const text = note.trim();
  if (!text) return md;
  const bullet = `- ${text.replace(/^[-*]\s+/, '').replace(/\n/g, '\n  ')}`;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, 'm').exec(md);
  if (!heading) return `${md.trimEnd()}\n\n## ${section}\n\n${bullet}\n`;
  const afterHeading = heading.index + heading[0].length;
  const next = /^##\s/m.exec(md.slice(afterHeading));
  const end = next ? afterHeading + next.index : md.length;
  const rest = md.slice(end);
  return `${md.slice(0, end).trimEnd()}\n${bullet}\n${rest ? `\n${rest}` : ''}`;
}

export interface RecapSection {
  /** The `## ` heading, or '' for anything before the first heading. */
  title: string;
  body: string;
}

/** Splits a recap body into its `## ` sections, so each can be shown as a card. */
export function splitSections(body: string): RecapSection[] {
  const out: RecapSection[] = [];
  let current: RecapSection = { title: '', body: '' };
  for (const line of body.split('\n')) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      if (current.title || current.body.trim()) out.push(current);
      current = { title: heading[1]!, body: '' };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.title || current.body.trim()) out.push(current);
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

/** Pulls the "- **Kill count:** Thorin 2, Elara 1" line out of a section, as [name, kills] pairs. */
export function takeKillCount(body: string): { rest: string; kills: [string, number][] } {
  const m = /^[-*]\s+\*\*Kill count:?\*\*\s*(.+)$/im.exec(body);
  if (!m) return { rest: body, kills: [] };
  const kills = m[1]!
    .split(',')
    .map((part) => /^(.*\S)\s+(\d+)$/.exec(part.trim()))
    .filter((x): x is RegExpExecArray => !!x)
    .map((x): [string, number] => [x[1]!, Number(x[2])]);
  return { rest: body.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim(), kills };
}
