import { useEffect, useState, type FormEvent } from 'react';
import type { Combatant, CombatantKind, EncounterAction, EncounterState } from '../../types';
import { Badge } from '../../ui';
import { CombatantPanel } from './CombatantPanel';
import { JoinPanel } from './JoinPanel';
import { MapCard } from './MapCard';

type Act = (action: EncounterAction) => Promise<void>;

/** The DM's tracker: turn order, HP, conditions, and the controls to run the round. */
export function Tracker({ state, act, onEnd }: { state: EncounterState; act: Act; onEnd: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const byId = new Map(state.combatants.map((c) => [c.id, c]));
  const ordered = state.order.map((id) => byId.get(id)).filter((c): c is Combatant => !!c);
  const running = state.status === 'running';
  const missing = state.combatants.filter((c) => c.initiative === null);
  const checks = state.combatants.filter((c) => c.concentrationCheck !== null);
  const current = state.turn ? byId.get(state.turn) : undefined;

  return (
    <div>
      <div className="row spread tracker-head">
        <div>
          <h1>{state.title}</h1>
          <div className="muted small">{running ? `Round ${state.round} · ${current?.name ?? ''}’s turn` : 'Setting up: initiative first'}</div>
        </div>
        <button className="danger" onClick={() => (confirmEnd ? void onEnd() : setConfirmEnd(true))} onBlur={() => setConfirmEnd(false)}>
          {confirmEnd ? 'Tap again to end' : 'End encounter'}
        </button>
      </div>

      <div className="card tracker-controls">
        {running ? (
          <div className="row">
            <button onClick={() => void act({ type: 'previous' })}>Previous</button>
            <button className="primary next-turn" onClick={() => void act({ type: 'next' })}>
              Next turn
            </button>
          </div>
        ) : (
          <div className="row">
            <button onClick={() => void act({ type: 'rollInitiative' })} disabled={!state.combatants.some((c) => c.kind !== 'pc' && c.initiative === null)}>
              Roll for monsters
            </button>
            <button className="primary" onClick={() => void act({ type: 'begin' })} disabled={!state.combatants.length || missing.length > 0}>
              Start round 1
            </button>
            {missing.length > 0 && <span className="muted small">Waiting on: {missing.map((c) => c.name).join(', ')}</span>}
          </div>
        )}
      </div>

      <JoinPanel state={state} />

      {checks.map((c) => (
        <div key={c.id} className="card notice row spread" role="alert">
          <span>
            <strong>{c.name}</strong>: Constitution save, DC {c.concentrationCheck}, to keep {c.concentrating}.
          </span>
          <span className="row">
            <button onClick={() => void act({ type: 'concentrationResult', id: c.id, kept: true })}>Kept it</button>
            <button className="danger" onClick={() => void act({ type: 'concentrationResult', id: c.id, kept: false })}>
              Lost it
            </button>
          </span>
        </div>
      ))}

      <MapCard
        state={state}
        act={act}
        onSelect={(id) => {
          setOpen(id);
          document.getElementById(`combatant-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }}
      />

      <ol className="initiative" aria-label="Turn order">
        {ordered.map((c) => (
          <li key={c.id} id={`combatant-${c.id}`} className={`combatant ${c.id === state.turn ? 'current' : ''} ${c.hp === 0 ? 'down' : ''}`}>
            <CombatantRow c={c} setup={!running} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} act={act} />
            {open === c.id && <CombatantPanel c={c} state={state} act={act} />}
          </li>
        ))}
      </ol>

      <AddCombatant act={act} />

      {state.notes && Object.values(state.notes).some(Boolean) && (
        <details className="card">
          <summary>
            <strong>Notes from the wiki</strong>
          </summary>
          {state.notes.read_aloud && <blockquote className="read-aloud">{state.notes.read_aloud}</blockquote>}
          {(
            [
              ['Setup', state.notes.setup],
              ['Tactics', state.notes.tactics],
              ['What changes the fight', state.notes.changes],
              ['Treasure', state.notes.treasure],
            ] as const
          ).map(([label, text]) =>
            text ? (
              <div key={label}>
                <h3>{label}</h3>
                <p className="pre-line">{text}</p>
              </div>
            ) : null,
          )}
        </details>
      )}

      {state.log.length > 0 && (
        <details className="card">
          <summary>
            <strong>Log</strong>
          </summary>
          <ul className="encounter-log">
            {[...state.log]
              .reverse()
              .slice(0, 30)
              .map((l, i) => (
                <li key={i}>
                  <span className="muted tabular">R{l.round}</span> {l.text}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const KIND_LABEL: Record<CombatantKind, string> = { pc: 'PC', monster: 'Monster', npc: 'NPC' };

function hpTone(c: Combatant): string {
  if (c.hp === null || c.maxHp === null || c.maxHp === 0) return '';
  const left = c.hp / c.maxHp;
  return c.hp === 0 ? 'zero' : left <= 0.25 ? 'bad' : left <= 0.5 ? 'warn' : 'good';
}

function CombatantRow({ c, setup, open, onToggle, act }: { c: Combatant; setup: boolean; open: boolean; onToggle: () => void; act: Act }) {
  const [init, setInit] = useState(c.initiative === null ? '' : String(c.initiative));
  useEffect(() => setInit(c.initiative === null ? '' : String(c.initiative)), [c.initiative]);
  const commit = () => {
    const value = init.trim() === '' ? null : Number(init);
    if (value === c.initiative || (value !== null && !Number.isInteger(value))) return;
    void act({ type: 'initiative', id: c.id, value });
  };
  const pct = c.hp !== null && c.maxHp ? Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100)) : 0;
  return (
    <div className="combatant-row">
      {setup ? (
        <input
          className="init-input tabular"
          inputMode="numeric"
          aria-label={`${c.name}'s initiative`}
          value={init}
          placeholder="–"
          onChange={(e) => setInit(e.target.value.replace(/[^\d-]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <span className="init tabular" aria-label="Initiative">
          {c.initiative ?? '–'}
        </span>
      )}
      <button type="button" className="combatant-main" aria-expanded={open} onClick={onToggle}>
        <span className="combatant-name">
          <span className={`kind-dot ${c.kind}`} aria-label={KIND_LABEL[c.kind]} />
          {c.name}
          {c.hidden && <Badge tone="warn">hidden</Badge>}
          {c.concentrating && <Badge tone="accent">◎ {c.concentrating}</Badge>}
        </span>
        <span className="combatant-stats tabular">
          {c.ac !== null && <span>AC {c.ac}</span>}
          {c.hp !== null && (
            <span>
              {c.hp}
              {c.maxHp !== null && `/${c.maxHp}`}
              {c.tempHp > 0 && <span className="temp-hp"> +{c.tempHp}</span>}
            </span>
          )}
        </span>
        {c.hp !== null && c.maxHp !== null && (
          <span className={`hp-bar ${hpTone(c)}`} aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        {c.conditions.length > 0 && (
          <span className="condition-chips">
            {c.conditions.map((x) => (
              <span key={x.name} className="condition">
                {x.name}
                {x.level ? ` ${x.level}` : ''}
                {x.rounds ? ` · ${x.rounds}r` : ''}
              </span>
            ))}
          </span>
        )}
      </button>
    </div>
  );
}

function AddCombatant({ act }: { act: Act }) {
  const [name, setName] = useState('');
  const [count, setCount] = useState('1');
  const [ac, setAc] = useState('');
  const [hp, setHp] = useState('');
  const [bonus, setBonus] = useState('');
  const [kind, setKind] = useState<CombatantKind>('monster');
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void act({
      type: 'add',
      combatant: { name: name.trim(), kind, count: num(count) ?? 1, ac: num(ac) ?? null, hp: num(hp) ?? null, ...(num(bonus) !== undefined ? { initiativeBonus: num(bonus) } : {}) },
    }).then(() => {
      setName('');
      setCount('1');
    });
  };
  return (
    <details className="card">
      <summary>
        <strong>Add a combatant</strong>
      </summary>
      <form onSubmit={submit} className="add-combatant">
        <label>
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wolf" />
        </label>
        <label>
          <span className="field-label">How many</span>
          <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
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
          <span className="field-label">Init. bonus</span>
          <input inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value.replace(/[^\d-]/g, ''))} />
        </label>
        <label>
          <span className="field-label">Side</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as CombatantKind)}>
            <option value="monster">Monster</option>
            <option value="npc">NPC</option>
            <option value="pc">PC</option>
          </select>
        </label>
        <button className="primary" disabled={!name.trim()}>
          Add
        </button>
      </form>
    </details>
  );
}
