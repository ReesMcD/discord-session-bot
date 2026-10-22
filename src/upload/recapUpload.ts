import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { campaignFor } from '../config/campaign.js';
import { sessionTitle } from '../session/title.js';
import type { Config } from '../config/schema.js';
import { readJson, readSessionInfo, writeJson } from '../session/layout.js';
import type { RecapUpload, UploadTestResult } from '../shared/types.js';
import { readRecap, recapState } from '../summary/recapEdits.js';
import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from '../util/retry.js';
import { toWikiSession, wikiConnectionTest, type WikiSession } from './ardentWeave.js';

/** The upload key's environment variable (the Mac app sets it from the Keychain). */
export const UPLOAD_TOKEN_ENV = 'WIKI_UPLOAD_TOKEN';

type UploadSettings = Config['upload'];

/** What's sent: the recap as it is now (hand edits included) plus enough to name and file the page. */
export interface RecapPayload {
  /** The session ID: the same session always updates the same page. */
  id: string;
  title: string;
  /** YYYY-MM-DD in transcript.timezone. */
  date: string;
  startedAt: string;
  stoppedAt?: string;
  campaign?: string;
  channel?: string;
  /** True when the recap was edited by hand after it was generated. */
  edited: boolean;
  markdown: string;
}

/** Saved in the session after a successful upload. */
interface UploadRecord {
  uploadedAt: string;
  status: number;
  url?: string;
  /** Hash of the Markdown sent, to tell when the recap changed since. */
  hash: string;
}

const recordPath = (sessionDir: string) => join(sessionDir, 'summary', 'upload.json');
const hashOf = (markdown: string) => createHash('sha256').update(markdown).digest('hex');
const TIMEOUT_MS = 30_000;

export function buildPayload(sessionDir: string, config: Config): RecapPayload {
  const markdown = readRecap(sessionDir);
  if (!markdown) throw new Error('This session has no recap yet');
  const info = readSessionInfo(sessionDir);
  const campaign = campaignFor(config, info)?.name;
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(config.transcript.timezone ? { timeZone: config.transcript.timezone } : {}) }).format(info.startedAt);
  return {
    id: info.id,
    title: sessionTitle(info, config),
    date,
    startedAt: new Date(info.startedAt).toISOString(),
    ...(info.stoppedAt ? { stoppedAt: new Date(info.stoppedAt).toISOString() } : {}),
    ...(campaign ? { campaign } : {}),
    ...(info.channelName ? { channel: info.channelName } : {}),
    edited: recapState(sessionDir) === 'edited',
    markdown,
  };
}

/** The address and the key's header. The Ardent Weave endpoint always takes a bearer token. */
function baseRequest(settings: UploadSettings, token: string | undefined): { url: string; headers: Record<string, string> } {
  if (!settings.url) throw new Error('Set the upload address first (Settings → Upload)');
  const headers: Record<string, string> = { 'User-Agent': 'ScryingEye' };
  const auth = settings.format === 'ardent-weave' ? 'bearer' : settings.auth;
  if (auth !== 'none') {
    if (!token) throw new Error(`The upload key is missing: add it under Settings → Keys (Mac app) or as ${UPLOAD_TOKEN_ENV} in .env`);
    if (auth === 'bearer') headers.Authorization = `Bearer ${token}`;
    else headers[settings.header_name] = token;
  }
  return { url: settings.url, headers };
}

/** The Ardent Weave wiki's /api/sessions request (always a JSON POST). */
export function buildWikiRequest(session: WikiSession, settings: UploadSettings, token: string | undefined): { url: string; init: RequestInit } {
  const { url, headers } = baseRequest(settings, token);
  headers['Content-Type'] = 'application/json';
  return { url, init: { method: 'POST', headers, body: JSON.stringify(session) } };
}

/** The HTTP request for a payload: JSON, or Markdown with the other fields as YAML front matter. */
export function buildRequest(payload: RecapPayload | { test: true }, settings: UploadSettings, token: string | undefined): { url: string; init: RequestInit } {
  const { url, headers } = baseRequest(settings, token);
  let body: string;
  if ('markdown' in payload) {
    // Retries of the same content are the same request; an edited recap is a new one.
    headers['Idempotency-Key'] = `${payload.id}-${hashOf(payload.markdown).slice(0, 16)}`;
    if (settings.format === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    } else {
      const { markdown, ...meta } = payload;
      headers['Content-Type'] = 'text/markdown; charset=utf-8';
      body = `---\n${stringify(meta).trimEnd()}\n---\n\n${markdown}`;
    }
  } else if (settings.format === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  } else {
    headers['Content-Type'] = 'text/markdown; charset=utf-8';
    body = '---\ntest: true\n---\n\nConnection test from Scrying Eye. Nothing to save.\n';
  }
  return { url, init: { method: settings.method, headers, body } };
}

