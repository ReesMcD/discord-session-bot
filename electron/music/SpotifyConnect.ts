import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_FRAMES, FrameChunker, SPOTIFY_RATE, findLibrespot, librespotArgs, parseLibrespotLine } from '../../src/music/spotify.js';
import type { SpotifyStatus } from '../../src/music/control.js';

export interface SpotifyConnectOptions {
  /** The speaker's name in the Spotify app. */
  name: string;
  /** Where the login and settings are kept. */
  dir: string;
  /** Each chunk of audio: interleaved float32 stereo at 44.1 kHz. */
  onAudio: (chunk: Buffer) => void;
  onChange: () => void;
  log: (msg: string) => void;
}

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Quiet this long and it counts as paused. */
const IDLE_MS = 1500;
/** How much audio may be sent ahead of time to the mixer. */
const MAX_AHEAD_MS = 1000;

/**
 * Runs librespot (Spotify Connect) while turned on, restarting it if it stops, and passes its
 * audio on. On by default once librespot is installed; the choice and volume are remembered.
 */
export class SpotifyConnect {
  private child: ChildProcess | undefined;
  private readonly chunker = new FrameChunker();
  private settings = { enabled: true, volume: 0.8, muted: false };
  private track: string | null = null;
  private error: string | undefined;
  private lastAudio = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;
  /** Wall-clock time the audio sent so far runs out, to pace librespot (its pipe isn't real-time). */
  private aheadUntil = 0;

  constructor(private readonly opts: SpotifyConnectOptions) {
    mkdirSync(opts.dir, { recursive: true });
    try {
      this.settings = { ...this.settings, ...(JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<typeof this.settings>) };
    } catch {
      /* first run */
    }
  }

  private get settingsFile() {
    return join(this.opts.dir, 'settings.json');
  }

  get volume(): number {
    return this.settings.muted ? 0 : this.settings.volume;
  }

  status(): SpotifyStatus {
    const binary = findLibrespot(process.env.PATH, isExecutable);
    const state: SpotifyStatus['state'] = !binary
      ? 'missing'
      : !this.settings.enabled
        ? 'off'
        : this.error && !this.child
          ? 'error'
          : Date.now() - this.lastAudio < IDLE_MS
            ? 'playing'
            : 'ready';
    return { state, device: this.opts.name, track: this.track, volume: this.settings.volume, muted: this.settings.muted, ...(state === 'error' && this.error ? { error: this.error } : {}) };
  }

  start(): void {
    this.stopped = false;
    if (this.settings.enabled) this.launch();
  }

  update(patch: { enabled?: boolean; volume?: number; muted?: boolean }): void {
    this.settings = { ...this.settings, ...patch };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings));
    if (patch.enabled === true && !this.child) {
      this.failures = 0;
      this.error = undefined;
      this.launch();
    }
    if (patch.enabled === false) this.kill();
    this.opts.onChange();
  }

  stop(): void {
    this.stopped = true;
    this.kill();
  }

  private launch(): void {
    clearTimeout(this.restartTimer);
    const binary = findLibrespot(process.env.PATH, isExecutable);
    if (!binary || this.child || this.stopped) return;
    const child = spawn(binary, librespotArgs(this.opts.name, join(this.opts.dir, 'cache')), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RUST_LOG: 'info' } });
    this.child = child;
    this.chunker.reset();
    child.stdout!.on('data', (data: Buffer) => {
      for (const chunk of this.chunker.push(data)) {
        this.opts.onAudio(chunk);
        const now = Date.now();
        this.aheadUntil = Math.max(now, this.aheadUntil) + (CHUNK_FRAMES / SPOTIFY_RATE) * 1000;
      }
      // More than ~a second ahead: stop reading, so the pipe fills and librespot waits.
      const ahead = this.aheadUntil - Date.now();
      if (ahead > MAX_AHEAD_MS && !child.stdout!.isPaused()) {
        child.stdout!.pause();
        setTimeout(() => child.stdout?.resume(), ahead - MAX_AHEAD_MS / 2);
      }
      const wasPlaying = Date.now() - this.lastAudio < IDLE_MS;
      this.lastAudio = Date.now();
      this.failures = 0;
      if (!wasPlaying) this.opts.onChange();
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.opts.onChange(), IDLE_MS + 50);
    });
    let partial = '';
    child.stderr!.on('data', (data: Buffer) => {
      const lines = (partial + data.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseLibrespotLine(line);
        if (!event) continue;
        if (event.kind === 'track') this.track = event.title;
        if (event.kind === 'error') {
          this.error = event.message;
          this.opts.log(`spotify: ${event.message}`);
        }
        if (event.kind === 'connected') this.error = undefined;
        this.opts.onChange();
      }
    });
    child.on('error', (err) => {
      this.error = err.message;
      this.opts.log(`spotify: couldn't start librespot: ${err.message}`);
    });
    child.on('exit', (code) => {
      this.child = undefined;
      if (this.stopped || !this.settings.enabled) return this.opts.onChange();
      // Restart, backing off if it keeps failing (a bad install shouldn't spin).
      this.failures++;
      this.error ??= `librespot stopped (exit ${code ?? 'signal'})`;
      this.opts.log(`spotify: librespot stopped (exit ${code}); restarting`);
      this.opts.onChange();
      this.restartTimer = setTimeout(() => this.launch(), Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5)));
    });
    this.opts.onChange();
  }

  private kill(): void {
    clearTimeout(this.restartTimer);
    clearTimeout(this.idleTimer);
    this.child?.kill();
    this.child = undefined;
    this.lastAudio = 0;
  }
}
