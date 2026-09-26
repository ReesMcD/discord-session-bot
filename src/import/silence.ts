import { spawn } from 'node:child_process';

export interface Region {
  startSec: number;
  endSec: number;
}

/** Parses ffmpeg `silencedetect` output (stderr) into silence regions. */
export function parseSilenceDetect(stderr: string, totalSec: number): Region[] {
  const silences: Region[] = [];
  let open: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start: (-?[\d.]+)/.exec(line);
    if (start) open = Math.max(0, Number(start[1]));
    const end = /silence_end: ([\d.]+)/.exec(line);
    if (end) {
      silences.push({ startSec: open ?? 0, endSec: Number(end[1]) });
      open = undefined;
    }
  }
  // Silence that runs to the end of the file has a start but no end.
  if (open !== undefined) silences.push({ startSec: open, endSec: totalSec });
  return silences;
}

export interface SpeechOptions {
  /** Keep this much audio either side of detected speech, so word edges aren't clipped. */
  padSec: number;
  /** Speech regions shorter than this are dropped (clicks, breaths). */
  minSec: number;
  /** Regions closer than this are joined into one utterance. */
  joinGapSec: number;
}

/** The complement of the silences: where someone is talking, padded and cleaned up. */
export function speechRegions(silences: readonly Region[], totalSec: number, opts: SpeechOptions): Region[] {
  const sorted = [...silences].sort((a, b) => a.startSec - b.startSec);
  const raw: Region[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.startSec > cursor) raw.push({ startSec: cursor, endSec: s.startSec });
    cursor = Math.max(cursor, s.endSec);
  }
  if (cursor < totalSec) raw.push({ startSec: cursor, endSec: totalSec });

  const out: Region[] = [];
  for (const r of raw) {
    const padded = { startSec: Math.max(0, r.startSec - opts.padSec), endSec: Math.min(totalSec, r.endSec + opts.padSec) };
    const prev = out.at(-1);
    if (prev && padded.startSec - prev.endSec <= opts.joinGapSec) prev.endSec = Math.max(prev.endSec, padded.endSec);
    else out.push(padded);
  }
  return out.filter((r) => r.endSec - r.startSec >= opts.minSec + 2 * opts.padSec);
}

function run(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.once('error', reject);
    proc.once('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`))));
  });
}

/** Runs ffmpeg silencedetect over a whole track; returns silences and the track length. */
export async function detectSilence(
  file: string,
  { noiseDb = -45, minSilenceSec = 0.8 } = {},
  ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg',
): Promise<{ silences: Region[]; totalSec: number }> {
  const stderr = await run(ffmpegPath, ['-hide_banner', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, '-f', 'null', '-']);
  // The final progress line reports how much audio was decoded ("time=01:02:03.45").
  const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  const durationMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const m = last ?? durationMatch;
  const totalSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { silences: parseSilenceDetect(stderr, totalSec), totalSec };
}

/** Cuts [startSec, endSec) out of a track into an Ogg Opus file. */
export async function extractOpus(file: string, region: Region, outFile: string, ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg'): Promise<void> {
  await run(ffmpegPath, [
    '-v', 'error', '-y',
    '-ss', region.startSec.toFixed(3),
    '-t', (region.endSec - region.startSec).toFixed(3),
    '-i', file,
    '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
    outFile,
  ]);
}
