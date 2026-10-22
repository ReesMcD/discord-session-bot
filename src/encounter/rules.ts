import { blankMap, MapError, moveToken, placeToken, setDifficult, setDoor, type BattleMap } from '../shared/battlemap.js';
import type { Combatant, CombatantKind, Condition, ConditionName, EncounterAction, EncounterOutcome, EncounterState } from '../shared/types.js';

/** The 2024 conditions, in the order the tracker lists them. */
export const CONDITIONS: readonly ConditionName[] = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Exhaustion',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
];

/** A mistake in what was asked (unknown combatant, bad number): shown to the DM as is. */
export class EncounterError extends Error {}

export interface RuleDeps {
  now: () => number;
  /** A d20 roll, 1–20. */
  d20: () => number;
}

export const abilityModifier = (score: number) => Math.floor((score - 10) / 2);

/** A new, empty encounter in setup. */
export function newEncounter(id: string, title: string, now: number): EncounterState {
  return { id, title, status: 'setup', round: 0, turn: null, order: [], combatants: [], statBlocks: {}, map: null, startedAt: now, log: [] };
}

/** A combatant with defaults filled in. */
export function makeCombatant(id: string, input: { name: string; kind?: CombatantKind; ac?: number | null; hp?: number | null; initiativeBonus?: number; dex?: number | null; hidden?: boolean; ref?: string; tokenId?: string; player?: string | null }): Combatant {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new EncounterError('A combatant needs a name');
  const hp = wholeOrNull(input.hp, 'HP');
  return {
    id,
    name,
    kind: input.kind ?? 'monster',
    initiative: null,
    initiativeBonus: input.initiativeBonus ?? (input.dex != null ? abilityModifier(input.dex) : 0),
    dex: input.dex ?? null,
    ac: wholeOrNull(input.ac, 'AC'),
    hp,
    maxHp: hp,
    tempHp: 0,
    conditions: [],
    concentrating: null,
    concentrationCheck: null,
    hidden: input.hidden ?? false,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.tokenId ? { tokenId: input.tokenId } : {}),
    ...(input.player !== undefined ? { player: input.player } : {}),
  };
}

function wholeOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000) throw new EncounterError(`${what} must be a whole number from 0 to 10000`);
  return v;
}

function amountOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000) throw new EncounterError('The amount must be a whole number from 0 to 10000');
  return v;
}

/** Turn order: highest initiative first; ties by Dexterity, then PCs before others, then name. Unrolled last. */
export function sortOrder(combatants: readonly Combatant[]): string[] {
  const rank = (c: Combatant) => (c.kind === 'pc' ? 0 : 1);
  return [...combatants]
    .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity) || (b.dex ?? b.initiativeBonus * 2 + 10) - (a.dex ?? a.initiativeBonus * 2 + 10) || rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((c) => c.id);
}

