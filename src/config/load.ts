import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface LoadedConfig {
  config: Config;
  /** sha256 of the raw file, recorded with each session so results can be traced to settings. */
  hash: string;
  path: string | undefined;
}

/** Parses and validates YAML config text. Throws ConfigError with a readable message. */
export function parseConfig(text: string, source = 'config'): Omit<LoadedConfig, 'path'> {
  let raw: unknown;
  try {
    // Discord IDs exceed 2^53, so parse integers as BigInt and only narrow the safe ones back to
    // numbers; unquoted IDs (keys or values) then survive as exact strings.
    raw =
      parse(text, (_key, value) => (typeof value === 'bigint' ? (Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()) : value), {
        intAsBigInt: true,
      }) ?? {};
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  const config = result.data;
  if (config.transcript.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.transcript.timezone });
    } catch {
      throw new ConfigError(`${source}: transcript.timezone "${config.transcript.timezone}" is not a valid IANA time zone`);
    }
  }
  return { config, hash: createHash('sha256').update(text).digest('hex') };
}

/**
 * Loads CONFIG_PATH (default ./config.yaml). A missing file means "all defaults",
 * so the bot runs with zero configuration.
 */
export function loadConfig(path = process.env.CONFIG_PATH ?? 'config.yaml'): LoadedConfig {
  const full = resolve(path);
  if (!existsSync(full)) return { ...parseConfig('', 'defaults'), path: undefined };
  return { ...parseConfig(readFileSync(full, 'utf8'), full), path: full };
}
