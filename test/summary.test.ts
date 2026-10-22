import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseConfig } from '../src/config/load.js';
import { PLACEHOLDERS, PROMPT_NAMES } from '../src/app/promptStore.js';
import { paths, readJson, writeJson } from '../src/session/layout.js';
import { campaignFor } from '../src/config/roster.js';
import { parseDndBeyondId } from '../web/src/dndbeyond.js';
import { chunkTranscript, formatChunk } from '../src/summary/chunk.js';
import { auditCleanup, similarity, type Proposal } from '../src/summary/cleanupAudit.js';
import { combineGuesses } from '../src/summary/cleanup.js';
import { contextBlock } from '../src/summary/context.js';
import { AnthropicSummaryModel, SummaryError, type Extraction } from '../src/summary/model.js';
import { loadTemplate, PROMPT_VERSIONS, render } from '../src/summary/prompts.js';
import { formatNotes, insertKillCount, tallyKills } from '../src/summary/recap.js';
import { appendFindings } from '../src/summary/recapAudit.js';
import { recapPaths, recapState, saveRecapEdit } from '../src/summary/recapEdits.js';
import { summarizeSession, summaryPaths } from '../src/summary/summarizeSession.js';
import type { TranscriptLine } from '../src/transcript/merge.js';
import { emptyNotes, FakeModel } from './helpers/fakeModel.js';

const T0 = Date.UTC(2026, 8, 25, 23);
const CHANNEL = '111111111111111111';
const SAM = '222222222222222222';
const ALEX = '333333333333333333';
const line = (min: number, speaker: string, text: string, userId = speaker): TranscriptLine => ({
  userId,
  speaker,
  offsetMs: min * 60_000,
  startMs: T0 + min * 60_000,
  endMs: T0 + min * 60_000 + 5000,
  text,
});

const SPEAKERS = `speakers:
  sam: { name: Sam, discord: ["${SAM}"] }
  alex: { name: Alex, discord: ["${ALEX}"] }
`;
const CAMPAIGN = `${SPEAKERS}campaigns:
  strahd:
    name: Curse of Strahd
    context: The party is level 5.
    channels: ["${CHANNEL}"]
characters:
  thorin: { name: Thorin, description: dwarf fighter, campaign: strahd, speaker: sam }
  elara: { name: Elara, description: elf wizard, campaign: strahd, speaker: alex }
`;

test('render fills placeholders and rejects unknown ones', () => {
  assert.equal(render('a {{x}} b\n\n\n\nc', { x: '1' }), 'a 1 b\n\nc\n');
  assert.throws(() => render('{{nope}}', {}), /unknown placeholder \{\{nope\}\}/);
});

