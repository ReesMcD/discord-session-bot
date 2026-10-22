/**
 * Spotify Connect for the music mix (Mac app). Spotify's web player needs DRM the app's browser
 * doesn't have, so instead the app runs librespot (an open-source Spotify Connect receiver,
 * `brew install librespot`, Spotify Premium only): it shows up in the Spotify app as a speaker
 * named after the app, and whatever you play to it is mixed into the voice channel like a tab.
 */

/** Where Homebrew and friends put it; apps opened from Finder don't get the shell's PATH. */
export const LIBRESPOT_PATHS = ['/opt/homebrew/bin/librespot', '/usr/local/bin/librespot', '/opt/local/bin/librespot'];

/** librespot's pipe output: interleaved 32-bit float stereo at Spotify's 44.1 kHz. */
export const SPOTIFY_RATE = 44_100;
export const SPOTIFY_CHANNELS = 2;
const BYTES_PER_FRAME = 4 * SPOTIFY_CHANNELS;
/** ~93 ms per chunk sent to the mixer: few messages, short enough to start quickly. */
export const CHUNK_FRAMES = 4096;

export function findLibrespot(pathEnv: string | undefined, isExecutable: (path: string) => boolean): string | undefined {
  const fromPath = (pathEnv ?? '')
    .split(':')
    .filter(Boolean)
    .map((dir) => `${dir.replace(/\/$/, '')}/librespot`);
  return [...LIBRESPOT_PATHS, ...fromPath].find(isExecutable);
}

/** The command line: a Connect speaker that writes its audio to stdout, remembering the login in `cacheDir`. */
export function librespotArgs(name: string, cacheDir: string): string[] {
  return [
    '--name',
    name,
    '--backend',
    'pipe',
    '--format',
    'F32',
    '--bitrate',
    '320',
    '--device-type',
    'avr',
    '--initial-volume',
    '100',
    '--cache',
    cacheDir,
    '--disable-audio-cache',
  ];
}

export type LibrespotEvent = { kind: 'track'; title: string } | { kind: 'connected' } | { kind: 'error'; message: string };

/**
 * What a librespot log line says, if anything we show: the track it's loading, a new session
 * (someone picked this speaker), or an error. Its log format isn't an API, so this only looks for
 * phrases that have been stable for years and ignores everything else.
 */
export function parseLibrespotLine(line: string): LibrespotEvent | null {
  const loading = /Loading <(.+?)> with Spotify URI/.exec(line);
  if (loading) return { kind: 'track', title: loading[1]! };
  if (/Authenticated as|New session|Connecting to AP/.test(line) && !/ERROR/.test(line)) return { kind: 'connected' };
  const error = /\bERROR\b[^\]]*\]\s*(.+)$/.exec(line);
  if (error) return { kind: 'error', message: error[1]!.trim() };
  if (/Premium|premium account/i.test(line) && /required|not/i.test(line)) return { kind: 'error', message: 'Spotify Connect needs a Spotify Premium account' };
  return null;
}

/** Cuts a byte stream into whole chunks of CHUNK_FRAMES frames (the pipe delivers arbitrary pieces). */
export class FrameChunker {
  private pending: Buffer = Buffer.alloc(0);
  private readonly size = CHUNK_FRAMES * BYTES_PER_FRAME;

  push(data: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const out: Buffer[] = [];
    while (this.pending.length >= this.size) {
      out.push(Buffer.from(this.pending.subarray(0, this.size)));
      this.pending = this.pending.subarray(this.size);
    }
    return out;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}
