import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The password, or a function returning the current one (the Mac app can change it while running). */
export type PasswordSource = string | (() => string);

/**
 * Every /api request must carry `Authorization: Bearer <APP_PASSWORD>`. The app controls a bot
 * that records people, so there is no unauthenticated mode.
 */
export function requirePassword(password: PasswordSource): MiddlewareHandler {
  const current = typeof password === 'string' ? () => password : password;
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), digest(current()))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