/** A unique id from a name: "Goblin 2" → "goblin-2", with -2, -3… when taken. */
export function combatantId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'combatant';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Applies one change. Returns a new state; throws EncounterError for a bad request. */
export function applyAction(state: EncounterState, action: EncounterAction, deps: RuleDeps): EncounterState {
  if (state.status === 'ended') throw new EncounterError('This encounter has ended');
  const s: EncounterState = structuredClone(state);
  const log = (text: string) => s.log.push({ at: deps.now(), round: s.round, text });
  const find = (id: string) => {
    const c = s.combatants.find((x) => x.id === id);
    if (!c) throw new EncounterError('No such combatant');
    return c;
  };

  switch (action.type) {
    case 'add': {
      const count = action.combatant.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 30) throw new EncounterError('Add 1 to 30 at a time');
      const taken = new Set(s.combatants.map((c) => c.id));
      for (let i = 1; i <= count; i++) {
        const name = count > 1 ? `${action.combatant.name.trim()} ${i}` : action.combatant.name;
        const c = makeCombatant(combatantId(name, taken), { ...action.combatant, name });
        taken.add(c.id);
        s.combatants.push(c);
        if (s.status === 'running') {
          // Joins at the end of the round until it has an initiative.
          s.order.push(c.id);
        }
      }
      break;
    }
    case 'remove': {
      const c = find(action.id);
      // Removing whoever's turn it is hands the turn to the next in line, without ticking timers.
      const i = s.order.indexOf(c.id);
      s.combatants = s.combatants.filter((x) => x.id !== c.id);
      s.order = s.order.filter((id) => id !== c.id);
      if (s.turn === c.id) s.turn = s.order.length ? s.order[i % s.order.length]! : null;
      log(`${c.name} removed`);
      break;
    }
    case 'update': {
      const c = find(action.id);
      if (action.name !== undefined) {
        const name = action.name.trim().slice(0, 60);
        if (!name) throw new EncounterError('A combatant needs a name');
        c.name = name;
      }
      if (action.ac !== undefined) c.ac = wholeOrNull(action.ac, 'AC');
      if (action.maxHp !== undefined) c.maxHp = wholeOrNull(action.maxHp, 'Max HP');
      if (action.hp !== undefined) c.hp = wholeOrNull(action.hp, 'HP');
      if (c.hp !== null && c.maxHp !== null && c.hp > c.maxHp) c.hp = c.maxHp;
      break;
    }
    case 'initiative': {
      const c = find(action.id);
      if (action.value !== null && (typeof action.value !== 'number' || !Number.isInteger(action.value) || action.value < -10 || action.value > 50)) throw new EncounterError('Initiative must be a whole number');
      c.initiative = action.value;
      if (s.status === 'setup') s.order = sortOrder(s.combatants);
      break;
    }
    case 'rollInitiative': {
      // Default: every monster and NPC without one (players roll their own).
      const targets = action.ids ? action.ids.map(find) : s.combatants.filter((c) => c.kind !== 'pc' && c.initiative === null);
      for (const c of targets) {
        const roll = deps.d20();
        c.initiative = roll + c.initiativeBonus;
      }
      if (s.status === 'setup') s.order = sortOrder(s.combatants);
      break;
    }
    case 'reorder': {
      const ids = new Set(s.combatants.map((c) => c.id));
      if (action.order.length !== ids.size || !action.order.every((id) => ids.has(id)) || new Set(action.order).size !== ids.size) throw new EncounterError('The new order must list every combatant once');
      s.order = [...action.order];
      break;
    }
    case 'begin': {
      if (s.status !== 'setup') throw new EncounterError('Already running');
      if (!s.combatants.length) throw new EncounterError('Add combatants first');
      const missing = s.combatants.filter((c) => c.initiative === null).map((c) => c.name);
      if (missing.length) throw new EncounterError(`Still waiting on initiative: ${missing.join(', ')}`);
      if (s.order.length !== s.combatants.length) s.order = sortOrder(s.combatants);
      s.status = 'running';
      s.round = 1;
      s.turn = s.order[0]!;
      log('Round 1');
      startTurn(s, deps);
      break;
    }
    case 'next':
      requireRunning(s);
      advance(s, deps, 1);
      break;
    case 'previous':
      // Moves back without undoing timers: a fix for a click too many.
      requireRunning(s);
      advance(s, deps, -1);
      break;
    case 'damage': {
      const c = find(action.id);
      const amount = amountOf(action.amount);
      const fromTemp = Math.min(c.tempHp, amount);
      c.tempHp -= fromTemp;
      const rest = amount - fromTemp;
      if (c.hp !== null) {
        const before = c.hp;
        c.hp = Math.max(0, c.hp - rest);
        if (before > 0 && c.hp === 0) {
          log(`${c.name} drops to 0 HP`);
          if (c.kind === 'pc') setCondition(c, { name: 'Unconscious' });
          if (c.concentrating) {
            log(`${c.name} loses concentration on ${c.concentrating}`);
            c.concentrating = null;
            c.concentrationCheck = null;
          }
        }
      }
      // 2024: a Constitution save, DC 10 or half the damage (max 30), whenever damaged while concentrating.
      if (c.concentrating && amount > 0) c.concentrationCheck = Math.min(30, Math.max(10, Math.floor(amount / 2)));
      log(`${c.name} takes ${amount} damage${fromTemp ? ` (${fromTemp} from temporary HP)` : ''}`);
      break;
    }
    case 'heal': {
      const c = find(action.id);
      const amount = amountOf(action.amount);
      if (c.hp === null) throw new EncounterError(`${c.name} has no HP set`);
      const before = c.hp;
      c.hp = c.maxHp !== null ? Math.min(c.maxHp, c.hp + amount) : c.hp + amount;
      if (before === 0 && c.hp > 0) c.conditions = c.conditions.filter((x) => x.name !== 'Unconscious');
      log(`${c.name} heals ${c.hp - before}`);
      break;
    }
    case 'tempHp': {
      // Temporary HP don't stack: keep the higher.
      const c = find(action.id);
      c.tempHp = Math.max(c.tempHp, amountOf(action.amount));
      break;
    }
    case 'condition': {
      const c = find(action.id);
      if (!CONDITIONS.includes(action.name)) throw new EncounterError(`Unknown condition: ${String(action.name)}`);
      if (action.remove) {
        c.conditions = c.conditions.filter((x) => x.name !== action.name);
        log(`${c.name} is no longer ${action.name}`);
        break;
      }
      if (action.rounds !== undefined && (!Number.isInteger(action.rounds) || action.rounds < 1 || action.rounds > 100)) throw new EncounterError('Rounds must be 1 to 100');
      if (action.tick) find(action.tick.of);
      const level = action.name === 'Exhaustion' ? Math.min(6, Math.max(1, action.level ?? 1)) : undefined;
      setCondition(c, {
        name: action.name,
        ...(level ? { level } : {}),
        ...(action.rounds ? { rounds: action.rounds, tick: action.tick ?? { on: 'end', of: c.id } } : {}),
      });
      log(`${c.name} is ${action.name}${level ? ` ${level}` : ''}${action.rounds ? ` for ${action.rounds} round${action.rounds > 1 ? 's' : ''}` : ''}`);
      break;
    }
    case 'concentrate': {
      const c = find(action.id);
      const spell = action.spell?.trim().slice(0, 60) || null;
      if (c.concentrating && spell) log(`${c.name} stops concentrating on ${c.concentrating}`);
      c.concentrating = spell;
      c.concentrationCheck = null;
      if (spell) log(`${c.name} concentrates on ${spell}`);
      break;
    }
    case 'concentrationResult': {
      const c = find(action.id);
      if (!action.kept && c.concentrating) log(`${c.name} loses concentration on ${c.concentrating}`);
      if (!action.kept) c.concentrating = null;
      c.concentrationCheck = null;
      break;
    }
    case 'reveal': {
      const c = find(action.id);
      c.hidden = action.hidden ?? false;
      // The token shows (or hides) with its combatant.
      if (s.map && c.tokenId) s.map = { ...s.map, tokens: s.map.tokens.map((t) => (t.id === c.tokenId ? { ...t, hidden: c.hidden } : t)) };
      log(c.hidden ? `${c.name} hidden` : `${c.name} revealed`);
      break;
    }
    case 'move':
      s.map = onMap(s, (m) => moveToken(m, action.token, action.at));
      break;
    case 'place': {
      const c = find(action.id);
      const tokenId = c.tokenId ?? uniqueTokenId(s.map, c.id);
      s.map = onMap(s, (m) => placeToken(m, { id: tokenId, name: c.name, kind: c.kind, size: 'medium', ...(c.hidden ? { hidden: true } : {}) }, action.at));
      c.tokenId = tokenId;
      break;
    }
    case 'door':
      s.map = onMap(s, (m) => setDoor(m, action.index, action.state));
      break;
    case 'difficult':
      s.map = onMap(s, (m) => setDifficult(m, action.at, action.on));
      break;
    case 'newMap': {
      if (s.map) throw new EncounterError('This encounter already has a map');
      s.map = asEncounterError(() => blankMap(action.width, action.height));
      break;
    }
    default:
      throw new EncounterError('Unknown action');
  }
  return s;
}