export interface SendOptions extends Pick<RetryOptions, 'sleep'> {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => Date;
}

/** Sends one request; non-2xx responses become HttpErrors so withRetry can decide. */
async function send(request: { url: string; init: RequestInit }, doFetch: typeof fetch): Promise<Response> {
  const res = await doFetch(request.url, { ...request.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.ok) return res;
  const raw = (await res.text().catch(() => '')).trim();
  // A JSON {"error": "..."} (the wiki's style) reads better as just its message.
  let text = raw.slice(0, 200);
  try {
    const error = (JSON.parse(raw) as { error?: unknown }).error;
    if (typeof error === 'string') text = error.slice(0, 300);
  } catch {
    /* not JSON: keep the start of the text */
  }
  const reason = res.status === 401 || res.status === 403 ? 'the endpoint refused the key' : res.statusText || 'request failed';
  throw new HttpError(res.status, `Upload failed: ${res.status} ${reason}${text ? ` (${text})` : ''}`, parseRetryAfter(res.headers.get('retry-after')));
}

/** A link to the page, if the endpoint gave one (a Location header or a JSON "url"); http(s) only. */
async function pageUrl(res: Response): Promise<string | undefined> {
  let candidate = res.headers.get('location') ?? undefined;
  if (!candidate && res.headers.get('content-type')?.includes('application/json')) {
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (typeof body?.url === 'string') candidate = body.url;
  }
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate, res.url || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Uploads the session's current recap, retrying network errors and 5xx, and records the result. */
export async function uploadRecap(sessionDir: string, config: Config, token: string | undefined, opts: SendOptions = {}): Promise<RecapUpload> {
  const log = opts.log ?? (() => {});
  const payload = buildPayload(sessionDir, config);
  const request =
    config.upload.format === 'ardent-weave'
      ? buildWikiRequest(toWikiSession(sessionDir, config, { id: payload.id, date: payload.date, markdown: payload.markdown }, log), config.upload, token)
      : buildRequest(payload, config.upload, token);
  log(`Uploading "${payload.title}"${payload.edited ? ' (edited)' : ''} to ${new URL(request.url).host}`);
  const res = await withRetry(() => send(request, opts.fetch ?? fetch), {
    retries: 3,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    onRetry: (err, attempt, delay) => log(`  ${(err as Error).message}; retry ${attempt} in ${Math.round(delay / 1000)}s`),
  });
  const url = await pageUrl(res);
  const record: UploadRecord = { uploadedAt: (opts.now?.() ?? new Date()).toISOString(), status: res.status, ...(url ? { url } : {}), hash: hashOf(payload.markdown) };
  writeJson(recordPath(sessionDir), record);
  log(`Uploaded (${res.status})${url ? `: ${url}` : ''}`);
  return uploadStatus(sessionDir)!;
}

/** When the recap was last uploaded, and whether it changed since. */
export function uploadStatus(sessionDir: string): RecapUpload | null {
  const record = readJson<UploadRecord>(recordPath(sessionDir));
  if (!record) return null;
  const markdown = readRecap(sessionDir);
  return { uploadedAt: record.uploadedAt, ...(record.url ? { url: record.url } : {}), changedSince: markdown !== null && hashOf(markdown) !== record.hash };
}

/**
 * Sends a test request once, without retrying, and reports what came back: { "test": true }, or
 * for the Ardent Weave wiki a dry run for `campaign`, which also checks the campaign name.
 */
export async function testUpload(settings: UploadSettings, token: string | undefined, doFetch: typeof fetch = fetch, campaign?: string): Promise<UploadTestResult> {
  try {
    if (settings.format === 'ardent-weave') {
      if (!campaign) return { ok: false, message: 'Name a campaign under Settings → Campaigns first, spelled as the wiki’s campaign is' };
      const res = await send(buildWikiRequest(wikiConnectionTest(campaign), settings, token), doFetch);
      const path = ((await res.json().catch(() => ({}))) as { path?: unknown }).path;
      return { ok: true, status: res.status, message: `Connected: recaps for "${campaign}" will be filed in its Sessions folder${typeof path === "string" ? ` (next: ${path.split("/").pop()})` : ""}` };
    }
    const res = await send(buildRequest({ test: true }, settings, token), doFetch);
    return { ok: true, status: res.status, message: `Connected (${res.status})` };
  } catch (err) {
    const status = err instanceof HttpError ? err.status : undefined;
    const message = err instanceof HttpError ? err.message.replace(/^Upload failed: /, '') : `Couldn't reach it: ${(err as Error).message}`;
    return { ok: false, ...(status ? { status } : {}), message };
  }
}
