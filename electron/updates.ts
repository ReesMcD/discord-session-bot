// Updates (#64). The app is ad-hoc signed (no Apple Developer ID), so Electron's built-in updater
// (Squirrel.Mac) can't be used. Instead the app updates itself: it downloads a release asset,
// checks it against the SHA-256 GitHub publishes, builds the new app next to the old one, and a
// small script swaps them once the app has quit, putting the old one back if the new one doesn't
// start. Most releases change only our code, so a small "app" zip (Contents/Resources without
// Electron) is used whenever the installed Electron matches; otherwise the full app zip.
//
// No Electron imports here: the pure parts are unit tested on any OS.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REPO = 'ReesMcD/discord-session-bot';

/** What Contents/Resources holds that the small update replaces (electron-builder.yml decides it). */
export const APP_RESOURCES = ['app.asar', 'app.asar.unpacked', 'web', 'prompts', 'assets'] as const;

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

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** Hex SHA-256, from GitHub's own digest of the uploaded file. */
  sha256: string | null;
}

export interface Release {
  version: string;
  /** The release page, for reading notes or installing by hand. */
  url: string;
  /** The whole app (zip), the small app-code update (zip), and update.json. */
  full: ReleaseAsset | null;
  app: ReleaseAsset | null;
  manifest: ReleaseAsset | null;
}

interface GitHubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
}

/** Looks up the newest GitHub release; returns it only if newer than the running version. */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<Release | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'session-bot' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; assets?: GitHubAsset[] };
  if (!release.tag_name || release.draft || compareVersions(release.tag_name, current) <= 0) return null;
  const assets = (release.assets ?? [])
    .filter((a): a is Required<Pick<GitHubAsset, 'name' | 'browser_download_url'>> & GitHubAsset => !!a.name && !!a.browser_download_url)
    .map((a): ReleaseAsset => ({ name: a.name, url: a.browser_download_url, size: a.size ?? 0, sha256: /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1] ?? null }));
  const find = (re: RegExp) => assets.find((a) => re.test(a.name)) ?? null;
  return {
    version: release.tag_name.replace(/^v/, ''),
    url: release.html_url ?? `https://github.com/${REPO}/releases/latest`,
    full: find(/-arm64-mac\.zip$/),
    app: find(/-app\.zip$/),
    manifest: find(/^update\.json$/),
  };
}

/** update.json: what the release was built with. */
export interface UpdateManifest {
  version: string;
  electron: string;
}

export function parseManifest(raw: unknown): UpdateManifest | null {
  const m = raw as Partial<UpdateManifest> | null;
  return m && typeof m.version === 'string' && typeof m.electron === 'string' ? { version: m.version, electron: m.electron } : null;
}

export type UpdatePlan = { kind: 'app' | 'full'; asset: ReleaseAsset };

/**
 * Which download to install: the small app-code zip when this app's Electron is the one the release
 * was built with, else the full app. Null when neither is there with a checksum to verify against.
 */
export function planUpdate(release: Release, manifest: UpdateManifest | null, installedElectron: string): UpdatePlan | null {
  if (release.app?.sha256 && manifest && manifest.electron === installedElectron) return { kind: 'app', asset: release.app };
  if (release.full?.sha256) return { kind: 'full', asset: release.full };
  return null;
}

/** Downloads to `dest`, refusing anything that doesn't match the published SHA-256. */
export async function downloadVerified(asset: ReleaseAsset, dest: string, fetchImpl: typeof fetch = fetch, onProgress?: (fraction: number) => void): Promise<void> {
  if (!asset.sha256) throw new Error(`${asset.name} has no published checksum`);
  const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'session-bot' }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const hash = createHash('sha256');
  let received = 0;
  const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (asset.size) onProgress?.(Math.min(1, received / asset.size));
  });
  await pipeline(counted, createWriteStream(dest));
  const got = hash.digest('hex');
  if (got !== asset.sha256) throw new Error(`The download doesn't match its checksum (expected ${asset.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…): not installed`);
}

/** Single-quotes for bash. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell commands that build the new app in `staging` from a verified zip: the full app as is,
 * or a copy of this app with its Resources replaced. Then the version in Info.plist, an ad-hoc
 * signature (the bundle changed), and no quarantine flag.
 */
export function stageCommands(o: { kind: 'app' | 'full'; zip: string; currentApp: string; staging: string; version: string }): string[][] {
  const app = `${o.staging}/Session Bot.app`;
  const resources = `${app}/Contents/Resources`;
  const steps: string[][] = [['/bin/rm', '-rf', o.staging], ['/bin/mkdir', '-p', o.staging]];
  if (o.kind === 'full') steps.push(['/usr/bin/ditto', '-x', '-k', o.zip, o.staging]);
  else {
    steps.push(['/usr/bin/ditto', o.currentApp, app]);
    steps.push(['/bin/rm', '-rf', ...APP_RESOURCES.map((r) => `${resources}/${r}`)]);
    steps.push(['/usr/bin/ditto', '-x', '-k', o.zip, resources]);
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) steps.push(['/usr/bin/plutil', '-replace', key, '-string', o.version, `${app}/Contents/Info.plist`]);
  }
  steps.push(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', app]);
  steps.push(['/usr/bin/xattr', '-cr', app]);
  return steps;
}

/**
 * The script that runs after the app quits: swap the new app in, start it, and if it hasn't said
 * it started (written its version to `marker`) within a minute, put the old one back.
 */
export function swapScript(o: { pid: number; appPath: string; newApp: string; previous: string; marker: string; version: string }): string {
  return `#!/bin/bash
set -u
APP=${q(o.appPath)}
NEW=${q(o.newApp)}
OLD=${q(o.previous)}
MARK=${q(o.marker)}
while /bin/kill -0 ${o.pid} 2>/dev/null; do /bin/sleep 0.5; done
/bin/rm -rf "$OLD"
if ! /bin/mv "$APP" "$OLD"; then /usr/bin/open "$APP"; exit 1; fi
if ! /bin/mv "$NEW" "$APP"; then /bin/mv "$OLD" "$APP"; /usr/bin/open "$APP" --args --update-failed; exit 1; fi
/bin/rm -f "$MARK"
/usr/bin/open "$APP"
for i in $(/usr/bin/seq 1 120); do
  if /usr/bin/grep -qx ${q(o.version)} "$MARK" 2>/dev/null; then /bin/rm -rf "$OLD"; exit 0; fi
  /bin/sleep 0.5
done
# The new version didn't start: put the old one back.
/usr/bin/pkill -f "$APP/Contents/MacOS/" 2>/dev/null
/bin/sleep 1
/bin/rm -rf "$APP"
/bin/mv "$OLD" "$APP"
/usr/bin/open "$APP" --args --update-failed
`;
}

/** The .app bundle this executable is in (…/Session Bot.app), or null when not running from one. */
export function bundlePath(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}
