import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config/schema.js';
import { paths, writeJson } from '../src/session/layout.js';
import { recapSummary, toWikiSession, wikiBody, WIKI_MAX_BYTES } from '../src/upload/ardentWeave.js';
import { testUpload, uploadRecap } from '../src/upload/recapUpload.js';

/** The fields the wiki's /api/sessions accepts (dnd-wiki mcp/src/ingest.ts); anything else is a 400. */
const WIKI_FIELDS = new Set(['campaign', 'date', 'number', 'summary', 'body', 'sections', 'players_present', 'in_world_date', 'location', 'transcript', 'source_id', 'visibility', 'dry_run']);

const CHANNEL = '222222222222222222';
const RECAP = `# Recap: Crimson Tide

- **Date:** Oct 24, 2026, 7:00 PM
- **Duration:** 03:00:00

---

**The party drove the Redbrands out of the Sleeping Giant.**

## NPCs
- **Tobin**: the barkeep. [00:12:00]

## What happened
- Arrived in Phandalin. [00:01:00]

## Combat
- **vs. Redbrands**: three fled.

## Quests, hooks and open threads
- Find Glasstaff.
`;

function session(recap = RECAP, transcript = '[00:00:01] Aria: We go to the inn.\n', campaignName: string | null = 'Crimson Tide') {
  const dir = join(mkdtempSync(join(tmpdir(), 'aw-')), 'sessions', 's1');
  writeJson(paths.session(dir), { id: 's1', startedAt: Date.UTC(2026, 9, 24, 19), channelId: CHANNEL, channelName: 'game-night' });
  writeJson(paths.segments(dir), { lines: [{ speaker: 'Aria' }, { speaker: 'Brom' }, { speaker: 'Aria' }] });
  writeFileSync(paths.transcript(dir), transcript);
  writeFileSync(join(dir, 'summary.md'), recap);
  const config = configSchema.parse({
    campaigns: { [CHANNEL]: campaignName ? { name: campaignName } : {} },
    transcript: { timezone: 'UTC' },
    upload: { url: 'https://wiki.example/api/sessions', format: 'ardent-weave' },
  });
  return { dir, config };
}

test('the wiki request: its own fields only, summary on its own, headings renamed to its template', () => {
  const { dir, config } = session();
  const wiki = toWikiSession(dir, config, { id: 's1', date: '2026-10-24', markdown: RECAP });
  assert.deepEqual(Object.keys(wiki).filter((k) => !WIKI_FIELDS.has(k)), [], 'unknown fields are a 400 at the wiki');
  assert.equal(wiki.campaign, 'Crimson Tide');
  assert.equal(wiki.date, '2026-10-24');
  assert.equal(wiki.source_id, 's1');
  assert.equal(wiki.summary, 'The party drove the Redbrands out of the Sleeping Giant.');
  assert.deepEqual(wiki.players_present, ['Aria', 'Brom']);
  assert.equal(wiki.transcript, '[00:00:01] Aria: We go to the inn.\n');
  assert.equal(
    wiki.body,
    '## NPCs Met\n- **Tobin**: the barkeep. [00:12:00]\n\n## Events\n- Arrived in Phandalin. [00:01:00]\n\n## Combat\n- **vs. Redbrands**: three fled.\n\n## Quest Updates\n- Find Glasstaff.',
  );
});

test('older recaps without a summary line: the first event, without its timestamp, else the date', () => {
  const old = RECAP.replace('**The party drove the Redbrands out of the Sleeping Giant.**\n\n', '');
  assert.equal(recapSummary(old, '2026-10-24'), 'Arrived in Phandalin.');
  assert.equal(recapSummary('## NPCs\n- **Tobin**\n', '2026-10-24'), 'Session on 2026-10-24');
  assert.ok(!wikiBody(old).startsWith('**'));
});

test('a transcript too big for the wiki is left out and the recap still goes', () => {
  const { dir, config } = session(RECAP, 'x'.repeat(WIKI_MAX_BYTES));
  const logs: string[] = [];
  const wiki = toWikiSession(dir, config, { id: 's1', date: '2026-10-24', markdown: RECAP }, (m) => logs.push(m));
  assert.equal(wiki.transcript, undefined);
  assert.match(logs.join('\n'), /transcript is left out/);
});

test('a session whose channel has no campaign name says how to fix it', () => {
  const { dir, config } = session(RECAP, '', null);
  assert.throws(() => toWikiSession(dir, config, { id: 's1', date: '2026-10-24', markdown: RECAP }), /no campaign name.*Settings → Campaigns/);
});

/** A local stand-in that answers like the wiki: JSON errors as {"error": …}. */
async function fakeWiki(answer: (body: Record<string, unknown>, req: IncomingMessage) => [number, unknown]) {
  const seen: { body: Record<string, unknown>; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, auth: req.headers.authorization });
      const [status, json] = answer(body, req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions`, seen, close: () => server.close() };
}

test('uploading in the wiki format: a bearer key always, the page link from its answer, its error messages as is', async () => {
  const wiki = await fakeWiki((body) =>
    body.campaign === 'Crimson Tide' ? [201, { path: 'Campaigns/Crimson Tide/Sessions/Session Recap 001 - 2026-10-24.md', url: 'https://dm.example/S1', number: 1, created: true }] : [400, { error: `No campaign named "${body.campaign}".` }],
  );
  try {
    const { dir, config } = session();
    config.upload.url = wiki.url;
    config.upload.auth = 'none'; // the wiki always needs its token, whatever this says
    const status = await uploadRecap(dir, config, 'k'.repeat(32), { sleep: async () => {} });
    assert.equal(wiki.seen[0]!.auth, `Bearer ${'k'.repeat(32)}`);
    assert.equal(status.url, 'https://dm.example/S1');

    config.campaigns[CHANNEL]!.name = 'Crimson Tyde';
    await assert.rejects(uploadRecap(dir, config, 'k', { sleep: async () => {} }), /400 Bad Request \(No campaign named "Crimson Tyde"\.\)/);
  } finally {
    wiki.close();
  }
});

test('test connection in the wiki format is a dry run for a campaign, which checks its name', async () => {
  const wiki = await fakeWiki((body) => (body.campaign === 'Crimson Tide' ? [200, { path: 'Campaigns/Crimson Tide/Sessions/Session Recap 004 - 2026-10-21.md', dry_run: true }] : [400, { error: `No campaign named "${body.campaign}".` }]));
  try {
    const settings = configSchema.parse({ upload: { url: wiki.url, format: 'ardent-weave' } }).upload;
    const ok = await testUpload(settings, 'k', fetch, 'Crimson Tide');
    assert.equal(ok.ok, true);
    assert.match(ok.message, /Crimson Tide/);
    assert.equal(wiki.seen[0]!.body.dry_run, true);
    assert.deepEqual(Object.keys(wiki.seen[0]!.body).filter((k) => !WIKI_FIELDS.has(k)), []);
    assert.equal((await testUpload(settings, 'k', fetch, 'Crimson Tyde')).message, '400 Bad Request (No campaign named "Crimson Tyde".)');
    assert.match((await testUpload(settings, 'k', fetch)).message, /Name a campaign/);
  } finally {
    wiki.close();
  }
});
