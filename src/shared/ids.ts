/** IDs of speakers, campaigns and characters in config.yaml: readable slugs made from the name. */
export const ROSTER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** "Thorin Oakenshield" → "thorin-oakenshield"; "thorin-2" if taken. Always starts with a letter. */
export function rosterId(name: string, taken: (id: string) => boolean): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56)
      .replace(/-+$/, '') || 'item';
  const id = /^[a-z]/.test(base) ? base : `x-${base}`;
  if (!taken(id)) return id;
  for (let n = 2; ; n++) if (!taken(`${id}-${n}`)) return `${id}-${n}`;
}
