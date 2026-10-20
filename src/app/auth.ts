import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { clientAddress } from './network.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The password, or a function returning the current one (the Mac app can change it while running). */
export type PasswordSource = string | (() => string);

/** Allows `max` wrong passwords per client per window; after that the client waits for the window to pass. */
export class SignInLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until this client may try again (0 = now). */
  waitFor(client: string): number {
    const recent = this.recent(client);
    return recent.length >= this.max ? recent[0]! + this.windowMs - this.now() : 0;
  }

  failed(client: string): void {
    this.failures.set(client, [...this.recent(client), this.now()]);
  }

  succeeded(client: string): void {
    this.failures.delete(client);
  }

  private recent(client: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(client) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(client, kept);
    else this.failures.delete(client);
    return kept;
  }
}

/**
 * Every /api request must carry `Authorization: Bearer <APP_PASSWORD>`. The app controls a bot
 * that records people, so there is no unauthenticated mode, and repeated wrong guesses are slowed.
 */
export function requirePassword(password: PasswordSource, limiter = new SignInLimiter()): MiddlewareHandler {
  const current = typeof password === 'string' ? () => password : password;
  return async (c, next) => {
    const client = clientAddress(c) ?? 'local';
    const wait = limiter.waitFor(client);
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.json({ error: 'Too many wrong passwords; try again in a minute' }, 429);
    }
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), digest(current()))) {
      limiter.failed(client);
      return c.json({ error: 'unauthorized' }, 401);
    }
    limiter.succeeded(client);
    await next();
  };
}
