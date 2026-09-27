export const REPO = 'ReesMcD/discord-session-bot';

/** Compares dotted versions ("v0.3.1" vs "0.3.0"); returns >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Looks up the newest GitHub release; returns it only if newer than the running version. */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<{ version: string; url: string } | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'session-bot' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean };
  if (!release.tag_name || release.draft || compareVersions(release.tag_name, current) <= 0) return null;
  return { version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? `https://github.com/${REPO}/releases/latest` };
}
