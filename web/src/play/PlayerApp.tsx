import { useEffect, useRef, useState } from 'react';
import type { ConditionName, PlayerCombatant, PlayerView } from '../../../src/shared/types';
import { OrbMark } from '../icons';
import { BattleMapView, type TokenInfo } from '../map/BattleMapView';
import { device, follow, play, PlayError } from './client';

const CONDITIONS: ConditionName[] = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];

type Screen = { kind: 'loading' } | { kind: 'ended' } | { kind: 'join'; view: PlayerView } | { kind: 'play'; view: PlayerView };

/** What a player sees after tapping the link in Discord: pick your character once, then follow the fight. */
export function PlayerApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [error, setError] = useState('');
  // Bumped after joining, so the live stream reconnects as this device.
  const [connection, setConnection] = useState(0);

  useEffect(() => {
    const joined = !!device.token;
    let stop: (() => void) | undefined;
    const start = () => {
      stop?.();
      stop = follow({
        onView: (view) => setScreen(device.token ? { kind: 'play', view } : { kind: 'join', view }),
        onEnded: () => setScreen({ kind: 'ended' }),
        onRejoin: () => {
          device.token = '';
          start();
        },
      });
    };
    play.view().then(
      (view) => {
        setScreen(joined ? { kind: 'play', view } : { kind: 'join', view });
        start();
      },
      (e: unknown) => {
        if (e instanceof PlayError && e.status === 401) {
          device.token = '';
          start();
        } else if (e instanceof PlayError && (e.status === 410 || e.status === 404)) setScreen({ kind: 'ended' });
        else setError((e as Error).message);
      },
    );
    return () => stop?.();
  }, [connection]);

  const join = async (combatantId: string | null) => {
    setError('');
    try {
      const { token, view } = await play.join(combatantId);
      device.token = token;
      setScreen({ kind: 'play', view });
      setConnection((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = async (request: Parameters<typeof play.act>[0]) => {
    setError('');
    try {
      setScreen({ kind: 'play', view: await play.act(request) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="play">
      <header className="play-top">
        <OrbMark size={24} /> <span>Scrying Eye</span>
      </header>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {screen.kind === 'loading' && !error && <p className="muted">Opening the encounter…</p>}
      {screen.kind === 'ended' && (
        <div className="empty">
          <strong>This encounter has ended</strong>
          Or the DM made a new link: ask for it in Discord.
        </div>
      )}
      {screen.kind === 'join' && <Join view={screen.view} onJoin={join} />}
      {screen.kind === 'play' && <Fight view={screen.view} act={act} />}
    </div>
  );
}

function Join({ view, onJoin }: { view: PlayerView; onJoin: (id: string | null) => void }) {
  return (
    <div>
      <p className="muted small play-kicker">Round {Math.max(view.round, 1)}</p>
      <h1>{view.title}</h1>
      <p className="muted">Pick your character to follow the fight and take your turns. This device remembers it.</p>
      <ul className="join-list">
        {view.party.map((p) => (
          <li key={p.id}>
            <button className="join-pc" disabled={p.taken} onClick={() => onJoin(p.id)}>
              <span className="avatar">{p.name.slice(0, 2).toUpperCase()}</span>
              <span className="join-name">{p.name}</span>
              <span className="muted small">{p.taken ? 'Joined' : 'This is me'}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="link" onClick={() => onJoin(null)}>
        Just watch
      </button>
    </div>
  );
}

const HEALTH_LABEL = { healthy: 'Healthy', bloodied: 'Bloodied', down: 'Down' } as const;

function Fight({ view, act }: { view: PlayerView; act: (r: Parameters<typeof play.act>[0]) => Promise<void> }) {
  const me = view.order.find((c) => c.id === view.me) ?? null;
  const myTurn = !!view.me && view.turn === view.me;
  const current = view.order.find((c) => c.current);
  const wasMyTurn = useRef(false);
  useEffect(() => {
    if (myTurn && !wasMyTurn.current) navigator.vibrate?.([120, 60, 120]);
    wasMyTurn.current = myTurn;
  }, [myTurn]);

  return (
    <div className="stack">
      <div>
        <p className="muted small play-kicker">{view.status === 'running' ? `Round ${view.round}` : 'Getting ready'}</p>
        <h1>{view.title}</h1>
      </div>
      {myTurn ? (
        <div className="your-turn" role="status">
          Your turn
        </div>
      ) : (
        view.status === 'running' && <p className="muted">{current ? `${current.name}’s turn` : 'Someone is taking their turn…'}</p>
      )}
      {view.me && view.status === 'setup' && view.myInitiative === null && <InitiativePrompt act={act} />}
      {me && <MyCard me={me} ac={view.myAc} initiative={view.myInitiative} act={act} />}
      {view.map && <PlayerMap view={view} act={act} />}
      <section aria-label="Turn order">
        <h2>Turn order</h2>
        <ol className="play-order">
          {view.order.map((c) => (
            <OrderRow key={c.id} c={c} you={c.id === view.me} />
          ))}
        </ol>
      </section>
    </div>
  );
}

/** The map: everyone visible, the party's HP, and my own token to drag. */
function PlayerMap({ view, act }: { view: PlayerView; act: (r: Parameters<typeof play.act>[0]) => Promise<void> }) {
  const map = view.map!;
  const myToken = view.me ? view.tokens[view.me] : undefined;
  const info: Record<string, TokenInfo> = {};
  for (const c of view.order) {
    const token = view.tokens[c.id];
    if (token) info[token] = { name: c.name, current: c.current, hp: c.hp, maxHp: c.maxHp, mine: c.id === view.me };
  }
  return (
    <section aria-label="Battle map">
      <h2>Map</h2>
      <BattleMapView
        map={map}
        info={info}
        canMove={(t) => t === myToken}
        onMove={(_, at) => void act({ type: 'move', at })}
        label={`Battle map, ${map.width} by ${map.height} squares`}
      />
      <p className="muted small map-hint">{myToken ? 'Drag your token (ringed) to move. Pinch to zoom, drag the map to look around.' : view.me ? 'The DM hasn’t put you on the map yet.' : 'Pinch to zoom, drag to look around.'}</p>
    </section>
  );
}

function InitiativePrompt({ act }: { act: (r: { type: 'initiative'; value: number }) => Promise<void> }) {
  const [value, setValue] = useState('');
  const n = Number(value);
  return (
    <form
      className="card initiative-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && Number.isInteger(n)) void act({ type: 'initiative', value: n });
      }}
    >
      <label htmlFor="init" className="field-label">
        Roll initiative: what did you get?
      </label>
      <div className="row">
        <input id="init" inputMode="numeric" autoFocus value={value} placeholder="e.g. 17" onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ''))} style={{ flex: 1 }} />
        <button className="primary" disabled={!value.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function MyCard({ me, ac, initiative, act }: { me: PlayerCombatant; ac: number | null; initiative: number | null; act: (r: Parameters<typeof play.act>[0]) => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [condition, setCondition] = useState<ConditionName>('Prone');
  const n = Number(amount);
  const valid = amount.trim() !== '' && Number.isInteger(n) && n >= 0;
  const pct = me.hp !== null && me.maxHp ? Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100)) : 0;
  const send = (type: 'damage' | 'heal' | 'tempHp') => void act({ type, amount: n }).then(() => setAmount(''));
  return (
    <section className="card my-card" aria-label="Your character">
      <div className="row spread">
        <strong className="my-name">{me.name}</strong>
        <span className="row muted small">
          {ac !== null && <span>AC {ac}</span>}
          {initiative !== null && <span>Init {initiative}</span>}
        </span>
      </div>
      {me.hp !== null && (
        <>
          <div className="my-hp tabular">
            {me.hp}
            {me.maxHp !== null && <span className="muted"> / {me.maxHp}</span>}
            {me.tempHp > 0 && <span className="temp-hp"> +{me.tempHp} temp</span>}
          </div>
          <div className={`hp-bar ${me.hp === 0 ? 'zero' : pct <= 25 ? 'bad' : pct <= 50 ? 'warn' : 'good'}`} aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      <div className="row">
        <label htmlFor="amount" className="visually-hidden">
          Amount
        </label>
        <input id="amount" className="amount" inputMode="numeric" value={amount} placeholder="Amount" onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
        <button className="danger" disabled={!valid} onClick={() => send('damage')}>
          Took damage
        </button>
        <button disabled={!valid} onClick={() => send('heal')}>
          Healed
        </button>
        <button disabled={!valid} onClick={() => send('tempHp')}>
          Temp HP
        </button>
      </div>
      <div className="chips">
        {me.conditions.map((x) => (
          <button key={x.name} className="chip" aria-label={`Remove ${x.name}`} onClick={() => void act({ type: 'condition', name: x.name, remove: true })}>
            {x.name}
            {x.level ? ` ${x.level}` : ''}
            {x.rounds ? ` · ${x.rounds}r` : ''} ✕
          </button>
        ))}
      </div>
      <div className="row">
        <label htmlFor="cond" className="visually-hidden">
          Condition
        </label>
        <select id="cond" value={condition} onChange={(e) => setCondition(e.target.value as ConditionName)} style={{ flex: 1 }}>
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button onClick={() => void act({ type: 'condition', name: condition })}>Add</button>
      </div>
      {me.concentrating && <p className="small muted">Concentrating on {me.concentrating}</p>}
    </section>
  );
}

function OrderRow({ c, you }: { c: PlayerCombatant; you: boolean }) {
  const pct = c.hp !== null && c.maxHp ? Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100)) : 0;
  return (
    <li className={`play-row ${c.current ? 'current' : ''} ${c.health === 'down' || c.hp === 0 ? 'down' : ''}`}>
      <span className={`kind-dot ${c.kind}`} aria-hidden />
      <span className="play-row-main">
        <span className="play-row-name">
          {c.name}
          {you && <span className="badge accent">you</span>}
        </span>
        {c.hp !== null && c.maxHp !== null ? (
          <span className={`hp-bar ${c.hp === 0 ? 'zero' : pct <= 25 ? 'bad' : pct <= 50 ? 'warn' : 'good'}`} aria-label={`${c.hp} of ${c.maxHp} HP`}>
            <i style={{ width: `${pct}%` }} />
          </span>
        ) : (
          c.health && <span className={`badge ${c.health === 'healthy' ? '' : c.health === 'bloodied' ? 'warn' : 'bad'}`}>{HEALTH_LABEL[c.health]}</span>
        )}
        {c.conditions.length > 0 && <span className="muted small">{c.conditions.map((x) => x.name).join(', ')}</span>}
      </span>
    </li>
  );
}
