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
