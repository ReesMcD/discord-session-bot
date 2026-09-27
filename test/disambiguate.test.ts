import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseConfig } from '../src/config/load.js';
import { parseIdentity, sharedAccounts, speakerNames } from '../src/config/schema.js';
import { paths, writeJson } from '../src/session/layout.js';
import { disambiguateLines, disambiguateSession } from '../src/summary/disambiguate.js';
import { AnthropicSummaryModel, type CallOptions, type Labels, type SummaryModel } from '../src/summary/model.js';
import { summarizeSession, summaryPaths } from '../src/summary/summarizeSession.js';
import { mergeSegments, type TranscriptLine } from '../src/transcript/merge.js';

const T0 = Date.UTC(2026, 8, 26, 0);
const REES = '111111111111111111';
const SAM = '222222222222222222';
const MUSIC = '333333333333333333';

const CONFIG = `
transcript:
  timezone: UTC
speakers:
  "${REES}":
    name: Rees
    disambiguate:
      - "DM — narrates the world and NPCs"
      - "Hamqueef — a player character"
  "${SAM}": Sam
summary:
  context: "Weekly D&D game."
`;

const line = (sec: number, userId: string, speaker: string, text: string): TranscriptLine => ({
  userId,
  speaker,
  offsetMs: sec * 1000,
  startMs: T0 + sec * 1000,
  endMs: T0 + sec * 1000 + 3000,
  text,
});

const LINES = [
  line(1, REES, 'Rees', 'You enter a dusty tavern. The innkeeper eyes you.'),
  line(5, SAM, 'Sam', 'I ask the innkeeper about the missing caravan.'),
  line(9, REES, 'Rees', '"Caravan? Never heard of it," he mutters.'),
  line(13, REES, 'Rees', 'Hamqueef slams a gold coin on the bar. Talk.'),
  line(17, REES, 'Rees', 'Yeah.'),
  line(21, SAM, 'Sam', 'Nice.'),
  line(25, REES, 'Rees', 'Mystery line.'),
];

