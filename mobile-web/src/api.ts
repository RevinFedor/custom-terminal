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
  // True when any claude tab in this project is blocked on an AskUserQuestion —
  // the project card shows the rotating purple ring (mirror of desktop).
  hasAwaiting?: boolean;
};

export type TabInfo = {
  tabId?: string;
  name: string;
  tabType: string;
  commandType?: string;
  // Desktop user-assigned tab color (TabColor enum) — drives the row background
  // so the mobile list looks exactly like the desktop vertical tab list. null =
  // default (faint translucent bg). Server may omit it (old build) → treated null.
  color?: string | null;
  cwd: string;
  claudeSessionId?: string;
  // Number of Timeline-relevant entries (user prompts + compact boundaries)
  // on the active branch. null = no Claude session attached.
  timelineCount?: number | null;
  live?: { sessionId?: string; cwd: string } | null;
  // For PTY+Claude tabs only: lifecycle of the embedded `claude` process.
  // null for SDK tabs and bare-shell tabs. Drives the loader + row glow.
  sessionStatus?: 'active' | 'busy' | 'inactive' | null;
  // True when Claude is blocked on an AskUserQuestion in this tab — the tab list
  // shows a pulsing purple dot ("needs your answer"), mirroring the desktop glow.
  awaiting?: boolean;
  // Assigned-category status (dev/bugfix/knowledge/custom) mirrored from the
  // desktop "Статусы" palette. `statusId` is the stable id, `statusColor` the
  // resolved hex from the desktop palette. null when no category is assigned or
  // the desktop server predates this field (graceful: marker falls back).
  statusId?: string | null;
  statusColor?: string | null;
};

// Status-marker shape/size mirrored from the desktop useUIStore.statusMarker.
// Sent at the top of /api/projects/:id/tabs so the phone draws the SAME left
// marker (square vs dot) the desktop TabBar uses.
export type StatusMarkerCfg = { shape: 'dot' | 'square'; sizePx: number };

// Process-bar config mirrored from desktop useUIStore.processBar. Drives the
// loader STRIP (переливающаяся полоска) on the tab-row edge: base color, shimmer
// color/spacing/opacity, and position. There is no pulse toggle and no whole-tab tint.
export type ProcessBarCfg = {
  colorA: string;
  shimmerColor: string;
  shimmerSpacingPct: number;
  shimmerOpacityPct: number;
  position: 'left' | 'right';
};

// ── Prompt Queue ("Run after") — mobile mirror of the desktop store ──────────
// Mobile does NOT own the queue: it reads this core from the desktop store and
// pushes mutation ops back; the desktop App-root runner fires the prompts. Live
// deltas arrive via the `queue-update` SSE event. The shape mirrors the
// desktop's PromptQueueCore (usePromptQueueStore.ts).
export type QueueItem = {
  id: string;
  enabled?: boolean;
  title?: string;
  titleManual?: boolean;
  text: string;
  images: number;
  createdAt: number;
};
export type QueueCore = {
  items: QueueItem[];
  autoRun: boolean;
  stopAfter: boolean;
  closeAfter: boolean;
  runAfterTabId: string | null;
  firstDelaySeconds: number;
  postPromptEnabled: boolean;
  postPromptText: string;
};
export type QueueAiTab = { id: string; name: string; kind: 'claude-pty' | 'claude-sdk' | 'gemini' | 'codex' };
export type QueueData = { tabId: string; queue: QueueCore; aiTabs: QueueAiTab[] };
// Mutation ops — each maps 1:1 to a desktop store method.
export type QueueOp =
  | { op: 'add'; args: { text: string; title?: string } }
  | { op: 'remove'; args: { id: string } }
  | { op: 'update'; args: { id: string; text?: string; title?: string; titleManual?: boolean; enabled?: boolean } }
  | { op: 'reorder'; args: { fromIndex: number; toIndex: number } }
  | { op: 'clear'; args?: {} }
  | { op: 'setAutoRun'; args: { value: boolean } }
  | { op: 'setStopAfter'; args: { value: boolean } }
  | { op: 'setCloseAfter'; args: { value: boolean } }
  | { op: 'setRunAfterTab'; args: { value: string | null } }
  | { op: 'setFirstDelaySeconds'; args: { value: number } }
  | { op: 'setPostPromptEnabled'; args: { value: boolean } }
  | { op: 'setPostPromptText'; args: { value: string } };

