import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { pipelineRunner } from '../src/app/steps.js';
import { paths, writeJson } from '../src/session/layout.js';

const PASSWORD = 'correct horse battery';
const T0 = Date.UTC(2026, 8, 27, 1);
const REES = '123456789012345678';

function setup(configYaml = '') {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.yaml');
  if (configYaml) writeFileSync(configPath, configYaml);
  const dir = join(dataDir, 'sessions', 'game-1');
  writeJson(paths.session(dir), { id: 'game-1', startedAt: T0, stoppedAt: T0 + 60_000, channelName: 'dnd' });
  writeJson(paths.participants(dir), { [REES]: { displayName: 'rees_d' } });
  // Transcript lines, as mergeSession would write them.
  writeJson(paths.transcriptsDir(dir) + '/' + REES + '.json', {
    userId: REES,
    transcriber: 'fake',
    segments: [{ startMs: T0 + 1000, endMs: T0 + 3000, text: 'Hello table.', utteranceStartMs: T0 + 1000 }],
    dropped: [],
  });
  const configStore = new ConfigStore(configPath);
  const jobs = new JobRunner(pipelineRunner({ dataDir, configPath }));
  const api = createApi({ password: PASSWORD, dataDir, configStore, jobs, keys: () => ({ anthropic: false }) });
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    api.request(path, { ...init, headers: { ...(auth ? { Authorization: `Bearer ${PASSWORD}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  return { root, dataDir, dir, configPath, jobs, req };
}

test('every route needs the password', async () => {
  const { req } = setup();
  assert.equal((await req('/health', {}, false)).status, 401);
  assert.equal((await req('/health', { headers: { Authorization: 'Bearer wrong' } }, false)).status, 401);
  const ok = await req('/health');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, keys: { anthropic: false } });
});

test('lists sessions and rejects path tricks', async () => {
  const { req } = setup();
  const list = (await (await req('/sessions')).json()) as { id: string; has: Record<string, boolean>; speakers: string[] }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'game-1');
  assert.deepEqual(list[0]!.has, { audio: false, transcript: false, speakerLabels: false, summary: false });
  assert.deepEqual(list[0]!.speakers, []);
  assert.equal((await req('/sessions/..%2F..%2Fetc')).status, 404);
  assert.equal((await req('/sessions/nope')).status, 404);
});

test('runs a pipeline step as a job and exposes its log', async () => {
  const { req, jobs, dir } = setup(`speakers:\n  ${REES}: Rees\n`);
  const res = await req('/sessions/game-1/jobs', { method: 'POST', body: JSON.stringify({ step: 'merge' }) });
  assert.equal(res.status, 202);
  const job = (await res.json()) as { id: string };
  await jobs.idle();
  const done = (await (await req(`/jobs/${job.id}`)).json()) as { status: string; logs: string[] };
  assert.equal(done.status, 'done');
  assert.match(done.logs.join('\n'), /Transcript rebuilt: 1 lines, 1 speakers/);
  assert.match(readFileSync(paths.transcript(dir), 'utf8'), /\[00:00:01\] Rees: Hello table\./);

  const detail = (await (await req('/sessions/game-1')).json()) as { lines: { speaker: string }[]; jobs: unknown[]; has: { transcript: boolean } };
  assert.equal(detail.lines[0]!.speaker, 'Rees');
  assert.equal(detail.has.transcript, true);
  assert.equal(detail.jobs.length, 1);

  assert.equal((await req('/sessions/game-1/jobs', { method: 'POST', body: JSON.stringify({ step: 'rm -rf' }) })).status, 400);
});

test('failed steps report a useful error', async () => {
  const { req, jobs } = setup();
  const job = (await (await req('/sessions/game-1/jobs', { method: 'POST', body: JSON.stringify({ step: 'disambiguate' }) })).json()) as { id: string };
  await jobs.idle();
  const done = (await (await req(`/jobs/${job.id}`)).json()) as { status: string; error: string };
  assert.equal(done.status, 'failed');
  assert.match(done.error, /No shared accounts configured/);
});

test('config edits keep comments, key order and exact Discord IDs', async () => {
  const yaml = [
    '# My settings',
    'recording:',
    '  ignore_users: []  # music bot goes here',
    '  silence_ms: 1000',
    '',
    'speakers:',
    `  ${REES}: Rees   # unquoted ID`,
    '',
    'summary:',
    '  detail: medium  # low | medium | high',
    '',
  ].join('\n');
  const { req, configPath } = setup(yaml);
  const state = (await (await req('/config')).json()) as { config: any; error: null };
  assert.equal(state.error, null);
  assert.equal(state.config.speakers[REES], 'Rees');

  const next = structuredClone(state.config);
  next.summary.detail = 'high';
  next.recording.ignore_users = ['234395307759108106'];
  next.speakers['223456789012345678'] = { name: 'Sam', disambiguate: ['DM — narrates', 'Thorin — a dwarf'] };
  const saved = await req('/config', { method: 'PUT', body: JSON.stringify({ config: next }) });
  assert.equal(saved.status, 200);

  const written = readFileSync(configPath, 'utf8');
  assert.match(written, /^# My settings\n/);
  assert.match(written, /silence_ms: 1000/);
  assert.match(written, new RegExp(`${REES}: Rees +# unquoted ID`));
  assert.match(written, /detail: high +# low \| medium \| high/);
  assert.match(written, /music bot goes here/);
  assert.match(written, /"234395307759108106"/);
  assert.match(written, /"223456789012345678":\n\s+name: Sam\n\s+disambiguate:\n\s+- DM — narrates/);
  const reread = (await (await req('/config')).json()) as { config: any };
  assert.equal(reread.config.speakers[REES], 'Rees');
  assert.deepEqual(reread.config.recording.ignore_users, ['234395307759108106']);
});

test('invalid config is rejected with field paths; raw YAML can be saved', async () => {
  const { req, configPath } = setup('summary:\n  detail: low\n');
  const state = (await (await req('/config')).json()) as { config: any };
  const bad = { ...state.config, summary: { ...state.config.summary, detail: 'extreme' } };
  const res = await req('/config', { method: 'PUT', body: JSON.stringify({ config: bad }) });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errors: { path: string }[] };
  assert.equal(body.errors[0]!.path, 'summary.detail');

  assert.equal((await req('/config', { method: 'PUT', body: JSON.stringify({ yaml: 'summary: [oops' }) })).status, 400);
  assert.equal((await req('/config', { method: 'PUT', body: JSON.stringify({ yaml: '# raw\nsummary:\n  detail: high\n' }) })).status, 200);
  assert.equal(readFileSync(configPath, 'utf8'), '# raw\nsummary:\n  detail: high\n');
});

test('prompts: custom versions are validated, saved to a folder config points at, and removable', async () => {
  const { req, root, configPath } = setup('summary:\n  detail: low\n');
  const cwd = process.cwd();
  process.chdir(root); // the default prompts folder is relative to where the app runs
  try {
    const list = (await (await req('/prompts')).json()) as { dir: null; prompts: { name: string; custom: null; builtIn: string }[] };
    assert.equal(list.dir, null);
    assert.deepEqual(list.prompts.map((p) => p.name), ['disambiguate', 'cleanup', 'extract', 'synthesize', 'audit', 'revise']);
    assert.match(list.prompts.find((p) => p.name === 'extract')!.builtIn, /\{\{include_rules\}\}/);

    const bad = await req('/prompts/extract', { method: 'PUT', body: JSON.stringify({ text: 'Use {{typo}}' }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /unknown placeholder \{\{typo\}\}.*\{\{include_rules\}\}/);

    const ok = await req('/prompts/extract', { method: 'PUT', body: JSON.stringify({ text: 'Rules:\n{{include_rules}}' }) });
    assert.equal(ok.status, 200);
    assert.match(readFileSync(configPath, 'utf8'), /prompts_dir: prompts\.local/);
    assert.ok(existsSync(join(root, 'prompts.local', 'extract.md')));

    const after = (await (await req('/prompts/extract', { method: 'DELETE' })).json()) as { prompts: { name: string; custom: string | null }[] };
    assert.equal(after.prompts.find((p) => p.name === 'extract')!.custom, null);
  } finally {
    process.chdir(cwd);
  }
});

test('people from past sessions, and file downloads', async () => {
  const { req, jobs } = setup(`speakers:\n  ${REES}: Rees\n`);
  assert.deepEqual(await (await req('/people')).json(), [{ id: REES, names: ['rees_d'], sessions: 1, lastSeen: T0 }]);
  assert.equal((await req('/sessions/game-1/files/transcript.md')).status, 404);
  await req('/sessions/game-1/jobs', { method: 'POST', body: JSON.stringify({ step: 'merge' }) });
  await jobs.idle();
  const file = await req('/sessions/game-1/files/transcript.md');
  assert.equal(file.status, 200);
  assert.match(await file.text(), /Rees: Hello table\./);
  assert.equal((await req('/sessions/game-1/files/..%2Fsecret')).status, 404);
});

test('the recap can be edited: saved, generated copy kept, refused while it is being regenerated', async () => {
  const { req, dir, jobs } = setup();
  const put = (markdown: unknown) => req('/sessions/game-1/summary', { method: 'PUT', body: JSON.stringify({ markdown }) });
  assert.equal((await put('# Recap')).status, 400, 'no recap yet');
  writeFileSync(join(dir, 'summary.md'), '# Recap: game-1\n\n## NPCs\n\n- Strahd\n');

  assert.equal((await put(42)).status, 400);
  const res = await put('# Recap: game-1\n\n## NPCs\n\n- Strahd\n- Ireena\n');
  assert.equal(res.status, 200);
  const detail = (await res.json()) as { summary: string; recapState: string; editedAt: string };
  assert.equal(detail.recapState, 'edited');
  assert.match(detail.summary, /- Ireena/);
  assert.ok(detail.editedAt);
  assert.match(readFileSync(join(dir, 'summary', 'generated.md'), 'utf8'), /- Strahd\n$/);
  assert.equal((await req('/sessions/nope/summary', { method: 'PUT', body: '{}' })).status, 404);

  // While a summarize job is queued or running, edits are refused (it would overwrite them).
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const busy = new JobRunner(async () => blocked);
  const api = createApi({ password: PASSWORD, dataDir: join(dir, '..', '..'), configStore: new ConfigStore(join(dir, 'none.yaml')), jobs: busy });
  busy.enqueue('game-1', 'summarize');
  const refused = await api.request('/sessions/game-1/summary', { method: 'PUT', headers: { Authorization: `Bearer ${PASSWORD}` }, body: JSON.stringify({ markdown: 'x' }) });
  assert.equal(refused.status, 409);
  release();
  await busy.idle();
  await jobs.idle();
});

test('replacing an inline list keeps its comment, above the key', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const file = join(root, 'config.yaml');
  writeFileSync(file, 'recording:\n  ignore_users: []   # music bot goes here\n');
  const store = new ConfigStore(file);
  const config = store.read().config!;
  config.recording.ignore_users = ['423456789012345678'];
  assert.deepEqual(store.write(config).errors, []);
  assert.match(readFileSync(file, 'utf8'), /^recording:\n  # music bot goes here\n  ignore_users:\n    - "423456789012345678"\n/);
});
