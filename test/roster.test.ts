import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/load.js';
import { campaignFor, charactersByAccount, sharedAccounts, speakerNames, unpairedSpeakers } from '../src/config/roster.js';
import { rosterId } from '../src/shared/ids.js';
import { runCommand } from '../src/bot/commands.js';

const REES = '111111111111111111';
const SAM = '222222222222222222';
const ALEX = '333333333333333333';
const PAT = '444444444444444444';
const TABLE = '555555555555555555';

test('an older config (everything keyed by Discord ID and voice channel) reads as speakers, campaigns and characters', () => {
  const { config } = parseConfig(`
speakers:
  "${REES}": Rees
  "${SAM}":
    name: Sam's mic
    disambiguate:
      - "Sam — plays Thorin"
      - "Rees: sometimes sits with Sam"
campaigns:
  "${TABLE}":
    name: Curse of Strahd
    context: Level 5.
    dndbeyond: 4567890
    characters:
      "${REES}": DM
      "${SAM}": "Thorin — dwarf fighter"
      "${ALEX}": { name: Elara, description: elf wizard, dndbeyond: 98765432 }
    guests: ["${PAT}"]
`);
  assert.deepEqual(config.speakers, {
    rees: { name: 'Rees', discord: [REES, SAM], description: 'DM, sometimes sits with Sam' },
    sam: { name: 'Sam', discord: [SAM], description: 'plays Thorin' },
    'elara-s-player': { name: 'Elara’s player', discord: [ALEX] },
    'guest-4444': { name: 'Guest 4444', discord: [PAT] },
  });
  assert.deepEqual(config.campaigns, { 'curse-of-strahd': { name: 'Curse of Strahd', context: 'Level 5.', dndbeyond: 4567890, channels: [TABLE] } });
  assert.deepEqual(config.characters, {
    thorin: { name: 'Thorin', description: 'dwarf fighter', campaign: 'curse-of-strahd', speaker: 'sam' },
    elara: { name: 'Elara', description: 'elf wizard', dndbeyond: 98765432, campaign: 'curse-of-strahd', speaker: 'elara-s-player' },
  });
  // Sessions from before stored the voice channel as their campaign.
  assert.equal(campaignFor(config, { campaign: TABLE })?.name, 'Curse of Strahd');
});

test('a speaker on several accounts, and an account with several speakers (a shared mic)', () => {
  const { config } = parseConfig(`
speakers:
  rees: { name: Rees, discord: ["${REES}", "${SAM}"], description: DM }
  sam: { name: Sam, discord: ["${SAM}"] }
  alex: { name: Alex, discord: ["${ALEX}"] }
campaigns:
  strahd: { name: Strahd, channels: ["${TABLE}"] }
characters:
  thorin: { name: Thorin, description: dwarf fighter, campaign: strahd, speaker: sam }
  elara: { name: Elara, campaign: strahd, speaker: alex }
  other: { name: Somebody Else, speaker: alex }
`);
  assert.deepEqual(speakerNames(config), { [REES]: 'Rees', [ALEX]: 'Alex' }, 'a shared mic has no single name');
  const campaign = campaignFor(config, { channelId: TABLE })!;
  assert.deepEqual(charactersByAccount(config, campaign), { [ALEX]: 'Elara' }, 'only characters in this campaign');
  assert.deepEqual(sharedAccounts(config, campaign).get(SAM), [
    { label: 'Rees', description: 'Rees — DM' },
    { label: 'Thorin', player: 'Sam', description: 'Thorin — dwarf fighter (played by Sam)' },
  ]);
  assert.equal(sharedAccounts(config).has(REES), false);
  const line = (userId: string, speaker: string) => ({ userId, speaker, offsetMs: 0, startMs: 0, endMs: 1, text: 'hi' });
  assert.deepEqual(unpairedSpeakers(config, [line(ALEX, 'Elara'), line(PAT, 'pat_d'), line(PAT, 'pat_d')]), [{ userId: PAT, name: 'pat_d' }]);
});

test('roster IDs are readable slugs, unique, always starting with a letter', () => {
  const taken = new Set(['thorin']);
  assert.equal(rosterId('Thorin', (id) => taken.has(id)), 'thorin-2');
  assert.equal(rosterId('Élara Moonwhisper', () => false), 'elara-moonwhisper');
  assert.equal(rosterId('42nd Street', () => false), 'x-42nd-street');
  assert.equal(rosterId('!!!', () => false), 'item');
});

test('/record campaign: picks the campaign for the recording', async () => {
  const joined: unknown[] = [];
  const bot = {
    status: () => ({ state: 'ready' as const, recording: null }),
    join: async (channelId: string, opts?: { campaign?: string }) => (joined.push([channelId, opts]), { channelName: 'table' }) as never,
    stop: async () => ({ sessionId: '' }),
  };
  await runCommand({ name: 'record', guildId: 'g', memberVoiceChannelId: TABLE, campaign: 'strahd' }, bot);
  await runCommand({ name: 'record', guildId: 'g', memberVoiceChannelId: TABLE }, bot);
  assert.deepEqual(joined, [
    [TABLE, { campaign: 'strahd' }],
    [TABLE, {}],
  ]);
});

test('D&D Beyond: a public character, its description, and its campaign’s other characters', async () => {
  const { lookupCharacter } = await import('../src/dndbeyond/characters.js');
  const seen: string[] = [];
  const fake = (status: number, body: unknown) =>
    (async (url: string | URL | Request) => (seen.push(String(url)), new Response(JSON.stringify(body), { status }))) as typeof fetch;
  const sheet = {
    success: true,
    data: {
      name: 'Thorin',
      race: { fullName: 'Hill Dwarf' },
      classes: [{ level: 5, definition: { name: 'Fighter' } }, { level: 1, definition: { name: 'Cleric' } }],
      campaign: { id: 4567890, name: 'Strahd', characters: [{ characterId: 98765432, characterName: 'Thorin', username: 'sam_d' }, { characterId: 11, characterName: 'Elara ' }, { characterName: 'no id' }] },
    },
  };
  assert.deepEqual(await lookupCharacter(98765432, fake(200, sheet)), {
    id: 98765432,
    name: 'Thorin',
    description: 'Hill Dwarf Fighter 5 / Cleric 1',
    campaign: { id: 4567890, name: 'Strahd', characters: [{ id: 98765432, name: 'Thorin', player: 'sam_d' }, { id: 11, name: 'Elara' }] },
  });
  assert.equal(seen[0], 'https://character-service.dndbeyond.com/character/v5/character/98765432');
  assert.deepEqual(await lookupCharacter(5, fake(200, { success: true, data: { name: 'Solo' } })), { id: 5, name: 'Solo' });
  await assert.rejects(lookupCharacter(5, fake(403, {})), /isn't public/);
  await assert.rejects(lookupCharacter(5, fake(200, { success: false, message: 'Character is private' })), /isn't public/);
  await assert.rejects(lookupCharacter(5, fake(404, {})), /no character 5/);
});
