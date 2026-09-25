import { spawnSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

export function ffmpeg(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args]);
  return { status: r.status, stderr: r.stderr.toString() };
}
