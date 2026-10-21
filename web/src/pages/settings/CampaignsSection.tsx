import { useEffect, useState } from 'react';
import { api } from '../../api';
import { dndBeyondCampaignUrl, dndBeyondCharacterUrl, parseDndBeyondId } from '../../dndbeyond';
import type { Campaign, Config, GuildInfo, Person } from '../../types';
import { Field } from '../../ui';
import { ID_RE, personLabel, PersonPicker, type SectionProps } from './shared';

type CharacterEntry = Campaign['characters'][string];
type CharacterObject = Exclude<CharacterEntry, string>;

/** The roster writes the object form; older "Thorin — dwarf fighter" strings are read the same way the server reads them. */
function toObject(entry: CharacterEntry): CharacterObject {
  if (typeof entry !== 'string') return entry;
  const m = /^(.+?)\s+[—–-]\s+(.+)$|^(.+?):\s*(.+)$/.exec(entry);
  const name = (m?.[1] ?? m?.[3] ?? entry).trim();
  const description = (m?.[2] ?? m?.[4])?.trim();
  return { name, ...(description ? { description } : {}) };
}

function realName(config: Config, id: string): string {
  const v = config.speakers[id];
  return typeof v === 'string' ? v : (v?.name ?? '');
}

/** The real name lives in `speakers`, shared by every campaign (and shared accounts keep their identities). */
function setRealName(c: Config, id: string, name: string): void {
  const v = c.speakers[id];
  if (v && typeof v !== 'string') c.speakers[id] = { ...v, name: name || undefined };
  else if (name) c.speakers[id] = name;
  else delete c.speakers[id];
}

