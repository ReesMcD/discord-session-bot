import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Every /api request must carry `Authorization: Bearer <APP_PASSWORD>`. The app controls a bot
 * that records people, so there is no unauthenticated mode.
 */
export function requirePassword(password: string): MiddlewareHandler {
  const expected = digest(password);
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
