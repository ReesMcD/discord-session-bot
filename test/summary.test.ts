import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseConfig } from '../src/config/load.js';
import { writeJson, paths } from '../src/session/layout.js';
import { chunkTranscript, formatChunk } from '../src/summary/chunk.js';
import { loadTemplate, render } from '../src/summary/prompts.js';
import { AnthropicSummaryModel, SummaryError, type CallOptions, type Extraction, type SummaryModel } from '../src/summary/model.js';
import { formatExtractions, summarizeSession, summaryPaths } from '../src/summary/summarizeSession.js';
import type { TranscriptLine } from '../src/transcript/merge.js';

const T0 = Date.UTC(2026, 8, 25, 23);
const line = (min: number, speaker: string, text: string): TranscriptLine => ({
  userId: speaker,
  speaker,
  offsetMs: min * 60_000,
  startMs: T0 + min * 60_000,
  endMs: T0 + min * 60_000 + 5000,
  text,
});

test('render fills placeholders and rejects unknown ones', () => {
  assert.equal(render('a {{x}} b\n\n\n\nc', { x: '1' }), 'a 1 b\n\nc\n');
  assert.throws(() => render('{{nope}}', {}), /unknown placeholder \{\{nope\}\}/);
});

test('built-in templates only use placeholders the code provides', () => {
  const vars = { context: '', include_rules: '', exclude_rules: '', detail: '', detail_guidance: '', citation_guidance: '' };
  for (const name of ['extract', 'synthesize'] as const) {
    const t = loadTemplate(name);
    assert.equal(t.version, 'v1');
    assert.doesNotThrow(() => render(t.text, vars));
  }
});

test('chunks by time window, carries a minute of context, splits very dense windows', () => {
  const lines = [line(0, 'A', 'x'), line(5, 'B', 'y'), line(19.5, 'A', 'z'), line(21, 'B', 'w'), line(65, 'A', 'v')];
  const chunks = chunkTranscript(lines, { chunkMs: 20 * 60_000, contextMs: 60_000, maxChars: 10_000 });
  assert.deepEqual(chunks.map((c) => c.lines.map((l) => l.text)), [['x', 'y', 'z'], ['w'], ['v']]);
  assert.deepEqual(chunks[1]!.context.map((l) => l.text), []); // 19:30 is 90 s before 21:00
  const dense = chunkTranscript([line(1, 'A', 'a'.repeat(50)), line(2, 'A', 'b'.repeat(50)), line(3, 'A', 'c'.repeat(50))], { chunkMs: 20 * 60_000, contextMs: 5 * 60_000, maxChars: 100 });
  assert.equal(dense.length, 3);
  assert.deepEqual(dense[1]!.context.map((l) => l.text[0]), ['a']);
  assert.match(formatChunk(dense[1]!, 3), /^<transcript_section number="2" of="3" from="00:02:00" to="00:02:00">\n\(context\) \[00:01:00\] A: a+\n\[00:02:00\] A: b+\n<\/transcript_section>$/);
});

test('formatExtractions groups by rule in time order', () => {
  const out = formatExtractions(
    [
      { time: '00:10:00', rule: 2, speakers: ['Sam'], detail: 'Later decision.' },
      { time: '00:02:00', rule: 2, speakers: ['Rees'], detail: 'Earlier decision.' },
      { time: '00:05:00', rule: 1, speakers: [], detail: 'A topic.' },
    ],
    ['Topics', 'Decisions', 'Unused'],
  );
  assert.equal(
    out,
    '<rule number="1" text="Topics">\n[00:05:00] (unknown) A topic.\n</rule>\n\n<rule number="2" text="Decisions">\n[00:02:00] (Rees) Earlier decision.\n[00:10:00] (Sam) Later decision.\n</rule>',
  );
});

class FakeModel implements SummaryModel {
  extractCalls: CallOptions[] = [];
  synthCalls: CallOptions[] = [];
  async extract(opts: CallOptions) {
    this.extractCalls.push(opts);
    const value: Extraction = {
      items: [
        { time: '00:00:05', rule: 2, speakers: ['Rees'], detail: 'Decided to meet Friday.' },
        { time: '00:00:09', rule: 99, speakers: [], detail: 'Bad rule number, dropped.' },
      ],
    };
    return { value, model: 'claude-test', usage: { inputTokens: 100, outputTokens: 20 } };
  }
  async synthesize(opts: CallOptions) {
    this.synthCalls.push(opts);
    return { value: '## Decisions\n\n- Meet Friday. [00:00:05]', model: 'claude-test', usage: { inputTokens: 50, outputTokens: 10 } };
  }
}

