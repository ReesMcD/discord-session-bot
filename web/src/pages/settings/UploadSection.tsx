import { useEffect, useState } from 'react';
import { api } from '../../api';
import { href } from '../../router';
import type { Config, UploadTestResult } from '../../types';
import { Field, Segmented, Toggle } from '../../ui';
import type { SectionProps } from './shared';

type Upload = Config['upload'];

/** What the endpoint receives, so whoever builds it knows the contract. */
const EXAMPLE = {
  id: '2026-10-20T19-02-11Z_game-night',
  title: 'Curse of Strahd — 2026-10-20',
  date: '2026-10-20',
  startedAt: '2026-10-20T19:02:11.000Z',
  stoppedAt: '2026-10-20T22:31:40.000Z',
  campaign: 'Curse of Strahd',
  channel: 'game-night',
  edited: true,
  markdown: '# Recap: Curse of Strahd\n…\n## NPCs\n…',
};

export function UploadSection({ config, update, err }: SectionProps) {
  const u = config.upload;
  const set = <K extends keyof Upload>(k: K, v: Upload[K]) => update((c) => void (c.upload[k] = v));
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [test, setTest] = useState<UploadTestResult | { ok: false; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    api<{ keys: Record<string, boolean> }>('/health').then((h) => setKeySaved(!!h.keys.upload), () => {});
  }, []);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api<UploadTestResult>('/upload/test', { method: 'POST', json: { upload: u } }));
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          Sends a session's recap, with your edits, to your wiki or anything else that accepts a web request. Each session has an <strong>Upload to wiki</strong> button
          on its recap. Uploading the same session again sends the same <code>id</code>, so your endpoint can update the page instead of adding a new one.
        </p>
        <Field label="Address" hint="The endpoint's full URL. Leave empty to turn uploading off." error={err('upload.url')}>
          <input
            type="url"
            inputMode="url"
            value={u.url ?? ''}
            placeholder="https://wiki.example.com/api/recaps"
            onChange={(e) => set('url', e.target.value.trim() ? e.target.value.trim() : undefined)}
          />
        </Field>
        <div className="grid2">
          <Field label="Method">
            <Segmented
              value={u.method}
              options={[
                { value: 'POST', label: 'POST' },
                { value: 'PUT', label: 'PUT' },
              ]}
              onChange={(v) => set('method', v)}
            />
          </Field>
          <Field label="Body">
            <Segmented
              value={u.format}
              options={[
                { value: 'json', label: 'JSON' },
                { value: 'markdown', label: 'Markdown file' },
              ]}
              onChange={(v) => set('format', v)}
            />
          </Field>
        </div>
        <Field
          label="Key"
          hint={
            <>
              {keySaved === null ? '' : keySaved ? 'A key is saved. ' : 'No key saved yet. '}
              {window.sessionBot ? (
                <>
                  The key itself is kept in the Keychain: <a href={href('settings', 'keys')}>Settings → Keys</a>.
                </>
              ) : (
                <>
                  The key itself goes in <code>.env</code> on the Mac as <code>WIKI_UPLOAD_TOKEN</code>, never in config.yaml.
                </>
              )}
            </>
          }
        >
          <Segmented
            value={u.auth}
            options={[
              { value: 'bearer', label: 'Bearer token' },
              { value: 'header', label: 'Custom header' },
              { value: 'none', label: 'None' },
            ]}
            onChange={(v) => set('auth', v)}
          />
        </Field>
        {u.auth === 'header' && (
          <Field label="Header name" hint='Sent as "<name>: <key>".' error={err('upload.header_name')}>
            <input value={u.header_name} onChange={(e) => set('header_name', e.target.value.trim())} />
          </Field>
        )}
        <Toggle
          checked={u.auto}
          onChange={(v) => set('auto', v)}
          label="Upload automatically after a recording"
          hint='Once its recap is written (needs "After a recording: Transcribe + recap" under Recording & people). Off: you review and edit first.'
        />
        <div className="row">
          <button disabled={!u.url || testing} onClick={() => void runTest()} title="Sends { &quot;test&quot;: true } with these settings, saved or not">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {test && (
            <span className={`small ${test.ok ? 'good-text' : 'bad-text'}`} role="status">
              {test.message}
            </span>
          )}
        </div>
      </div>

      <details className="card">
        <summary>
          <strong>What your endpoint receives</strong>
        </summary>
        <p className="small muted">
          {u.method} to the address, with <code>Idempotency-Key</code> (changes only when the recap does) and the key header.{' '}
          {u.format === 'json' ? (
            <>
              Body (<code>application/json</code>):
            </>
          ) : (
            <>
              Body (<code>text/markdown</code>): the same fields as YAML front matter, then the recap.
            </>
          )}
        </p>
        <pre className="code-sample">
          {u.format === 'json'
            ? JSON.stringify(EXAMPLE, null, 2)
            : `---\n${Object.entries(EXAMPLE)
                .filter(([k]) => k !== 'markdown')
                .map(([k, v]) => `${k}: ${typeof v === 'string' && /[:#—]/.test(v) ? JSON.stringify(v) : v}`)
                .join('\n')}\n---\n\n${EXAMPLE.markdown}`}
        </pre>
        <p className="small muted">
          Reply with any 2xx. To link the page from the app, return a <code>Location</code> header or JSON with <code>"url"</code>. 5xx and network errors are retried;
          401/403 are reported as a key problem. <strong>Test connection</strong> sends <code>{'{"test": true}'}</code> (or <code>test: true</code> front matter): reply 2xx
          and don't save it.
        </p>
      </details>
    </div>
  );
}
