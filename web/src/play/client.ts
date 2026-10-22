import type { PlayerRequest, PlayerView } from '../../../src/shared/types';

/** The join code is the last part of /play/<code>. */
export const code = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const KEY = `scrying-eye-play:${code}`;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** This device's token for this link, remembered so a reload keeps your character. */
export const device = {
  get token(): string {
    return storage()?.getItem(KEY) ?? '';
  },
  set token(t: string) {
    try {
      if (t) storage()?.setItem(KEY, t);
      else storage()?.removeItem(KEY);
    } catch {
      /* private mode: this tab only */
    }
  },
};

export class PlayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = device.token;
  const res = await fetch(`/p/${encodeURIComponent(code)}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new PlayError(res.status, body.error ?? `Error ${res.status}`);
  return body;
}

export const play = {
  view: () => call<PlayerView>('/view'),
  join: (combatantId: string | null) => call<{ token: string; view: PlayerView }>('/join', { method: 'POST', body: JSON.stringify({ combatantId }) }),
  act: (request: PlayerRequest) => call<PlayerView>('/act', { method: 'POST', body: JSON.stringify(request) }),
};

/**
 * Live updates. Phones sleep and drop connections, so it reconnects (and refetches) whenever the
 * page comes back into view, comes back online, or the stream ends.
 */
export function follow(handlers: { onView: (v: PlayerView) => void; onEnded: () => void; onRejoin: () => void }): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let wake: (() => void) | undefined;
  const nudge = () => wake?.();
  // A connection that slept with the phone can hang without failing: start a fresh one.
  const visible = () => {
    if (document.visibilityState !== 'visible') return;
    controller?.abort();
    nudge();
  };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', nudge);

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const token = device.token;
        const res = await fetch(`/p/${encodeURIComponent(code)}/events`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
        if (res.status === 410) return handlers.onEnded();
        if (res.status === 401) return handlers.onRejoin();
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (event === 'view' && data) handlers.onView(JSON.parse(data) as PlayerView);
            if (event === 'ended') return handlers.onEnded();
          }
        }
      } catch {
        /* dropped: wait, then reconnect */
      }
      if (stopped) return;
      await new Promise<void>((r) => {
        const t = setTimeout(r, 4000);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', nudge);
  };
}
