import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Secrets {
  discord?: string;
  groq?: string;
  anthropic?: string;
  /** Password for the web app (the Mac window signs in automatically; phones need it). */
  password: string;
}

export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Keys for the Mac app, encrypted with the macOS Keychain (Electron safeStorage) at rest. */
export class SecretStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  read(): Secrets {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(this.cipher.decrypt(readFileSync(this.file))) as Partial<Secrets>;
        if (parsed.password) return parsed as Secrets;
      } catch {
        // Unreadable (e.g. Keychain entry reset): start over rather than crash; the user re-enters keys.
      }
    }
    const fresh: Secrets = { password: generatePassword() };
    this.write(fresh);
    return fresh;
  }

  write(secrets: Secrets): void {
    writeFileSync(this.file, this.cipher.encrypt(JSON.stringify(secrets)), { mode: 0o600 });
  }

  update(patch: Partial<Omit<Secrets, 'password'>> & { password?: string }): Secrets {
    const next = { ...this.read() };
    for (const [k, v] of Object.entries(patch) as [keyof Secrets, string | undefined][]) {
      if (v === undefined) continue;
      if (v.trim() === '') {
        if (k !== 'password') delete next[k];
      } else next[k] = v.trim();
    }
    this.write(next);
    return next;
  }
}

/** Readable but strong: 4 groups of 4 from an unambiguous alphabet (~80 bits). */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** Maps stored keys to the environment variables the pipeline reads. */
export function applyToEnv(s: Secrets, env: NodeJS.ProcessEnv = process.env): void {
  const set = (name: string, v: string | undefined) => (v ? (env[name] = v) : delete env[name]);
  set('DISCORD_TOKEN', s.discord);
  set('GROQ_API_KEY', s.groq);
  set('ANTHROPIC_API_KEY', s.anthropic);
}
