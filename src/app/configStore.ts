import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, isMap, isScalar, parseDocument, YAMLMap } from 'yaml';
import { z } from 'zod';
import { configSchema, explainKeyErrors, type Config } from '../config/schema.js';
import { ConfigError, parseConfig } from '../config/load.js';
import type { ConfigState, FieldError } from '../shared/types.js';

export type { ConfigState, FieldError } from '../shared/types.js';

export class ConfigStore {
  readonly path: string;

  constructor(path = process.env.CONFIG_PATH ?? 'config.yaml') {
    this.path = resolve(path);
  }

  read(): ConfigState {
    const exists = existsSync(this.path);
    const yaml = exists ? readFileSync(this.path, 'utf8') : '';
    try {
      return { path: this.path, exists, yaml, config: parseConfig(yaml, this.path).config, error: null };
    } catch (err) {
      return { path: this.path, exists, yaml, config: null, error: err instanceof ConfigError ? err.message : String(err) };
    }
  }

  /** Validates a full config object; returns field errors (empty when valid). */
  static validate(value: unknown): { config?: Config; errors: FieldError[] } {
    const r = configSchema.safeParse(value);
    if (r.success) return { config: r.data, errors: [] };
    return { errors: explainKeyErrors(r.error).issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }

  /**
   * Saves a config object into the YAML file, changing only the values that differ, so comments
   * and formatting elsewhere in the file survive edits made from the app.
   */
  write(value: unknown): { config?: Config; errors: FieldError[] } {
    const { config, errors } = ConfigStore.validate(value);
    if (!config) return { errors };
    const current = existsSync(this.path) ? readFileSync(this.path, 'utf8') : '';
    // intAsBigInt keeps unquoted Discord IDs (keys like 123456789012345678:) exact.
    const doc = current.trim() ? parseDocument(current, { intAsBigInt: true }) : new Document({});
    if (doc.errors.length || !isMap(doc.contents)) {
      // Unreadable file: start fresh rather than refusing to save.
      writeFileSync(this.path, new Document(withoutDefaults(stripUndefined(value), DEFAULTS) ?? {}).toString());
    } else {
      apply(doc, doc.contents, stripUndefined(value) as Record<string, unknown>, DEFAULTS);
      writeFileSync(this.path, doc.toString());
    }
    return { config, errors: [] };
  }

  /** Saves raw YAML (the "edit as YAML" view) after checking it parses and validates. */
  writeRaw(yaml: string): { errors: FieldError[] } {
    try {
      parseConfig(yaml, 'config');
    } catch (err) {
      return { errors: [{ path: '', message: err instanceof Error ? err.message : String(err) }] };
    }
    writeFileSync(this.path, yaml.endsWith('\n') ? yaml : `${yaml}\n`);
    return { errors: [] };
  }
}

/** Every setting at its default, to tell which values the user actually chose. */
const DEFAULTS = configSchema.parse({}) as unknown as Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `value` without the parts equal to `defaults` (undefined if nothing is left), so saving from the
 * app doesn't pin defaults into the file and later default changes still apply.
 */
function withoutDefaults(value: unknown, defaults: unknown): unknown {
  if (sameValue(value, defaults)) return undefined;
  if (!isPlainObject(value) || !isPlainObject(defaults)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const kept = k in defaults ? withoutDefaults(v, defaults[k]) : v;
    if (kept !== undefined) out[k] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, stripUndefined(x)]));
  }
  return v;
}

function withCommentBefore(doc: Document, key: unknown, comment: string): unknown {
  const node = isScalar(key) ? key : doc.createNode(key);
  node.commentBefore = node.commentBefore ? `${node.commentBefore}\n${comment}` : comment;
  return node;
}

function keyString(key: unknown): string {
  return String(isScalar(key) ? key.value : key);
}

function sameScalar(node: unknown, value: unknown): boolean {
  if (!isScalar(node)) return false;
  return typeof node.value === 'bigint' ? Number(node.value) === value || String(node.value) === value : node.value === value;
}

/**
 * Recursively merges `value` into a YAML map node, deleting keys that are gone. Keys already in the
 * file are always updated; missing keys are only added where they differ from the default.
 */
function apply(doc: Document, map: YAMLMap, value: Record<string, unknown>, defaults: unknown): void {
  const defaultOf = (key: string) => (isPlainObject(defaults) ? defaults[key] : undefined);
  for (const item of [...map.items]) {
    if (!(keyString(item.key) in value)) map.delete(item.key);
  }
  for (const [key, v] of Object.entries(value)) {
    const item = map.items.find((i) => keyString(i.key) === key);
    if (item && isMap(item.value) && v && typeof v === 'object' && !Array.isArray(v)) {
      apply(doc, item.value, v as Record<string, unknown>, defaultOf(key));
    } else if (item && sameScalar(item.value, v)) {
      // unchanged: keep the node (and its comment) as is
    } else if (item) {
      const old = item.value as { comment?: string | null; commentBefore?: string | null } | null;
      const node = doc.createNode(v) as { comment?: string | null; commentBefore?: string | null };
      // Keep the explanatory comment that was on this line ("detail: medium  # low | medium | high").
      // A list or map is written as a block, so its old inline comment goes above it instead.
      if (old?.comment) {
        if (isScalar(node)) node.comment = old.comment;
        else item.key = withCommentBefore(doc, item.key, old.comment);
      }
      if (old?.commentBefore) node.commentBefore = old.commentBefore;
      item.value = node;
    } else {
      const chosen = withoutDefaults(v, defaultOf(key));
      if (chosen !== undefined) map.add(doc.createPair(key, chosen));
    }
  }
}