export function CampaignsSection({ config, update, err, people }: SectionProps & { people: Person[] }) {
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [manual, setManual] = useState('');
  useEffect(() => {
    api<GuildInfo[]>('/bot/guilds').then(setGuilds, () => {});
  }, []);
  const channels = guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}${guilds.length > 1 ? ` (${g.name})` : ''}` })));
  const ids = Object.keys(config.campaigns);
  const add = (id: string) => update((c) => void (c.campaigns[id] = { characters: {}, guests: [] }));
  // Rebuilt in a fixed key order so config.yaml reads name, context, dndbeyond, characters, guests.
  const set = (id: string, f: (k: Campaign) => void) =>
    update((c) => {
      const k = c.campaigns[id]!;
      f(k);
      c.campaigns[id] = {
        ...(k.name ? { name: k.name } : {}),
        ...(k.context ? { context: k.context } : {}),
        ...(k.dndbeyond ? { dndbeyond: k.dndbeyond } : {}),
        characters: k.characters,
        guests: k.guests,
      };
    });

  return (
    <div>
      <p className="muted small">
        A campaign is tied to the voice channel you play in. Pair each person with their real name and character once; transcripts then show character names,
        and the recap can tell the party from NPCs. Recordings imported from Craig use the campaign when there's only one.
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
              <DndBeyondField
                label="D&D Beyond campaign"
                value={k.dndbeyond}
                url={dndBeyondCampaignUrl}
                error={err(`campaigns.${id}.dndbeyond`)}
                onChange={(v) => set(id, (x) => void (x.dndbeyond = v))}
              />
            </div>
            <Field label="Background" hint="Setting, party level, recurring names: anything Claude should know for this campaign." error={err(`campaigns.${id}.context`)}>
              <textarea value={k.context ?? ''} placeholder="Gothic horror in Barovia. The party is level 5." onChange={(e) => set(id, (x) => void (x.context = e.target.value.trim() ? e.target.value : undefined))} />
            </Field>

            <h3 style={{ margin: '14px 0 6px' }}>Roster</h3>
            {err(`campaigns.${id}.characters`) && <div className="field-error">{err(`campaigns.${id}.characters`)}</div>}
            {players.length === 0 && <p className="muted small">Nobody yet. Add each player (and yourself as DM) below.</p>}
            {players.map((pid) => {
              const ch = toObject(k.characters[pid]!);
              const setCh = (patch: Partial<CharacterObject>) =>
                set(id, (x) => {
                  const next = { ...ch, ...patch };
                  x.characters[pid] = {
                    name: next.name,
                    ...(next.description ? { description: next.description } : {}),
                    ...(next.dndbeyond ? { dndbeyond: next.dndbeyond } : {}),
                  };
                });
              return (
                <div className="roster-row" key={pid}>
                  <div className="roster-who small">
                    <strong>{personLabel(pid, people, config)}</strong>
                    <span className="muted">{people.find((p) => p.id === pid)?.names.join(' / ') ?? pid}</span>
                  </div>
                  <label className="roster-field">
                    <span className="field-label">Real name</span>
                    <input value={realName(config, pid)} placeholder="e.g. Sam" onChange={(e) => update((c) => setRealName(c, pid, e.target.value))} />
                  </label>
                  <label className="roster-field">
                    <span className="field-label">Character</span>
                    <input value={ch.name} placeholder="e.g. Thorin, or DM" onChange={(e) => setCh({ name: e.target.value })} />
                  </label>
                  <label className="roster-field">
                    <span className="field-label">Description</span>
                    <input value={ch.description ?? ''} placeholder="e.g. dwarf fighter 5" onChange={(e) => setCh({ description: e.target.value.trim() ? e.target.value : undefined })} />
                  </label>
                  <DndBeyondField label="D&D Beyond sheet" compact value={ch.dndbeyond} url={dndBeyondCharacterUrl} onChange={(v) => setCh({ dndbeyond: v })} />
                  <button type="button" className="icon danger" title="Remove from the roster" onClick={() => set(id, (x) => void delete x.characters[pid])}>
                    ✕
                  </button>
                </div>
              );
            })}
            <PersonPicker people={people} exclude={[...players, ...k.guests]} placeholder="Add a player…" onPick={(pid) => set(id, (x) => void (x.characters[pid] = { name: 'Character' }))} />

            <h3 style={{ margin: '14px 0 6px' }}>Guests</h3>
            <p className="muted small" style={{ marginTop: 0 }}>
              People who talk at the table but don't play. They're never asked about as new players, and the recap treats what they say as table talk.
            </p>
            {k.guests.map((gid) => (
              <div key={gid} className="row spread list-row" style={{ marginBottom: 6 }}>
                <span>
                  <strong>{personLabel(gid, people, config)}</strong> <span className="muted small">{gid}</span>
                </span>
                <button className="danger" onClick={() => set(id, (x) => void (x.guests = x.guests.filter((g) => g !== gid)))}>
                  Remove
                </button>
              </div>
            ))}
            <PersonPicker people={people} exclude={[...players, ...k.guests]} placeholder="Add a guest…" onPick={(gid) => set(id, (x) => void x.guests.push(gid))} />
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

/** A D&D Beyond link or ID: stored as the ID, shown as a link once set. */
function DndBeyondField({ label, value, url, onChange, error, compact }: { label: string; value: number | undefined; url: (id: number) => string; onChange: (id: number | undefined) => void; error?: string | undefined; compact?: boolean }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  const invalid = text.trim() !== '' && parseDndBeyondId(text) === undefined;
  return (
    <label className={compact ? 'roster-field' : `field${error || invalid ? ' has-error' : ''}`}>
      <span className="field-label">
        {label}
        {value ? (
          <>
            {' '}
            <a href={url(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              open
            </a>
          </>
        ) : null}
      </span>
      <input
        value={text}
        placeholder="link or ID"
        onChange={(e) => {
          setText(e.target.value);
          const id = parseDndBeyondId(e.target.value);
          if (id !== undefined || !e.target.value.trim()) onChange(id);
        }}
      />
      {!compact && <span className="field-hint">Paste the D&D Beyond link; syncing comes later.</span>}
      {(error || invalid) && <span className="field-error">{error ?? 'Not a D&D Beyond link or ID'}</span>}
    </label>
  );
}
