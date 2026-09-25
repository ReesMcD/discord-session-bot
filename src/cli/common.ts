import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from '../util/env.js';
import { ConfigError, loadConfig, type LoadedConfig } from '../config/load.js';

/** Resolves a session argument: a path, or a session id under $DATA_DIR/sessions. */
export function resolveSessionDir(arg: string | undefined, usage: string): string {
  if (!arg) die(usage);
  if (existsSync(arg)) return resolve(arg);
  const underData = resolve(process.env.DATA_DIR ?? './data', 'sessions', arg);
  if (existsSync(underData)) return underData;
  die(`Session not found: ${arg}`);
}

export function setup(): LoadedConfig {
  loadDotEnv();
  try {
    const loaded = loadConfig();
    console.log(loaded.path ? `Config: ${loaded.path}` : 'Config: defaults (no config.yaml)');
    return loaded;
  } catch (err) {
    if (err instanceof ConfigError) die(err.message);
    throw err;
  }
}

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
