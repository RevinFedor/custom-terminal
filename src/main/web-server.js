// Mobile-web bridge: exposes Noted Terminal's SDK tabs over HTTP+WS so the
// user can drive Claude SDK sessions from a phone browser. Backend runs in
// Electron main; frontend (mobile-web/) is a separate Vite app served as static
// files from this server. Authentication: single bearer token in
// ~/.noted-terminal/web-token.txt, regenerated only if missing.
//
// What's exposed:
//   GET  /api/me                                 → { ok: true } if token valid
//   GET  /api/projects                            → all projects from DB
//   GET  /api/projects/:projectId/tabs            → tabs of one project (DB)
//   POST /api/projects/:projectId/sdk-tabs        → ask renderer to create SDK tab
//   POST /api/sdk-tabs/:tabId/send                → send prompt to SDK
//   POST /api/sdk-tabs/:tabId/stop                → stop SDK stream
//   GET  /api/sdk-tabs/:tabId/history             → load JSONL session history
//   WS   /ws?token=...&tabId=...                  → live SDK message stream
//
// WS protocol — server → client:
//   { type:'snapshot',  tabId, messages, sessionId, busy }     (on subscribe)
//   { type:'message',   tabId, message, sessionId }            (per SDK message)
//   { type:'busy',      tabId, busy }                          (busy toggled)
//   { type:'done',      tabId, sessionId }                     (turn ended)
//   { type:'queue-update', tabId, queue }                      (Run-after queue changed)
//   { type:'ask-question', tabId, source, toolUseID, questions }  (Claude asked a question)
//   { type:'question-cancelled', tabId, source }               (question answered/aborted)
//
// State source: tabs come from SQLite (works for ALL projects, even closed),
// because renderer's openProjects map only has currently-open ones. Live SDK
// session metadata (sessionId, busy) comes from main's sdkSessions Map. SDK
// tab creation needs the renderer (so the tab actually appears in the UI), so
// we use a request/reply IPC bridge.
//
// Important: the WS protocol forwards the same payloads main already sends to
// the local renderer via webContents.send('claude-sdk:message' / 'busy-state').
// We added one helper at the source — `webBroadcast(...)` — that fan-outs to
// every WS client subscribed to that tabId. No business logic on the WS layer.

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');
// Lazy-require the helpers (loaded fresh each call so missing module just
// disables the dependent endpoints, not the whole server).
let findSessionFile = null;
let parseTimelineUuids = null;
let parseTimelineEntries = null;
let loadCodexSessionRecords = null;
let buildCodexTimeline = null;
try {
  const cd = require(path.join(__dirname, 'ipc', 'claude-data'));
  findSessionFile = cd.findSessionFile;
  parseTimelineUuids = cd.parseTimelineUuids;
  parseTimelineEntries = cd.parseTimelineEntries;
} catch (e) {
  console.warn('[WebServer] claude-data helpers not loaded:', e.message);
}
try {
  const codex = require(path.join(__dirname, 'ipc', 'codex-data'));
  loadCodexSessionRecords = codex._api?.loadSessionRecords || null;
  buildCodexTimeline = codex._api?.buildCodexTimeline || codex.buildCodexTimeline || null;
} catch (e) {
  console.warn('[WebServer] codex-data helpers not loaded:', e.message);
}

let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  WebSocketServer = null;
}

// Preferred port. Can be overridden via env (NOTED_WEB_PORT). Default 7878
// keeps the installed app's URL stable for muscle memory. If 7878 is taken
// (typically by a sibling dev or prod instance), we walk forward to find the
// first free port in the range and publish the resolved port via the
// discovery file below — StatusBar reads it back so the QR/copy URL is always
// correct. Before this fallback, second instance silently EADDRINUSE-failed
// and mobile-web was reachable on neither end.
const PORT_PREFERRED = parseInt(process.env.NOTED_WEB_PORT || '', 10) || 7878;
const PORT_MAX = PORT_PREFERRED + 20; // 7878..7898 — plenty for parallel runs
let resolvedPort = PORT_PREFERRED;
const TOKEN_PATH = path.join(require('os').homedir(), '.noted-terminal', 'web-token.txt');
const DISCOVERY_DIR = path.join(require('os').homedir(), '.noted-terminal');
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, 'web-server-' + process.pid + '.json');

let httpServer = null;
let wss = null;
let token = null;
// Injected from main at start() — reads the live busy/running Maps (the same
// ones that drive the per-tab UI loader). Used by GET /api/active-loaders.
let computeActiveLoaders = null;
// Mobile question answering — injected by main.start(). answerClaudeQuestion
// routes SDK (resolve parked Promise) vs PTY (drive TUI keystrokes);
// getClaudePendingQuestion reads the live pending question for the SSE snapshot.
let answerClaudeQuestion = null;
let getClaudePendingQuestion = null;
// tabId → Set<Sink>. A Sink is the common interface for both transports:
//   { kind:'ws'|'sse', send(str):void, isAlive():bool, close():void }
// WebSocket and SSE both register here so webBroadcast() fans out to either
// without caring which transport the client used. Yandex/Chrome anti-tracker
// extensions silently block ws:// to private IPs (deterministically observed:
// fetch 200 but WS TIMEOUT rs=0, while curl gets 101) — SSE over plain GET is
// the reliable fallback. See fact-mobile-web.md::SSE transport.
const subscribers = new Map();
// pending bridge requests to renderer: requestId → { resolve, reject, timer }
const pendingBridge = new Map();

function shortId(value, len = 8) {
  const s = value == null ? '' : String(value);
  return s ? s.slice(-len) : 'nil';
}

function summarizeStreamMessage(message) {
  const recordType = message?.type || '-';
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  let textLen = 0;
  let thinkingLen = 0;
  let toolUses = 0;
  let toolResults = 0;
  let toolResultLen = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') textLen += String(block.text || '').length;
    else if (block.type === 'thinking') thinkingLen += String(block.thinking || '').length;
    else if (block.type === 'tool_use') toolUses += 1;
    else if (block.type === 'tool_result') {
      toolResults += 1;
      const c = block.content;
      toolResultLen += typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
    }
  }
  const resultLen = message?.result == null
    ? 0
    : typeof message.result === 'string'
      ? message.result.length
      : JSON.stringify(message.result).length;
  return ' record=' + recordType +
    ' uuid=' + shortId(message?.uuid) +
    ' msg=' + shortId(msg?.id) +
    ' session=' + shortId(message?.sessionId || message?.session_id) +
    ' blocks=' + blocks.length +
    ' textLen=' + textLen +
    ' thinkingLen=' + thinkingLen +
    ' tools=' + toolUses +
    ' toolResults=' + toolResults +
    ' toolResultLen=' + toolResultLen +
    ' resultLen=' + resultLen +
    ' synthetic=' + (message?.__webSynthetic === true) +
    ' queued=' + (message?.__wasQueued === true);
}

function summarizeBroadcastPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.type === 'message') return summarizeStreamMessage(payload.message);
  if (payload.type === 'snapshot') {
    return ' status=' + (payload.sessionStatus || '-') +
      ' busy=' + (payload.busy == null ? '-' : payload.busy) +
      ' session=' + shortId(payload.sessionId) +
      ' tool=' + (payload.toolType || payload.commandType || '-');
  }
  if (payload.type === 'busy') return ' busy=' + (payload.busy == null ? '-' : payload.busy) + ' reason=' + (payload.reason || '-');
  if (payload.type === 'done') return ' session=' + shortId(payload.sessionId) + ' reason=' + (payload.reason || '-');
  if (payload.type === 'bridge-update') return ' model=' + (payload.model || '-') + ' context=' + (payload.contextPct == null ? '-' : payload.contextPct);
  if (payload.type === 'queue-update') return ' queue=yes';
  if (payload.type === 'ask-question') return ' source=' + (payload.source || '-') + ' questions=' + (Array.isArray(payload.questions) ? payload.questions.length : 0);
  if (payload.type === 'question-cancelled') return ' source=' + (payload.source || '-');
  return '';
}

function loadOrCreateToken() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  } catch {}
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, fresh + '\n', { mode: 0o600 });
  return fresh;
}

function getLanIp() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function checkAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === token;
  }
  // Fallback: ?token=... in query (used by WS upgrade since browsers can't
  // set headers on WS handshakes from JS).
  const parsed = url.parse(req.url, true);
  return parsed.query.token === token;
}