/** Labels by line number: 1 = DM, 2 = Hamqueef. */
class FakeLabeller implements SummaryModel {
  calls: CallOptions[] = [];
  constructor(private readonly labels: Labels['labels']) {}
  async disambiguate(opts: CallOptions) {
    this.calls.push(opts);
    return { value: { labels: this.labels }, model: 'claude-test', usage: { inputTokens: 500, outputTokens: 40 } };
  }
  async extract(opts: CallOptions) {
    this.extractCalls.push(opts);
    return { value: { items: [] }, model: 'claude-test', usage: { inputTokens: 1, outputTokens: 1 } };
  }
  extractCalls: CallOptions[] = [];
  async synthesize() {
    return { value: 'unused', model: 'claude-test', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

test('config: shared speakers accept identities; plain names still work; labels come from the hint', () => {
  const { config } = parseConfig(CONFIG);
  assert.deepEqual(speakerNames(config), { [REES]: 'Rees', [SAM]: 'Sam' });
  assert.deepEqual(
    sharedAccounts(config).get(REES)?.map((i) => i.label),
    ['DM', 'Hamqueef'],
  );
  assert.equal(sharedAccounts(config).has(SAM), false);
  assert.deepEqual(parseIdentity('Thorin: the dwarf'), { label: 'Thorin', description: 'Thorin: the dwarf' });
  assert.deepEqual(parseIdentity('Narrator'), { label: 'Narrator', description: 'Narrator' });
  assert.equal(parseIdentity('Jean-Luc - the captain').label, 'Jean-Luc');
  assert.throws(() => parseConfig(`speakers:\n  "${REES}":\n    disambiguate: ["only one"]`), /at least two/);
});

test('merge keeps shared-account lines separate so each can be relabelled', () => {
  const seg = (sec: number, text: string) => ({ startMs: T0 + sec * 1000, endMs: T0 + sec * 1000 + 1000, text, utteranceStartMs: T0 });
  const bySpeaker = new Map([
    [REES, [seg(0, 'One.'), seg(1.5, 'Two.')]],
    [SAM, [seg(10, 'A.'), seg(11.5, 'B.')]],
  ]);
  const opts = { sessionStartMs: T0, aliases: { [REES]: 'Rees' }, participants: {}, mergeGapMs: 2000, maxLineMs: 60_000 };
  assert.equal(mergeSegments(bySpeaker, opts).length, 2);
  assert.equal(mergeSegments(bySpeaker, { ...opts, noJoin: new Set([REES]) }).length, 3);
});

test('relabels shared-account lines, tags guesses and unclear lines, leaves everyone else alone', async () => {
  const { config } = parseConfig(CONFIG);
  const dir = mkdtempSync(join(tmpdir(), 'dis-'));
  const model = new FakeLabeller([
    { line: 1, speaker: 1, confident: true },
    { line: 3, speaker: 1, confident: true },
    { line: 4, speaker: 2, confident: true },
    { line: 5, speaker: 2, confident: false },
    { line: 7, speaker: 0, confident: false },
    { line: 2, speaker: 1, confident: true }, // Sam's line: must be ignored
  ]);
  const r = await disambiguateLines(LINES, config, model, dir, { id: 's', startedAt: T0 }, { log: () => {} });

  assert.equal(model.calls.length, 1);
  const user = model.calls[0]!.user;
  assert.match(user, /#1 \[00:00:01\] Rees: You enter/);
  assert.match(user, /\n\[00:00:05\] Sam: I ask/, 'other speakers are context, not numbered');
  const sys = model.calls[0]!.system;
  assert.match(sys, /Account "Rees":\n  1\. DM — narrates the world and NPCs\n  2\. Hamqueef — a player character/);
  assert.match(sys, /Weekly D&D game\./);

  assert.deepEqual(r.stats, { labelled: 5, confident: 3, guessed: 1, unclear: 1 });
  assert.deepEqual(
    r.lines.map((l) => [l.speaker, l.inferred?.confidence ?? null, l.text]),
    [
      ['DM', 'high', 'You enter a dusty tavern. The innkeeper eyes you.'],
      ['Sam', null, 'I ask the innkeeper about the missing caravan.'],
      ['DM', 'high', '"Caravan? Never heard of it," he mutters.'],
      ['Hamqueef', 'high', 'Hamqueef slams a gold coin on the bar. Talk.'],
      ['Hamqueef', 'low', 'Yeah.'],
      ['Sam', null, 'Nice.'],
      ['Rees', 'unclear', 'Mystery line.'],
    ],
  );
  assert.equal(r.lines[0]!.inferred?.account, 'Rees');
});

test('a label pointing at another account, or a missing label, becomes unclear', async () => {
  const { config } = parseConfig(`${CONFIG}\n  "${MUSIC}":\n    name: Duo\n    disambiguate: ["A — one", "B — two"]`.replace('summary:\n  context: "Weekly D&D game."\n', '') + '\n');
  const lines = [line(1, REES, 'Rees', 'x'), line(2, MUSIC, 'Duo', 'y'), line(3, REES, 'Rees', 'z')];
  // Identities: Rees → 1 DM, 2 Hamqueef; Duo → 3 A, 4 B.
  const model = new FakeLabeller([{ line: 1, speaker: 3, confident: true }, { line: 2, speaker: 4, confident: true }]);
  const r = await disambiguateLines(lines, config, model, mkdtempSync(join(tmpdir(), 'dis-')), { id: 's', startedAt: T0 }, { log: () => {} });
  assert.deepEqual(r.lines.map((l) => [l.speaker, l.inferred?.confidence]), [['Rees', 'unclear'], ['B', 'high'], ['Rees', 'unclear']]);
});

test('no shared accounts in the session → no model call, lines unchanged', async () => {
  const { config } = parseConfig(CONFIG);
  const model = new FakeLabeller([]);
  const lines = LINES.filter((l) => l.userId === SAM);
  const r = await disambiguateLines(lines, config, model, mkdtempSync(join(tmpdir(), 'dis-')), { id: 's', startedAt: T0 }, { log: () => {} });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(r.lines, lines);
});

test('session: writes transcript.speakers.md, caches labels, and feeds relabelled lines to the summary', async () => {
  const { config } = parseConfig(CONFIG);
  const dir = mkdtempSync(join(tmpdir(), 'dis-'));
  writeJson(paths.segments(dir), { session: { id: 'game', startedAt: T0 }, lines: LINES });
  const model = new FakeLabeller([
    { line: 1, speaker: 1, confident: true },
    { line: 3, speaker: 1, confident: true },
    { line: 4, speaker: 2, confident: true },
    { line: 5, speaker: 2, confident: false },
  ]);

  const r = await disambiguateSession(dir, config, model, { log: () => {} });
  assert.equal(r.file, paths.disambiguatedTranscript(dir));
  const md = readFileSync(r.file!, 'utf8');
  assert.match(md, /\[00:00:01\] DM: You enter a dusty tavern/);
  assert.match(md, /\[00:00:13\] Hamqueef: Hamqueef slams/);
  assert.match(md, /\[00:00:17\] Hamqueef \(\?\): Yeah\./);
  assert.match(md, /\[00:00:25\] Rees \(unclear\): Mystery line\./);
  assert.match(md, /\*\*Speakers:\*\* DM, Sam, Hamqueef\n/);
  assert.ok(existsSync(paths.disambiguatedSegments(dir)));
  assert.equal(existsSync(paths.transcript(dir)), false, 'the original transcript is not touched');

  // summarize runs the pass (from cache) and summarizes the relabelled lines.
  const { meta } = await summarizeSession(dir, config, 'h', model, { log: () => {} });
  assert.equal(model.calls.length, 1, 'labels reused from cache');
  assert.deepEqual(meta.speakerLabels, { labelled: 5, confident: 3, guessed: 1, unclear: 1 });
  assert.match(meta.promptVersions.disambiguate!, /^v1#/);
  assert.match(model.extractCalls[0]!.user, /\[00:00:13\] Hamqueef: Hamqueef slams/);
  assert.match(model.extractCalls[0]!.user, /\[00:00:25\] Rees \(unclear\): Mystery line\./);
  assert.ok(existsSync(summaryPaths.markdown(dir)));
});

test('Anthropic request for the labelling step uses structured output', async () => {
  let body: any;
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: JSON.stringify({ labels: [{ line: 1, speaker: 2, confident: false }] }) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch,
  });
  const r = await new AnthropicSummaryModel({ fallbacks: true, client }).disambiguate({ model: 'claude-opus-5', effort: 'medium', system: 's', user: 'u' });
  assert.deepEqual(r.value.labels, [{ line: 1, speaker: 2, confident: false }]);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.format.schema.properties.labels);
});
