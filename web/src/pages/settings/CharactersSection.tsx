import { useEffect, useState } from 'react';
import { rosterId } from '../../../../src/shared/ids';
import { api } from '../../api';
import { dndBeyondCharacterUrl, parseDndBeyondId } from '../../dndbeyond';
import { href } from '../../router';
import type { Config, DndBeyondCharacter } from '../../types';
import { Empty } from '../../ui';
import { DndBeyondField } from './DndBeyondField';
import type { SectionProps } from './shared';

type Character = Config['characters'][string];
type NewCharacter = { name: string; description?: string | undefined; dndbeyond?: number | undefined };

/** Rebuilt in a fixed key order so config.yaml reads name, description, dndbeyond, campaign, speaker. */
const tidy = (c: Character): Character => ({
  name: c.name,
  ...(c.description ? { description: c.description } : {}),
  ...(c.dndbeyond ? { dndbeyond: c.dndbeyond } : {}),
  ...(c.campaign ? { campaign: c.campaign } : {}),
  ...(c.speaker ? { speaker: c.speaker } : {}),
});

/** Player characters by campaign: added by hand, or from D&D Beyond (one sheet brings its whole campaign). */
export function CharactersSection({ config, update, err }: SectionProps) {
  const campaignIds = Object.keys(config.campaigns);
  const groups: Array<{ campaign: string | undefined; title: string }> = [
    ...campaignIds.map((id) => ({ campaign: id as string | undefined, title: config.campaigns[id]!.name })),
    ...(Object.values(config.characters).some((c) => !c.campaign || !config.campaigns[c.campaign]) ? [{ campaign: undefined, title: 'No campaign' }] : []),
  ];
  const set = (id: string, f: (c: Character) => void) =>
    update((c) => {
      const ch = c.characters[id]!;
      f(ch);
      c.characters[id] = tidy(ch);
    });
  const add = (campaign: string | undefined, ch: NewCharacter) =>
    update((c) => {
      c.characters[rosterId(ch.name, (x) => x in c.characters)] = tidy({ ...ch, ...(campaign ? { campaign } : {}) } as Character);
    });

  if (!campaignIds.length && !Object.keys(config.characters).length)
    return (
      <Empty title="Add a campaign first">
        Characters belong to a campaign. <a href={href('settings', 'campaigns')}>Add one under Campaigns</a>.
      </Empty>
    );

  return (
    <div>
      <p className="muted small">
        The party, by campaign. Transcripts name each line by the character, and the recap tells the party from NPCs. Who plays a character is one of your{' '}
        <a href={href('settings', 'speakers')}>speakers</a>.
      </p>
      {groups.map(({ campaign, title }) => {
        const ids = Object.keys(config.characters).filter((id) => {
          const c = config.characters[id]!.campaign;
          return campaign ? c === campaign : !c || !config.campaigns[c];
        });
        return (
          <div className="card" key={campaign ?? '-'}>
            <h2 style={{ marginTop: 0 }}>{title}</h2>
            {ids.length === 0 && <p className="muted small">No characters yet.</p>}
            {ids.map((id) => (
              <CharacterRow key={id} id={id} config={config} character={config.characters[id]!} set={(f) => set(id, f)} remove={() => update((c) => void delete c.characters[id])} err={err} />
            ))}
            {campaign && (
              <>
                <h3 style={{ margin: '14px 0 6px' }}>Add a character</h3>
                <AddCharacter
                  config={config}
                  campaign={campaign}
                  onAdd={(ch, dndbeyondCampaign) => {
                    add(campaign, ch);
                    // The first sheet from a D&D Beyond campaign links the campaign too.
                    if (dndbeyondCampaign && !config.campaigns[campaign]!.dndbeyond) update((c) => void (c.campaigns[campaign]!.dndbeyond = dndbeyondCampaign));
                  }}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CharacterRow({ id, config, character: ch, set, remove, err }: { id: string; config: Config; character: Character; set: (f: (c: Character) => void) => void; remove: () => void; err: SectionProps['err'] }) {
  return (
    <div className="roster-row">
      <label className="roster-field">
        <span className="field-label">Name</span>
        <input value={ch.name} onChange={(e) => set((x) => void (x.name = e.target.value))} />
      </label>
      <label className="roster-field">
        <span className="field-label">Description</span>
        <input value={ch.description ?? ''} placeholder="e.g. dwarf fighter 5" onChange={(e) => set((x) => void (x.description = e.target.value.trim() ? e.target.value : undefined))} />
      </label>
      <label className="roster-field">
        <span className="field-label">Played by</span>
        <select value={ch.speaker ?? ''} onChange={(e) => set((x) => void (x.speaker = e.target.value || undefined))}>
          <option value="">Nobody yet</option>
          {Object.entries(config.speakers).map(([sid, s]) => (
            <option key={sid} value={sid}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="roster-field">
        <span className="field-label">Campaign</span>
        <select value={ch.campaign ?? ''} onChange={(e) => set((x) => void (x.campaign = e.target.value || undefined))}>
          <option value="">None</option>
          {Object.entries(config.campaigns).map(([cid, k]) => (
            <option key={cid} value={cid}>
              {k.name}
            </option>
          ))}
        </select>
      </label>
      <DndBeyondField label="D&D Beyond sheet" compact value={ch.dndbeyond} url={dndBeyondCharacterUrl} onChange={(v) => set((x) => void (x.dndbeyond = v))} />
      <button type="button" className="icon danger" title="Remove this character" onClick={remove}>
        ✕
      </button>
      {(err(`characters.${id}.speaker`) ?? err(`characters.${id}.campaign`) ?? err(`characters.${id}.name`)) && (
        <div className="field-error">{err(`characters.${id}.speaker`) ?? err(`characters.${id}.campaign`) ?? err(`characters.${id}.name`)}</div>
      )}
    </div>
  );
}

/**
 * Add by name (custom), or from D&D Beyond: paste one character's link, and the campaign it's in
 * offers its other characters too. Once a character here has a D&D Beyond sheet, its campaign's
 * characters are offered straight away.
 */
function AddCharacter({ config, campaign, onAdd }: { config: Config; campaign: string; onAdd: (ch: NewCharacter, dndbeyondCampaign?: number) => void }) {
  const here = Object.values(config.characters).filter((c) => c.campaign === campaign);
  const known = new Set(Object.values(config.characters).map((c) => c.dndbeyond).filter(Boolean));
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [found, setFound] = useState<DndBeyondCharacter | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const lookup = async (id: number) => {
    setBusy(id);
    setError('');
    try {
      return await api<DndBeyondCharacter>(`/dndbeyond/characters/${id}`);
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  // The campaign's characters, from any sheet already linked here.
  const seed = here.find((c) => c.dndbeyond)?.dndbeyond;
  useEffect(() => {
    if (seed && !found) void lookup(seed).then((c) => c && setFound(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const addFromDndBeyond = async (id: number, fallbackName: string) => {
    const sheet = found?.id === id ? found : await lookup(id);
    onAdd({ name: sheet?.name ?? fallbackName, description: sheet?.description, dndbeyond: id }, sheet?.campaign?.id ?? found?.campaign?.id);
  };
  const offers = [
    ...(found && !known.has(found.id) ? [{ id: found.id, name: found.name, player: undefined as string | undefined }] : []),
    ...(found?.campaign?.characters.filter((c) => c.id !== found.id && !known.has(c.id)) ?? []),
  ];

  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input value={name} placeholder="A name, e.g. Thorin" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && (e.preventDefault(), onAdd({ name: name.trim() }), setName(''))} />
        <button type="button" className="primary" disabled={!name.trim()} onClick={() => (onAdd({ name: name.trim() }), setName(''))}>
          Add
        </button>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap', marginTop: 8 }}>
        <input value={link} placeholder="…or paste a D&D Beyond character link" onChange={(e) => setLink(e.target.value)} />
        <button
          type="button"
          style={{ whiteSpace: 'nowrap' }}
          disabled={!parseDndBeyondId(link) || busy !== null}
          onClick={() =>
            void lookup(parseDndBeyondId(link)!).then((c) => {
              if (c) setFound(c);
              setLink('');
            })
          }
        >
          {busy !== null ? 'Looking…' : 'Look up'}
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
      {found && (
        <div style={{ marginTop: 8 }}>
          <p className="muted small" style={{ margin: '4px 0' }}>
            {found.campaign ? `From D&D Beyond: ${found.campaign.name}` : `From D&D Beyond: ${found.name}${found.description ? `, ${found.description}` : ''}`}
            {offers.length === 0 && ' (all added)'}
          </p>
          <div className="chips">
            {offers.map((o) => (
              <button key={o.id} type="button" className="chip" disabled={busy !== null} onClick={() => void addFromDndBeyond(o.id, o.name)}>
                + {o.name}
                {o.player ? <span className="muted"> ({o.player})</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