// Compress responses bigger than ~4KB if the client accepts gzip. Phone JSON
// payloads (history with thousands of messages) shrink ~10x — 20MB → 2MB —
// which is the difference between a 15s WiFi transfer and a 1.5s one.
const GZIP_THRESHOLD = 4 * 1024;
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Accept-Encoding',
  };
  const accept = (res.req && res.req.headers['accept-encoding']) || '';
  const useGzip = json.length >= GZIP_THRESHOLD && /\bgzip\b/.test(accept);
  if (useGzip) {
    const t0 = Date.now();
    const buf = zlib.gzipSync(json, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(buf.length);
    res.writeHead(status, headers);
    res.end(buf);
    if (json.length > 64 * 1024) {
      console.log(`[WebGzip] ${json.length}B → ${buf.length}B (${Math.round((1 - buf.length / json.length) * 100)}%) in ${Date.now() - t0}ms`);
    }
  } else {
    headers['Content-Length'] = String(Buffer.byteLength(json));
    res.writeHead(status, headers);
    res.end(json);
  }
}

function mobileTimelineColor(kind) {
  switch (kind) {
    case 'compact': return 'f59e0b';
    case 'continued': return 'fb923c';
    case 'docs_edit': return '22c55e';
    case 'docs_search': return '38bdf8';
    case 'user': return 'a78bfa';
    default: return '888888';
  }
}

function mobileTimelinePreview(value, max = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function mobileTimelineTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function normalizeMobileTimelineEntries(entries, fullEntries = []) {
  const fullByUuid = new Map();
  for (const entry of Array.isArray(fullEntries) ? fullEntries : []) {
    if (entry && typeof entry.uuid === 'string') fullByUuid.set(entry.uuid, entry);
  }

  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && typeof entry.uuid === 'string')
    .map((entry) => {
      const fullEntry = fullByUuid.get(entry.uuid) || {};
      if (entry.kind && (entry.preview || entry.full)) {
        const kind = String(entry.kind || 'entry');
        const full = entry.full || fullEntry.full || entry.preview || '';
        const preview = mobileTimelinePreview(entry.preview || full || kind);
        return {
          uuid: entry.uuid,
          kind,
          color: entry.color || mobileTimelineColor(kind),
          preview: preview || kind,
          full: full || undefined,
          ts: mobileTimelineTs(entry.ts || entry.timestamp || fullEntry.ts || fullEntry.timestamp),
          preTokens: entry.preTokens || fullEntry.preTokens || undefined,
          truncated: entry.truncated || undefined,
          tools: entry.tools || undefined,
        };
      }
      const kind = String(entry.type || entry.role || 'entry');
      const compactSummary = entry.compactSummary || fullEntry.compactSummary || '';
      const content = entry.content || fullEntry.content || '';
      const full = kind === 'compact'
        ? (compactSummary || content || 'Conversation compacted')
        : (content || compactSummary || '');
      const preview = kind === 'compact'
        ? mobileTimelinePreview(full || 'Conversation compacted')
        : mobileTimelinePreview(content || compactSummary || kind);
      const tsMs = Date.parse(entry.timestamp || fullEntry.timestamp || '');

      return {
        uuid: entry.uuid,
        kind,
        color: mobileTimelineColor(kind),
        preview: preview || kind,
        full: full || undefined,
        ts: Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : undefined,
        preTokens: entry.preTokens || fullEntry.preTokens || undefined,
      };
    });
}

async function sendInitialSnapshot(tabId, sink, sdkSessions) {
  const session = sdkSessions.get(tabId);
  const pendingQuestion = getClaudePendingQuestion ? getClaudePendingQuestion(tabId) : null;
  if (session) {
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: session.sessionId || null,
      busy: true,
      sessionStatus: 'busy',
      commandType: 'claude-sdk',
      toolType: 'claude',
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
    return;
  }
  try {
    const status = await bridgeRequest('getClaudeTabStatus', { tabId }, 1500);
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: status?.sessionId || null,
      busy: status?.status === 'busy',
      sessionStatus: status?.status || 'inactive',
      commandType: status?.commandType || null,
      toolType: status?.toolType || null,
      inputReady: status?.status === 'active' || status?.status === 'busy',
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
  } catch {
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: null,
      busy: false,
      sessionStatus: 'inactive',
      commandType: null,
      toolType: null,
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Ask renderer to do something (create tab, list open tabs, etc) and wait for
// a single reply. The renderer registers `web:bridge-reply` as the response
// channel; here we just allocate a requestId and time out at 5s. Used for
// state that only the live UI knows (current openProjects map, tab creation).
function bridgeRequest(action, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    if (!win || win.isDestroyed()) {
      console.log('[BridgeDiag] NO_WINDOW action=' + action + ' wins=' + wins.length);
      return reject(new Error('No window'));
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingBridge.delete(requestId);
      console.log('[BridgeDiag] TIMEOUT action=' + action + ' rid=' + requestId + ' afterMs=' + timeoutMs);
      reject(new Error('Bridge timeout: ' + action));
    }, timeoutMs);
    pendingBridge.set(requestId, { resolve, reject, timer, action, sentAt: Date.now() });
    console.log('[BridgeDiag] SEND action=' + action + ' rid=' + requestId + ' wins=' + wins.length);
    win.webContents.send('web:bridge-request', { requestId, action, payload });
  });
}

async function resolveAgentSessionInfo(tabId, timeoutMs = 1500) {
  let info = null;
  try {
    info = await bridgeRequest('getTabSessionInfo', { tabId }, timeoutMs);
  } catch {}
  if (info?.sessionId && info?.toolType) return info;

  try {
    const projectManager = require('./project-manager');
    for (const p of projectManager.db.getAllProjects()) {
      const t = (p.tabs || []).find(x => x.tabId === tabId);
      if (!t) continue;
      const isCodex = t.commandType === 'codex' && (t.tabType || 'terminal') !== 'claude-sdk';
      const isClaude = t.commandType === 'claude' && (t.tabType || 'terminal') !== 'claude-sdk';
      const toolType = isCodex ? 'codex' : isClaude ? 'claude' : null;
      const sessionId = isCodex ? (t.codexSessionId || null) : isClaude ? (t.claudeSessionId || null) : null;
      return {
        tabId,
        toolType,
        commandType: t.commandType || null,
        sessionId,
        claudeSessionId: t.claudeSessionId || null,
        codexSessionId: t.codexSessionId || null,
        geminiSessionId: t.geminiSessionId || null,
        cwd: t.cwd || null,
      };
    }
  } catch {}

  return info || {
    tabId,
    toolType: null,
    commandType: null,
    sessionId: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null,
    cwd: null,
  };
}

function registerBridgeReplyHandler() {
  ipcMain.on('web:bridge-reply', (_event, { requestId, ok, data, error }) => {
    const pending = pendingBridge.get(requestId);
    if (!pending) {
      console.log('[BridgeDiag] REPLY_DROPPED rid=' + requestId + ' ok=' + ok + ' err=' + (error || '-') + ' (no pending — probably already timed out)');
      return;
    }
    const elapsed = Date.now() - pending.sentAt;
    console.log('[BridgeDiag] REPLY action=' + pending.action + ' rid=' + requestId + ' ok=' + ok + ' elapsedMs=' + elapsed + ' err=' + (error || '-'));
    clearTimeout(pending.timer);
    pendingBridge.delete(requestId);
    if (ok) pending.resolve(data);
    else pending.reject(new Error(error || 'Bridge failed'));
  });
}