test('every built-in template exists at its version and only uses placeholders the code provides', () => {
  assert.deepEqual([...PROMPT_NAMES].sort(), Object.keys(PROMPT_VERSIONS).sort());
  for (const name of PROMPT_NAMES) {
    const t = loadTemplate(name);
    assert.equal(t.version, PROMPT_VERSIONS[name]);
    assert.doesNotThrow(() => render(t.text, Object.fromEntries(PLACEHOLDERS[name].map((k) => [k, '']))), name);
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

test('campaign: the one picked, else the channel’s default, else the only campaign for sessions without a channel', () => {
  const { config } = parseConfig(CAMPAIGN);
  const c = campaignFor(config, { channelId: CHANNEL })!;
  assert.equal(c.name, 'Curse of Strahd');
  assert.deepEqual(c.characters.map((x) => [x.speaker?.name, x.label]), [['Sam', 'Thorin'], ['Alex', 'Elara']]);
  assert.equal(campaignFor(config, {})?.name, 'Curse of Strahd', 'Craig import: the only campaign');
  assert.equal(campaignFor(config, { channelId: '999999999999999999' }), undefined);
  const two = parseConfig(CAMPAIGN.replace('characters:', '  other:\n    name: Other\ncharacters:')).config;
  assert.equal(campaignFor(two, {}), undefined, 'ambiguous with two campaigns');
  assert.equal(campaignFor(two, { channelId: CHANNEL, campaign: 'other' })?.name, 'Other', 'picked wins over the channel');
  assert.equal(campaignFor(two, { campaign: CHANNEL })?.name, 'Curse of Strahd', 'sessions from before 0.5 stored the channel');
  assert.throws(() => parseConfig(`${CAMPAIGN}  gone: { name: Gone, campaign: nope, speaker: nobody }\n`), /no campaign "nope"[\s\S]*no speaker "nobody"/);
  assert.throws(() => parseConfig(CAMPAIGN.replace('characters:', `  other:\n    name: Other\n    channels: ["${CHANNEL}"]\ncharacters:`)), /already the default for "Curse of Strahd"/);
});

test('characters: a D&D Beyond ID, and one without a player', () => {
  const { config } = parseConfig(`campaigns:
  strahd: { name: Strahd, dndbeyond: 4567890 }
characters:
  thorin: { name: Thorin, description: dwarf fighter 5, dndbeyond: 98765432, campaign: strahd }
`);
  const c = campaignFor(config, { campaign: 'strahd' })!;
  assert.equal(c.dndbeyond, 4567890);
  assert.deepEqual(c.characters, [{ id: 'thorin', label: 'Thorin', description: 'Thorin — dwarf fighter 5', dndbeyond: 98765432 }]);
  assert.throws(() => parseConfig(`characters:\n  thorin: { name: Thorin, class: fighter }\n`), /class/);

  assert.equal(parseDndBeyondId('https://www.dndbeyond.com/characters/98765432'), 98765432);
  assert.equal(parseDndBeyondId('https://www.dndbeyond.com/campaigns/4567890?x=1'), 4567890);
  assert.equal(parseDndBeyondId(' 123 '), 123);
  assert.equal(parseDndBeyondId('https://www.dndbeyond.com/characters/'), undefined);
});

test('the prompt context lists the party, who plays whom, everyone else heard, and the campaign background', () => {
  const { config } = parseConfig(`${CAMPAIGN.replace(SPEAKERS, `${SPEAKERS}  rees: { name: Rees, discord: ["444444444444444444"], description: DM }\n`)}summary:\n  context: Weekly game.\n`);
  const block = contextBlock({ id: 's', startedAt: T0, channelId: CHANNEL, channelName: 'dnd' }, [line(0, 'Thorin', 'hi', SAM), line(1, 'Rees', 'You see a wolf.', '444444444444444444')], config);
  assert.match(block, /- Campaign: Curse of Strahd/);
  assert.match(block, /## Party\n\nThe playable characters, and who plays them\. They are not NPCs\.\n\n- Thorin — dwarf fighter \(played by Sam\)\n- Elara — elf wizard \(played by Alex\)/);
  assert.match(block, /## Also at the table\n\nSpeakers who play no character here \(the DM, guests\)\.\n\n- Rees — DM/);
  assert.match(block, /Weekly game\.\n\nThe party is level 5\./);
});

const notes = (n: Partial<Extraction>): Extraction => ({ ...emptyNotes(), ...n });

test('formatNotes groups every kind of note in time order', () => {
  const out = formatNotes(
    [
      notes({ npcs: [{ name: 'Ireena', time: '00:30:00', details: ['Burgomaster\'s daughter'] }], events: [{ time: '00:31:00', text: 'Met Ireena.' }] }),
      notes({
        npcs: [{ name: 'Strahd', time: '00:05:00', details: [] }],
        combats: [{ start: '00:10:00', end: '00:15:00', opponents: ['wolves'], summary: 'Wolves attacked.', deaths: ['wolf'], kills: [{ by: 'Thorin', target: 'wolf' }] }],
        items: [{ time: '00:20:00', rule: 2, detail: 'Took the map.' }, { time: '00:21:00', rule: 9, detail: 'Unknown rule.' }],
      }),
    ],
    ['Loot', 'Quests'],
  );
  assert.equal(
    out,
    [
      '<npcs>\n[00:05:00] Strahd\n[00:30:00] Ireena: Burgomaster\'s daughter\n</npcs>',
      '<events>\n[00:31:00] Met Ireena.\n</events>',
      '<combats>\n[00:10:00–00:15:00] vs. wolves: Wolves attacked. Died: wolf. Killing blows: Thorin → wolf.\n</combats>',
      '<rule number="2" text="Quests">\n[00:20:00] Took the map.\n</rule>',
    ].join('\n\n'),
  );
});

test('kill count: tallied per character (matching party names), added to the Combat section', () => {
  const fight = (kills: [string, string][]) => ({ start: '00:01:00', end: '00:02:00', opponents: [], summary: '', deaths: [], kills: kills.map(([by, target]) => ({ by, target })) });
  const tally = tallyKills([notes({ combats: [fight([['Thorin', 'goblin'], ['elara', 'goblin']])] }), notes({ combats: [fight([['Thorin the dwarf', 'wolf'], ['', 'x']])] })], [{ label: 'Thorin' }, { label: 'Elara' }]);
  assert.deepEqual(tally, [['Thorin', 2], ['Elara', 1]]);

  const md = '## NPCs\n\n- A\n\n## Combat\n\n- **vs. goblins**: won.\n\n## Loot\n\n- Gold';
  assert.equal(insertKillCount(md, tally), '## NPCs\n\n- A\n\n## Combat\n\n- **vs. goblins**: won.\n- **Kill count:** Thorin 2, Elara 1\n\n## Loot\n\n- Gold');
  assert.equal(insertKillCount('## What happened\n\n- Fight.\n\n## Loot\n\n- Gold', [['Thorin', 1]]), '## What happened\n\n- Fight.\n\n## Combat\n\n- **Kill count:** Thorin 1\n\n## Loot\n\n- Gold');
  assert.equal(insertKillCount('## Combat\n\n- x', [['Thorin', 1]]), '## Combat\n\n- x\n- **Kill count:** Thorin 1\n');
  assert.equal(insertKillCount(md, []), md);
  assert.equal(insertKillCount('## Combat\n\n- x\n- **Kill count:** Elara 9\n', [['Thorin', 1]]), '## Combat\n\n- x\n- **Kill count:** Thorin 1\n', 'a model-written count is replaced');
});

test('clean-up audit: keeps corrections, reverts rewrites, restores real content, discards a chunk that changed too much', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.ok(similarity('We go to Strod tomorrow', 'We go to Strahd tomorrow') > 0.9);
  assert.ok(similarity('I attack the goblin with my axe', 'Thorin swings at the goblin and hits') < 0.6);

  const lines = [
    line(0, 'Sam', 'We go to Strod tomorrow'),
    line(1, 'Sam', 'I attack the goblin with my axe'),
    line(2, 'Sam', 'um'),
    line(3, 'Sam', 'I want to check the chest for traps first please'),
    line(4, 'Sam', 'thank you thank you thank you thank you thank you thank you thank you thank you'),
  ];
  const proposals = new Map<number, Proposal>([
    [1, { kind: 'edit', text: 'We go to Strahd tomorrow' }],
    [2, { kind: 'edit', text: 'Thorin swings at the goblin and hits' }],
    [3, { kind: 'drop' }],
    [4, { kind: 'drop' }],
    [5, { kind: 'drop' }],
  ]);
  const { accepted, report } = auditCleanup(lines, proposals, [{ index: 0, lineNumbers: [1, 2, 3, 4, 5] }]);
  assert.deepEqual([...accepted.keys()], [1, 3, 5]);
  assert.deepEqual(report.accepted, { edits: 1, drops: 2 });
  assert.deepEqual(report.reverted.map((r) => [r.kind, r.original.slice(0, 12)]), [['edit', 'I attack the'], ['drop', 'I want to ch']]);
  assert.match(report.reverted[0]!.reason, /changed too much/);

  const many = Array.from({ length: 10 }, (_, i) => line(i, 'Sam', `uh ${i}`));
  const allDropped = new Map<number, Proposal>(many.map((_, i) => [i + 1, { kind: 'drop' }]));
  const discarded = auditCleanup(many, allDropped, [{ index: 3, lineNumbers: many.map((_, i) => i + 1) }]);
  assert.equal(discarded.accepted.size, 0);
  assert.deepEqual(discarded.report.discardedChunks, [3]);
});

function session(extraConfig = '', lines = [line(0.08, 'Sam', 'We go to Strod.', SAM), line(0.15, 'Alex', 'Roll initiative!', ALEX), line(30, 'Alex', 'Finish him.', ALEX)]) {
  const dir = mkdtempSync(join(tmpdir(), 'recap-'));
  writeJson(paths.segments(dir), { session: { id: 'game-night', startedAt: T0, stoppedAt: T0 + 3_600_000, channelId: CHANNEL, channelName: 'dnd' }, lines });
  const cfg = parseConfig(`transcript:\n  timezone: UTC\n${CAMPAIGN}summary:\n  context: "Weekly D&D game."\n  exclude: ["Rules arguments"]\n${extraConfig}`).config;
  return { dir, cfg };
}

const STRAHD_NOTES = notes({
  npcs: [{ name: 'Strahd', time: '00:00:05', details: ['Rules Barovia'] }],
  locations: [{ name: 'Barovia', time: '00:00:05', details: ['Foggy'] }],
  events: [{ time: '00:00:05', text: 'The party set out for Barovia.' }],
  combats: [{ start: '00:00:09', end: '00:30:00', opponents: ['wolves'], summary: 'Wolves ambushed the party.', deaths: ['wolf'], kills: [{ by: 'Thorin', target: 'wolf' }, { by: 'Elara', target: 'wolf' }, { by: 'thorin', target: 'wolf' }] }],
  items: [{ time: '00:00:05', rule: 1, detail: 'Found 20 gold.' }, { time: '00:00:09', rule: 99, detail: 'Bad rule number, dropped.' }],
});
const RECAP = '## NPCs\n\n- **Strahd**: rules Barovia. [00:00:05]\n\n## Combat\n\n- **vs. wolves**: won. [00:00:09]';

test('recap: clean-up → extract → write-up, with the party in every prompt, a kill count, and caching', async () => {
  const { dir, cfg } = session('  recap_audit: false\n');
  const model = new FakeModel({
    cleanup: () => ({ edits: [{ line: 1, text: 'We go to Strahd.' }, { line: 99, text: 'made up' }], drops: [] }),
    extract: () => STRAHD_NOTES,
    synthesize: () => RECAP,
  });
  const { meta } = await summarizeSession(dir, cfg, 'h1', model, { log: () => {} });

  assert.equal(model.calls.cleanup.length, 2);
  assert.match(model.calls.cleanup[0]!.system, /Characters: Thorin, Elara/);
  assert.match(model.calls.cleanup[0]!.user, /#1 \[00:00:04\] Sam: We go to Strod\./);
  assert.match(readFileSync(paths.cleanTranscript(dir), 'utf8'), /Sam: We go to Strahd\./);
  assert.match(readFileSync(paths.segments(dir), 'utf8'), /Strod/, 'raw transcript untouched');
  assert.deepEqual(meta.cleanup, { edited: 1, dropped: 0, reverted: 0 });

  const sys = model.calls.extract[0]!.system;
  assert.match(sys, /Thorin — dwarf fighter \(played by Sam\)/);
  assert.match(sys, /1\. Loot, rewards and purchases\n2\. Quests, hooks and open threads/);
  assert.match(sys, /- Rules arguments/);
  assert.match(model.calls.extract[0]!.user, /\[00:00:04\] Sam: We go to Strahd\./, 'extraction reads the cleaned transcript');
  assert.match(model.calls.synthesize[0]!.user, /<npcs>\n\[00:00:05\] Strahd: Rules Barovia/);
  assert.doesNotMatch(model.calls.synthesize[0]!.user, /Bad rule number/);
  assert.equal(model.calls.audit.length, 0, 'recap audit off');

  const md = readFileSync(summaryPaths.markdown(dir), 'utf8');
  assert.match(md, /^# Recap: Curse of Strahd\n\n- \*\*Date:\*\* Sep 25, 2026, 11:00\s?PM\n- \*\*Duration:\*\* 01:00:00\n/);
  assert.match(md, /- \*\*vs\. wolves\*\*: won\. \[00:00:09\]\n- \*\*Kill count:\*\* Thorin 4, Elara 2\n$/, 'two chunks × the same notes');
  assert.deepEqual(meta.kills, [['Thorin', 4], ['Elara', 2]]);
  assert.deepEqual(meta.notes, { npcs: 2, locations: 2, events: 2, combats: 2, items: 2 });

  // Changing only the detail level reuses the clean-up and every extraction.
  const again = await summarizeSession(dir, { ...cfg, summary: { ...cfg.summary, detail: 'high' } }, 'h2', model, { log: () => {} });
  assert.equal(model.calls.cleanup.length, 2);
  assert.equal(model.calls.extract.length, 2);
  assert.equal(again.meta.chunksFromCache, 2);
  assert.match(model.calls.synthesize[1]!.system, /Detail level: high/);
});

test('recap: clean-up off reads the raw transcript and makes no clean-up calls', async () => {
  const { dir, cfg } = session('  cleanup: false\n  recap_audit: false\n');
  const model = new FakeModel({ extract: () => STRAHD_NOTES, synthesize: () => RECAP });
  const { meta } = await summarizeSession(dir, cfg, 'h', model, { log: () => {} });
  assert.equal(model.calls.cleanup.length, 0);
  assert.equal(existsSync(paths.cleanTranscript(dir)), false);
  assert.equal(meta.cleanup, undefined);
  assert.match(model.calls.extract[0]!.user, /Strod/);
});

test('recap audit: missing items are added by a revision; nothing missing means no revision', async () => {
  const { dir, cfg } = session('  cleanup: false\n');
  let revised = '';
  const model = new FakeModel({
    extract: () => STRAHD_NOTES,
    audit: (o) => (o.user.includes('Finish him') ? { missing: [{ section: 'npcs', time: '00:30:00', detail: 'Ismark, Ireena\'s brother.' }] } : { missing: [] }),
    synthesize: (o) => {
      if (!o.user.startsWith('<recap>')) return RECAP;
      revised = `${RECAP.replace('## Combat', '- **Ismark**: Ireena\'s brother. [00:30:00]\n\n## Combat')}`;
      return revised;
    },
  });
  const { meta } = await summarizeSession(dir, cfg, 'h', model, { log: () => {} });
  assert.equal(model.calls.audit.length, 2);
  assert.match(model.calls.audit[0]!.system, /<recap>\n## NPCs/);
  assert.equal(model.calls.synthesize.length, 2);
  assert.match(model.calls.synthesize[1]!.user, /<missing>\n- \(npcs\) \[00:30:00\] Ismark, Ireena's brother\./);
  assert.deepEqual(meta.recapAudit, { missing: 1, applied: 'revised' });
  assert.match(readFileSync(summaryPaths.markdown(dir), 'utf8'), /\*\*Ismark\*\*/);
  assert.deepEqual(readJson(summaryPaths.recapAudit(dir)), { missing: [{ section: 'npcs', time: '00:30:00', detail: "Ismark, Ireena's brother." }], applied: 'revised' });

  const clean = session('  cleanup: false\n');
  const quiet = new FakeModel({ extract: () => STRAHD_NOTES, synthesize: () => RECAP });
  const r = await summarizeSession(clean.dir, clean.cfg, 'h', quiet, { log: () => {} });
  assert.equal(quiet.calls.synthesize.length, 1);
  assert.deepEqual(r.meta.recapAudit, { missing: 0, applied: 'none' });
});

test('recap audit: a revision that lost content is not trusted; the findings are appended instead', async () => {
  const { dir, cfg } = session('  cleanup: false\n');
  const model = new FakeModel({
    extract: () => STRAHD_NOTES,
    audit: () => ({ missing: [{ section: 'locations', time: '00:00:05', detail: 'The Blood on the Vine tavern.' }] }),
    synthesize: (o) => (o.user.startsWith('<recap>') ? '## NPCs\n\n- short' : RECAP),
  });
  const { meta } = await summarizeSession(dir, cfg, 'h', model, { log: () => {} });
  assert.equal(meta.recapAudit?.applied, 'appended');
  const md = readFileSync(summaryPaths.markdown(dir), 'utf8');
  assert.match(md, /## Also mentioned\n\n_Found by the completeness check; move these where they belong\._\n\n- \*\*Locations\*\* \[00:00:05\]: The Blood on the Vine tavern\./);
  assert.match(md, /\*\*Strahd\*\*/, 'original content kept');
  assert.equal(appendFindings('x', []).includes('Also mentioned'), true);
});

test('unpaired: one guess per person from all chunks (majority role, most common name, earliest line)', () => {
  const people = [{ userId: '1', name: 'Alex' }, { userId: '2', name: 'Pat' }, { userId: '3', name: 'Quiet' }];
  const guesses = combineGuesses(people, [
    [{ speaker: 1, role: 'new_player', character: 'Garrick', time: '00:40:00' }, { speaker: 2, role: 'guest', character: '', time: '00:10:00' }],
    [{ speaker: 1, role: 'new_player', character: 'garrick', time: '00:12:04' }, { speaker: 1, role: 'guest', character: '', time: '00:05:00' }],
    [{ speaker: 1, role: 'new_player', character: 'Gareth', time: '01:00:00' }],
  ]);
  assert.deepEqual(guesses, [
    { userId: '1', name: 'Alex', role: 'new_player', character: 'Garrick', time: '00:12:04' },
    { userId: '2', name: 'Pat', role: 'guest', time: '00:10:00' },
    { userId: '3', name: 'Quiet' },
  ]);
});

test('unpaired: the clean-up asks about people off the roster, and the recap treats a likely new player as party', async () => {
  const NEW = '555555555555555555';
  const GUEST = '666666666666666666';
  const lines = [line(0.08, 'Sam', 'We go to Barovia.', SAM), line(0.15, 'Alex', 'Garrick, roll initiative!', ALEX), line(0.2, 'Robin', 'I swing at the wolf.', NEW), line(0.3, 'Pat', 'Can I watch?', GUEST)];
  const { dir, cfg } = session(`  recap_audit: false\n`, lines);
  cfg.speakers['pat'] = { name: 'Pat', discord: [GUEST] };
  const model = new FakeModel({
    cleanup: (o) => ({ unpaired: o.system.includes('U1: Robin') ? [{ speaker: 1, role: 'new_player', character: 'Garrick', time: '00:00:12' }] : [] }),
    extract: () => notes({ combats: [{ start: '00:00:09', end: '00:00:20', opponents: ['wolf'], summary: '', deaths: ['wolf'], kills: [{ by: 'garrick', target: 'wolf' }] }] }),
    synthesize: () => RECAP,
  });
  const { meta } = await summarizeSession(dir, cfg, 'h', model, { log: () => {} });

  assert.match(model.calls.cleanup[0]!.system, /## People not on the roster yet\n\nU1: Robin\n/);
  assert.doesNotMatch(model.calls.cleanup[0]!.system, /U2/, 'accounts with a speaker are not asked about');
  assert.deepEqual(readJson(summaryPaths.unpaired(dir)), [{ userId: NEW, name: 'Robin', role: 'new_player', character: 'Garrick', time: '00:00:12' }]);
  assert.match(model.calls.extract[0]!.system, /## Not on the roster yet\n\n- Robin: probably a new player, playing Garrick \(not confirmed yet\)\. Treat Garrick as part of the party, not an NPC\./);
  assert.deepEqual(meta.kills, [['Garrick', 1]], 'kills credited to the guessed character');

  const off = session(`  cleanup: false\n  recap_audit: false\n`, lines);
  await summarizeSession(off.dir, off.cfg, 'h', new FakeModel({ synthesize: () => RECAP }), { log: () => {} });
  assert.deepEqual(readJson(summaryPaths.unpaired(off.dir)), [{ userId: NEW, name: 'Robin' }, { userId: GUEST, name: 'Pat' }], 'without clean-up: listed, no guesses');
});

test('edits: saving keeps the generated recap; regenerating keeps the edited one', async () => {
  const { dir, cfg } = session('  cleanup: false\n  recap_audit: false\n');
  const model = new FakeModel({ extract: () => STRAHD_NOTES, synthesize: () => RECAP });
  await summarizeSession(dir, cfg, 'h', model, { log: () => {} });
  assert.equal(recapState(dir), 'generated');
  const generated = readFileSync(recapPaths.markdown(dir), 'utf8');

  saveRecapEdit(dir, '# My recap\n\n- Edited by hand', new Date('2026-10-20T10:00:00Z'));
  assert.equal(recapState(dir), 'edited');
  assert.equal(readFileSync(recapPaths.generated(dir), 'utf8'), generated);
  saveRecapEdit(dir, '# My recap\n\n- Edited twice');
  assert.equal(readFileSync(recapPaths.generated(dir), 'utf8'), generated, 'the first generated copy is kept');
  assert.throws(() => saveRecapEdit(dir, '  '), /empty/);

  const { meta } = await summarizeSession(dir, cfg, 'h', model, { log: () => {} });
  assert.equal(recapState(dir), 'generated');
  assert.ok(meta.editedBackup);
  assert.equal(readFileSync(meta.editedBackup!, 'utf8'), '# My recap\n\n- Edited twice\n');
  assert.equal(existsSync(recapPaths.generated(dir)), false);
  assert.equal(readdirSync(join(dir, 'summary')).filter((f) => f.startsWith('edited-')).length, 1);
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
  const { client, calls } = fakeAnthropic(() => message(JSON.stringify({ npcs: [{ name: 'Strahd', time: '00:01:00', details: ['A vampire.'] }], locations: [], events: [], combats: [], items: [] })));
  const model = new AnthropicSummaryModel({ fallbacks: true, client });
  const r = await model.extract({ model: 'claude-opus-5', effort: 'medium', system: 'SYS', user: 'USER' });

  assert.deepEqual(r.value.npcs[0], { name: 'Strahd', time: '00:01:00', details: ['A vampire.'] });
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 50 });
  const { body, headers } = calls[0]!;
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.system, 'SYS');
  assert.equal(body.fallbacks, 'default');
  assert.match(headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.format.schema.properties.combats);
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
