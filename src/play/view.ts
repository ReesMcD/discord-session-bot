import type { Combatant, EncounterAction, EncounterState, Health, PlayerCombatant, PlayerRequest, PlayerView } from '../shared/types.js';
import { CONDITIONS, EncounterError } from '../encounter/rules.js';

/** How hurt a monster looks: down at 0, bloodied at half or less (the usual table call). */
export function healthOf(c: Combatant): Health | null {
  if (c.hp === null) return null;
  if (c.hp === 0) return 'down';
  return c.maxHp && c.hp <= c.maxHp / 2 ? 'bloodied' : 'healthy';
}

/**
 * One player's view of the encounter. Leaves out hidden combatants entirely, monsters' and NPCs'
 * numbers (only how hurt they look), initiative values, stat blocks, DM notes, the log and the map.
 */
export function playerView(s: EncounterState, me: string | null): PlayerView {
  const visible = (c: Combatant | undefined): c is Combatant => !!c && !c.hidden;
  const byId = new Map(s.combatants.map((c) => [c.id, c]));
  const order = s.order.map((id) => byId.get(id)).filter(visible);
  const pc = (c: Combatant) => c.kind === 'pc';
  const mine = me ? byId.get(me) : undefined;
  const taken = new Set((s.join?.players ?? []).map((p) => p.combatantId).filter(Boolean));
  return {
    title: s.title,
    status: s.status,
    round: s.round,
    turn: s.turn && visible(byId.get(s.turn)) ? s.turn : null,
    me: mine ? mine.id : null,
    order: order.map(
      (c): PlayerCombatant => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        current: c.id === s.turn,
        hp: pc(c) ? c.hp : null,
        maxHp: pc(c) ? c.maxHp : null,
        tempHp: pc(c) ? c.tempHp : 0,
        health: pc(c) ? null : healthOf(c),
        conditions: c.conditions.map((x) => ({ name: x.name, ...(x.level ? { level: x.level } : {}), ...(x.rounds ? { rounds: x.rounds } : {}) })),
        concentrating: pc(c) ? c.concentrating : null,
      }),
    ),
    party: s.combatants.filter(pc).map((c) => ({ id: c.id, name: c.name, taken: taken.has(c.id) })),
    myInitiative: mine?.initiative ?? null,
    myAc: mine?.ac ?? null,
  };
}

/** A player's request as a tracker action, if they may make it: only on their own PC. */
export function playerAction(s: EncounterState, me: string | null, request: PlayerRequest): EncounterAction {
  const mine = me ? s.combatants.find((c) => c.id === me && c.kind === 'pc') : undefined;
  if (!mine) throw new EncounterError('Pick your character first');
  switch (request?.type) {
    case 'initiative':
      // Theirs to set while the DM collects them; after that the DM changes it.
      if (s.status !== 'setup' && mine.initiative !== null) throw new EncounterError('Initiative is set: ask the DM to change it');
      return { type: 'initiative', id: mine.id, value: request.value };
    case 'damage':
    case 'heal':
    case 'tempHp':
      return { type: request.type, id: mine.id, amount: request.amount };
    case 'condition':
      if (!CONDITIONS.includes(request.name)) throw new EncounterError('Unknown condition');
      return { type: 'condition', id: mine.id, name: request.name, ...(request.remove ? { remove: true } : {}) };
    default:
      throw new EncounterError('Unknown request');
  }
}
