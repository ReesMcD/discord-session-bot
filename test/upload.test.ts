import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type Config } from '../src/config/schema.js';
import { paths, writeJson } from '../src/session/layout.js';
import { saveRecapEdit } from '../src/summary/recapEdits.js';
import { testUpload, uploadRecap, uploadStatus } from '../src/upload/recapUpload.js';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { pipelineRunner } from '../src/app/steps.js';

const T0 = Date.UTC(2026, 9, 20, 19, 2, 11);
const CHANNEL = '222222222222222222';
const RECAP = '# Recap: Curse of Strahd\n\n---\n\n## NPCs\n\n- Strahd\n';
const noSleep = async () => {};

interface Received {
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local endpoint: answers each request with the next handler (the last one repeats). */
async function fakeEndpoint(...handlers: ((res: ServerResponse) => void)[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ method: req.method!, headers: req.headers, body });
      (handlers[received.length - 1] ?? handlers.at(-1)!)(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/recaps`, received, close: () => server.close() };
}

const ok = (json?: unknown) => (res: ServerResponse) => {
  if (json) res.setHeader('content-type', 'application/json');
  res.end(json ? JSON.stringify(json) : '');
};
const fail = (status: number, text = '') => (res: ServerResponse) => ((res.statusCode = status), res.end(text));

function session(upload: Partial<Config['upload']>) {
  const dir = join(mkdtempSync(join(tmpdir(), 'upload-')), 'sessions', 's1');
  writeJson(paths.session(dir), { id: 's1', startedAt: T0, stoppedAt: T0 + 3_600_000, channelId: CHANNEL, channelName: 'game-night' });
  writeFileSync(join(dir, 'summary.md'), RECAP);
  const config = configSchema.parse({ upload, campaigns: { [CHANNEL]: { name: 'Curse of Strahd' } }, transcript: { timezone: 'UTC' } });
  return { dir, config };
}

test('uploads the recap as JSON with the key, then remembers when and where', async () => {
  const wiki = await fakeEndpoint(ok({ url: 'https://wiki.example/sessions/s1' }));
  try {
    const { dir, config } = session({ url: wiki.url });
    const status = await uploadRecap(dir, config, 'secret-token', { sleep: noSleep });

    const [req] = wiki.received;
    assert.equal(req!.method, 'POST');
    assert.equal(req!.headers.authorization, 'Bearer secret-token');
    assert.match(String(req!.headers['idempotency-key']), /^s1-[0-9a-f]{16}$/);
    assert.deepEqual(JSON.parse(req!.body), {
      id: 's1',
      title: 'Curse of Strahd — 2026-10-20',
      date: '2026-10-20',
      startedAt: '2026-10-20T19:02:11.000Z',
      stoppedAt: '2026-10-20T20:02:11.000Z',
      campaign: 'Curse of Strahd',
      channel: 'game-night',
      edited: false,
      markdown: RECAP,
    });
    assert.equal(status.url, 'https://wiki.example/sessions/s1');
    assert.equal(status.changedSince, false);
  } finally {
    wiki.close();
  }
});

test('sends the edited recap, and flags edits made after the upload', async () => {
  const wiki = await fakeEndpoint(ok());
  try {
    const { dir, config } = session({ url: wiki.url });
    saveRecapEdit(dir, `${RECAP}\n- Ireena\n`);
    await uploadRecap(dir, config, 'k', { sleep: noSleep });
    const sent = JSON.parse(wiki.received[0]!.body);
    assert.equal(sent.edited, true);
    assert.match(sent.markdown, /Ireena/);
    assert.equal(uploadStatus(dir)!.changedSince, false);

    saveRecapEdit(dir, `${RECAP}\n- Ireena\n- Ismark\n`);
    assert.equal(uploadStatus(dir)!.changedSince, true);
    await uploadRecap(dir, config, 'k', { sleep: noSleep });
    assert.notEqual(wiki.received[1]!.headers['idempotency-key'], wiki.received[0]!.headers['idempotency-key'], 'new content, new key');
    assert.equal(JSON.parse(wiki.received[1]!.body).id, 's1', 'same session, same id');
  } finally {
    wiki.close();
  }
});

test('retries after a 5xx and succeeds', async () => {
  const wiki = await fakeEndpoint(fail(503, 'busy'), ok());
  try {
    const { dir, config } = session({ url: wiki.url });
    const logs: string[] = [];
    await uploadRecap(dir, config, 'k', { sleep: noSleep, log: (m) => logs.push(m) });
    assert.equal(wiki.received.length, 2);
    assert.ok(logs.some((l) => l.includes('503') && l.includes('retry 1')));
    assert.ok(uploadStatus(dir));
  } finally {
    wiki.close();
  }
});

test('a refused key fails at once, saying so, and records nothing', async () => {
  const wiki = await fakeEndpoint(fail(401, 'bad token'));
  try {
    const { dir, config } = session({ url: wiki.url });
    await assert.rejects(uploadRecap(dir, config, 'wrong', { sleep: noSleep }), /401 the endpoint refused the key \(bad token\)/);
    assert.equal(wiki.received.length, 1, 'not retried');
    assert.equal(uploadStatus(dir), null);
  } finally {
    wiki.close();
  }
});

test('markdown format: front matter, then the recap; a custom key header', async () => {
  const wiki = await fakeEndpoint((res) => ((res.statusCode = 201), res.setHeader('location', '/pages/s1'), res.end()));
  try {
    const { dir, config } = session({ url: wiki.url, method: 'PUT', format: 'markdown', auth: 'header', header_name: 'X-Wiki-Key' });
    const status = await uploadRecap(dir, config, 'k', { sleep: noSleep });
    const req = wiki.received[0]!;
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers['x-wiki-key'], 'k');
    assert.equal(req.headers.authorization, undefined);
    assert.match(String(req.headers['content-type']), /^text\/markdown/);
    const [, front, body] = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(req.body)!;
    assert.equal(parse(front!).title, 'Curse of Strahd — 2026-10-20');
    assert.equal(body, RECAP);
    assert.equal(status.url, `${new URL(wiki.url).origin}/pages/s1`, 'a relative Location resolves against the endpoint');
  } finally {
    wiki.close();
  }
});

test('a page link that is not http(s) is ignored', async () => {
  const wiki = await fakeEndpoint(ok({ url: 'javascript:alert(1)' }));
  try {
    const { dir, config } = session({ url: wiki.url });
    assert.equal((await uploadRecap(dir, config, 'k', { sleep: noSleep })).url, undefined);
  } finally {
    wiki.close();
  }
});

test('a missing key or address is explained before anything is sent', async () => {
  const { dir, config } = session({ url: 'https://wiki.example/x' });
  await assert.rejects(uploadRecap(dir, config, undefined), /upload key is missing/);
  const off = session({});
  await assert.rejects(uploadRecap(off.dir, off.config, 'k'), /Set the upload address/);
  const open = session({ url: 'https://wiki.example/x', auth: 'none' });
  assert.equal(open.config.upload.auth, 'none');
});

test('test connection sends {"test": true} once and reports the result', async () => {
  const wiki = await fakeEndpoint(ok(), fail(500));
  try {
    const settings = configSchema.parse({ upload: { url: wiki.url } }).upload;
    assert.deepEqual(await testUpload(settings, 'k'), { ok: true, status: 200, message: 'Connected (200)' });
    assert.deepEqual(JSON.parse(wiki.received[0]!.body), { test: true });
    const failed = await testUpload(settings, 'k');
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 500);
    assert.equal(wiki.received.length, 2, 'not retried');
  } finally {
    wiki.close();
  }
});

test('the upload step runs as a job and the session shows its status', async () => {
  const wiki = await fakeEndpoint(ok({ url: 'https://wiki.example/s1' }));
  const previous = process.env.WIKI_UPLOAD_TOKEN;
  process.env.WIKI_UPLOAD_TOKEN = 'env-key';
  try {
    const { dir } = session({});
    const dataDir = join(dir, '..', '..');
    const configPath = join(dataDir, 'config.yaml');
    writeFileSync(configPath, `upload:\n  url: ${wiki.url}\n`);
    const jobs = new JobRunner(pipelineRunner({ dataDir, configPath, sleep: noSleep }));
    const api = createApi({ password: 'pw', dataDir, configStore: new ConfigStore(configPath), jobs });
    const auth = { Authorization: 'Bearer pw', 'Content-Type': 'application/json' };

    assert.equal((await api.request('/sessions/s1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ step: 'upload' }) })).status, 202);
    await jobs.idle();
    assert.equal(wiki.received[0]!.headers.authorization, 'Bearer env-key');
    const detail = (await (await api.request('/sessions/s1', { headers: auth })).json()) as { upload: { url: string }; uploadTo: string };
    assert.equal(detail.upload.url, 'https://wiki.example/s1');
    assert.equal(detail.uploadTo, new URL(wiki.url).host);

    const tested = await api.request('/upload/test', { method: 'POST', headers: auth, body: JSON.stringify({ upload: { url: wiki.url } }) });
    assert.equal(((await tested.json()) as { ok: boolean }).ok, true);
    assert.equal((await api.request('/upload/test', { method: 'POST', headers: auth, body: JSON.stringify({ upload: { url: 'ftp://x' } }) })).status, 400);
  } finally {
    if (previous === undefined) delete process.env.WIKI_UPLOAD_TOKEN;
    else process.env.WIKI_UPLOAD_TOKEN = previous;
    wiki.close();
  }
});
