import { useState } from 'react';
import { api, apiBlob } from '../../api';
import { doorsAt, isDifficult, type Cell, type MapToken } from '../../../../src/shared/battlemap';
import { BattleMapView, type TokenInfo } from '../../map/BattleMapView';
import { useArtPlan } from '../../map/useArtPlan';
import type { ArtPlan, EncounterAction, EncounterState } from '../../types';
import { Segmented } from '../../ui';

type Act = (action: EncounterAction) => Promise<void>;
type Tool = 'move' | 'doors' | 'difficult';

const NEXT_DOOR_STATE = { open: 'closed', closed: 'locked', locked: 'open' } as const;

/** The DM's battle map: move any token, work doors, mark difficult ground, put combatants on the map. */
export function MapCard({ state, act, onSelect }: { state: EncounterState; act: Act; onSelect: (combatantId: string) => void }) {
  const [tool, setTool] = useState<Tool>('move');
  const [placing, setPlacing] = useState<string | null>(null);
  const [size, setSize] = useState({ width: '20', height: '15' });
  const map = state.map;
  const art = useArtPlan(map, () => api<ArtPlan | null>('/encounter/art'));

  if (!map)
    return (
      <details className="card">
        <summary>
          <strong>Battle map</strong> <span className="muted small">none yet</span>
        </summary>
        <p className="muted small">This encounter came without a map. Start a blank grid and place everyone on it.</p>
        <div className="row">
          <label className="row small">
            Width <input inputMode="numeric" value={size.width} style={{ width: 64 }} onChange={(e) => setSize({ ...size, width: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="row small">
            Height <input inputMode="numeric" value={size.height} style={{ width: 64 }} onChange={(e) => setSize({ ...size, height: e.target.value.replace(/\D/g, '') })} />
          </label>
          <button className="primary" onClick={() => void act({ type: 'newMap', width: Number(size.width), height: Number(size.height) })}>
            Add a blank map
          </button>
        </div>
      </details>
    );

  const byToken = new Map(state.combatants.filter((c) => c.tokenId).map((c) => [c.tokenId!, c]));
  const info: Record<string, TokenInfo> = {};
  for (const t of map.tokens) {
    const c = byToken.get(t.id);
    info[t.id] = c ? { name: c.name, current: c.id === state.turn, hp: c.hp, maxHp: c.maxHp, hidden: c.hidden } : { name: t.name, hidden: !!t.hidden };
  }
  const offMap = state.combatants.filter((c) => !c.tokenId || !map.tokens.some((t) => t.id === c.tokenId));
  const placingName = placing ? state.combatants.find((c) => c.id === placing)?.name : undefined;

  const onTap = (at: Cell, token: MapToken | undefined) => {
    if (placing) {
      void act({ type: 'place', id: placing, at }).then(() => setPlacing(null));
      return;
    }
    if (tool === 'doors') {
      const [door] = doorsAt(map, at);
      if (door !== undefined) {
        const current = map.terrain[door]!.state ?? 'closed';
        void act({ type: 'door', index: door, state: NEXT_DOOR_STATE[current] });
      }
      return;
    }
    if (tool === 'difficult') {
      void act({ type: 'difficult', at, on: !isDifficult(map, at) });
      return;
    }
    const c = token ? byToken.get(token.id) : undefined;
    if (c) onSelect(c.id);
  };

  return (
    <section className="card" aria-label="Battle map">
      <div className="map-tools">
        <Segmented
          value={tool}
          options={[
            { value: 'move', label: 'Move' },
            { value: 'doors', label: 'Doors' },
            { value: 'difficult', label: 'Difficult' },
          ]}
          onChange={(t) => (setTool(t), setPlacing(null))}
        />
        {offMap.length > 0 && (
          <span className="row small">
            <span className="muted">Not on the map:</span>
            {offMap.map((c) => (
              <button key={c.id} type="button" className={`chip${placing === c.id ? ' on' : ''}`} onClick={() => setPlacing(placing === c.id ? null : c.id)}>
                {c.name}
              </button>
            ))}
          </span>
        )}
      </div>
      <BattleMapView
        map={map}
        info={info}
        canMove={() => tool === 'move' && !placing}
        onMove={(token, at) => void act({ type: 'move', token, at })}
        onTap={onTap}
        showNotes
        art={art}
        loadArt={(id) => apiBlob(`/art/${encodeURIComponent(id)}`)}
        label={`Battle map, ${map.width} by ${map.height} squares`}
      />
      <p className="muted small map-hint">
        {placingName
          ? `Tap a square to put ${placingName} there.`
          : tool === 'doors'
            ? 'Tap a door: open → closed → locked.'
            : tool === 'difficult'
              ? 'Tap a square to mark or clear difficult terrain.'
              : 'Drag a token to move it; tap one for its details. Pinch or scroll to zoom.'}
        {map.notes.length > 0 && tool === 'move' && !placing && ` ${map.notes.length} note${map.notes.length === 1 ? '' : 's'} (yellow dots): ${map.notes.map((n) => n.text).join(' · ')}`}
      </p>
    </section>
  );
}

