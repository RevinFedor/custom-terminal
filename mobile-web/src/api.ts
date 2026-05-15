// Thin wrapper around fetch + WebSocket for the mobile-web client.
//
// Token handling:
//   - On first load, accept ?token=... in the URL → store in localStorage,
//     then strip it from history so it doesn't sit in the browser bar.
//   - Subsequent loads read the token from localStorage.
//   - All REST calls send `Authorization: Bearer <token>`.
//   - WS upgrade can't set custom headers from the browser, so token goes in
//     the query string (?token=...) — the server checks both spots.

const TOKEN_KEY = 'noted-sdk-token';

export function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  tabCount: number;
  sdkTabCount: number;
  liveSdkCount: number;
  // SQLite stores updated_at as INTEGER (unix seconds) — keep as number
  updatedAt: number;
  isOpen: boolean;
  isActive: boolean;
};

export type TabInfo = {
  tabId?: string;
  name: string;
  tabType: string;
  commandType?: string;
  cwd: string;
  claudeSessionId?: string;
  // Number of Timeline-relevant entries (user prompts + compact boundaries)
  // on the active branch. null = no Claude session attached.
  timelineCount?: number | null;
  live?: { sessionId?: string; cwd: string } | null;
};

export type TimelineEntry = {
  uuid: string;
  kind: 'user' | 'assistant' | 'compact';
  color: string;
  preview: string;
  full: string;
  truncated: boolean;
  ts: number | null;
  tools: Array<{ id: string; name: string; input: any; result: string | null; isError: boolean }>;
};

export const Api = {
  ping: () => api<{ ok: boolean; lanIp: string }>('/api/me'),
  listProjects: () => api<{ projects: ProjectInfo[] }>('/api/projects'),
  listTabs: (projectId: string) =>
    api<{ project: { id: string; name: string; path: string }; tabs: TabInfo[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tabs`,
    ),
  createSDKTab: (projectId: string) =>
    api<{ tabId: string; name: string; cwd: string; projectId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/sdk-tabs`,
      { method: 'POST', body: '{}' },
    ),
  send: (tabId: string, prompt: string) =>
    api<{ success: boolean; error?: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/send`,
      { method: 'POST', body: JSON.stringify({ prompt }) },
    ),
  stop: (tabId: string) =>
    api<{ stopped: boolean }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/stop`,
      { method: 'POST', body: '{}' },
    ),
  rename: (tabId: string, name: string) =>
    api<{ tabId: string; name: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/rename`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  close: (tabId: string) =>
    api<{ closed: boolean }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/close`,
      { method: 'POST', body: '{}' },
    ),
  forkToSDK: (sourceTabId: string) =>
    api<{ tabId: string; sessionId: string; projectId: string }>(
      `/api/tabs/${encodeURIComponent(sourceTabId)}/fork-to-sdk`,
      { method: 'POST', body: '{}' },
    ),
  // last=N → tail-only response. Returns { messages, total, truncated, dropped }
  // so the caller can decide whether to background-fetch the full set after.
  history: (tabId: string, opts?: { last?: number }) => {
    const q = opts?.last ? `?last=${opts.last}` : '';
    return api<{ messages?: any[]; total?: number; truncated?: boolean; dropped?: number }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/history${q}`,
    );
  },
  timeline: (tabId: string) =>
    api<{ entries: TimelineEntry[]; sessionId?: string; count?: number }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/timeline`,
    ),
  getParams: (tabId: string) =>
    api<{ tabId: string; model: string; effort: string; thinking: 'adaptive' | 'disabled' }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/params`,
    ),
  setParams: (tabId: string, partial: { model?: string; effort?: string; thinking?: 'adaptive' | 'disabled' }) =>
    api<{ tabId: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/params`,
      { method: 'POST', body: JSON.stringify(partial) },
    ),
  // Fire-and-forget diagnostic log — server appends to logs/dev.log. Used from
  // mobile to debug things you can't see locally (timeline scroll, focus, etc).
  log: (tag: string, msg: string, data?: any) => {
    const token = getToken();
    fetch('/api/log/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ tag, msg, data }),
    }).catch(() => {});
  },
  // Pass `etag` from a previous successful response to enable revalidation —
  // server returns { etag, unchanged: true } when nothing changed (~50 bytes
  // instead of 60KB). Mobile then keeps using its localStorage copy.
  prompts: (etag?: string) =>
    api<{
      groups?: Array<{ id: number; name: string; position: number }>;
      prompts?: Array<{ id: number; title: string; content: string; group_id: number | null; position: number; file_paths: string[] }>;
      etag?: string;
      unchanged?: boolean;
    }>(`/api/prompts${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`),
};

// Build a websocket URL that points at the same origin as the page, with
// the bearer token embedded so the server can authenticate the upgrade.
export function wsUrl(tabId: string) {
  const token = getToken() || '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}&tabId=${encodeURIComponent(tabId)}`;
}
