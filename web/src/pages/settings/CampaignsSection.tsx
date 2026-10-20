import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Campaign, GuildInfo, Person } from '../../types';
import { Field } from '../../ui';
import { ID_RE, personLabel, PersonPicker, type SectionProps } from './shared';

export function CampaignsSection({ config, update, err, people }: SectionProps & { people: Person[] }) {
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [manual, setManual] = useState('');
  useEffect(() => {
    api<GuildInfo[]>('/bot/guilds').then(setGuilds, () => {});
  }, []);
  const channels = guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}${guilds.length > 1 ? ` (${g.name})` : ''}` })));
  const ids = Object.keys(config.campaigns);
  const add = (id: string) => update((c) => void (c.campaigns[id] = { characters: {} }));
  // Rebuilt in a fixed key order so config.yaml reads name, context, characters.
  const set = (id: string, f: (k: Campaign) => void) =>
    update((c) => {
      const k = c.campaigns[id]!;
      f(k);
      c.campaigns[id] = { ...(k.name ? { name: k.name } : {}), ...(k.context ? { context: k.context } : {}), characters: k.characters };
    });

  return (
    <div>
      <p className="muted small">
        A campaign is tied to the voice channel you play in. Listing who plays which character lets the recap tell party members from NPCs and credit kills to
        characters. Recordings imported from Craig use the campaign when there's only one.
      </p>
      {ids.map((id) => {
        const k = config.campaigns[id]!;
        const players = Object.keys(k.characters);
        return (
          <div className="card" key={id}>
            <div className="row spread">
              <strong>{channels.find((ch) => ch.id === id)?.label ?? 'Voice channel'}</strong>
              <span className="row">
                <span className="muted small">{id}</span>
                <button className="link danger" onClick={() => update((c) => void delete c.campaigns[id])}>
                  Remove
                </button>
              </span>
            </div>
            <div className="grid2">
              <Field label="Campaign name" hint="Used as the recap's title." error={err(`campaigns.${id}.name`)}>
                <input value={k.name ?? ''} placeholder="e.g. Curse of Strahd" onChange={(e) => set(id, (x) => void (x.name = e.target.value.trim() ? e.target.value : undefined))} />
              </Field>
            </div>
            <Field label="Background" hint="Setting, party level, recurring names: anything Claude should know for this campaign." error={err(`campaigns.${id}.context`)}>
              <textarea value={k.context ?? ''} placeholder="Gothic horror in Barovia. The party is level 5." onChange={(e) => set(id, (x) => void (x.context = e.target.value.trim() ? e.target.value : undefined))} />
            </Field>
            <Field label="Characters" hint='"Name — description", e.g. "Thorin — dwarf fighter". Use "DM" for the game master.' error={err(`campaigns.${id}.characters`)}>
              <div className="list-editor">
                {players.map((pid) => (
                  <div className="list-row" key={pid}>
                    <span style={{ flex: '0 1 160px' }} className="small">
                      {personLabel(pid, people, config)}
                    </span>
                    <input value={k.characters[pid]} onChange={(e) => set(id, (x) => void (x.characters[pid] = e.target.value))} />
                    <button type="button" className="icon danger" title="Remove" onClick={() => set(id, (x) => void delete x.characters[pid])}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </Field>
            <PersonPicker people={people} exclude={players} placeholder="Add a player…" onPick={(pid) => set(id, (x) => void (x.characters[pid] = 'Character — class'))} />
          </div>
        );
      })}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Add a campaign</h2>
        <div className="row" style={{ alignItems: 'stretch' }}>
          {channels.some((c) => !ids.includes(c.id)) && (
            <select value="" onChange={(e) => e.target.value && add(e.target.value)} style={{ flex: '1 1 200px' }}>
              <option value="">Pick a voice channel…</option>
              {channels
                .filter((c) => !ids.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
          )}
          <div className="row" style={{ flex: '1 1 240px', flexWrap: 'nowrap' }}>
            <input value={manual} inputMode="numeric" placeholder="…or paste a voice channel ID" onChange={(e) => setManual(e.target.value.trim())} />
            <button type="button" disabled={!ID_RE.test(manual) || ids.includes(manual)} onClick={() => (add(manual), setManual(''))}>
              Add
            </button>
          </div>
        </div>
        {channels.length === 0 && <p className="muted small">Voice channels are listed here while the bot is running; otherwise paste the channel's ID (right-click → Copy Channel ID).</p>}
      </div>
    </div>
  );
}
