import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

/** The remote address of a request, or undefined when there's no socket (in-process tests). */
export function clientAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function ipv4(address: string): number[] | undefined {
  const v4 = address.replace(/^::ffff:/i, '');
  const parts = v4.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : undefined;
}

/** This Mac (loopback) or a Tailscale device (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function isLocalOrTailscale(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return v4[0] === 127 || (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127);
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6.startsWith('fd7a:115c:a1e0:');
}

/**
 * Refuses requests from anywhere but this Mac and Tailscale, unless LAN access is turned on. The
 * server still listens on every interface so Tailscale works even if it starts after the app.
 */
export function networkGuard(allowLan: boolean): MiddlewareHandler {
  return async (c, next) => {
    const address = clientAddress(c);
    if (!allowLan && address && !isLocalOrTailscale(address)) {
      return c.text('Scrying Eye only answers on this Mac and over Tailscale (set APP_ALLOW_LAN=1 to allow your local network).', 403);
    }
    await next();
  };
}