// Project/tab IDs могут содержать `=` (base64 от пути), пробелы, кириллицу —
// всё это URL-кодируется на клиенте как %3D, %20, %D0%9F и т.п.
// Без decodeURIComponent любой projectId оканчивающийся на `=` (например
// uav → `...dWF2%3D`) превращается в строку которой нет в БД → 404.
function decId(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ───────── REST handlers ─────────

async function handleApi(req, res, parsed, sdkSessions) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, {});
    return;
  }

  // Public ping endpoint — checks if token works. No body required.
  if (parsed.pathname === '/api/me' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { ok: true, lanIp: getLanIp() });
  }

  // Active-loaders snapshot — every tab across every project that is still
  // "working" (AI turn/loader, SDK streaming, Gemini busy, or a non-AI running
  // shell process). AI CLI liveness by itself is not a loader: idle Claude/Codex
  // tabs are allowed to be closed by build:install. Computed in main against
  // the live Maps that already drive the UI loader — no separate busy notion.
  // See computeActiveLoaders() in main.js.
  if (parsed.pathname === '/api/active-loaders' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!computeActiveLoaders) {
      // Fail SAFE: if the injection is missing we must NOT report idle — that
      // would green-light a rebuild mid-work. Signal the poller to keep waiting.
      return sendJson(res, 503, { error: 'active-loaders unavailable', idle: false });
    }
    try {
      return sendJson(res, 200, computeActiveLoaders());
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message), idle: false });
    }
  }

  // ───────── SSE live channel (WebSocket replacement) ─────────
  // EventSource over plain HTTP GET. Yandex/Chrome anti-tracker extensions
  // block ws:// to private IPs but NOT text/event-stream. Same subscriber
  // registry + webBroadcast() as WS, so main.js fan-out is transport-agnostic.
  // Auth via ?token= (EventSource can't set headers, same as WS handshake).
  if (parsed.pathname === '/api/events' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const tabId = parsed.query.tabId ? decId(String(parsed.query.tabId)) : null;
    if (!tabId) return sendJson(res, 400, { error: 'tabId required' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Disable proxy buffering (nginx etc.) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    // Initial comment + retry hint. EventSource auto-reconnects on drop using
    // this interval; we still keep it modest since the network is LAN.
    res.write('retry: 2000\n\n');

    const sink = {
      kind: 'sse',
      sent: 0,
      errors: 0,
      send: (str) => {
        try {
          res.write('data: ' + str + '\n\n');
          sink.sent += 1;
        } catch (e) {
          sink.errors += 1;
          console.warn('[WebSSE:WriteError] tab=' + shortId(tabId, 12) + ' sent=' + sink.sent + ' err=' + (e?.message || e));
        }
      },
      isAlive: () => !res.writableEnded && !res.destroyed,
      close: () => { try { res.end(); } catch {} },
    };
    subscribe(tabId, sink);
    console.log('[WebSSE:Open] tab=' + shortId(tabId, 12) + ' from=' + (req.socket.remoteAddress || '?'));

    // Initial snapshot — mirror the WS upgrade path so the client renders
    // immediately without waiting for the next broadcast.
    sendInitialSnapshot(tabId, sink, sdkSessions).catch(() => {});
    startClaudeTabWatcher(tabId).catch(() => {});

    // Heartbeat: SSE connections die silently behind some proxies/radios.
    // A comment line every 25s keeps the socket warm and lets the client's
    // onerror fire promptly if the pipe is actually dead.
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 25000);

    const cleanup = () => {
      clearInterval(hb);
      unsubscribeAll(sink);
      releaseClaudeWatchersIfOrphan();
      console.log('[WebSSE:Close] tab=' + shortId(tabId, 12) + ' sent=' + sink.sent + ' errors=' + sink.errors);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return; // keep the response open
  }

  if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });

  const projectManager = require('./project-manager');

  // Projects list (from SQLite — includes closed projects too)
  if (parsed.pathname === '/api/projects' && req.method === 'GET') {
    // Ask renderer which projects are currently open in the desktop UI so the
    // mobile client can split into Active / All. If the bridge fails (renderer
    // not ready, no window), fall back to "nothing is active" — phone still
    // gets the project list, just without the badge.
    let openProjectIds = [];
    let openIds = new Set();
    let activeProjectId = null;
    let awaitingIds = new Set();
    try {
      const data = await bridgeRequest('getOpenProjectIds', {}, 1500);
      if (Array.isArray(data?.ids)) {
        openProjectIds = data.ids;
        openIds = new Set(data.ids);
      }
      activeProjectId = data?.activeProjectId || null;
      if (Array.isArray(data?.awaitingIds)) awaitingIds = new Set(data.awaitingIds);
    } catch {}

    const openOrder = new Map(openProjectIds.map((id, index) => [id, index]));
    const all = projectManager.db.getAllProjects().map(p => {
      const tabs = p.tabs || [];
      const sdkTabs = tabs.filter(t => t.tabType === 'claude-sdk');
      // Count how many SDK tabs are streaming RIGHT NOW (one entry in
      // sdkSessions per active query). Lets the phone show a "live" pulse.
      const liveSdkCount = sdkTabs.filter(t => t.tabId && sdkSessions.has(t.tabId)).length;
      return {
        id: p.id,
        name: p.name,
        path: p.path,
        icon: p.icon || null,
        tabCount: tabs.length,
        sdkTabCount: sdkTabs.length,
        liveSdkCount,
        updatedAt: p.updatedAt,
        isOpen: openIds.has(p.id),
        isActive: p.id === activeProjectId,
        hasAwaiting: awaitingIds.has(p.id),
      };
    });
    all.sort((a, b) => {
      const aOpen = openOrder.has(a.id);
      const bOpen = openOrder.has(b.id);
      if (aOpen && bOpen) return openOrder.get(a.id) - openOrder.get(b.id);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return sendJson(res, 200, { projects: all });
  }

  // Soniox temporary API key — mints a short-lived (5 min) key bound to
  // websocket-transcribe usage. Mobile client never sees SONIOX_API_KEY itself.
  // The mint call goes to api.soniox.com with our long-lived key in the
  // Authorization header; returned `api_key` is what the browser uses to open
  // wss://stt-rt.soniox.com/transcribe-websocket. If SONIOX_API_KEY is missing
  // from env we return 503 so the client can disable the mic button.
  if (parsed.pathname === '/api/soniox-token' && req.method === 'POST') {
    try {
      const key = process.env.SONIOX_API_KEY;
      if (!key) return sendJson(res, 503, { error: 'SONIOX_API_KEY not configured' });
      const r = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300 }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return sendJson(res, 502, { error: `soniox ${r.status}: ${txt.slice(0, 200)}` });
      }
      const data = await r.json();
      return sendJson(res, 200, { api_key: data.api_key, expires_at: data.expires_at });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Client-side log sink — mobile sends diagnostic lines here, they land in
  // logs/dev.log via the [WebClient] tag so the user's standard log workflow
  // picks them up. POST body: { tag: 'TimelineGoTo', msg: '...', data: any }.
  if (parsed.pathname === '/api/log/client' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tag = body.tag || 'WebClient';
      const msg = body.msg || '';
      const data = body.data !== undefined ? ' ' + JSON.stringify(body.data) : '';
      console.log(`[${tag}] ${msg}${data}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Prompts library (groups + items). Read-only — used by mobile composer
  // Insert-Prompt button. Schema:
  //   group: { id, name, position }
  //   prompt: { id, title, content, group_id?, position, file_paths[] }
  if (parsed.pathname === '/api/prompts' && req.method === 'GET') {
    try {
      const groups = projectManager.getPromptGroups();
      const prompts = projectManager.getPrompts();
      // Cheap content fingerprint — client passes ?etag=<previous> to skip the
      // body when nothing changed. SHA-1 of the canonical JSON, hex-truncated
      // to 16 chars (~10^19 keys, plenty for a never-evicted cache).
      const json = JSON.stringify({ groups, prompts });
      const etag = crypto.createHash('sha1').update(json).digest('hex').slice(0, 16);
      const clientEtag = parsed.query.etag;
      if (clientEtag && clientEtag === etag) {
        // 304-equivalent: return tiny payload, mobile reuses its localStorage copy.
        return sendJson(res, 200, { etag, unchanged: true });
      }
      return sendJson(res, 200, { groups, prompts, etag });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Tabs of a project
  let m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/);
  if (m && req.method === 'GET') {
    const projectId = decId(m[1]);
    let project = projectManager.db.getProjectById(projectId);
    // Live fallback — проект может быть открыт в Zustand но без записи в БД
    // (новый незаsavedaftered draft). Спрашиваем renderer что у него есть.
    if (!project) {
      try {
        const live = await bridgeRequest('getProjectTabsLive', { projectId }, 1500);
        if (live?.project) {
          console.log('[WebServer] project ' + projectId.slice(0, 16) + ' served from live Zustand (not in DB)');
          return sendJson(res, 200, live);
        }
      } catch (e) {
        // bridge failed, fall through to 404
      }
      console.log('[WebServer] 404 project not found: ' + projectId + ' (not in DB, not in live Zustand)');
      return sendJson(res, 404, { error: 'project not found', projectId });
    }
    // For PTY agent tabs (Claude/Codex, excluding SDK)
    // ask renderer for sessionStatus in a single batch — cheap because
    // renderer holds the live runtime adapters. SDK tabs have no
    // sessionStatus concept here; we keep null for them.
    let statusMap = new Map();
    let awaitingMap = new Map();
    const ptyAgentIds = (project.tabs || [])
      .filter(t => (t.commandType === 'claude' || t.commandType === 'codex') && (t.tabType || 'terminal') !== 'claude-sdk')
      .map(t => t.tabId);
    if (ptyAgentIds.length > 0) {
      try {
        const data = await bridgeRequest('getClaudeTabStatusBatch', { tabIds: ptyAgentIds }, 1500);
        if (data?.statuses) for (const [id, st] of Object.entries(data.statuses)) statusMap.set(id, st);
        if (data?.awaiting) for (const [id, aw] of Object.entries(data.awaiting)) if (aw) awaitingMap.set(id, true);
      } catch (e) {
        // Bridge unavailable — every PTY agent tab will show no badge until
        // user opens it (per-tab GET /status still works on demand).
      }
    }
    // Configurable status-marker palette (assigned-category color + shape/size)
    // AND process-bar config (loader strip position/base/shimmer) live in renderer
    // useUIStore — fetch once so the phone mirrors both the desktop left-marker
    // and the loader strip exactly. Falls back to dot/8px + left process-bar
    // when the bridge is unavailable.
    let markerCfg = { shape: 'dot', sizePx: 8 };
    let processBarCfg = { colorA: '#155E75', shimmerColor: '#FFFFFF', shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: 'left' };
    let paletteById = new Map();
    try {
      const cfg = await bridgeRequest('getStatusMarkerConfig', {}, 1500);
      if (cfg?.shape) markerCfg = { shape: cfg.shape, sizePx: cfg.sizePx || 8 };
      if (Array.isArray(cfg?.statuses)) for (const s of cfg.statuses) paletteById.set(s.id, s.color);
      if (cfg?.processBar) processBarCfg = cfg.processBar;
    } catch (e) {
      // renderer not ready — phone renders runtime-only markers, no category tint
    }
    const tabs = (project.tabs || []).map(t => {
      // Cheap timeline-count: only computed if the tab has a session file we
      // can find. parseTimelineUuids reads the JSONL once and returns the
      // active-branch user-prompt UUIDs — its length = "messages on Timeline".
      let timelineCount = null;
      if (t.claudeSessionId && parseTimelineUuids && findSessionFile) {
        try {
          const found = findSessionFile(t.claudeSessionId, t.cwd);
          if (found) timelineCount = parseTimelineUuids(found.filePath).length;
        } catch {}
      }
      // Assigned-category status (DB column session_status holds the palette id;
      // distinct from runtime sessionStatus which drives the loader/background).
      const statusId = t.sessionStatus || null;
      return {
        tabId: t.tabId,
        name: t.name,
        tabType: t.tabType || 'terminal',
        commandType: t.commandType,
        color: t.color || null,   // desktop TabColor — drives row bg (mobile mirrors desktop)
        cwd: t.cwd,
        claudeSessionId: t.claudeSessionId,
        codexSessionId: t.codexSessionId,
        geminiSessionId: t.geminiSessionId,
        timelineCount,
        sessionStatus: statusMap.get(t.tabId) || null,
        awaiting: awaitingMap.get(t.tabId) || false,
        statusId,
        statusColor: statusId ? (paletteById.get(statusId) || null) : null,
        // Live state if SDK session is active in main right now
        live: t.tabId && sdkSessions.has(t.tabId) ? {
          sessionId: sdkSessions.get(t.tabId).sessionId,
          cwd: sdkSessions.get(t.tabId).cwd,
        } : null,
      };
    });
    return sendJson(res, 200, { project: { id: project.id, name: project.name, path: project.path, icon: project.icon || null }, tabs, statusMarker: markerCfg, processBar: processBarCfg });
  }

  // Create SDK tab in a project (delegates to renderer store)
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/sdk-tabs$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('createSDKTab', { projectId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Send prompt to SDK tab — invokes the same handler the desktop UI uses.
  // For PTY+Claude tabs (commandType==='claude') routes through safePasteAndSubmit
  // instead. Mobile uses the same URL for both; routing is by tab type.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/send$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const { prompt, model, effort, thinking, cwd } = body;
      if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
      // Single bridge round-trip — renderer dispatches by tab.tabType/commandType.
      // Earlier this endpoint did TWO round-trips (status check + send), adding
      // ~50ms per phone send on top of the actual PTY paste latency.
      const data = await bridgeRequest('sendMessageAuto', {
        tabId, prompt, model, effort, thinking, cwd,
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Create PTY+Claude tab in a project (mobile button "+ New Claude terminal").
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/claude-tabs$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('createClaudeTab', { projectId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Create PTY agent tab in a project. Body: { toolType: 'claude' | 'codex' }.
  // Used by the native iOS "New Terminal" picker; keeps Claude/Codex creation
  // on the same renderer-owned pendingAction path as desktop.
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/agent-tabs$/);
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const toolType = body.toolType === 'codex' ? 'codex' : 'claude';
      const data = await bridgeRequest('createAgentTab', { projectId: decId(m[1]), toolType });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Resume inactive Claude session (PTY tab whose `claude` process exited).
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/resume$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('resumeClaudeTab', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Status snapshot for a PTY+Claude tab: active | busy | inactive.
  // Mobile polls this on chat-open to decide Resume-banner visibility.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/status$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('getClaudeTabStatus', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Truncate history (drop everything ≥ targetUuid). Used by mobile Edit/Repeat
  // — bridges to the renderer which then invokes the same `claude-sdk:truncate-history`
  // ipcMain handler the desktop UI uses. After 200 OK the caller sends the new
  // prompt via /send (with original or edited text) and Claude resumes off the
  // truncated tip.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/truncate$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const targetUuid = (body.targetUuid || '').trim();
      if (!targetUuid) return sendJson(res, 400, { error: 'targetUuid required' });
      const data = await bridgeRequest('truncateHistory', { tabId, targetUuid });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Rename tab (delegates to renderer store via bridge — only works for tabs
  // currently OPEN in the desktop). Returns 409 if the tab isn't open.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const data = await bridgeRequest('renameTab', { tabId, name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Close tab (delegates to renderer store — same constraint as rename:
  // closed-only-when-open).
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/close$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('closeTab', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Fork a Claude session (PTY tab → new SDK tab). Source tab must be open
  // in the desktop and have a captured claudeSessionId. Returns the new tabId
  // so the mobile client can navigate straight into the chat.
  m = parsed.pathname.match(/^\/api\/tabs\/([^/]+)\/fork-to-sdk$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('forkToSDK', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Stop SDK stream OR shut down PTY+Claude session (Ctrl+C Ctrl+C Ctrl+D).
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/stop$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const session = sdkSessions.get(tabId);
    if (session) {
      try { session.query.close(); } catch {}
      sdkSessions.delete(tabId);
      return sendJson(res, 200, { stopped: true });
    }
    // Not an SDK tab — maybe it's PTY+Claude. Try stop via bridge.
    try {
      const data = await bridgeRequest('stopClaudeTab', { tabId }, 2000);
      return sendJson(res, 200, { stopped: true, ...data });
    } catch (e) {
      return sendJson(res, 200, { stopped: false, reason: 'no active session' });
    }
  }

  // SOFT interrupt the CURRENT TURN (composer Stop button). SDK → query.close()
  // (process stays warm). PTY+Claude → single Esc into the TUI via bridge —
  // Claude stops generating, stays alive at the prompt. Distinct from /stop,
  // which SIGTERMs the PTY-Claude process. See fact-mobile-claude-pty.md.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/interrupt$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const session = sdkSessions.get(tabId);
    if (session) {
      // SDK soft-interrupt = close the query stream; the process is kept warm by
      // the desktop runner and the next message revives the turn loop.
      try { session.query.close(); } catch {}
      sdkSessions.delete(tabId);
      return sendJson(res, 200, { interrupted: true, kind: 'sdk' });
    }
    try {
      const data = await bridgeRequest('interruptClaudeTurn', { tabId }, 2000);
      return sendJson(res, 200, { interrupted: true, kind: 'pty', ...data });
    } catch (e) {
      return sendJson(res, 200, { interrupted: false, reason: 'no active session' });
    }
  }

  // Read the current terminal composer draft after a deterministic interrupt.
  // Mobile uses the same bridge action as desktop History instead of keeping a
  // local "last sent prompt" fallback.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/draft$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('grabAgentDraft', { tabId }, 5000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Answer (or stop) an AskUserQuestion from mobile. Body:
  //   { source:'pty'|'sdk', toolUseID, answers:{[questionText]:label|labels}, stop? }
  // Routes to main's answerClaudeQuestion (PTY → drive TUI keystrokes, SDK →
  // resolve the parked canUseTool Promise). No bridge — these run in main directly.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/answer-question$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    if (!answerClaudeQuestion) return sendJson(res, 500, { error: 'answer handler not wired' });
    try {
      const body = await readBody(req);
      const result = await answerClaudeQuestion({
        tabId,
        source: body.source || 'pty',
        toolUseID: body.toolUseID,
        questions: body.questions,
        answers: body.answers || {},
        stop: !!body.stop,
      });
      return sendJson(res, 200, result || { success: false });
    } catch (e) {
      return sendJson(res, 200, { success: false, error: String(e.message) });
    }
  }
  // Current pending question for a tab (mobile fetches on mount in case it
  // connected mid-question and the ask-question broadcast already fired).
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/pending-question$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const q = getClaudePendingQuestion ? getClaudePendingQuestion(tabId) : null;
    return sendJson(res, 200, { pendingQuestion: q });
  }

  // SDK params (model/effort/thinking) for a tab — read & update.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/params$/);
  if (m && req.method === 'GET') {
    try {
      const data = await bridgeRequest('getSDKParams', { tabId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setSDKParams', { tabId: decId(m[1]) , ...body });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }

  // Prompt-queue ("Run after") for a tab — read live core + sibling AI-tabs, or
  // apply one mutation op. Mobile mirrors the desktop store; the desktop runner
  // does the firing. GET returns { queue, aiTabs }; POST body { op, args } maps
  // 1:1 to a store method (see App.tsx::mutatePromptQueue). Live deltas arrive
  // separately via the `queue-update` SSE event.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/queue$/);
  if (m && req.method === 'GET') {
    try {
      const data = await bridgeRequest('getPromptQueue', { tabId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('mutatePromptQueue', { tabId: decId(m[1]), op: body.op, args: body.args });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }

  // Timeline entries for a tab (any tab — SDK or terminal — as long as it has
  // a Claude session). Goes through bridgeRequest → renderer reads tab.cwd +
  // claudeSessionId from the live store, then we call the IPC directly here.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/timeline$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const t0 = Date.now();
    console.log(`[WebTiming] /timeline START tabId=${tabId.slice(0, 24)}`);
    try {
      const tBridge = Date.now();
      const info = await resolveAgentSessionInfo(tabId, 1500);
      const sessionId = info?.sessionId || null;
      const cwd = info?.cwd || null;
      const toolType = info?.toolType || null;
      if (!sessionId || !toolType) {
        console.log(`[WebTiming] /timeline NO_SESSION bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
        return sendJson(res, 200, { entries: [] });
      }
      if (toolType === 'codex') {
        if (!loadCodexSessionRecords || !buildCodexTimeline) return sendJson(res, 500, { error: 'codex timeline parser not loaded' });
        const loaded = await loadCodexSessionRecords(sessionId, cwd);
        if (!loaded?.success) {
          console.log(`[WebTiming] /timeline CODEX_NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
          return sendJson(res, 200, { entries: [], sessionId, toolType });
        }
        const entries = buildCodexTimeline(loaded.records || [], sessionId);
        let fullEntries = [];
        if (entries.some(e => e?.type === 'compact' || e?.role === 'compact')) {
          try {
            const full = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
            fullEntries = Array.isArray(full?.entries) ? full.entries : [];
          } catch (summaryErr) {
            console.log(`[WebTiming] /timeline CODEX_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
          }
        }
        const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
        const tParse = Date.now();
        console.log(`[WebTiming] /timeline DONE tool=codex entries=${mobileEntries.length} bridge=${tBridge-t0}ms parse=${tParse-tBridge}ms total=${tParse-t0}ms`);
        return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
      }
      if (!parseTimelineEntries || !findSessionFile) return sendJson(res, 500, { error: 'timeline parser not loaded' });
      const found = findSessionFile(sessionId, cwd);
      if (!found) {
        console.log(`[WebTiming] /timeline NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
        return sendJson(res, 200, { entries: [], sessionId, toolType });
      }
      const tFind = Date.now();
      const entries = parseTimelineEntries(found.filePath);
      let fullEntries = [];
      if (entries.some(e => e?.type === 'compact' || e?.role === 'compact')) {
        try {
          const full = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
          fullEntries = Array.isArray(full?.entries) ? full.entries : [];
        } catch (summaryErr) {
          console.log(`[WebTiming] /timeline CLAUDE_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
        }
      }
      const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
      const tParse = Date.now();
      console.log(`[WebTiming] /timeline DONE tool=claude entries=${mobileEntries.length} bridge=${tBridge-t0}ms find=${tFind-tBridge}ms parse=${tParse-tFind}ms total=${tParse-t0}ms`);
      return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
    } catch (e) {
      console.log(`[WebTiming] /timeline ERROR ${String(e.message)} total=${Date.now()-t0}ms`);
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Load JSONL session history.
  // - Default: JSON `{ messages, total, truncated, dropped, etag }` (legacy clients)
  // - With `Accept: application/x-ndjson` OR `?ndjson=1`: STREAMING NDJSON.
  //     Line 1: `{"type":"meta", total, sessionId, etag, returned, lastUuid}`
  //     Lines 2..N+1: one message JSON per line
  //     Compressed via Brotli (quality 4) when client accepts `br`, piped
  //     directly to the response — first message bytes reach the phone in
  //     ~50ms instead of the ~4s buffered-and-compress wait.
  // - `?after=<uuid>` returns ONLY messages strictly after that uuid (delta sync).
  // - `?before=<uuid>` returns ONLY messages strictly before that uuid (prefix
  //    backfill). Combined with phase 1 `?last=200` → phase 2 `?before=<firstTailUuid>`,
  //    the cold-open paint flow is: tail in 1s, prefix streams in behind it.
  // - `?last=N` returns the last N messages.
  m = parsed.pathname.match(/^\/api\/sdk-tabs\/([^/]+)\/history$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const t0 = Date.now();
    const lastRaw = parsed.query.last;
    const lastN = lastRaw != null ? Math.max(1, Math.min(20000, parseInt(String(lastRaw), 10) || 0)) : null;
    const afterUuid = typeof parsed.query.after === 'string' ? parsed.query.after : null;
    const beforeUuid = typeof parsed.query.before === 'string' ? parsed.query.before : null;
    const wantHistoryEntries = parsed.query.view === 'history' || parsed.query.entries === '1';
    const wantNdjson = /\bapplication\/x-ndjson\b/.test(req.headers['accept'] || '') || parsed.query.ndjson === '1';
    console.log(`[WebTiming] /history START tabId=${tabId.slice(0, 24)} last=${lastN || 'all'} after=${afterUuid ? afterUuid.slice(0, 8) : 'none'} before=${beforeUuid ? beforeUuid.slice(0, 8) : 'none'} view=${wantHistoryEntries ? 'history' : 'messages'} ndjson=${wantNdjson}`);
    try {
      if (wantHistoryEntries) {
        const data = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
        let entries = Array.isArray(data?.entries) ? data.entries : [];
        const total = entries.length;
        let dropped = 0;
        if (afterUuid) {
          const idx = entries.findIndex((e) => e && e.uuid === afterUuid);
          entries = idx >= 0 ? entries.slice(idx + 1) : [];
        }
        if (beforeUuid) {
          const idx = entries.findIndex((e) => e && e.uuid === beforeUuid);
          entries = idx >= 0 ? entries.slice(0, idx) : [];
        }
        if (lastN && entries.length > lastN) {
          dropped = entries.length - lastN;
          entries = entries.slice(entries.length - lastN);
        }
        const truncated = dropped > 0;
        const firstUuid = entries.length ? (entries[0]?.uuid || null) : null;
        const lastUuid = entries.length ? (entries[entries.length - 1]?.uuid || null) : null;
        const etagSrc = entries.map((e) => e?.uuid || '').join('|');
        const etag = crypto.createHash('sha1').update(etagSrc).digest('hex').slice(0, 16);
        console.log(`[WebTiming] /history DONE view=history tool=${data?.toolType || '-'} total=${total} returned=${entries.length} dropped=${dropped} ms=${Date.now()-t0}`);
        return sendJson(res, 200, { ...data, entries, total, truncated, dropped, etag, firstUuid, lastUuid });
      }

      const data = await bridgeRequest('loadSDKHistory', { tabId });
      const allMsgs = data?.messages || [];
      const total = allMsgs.length;

      // Apply filters in order: after-cursor → before-cursor → last-tail.
      let messages = allMsgs;
      let dropped = 0;
      if (afterUuid) {
        const idx = messages.findIndex((m) => m && m.uuid === afterUuid);
        if (idx >= 0) messages = messages.slice(idx + 1);
        else messages = []; // unknown uuid → empty delta
      }
      if (beforeUuid) {
        const idx = messages.findIndex((m) => m && m.uuid === beforeUuid);
        // Found → return the prefix (everything strictly before it).
        // Not found → safer to return empty than to dump everything; client
        // would think this IS the prefix and skip phase 2 entirely.
        if (idx >= 0) messages = messages.slice(0, idx);
        else messages = [];
      }
      if (lastN && messages.length > lastN) {
        dropped = messages.length - lastN;
        messages = messages.slice(messages.length - lastN);
      }
      const truncated = dropped > 0;
      const lastUuid = messages.length ? (messages[messages.length - 1]?.uuid || null) : null;
      // Cheap content fingerprint over uuids — client uses this as a cache key.
      // Hashing uuids only (not bodies) is enough: any backend mutation creates
      // a new uuid via Anthropic SDK, so uuid-set uniquely identifies content.
      const etagSrc = messages.map((m) => m?.uuid || '').join('|');
      const etag = crypto.createHash('sha1').update(etagSrc).digest('hex').slice(0, 16);

      const firstUuid = messages.length ? (messages[0]?.uuid || null) : null;

      if (!wantNdjson) {
        console.log(`[WebTiming] /history DONE total=${total} returned=${messages.length} dropped=${dropped} ms=${Date.now()-t0} mode=json`);
        return sendJson(res, 200, { ...data, messages, total, truncated, dropped, etag, lastUuid, firstUuid });
      }

      // ─── NDJSON streaming path ────────────────────────────────────────
      // Pipe: write() lines → Brotli transform (if accepted) → response.
      const accept = req.headers['accept-encoding'] || '';
      const useBrotli = /\bbr\b/.test(accept);
      const useGzip = !useBrotli && /\bgzip\b/.test(accept);

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Vary': 'Accept-Encoding, Accept',
        ...(useBrotli ? { 'Content-Encoding': 'br' } : useGzip ? { 'Content-Encoding': 'gzip' } : {}),
        // Tell intermediaries (and clients) we want chunked-transfer, not
        // wait-for-full-length. Critical for streaming perception.
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });

      let sink = res;
      if (useBrotli) {
        // Quality 4 = balanced ratio/speed for live encoding (~20-40 MB/s).
        // Higher quality (11 default) is 100x slower for tiny ratio win.
        const br = zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          },
        });
        br.pipe(res);
        sink = br;
      } else if (useGzip) {
        const gz = zlib.createGzip({ level: 4 });
        gz.pipe(res);
        sink = gz;
      }

      const writeLine = (obj) => sink.write(JSON.stringify(obj) + '\n');

      // Meta first — client uses `total` for the progress bar, `etag` for cache key.
      // `firstUuid` enables phase-2 prefix backfill (`?before=<firstUuid>`).
      writeLine({
        type: 'meta',
        total,
        returned: messages.length,
        truncated,
        dropped,
        sessionId: data?.sessionId,
        etag,
        lastUuid,
        firstUuid,
      });

      // Yield to event loop every 200 messages so we don't synchronously block
      // when a single client requests a 5000-message dump. The lighter pulse
      // keeps the HTTP server responsive to other requests during a big stream.
      const FLUSH_EVERY = 200;
      let written = 0;
      for (const msg of messages) {
        writeLine(msg);
        written += 1;
        if (written % FLUSH_EVERY === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
      // End sentinel — client can rely on `done` to know stream completed
      // cleanly vs was cut off mid-flight.
      writeLine({ type: 'done', written });
      sink.end();
      console.log(`[WebTiming] /history DONE total=${total} returned=${messages.length} dropped=${dropped} ms=${Date.now()-t0} mode=ndjson enc=${useBrotli ? 'br' : useGzip ? 'gz' : 'plain'}`);
      return;
    } catch (e) {
      console.log(`[WebTiming] /history ERROR ${String(e.message)} total=${Date.now()-t0}ms`);
      if (!res.headersSent) return sendJson(res, 500, { error: String(e.message) });
      try { res.end(); } catch {}
      return;
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ───────── Static file serving (mobile-web/dist) ─────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, parsed) {
  const distRoot = path.resolve(__dirname, '../../mobile-web/dist');
  let urlPath = parsed.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  // SPA fallback — any unknown path serves index.html so React Router takes over
  let filePath = path.join(distRoot, urlPath);
  // Block directory escapes
  if (!filePath.startsWith(distRoot)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback to index.html for SPA routes
      filePath = path.join(distRoot, 'index.html');
      fs.readFile(filePath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('mobile-web/dist not built. Run: cd mobile-web && npm run build');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ───────── WS pub/sub ─────────

function subscribe(tabId, sink) {
  if (!subscribers.has(tabId)) subscribers.set(tabId, new Set());
  subscribers.get(tabId).add(sink);
  console.log('[WebSub:Subscribe] tab=' + shortId(tabId, 12) + ' kind=' + sink.kind + ' total=' + subscribers.get(tabId).size + ' tabs=' + subscribers.size);
}
function unsubscribeAll(sink) {
  let removed = 0;
  for (const set of subscribers.values()) { if (set.delete(sink)) removed++; }
  if (removed) console.log('[WebSub:Unsubscribe] kind=' + (sink.kind || '?') + ' removed=' + removed + ' remainingTabs=' + Array.from(subscribers.entries()).filter(([_, s]) => s.size > 0).length);
}

// Wrap a raw WebSocket as a Sink.
function wsSink(ws) {
  return {
    kind: 'ws',
    send: (str) => { if (ws.readyState === 1) ws.send(str); },
    isAlive: () => ws.readyState === 1,
    close: () => { try { ws.close(); } catch {} },
    _ws: ws,
  };
}

// Stop watcher AND drop pending-promotion slot for any tab whose last
// subscriber (ws OR sse) disconnected. Both maps may hold orphans. Shared by
// the WS close/error handlers and the SSE req-close handler.
function releaseClaudeWatchersIfOrphan() {
  const allTabIds = new Set([
    ...claudeTabWatchers.keys(),
    ...claudeTabWatcherPending,
  ]);
  for (const tid of allTabIds) {
    const set = subscribers.get(tid);
    if (!set || set.size === 0) stopClaudeTabWatcher(tid);
  }
}

// Called from main.js when SDK/PTY fires events. Cheap O(n) over clients
// subscribed to that specific tabId — usually 0-1 phone connected. Transport
// (ws/sse) is opaque here; each Sink knows how to write itself.
//
// Logging is lifecycle-first, with one important exception: when a phone is
// actively subscribed, 'message' fan-out is logged with metadata only. That
// gives a permanent causal trace for "server emitted → SSE wrote → iOS applied"
// without dumping chat text or spamming desktop-only sessions with message drops.
const BCAST_LOG_TYPES = new Set(['snapshot', 'busy', 'done', 'bridge-update', 'queue-update', 'ask-question', 'question-cancelled']);
function webBroadcast(tabId, payload) {
  const type = payload && payload.type;
  const loggable = BCAST_LOG_TYPES.has(type);
  const set = subscribers.get(tabId);
  if (!set || set.size === 0) {
    if (loggable) console.log('[WebBcast:DROP] tab=' + shortId(tabId, 12) + ' type=' + type + summarizeBroadcastPayload(payload) + ' noSubscribers (registered=' + subscribers.size + ')');
    return;
  }
  const msg = JSON.stringify({ tabId, ...payload });
  let sent = 0;
  const dead = [];
  for (const sink of set) {
    try {
      if (sink.isAlive()) { sink.send(msg); sent++; }
      else dead.push(sink);
    } catch { dead.push(sink); }
  }
  for (const d of dead) set.delete(d);
  if (loggable || type === 'message' || dead.length) {
    console.log('[WebBcast:SEND] tab=' + shortId(tabId, 12) + ' type=' + type + ' to=' + sent + '/' + (sent + dead.length) + summarizeBroadcastPayload(payload) + (dead.length ? ' (pruned ' + dead.length + ' dead)' : ''));
  }
}

// ───────── JSONL tail-watchers for PTY+Claude tabs ─────────
// SDK tabs get their live events via webBroadcast() called from main on each
// SDK message. PTY+Claude tabs write to a JSONL file (~/.claude/projects/...) —
// the mobile client needs the same {type:'message'} stream. We fs.watch the
// resolved JSONL path and incrementally read new bytes.
//
// Activated on first WS subscribe to a tabId whose commandType==='claude'.
// Released when all subscribers for that tab disconnect.
//
// tabId -> { sessionId, filePath, offset, watcher, leftover, timer, inflight, attempts }
const claudeTabWatchers = new Map();
// Tabs whose WS is subscribed but Claude hasn't produced a sessionId yet.
// When sessionId arrives via main's `claude:session-detected` IPC path we
// promote them to live watchers — no polling, no timeouts. The set is also
// consulted on bridgeReady so we don't miss a sessionId that materialised
// before subscribe.
const claudeTabWatcherPending = new Set();

// Called from main.js whenever a claude session id is freshly attached to a
// tab (Bridge:Fresh / Bridge:PID / explicit resume / fork). Promotes any
// pending watcher for this tabId from "waiting for sessionId" → live fs.watch.
// Idempotent: a no-op if no pending entry exists.
function notifyClaudeSessionAvailable(tabId) {
  if (!claudeTabWatcherPending.has(tabId)) {
    console.log('[ClaudeWatcher] notify ignored tabId=' + shortId(tabId, 12) + ' no pending watcher');
    return;
  }
  console.log('[ClaudeWatcher] notify promote tabId=' + shortId(tabId, 12));
  claudeTabWatcherPending.delete(tabId);
  startClaudeTabWatcher(tabId).catch((e) => {
    console.warn('[ClaudeWatcher] late-start failed for', shortId(tabId, 12), e?.message);
  });
}

async function startClaudeTabWatcher(tabId) {
  if (claudeTabWatchers.has(tabId)) {
    console.log('[ClaudeWatcher] already-active tabId=' + shortId(tabId, 12));
    return;
  }
  let status;
  try {
    status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
  } catch (e) {
    console.warn('[ClaudeWatcher] status failed tabId=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
    return; // tab not open in renderer or bridge unavailable — skip
  }
  if (status?.commandType !== 'claude') {
    console.log('[ClaudeWatcher] skip tabId=' + shortId(tabId, 12) + ' command=' + (status?.commandType || '-') + ' tool=' + (status?.toolType || '-'));
    return; // not a PTY+Claude tab
  }
  if (!status.sessionId || !findSessionFile) {
    // No sessionId yet — Claude is still booting. Park the tabId; main.js will
    // call notifyClaudeSessionAvailable(tabId) the moment session-detected
    // fires (deterministic event from SessionBridge — never polled).
    claudeTabWatcherPending.add(tabId);
    console.log('[ClaudeWatcher] parked tabId=' + shortId(tabId, 12) + ' waiting for sessionId event findSessionFile=' + !!findSessionFile);
    return;
  }
  const found = findSessionFile(status.sessionId, status.cwd);
  if (!found) {
    // SessionId is known but the JSONL file isn't on disk yet — Claude wrote
    // the bridge.json moments before the first JSONL line landed (it batches
    // initial writes). Watch the parent directory ONCE for the file to
    // appear, then promote. No polling — fs.watch on the dir is event-driven.
    if (claudeTabWatcherPending.has(tabId)) {
      console.log('[ClaudeWatcher] still-pending tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId));
      return;
    }
    claudeTabWatcherPending.add(tabId);
    const projectDir = path.dirname(path.join(require('os').homedir(),
      '.claude', 'projects', 'placeholder', 'placeholder.jsonl'));
    let dirWatcher = null;
    const tryPromote = () => {
      if (findSessionFile(status.sessionId, status.cwd)) {
        try { dirWatcher?.close(); } catch {}
        console.log('[ClaudeWatcher] dir-promote tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId));
        claudeTabWatcherPending.delete(tabId);
        startClaudeTabWatcher(tabId).catch(() => {});
      }
    };
    try {
      // Watch the projects/ root since cwd-encoded subdir may itself not
      // exist yet for a brand-new project.
      const watchDir = path.join(require('os').homedir(), '.claude', 'projects');
      dirWatcher = fs.watch(watchDir, { recursive: true }, (_, fname) => {
        if (fname && fname.includes(status.sessionId)) tryPromote();
      });
    } catch (e) {
      console.warn('[ClaudeWatcher] dir-watch failed tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId) + ' err=' + (e?.message || e));
    }
    return;
  }
  const filePath = found.filePath;
  // Start at current EOF when there's already some history (user got it via
  // /history REST endpoint on chat open). For brand-new sessions whose first
  // JSONL bytes haven't been written yet, the file would have been "not found"
  // above; here size >= 1 record means /history already returned it.
  // Always-from-EOF policy avoids duplicate messages on the mobile reducer
  // (which would still dedupe by uuid, but at the cost of unnecessary WS
  // bytes). The race window where mobile has loaded /history but JSONL grew
  // between that read and our fs.stat is small (~ms); any messages from that
  // window arrive via the next turn's WS push because reducer.apply is
  // idempotent on uuid.
  let offset = 0;
  try { offset = fs.statSync(filePath).size; } catch (e) {
    console.warn('[ClaudeWatcher] stat failed tabId=' + shortId(tabId, 12) + ' file=' + filePath + ' err=' + (e?.message || e));
    return;
  }
  const entry = {
    sessionId: status.sessionId,
    filePath,
    offset,
    watcher: null,
    timer: null,
    inflight: false,        // guard against re-entrant readDelta
    leftover: '',           // partial last line carried to next read
  };

  // Send initial snapshot — phone needs current sessionStatus right after connect.
  webBroadcast(tabId, { type: 'snapshot', sessionId: status.sessionId, busy: status.status === 'busy', sessionStatus: status.status });

  const readDelta = () => {
    // Inflight guard: fs.watch on macOS can fire multiple times between our
    // scheduleRead debounce and stream.on('end'). Without this, two concurrent
    // reads share entry.offset and skip bytes (same shape as bug in
    // fix-incremental-reader-race.md::Race condition in Case 2).
    if (entry.inflight) {
      console.log('[ClaudeWatcher:Delta] skip-inflight tab=' + shortId(tabId, 12) + ' offset=' + entry.offset);
      return;
    }
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) {
      console.warn('[ClaudeWatcher:Delta] stat failed tab=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
      return;
    }
    if (size <= entry.offset) {
      // File got truncated (e.g. fork rewrite reusing same sessionId, or
      // session rewrite via `claude:fork-session-file`). Reset to head and
      // also drop leftover — old position invalidates partial line buffer.
      if (size < entry.offset) {
        console.log('[ClaudeWatcher:Delta] truncated tab=' + shortId(tabId, 12) + ' oldOffset=' + entry.offset + ' newSize=' + size);
        entry.offset = 0;
        entry.leftover = '';
      }
      return;
    }
    entry.inflight = true;
    const startOffset = entry.offset; // snapshot before yielding
    const stream = fs.createReadStream(filePath, { start: startOffset, end: size - 1 });
    let buf = entry.leftover;
    entry.leftover = ''; // carry forward only what survives this pass
    stream.on('data', (chunk) => { buf += chunk.toString('utf-8'); });
    stream.on('end', () => {
      entry.offset = size;
      // Last fragment may not end with \n — Claude's append could land
      // mid-record between two writes. Defer to next readDelta.
      const endsWithNewline = buf.endsWith('\n');
      const lines = buf.split('\n');
      if (!endsWithNewline) entry.leftover = lines.pop() || '';
      let sentRecords = 0;
      let parseErrors = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch {
          // Malformed JSON in a complete line is a real corruption — log
          // (deduped) and skip. NOT the partial-line case above.
          parseErrors += 1;
          continue;
        }
        // Mirror SDK WS protocol — mobile reducer expects { type:'message', message: inner }.
        // The inner record is what JSONL stores: { type:'user'|'assistant'|..., message:..., uuid, ... }.
        webBroadcast(tabId, { type: 'message', sessionId: parsed.sessionId || status.sessionId, message: parsed });
        sentRecords += 1;
      }
      console.log('[ClaudeWatcher:Delta] tab=' + shortId(tabId, 12) +
        ' sid=' + shortId(status.sessionId) +
        ' bytes=' + (size - startOffset) +
        ' range=' + startOffset + '..' + size +
        ' lines=' + lines.filter(Boolean).length +
        ' sent=' + sentRecords +
        ' parseErrors=' + parseErrors +
        ' leftover=' + entry.leftover.length);
      entry.inflight = false;
      // If fs.stat shows growth that happened DURING our read, schedule once
      // more so we don't miss bytes flushed between stat and our consumption.
      try {
        const nowSize = fs.statSync(filePath).size;
        if (nowSize > entry.offset) scheduleRead();
      } catch {}
    });
    stream.on('error', (e) => {
      entry.inflight = false;
      console.warn('[ClaudeWatcher:Delta] read error tab=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
    });
  };

  // Debounced re-read to coalesce rapid writes (Claude flushes JSONL in bursts).
  const scheduleRead = () => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => { entry.timer = null; readDelta(); }, 60);
  };

  try {
    entry.watcher = fs.watch(filePath, () => {
      console.log('[ClaudeWatcher:FS] change tab=' + shortId(tabId, 12) + ' offset=' + entry.offset);
      scheduleRead();
    });
  } catch (e) {
    console.warn('[ClaudeWatcher] fs.watch failed for', filePath, e.message);
    return;
  }
  claudeTabWatchers.set(tabId, entry);
  console.log('[ClaudeWatcher] started tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId) + ' status=' + (status.status || '-') + ' file=' + filePath + ' startOffset=' + offset);
  // Immediate read once — covers the race where Claude appended bytes between
  // our fs.statSync(filePath).size above and fs.watch arming. Subsequent
  // growth is caught by the watcher itself; offset guards against duplicates.
  scheduleRead();
}

function stopClaudeTabWatcher(tabId) {
  // Drop pending-promotion slot so a late session-detected event doesn't
  // try to start a watcher for a tab no one is watching anymore.
  claudeTabWatcherPending.delete(tabId);
  const entry = claudeTabWatchers.get(tabId);
  if (!entry) return;
  try { entry.watcher?.close(); } catch {}
  if (entry.timer) clearTimeout(entry.timer);
  claudeTabWatchers.delete(tabId);
  console.log('[ClaudeWatcher] stopped tabId=' + shortId(tabId, 12) + ' sid=' + shortId(entry.sessionId) + ' offset=' + entry.offset);
}

function attachWebSocket(server, sdkSessions) {
  if (!WebSocketServer) {
    console.warn('[WebServer] `ws` package not installed — WS streaming disabled');
    return;
  }
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);
    const remote = (socket.remoteAddress || '?') + ':' + (socket.remotePort || '?');
    console.log('[WebWS:Upgrade] path=' + parsed.pathname + ' tabId=' + String(parsed.query.tabId || '').slice(-12) + ' from=' + remote + ' tokenLen=' + String(parsed.query.token || '').length);
    if (parsed.pathname !== '/ws') {
      console.log('[WebWS:Upgrade:REJECT] bad path ' + parsed.pathname);
      socket.destroy();
      return;
    }
    if (parsed.query.token !== token) {
      console.log('[WebWS:Upgrade:REJECT] token mismatch (got len=' + String(parsed.query.token || '').length + ', expected len=' + String(token || '').length + ')');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tabId = parsed.query.tabId;
      const sink = wsSink(ws);
      ws.tabId = tabId || null;
      if (tabId) {
        subscribe(tabId, sink);
        // Send initial snapshot of live state — what the phone needs to render
        // immediately without waiting for the next message.
        sendInitialSnapshot(tabId, sink, sdkSessions).catch(() => {});
        // Start fs-watch on PTY+Claude tab's JSONL (no-op for SDK tabs).
        startClaudeTabWatcher(tabId).catch(() => {});
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe' && msg.tabId) {
            subscribe(msg.tabId, sink);
            sendInitialSnapshot(msg.tabId, sink, sdkSessions).catch(() => {});
            startClaudeTabWatcher(msg.tabId).catch(() => {});
          }
        } catch {}
      });
      ws.on('close', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); });
      ws.on('error', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); });
    });
  });
}

