import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ArtStatus } from '../../types';
import { Field } from '../../ui';
import type { SectionProps } from './shared';

/** Where the battle map art lives on this Mac (Forgotten Adventures packs), and how much was found. */
export function MapArtSection({ config, update, err }: SectionProps) {
  const [status, setStatus] = useState<ArtStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = status?.dir ?? null;
  useEffect(() => {
    api<ArtStatus>('/art/status').then(setStatus, () => {});
  }, []);
  const reindex = async () => {
    setBusy(true);
    try {
      setStatus(await api<ArtStatus>('/art/reindex', { method: 'POST' }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Battle maps are drawn plainly until you point this at a folder of map art, like the{' '}
        <a href="https://www.forgotten-adventures.net/" target="_blank" rel="noreferrer">
          Forgotten Adventures
        </a>{' '}
        packs you've downloaded. Pictures are matched by their file names (<code>Tree_Oak_A1_2x2.png</code> is a 2×2 oak). The files stay on this Mac: they're shown
        to your own game only, and never copied or uploaded.
      </p>
      <Field label="Art folder" hint="The folder's full path, e.g. /Users/you/Documents/Forgotten Adventures. Save, then it's indexed." error={err('battle_maps.assets_dir')}>
        <input
          value={config.battle_maps.assets_dir ?? ''}
          placeholder="/Users/you/Documents/Forgotten Adventures"
          onChange={(e) => update((c) => void (c.battle_maps.assets_dir = e.target.value.trim() ? e.target.value : undefined))}
        />
      </Field>
      {status && saved && (
        <div className="row spread">
          <span className={status.error ? 'small bad-text' : 'muted small'}>
            {status.error ?? `${status.files.toLocaleString()} pictures found${status.indexedAt ? `, indexed ${new Date(status.indexedAt).toLocaleTimeString()}` : ''}.`}
          </span>
          <button type="button" disabled={busy} onClick={() => void reindex()}>
            {busy ? 'Indexing…' : 'Index again'}
          </button>
        </div>
      )}
    </div>
  );
}