test('summarizes a session, caches extractions, and only re-extracts when inputs change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sum-'));
  writeJson(paths.segments(dir), {
    session: { id: 'game-night', startedAt: T0, stoppedAt: T0 + 3_600_000, channelName: 'dnd' },
    lines: [line(0.08, 'Rees', 'Friday works?'), line(0.15, 'Sam', 'Yes, Friday.'), line(30, 'Rees', 'Wrapping up.')],
  });
  const cfg = (extra = '') => parseConfig(`transcript:\n  timezone: UTC\nsummary:\n  context: "Weekly D&D game."\n  exclude: ["Rules arguments"]\n${extra}`);

  const fake = new FakeModel();
  const first = await summarizeSession(dir, cfg().config, 'h1', fake, { log: () => {} });
  assert.equal(fake.extractCalls.length, 2);
  assert.equal(fake.synthCalls.length, 1);
  assert.equal(first.meta.items, 2);
  assert.deepEqual(first.meta.modelsUsed, ['claude-test']);
  assert.deepEqual(first.meta.usage.extract, { inputTokens: 200, outputTokens: 40 });

  const sys = fake.extractCalls[0]!.system;
  assert.match(sys, /Weekly D&D game\./);
  assert.match(sys, /1\. Main topics discussed\n2\. Decisions made/);
  assert.match(sys, /- Rules arguments/);
  assert.match(fake.extractCalls[0]!.user, /\[00:00:04\] Rees: Friday works\?/);
  assert.equal(fake.extractCalls[0]!.effort, 'medium');
  assert.match(fake.synthCalls[0]!.system, /Detail level: medium/);
  assert.match(fake.synthCalls[0]!.system, /timestamp in square brackets/);
  assert.match(fake.synthCalls[0]!.user, /<rule number="2" text="Decisions made">\n\[00:00:05\] \(Rees\) Decided to meet Friday\./);
  assert.doesNotMatch(fake.synthCalls[0]!.user, /Bad rule number/);

  const md = readFileSync(summaryPaths.markdown(dir), 'utf8');
  assert.match(md, /^# Summary: game-night\n\n- \*\*Date:\*\* Sep 25, 2026, 11:00\s?PM\n- \*\*Duration:\*\* 01:00:00\n- \*\*Speakers:\*\* Rees, Sam\n\n---\n\n## Decisions/);

  // Changing only the detail level reuses every extraction.
  const second = await summarizeSession(dir, cfg('  detail: high\n  cite_timestamps: false').config, 'h2', fake, { log: () => {} });
  assert.equal(fake.extractCalls.length, 2);
  assert.equal(second.meta.chunksFromCache, 2);
  assert.match(fake.synthCalls[1]!.system, /Detail level: high/);
  assert.match(fake.synthCalls[1]!.system, /Don't include timestamps/);

  // Changing the rules re-extracts.
  await summarizeSession(dir, cfg('  include: ["Plot developments"]').config, 'h3', fake, { log: () => {} });
  assert.equal(fake.extractCalls.length, 4);
});

function fakeAnthropic(respond: (body: any, headers: Headers) => object) {
  const calls: { body: any; headers: Headers }[] = [];
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const headers = new Headers(init.headers);
      calls.push({ body, headers });
      return Response.json(respond(body, headers));
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const message = (text: string, extra: object = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

test('extraction request: structured output, effort, and default fallbacks', async () => {
  const { client, calls } = fakeAnthropic(() => message(JSON.stringify({ items: [{ time: '00:01:00', rule: 1, speakers: ['A'], detail: 'x' }] })));
  const model = new AnthropicSummaryModel({ fallbacks: true, client });
  const r = await model.extract({ model: 'claude-opus-5', effort: 'medium', system: 'SYS', user: 'USER' });

  assert.deepEqual(r.value.items[0], { time: '00:01:00', rule: 1, speakers: ['A'], detail: 'x' });
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 50 });
  const { body, headers } = calls[0]!;
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.system, 'SYS');
  assert.equal(body.fallbacks, 'default');
  assert.match(headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.format.schema.properties.items);
  assert.equal(body.thinking, undefined, 'adaptive thinking is the default on current models');
});

test('fallbacks can be turned off; refusals become a clear SummaryError', async () => {
  const { client, calls } = fakeAnthropic(() =>
    message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } }),
  );
  const model = new AnthropicSummaryModel({ fallbacks: false, client });
  await assert.rejects(model.extract({ model: 'claude-opus-5', effort: 'low', system: 's', user: 'u' }), (e: Error) => e instanceof SummaryError && /declined.*cyber.*nope/.test(e.message));
  assert.equal(calls[0]!.body.fallbacks, undefined);
  assert.doesNotMatch(calls[0]!.headers.get('anthropic-beta') ?? '', /fallback/);
});

test('summary request is streamed and assembled into text', async () => {
  const events = [
    { type: 'message_start', message: { ...message(''), content: [], stop_reason: null, usage: { input_tokens: 800, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Decisions\n\n' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '- Meet Friday. [00:00:05]' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ];
  let seen: any;
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      seen = JSON.parse(init.body as string);
      const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
  const r = await new AnthropicSummaryModel({ fallbacks: true, client }).synthesize({ model: 'claude-opus-5', effort: 'high', system: 'S', user: 'U' });
  assert.equal(seen.stream, true);
  assert.equal(seen.output_config.effort, 'high');
  assert.equal(r.value, '## Decisions\n\n- Meet Friday. [00:00:05]');
  assert.equal(r.usage.outputTokens, 42);
});
