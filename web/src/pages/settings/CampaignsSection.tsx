import { useEffect, useState } from 'react';
import { rosterId } from '../../../../src/shared/ids';
import { api } from '../../api';
import { dndBeyondCampaignUrl } from '../../dndbeyond';
import { href } from '../../router';
import type { Config, GuildInfo } from '../../types';
import { Field } from '../../ui';
import { DndBeyondField } from './DndBeyondField';
import { AddByName, ID_RE, type SectionProps } from './shared';

type Campaign = Config['campaigns'][string];

/** Rebuilt in a fixed key order so config.yaml reads name, context, dndbeyond, channels. */
const tidy = (k: Campaign): Campaign => ({
  name: k.name,
  ...(k.context ? { context: k.context } : {}),
  ...(k.dndbeyond ? { dndbeyond: k.dndbeyond } : {}),
  channels: k.channels,
});

/** The campaigns you run: a name, background for Claude, and optionally the voice channels you usually play in. */
export function CampaignsSection({ config, update, err }: SectionProps) {
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  useEffect(() => {
    api<GuildInfo[]>('/bot/guilds').then(setGuilds, () => {});
  }, []);
  const channels = guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}${guilds.length > 1 ? ` (${g.name})` : ''}` })));
  const channelLabel = (id: string) => channels.find((c) => c.id === id)?.label ?? 'Voice channel';
  const taken = new Set(Object.values(config.campaigns).flatMap((k) => k.channels));
  const ids = Object.keys(config.campaigns);
  const set = (id: string, f: (k: Campaign) => void) =>
    update((c) => {
      const k = c.campaigns[id]!;
      f(k);
      c.campaigns[id] = tidy(k);
    });
  const remove = (id: string) =>
    update((c) => {
      delete c.campaigns[id];
      for (const ch of Object.values(c.characters)) if (ch.campaign === id) delete ch.campaign;
    });

  return (
    <div>
      <Field
        label="Session names"
        hint="How new and existing sessions are named, unless you rename one: {campaign}, {channel}, {date} and {time}. A session's campaign can be changed on its page."
        error={err('sessions.title')}
      >
        <input value={config.sessions.title} onChange={(e) => update((c) => void (c.sessions.title = e.target.value))} placeholder="{campaign} — {date}" />
      </Field>
      <p className="muted small">
        Pick the campaign when you start a recording (in the app or with <code>/record campaign:</code>), or afterwards on the session's page. A usual voice channel
        makes it the default there. Recordings imported from Craig use the campaign when there's only one.
      </p>
      {ids.map((id) => {
        const k = config.campaigns[id]!;
        const characters = Object.values(config.characters).filter((ch) => ch.campaign === id);
        return (
          <div className="card" key={id}>
            <div className="grid2">
              <Field label="Name" hint="The recap's title. For wiki uploads, spell it as the wiki does." error={err(`campaigns.${id}.name`)}>
                <input value={k.name} placeholder="e.g. Curse of Strahd" onChange={(e) => set(id, (x) => void (x.name = e.target.value))} />
              </Field>
              <DndBeyondField label="D&D Beyond campaign" value={k.dndbeyond} url={dndBeyondCampaignUrl} error={err(`campaigns.${id}.dndbeyond`)} onChange={(v) => set(id, (x) => void (x.dndbeyond = v))} />
            </div>
            <Field label="Background" hint="Setting, party level, recurring names: anything Claude should know for this campaign." error={err(`campaigns.${id}.context`)}>
              <textarea value={k.context ?? ''} placeholder="Gothic horror in Barovia. The party is level 5." onChange={(e) => set(id, (x) => void (x.context = e.target.value.trim() ? e.target.value : undefined))} />
            </Field>

            <span className="field-label">Usual voice channels</span>
            {err(`campaigns.${id}.channels`) && <div className="field-error">{err(`campaigns.${id}.channels`)}</div>}
            <p className="muted small" style={{ marginTop: 2 }}>
              Optional. Recordings there belong to this campaign unless you pick another.
            </p>
            {k.channels.map((ch) => (
              <div key={ch} className="row spread list-row" style={{ marginBottom: 6 }}>
                <span>
                  <strong>{channelLabel(ch)}</strong> <span className="muted small">{ch}</span>
                </span>
                <button type="button" className="link danger" onClick={() => set(id, (x) => void (x.channels = x.channels.filter((c) => c !== ch)))}>
                  Remove
                </button>
              </div>
            ))}
            <ChannelPicker channels={channels.filter((c) => !taken.has(c.id))} onPick={(ch) => set(id, (x) => void x.channels.push(ch))} />

            <div className="row spread" style={{ marginTop: 10 }}>
              <span className="muted small">
                {characters.length ? `${characters.length} character${characters.length === 1 ? '' : 's'}: ${characters.map((c) => c.name).join(', ')}` : 'No characters yet'} ·{' '}
                <a href={href('settings', 'characters')}>Characters</a>
              </span>
              <button type="button" className="link danger" onClick={() => remove(id)}>
                Remove campaign
              </button>
            </div>
          </div>
        );
      })}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Add a campaign</h2>
        <AddByName placeholder="Its name, e.g. Curse of Strahd" onAdd={(name) => update((c) => void (c.campaigns[rosterId(name, (x) => x in c.campaigns)] = { name, channels: [] }))} />
      </div>
    </div>
  );
}

function ChannelPicker({ channels, onPick }: { channels: { id: string; label: string }[]; onPick: (id: string) => void }) {
  const [manual, setManual] = useState('');
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {channels.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} style={{ flex: '1 1 200px' }}>
          <option value="">Add a voice channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <div className="row" style={{ flex: '1 1 240px', flexWrap: 'nowrap' }}>
        <input value={manual} inputMode="numeric" placeholder="…or paste a voice channel ID" onChange={(e) => setManual(e.target.value.trim())} />
        <button type="button" disabled={!ID_RE.test(manual)} onClick={() => (onPick(manual), setManual(''))}>
          Add
        </button>
      </div>
    </div>
  );
}
