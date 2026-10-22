import { useState } from 'react';
import type { Combatant, ConditionName, EncounterAction, EncounterState } from '../../types';

/** The 2024 conditions (the server checks them too: src/encounter/rules.ts). */
const CONDITIONS: ConditionName[] = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];

type Act = (action: EncounterAction) => Promise<void>;

/** Everything the DM does to one combatant: HP, conditions, concentration, hiding, editing, the stat block. */
export function CombatantPanel({ c, state, act }: { c: Combatant; state: EncounterState; act: Act }) {
  const [amount, setAmount] = useState('');
  const [condition, setCondition] = useState<ConditionName>('Prone');
  const [rounds, setRounds] = useState('');
  const [tickOn, setTickOn] = useState<'start' | 'end'>('end');
  const [tickOf, setTickOf] = useState(c.id);
  const [spell, setSpell] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const n = Number(amount);
  const valid = amount.trim() !== '' && Number.isInteger(n) && n >= 0;
  const hpAction = (type: 'damage' | 'heal' | 'tempHp') => void act({ type, id: c.id, amount: n }).then(() => setAmount(''));
  const block = c.ref ? state.statBlocks[c.ref] : undefined;

  return (
    <div className="combatant-panel">
      <div className="row hp-controls">
        <label htmlFor={`amt-${c.id}`} className="visually-hidden">
          Amount
        </label>
        <input id={`amt-${c.id}`} className="amount" inputMode="numeric" value={amount} placeholder="Amount" onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
        <button className="danger" disabled={!valid} onClick={() => hpAction('damage')}>
          Damage
        </button>
        <button disabled={!valid || c.hp === null} onClick={() => hpAction('heal')}>
          Heal
        </button>
        <button disabled={!valid} onClick={() => hpAction('tempHp')}>
          Temp HP
        </button>
      </div>

      <div className="row condition-add">
        <label className="visually-hidden" htmlFor={`cond-${c.id}`}>
          Condition
        </label>
        <select id={`cond-${c.id}`} value={condition} onChange={(e) => setCondition(e.target.value as ConditionName)}>
          {CONDITIONS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`rounds-${c.id}`}>
          Rounds (optional)
        </label>
        <input id={`rounds-${c.id}`} className="amount" inputMode="numeric" value={rounds} placeholder="Rounds" onChange={(e) => setRounds(e.target.value.replace(/\D/g, ''))} />
        {rounds && (
          <>
            <select aria-label="Counts down at" value={tickOn} onChange={(e) => setTickOn(e.target.value as 'start' | 'end')}>
              <option value="end">at the end of</option>
              <option value="start">at the start of</option>
            </select>
            <select aria-label="Whose turn" value={tickOf} onChange={(e) => setTickOf(e.target.value)}>
              {state.combatants.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id === c.id ? 'its own turn' : `${x.name}’s turn`}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          onClick={() =>
            void act({ type: 'condition', id: c.id, name: condition, ...(rounds ? { rounds: Number(rounds), tick: { on: tickOn, of: tickOf } } : {}) }).then(() => setRounds(''))
          }
        >
          Add condition
        </button>
      </div>
      {c.conditions.length > 0 && (
        <div className="chips">
          {c.conditions.map((x) => (
            <button key={x.name} className="chip" aria-label={`Remove ${x.name}`} onClick={() => void act({ type: 'condition', id: c.id, name: x.name, remove: true })}>
              {x.name}
              {x.level ? ` ${x.level}` : ''}
              {x.rounds ? ` · ${x.rounds} round${x.rounds > 1 ? 's' : ''}` : ''} ✕
            </button>
          ))}
        </div>
      )}

      <div className="row">
        {c.concentrating ? (
          <button onClick={() => void act({ type: 'concentrate', id: c.id, spell: null })}>Stop concentrating on {c.concentrating}</button>
        ) : (
          <>
            <label className="visually-hidden" htmlFor={`spell-${c.id}`}>
              Spell
            </label>
            <input id={`spell-${c.id}`} style={{ flex: 1, minWidth: 140 }} value={spell} placeholder="Concentrating on… (Bless)" onChange={(e) => setSpell(e.target.value)} />
            <button disabled={!spell.trim()} onClick={() => void act({ type: 'concentrate', id: c.id, spell }).then(() => setSpell(''))}>
              Concentrate
            </button>
          </>
        )}
      </div>

      <div className="row">
        <button onClick={() => void act({ type: 'reveal', id: c.id, hidden: !c.hidden })}>{c.hidden ? 'Reveal to players' : 'Hide from players'}</button>
        <EditCombatant c={c} act={act} />
        <button className="danger" onClick={() => (confirmRemove ? void act({ type: 'remove', id: c.id }) : setConfirmRemove(true))} onBlur={() => setConfirmRemove(false)}>
          {confirmRemove ? 'Tap again to remove' : 'Remove'}
        </button>
      </div>

      {block && (
        <details className="stat-block">
          <summary>
            <strong>{block.name}</strong>
            <span className="muted small">
              {' '}
              {[block.size, block.type, block.cr ? `CR ${block.cr}` : null, block.source === 'srd' ? 'SRD 5.2' : block.source === 'bestiary' ? 'Bestiary' : null].filter(Boolean).join(' · ')}
            </span>
          </summary>
          <p className="small">
            {[block.ac !== undefined ? `AC ${block.ac}` : null, block.hp !== undefined ? `HP ${block.hp}${block.hit_dice ? ` (${block.hit_dice})` : ''}` : null, block.speed ? `Speed ${Object.entries(block.speed).filter(([, v]) => v).map(([k, v]) => (k === 'walk' ? `${v} ft.` : `${k} ${v} ft.`)).join(', ')}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {block.abilities && (
            <p className="small tabular">
              {['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((a, i) => {
                const score = block.abilities![i] ?? 10;
                const mod = Math.floor((score - 10) / 2);
                return (
                  <span key={a} className="ability">
                    {a} {score} ({mod >= 0 ? '+' : ''}
                    {mod})
                  </span>
                );
              })}
            </p>
          )}
          {[block.senses && `Senses: ${block.senses}`, block.languages && `Languages: ${block.languages}`, block.resistances && `Resistances: ${block.resistances}`, block.immunities && `Immunities: ${block.immunities}`]
            .filter(Boolean)
            .map((line) => (
              <p key={line as string} className="small">
                {line}
              </p>
            ))}
          {[...(block.traits ?? []), ...(block.actions ?? [])].map((t) => (
            <p key={t.name} className="small">
              <strong>{t.name}.</strong> {t.desc}
            </p>
          ))}
          {!block.traits?.length && !block.actions?.length && block.stat_block && <p className="small pre-line">{block.stat_block}</p>}
        </details>
      )}
    </div>
  );
}

function EditCombatant({ c, act }: { c: Combatant; act: Act }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(c.name);
  const [ac, setAc] = useState(c.ac === null ? '' : String(c.ac));
  const [maxHp, setMaxHp] = useState(c.maxHp === null ? '' : String(c.maxHp));
  const [hp, setHp] = useState(c.hp === null ? '' : String(c.hp));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  if (!open) return <button onClick={() => setOpen(true)}>Edit</button>;
  return (
    <form
      className="edit-combatant"
      onSubmit={(e) => {
        e.preventDefault();
        void act({ type: 'update', id: c.id, name, ac: num(ac), maxHp: num(maxHp), hp: num(hp) }).then(() => setOpen(false));
      }}
    >
      <label>
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className="field-label">AC</span>
        <input inputMode="numeric" value={ac} onChange={(e) => setAc(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label>
        <span className="field-label">HP</span>
        <input inputMode="numeric" value={hp} onChange={(e) => setHp(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label>
        <span className="field-label">Max HP</span>
        <input inputMode="numeric" value={maxHp} onChange={(e) => setMaxHp(e.target.value.replace(/\D/g, ''))} />
      </label>
      <button className="primary">Save</button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