// ── AskUserQuestion (interactive question from Claude) ───────────────────────
// Claude can pause and ask the user a multiple-choice question (AskUserQuestion
// tool). Both PTY-terminal-Claude and SDK tabs surface it. Mobile renders its
// own picker and answers back; PTY answers drive the Ink TUI keystrokes, SDK
// answers resolve the parked canUseTool Promise (server routes by `source`).
export type QuestionOption = { label: string; description?: string; preview?: string };
export type MobileQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};
export type PendingQuestion = {
  source: 'pty' | 'sdk';
  toolUseID: string;
  questions: MobileQuestion[];
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
    api<{ project: { id: string; name: string; path: string }; tabs: TabInfo[]; statusMarker?: StatusMarkerCfg; processBar?: ProcessBarCfg }>(
      `/api/projects/${encodeURIComponent(projectId)}/tabs`,
    ),
  createSDKTab: (projectId: string) =>
    api<{ tabId: string; name: string; cwd: string; projectId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/sdk-tabs`,
      { method: 'POST', body: '{}' },
    ),
  createClaudeTab: (projectId: string) =>
    api<{ tabId: string; name: string; cwd: string; projectId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/claude-tabs`,
      { method: 'POST', body: '{}' },
    ),
  resumeClaudeTab: (tabId: string) =>
    api<{ tabId: string; sessionId: string; alreadyRunning?: boolean }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/resume`,
      { method: 'POST', body: '{}' },
    ),
  claudeStatus: (tabId: string) =>
    api<{ tabId: string; status: 'active' | 'busy' | 'inactive' | 'starting'; commandType: string | null; sessionId: string | null; cwd?: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/status`,
    ),
  send: (tabId: string, prompt: string) =>
    api<{ success: boolean; error?: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/send`,
      { method: 'POST', body: JSON.stringify({ prompt }) },
    ),
  // Drop everything ≥ targetUuid in the JSONL. Used by Repeat/Edit on a user
  // bubble — bridges to the same backend path desktop uses.
  truncate: (tabId: string, targetUuid: string) =>
    api<{ success: boolean; error?: string; removed?: number; kept?: number }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/truncate`,
      { method: 'POST', body: JSON.stringify({ targetUuid }) },
    ),
  // Kill the process (navbar Stop ■). PTY → SIGTERM claude child; SDK → close query.
  stop: (tabId: string) =>
    api<{ stopped: boolean }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/stop`,
      { method: 'POST', body: '{}' },
    ),
  // Soft-interrupt the CURRENT TURN (composer Stop). PTY → single Esc into TUI
  // (Claude stops generating, stays alive); SDK → close query (process warm).
  interrupt: (tabId: string) =>
    api<{ interrupted: boolean; kind?: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/interrupt`,
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
  // Prompt-queue ("Run after") for a tab — read the live desktop core + the list
  // of sibling AI-tabs (for the "on tab" pivot picker). Returns null-safe shape.
  getQueue: (tabId: string) =>
    api<QueueData>(`/api/sdk-tabs/${encodeURIComponent(tabId)}/queue`),
  // Apply one mutation op. Returns the new core (echo) so the caller can paint
  // immediately; the queue-update SSE event will also fan-out shortly after.
  queueMutate: (tabId: string, body: QueueOp) =>
    api<{ tabId: string; queue: QueueCore }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/queue`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // Current pending AskUserQuestion for a tab (mobile fetches on mount in case
  // it connected mid-question, before the live ask-question event fired).
  pendingQuestion: (tabId: string) =>
    api<{ pendingQuestion: PendingQuestion | null }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/pending-question`,
    ),
  // Answer (or stop) a pending question. answers keyed by question text; value
  // is a single label (single-select) or comma-joined labels (multiSelect).
  // stop:true → "Type something / respond manually" (PTY: Esc; SDK: deny+interrupt).
  answerQuestion: (
    tabId: string,
    body: { source: 'pty' | 'sdk'; toolUseID?: string; questions?: MobileQuestion[]; answers?: Record<string, string>; stop?: boolean },
  ) =>
    api<{ success: boolean; error?: string }>(
      `/api/sdk-tabs/${encodeURIComponent(tabId)}/answer-question`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // Soniox temporary API key for browser-side mic dictation. Backend mints a
  // 5-min ephemeral key bound to websocket-transcribe usage so we never ship
  // the long-lived SONIOX_API_KEY to the phone.
  sonioxToken: () =>
    api<{ api_key: string; expires_at: string }>('/api/soniox-token', { method: 'POST', body: '{}' }),
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
// NOTE: ws:// is blocked by some browsers' anti-tracker layer (Yandex Protect,
// Chrome extensions) when the host is a private IP — fetch works but the WS
// handshake never leaves the browser. Prefer eventsUrl() (SSE) which rides
// plain HTTP GET and is not subject to that block. wsUrl kept for any caller
// that still wants WS on a permissive browser.
export function wsUrl(tabId: string) {
  const token = getToken() || '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}&tabId=${encodeURIComponent(tabId)}`;
}

// SSE endpoint for the live channel — same-origin HTTP GET, token in query
// (EventSource cannot set headers). Replaces wsUrl for the live stream.
export function eventsUrl(tabId: string) {
  const token = getToken() || '';
  return `/api/events?token=${encodeURIComponent(token)}&tabId=${encodeURIComponent(tabId)}`;
}
