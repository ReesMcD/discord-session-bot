import type { Job } from './types';

// Same-origin by default; set VITE_API_URL when the UI is hosted elsewhere (e.g. Vercel).
const BASE = `${(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')}/api`;
const KEY = 'session-bot-password';

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

let password = storage()?.getItem(KEY) ?? '';
const logoutListeners = new Set<() => void>();

export const auth = {
  get isSet() {
    return !!password;
  },
  set(p: string) {
    password = p;
    try {
      storage()?.setItem(KEY, p);
    } catch {
      /* private mode: stays in memory */
    }
  },
  clear() {
    password = '';
    try {
      storage()?.removeItem(KEY);
    } catch {
      /* ignore */
    }
    logoutListeners.forEach((f) => f());
  },
  onLogout(f: () => void) {
    logoutListeners.add(f);
    return () => logoutListeners.delete(f);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.error ?? body?.errors?.[0]?.message ?? `HTTP ${status}`);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(BASE + path, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
  });
  if (res.status === 401) {
    auth.clear();
    throw new ApiError(401, { error: 'Wrong password' });
  }
  const text = await res.text();
  const body = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export async function downloadFile(sessionId: string, name: string): Promise<void> {
  const text = await api<string>(`/sessions/${encodeURIComponent(sessionId)}/files/${name}`);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${sessionId}-${name}` });
  a.click();
  URL.revokeObjectURL(url);
}

/** Live job updates over server-sent events (fetch-based so the password header can be sent). */
export function subscribeJobs(onJob: (job: Job) => void): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${BASE}/events`, { headers: { Authorization: `Bearer ${password}` }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const event = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (event === 'job' && data) onJob(JSON.parse(data) as Job);
          }
        }
      } catch {
        /* reconnect below */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