// ───────── lifecycle ─────────

function start({ sdkSessions, computeActiveLoaders: computeFn, answerClaudeQuestion: answerFn, getClaudePendingQuestion: getQFn }) {
  if (httpServer) {
    console.log('[WebServer] already started');
    return;
  }
  if (!sdkSessions) throw new Error('start({sdkSessions}) — Map of live SDK sessions required');
  computeActiveLoaders = computeFn || null;
  answerClaudeQuestion = answerFn || null;
  getClaudePendingQuestion = getQFn || null;
  token = loadOrCreateToken();
  registerBridgeReplyHandler();

  httpServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname.startsWith('/api/') || parsed.pathname === '/api') {
      handleApi(req, res, parsed, sdkSessions).catch((err) => {
        console.error('[WebServer] handler error:', err);
        sendJson(res, 500, { error: String(err.message) });
      });
      return;
    }
    serveStatic(req, res, parsed);
  });

  attachWebSocket(httpServer, sdkSessions);

  // Port-walk fallback. listen() emits 'error' with EADDRINUSE if port is taken.
  // Catch it, increment, retry — up to PORT_MAX. The successful port is stored
  // in `resolvedPort` and published via discovery file so renderer (StatusBar
  // mobile-web chip) reads the real port instead of the hardcoded 7878.
  const tryListen = (p) => {
    httpServer.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && p < PORT_MAX) {
        console.warn('[WebServer] port ' + p + ' in use, trying ' + (p + 1));
        // listen() emits one error per attempt; recreate listener for retry
        setImmediate(() => tryListen(p + 1));
        return;
      }
      console.error('[WebServer] server error:', err.message);
    });
    httpServer.listen(p, '0.0.0.0', () => {
      resolvedPort = p;
      writeWebServerDiscovery();
      const ip = getLanIp();
      console.log('[WebServer] listening on http://' + ip + ':' + p + ' (pid=' + process.pid + ')');
      console.log('[WebServer] token (' + TOKEN_PATH + '): ' + token);
      console.log('[WebServer] mobile URL example: http://' + ip + ':' + p + '/?token=' + token);
    });
  };
  tryListen(PORT_PREFERRED);
}

function writeWebServerDiscovery() {
  try {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
    fs.writeFileSync(DISCOVERY_FILE, JSON.stringify({
      port: resolvedPort,
      pid: process.pid,
      lanIp: getLanIp(),
      updatedAt: Date.now(),
    }));
  } catch (e) { console.warn('[WebServer:Discovery] write failed:', e.message); }
}

function stop() {
  if (wss) try { wss.close(); } catch {}
  if (httpServer) try { httpServer.close(); } catch {}
  try { fs.unlinkSync(DISCOVERY_FILE); } catch {}
  httpServer = null;
  wss = null;
  subscribers.clear();
}

function getInfo() {
  return {
    running: !!httpServer,
    port: resolvedPort,
    token,
    lanIp: getLanIp(),
  };
}

module.exports = { start, stop, webBroadcast, getInfo, notifyClaudeSessionAvailable };
