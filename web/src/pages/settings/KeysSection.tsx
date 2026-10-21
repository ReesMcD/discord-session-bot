import { useEffect, useState } from 'react';
import { auth } from '../../api';
import { Field } from '../../ui';

const KEY_FIELDS = [
  {
    key: 'discord',
    label: 'Discord bot token',
    hint: 'discord.com/developers/applications → your app → Bot → Reset Token',
    url: 'https://discord.com/developers/applications',
  },
  { key: 'groq', label: 'Groq API key (transcription)', hint: 'console.groq.com/keys → Create API Key', url: 'https://console.groq.com/keys' },
  {
    key: 'anthropic',
    label: 'Anthropic API key (summaries)',
    hint: 'platform.claude.com/settings/keys → Create key (starts with sk-ant-)',
    url: 'https://platform.claude.com/settings/keys',
  },
  { key: 'wiki', label: 'Wiki upload key (optional)', hint: 'Only if your upload endpoint needs one: the token or API key it gave you. The address is under Settings → Upload.', optional: true },
] as const;

/** Mac app only: keys are stored in the Keychain by the app, never sent to the web API. */
export function KeysSection() {
  const bridge = window.sessionBot!;
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState<{ password: string; port: number } | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [msg, setMsg] = useState('');
  const [folder, setFolder] = useState('');
  const [version, setVersion] = useState('');
  useEffect(() => {
    void bridge.getKeys().then(setSaved);
    void bridge.getPhoneAccess().then(setPhone);
    void bridge.dataFolder().then(setFolder);
    void bridge.version().then(setVersion);
  }, [bridge]);

  const save = async () => {
    const patch = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    const r = await bridge.setKeys(patch);
    setSaved(await bridge.getKeys());
    setValues({});
    setMsg(r.restarted ? 'Saved. Reconnecting to Discord…' : 'Saved');
  };
  const remove = async (key: string) => {
    await bridge.setKeys({ [key]: '' });
    setSaved(await bridge.getKeys());
  };

  const missing = KEY_FIELDS.filter((f) => !('optional' in f) && !saved[f.key]);
  return (
    <div>
      {missing.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <strong>Welcome! Add your keys to get started.</strong>
          <p className="muted small">
            They're stored encrypted in your Mac's Keychain. The Discord token is needed to record; Groq to transcribe; Anthropic to summarize. Anything you skip can be
            added later.
          </p>
        </div>
      )}
      <div className="card">
        {KEY_FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            hint={
              <>
                {f.hint}{' '}
                {'url' in f && (
                  <button type="button" className="link" onClick={() => void bridge.openExternal(f.url)}>
                    Open ↗
                  </button>
                )}
              </>
            }
          >
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={saved[f.key] ? '•••••••• saved (type to replace)' : 'Paste here'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              {saved[f.key] && (
                <button type="button" className="danger" onClick={() => void remove(f.key)}>
                  Remove
                </button>
              )}
            </div>
          </Field>
        ))}
        <div className="row spread">
          <span className="muted small">{msg}</span>
          <button className="primary" disabled={!Object.values(values).some((v) => v.trim())} onClick={() => void save()}>
            Save keys
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Phone access</h2>
        <ol className="small" style={{ paddingLeft: 18 }}>
          <li>
            Install{' '}
            <button type="button" className="link" onClick={() => void bridge.openExternal('https://tailscale.com/download')}>
              Tailscale
            </button>{' '}
            on this Mac and your phone, signed in to the same account.
          </li>
          <li>
            On the phone, open <code>http://&lt;this Mac&apos;s Tailscale name&gt;:{phone?.port ?? 4400}</code> (the name is shown in the Tailscale app).
          </li>
          <li>Sign in with the password below, then use Share → Add to Home Screen.</li>
        </ol>
        {phone && (
          <div className="row">
            <code style={{ fontSize: '1rem', padding: '6px 10px' }}>{showPw ? phone.password : '••••-••••-••••-••••'}</code>
            <button type="button" onClick={() => setShowPw((v) => !v)}>
              {showPw ? 'Hide' : 'Show'}
            </button>
            <button type="button" onClick={() => void bridge.copy(phone.password).then(() => setMsg('Password copied'))}>
              Copy
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (window.confirm('Make a new password? Phones signed in with the old one will need the new one.')) void bridge.resetPassword().then((p) => {
                    auth.set(p.password); // keep this window signed in
                    setPhone((x) => (x ? { ...x, ...p } : x));
                  });
              }}
            >
              New password
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your data</h2>
        <p className="muted small">
          Recordings, transcripts, summaries and settings are in <code>{folder}</code>.
        </p>
        <div className="row spread">
          <button type="button" onClick={() => void bridge.revealDataFolder()}>
            Show in Finder
          </button>
          <span className="muted small">Session Bot {version}</span>
        </div>
      </div>
    </div>
  );
}