/** Applies a map change, as an EncounterError when the map refuses it. */
function onMap(s: EncounterState, change: (map: BattleMap) => BattleMap): BattleMap {
  if (!s.map) throw new EncounterError('This encounter has no map');
  const map = s.map;
  return asEncounterError(() => change(map));
}

function asEncounterError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof MapError) throw new EncounterError(err.message);
    throw err;
  }
}

function uniqueTokenId(map: BattleMap | null, base: string): string {
  const taken = new Set(map?.tokens.map((t) => t.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function requireRunning(s: EncounterState) {
  if (s.status !== 'running' || !s.turn) throw new EncounterError('Start the encounter first');
}

/** Replaces a condition of the same name (a new duration or level wins). */
function setCondition(c: Combatant, condition: Condition) {
  c.conditions = [...c.conditions.filter((x) => x.name !== condition.name), condition];
}

/** Counts down the conditions tied to the start or end of `of`'s turn; removes those that run out. */
function tick(s: EncounterState, of: string, on: 'start' | 'end', deps: RuleDeps) {
  for (const c of s.combatants) {
    const kept: Condition[] = [];
    for (const x of c.conditions) {
      if (x.rounds !== undefined && x.tick?.of === of && x.tick.on === on) {
        const rounds = x.rounds - 1;
        if (rounds <= 0) {
          s.log.push({ at: deps.now(), round: s.round, text: `${c.name} is no longer ${x.name}` });
          continue;
        }
        kept.push({ ...x, rounds });
      } else kept.push(x);
    }
    c.conditions = kept;
  }
}

function startTurn(s: EncounterState, deps: RuleDeps) {
  if (s.turn) tick(s, s.turn, 'start', deps);
}

/** Moves the turn forward (1) or back (-1), wrapping into the next or previous round. */
function advance(s: EncounterState, deps: RuleDeps, step: 1 | -1) {
  if (!s.turn || !s.order.length) return;
  const i = s.order.indexOf(s.turn);
  if (step === 1) tick(s, s.turn, 'end', deps);
  let j = i + step;
  if (j >= s.order.length) {
    j = 0;
    s.round++;
    s.log.push({ at: deps.now(), round: s.round, text: `Round ${s.round}` });
  } else if (j < 0) {
    if (s.round <= 1) return;
    j = s.order.length - 1;
    s.round--;
  }
  s.turn = s.order[j]!;
  if (step === 1) startTurn(s, deps);
}

/** The end-of-fight summary for the session notes and the recap. */
export function outcomeOf(s: EncounterState, endedAt: number): EncounterOutcome {
  const down = (c: Combatant) => c.hp === 0;
  const defeated = s.combatants.filter((c) => c.kind !== 'pc' && down(c)).map((c) => c.name);
  const downed = s.combatants.filter((c) => c.kind === 'pc' && (down(c) || c.conditions.some((x) => x.name === 'Unconscious'))).map((c) => c.name);
  const standing = s.combatants.filter((c) => c.kind !== 'pc' && !down(c)).map((c) => c.name);
  const rounds = Math.max(0, s.round);
  const parts = [`${s.title}: ${rounds} round${rounds === 1 ? '' : 's'}.`];
  if (defeated.length) parts.push(`Defeated: ${defeated.join(', ')}.`);
  if (standing.length) parts.push(`Still standing: ${standing.join(', ')}.`);
  if (downed.length) parts.push(`Dropped to 0 HP: ${downed.join(', ')}.`);
  return { id: s.id, title: s.title, rounds, startedAt: s.startedAt, endedAt, defeated, downed, standing, text: parts.join(' ') };
}
