// Mobile/web bridge: exposes Noted Terminal's project terminal tabs over
// HTTP+SSE/WS so a phone or external client can drive Claude/Codex PTY sessions.
// Backend runs in Electron main; frontend (mobile-web/) is a separate Vite app
// served as static files from this server. Authentication: single bearer token in
// ~/.noted-terminal/web-token.txt, regenerated only if missing.
//
// What's exposed:
//   GET  /api/me                                 → { ok: true } if token valid
//   GET  /api/agent-models                        → { codex:[…], claude:[…] } model catalog
//   GET  /api/projects                            → all projects from DB
//   GET  /api/projects/:projectId/tabs            → tabs of one project (DB)
//   POST /api/projects/:projectId/agent-tabs       → create Claude/Codex terminal tab
//   POST /api/terminal-tabs/:tabId/send            → send prompt through scenario layer
//   POST /api/terminal-tabs/:tabId/stop            → stop terminal runtime
//   POST /api/terminal-tabs/:tabId/fork            → fork Claude/Codex into a neighbour tab
//   GET  /api/terminal-tabs/:tabId/history         → load JSONL/rollout session history
//   POST /api/terminal-tabs/:tabId/edit-range      → Claude JSONL / Codex rollout middle compact
//   POST /api/terminal-tabs/:tabId/delete-range    → Claude JSONL / Codex rollout middle delete
//   GET  /api/events?token=...&tabId=...           → live terminal event stream
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
// because renderer's openProjects map only has currently-open ones. Terminal
// runtime state comes from the renderer/main scenario layer; legacy SDK session
// metadata still comes from main's sdkSessions Map. Tab creation needs the
// renderer (so the tab actually appears in the UI), so we use a request/reply
// IPC bridge.
//
// Important: the WS protocol forwards the same payloads main already sends to
// the local renderer via webContents.send('claude-sdk:message' / 'busy-state').
// We added one helper at the source — `webBroadcast(...)` — that fan-outs to
// every WS client subscribed to that tabId. No business logic on the WS layer.

const http = require('http');
const http2 = require('http2');
const url = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');
const {
  codexSessionIdFromAuthoritativeStatus,
  isCodexComposerReadyForGuardedSend,
} = require('./codex-runtime-contract');
const {
  classifyAgentActionBridgeError,
  classifyAgentActionResult,
  validateFreshAgentRuntimeStatus,
} = require('./project-api-runtime-contract');
const { OrchestrationRunStore, isActiveStatus } = require('./orchestration-runs');
const INBOX_PROJECT_ID = '__noted_inbox__';
const isInboxProjectId = (projectId) => projectId === INBOX_PROJECT_ID;
// Lazy-require the helpers (loaded fresh each call so missing module just
// disables the dependent endpoints, not the whole server).
let findSessionFile = null;
let parseTimelineUuids = null;
let parseTimelineEntries = null;
let getClaudeSessionMaterialization = null;
let claudeDataApi = null;
let loadCodexSessionRecords = null;
let buildCodexTimeline = null;
let listCodexModels = null;
let codexDataApi = null;
let sanitizeFileForPrompt = null;
try {
  const cd = require(path.join(__dirname, 'ipc', 'claude-data'));
  findSessionFile = cd.findSessionFile;
  parseTimelineUuids = cd.parseTimelineUuids;
  parseTimelineEntries = cd.parseTimelineEntries;
  getClaudeSessionMaterialization = cd.getSessionMaterialization;
  claudeDataApi = cd._api || null;
} catch (e) {
  console.warn('[WebServer] claude-data helpers not loaded:', e.message);
}
try {
  const codex = require(path.join(__dirname, 'ipc', 'codex-data'));
  codexDataApi = codex._api || null;
  loadCodexSessionRecords = codex._api?.loadSessionRecords || null;
  buildCodexTimeline = codex._api?.buildCodexTimeline || codex.buildCodexTimeline || null;
  listCodexModels = codex.listCodexModels || codex._api?.listCodexModels || null;
} catch (e) {
  console.warn('[WebServer] codex-data helpers not loaded:', e.message);
}
try {
  sanitizeFileForPrompt = require(path.join(__dirname, 'ipc', 'settings')).sanitizeFileForPrompt || null;
} catch (e) {
  console.warn('[WebServer] prompt file sanitizer not loaded:', e.message);
}

// Claude model list for native/web clients. Mirror of the renderer source of
// truth `src/renderer/constants/claudeLevels.ts::DEFAULT_CLAUDE_CODE_MODELS` —
// kept inline because that file is TS/renderer-only and main cannot require it.
// If Anthropic revs the list, edit both (claudeLevels.ts is canonical).
const CLAUDE_MODELS_FOR_CLIENTS = [
  { id: 'default', label: 'default' },
  { id: 'sonnet', label: 'sonnet' },
  { id: 'opus', label: 'opus' },
  { id: 'haiku', label: 'haiku' },
  { id: 'claude-fable-5[1m]', label: 'fable' },
];

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
const IOS_PUSH_TOKENS_PATH = path.join(DISCOVERY_DIR, 'ios-push-tokens.json');

let httpServer = null;
let wss = null;
let token = null;
let apnsJwtCache = null;
// Injected from main at start() — reads the live busy/running Maps (the same
// ones that drive the per-tab UI loader). Used by GET /api/active-loaders.
let computeActiveLoaders = null;
// Injected from main at start() — tiny aggregate for the native iOS project
// list badge. This is deliberately project-scoped, not a tab transcript stream:
// one SSE connection carries a full snapshot of {projectId,count,streaming}.
let computeProjectActivity = null;
// Mobile question answering — injected by main.start(). answerClaudeQuestion
// routes SDK (resolve parked Promise) vs PTY (drive TUI keystrokes);
// getClaudePendingQuestion reads the live pending question for the SSE snapshot.
let answerClaudeQuestion = null;
let getClaudePendingQuestion = null;
let transcriptService = null;
let getAgentTurnResult = null;
// Main-owned Codex process/writer resolver. Renderer state and SQLite are not
// authoritative for a live rollout, so web routes fall back to this callback
// when the bridge is unavailable instead of publishing the saved resume ID.
let resolveCodexRuntimeSessionInfo = null;
// tabId → Set<Sink>. A Sink is the common interface for both transports:
//   { kind:'ws'|'sse', send(str):void, isAlive():bool, close():void }
// WebSocket and SSE both register here so webBroadcast() fans out to either
// without caring which transport the client used. Yandex/Chrome anti-tracker
// extensions silently block ws:// to private IPs (deterministically observed:
// fetch 200 but WS TIMEOUT rs=0, while curl gets 101) — SSE over plain GET is
// the reliable fallback. See fact-mobile-web.md::SSE transport.
const subscribers = new Map();
const PROJECT_ACTIVITY_TOPIC = '__project_activity__';
// pending bridge requests to renderer: requestId → { resolve, reject, timer }
const pendingBridge = new Map();
const externalRuns = new Map();      // runId -> run metadata
const externalRunByTabId = new Map(); // tabId -> runId
const externalRunByConversationKey = new Map(); // conversationKey -> runId
const DEFAULT_EXTERNAL_AUTO_CLOSE_MS = 15 * 60 * 1000;
let orchestrationRunStore = null;
const orchestrationCompletionInflight = new Set();

function getOrchestrationRunStore() {
  if (!orchestrationRunStore) {
    orchestrationRunStore = new OrchestrationRunStore(path.join(app.getPath('userData'), 'orchestration-runs.json'));
  }
  return orchestrationRunStore;
}

function shortId(value, len = 8) {
  const s = value == null ? '' : String(value);
  return s ? s.slice(-len) : 'nil';
}

function bridgePayloadLabel(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (payload.tabId) parts.push('tab=' + shortId(payload.tabId, 12));
  if (payload.projectId) parts.push('project=' + shortId(payload.projectId, 12));
  if (payload.targetIndex != null) parts.push('targetIndex=' + payload.targetIndex);
  if (payload.mode) parts.push('mode=' + payload.mode);
  return parts.length ? ' ' + parts.join(' ') : '';
}

function startRoutePendingLog(prefix, startedAt, afterMs = 10_000) {
  const timer = setTimeout(() => {
    console.log(prefix + ' STILL_PENDING ms=' + (Date.now() - startedAt));
  }, afterMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

function cleanOptionalString(value, fallback = '') {
  const s = value == null ? '' : String(value).trim();
  return s || fallback;
}

function claudeMaterializationFor(sessionId, cwd) {
  if (!sessionId || !getClaudeSessionMaterialization) {
    return {
      materialized: false,
      conversationMaterialized: false,
      timelineCount: sessionId ? null : 0,
      fileFound: false,
      reason: sessionId ? 'materialization-helper-unavailable' : 'no-session-id',
    };
  }
  try {
    const result = getClaudeSessionMaterialization(sessionId, cwd);
    return {
      ...result,
      materialized: result?.materialized === true,
      conversationMaterialized: result?.materialized === true,
      timelineCount: typeof result?.timelineCount === 'number' ? result.timelineCount : null,
    };
  } catch (e) {
    return {
      materialized: false,
      conversationMaterialized: false,
      timelineCount: null,
      fileFound: false,
      reason: 'materialization-check-failed',
      error: String(e?.message || e),
    };
  }
}

const MOBILE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
const mobileAttachmentIndex = new Map();

function mobileAttachmentRoot() {
  return path.join(app.getPath('temp'), 'noted-terminal-mobile-attachments');
}

function sanitizeMobileAttachmentName(name, fallback = 'attachment') {
  const raw = String(name || fallback).trim() || fallback;
  return raw
    .replace(/[\/\\:\0]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 160) || fallback;
}

function normalizeMobileAttachmentKind(kind, mimeType) {
  const k = String(kind || '').toLowerCase();
  if (k === 'image' || k === 'file') return k;
  return String(mimeType || '').startsWith('image/') ? 'image' : 'file';
}

function inferMobileAttachmentMimeType(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  return fallback;
}

function safeMobileAttachmentPath(id, name) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  return path.join(mobileAttachmentRoot(), safeId, sanitizeMobileAttachmentName(name));
}

async function removeMobileAttachment(id) {
  const cleanId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) return false;
  const known = mobileAttachmentIndex.get(cleanId);
  const dir = known?.dir || path.join(mobileAttachmentRoot(), cleanId);
  await fs.promises.rm(dir, { recursive: true, force: true });
  mobileAttachmentIndex.delete(cleanId);
  return true;
}

async function cleanupMobileAttachments() {
  const root = mobileAttachmentRoot();
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        try {
          const stat = await fs.promises.stat(dir);
          if (stat.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true });
        } catch {}
      }));
  } catch {}
}

async function storeMobileAttachment(payload) {
  const name = sanitizeMobileAttachmentName(payload?.name, payload?.kind === 'image' ? 'image.jpg' : 'attachment');
  const mimeType = cleanOptionalString(payload?.mimeType, 'application/octet-stream');
  const kind = normalizeMobileAttachmentKind(payload?.kind, mimeType);
  const dataBase64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : '';
  if (!dataBase64) {
    const err = new Error('dataBase64 required');
    err.statusCode = 400;
    throw err;
  }
  const estimatedBytes = Math.floor((dataBase64.length * 3) / 4);
  if (estimatedBytes > MOBILE_ATTACHMENT_MAX_BYTES) {
    const err = new Error('attachment too large');
    err.statusCode = 413;
    throw err;
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length || buffer.length > MOBILE_ATTACHMENT_MAX_BYTES) {
    const err = new Error('attachment too large');
    err.statusCode = 413;
    throw err;
  }
  const id = crypto.randomUUID();
  const dir = path.join(mobileAttachmentRoot(), id);
  const filePath = safeMobileAttachmentPath(id, name);
  if (!filePath) {
    const err = new Error('invalid attachment id');
    err.statusCode = 500;
    throw err;
  }
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  const item = { id, kind, name, mimeType, size: buffer.length, path: filePath, dir, createdAt: Date.now() };
  mobileAttachmentIndex.set(id, item);
  // Sent chat history keeps preview references to this Mac-local file. Do not
  // age-clean uploads here; explicit composer removal is the only immediate
  // delete path.
  return item;
}

function normalizeSendAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const root = mobileAttachmentRoot();
  return attachments.flatMap((item) => {
    const id = typeof item?.id === 'string' ? item.id : '';
    const known = id ? mobileAttachmentIndex.get(id) : null;
    const rawPath = String(item?.path || item?.filePath || known?.path || '').trim();
    if (!rawPath || !path.isAbsolute(rawPath)) return [];
    const resolved = path.resolve(rawPath);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) return [];
    if (!fs.existsSync(resolved)) return [];
    const name = sanitizeMobileAttachmentName(item?.name || known?.name || path.basename(resolved));
    const mimeType = cleanOptionalString(item?.mimeType || known?.mimeType, 'application/octet-stream');
    const kind = normalizeMobileAttachmentKind(item?.kind || known?.kind, mimeType);
    const size = Number(item?.size || known?.size || 0) || 0;
    return [{ id, kind, name, mimeType, size, path: resolved }];
  });
}

async function readMobileAttachmentPreview(payload) {
  const rawPath = String(payload?.path || payload?.filePath || '').trim();
  if (!rawPath || !path.isAbsolute(rawPath)) {
    const err = new Error('absolute attachment path required');
    err.statusCode = 400;
    throw err;
  }
  const root = path.resolve(mobileAttachmentRoot());
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(root + path.sep)) {
    const err = new Error('attachment path outside mobile temp root');
    err.statusCode = 403;
    throw err;
  }
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) {
    const err = new Error('attachment path is not a file');
    err.statusCode = 400;
    throw err;
  }
  const rel = path.relative(root, resolved);
  const id = rel.split(path.sep)[0] || '';
  const known = id ? mobileAttachmentIndex.get(id) : null;
  const mimeType = cleanOptionalString(known?.mimeType, inferMobileAttachmentMimeType(resolved));
  const kind = normalizeMobileAttachmentKind(known?.kind, mimeType);
  const result = {
    id,
    kind,
    name: sanitizeMobileAttachmentName(known?.name || path.basename(resolved)),
    mimeType,
    size: stat.size,
    path: resolved,
  };
  if (kind === 'image' && stat.size <= MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES) {
    const buffer = await fs.promises.readFile(resolved);
    result.dataBase64 = buffer.toString('base64');
  }
  return result;
}

function appendAttachmentsToPrompt(prompt, attachments) {
  const cleanPrompt = String(prompt || '').trim();
  const normalized = normalizeSendAttachments(attachments);
  if (!normalized.length) return { prompt: cleanPrompt, attachments: [] };
  const lines = normalized.map((att) => {
    const sizePart = att.size ? ', ' + Math.ceil(att.size / 1024) + ' KB' : '';
    const meta = [att.kind, att.mimeType].filter(Boolean).join(', ');
    return '- [' + (meta || 'file') + '] ' + att.name + ': ' + att.path + sizePart;
  });
  const attachmentBlock = [
    'Attached files from iOS are already uploaded to this Mac. Read them from these local paths if relevant:',
    ...lines,
  ].join('\n');
  if (cleanPrompt.includes('Attached files from iOS are already uploaded to this Mac')) {
    return { prompt: cleanPrompt, attachments: normalized };
  }
  return {
    prompt: [cleanPrompt, attachmentBlock].filter(Boolean).join('\n\n'),
    attachments: normalized,
  };
}

function clampAutoStopMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30_000;
  return Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(n)));
}

function clampAutoCloseMs(value) {
  if (value == null || value === '') return DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
  return Math.max(0, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(n)));
}

function setExternalRunMeta(tabId, meta) {
  if (!tabId || !meta) return;
  bridgeRequest('setExternalRunMeta', { tabId, meta }, 1500).catch(() => {});
}

function clearExternalRunTimer(run, key) {
  if (!run?.[key]) return;
  clearTimeout(run[key]);
  run[key] = null;
}

function cleanupExternalRun(run) {
  if (!run) return;
  clearExternalRunTimer(run, 'stopTimer');
  clearExternalRunTimer(run, 'closeTimer');
  if (run.tabId && externalRunByTabId.get(run.tabId) === run.runId) {
    externalRunByTabId.delete(run.tabId);
  }
  if (run.conversationKey && externalRunByConversationKey.get(run.conversationKey) === run.runId) {
    externalRunByConversationKey.delete(run.conversationKey);
  }
  if (run.runId) externalRuns.delete(run.runId);
}

async function waitForAgentReady(tabId, timeoutMs = 20_000) {
  const limitMs = Math.max(1000, Math.min(60_000, Number(timeoutMs) || 20_000));
  let last = null;
  const isManualActionRequiredStatus = (status) => {
    if (!status) return false;
    if (status.manualActionRequired === true) return true;
    const blockers = Array.isArray(status.lastNotReady?.blockers) ? status.lastNotReady.blockers : [];
    return blockers.includes('auth-required');
  };
  const readStatus = async () => {
    try {
      last = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
      if (isManualActionRequiredStatus(last)) {
        const err = new Error('codex_auth_required');
        err.code = 'codex_auth_required';
        err.status = last;
        throw err;
      }
      // Codex resume can have a fully-ready composer before the CLI proves
      // whether it will append to the source rollout or create a linked child.
      // That is ready for one guarded submit, but it is not a current-session
      // identity. Main revalidates the exact launch/source proof under the PTY
      // write lock and audits the post-Enter user_message.
      const codexProvisionalComposerReady = isCodexComposerReadyForGuardedSend(last)
        && last?.status === 'starting';
      if (last && ((last.status === 'active' || last.status === 'busy') && last.inputReady === true
        || codexProvisionalComposerReady)) {
        return last;
      }
    } catch (e) {
      if (e?.code === 'codex_auth_required') throw e;
      last = { error: String(e.message || e) };
    }
    return null;
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
	    const finish = (err, status) => {
	      if (settled) return;
	      settled = true;
	      if (timer) clearTimeout(timer);
	      ipcMain.removeListener('agent:tui-ready-internal', onReady);
	      ipcMain.removeListener('claude:startup-defaults-gate', onStartupDefaultsGate);
	      if (err) reject(err);
	      else resolve(status);
	    };
    const fail = () => {
      const err = new Error('agent did not become ready');
      err.status = last;
      finish(err);
    };
    const check = () => {
      readStatus()
        .then((status) => { if (status) finish(null, status); })
        .catch((e) => {
          last = { error: String(e.message || e) };
          if (e?.code === 'codex_auth_required') finish(e);
        });
    };
	    const onReady = (_event, payload) => {
	      const readyTabId = typeof payload === 'string' ? payload : payload?.tabId;
	      if (readyTabId !== tabId) return;
	      check();
	    };
	    const onStartupDefaultsGate = (_event, payload = {}) => {
	      if (payload?.tabId !== tabId) return;
	      console.log('[WebReadyWait] wake tab=' + shortId(tabId, 12)
	        + ' source=startup-defaults status=' + (payload?.status || '-')
	        + ' reason=' + (payload?.reason || '-'));
	      check();
	    };
	    ipcMain.on('agent:tui-ready-internal', onReady);
	    ipcMain.on('claude:startup-defaults-gate', onStartupDefaultsGate);
	    timer = setTimeout(fail, limitMs);
	    check();
	  });
	}

async function readFreshReadyRuntimeStatus(tabId, label) {
  let status;
  try {
    status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
  } catch (error) {
    const wrapped = new Error('runtime snapshot unavailable after startup defaults: ' + String(error?.message || error));
    wrapped.code = error?.code === 'bridge_timeout'
      ? 'runtime_snapshot_timeout'
      : 'runtime_snapshot_unavailable';
    wrapped.statusCode = error?.code === 'bridge_timeout' ? 504 : 502;
    wrapped.status = null;
    throw wrapped;
  }
  const verdict = validateFreshAgentRuntimeStatus(status);
  if (!verdict.ok) {
    const error = new Error(verdict.error);
    error.code = verdict.error;
    error.statusCode = verdict.statusCode;
    error.status = status;
    throw error;
  }
  console.log('[WebReadyFresh] tab=' + shortId(tabId, 12)
    + ' label=' + label
    + ' status=' + (status?.status || '-')
    + ' inputReady=' + (status?.inputReady === true)
    + ' tool=' + (status?.toolType || status?.commandType || '-'));
  return status;
}

async function resolveEditRangeMutationTarget(tabId, body = {}, operation = 'edit') {
  const operationName = operation === 'delete' ? 'delete-range' : 'edit-range';
  let status = null;
  try {
    status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
  } catch (e) {
    const err = new Error('tab is not open or status is unavailable: ' + String(e.message || e));
    err.statusCode = 409;
    throw err;
  }

  const toolType = status?.toolType || status?.commandType;
  if (toolType !== 'claude' && toolType !== 'codex') {
    const err = new Error('history ' + operationName + ' is supported only for Claude/Codex terminal tabs');
    err.statusCode = 400;
    err.details = { commandType: status?.commandType || null, toolType: status?.toolType || null };
    throw err;
  }
  if (status?.status === 'stopping' || status?.stopping === true) {
    const err = new Error('tab is stopping; history range mutation is not allowed');
    err.statusCode = 409;
    err.details = { status: status?.status || null, toolType };
    throw err;
  }
  if (toolType === 'codex' && status?.status !== 'inactive') {
    const err = new Error('Codex ' + operationName + ' requires an inactive tab; stop Codex before mutating rollout history');
    err.statusCode = 409;
    err.details = { status: status?.status || null, toolType };
    throw err;
  }
  const claudeMutation = operation === 'delete' ? claudeDataApi?.deleteRange : claudeDataApi?.editRange;
  const codexMutation = operation === 'delete' ? codexDataApi?.deleteCodexRange : codexDataApi?.editCodexRange;
  if (toolType === 'claude' && !claudeMutation) {
    const err = new Error('claude history mutation API is not initialised');
    err.statusCode = 500;
    throw err;
  }
  if (toolType === 'codex' && !codexMutation) {
    const err = new Error('codex history mutation API is not initialised');
    err.statusCode = 500;
    throw err;
  }

  const statusSessionId = toolType === 'codex'
    ? cleanOptionalString(status?.sessionId || status?.codexSessionId, '')
    : cleanOptionalString(status?.sessionId || status?.claudeSessionId, '');
  const requestedSessionId = cleanOptionalString(body.sessionId, '');
  const sessionId = requestedSessionId || statusSessionId;
  if (!sessionId) {
    const err = new Error((toolType === 'codex' ? 'Codex' : 'Claude') + ' session id is required');
    err.statusCode = 400;
    throw err;
  }
  if (requestedSessionId && statusSessionId && requestedSessionId !== statusSessionId) {
    const err = new Error('body.sessionId does not match tab sessionId');
    err.statusCode = 409;
    err.details = { requestedSessionId, tabSessionId: statusSessionId, toolType };
    throw err;
  }

  const cwd = cleanOptionalString(body.cwd, '') || cleanOptionalString(status?.cwd, '');
  const startUuid = cleanOptionalString(body.startUuid || body.targetUuid, '');
  const endUuid = cleanOptionalString(body.endUuid, '');
  if (!startUuid || !endUuid) {
    const err = new Error('startUuid and endUuid required');
    err.statusCode = 400;
    throw err;
  }

  return { status, toolType, sessionId, cwd, startUuid, endUuid };
}

function scheduleExternalRunStop(run, reason = 'auto-stop') {
  if (!run || !run.tabId) return;
  const autoStopMs = clampAutoStopMs(run.autoStopMs);
  if (autoStopMs < 0) return;
  clearExternalRunTimer(run, 'stopTimer');
  const stopAt = Date.now() + autoStopMs;
  run.autoStopAt = stopAt;
  setExternalRunMeta(run.tabId, { status: run.status || 'done', autoStopAt: stopAt, autoStopMs });
  run.stopTimer = setTimeout(async () => {
    try {
      run.status = 'stopping';
      setExternalRunMeta(run.tabId, { status: 'stopping', autoStopAt: null, autoStopMs });
      await runAgentStopScenario(run.tabId, 5000);
      run.status = 'stopped';
      run.stoppedAt = Date.now();
      setExternalRunMeta(run.tabId, { status: 'stopped', autoStopAt: null, autoStopMs, stoppedAt: run.stoppedAt, stopReason: reason });
    } catch (e) {
      run.status = 'stop_failed';
      setExternalRunMeta(run.tabId, { status: 'stop_failed', autoStopAt: null, stopError: String(e.message || e) });
    }
  }, autoStopMs);
}

function scheduleExternalRunClose(run, reason = 'auto-close') {
  if (!run || !run.tabId) return;
  const autoCloseMs = clampAutoCloseMs(run.autoCloseMs);
  clearExternalRunTimer(run, 'closeTimer');
  if (autoCloseMs <= 0) {
    run.autoCloseAt = null;
    setExternalRunMeta(run.tabId, { autoCloseAt: null, autoCloseMs });
    return;
  }
  const closeAt = Date.now() + autoCloseMs;
  run.autoCloseAt = closeAt;
  setExternalRunMeta(run.tabId, { autoCloseAt: closeAt, autoCloseMs });
  run.closeTimer = setTimeout(async () => {
    try {
      run.status = 'closing';
      setExternalRunMeta(run.tabId, { status: 'closing', autoCloseAt: null, autoCloseMs, closeReason: reason });
      await bridgeRequest('closeTab', { tabId: run.tabId, aiBusyOverride: false }, 8000);
      cleanupExternalRun(run);
    } catch (e) {
      run.status = 'close_failed';
      setExternalRunMeta(run.tabId, { status: 'close_failed', autoCloseAt: null, closeError: String(e.message || e) });
    }
  }, autoCloseMs);
}

function scheduleExternalRunCompletionTimers(run, reason = 'turn-done') {
  if (!run || !run.tabId) return;
  scheduleExternalRunStop(run, reason);
  scheduleExternalRunClose(run, reason);
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

function streamMessageBlocks(message) {
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  return Array.isArray(msg?.content) ? msg.content : [];
}

function streamMessageText(message) {
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  if (typeof msg?.content === 'string') return msg.content;
  const out = [];
  for (const block of streamMessageBlocks(message)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('\n');
}

function isSlashCommandTranscriptText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('<command-name>');
}

function isNonTranscriptServiceText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('<local-command-stdout>')
    || trimmed.startsWith('<local-command-caveat>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed === '[tool_result]'
    || trimmed.startsWith('<tool_result>');
}

function extractQueuedCommandProjectionText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (typeof item.message === 'string') return item.message;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (prompt && typeof prompt === 'object') {
    if (typeof prompt.text === 'string') return prompt.text;
    if (typeof prompt.content === 'string') return prompt.content;
    if (typeof prompt.message === 'string') return prompt.message;
  }
  return '';
}

function queuedCommandProjectionText(message) {
  if (message?.type !== 'attachment' || message?.attachment?.type !== 'queued_command') return '';
  return extractQueuedCommandProjectionText(message.attachment.prompt).trim();
}

function isSlashCommandText(text) {
  return String(text || '').trim().startsWith('/');
}

function deriveMessageProjection(payload) {
  if (!payload || payload.type !== 'message') return null;
  if (payload.projection && typeof payload.projection === 'object') return payload.projection;
  const message = payload.message || {};
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  const blocks = streamMessageBlocks(message);
  const entryId = message?.uuid || msg?.id || message?.id || null;
  const source = message?.__projectionSource
    || (message?.__webSynthetic === true ? 'synthetic-web-broadcast' : null)
    || (String(entryId || '').startsWith('codex-live-') ? 'codex-rollout-live' : null)
    || 'agent-live';
  let kind = message?.type || msg?.role || 'unknown';
  let role = msg?.role || (message?.type === 'user' ? 'user' : message?.type === 'assistant' ? 'assistant' : null);
  let transcript = message?.__projectionTranscript;
  let ephemeral = message?.__projectionEphemeral === true;
  let timeline = message?.__projectionTimeline;

  if (transcript == null) {
    const hasText = blocks.some((b) => b?.type === 'text' && String(b?.text || '').trim());
    const hasToolUse = blocks.some((b) => b?.type === 'tool_use');
    const hasToolResult = blocks.some((b) => b?.type === 'tool_result');
    const hasThinking = blocks.some((b) => b?.type === 'thinking' && String(b?.thinking || '').trim());
    const text = streamMessageText(message);
    const queuedText = queuedCommandProjectionText(message);
    if (queuedText) {
      kind = isSlashCommandText(queuedText) ? 'slash' : 'queued';
      role = 'user';
      transcript = true;
      ephemeral = false;
      timeline = !isSlashCommandText(queuedText);
    } else if (message?.type === 'assistant' && hasThinking && !hasText && !hasToolUse) {
      kind = 'thinking';
      role = 'assistant';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else if (message?.type === 'user' && isSlashCommandTranscriptText(text)) {
      kind = 'slash';
      role = 'user';
      transcript = true;
      ephemeral = false;
      timeline = false;
    } else if (message?.type === 'user' && isNonTranscriptServiceText(text)) {
      kind = 'service';
      role = 'user';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else if (hasToolResult) {
      kind = 'tool_result';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else {
      transcript = true;
      if (timeline == null) timeline = message?.type === 'user';
    }
  }

  return {
    version: 1,
    source,
    entryId,
    kind,
    role,
    transcript: transcript === true,
    timeline: timeline === true,
    ephemeral,
  };
}

function withMessageProjection(payload) {
  if (!payload || payload.type !== 'message') return payload;
  const projection = deriveMessageProjection(payload);
  return projection ? { ...payload, projection } : payload;
}

function summarizeBroadcastPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.type === 'message') {
    const projection = payload.projection || deriveMessageProjection(payload);
    const projectionPart = projection
      ? ' projection=' + (projection.transcript === false ? 'skip' : 'transcript') +
        '/' + (projection.timeline === false ? 'no-timeline' : 'timeline') +
        '/' + (projection.kind || '-') +
        ' entry=' + shortId(projection.entryId) +
        ' source=' + (projection.source || '-')
      : '';
    return summarizeStreamMessage(payload.message) + projectionPart;
  }
  if (payload.type === 'project-activity') {
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    const active = projects.filter((p) => (Number(p?.count) || 0) > 0 || p?.streaming === true).length;
    const streaming = projects.filter((p) => p?.streaming === true).length;
    return ' projects=' + projects.length + ' active=' + active + ' streaming=' + streaming + ' projectOrder=' + (payload.projectOrderChanged === true);
  }
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

function readIosPushTokens() {
  try {
    if (!fs.existsSync(IOS_PUSH_TOKENS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(IOS_PUSH_TOKENS_PATH, 'utf-8'));
    return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  } catch (e) {
    console.warn('[APNs] token store read failed:', e?.message || e);
    return [];
  }
}

function writeIosPushTokens(tokens) {
  fs.mkdirSync(path.dirname(IOS_PUSH_TOKENS_PATH), { recursive: true });
  fs.writeFileSync(IOS_PUSH_TOKENS_PATH, JSON.stringify({ tokens, updatedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 });
}

function registerIosPushToken(payload = {}) {
  const rawToken = String(payload.token || '').trim().replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (!rawToken || rawToken.length < 32) return { ok: false, error: 'invalid token' };
  const environment = payload.environment === 'production' ? 'production' : 'development';
  const bundleId = String(payload.bundleId || process.env.NOTED_APNS_BUNDLE_ID || 'com.habittracker.swift').trim();
  const now = Date.now();
  const existing = readIosPushTokens().filter((item) => String(item.token || '').toLowerCase() !== rawToken);
  existing.push({
    token: rawToken,
    environment,
    bundleId,
    deviceName: String(payload.deviceName || '').slice(0, 120),
    platform: String(payload.platform || 'ios').slice(0, 40),
    registeredAt: now,
    lastSeenAt: now,
  });
  writeIosPushTokens(existing);
  console.log('[APNs] registered token env=' + environment + ' bundle=' + bundleId + ' suffix=' + rawToken.slice(-10) + ' total=' + existing.length);
  return { ok: true, count: existing.length, environment, bundleId };
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function derToJose(signature) {
  const buf = Buffer.from(signature);
  let offset = 0;
  if (buf[offset++] !== 0x30) throw new Error('APNs JWT signature is not DER sequence');
  let seqLen = buf[offset++];
  if (seqLen & 0x80) {
    const bytes = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < bytes; i++) seqLen = (seqLen << 8) | buf[offset++];
  }
  const readInt = () => {
    if (buf[offset++] !== 0x02) throw new Error('APNs JWT signature integer missing');
    let len = buf[offset++];
    let value = buf.subarray(offset, offset + len);
    offset += len;
    while (value.length > 0 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) value = value.subarray(value.length - 32);
    if (value.length < 32) value = Buffer.concat([Buffer.alloc(32 - value.length), value]);
    return value;
  };
  return base64url(Buffer.concat([readInt(), readInt()]));
}

function apnsConfigFor(envOverride) {
  const keyId = process.env.NOTED_APNS_KEY_ID || process.env.APNS_KEY_ID || '';
  const teamId = process.env.NOTED_APNS_TEAM_ID || process.env.APNS_TEAM_ID || '';
  const keyPath = process.env.NOTED_APNS_KEY_PATH || process.env.APNS_KEY_PATH || '';
  const inlineKey = process.env.NOTED_APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY || '';
  let privateKey = inlineKey ? inlineKey.replace(/\\n/g, '\n') : '';
  let keyReadError = '';
  if (!privateKey && keyPath) {
    try {
      privateKey = fs.readFileSync(path.resolve(keyPath), 'utf-8');
    } catch (e) {
      keyReadError = e?.message || String(e);
    }
  }
  const forcedEnv = process.env.NOTED_APNS_ENV || process.env.APNS_ENV || '';
  const environment = forcedEnv === 'production' || forcedEnv === 'development'
    ? forcedEnv
    : (envOverride === 'production' ? 'production' : 'development');
  if (!keyId || !teamId || !privateKey) {
    return { configured: false, missing: ['KEY_ID', 'TEAM_ID', 'PRIVATE_KEY'].filter((name) => {
      if (name === 'KEY_ID') return !keyId;
      if (name === 'TEAM_ID') return !teamId;
      return !privateKey;
    }), error: keyReadError };
  }
  return { configured: true, keyId, teamId, privateKey, environment };
}

function apnsJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = config.keyId + ':' + config.teamId;
  if (apnsJwtCache && apnsJwtCache.cacheKey === cacheKey && now - apnsJwtCache.issuedAt < 45 * 60) {
    return apnsJwtCache.jwt;
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: now }));
  const signingInput = header + '.' + claims;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), crypto.createPrivateKey(config.privateKey));
  const jwt = signingInput + '.' + derToJose(signature);
  apnsJwtCache = { cacheKey, issuedAt: now, jwt };
  return jwt;
}

function sendApnsNotification(tokenRecord, payload) {
  return new Promise((resolve) => {
    const config = apnsConfigFor(tokenRecord.environment);
    if (!config.configured) {
      console.warn('[APNs] skip not configured missing=' + config.missing.join(',') + ' token=' + String(tokenRecord.token || '').slice(-10) + (config.error ? ' error=' + config.error : ''));
      resolve({ ok: false, skipped: true, reason: 'not_configured', error: config.error || undefined });
      return;
    }
    let jwt = '';
    try {
      jwt = apnsJwt(config);
    } catch (e) {
      resolve({ ok: false, error: 'jwt: ' + (e?.message || String(e)) });
      return;
    }
    const host = config.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const bundleId = tokenRecord.bundleId || process.env.NOTED_APNS_BUNDLE_ID || 'com.habittracker.swift';
    const client = http2.connect(host);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      resolve(result);
    };
    client.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + tokenRecord.token,
      authorization: 'bearer ' + jwt,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
    });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = Number(headers[':status'] || 0); });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => finish({ ok: status >= 200 && status < 300, status, body }));
    req.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
    req.end(JSON.stringify(payload));
  });
}

async function sendTabCompletionPush(detail = {}) {
  const projectId = String(detail.projectId || '').trim();
  const tabId = String(detail.tabId || '').trim();
  if (!projectId || !tabId) return { ok: false, error: 'projectId/tabId required' };
  const tokens = readIosPushTokens();
  if (tokens.length === 0) {
    console.log('[APNs] no registered iOS tokens for tab notification tab=' + tabId.slice(-10));
    return { ok: true, sent: 0, total: 0 };
  }
  const firedAt = Number(detail.firedAt) || Date.now();
  const tabName = String(detail.tabName || 'Terminal').slice(0, 160);
  const mode = detail.persistent === true ? 'persistent' : 'oneshot';
  const payload = {
    aps: {
      alert: { title: 'Terminal', body: tabName },
      sound: 'default',
      'content-available': 1,
    },
    kind: 'terminal-completion',
    projectId,
    tabId,
    tabName,
    firedAt,
    mode,
  };
  console.log('[APNs] send terminal completion project=' + projectId.slice(-10) + ' tab=' + tabId.slice(-10) + ' tokens=' + tokens.length + ' mode=' + mode);
  const results = [];
  for (const tokenRecord of tokens) {
    // Sequential sends keep logs readable and avoid opening a burst of HTTP/2 sessions.
    // Expected device count is tiny for this personal companion app.
    // eslint-disable-next-line no-await-in-loop
    const result = await sendApnsNotification(tokenRecord, payload);
    results.push({ token: String(tokenRecord.token || ''), tokenSuffix: String(tokenRecord.token || '').slice(-10), env: tokenRecord.environment, ...result });
    console.log('[APNs] result token=' + String(tokenRecord.token || '').slice(-10) + ' env=' + tokenRecord.environment + ' ok=' + !!result.ok + ' status=' + (result.status || '-') + ' reason=' + (result.reason || result.body || result.error || '-'));
  }
  const invalidReasons = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
  const invalid = new Set(results.filter((r) => {
    if (!r.body) return false;
    try { return invalidReasons.has(JSON.parse(r.body).reason); } catch { return false; }
  }).map((r) => r.token));
  if (invalid.size > 0) {
    const kept = tokens.filter((item) => !invalid.has(String(item.token || '')));
    writeIosPushTokens(kept);
    console.warn('[APNs] removed invalid tokens count=' + invalid.size + ' remaining=' + kept.length);
  }
  return { ok: true, sent: results.filter((r) => r.ok).length, total: tokens.length, results };
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

function sendTerminalBridgeError(res, error) {
  const message = String(error?.message || error || 'unknown error');
  const missingPrefix = 'working_directory_missing:';
  const missingIndex = message.indexOf(missingPrefix);
  if (missingIndex !== -1) {
    const cwd = message.slice(missingIndex + missingPrefix.length).trim();
    return sendJson(res, 409, {
      ok: false,
      error: 'working_directory_missing',
      message: 'Project folder does not exist' + (cwd ? ': ' + cwd : ''),
      cwd: cwd || null,
    });
  }
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('launch_not_accepted') || lowerMessage.includes('start failed')) {
    return sendJson(res, 409, {
      ok: false,
      success: false,
      error: lowerMessage.includes('codex') ? 'codex_launch_not_accepted' : 'agent_launch_not_accepted',
      message,
    });
  }
  return sendJson(res, 500, { ok: false, error: message });
}

function isSendFailure(data) {
  return data && (data.success === false || data.ok === false);
}

function sendSendFailure(res, data, extra = {}) {
  const code = data && typeof data.code === 'string' ? data.code : 'send_failed';
  return sendJson(res, 409, {
    ok: false,
    success: false,
    code,
    error: (data && (data.error || data.message)) || 'send failed',
    ...extra,
    ...(data || {}),
  });
}

async function runAgentSendScenario({
  tabId,
  prompt,
  model,
  effort,
  thinking,
  cwd,
  handoffId,
  source,
  statusAtSend,
  queue,
  ownership,
  timeoutMs = 60_000,
}) {
  return await bridgeRequest('sendAgentPromptScenario', {
    tabId,
    prompt,
    model,
    effort,
    thinking,
    cwd,
    handoffId,
    source,
    statusAtSend,
    queue: queue === true,
    // Project/History/iOS controls the terminal tab directly: leave a found
    // terminal draft untouched and report conflict. External Inbox owns its
    // own chat composer: atomically pull terminal draft out for caller rollback.
    returnDraftOnConflict: ownership === 'external',
  }, timeoutMs);
}

async function runAgentStopScenario(tabId, timeoutMs = 5000) {
  return await bridgeRequest('stopAgentProcessScenario', { tabId }, timeoutMs);
}

async function runAgentInterruptScenario(tabId, timeoutMs = 2000) {
  return await bridgeRequest('interruptAgentTurnScenario', { tabId }, timeoutMs);
}

async function runAgentGrabDraftScenario(tabId, timeoutMs = 5000) {
  return await bridgeRequest('grabAgentDraftScenario', { tabId }, timeoutMs);
}

async function runAgentInspectDraftScenario(tabId, timeoutMs = 5000) {
  return await bridgeRequest('inspectAgentDraftScenario', { tabId }, timeoutMs);
}

async function runAgentRewindScenario(tabId, payload, timeoutMs) {
  return await bridgeRequest('rewindAgentTimelineScenario', { tabId, ...payload }, timeoutMs);
}

async function runAgentAnswerQuestionScenario(payload) {
  if (!answerClaudeQuestion) {
    return { success: false, error: 'answer handler not wired' };
  }
  return await answerClaudeQuestion(payload);
}

function getAgentPendingQuestionScenario(tabId) {
  return getClaudePendingQuestion ? getClaudePendingQuestion(tabId) : null;
}

function promptFingerprint(prompt) {
  const normalized = String(prompt || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function findOrchestrationTabDescriptor(tabId) {
  if (!tabId) return null;
  try {
    const projectManager = require('./project-manager');
    for (const project of projectManager.db.getAllProjects()) {
      const tab = (project.tabs || []).find((item) => item.tabId === tabId);
      if (!tab) continue;
      const toolType = tab.commandType === 'codex'
        ? 'codex'
        : tab.commandType === 'claude' || tab.tabType === 'claude-sdk'
          ? 'claude'
          : null;
      return {
        tabId,
        tabName: tab.name || tabId.slice(-12),
        projectId: project.id,
        projectName: project.name || path.basename(project.path || '') || project.id,
        projectPath: project.path || tab.cwd || null,
        cwd: tab.cwd || project.path || null,
        toolType,
        commandType: tab.commandType || null,
      };
    }
  } catch (error) {
    console.warn('[Orchestration] tab lookup failed tab=' + shortId(tabId, 12) + ' error=' + (error?.message || error));
  }
  return null;
}

function orchestrationUrls(run) {
  const runId = encodeURIComponent(run.runId);
  return {
    statusUrl: '/api/orchestrations/' + runId,
    resultUrl: '/api/orchestrations/' + runId + '/result',
    cancelUrl: '/api/orchestrations/' + runId + '/cancel',
    eventsUrl: '/api/events?tabId=' + encodeURIComponent(run.sourceTabId),
  };
}

function withOrchestrationUrls(run) {
  return run ? { ...run, ...orchestrationUrls(run) } : null;
}

function emitOrchestrationRun(run, reason = 'changed') {
  if (!run) return;
  const payload = { type: 'orchestration-update', reason, run: withOrchestrationUrls(run) };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('orchestration:changed', payload);
  }
  const tabIds = new Set([run.sourceTabId, run.targetTabId].filter(Boolean));
  for (const tabId of tabIds) webBroadcast(tabId, payload);
}

async function probeOrchestrationResult(run, { maxChars = 100_000, sessionInfo = null } = {}) {
  if (!run || typeof getAgentTurnResult !== 'function') {
    return { found: false, resultAvailable: false, error: 'result reader unavailable' };
  }
  const info = sessionInfo || await resolveAgentSessionInfo(run.targetTabId, 2000).catch(() => null);
  const sessionId = info?.sessionId || run.sessionId || null;
  const cwd = info?.cwd || run.targetCwd || run.targetProjectPath || null;
  if (!sessionId) return { found: false, resultAvailable: false, sessionId: null };
  try {
    const result = await getAgentTurnResult({
      sessionId,
      cwd,
      promptHash: run.promptHash,
      requestedAt: run.createdAt,
      maxChars,
    });
    return {
      ...(result || {}),
      found: result?.found === true,
      resultAvailable: typeof result?.assistantText === 'string' && result.assistantText.length > 0,
      sessionId,
    };
  } catch (error) {
    return { found: false, resultAvailable: false, sessionId, error: String(error?.message || error) };
  }
}

async function sendOrchestrationCompletionNotification(run) {
  const store = getOrchestrationRunStore();
  const current = await store.getInternal(run.runId);
  if (!current || current.notifySource === false || current.notificationStatus === 'sent' || current.notificationStatus === 'queued') return;
  if (!current.sourceTabId || current.sourceTabId === current.targetTabId) return;
  await store.patch(current.runId, { notificationStatus: 'sending', notificationAttemptedAt: Date.now() });
  emitOrchestrationRun(await store.get(current.runId), 'notification-sending');
  try {
    const status = await resolveAgentSessionInfo(current.sourceTabId, 2000);
    const baseUrl = 'http://127.0.0.1:' + resolvedPort;
    const message = [
      '[Оркестрация] Запрос завершён.',
      'runId: ' + current.runId,
      'Исполнитель: ' + (current.targetTabName || current.targetTabId) + ' (' + (current.targetToolType || 'agent') + ').',
      'Результат не вставлен в сообщение. Получи его одним запросом:',
      'curl -sS -H "Authorization: Bearer $(cat ~/.noted-terminal/web-token.txt)" "' + baseUrl + '/api/orchestrations/' + encodeURIComponent(current.runId) + '/result"',
      'Не используй Overseer и не опрашивай статус повторно. После GET продолжи исходную задачу.',
    ].join('\n');
    const result = await runAgentSendScenario({
      tabId: current.sourceTabId,
      prompt: message,
      handoffId: 'orchestration-complete:' + current.runId,
      source: 'orchestration-completion',
      statusAtSend: status?.status || status?.sessionStatus || 'unknown',
      queue: true,
      ownership: 'project',
      timeoutMs: 60_000,
    });
    if (isSendFailure(result)) {
      await store.patch(current.runId, {
        notificationStatus: result?.code === 'terminal_draft_conflict' ? 'draft-conflict' : 'failed',
        notificationError: result?.error || result?.message || 'notification send failed',
      });
    } else {
      await store.patch(current.runId, {
        notificationStatus: result?.queued ? 'queued' : 'sent',
        notificationDeliveredAt: Date.now(),
        notificationError: null,
      });
    }
  } catch (error) {
    await store.patch(current.runId, {
      notificationStatus: 'failed',
      notificationError: String(error?.message || error),
    });
  }
  emitOrchestrationRun(await store.get(current.runId), 'notification-finished');
}

async function finalizeCompletedOrchestration(run, reason = 'completed') {
  if (!run || orchestrationCompletionInflight.has(run.runId)) return;
  orchestrationCompletionInflight.add(run.runId);
  try {
    const store = getOrchestrationRunStore();
    const probe = await probeOrchestrationResult(await store.getInternal(run.runId));
    await store.patch(run.runId, {
      resultAvailable: probe.resultAvailable === true,
      resultTurnIndex: Number.isInteger(probe.turnIndex) ? probe.turnIndex : null,
      resultUserUuid: probe.userUuid || null,
      resultError: probe.found ? null : (probe.error || 'matching turn not found'),
      sessionId: probe.sessionId || run.sessionId || null,
    });
    emitOrchestrationRun(await store.get(run.runId), reason);
    await sendOrchestrationCompletionNotification(await store.get(run.runId));
  } finally {
    orchestrationCompletionInflight.delete(run.runId);
  }
}

async function processOrchestrationLifecycle(tabId, payload) {
  if (!tabId || (payload?.type !== 'busy' && payload?.type !== 'done')) return;
  try {
    const store = getOrchestrationRunStore();
    const result = await store.applyLifecycle(tabId, payload);
    for (const run of result.changed) emitOrchestrationRun(run, 'target-lifecycle');
    for (const run of result.completed) await finalizeCompletedOrchestration(run, 'target-completed');
  } catch (error) {
    console.warn('[Orchestration] lifecycle failed tab=' + shortId(tabId, 12) + ' error=' + (error?.message || error));
  }
}

async function reconcileOrchestrationRun(runId, reason = 'reconcile') {
  const store = getOrchestrationRunStore();
  const run = await store.getInternal(runId);
  if (!run || !isActiveStatus(run.status)) return store.get(runId);
  const sessionInfo = await resolveAgentSessionInfo(run.targetTabId, 2000).catch(() => null);
  const status = sessionInfo?.status || sessionInfo?.sessionStatus || 'unknown';
  const probe = await probeOrchestrationResult(run, { sessionInfo });
  const reconciled = await store.reconcile(runId, {
    busy: status === 'busy',
    sessionId: probe.sessionId || sessionInfo?.sessionId || run.sessionId || null,
    resultFound: probe.found === true,
    resultAvailable: probe.resultAvailable === true,
    turnIndex: probe.turnIndex,
  });
  if (reconciled.changed) emitOrchestrationRun(reconciled.changed, reason);
  if (reconciled.completed) await finalizeCompletedOrchestration(reconciled.changed, 'recovered-completion');
  return store.get(runId);
}

async function reconcileActiveOrchestrations() {
  const store = getOrchestrationRunStore();
  const active = await store.listActive();
  for (const run of active) {
    await reconcileOrchestrationRun(run.runId, 'startup-reconcile');
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
      const rawKind = String(entry.kind || entry.type || entry.role || 'entry');
      const compactSummary = entry.compactSummary || fullEntry.compactSummary || '';
      const isCompact = rawKind === 'compact' || entry.isCompactSummary === true || fullEntry.isCompactSummary === true;
      if (isCompact) {
        const full = compactSummary || entry.full || fullEntry.full || entry.preview || fullEntry.content || 'Conversation compacted';
        const preview = mobileTimelinePreview(entry.preview || full || 'Conversation compacted');
        return {
          uuid: entry.uuid,
          kind: 'compact',
          color: entry.color || '#cba6f7',
          preview: preview || 'Conversation compacted',
          full: full || undefined,
          ts: mobileTimelineTs(entry.ts || entry.timestamp || fullEntry.ts || fullEntry.timestamp),
          preTokens: entry.preTokens || fullEntry.preTokens || undefined,
          truncated: entry.truncated || undefined,
          tools: entry.tools || undefined,
        };
      }
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
  const replayExternalRunTerminalEvent = () => {
    const runId = externalRunByTabId.get(tabId);
    if (!runId) return;
    const run = externalRuns.get(runId);
    if (!run) return;
    if (run.status === 'done') {
      sink.send(JSON.stringify({
        type: 'done',
        tabId,
        runId,
        sessionId: run.sessionId || null,
        reason: 'snapshot-replay',
        completedAt: run.completedAt || null,
      }));
    } else if (run.status === 'send_failed' || run.status === 'start_timeout') {
      sink.send(JSON.stringify({
        type: 'error',
        tabId,
        runId,
        error: run.error || run.status,
      }));
    }
  };
  const replayOrchestrationRuns = async () => {
    const runs = await getOrchestrationRunStore().listForTab(tabId);
    sink.send(JSON.stringify({
      type: 'orchestration-snapshot',
      tabId,
      runs: runs.map(withOrchestrationUrls),
    }));
  };
  if (session) {
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: session.sessionId || null,
      busy: true,
      sessionStatus: 'busy',
      starting: false,
      stopping: false,
      inputReady: true,
      commandType: 'claude-sdk',
      toolType: 'claude',
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
    return;
  }
  try {
    // Resolve through the DB-aware helper so a renderer that has not hydrated
    // this tab cannot answer a live Codex process with a fabricated inactive
    // state. Codex is overlaid with main's process/writer snapshot below.
    const status = await resolveAgentSessionInfo(tabId, 1500);
    const sessionStatus = status?.status || status?.sessionStatus || 'unknown';
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: status?.sessionId || null,
      busy: sessionStatus === 'busy',
      sessionStatus,
      starting: sessionStatus === 'starting',
      stopping: sessionStatus === 'stopping',
      commandType: status?.commandType || null,
      toolType: status?.toolType || null,
      inputReady: status?.inputReady === true,
      conversationMaterialized: status?.conversationMaterialized === true,
      canResume: status?.canResume === true,
      canCopySessionId: status?.canCopySessionId === true,
      timelineCount: typeof status?.timelineCount === 'number' ? status.timelineCount : null,
      materializationReason: status?.materializationReason || null,
      startupDefaultsPending: status?.startupDefaultsPending === true,
      startupDefaultsReady: status?.startupDefaultsReady === true,
      startupDefaultsError: status?.startupDefaultsError || null,
      lastNotReady: status?.lastNotReady || null,
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
  } catch {
    sink.send(JSON.stringify({
      type: 'snapshot',
      tabId,
      sessionId: null,
      busy: false,
      sessionStatus: 'unknown',
      starting: false,
      stopping: false,
      inputReady: false,
      commandType: null,
      toolType: null,
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    }));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
  }
}

function projectActivitySnapshot(reason = 'snapshot') {
  if (!computeProjectActivity) {
    return { type: 'project-activity', projects: [], ts: Date.now(), reason, unavailable: true };
  }
  try {
    const snap = computeProjectActivity() || {};
    return {
      type: 'project-activity',
      projects: Array.isArray(snap.projects) ? snap.projects : [],
      layoutChangedProjectIds: Array.isArray(snap.layoutChangedProjectIds) ? snap.layoutChangedProjectIds : [],
      projectOrderChanged: snap.projectOrderChanged === true,
      ts: snap.ts || Date.now(),
      reason,
    };
  } catch (e) {
    console.warn('[ProjectActivity] snapshot failed:', e?.message || e);
    return { type: 'project-activity', projects: [], ts: Date.now(), reason, error: String(e?.message || e) };
  }
}

function sendProjectActivitySnapshot(sink, reason = 'connect') {
  const payload = projectActivitySnapshot(reason);
  sink.send(JSON.stringify(payload));
  return payload;
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
    const label = bridgePayloadLabel(payload);
    if (!win || win.isDestroyed()) {
      console.log('[BridgeDiag] NO_WINDOW action=' + action + label + ' wins=' + wins.length);
      const error = new Error('No window');
      error.code = 'bridge_unavailable';
      return reject(error);
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingBridge.delete(requestId);
      console.log('[BridgeDiag] TIMEOUT action=' + action + label + ' rid=' + requestId + ' afterMs=' + timeoutMs);
      const error = new Error('Bridge timeout: ' + action);
      error.code = 'bridge_timeout';
      reject(error);
    }, timeoutMs);
    pendingBridge.set(requestId, { resolve, reject, timer, action, label, sentAt: Date.now() });
    console.log('[BridgeDiag] SEND action=' + action + label + ' rid=' + requestId + ' wins=' + wins.length);
    win.webContents.send('web:bridge-request', { requestId, action, payload });
  });
}

async function resolveAgentSessionInfo(tabId, timeoutMs = 1500) {
  let info = null;
  try {
    info = await bridgeRequest('getTabSessionInfo', { tabId }, timeoutMs);
  } catch {}
  const overlayMainCodexRuntime = async (base = {}, historicalSessionId = null) => {
    let runtime = null;
    try {
      runtime = typeof resolveCodexRuntimeSessionInfo === 'function'
        ? await resolveCodexRuntimeSessionInfo(tabId, 'web-resolve-agent-session')
        : null;
    } catch {}
    const sessionStatus = runtime?.sessionStatus || 'unknown';
    const sessionId = runtime?.sessionId || null;
    return {
      ...base,
      tabId,
      toolType: 'codex',
      commandType: 'codex',
      status: sessionStatus,
      sessionStatus,
      sessionId,
      codexSessionId: sessionId,
      savedSessionId: runtime?.savedSessionId || historicalSessionId || base?.savedSessionId || null,
      liveLifecycle: runtime ? (runtime.liveLifecycle ?? null) : null,
      inputReady: runtime?.inputReady === true,
      writerConfirmed: runtime?.writerConfirmed === true,
      writerUsableForMutation: runtime?.writerUsableForMutation === true,
      canCopySessionId: runtime?.canCopySessionId === true,
      canResume: sessionStatus === 'inactive' && !!sessionId,
    };
  };

  // Renderer owns UI-only fields, but main owns Codex process/writer truth.
  // Even a non-null renderer answer can be stale across hydration or a process
  // transition, so every Codex result is overlaid with one main snapshot.
  if (info?.toolType === 'codex') {
    return await overlayMainCodexRuntime(info, info?.savedSessionId || null);
  }
  if (info?.toolType) return info;

  try {
    const projectManager = require('./project-manager');
    for (const p of projectManager.db.getAllProjects()) {
      const t = (p.tabs || []).find(x => x.tabId === tabId);
      if (!t) continue;
      const isCodex = t.commandType === 'codex' && (t.tabType || 'terminal') !== 'claude-sdk';
      const isClaude = t.commandType === 'claude' && (t.tabType || 'terminal') !== 'claude-sdk';
      const toolType = isCodex ? 'codex' : isClaude ? 'claude' : null;
      if (isCodex) {
        return await overlayMainCodexRuntime({
          tabId,
          toolType: 'codex',
          commandType: t.commandType || 'codex',
          claudeSessionId: null,
          savedSessionId: t.codexSessionId || null,
          geminiSessionId: t.geminiSessionId || null,
          cwd: t.cwd || null,
        }, t.codexSessionId || null);
      }
      const sessionId = isClaude ? (t.claudeSessionId || null) : null;
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
    console.log('[BridgeDiag] REPLY action=' + pending.action + (pending.label || '') + ' rid=' + requestId + ' ok=' + ok + ' elapsedMs=' + elapsed + ' err=' + (error || '-'));
    clearTimeout(pending.timer);
    pendingBridge.delete(requestId);
    if (ok) {
      pending.resolve(data);
    } else {
      const bridgeError = new Error(error || 'Bridge failed');
      bridgeError.code = 'bridge_failed';
      bridgeError.bridgeData = data;
      pending.reject(bridgeError);
    }
  });
}

// Project/tab IDs могут содержать `=` (base64 от пути), пробелы, кириллицу —
// всё это URL-кодируется на клиенте как %3D, %20, %D0%9F и т.п.
// Без decodeURIComponent любой projectId оканчивающийся на `=` (например
// uav → `...dWF2%3D`) превращается в строку которой нет в БД → 404.
function decId(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

let activeLoadersLogSignature = null;
function logActiveLoadersSnapshot(snapshot, status = 200, error = null) {
  const loaders = Array.isArray(snapshot?.loaders) ? snapshot.loaders : [];
  const kinds = loaders.reduce((acc, loader) => {
    const key = loader?.kind || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const signature = JSON.stringify({
    status,
    idle: snapshot?.idle === true,
    count: Number(snapshot?.count || loaders.length || 0),
    kinds,
    error: error || null,
  });
  if (signature === activeLoadersLogSignature) return;
  activeLoadersLogSignature = signature;
  const tabs = loaders.slice(0, 8).map((loader) =>
    String(loader?.tabId || '').slice(-12) + ':' + (loader?.kind || '-') + ':' + (loader?.status || '-')
  ).join(',');
  console.log('[ActiveLoaders] status=' + status +
    ' idle=' + (snapshot?.idle === true) +
    ' count=' + Number(snapshot?.count || loaders.length || 0) +
    ' kinds=' + JSON.stringify(kinds) +
    ' tabs=' + (tabs || '-') +
    (error ? ' error=' + error : ''));
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

  if (parsed.pathname === '/api/ios/push-token' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const result = registerIosPushToken(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (parsed.pathname === '/api/ios/push-status' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const tokens = readIosPushTokens();
    const config = apnsConfigFor();
    return sendJson(res, 200, {
      ok: true,
      configured: config.configured === true,
      missing: config.configured ? [] : config.missing,
      error: config.error || null,
      tokenCount: tokens.length,
      tokens: tokens.map((item) => ({
        environment: item.environment,
        bundleId: item.bundleId,
        deviceName: item.deviceName,
        tokenSuffix: String(item.token || '').slice(-10),
        lastSeenAt: item.lastSeenAt,
      })),
    });
  }

  // Active-loaders snapshot — every tab across every project that is still
  // "working" (AI turn/loader, SDK streaming, Gemini busy, or a Restart-after
  // owned non-AI shell process). Manual shell commands are not install blockers.
  // AI CLI liveness by itself is not a loader: idle Claude/Codex tabs are
  // allowed to be closed by build:install. Computed in main against the live
  // Maps that already drive the UI loader — no separate busy notion.
  // See computeActiveLoaders() in main.js.
  if (parsed.pathname === '/api/active-loaders' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!computeActiveLoaders) {
      // Fail SAFE: if the injection is missing we must NOT report idle — that
      // would green-light a rebuild mid-work. Signal the poller to keep waiting.
      logActiveLoadersSnapshot({ idle: false, count: 0, loaders: [] }, 503, 'unavailable');
      return sendJson(res, 503, { error: 'active-loaders unavailable', idle: false });
    }
    try {
      const snapshot = computeActiveLoaders();
      logActiveLoadersSnapshot(snapshot, 200);
      return sendJson(res, 200, snapshot);
    } catch (e) {
      logActiveLoadersSnapshot({ idle: false, count: 0, loaders: [] }, 500, String(e.message || e));
      return sendJson(res, 500, { error: String(e.message), idle: false });
    }
  }

  // Project-level activity snapshot for native iOS project badges. This is a
  // small aggregate, not a tab list refresh: count = live agent tabs in project,
  // streaming = at least one child tab currently has its loader on. The matching
  // SSE scope sends the same full snapshot so dropped events self-heal.
  if (parsed.pathname === '/api/project-activity' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!computeProjectActivity) {
      return sendJson(res, 503, { error: 'project-activity unavailable', projects: [], ts: Date.now() });
    }
    try {
      return sendJson(res, 200, computeProjectActivity());
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message), projects: [], ts: Date.now() });
    }
  }

  // ───────── SSE live channel (WebSocket replacement) ─────────
  // EventSource over plain HTTP GET. Yandex/Chrome anti-tracker extensions
  // block ws:// to private IPs but NOT text/event-stream. Same subscriber
  // registry + webBroadcast() as WS, so main.js fan-out is transport-agnostic.
  // Auth via ?token= (EventSource can't set headers, same as WS handshake).
  if (parsed.pathname === '/api/events' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const scope = parsed.query.scope ? String(parsed.query.scope) : '';
    const isProjectActivity = scope === 'projects' || parsed.query.projectActivity === '1';
    const tabId = parsed.query.tabId ? decId(String(parsed.query.tabId)) : null;
    if (!tabId && !isProjectActivity) return sendJson(res, 400, { error: 'tabId required' });
    const topic = isProjectActivity ? PROJECT_ACTIVITY_TOPIC : tabId;

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
          console.warn('[WebSSE:WriteError] tab=' + shortId(topic, 12) + ' sent=' + sink.sent + ' err=' + (e?.message || e));
        }
      },
      isAlive: () => !res.writableEnded && !res.destroyed,
      close: () => { try { res.end(); } catch {} },
    };
    subscribe(topic, sink);
    console.log('[WebSSE:Open] tab=' + shortId(topic, 12) + ' scope=' + (isProjectActivity ? 'projects' : 'tab') + ' from=' + (req.socket.remoteAddress || '?'));

    if (isProjectActivity) {
      // Full summary snapshot on connect; the client treats later events as
      // replacement snapshots, not deltas.
      try { sendProjectActivitySnapshot(sink, 'connect'); } catch {}
    } else {
      // Initial snapshot — mirror the WS upgrade path so the client renders
      // immediately without waiting for the next broadcast.
      sendInitialSnapshot(tabId, sink, sdkSessions).catch(() => {});
      startClaudeTabWatcher(tabId).catch(() => {});
      startTranscriptSubscriptionForTab(tabId).catch(() => {});
    }

    // Heartbeat: SSE connections die silently behind some proxies/radios.
    // A comment line every 25s keeps the socket warm and lets the client's
    // onerror fire promptly if the pipe is actually dead.
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 25000);

    const cleanup = () => {
      clearInterval(hb);
      unsubscribeAll(sink);
      if (!isProjectActivity) releaseClaudeWatchersIfOrphan();
      if (!isProjectActivity) releaseTranscriptSubscriptionsIfOrphan();
      console.log('[WebSSE:Close] tab=' + shortId(topic, 12) + ' scope=' + (isProjectActivity ? 'projects' : 'tab') + ' sent=' + sink.sent + ' errors=' + sink.errors);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return; // keep the response open
  }

  if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (parsed.pathname === '/api/mobile-attachments' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = await storeMobileAttachment(body);
      return sendJson(res, 200, {
        ok: true,
        attachment: {
          id: item.id,
          kind: item.kind,
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          path: item.path,
        },
      });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return sendJson(res, status, { ok: false, error: String(e?.message || e) });
    }
  }

  if (parsed.pathname === '/api/mobile-attachments/preview' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = await readMobileAttachmentPreview(body);
      return sendJson(res, 200, { ok: true, attachment: item });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return sendJson(res, status, { ok: false, error: String(e?.message || e) });
    }
  }

  let attachmentMatch = parsed.pathname.match(/^\/api\/mobile-attachments\/([^/]+)$/);
  if (attachmentMatch && req.method === 'DELETE') {
    try {
      await removeMobileAttachment(decId(attachmentMatch[1]));
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (parsed.pathname === '/api/app-settings' && req.method === 'GET') {
    try {
      const data = await bridgeRequest('getAppSettings', {}, 1500);
      return sendJson(res, 200, { streamerMode: !!data?.streamerMode });
    } catch (e) {
      return sendJson(res, 200, { streamerMode: false });
    }
  }

  if (parsed.pathname === '/api/app-settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setAppSettings', {
        streamerMode: typeof body.streamerMode === 'boolean' ? body.streamerMode : undefined,
      }, 1500);
      return sendJson(res, 200, { streamerMode: !!data?.streamerMode });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  const projectManager = require('./project-manager');

  if (parsed.pathname === '/api/orchestrations' && req.method === 'GET') {
    const tabId = parsed.query.tabId ? decId(String(parsed.query.tabId)) : null;
    const runs = tabId
      ? await getOrchestrationRunStore().listForTab(tabId, { activeOnly: parsed.query.active === '1' })
      : await getOrchestrationRunStore().listActive();
    return sendJson(res, 200, { ok: true, runs: runs.map(withOrchestrationUrls) });
  }

  if (parsed.pathname === '/api/orchestrations' && req.method === 'POST') {
    let createdRunId = null;
    try {
      const body = await readBody(req);
      const prompt = cleanOptionalString(body.prompt ?? body.text, '');
      const sourceTabId = cleanOptionalString(body.sourceTabId, '');
      let targetTabId = cleanOptionalString(body.targetTabId, '');
      const targetProjectId = cleanOptionalString(body.targetProjectId || body.projectId, '');
      const targetToolType = body.toolType === 'codex' || body.provider === 'codex' ? 'codex' : 'claude';
      const notifySource = body.notifySource !== false;
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt required' });
      if (!sourceTabId) return sendJson(res, 400, { ok: false, error: 'sourceTabId required' });
      if (!targetTabId && !targetProjectId) {
        return sendJson(res, 400, { ok: false, error: 'targetTabId or targetProjectId required' });
      }

      const requestedRunId = cleanOptionalString(body.runId, '') || crypto.randomUUID();
      const existing = await getOrchestrationRunStore().get(requestedRunId);
      if (existing) {
        return sendJson(res, 200, { ok: true, idempotent: true, run: withOrchestrationUrls(existing) });
      }

      const source = findOrchestrationTabDescriptor(sourceTabId);
      if (!source) return sendJson(res, 404, { ok: false, error: 'source tab not found' });
      if (notifySource && !source.toolType) {
        return sendJson(res, 409, { ok: false, error: 'source tab is not a Claude/Codex agent' });
      }

      let target = targetTabId ? findOrchestrationTabDescriptor(targetTabId) : null;
      let targetCreated = false;
      if (targetTabId && !target) return sendJson(res, 404, { ok: false, error: 'target tab not found' });
      if (!targetTabId) {
        const created = await bridgeRequest('createAgentTab', {
          projectId: targetProjectId,
          toolType: targetToolType,
          name: cleanOptionalString(body.name || body.targetName, ''),
          startNow: true,
          background: true,
          codexModel: cleanOptionalString(body.model || body.codexModel, ''),
          codexEffort: cleanOptionalString(body.effort || body.codexEffort, ''),
        }, 12_000);
        targetTabId = created?.tabId || '';
        if (!targetTabId) return sendJson(res, 500, { ok: false, error: 'failed to create target tab' });
        targetCreated = true;
        target = findOrchestrationTabDescriptor(targetTabId) || {
          tabId: targetTabId,
          tabName: created?.name || targetTabId.slice(-12),
          projectId: created?.projectId || targetProjectId,
          projectName: created?.projectName || path.basename(created?.cwd || '') || targetProjectId,
          projectPath: created?.projectPath || created?.cwd || null,
          cwd: created?.cwd || null,
          toolType: created?.toolType || targetToolType,
          commandType: created?.commandType || targetToolType,
        };
      }
      if (targetTabId === sourceTabId) {
        return sendJson(res, 409, { ok: false, error: 'source and target tabs must be different' });
      }
      if (!target?.toolType) {
        return sendJson(res, 409, { ok: false, error: 'target tab is not a Claude/Codex agent' });
      }

      const run = await getOrchestrationRunStore().create({
        runId: requestedRunId,
        status: targetCreated ? 'starting' : 'sending',
        label: cleanOptionalString(body.label, ''),
        sourceTabId,
        sourceTabName: source.tabName,
        sourceProjectId: source.projectId,
        sourceProjectName: source.projectName,
        sourceProjectPath: source.projectPath,
        targetTabId,
        targetTabName: target.tabName,
        targetProjectId: target.projectId,
        targetProjectName: target.projectName,
        targetProjectPath: target.projectPath,
        targetCwd: target.cwd,
        targetToolType: target.toolType,
        targetCreated,
        notifySource,
        promptHash: promptFingerprint(prompt),
        promptChars: prompt.length,
      });
      createdRunId = run.runId;
      emitOrchestrationRun(run, 'created');

      let targetStatus = null;
      if (targetCreated) {
        const startupTimeoutMs = Math.max(5_000, Math.min(60_000, Number(body.startupTimeoutMs) || 20_000));
        targetStatus = await waitForAgentReady(targetTabId, startupTimeoutMs);
      } else {
        targetStatus = await resolveAgentSessionInfo(targetTabId, 2000);
      }
      const baselineStatus = targetStatus?.status || targetStatus?.sessionStatus || 'unknown';
      await getOrchestrationRunStore().patch(run.runId, {
        status: 'sending',
        sessionId: targetStatus?.sessionId || null,
      });
      emitOrchestrationRun(await getOrchestrationRunStore().get(run.runId), 'sending');

      const sendResult = await runAgentSendScenario({
        tabId: targetTabId,
        prompt,
        model: cleanOptionalString(body.model, ''),
        effort: cleanOptionalString(body.effort, ''),
        thinking: cleanOptionalString(body.thinking, ''),
        cwd: target.cwd,
        handoffId: 'orchestration:' + run.runId,
        source: 'orchestration:' + sourceTabId,
        statusAtSend: baselineStatus,
        queue: body.queue !== false,
        ownership: 'project',
        timeoutMs: 60_000,
      });
      if (isSendFailure(sendResult)) {
        const failed = await getOrchestrationRunStore().patch(run.runId, {
          status: 'failed',
          completedAt: Date.now(),
          completionReason: 'send-failed',
          error: sendResult?.error || sendResult?.message || 'send failed',
        });
        emitOrchestrationRun(failed, 'send-failed');
        return sendSendFailure(res, sendResult, { runId: run.runId, targetTabId });
      }

      const accepted = await getOrchestrationRunStore().markDelivery(run.runId, {
        queued: sendResult?.queued === true,
        baselineBusy: baselineStatus === 'busy',
        sessionId: sendResult?.sessionId || targetStatus?.sessionId || null,
      });
      emitOrchestrationRun(accepted, 'delivery-accepted');
      // The provider may emit task_started while the send scenario is still
      // auditing delivery. Reconcile once after acceptance so that event is not
      // lost; subsequent progress remains fully event-driven.
      const reconciled = await reconcileOrchestrationRun(run.runId, 'delivery-reconcile');
      return sendJson(res, 202, {
        ok: true,
        accepted: true,
        run: withOrchestrationUrls(reconciled || accepted),
      });
    } catch (error) {
      if (createdRunId) {
        const failed = await getOrchestrationRunStore().patch(createdRunId, {
          status: 'failed',
          completedAt: Date.now(),
          completionReason: 'orchestration-error',
          error: String(error?.message || error),
        });
        emitOrchestrationRun(failed, 'orchestration-error');
      }
      return sendJson(res, Number(error?.statusCode) || 500, { ok: false, runId: createdRunId, error: String(error?.message || error) });
    }
  }

  const orchestrationResultMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/result$/);
  if (orchestrationResultMatch && req.method === 'GET') {
    const runId = decId(orchestrationResultMatch[1]);
    const run = await reconcileOrchestrationRun(runId, 'result-read');
    if (!run) return sendJson(res, 404, { ok: false, error: 'run not found' });
    if (isActiveStatus(run.status)) {
      return sendJson(res, 202, { ok: true, ready: false, status: run.status, run: withOrchestrationUrls(run) });
    }
    if (run.status !== 'completed') {
      return sendJson(res, 409, { ok: false, ready: false, status: run.status, error: run.error || 'run did not complete' });
    }
    const internal = await getOrchestrationRunStore().getInternal(runId);
    const result = await probeOrchestrationResult(internal, {
      maxChars: Math.max(500, Math.min(250_000, Number(parsed.query.maxChars) || 100_000)),
    });
    if (!result.found) {
      return sendJson(res, 202, {
        ok: true,
        ready: false,
        status: run.status,
        error: result.error || 'matching transcript turn not materialized',
        run: withOrchestrationUrls(run),
      });
    }
    return sendJson(res, 200, {
      ok: true,
      ready: true,
      runId,
      status: run.status,
      sessionId: result.sessionId || run.sessionId || null,
      turnIndex: result.turnIndex ?? run.resultTurnIndex ?? null,
      userUuid: result.userUuid || run.resultUserUuid || null,
      assistantText: result.assistantText || '',
      assistantChars: Number(result.assistantChars) || (result.assistantText || '').length,
      truncated: result.truncated === true,
    });
  }

  const orchestrationCancelMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/cancel$/);
  if (orchestrationCancelMatch && req.method === 'POST') {
    const runId = decId(orchestrationCancelMatch[1]);
    const current = await getOrchestrationRunStore().get(runId);
    if (!current) return sendJson(res, 404, { ok: false, error: 'run not found' });
    const body = await readBody(req);
    const cancelled = await getOrchestrationRunStore().patch(runId, {
      status: 'cancelled',
      completedAt: Date.now(),
      completionReason: 'cancelled-by-api',
      error: null,
    });
    emitOrchestrationRun(cancelled, 'cancelled');
    let interrupt = null;
    if (body.interrupt === true) {
      interrupt = await runAgentInterruptScenario(current.targetTabId, 5000).catch((error) => ({ success: false, error: String(error?.message || error) }));
    }
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(cancelled), interrupt });
  }

  const orchestrationAckMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/ack$/);
  if (orchestrationAckMatch && req.method === 'POST') {
    const runId = decId(orchestrationAckMatch[1]);
    const body = await readBody(req);
    const tabId = cleanOptionalString(body.tabId, '');
    if (!tabId) return sendJson(res, 400, { ok: false, error: 'tabId required' });
    const acknowledged = await getOrchestrationRunStore().acknowledge(runId, tabId);
    if (!acknowledged) return sendJson(res, 404, { ok: false, error: 'run not found' });
    emitOrchestrationRun(acknowledged, 'acknowledged');
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(acknowledged) });
  }

  const orchestrationStatusMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)$/);
  if (orchestrationStatusMatch && req.method === 'GET') {
    const runId = decId(orchestrationStatusMatch[1]);
    const run = await getOrchestrationRunStore().get(runId);
    if (!run) return sendJson(res, 404, { ok: false, error: 'run not found' });
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(run) });
  }

  if (parsed.pathname === '/api/inbox' && req.method === 'GET') {
    const inbox = projectManager.db.getProjectById(INBOX_PROJECT_ID);
    if (!inbox) return sendJson(res, 500, { error: 'inbox project missing' });
    return sendJson(res, 200, {
      project: {
        id: inbox.id,
        name: inbox.name,
        path: inbox.path,
        icon: inbox.icon || null,
        isSystem: true,
        systemType: 'inbox',
        tabCount: (inbox.tabs || []).length,
      },
    });
  }

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
    let completionNotificationCounts = {};
    try {
      const data = await bridgeRequest('getOpenProjectIds', {}, 1500);
      if (Array.isArray(data?.ids)) {
        openProjectIds = data.ids;
        openIds = new Set(data.ids);
      }
      activeProjectId = data?.activeProjectId || null;
      if (Array.isArray(data?.awaitingIds)) awaitingIds = new Set(data.awaitingIds);
      if (data?.completionNotificationCounts && typeof data.completionNotificationCounts === 'object') {
        completionNotificationCounts = data.completionNotificationCounts;
      }
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
        completionNotificationCount: Number(completionNotificationCounts[p.id]) || 0,
        isSystem: isInboxProjectId(p.id),
        systemType: isInboxProjectId(p.id) ? 'inbox' : null,
      };
    });
    all.sort((a, b) => {
      if (isInboxProjectId(a.id) !== isInboxProjectId(b.id)) return isInboxProjectId(a.id) ? -1 : 1;
      const aOpen = openOrder.has(a.id);
      const bOpen = openOrder.has(b.id);
      if (aOpen && bOpen) return openOrder.get(a.id) - openOrder.get(b.id);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return sendJson(res, 200, { projects: all });
  }

  // Rename a project. Mobile parity with the tab rename below — same shape
  // (POST {name}) delegating to the renderer store so the desktop UI, the
  // SQLite metadata and the mobile list all converge. `renameProject` bridge
  // action persists via project:save-metadata (see useProjectsStore.updateProject).
  // NOTE: first use of `m` in this handler — declare it here with `let`. The old
  // first declaration (the /tabs route below) is now a plain reassignment. A
  // bare `m = …` here referenced the later `let m` → TDZ "Cannot access 'm'
  // before initialization", which 500'd every route from this point down.
  let m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const data = await bridgeRequest('renameProject', { projectId, name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
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

  // Read-only file preview for mobile file-tabs. The tab list already exposes
  // filePath for tabType='file'; this endpoint returns the current file body so
  // mobile can show the same Markdown document without depending on renderer
  // Zustand/FilePreview state.
  if (parsed.pathname === '/api/file-preview' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const filePath = String(body.path || '').trim();
      if (!filePath) return sendJson(res, 400, { error: 'path required' });
      if (!path.isAbsolute(filePath)) return sendJson(res, 400, { error: 'absolute path required' });
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return sendJson(res, 400, { error: 'not a file' });
      const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;
      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return sendJson(res, 413, { error: 'file too large for mobile preview' });
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      return sendJson(res, 200, {
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        size: stat.size,
        content,
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  async function resolveMobilePromptRow(prompt) {
    const parts = [];
    const own = String(prompt?.content || '').trim();
    if (own) parts.push(own);

    const filePaths = Array.isArray(prompt?.file_paths) ? prompt.file_paths : [];
    for (const fp of filePaths) {
      const filePath = typeof fp === 'string' ? fp.trim() : '';
      if (!filePath) continue;
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const clean = sanitizeFileForPrompt ? sanitizeFileForPrompt(raw, filePath) : raw;
        const trimmed = String(clean || '').trim();
        if (trimmed) parts.push(trimmed);
      } catch (e) {
        console.warn('[WebServer] /api/prompts failed to read prompt file:', filePath, e.message);
      }
    }

    return {
      ...prompt,
      resolvedText: parts.join('\n\n'),
    };
  }

  // Prompts library (groups + items). Read-only — used by mobile composer
  // Insert-Prompt button. Schema:
  //   group: { id, name, position }
  //   prompt: { id, title, content, group_id?, position, file_paths[], resolvedText }
  if (parsed.pathname === '/api/prompts' && req.method === 'GET') {
    try {
      const groups = projectManager.getPromptGroups();
      const prompts = await Promise.all(projectManager.getPrompts().map(resolveMobilePromptRow));
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

  // Agent model catalog for native/web clients. Codex list comes from the live
  // `codex debug models` (cached 5 min in codex-data); the bundled catalog is
  // fallback-only and can carry hidden/upgrade-only rows the TUI rejects, so the
  // phone must NOT hardcode a stale subset (symptom: "у Codex не все модели").
  // Claude list is the static renderer literal. Server-wide, no tabId, no bridge
  // (listCodexModels runs in main). Direct `pathname ===` route — does NOT touch
  // `m`, so it's safe above the `let m` chain (see fact-mobile-web.md::let m TDZ).
  if (parsed.pathname === '/api/agent-models' && req.method === 'GET') {
    try {
      let codexModels = [];
      if (listCodexModels) {
        try {
          codexModels = await listCodexModels();
        } catch (e) {
          console.warn('[WebServer] /api/agent-models codex list failed:', e.message);
        }
      }
      return sendJson(res, 200, {
        success: true,
        codex: codexModels,
        claude: CLAUDE_MODELS_FOR_CLIENTS,
        controlCapabilities: {
          // v2 reads every numbered effort row from the live TUI instead of a
          // closed name whitelist, so clients may safely expose future levels.
          codexEffortPicker: 'tui-numbered-v2',
        },
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Tabs of a project. (`m` is declared at the project-rename route above.)
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/);
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
    let inputReadyMap = new Map();
    let lastNotReadyMap = new Map();
    let awaitingMap = new Map();
    let runtimeSessionMap = new Map();
    let codexWriterConfirmedMap = new Map();
    let codexWriterUsableMap = new Map();
    let canCopySessionIdMap = new Map();
    let canResumeMap = new Map();
    let startupFailedMap = new Map();
    let startupErrorMap = new Map();
    let startupDefaultsPendingMap = new Map();
    let startupDefaultsReadyMap = new Map();
    let startupDefaultsErrorMap = new Map();
    let completionNotificationMap = new Map();
    try {
      const data = await bridgeRequest('getProjectCompletionNotifications', { projectId }, 1500);
      if (data?.tabs && typeof data.tabs === 'object') {
        for (const [id, info] of Object.entries(data.tabs)) completionNotificationMap.set(id, info || {});
      }
    } catch (e) {
      // Runtime-only notification state lives in renderer; closed projects just
      // expose the persisted "persistent" arm flag below.
    }
    const ptyAgentIds = (project.tabs || [])
      .filter(t => (t.commandType === 'claude' || t.commandType === 'codex') && (t.tabType || 'terminal') !== 'claude-sdk')
      .map(t => t.tabId);
    if (ptyAgentIds.length > 0) {
      try {
        const data = await bridgeRequest('getClaudeTabStatusBatch', { tabIds: ptyAgentIds, projectId }, 1500);
        if (data?.statuses) for (const [id, st] of Object.entries(data.statuses)) statusMap.set(id, st);
        if (data?.inputReady) for (const [id, ready] of Object.entries(data.inputReady)) inputReadyMap.set(id, !!ready);
        if (data?.lastNotReady) for (const [id, value] of Object.entries(data.lastNotReady)) lastNotReadyMap.set(id, value);
        if (data?.awaiting) for (const [id, aw] of Object.entries(data.awaiting)) if (aw) awaitingMap.set(id, true);
        if (data?.sessions) for (const [id, sid] of Object.entries(data.sessions)) if (sid) runtimeSessionMap.set(id, sid);
        if (data?.codexWriterConfirmed) for (const [id, value] of Object.entries(data.codexWriterConfirmed)) codexWriterConfirmedMap.set(id, value === true);
        if (data?.codexWriterUsableForMutation) for (const [id, value] of Object.entries(data.codexWriterUsableForMutation)) codexWriterUsableMap.set(id, value === true);
        if (data?.canCopySessionId) for (const [id, value] of Object.entries(data.canCopySessionId)) canCopySessionIdMap.set(id, value === true);
        if (data?.canResume) for (const [id, value] of Object.entries(data.canResume)) canResumeMap.set(id, value === true);
        if (data?.startupFailed) for (const [id, value] of Object.entries(data.startupFailed)) if (value) startupFailedMap.set(id, true);
        if (data?.startupError) for (const [id, value] of Object.entries(data.startupError)) if (value) startupErrorMap.set(id, value);
        if (data?.startupDefaultsPending) for (const [id, value] of Object.entries(data.startupDefaultsPending)) if (value) startupDefaultsPendingMap.set(id, true);
        if (data?.startupDefaultsReady) for (const [id, value] of Object.entries(data.startupDefaultsReady)) if (value) startupDefaultsReadyMap.set(id, true);
        if (data?.startupDefaultsError) for (const [id, value] of Object.entries(data.startupDefaultsError)) if (value) startupDefaultsErrorMap.set(id, value);
      } catch (e) {
        // Bridge unavailable — every PTY agent tab will show no badge until
        // user opens it (per-tab GET /status still works on demand).
      }
    }
    // Resolve every Codex row from main, even when renderer returned a status.
    // A closed/not-yet-hydrated renderer tab otherwise answers `inactive` and
    // would expose SQLite while a live or unresolved Codex process exists.
    for (const t of project.tabs || []) {
      if (t.commandType !== 'codex') continue;
      let runtime = null;
      try {
        runtime = typeof resolveCodexRuntimeSessionInfo === 'function'
          ? await resolveCodexRuntimeSessionInfo(t.tabId, 'web-project-tabs-authoritative', projectId)
          : null;
      } catch {}
      runtimeSessionMap.delete(t.tabId);
      if (!runtime) {
        statusMap.set(t.tabId, 'unknown');
        inputReadyMap.set(t.tabId, false);
        codexWriterConfirmedMap.set(t.tabId, false);
        codexWriterUsableMap.set(t.tabId, false);
        canCopySessionIdMap.set(t.tabId, false);
        canResumeMap.set(t.tabId, false);
        continue;
      }
      statusMap.set(t.tabId, runtime.sessionStatus || 'unknown');
      inputReadyMap.set(t.tabId, runtime.inputReady === true);
      if (runtime.sessionId) runtimeSessionMap.set(t.tabId, runtime.sessionId);
      codexWriterConfirmedMap.set(t.tabId, runtime.writerConfirmed === true);
      codexWriterUsableMap.set(t.tabId, runtime.writerUsableForMutation === true);
      canCopySessionIdMap.set(t.tabId, runtime.canCopySessionId === true);
      canResumeMap.set(t.tabId, runtime.sessionStatus === 'inactive' && !!runtime.sessionId);
    }
    // Configurable status-marker palette (assigned-category color + shape/size)
    // AND process-bar config (loader strip position/base/shimmer) live in renderer
    // useUIStore — fetch once so the phone mirrors both the desktop left-marker
    // and the loader strip exactly. Falls back to dot/8px + left process-bar
    // when the bridge is unavailable.
    let markerCfg = { shape: 'dot', sizePx: 8 };
    let processBarCfg = { colorA: '#155E75', shimmerColor: '#FFFFFF', shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: 'left' };
    let statusesForClient = [];
    let paletteById = new Map();
    try {
      const cfg = await bridgeRequest('getStatusMarkerConfig', {}, 1500);
      if (cfg?.shape) markerCfg = { shape: cfg.shape, sizePx: cfg.sizePx || 8 };
      if (Array.isArray(cfg?.statuses)) {
        statusesForClient = cfg.statuses.map(s => ({ id: s.id, color: s.color, label: s.label }));
        for (const s of statusesForClient) paletteById.set(s.id, s);
      }
      if (cfg?.processBar) processBarCfg = cfg.processBar;
    } catch (e) {
      // renderer not ready — phone renders runtime-only markers, no category tint
    }
    const tabs = (project.tabs || []).map(t => {
      // Materialized conversation is a separate axis from "Claude wrote a UUID".
      // A pre-prompt Claude process can create a JSONL with only mode/permission
      // records; that UUID is not resumable and must not enable Copy/Resume.
      const claudeMaterialization = t.claudeSessionId
        ? claudeMaterializationFor(t.claudeSessionId, t.cwd)
        : null;
      const runtimeStatus = statusMap.get(t.tabId) || null;
      const runtimeCodexSessionId = runtimeSessionMap.get(t.tabId) || null;
      const isCodex = t.commandType === 'codex';
      const isClaude = t.commandType === 'claude';
      const codexWriterConfirmed = codexWriterConfirmedMap.get(t.tabId) === true;
      const codexWriterUsableForMutation = codexWriterUsableMap.get(t.tabId) === true;
      const codexHistoricalSessionId = t.codexSessionId || null;
      const codexSessionId = isCodex
        ? runtimeStatus === 'inactive'
          ? (runtimeCodexSessionId || codexHistoricalSessionId)
          : runtimeStatus && codexWriterConfirmed
            ? runtimeCodexSessionId
            : null
        : null;
      const timelineCount = isClaude && typeof claudeMaterialization?.timelineCount === 'number'
        ? claudeMaterialization.timelineCount
        : null;
      const conversationMaterialized = isClaude
        ? claudeMaterialization?.materialized === true
        : isCodex
          ? !!codexHistoricalSessionId
          : false;
      // Assigned-category status (DB column session_status holds the palette id;
      // distinct from runtime sessionStatus which drives the loader/background).
      const statusId = t.sessionStatus || null;
      const isPtyAgent = (t.commandType === 'claude' || t.commandType === 'codex') && (t.tabType || 'terminal') !== 'claude-sdk';
      const notification = completionNotificationMap.get(t.tabId) || {};
      return {
        tabId: t.tabId,
        name: t.name,
        tabType: t.tabType || 'terminal',
        commandType: t.commandType,
        color: t.color || null,   // desktop TabColor — drives row bg (mobile mirrors desktop)
        cwd: t.cwd,
        filePath: t.filePath || null,
        claudeSessionId: t.claudeSessionId,
        codexSessionId,
        codexWriterConfirmed,
        codexWriterUsableForMutation,
        geminiSessionId: t.geminiSessionId,
        timelineCount,
        conversationMaterialized,
        canResume: isCodex
          ? (canResumeMap.has(t.tabId) ? canResumeMap.get(t.tabId) : runtimeStatus === 'inactive' && !!codexSessionId)
          : isClaude && runtimeStatus === 'inactive' && conversationMaterialized,
        canCopySessionId: isCodex
          ? (canCopySessionIdMap.has(t.tabId)
            ? canCopySessionIdMap.get(t.tabId)
            : runtimeStatus === 'inactive'
              ? !!codexSessionId
              : !!runtimeStatus && codexWriterUsableForMutation)
          : isClaude
            ? conversationMaterialized
            : !!t.geminiSessionId,
        materializationReason: isClaude ? (claudeMaterialization?.reason || null) : (isCodex ? (codexHistoricalSessionId ? 'codex-session-id' : 'no-session-id') : null),
        sessionStatus: runtimeStatus,
        starting: runtimeStatus === 'starting',
        stopping: runtimeStatus === 'stopping',
        inputReady: inputReadyMap.has(t.tabId) ? inputReadyMap.get(t.tabId) : null,
        lastNotReady: lastNotReadyMap.get(t.tabId) || null,
        startupFailed: startupFailedMap.get(t.tabId) || false,
        startupError: startupErrorMap.get(t.tabId) || null,
        startupDefaultsPending: t.commandType === 'claude' ? (startupDefaultsPendingMap.get(t.tabId) || false) : false,
        startupDefaultsReady: t.commandType === 'claude' ? (startupDefaultsReadyMap.get(t.tabId) || false) : (isPtyAgent ? true : false),
        startupDefaultsError: startupDefaultsErrorMap.get(t.tabId) || null,
        awaiting: awaitingMap.get(t.tabId) || false,
        statusId,
        statusColor: statusId ? (paletteById.get(statusId)?.color || null) : null,
        completionNotificationPersistent: notification.completionNotificationPersistent === true || t.completionNotificationPersistent === true,
        completionNotificationArmed: notification.completionNotificationArmed === true,
        completionNotificationFired: notification.completionNotificationFired === true,
        completionNotificationFiredAt: notification.completionNotificationFiredAt || null,
        groupId: t.groupId || null,
        visualParentTabId: t.visualParentTabId || null,
        // Last-known context fill % (SQLite context_pct). Seeds the native/web
        // header pill on open so it shows a value before the next live
        // bridge-update/turn, instead of being blank until the first turn.
        contextPct: (typeof t.contextPct === 'number' && isFinite(t.contextPct)) ? t.contextPct : null,
        // Live state if SDK session is active in main right now
        live: t.tabId && sdkSessions.has(t.tabId) ? {
          sessionId: sdkSessions.get(t.tabId).sessionId,
          cwd: sdkSessions.get(t.tabId).cwd,
        } : null,
      };
    });
    const groups = (project.tabGroups || []).map(g => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt || null,
      anchorTabId: g.anchorTabId || null,
      collapsed: !!g.collapsed,
      color: g.color || null,
      sessionStatus: g.sessionStatus || null,
      statusColor: g.sessionStatus ? (paletteById.get(g.sessionStatus)?.color || null) : null,
    }));
    return sendJson(res, 200, {
      project: { id: project.id, name: project.name, path: project.path, icon: project.icon || null },
      tabs,
      groups,
      statusMarker: markerCfg,
      statuses: statusesForClient,
      processBar: processBarCfg,
    });
  }

  // Create tab group in a project. Delegates to the renderer store so group
  // anchors, activeGroupId semantics, persistence, and desktop UI stay single-source.
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('createTabGroup', { projectId, name: body.name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const data = await bridgeRequest('renameTabGroup', { projectId, groupId, name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/toggle-collapsed$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const data = await bridgeRequest('toggleTabGroupCollapsed', { projectId, groupId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/status$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setTabGroupSessionStatus', { projectId, groupId, status: body.status || null });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/delete$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const data = await bridgeRequest('deleteTabGroup', { projectId, groupId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-layout$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.orderedIds)) return sendJson(res, 400, { error: 'orderedIds required' });
      const data = await bridgeRequest('applyTabLayout', {
        projectId,
        orderedIds: body.orderedIds,
        groupAssignments: body.groupAssignments || {},
        visualParentAssignments: body.visualParentAssignments || {},
        groupAnchorAssignments: body.groupAnchorAssignments || {},
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Send prompt to a project terminal tab. The scenario layer owns draft
  // preflight, busy/send-during-streaming and stopped-session readiness. Legacy
  // SDK tabs can still be routed by tab type, but the public endpoint is
  // terminal-tabs because Claude/Codex PTY is the main API surface.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/send$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const { prompt, model, effort, thinking, cwd, handoffId, source, statusAtSend, queue, attachments } = body;
      if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
      const sendPayload = appendAttachmentsToPrompt(prompt, attachments);
      // Single bridge round-trip — renderer dispatches by tab.tabType/commandType.
      // Earlier this endpoint did TWO round-trips (status check + send), adding
      // ~50ms per phone send on top of the actual PTY paste latency.
      const data = await runAgentSendScenario({
        tabId, prompt: sendPayload.prompt, model, effort, thinking, cwd,
        handoffId, source, statusAtSend, queue: queue === true,
        ownership: 'project',
      });
      if (isSendFailure(data)) return sendSendFailure(res, data, { tabId });
      return sendJson(res, 200, {
        ok: true,
        success: data?.success !== false,
        status: data?.queued ? 'queued' : 'sent',
        attachments: sendPayload.attachments,
        ...(data || {}),
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/completion-notification\/clear$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('clearTabCompletionNotification', { tabId, keepPersistent: true }, 1500);
      return sendJson(res, 200, { ok: true, success: true, ...(data || {}) });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Legacy Claude-only alias. Keep it on the same native-safe path as
  // /agent-tabs: API clients may never mount the desktop Terminal component,
  // so pendingAction alone is not enough to start the CLI.
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/claude-tabs$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('createAgentTab', {
        projectId: decId(m[1]),
        toolType: 'claude',
        startNow: true,
      }, 12_000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Create PTY agent tab in a project. Body: { toolType: 'claude' | 'codex' }.
  // Native/API clients do not necessarily mount the desktop Terminal component,
  // so the bridge starts the agent immediately after the PTY is created.
  if (parsed.pathname === '/api/inbox/agent-tabs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const toolType = body.toolType === 'codex' ? 'codex' : 'claude';
      await bridgeRequest('ensureInboxProject', {}, 5000);
      const data = await bridgeRequest('createAgentTab', { projectId: INBOX_PROJECT_ID, toolType, startNow: true }, 12_000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/inbox/runs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const provider = body.provider === 'codex' ? 'codex' : null;
      if (!provider) return sendJson(res, 400, { error: 'provider must be codex' });
      const prompt = cleanOptionalString(body.prompt ?? body.text);
      if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
      const runId = body.runId && String(body.runId).trim() ? String(body.runId).trim() : crypto.randomUUID();
      const source = cleanOptionalString(body.source, 'external-api');
      const conversationKey = cleanOptionalString(body.conversationKey || body.chatId, '');
      const autoStopMs = clampAutoStopMs(body.autoStopMs);
      const autoCloseMs = clampAutoCloseMs(body.autoCloseMs);
      const startupTimeoutMs = Math.max(5_000, Math.min(120_000, Number(body.startupTimeoutMs) || 20_000));
      const developerInstructions = cleanOptionalString(body.developerInstructions || body.systemPrompt, '');
      const startedAt = Date.now();
      const autoStopAt = autoStopMs > 0 ? null : null;
      const autoCloseAt = null;
      await bridgeRequest('ensureInboxProject', {}, 5000);
      let tabId = null;
      let sessionId = null;
      let reused = false;
      if (conversationKey && externalRunByConversationKey.has(conversationKey)) {
        const prevRunId = externalRunByConversationKey.get(conversationKey);
        const prevRun = externalRuns.get(prevRunId);
        if (prevRun?.tabId) {
          try {
            clearExternalRunTimer(prevRun, 'stopTimer');
            clearExternalRunTimer(prevRun, 'closeTimer');
            const prevStatus = await bridgeRequest('getClaudeTabStatus', { tabId: prevRun.tabId }, 2000);
            if (prevStatus?.toolType === 'codex') {
              tabId = prevRun.tabId;
              // A null current ID is intentional while a live resume is
              // resolving its writer. Never fill it with the previous run's
              // historical identity.
              sessionId = codexSessionIdFromAuthoritativeStatus(prevStatus);
              reused = true;
              if (prevStatus.status === 'inactive' && sessionId) {
                await bridgeRequest('resumeClaudeTab', { tabId }, 5000);
              }
            }
          } catch {}
        }
      }
      const tabName = cleanOptionalString(body.name, conversationKey ? `Codex · ${conversationKey.slice(-8)}` : `Codex · ${source}`);
      const externalRun = {
        runId,
        provider,
        source,
        conversationKey: conversationKey || undefined,
        status: 'starting',
        startedAt,
        autoStopAt,
        autoStopMs,
        autoCloseAt,
        autoCloseMs,
        collapsed: body.collapsed === true,
      };
      if (!tabId) {
        const tab = await bridgeRequest('createAgentTab', {
          projectId: INBOX_PROJECT_ID,
          toolType: provider,
          name: tabName,
          startNow: true,
          externalRun,
          codexDeveloperInstructions: developerInstructions || undefined,
          codexModel: cleanOptionalString(body.model, ''),
          codexEffort: cleanOptionalString(body.effort, ''),
        }, 8000);
        tabId = tab?.tabId;
        if (!tabId) return sendJson(res, 500, { error: 'failed to create tab' });
      }
      const run = { ...externalRun, tabId, sessionId, stopTimer: null, closeTimer: null };
      externalRuns.set(runId, run);
      externalRunByTabId.set(tabId, runId);
      if (conversationKey) externalRunByConversationKey.set(conversationKey, runId);
      setExternalRunMeta(tabId, { ...externalRun, tabId });
      let status = null;
      try {
        status = await waitForAgentReady(tabId, startupTimeoutMs);
      } catch (e) {
        if (e?.code === 'codex_auth_required') {
          run.status = 'auth_required';
          setExternalRunMeta(tabId, { status: 'auth_required', error: 'codex_auth_required' });
          return sendJson(res, 409, { ok: false, runId, tabId, error: 'codex_auth_required', status: e.status || null });
        }
        run.status = 'start_timeout';
        setExternalRunMeta(tabId, { status: 'start_timeout', error: String(e.message || e) });
        return sendJson(res, 504, { ok: false, runId, tabId, error: 'agent did not become ready', status: e.status || null });
      }
      sessionId = codexSessionIdFromAuthoritativeStatus(status);
      run.status = 'sending';
      run.sessionId = sessionId;
      setExternalRunMeta(tabId, { status: 'sending', sessionId, autoStopAt: null, autoCloseAt: null });
      const sendResult = await runAgentSendScenario({
        tabId,
        prompt,
        model: cleanOptionalString(body.model, ''),
        effort: cleanOptionalString(body.effort, ''),
        source: 'external:' + source,
        statusAtSend: status?.status || 'active',
        queue: body.queue === true,
        ownership: 'external',
        timeoutMs: 60_000,
      });
      if (isSendFailure(sendResult)) {
        const failureCode = sendResult?.code || 'send_failed';
        run.status = failureCode === 'terminal_draft_conflict' ? 'draft_conflict' : 'send_failed';
        setExternalRunMeta(tabId, { status: run.status, error: sendResult.error || 'send failed' });
        return sendSendFailure(res, sendResult, { runId, tabId, sessionId });
      }
      run.status = 'running';
      setExternalRunMeta(tabId, { status: 'running', sessionId, autoStopAt: null, autoStopMs, autoCloseAt: null, autoCloseMs });
      return sendJson(res, 200, {
        ok: true,
        success: true,
        status: sendResult?.queued ? 'queued' : 'sent',
        runId,
        provider,
        tabId,
        sessionId,
        source,
        conversationKey: conversationKey || null,
        eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
        stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
        autoStopMs,
        autoCloseMs,
        reused,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)\/stop$/);
  if (m && req.method === 'POST') {
    const runId = decId(m[1]);
    const run = externalRuns.get(runId);
    if (!run?.tabId) return sendJson(res, 404, { error: 'run not found' });
    try {
      clearExternalRunTimer(run, 'stopTimer');
      run.status = 'stopping';
      setExternalRunMeta(run.tabId, { status: 'stopping', autoStopAt: null });
      const data = await runAgentStopScenario(run.tabId, 5000);
      run.status = 'stopped';
      run.stoppedAt = Date.now();
      setExternalRunMeta(run.tabId, { status: 'stopped', stoppedAt: run.stoppedAt, autoStopAt: null, stopReason: 'api' });
      scheduleExternalRunClose(run, 'api-stop');
      return sendJson(res, 200, { ok: true, runId, tabId: run.tabId, stopped: true, ...data });
    } catch (e) {
      return sendJson(res, 500, { ok: false, runId, error: String(e.message || e) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/agent-tabs$/);
  if (m && req.method === 'POST') {
    const started = Date.now();
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const toolType = body.toolType === 'codex' ? 'codex' : 'claude';
      console.log('[WebAgentTabs] START project=' + shortId(projectId, 12)
        + ' tool=' + toolType
        + ' model=' + (cleanOptionalString(body.model || body.codexModel, '') || '-')
        + ' effort=' + (cleanOptionalString(body.effort || body.codexEffort, '') || '-'));
      const data = await bridgeRequest('createAgentTab', {
        projectId,
        toolType,
        startNow: true,
        name: cleanOptionalString(body.name, ''),
        codexModel: cleanOptionalString(body.model || body.codexModel, ''),
        codexEffort: cleanOptionalString(body.effort || body.codexEffort, ''),
      }, 12_000);
      console.log('[WebAgentTabs] OK project=' + shortId(projectId, 12)
        + ' tool=' + toolType
        + ' tab=' + shortId(data?.tabId, 12)
        + ' status=' + (data?.sessionStatus || (data?.starting ? 'starting' : '-'))
        + ' session=' + shortId(data?.claudeSessionId || data?.codexSessionId || data?.sessionId)
        + ' materialized=' + (data?.conversationMaterialized === true)
        + ' canResume=' + (data?.canResume === true)
        + ' canCopy=' + (data?.canCopySessionId === true)
        + ' defaultsPending=' + (data?.startupDefaultsPending === true)
        + ' defaultsReady=' + (data?.startupDefaultsReady === true)
        + ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      console.warn('[WebAgentTabs] ERR project=' + shortId(projectId, 12)
        + ' error=' + String(e?.message || e)
        + ' ms=' + (Date.now() - started));
      return sendTerminalBridgeError(res, e);
    }
  }

  // Start a fresh agent runtime in an existing PTY tab. This is intentionally
  // separate from /resume: an unmaterialized Claude tab has no saved
  // conversation to resume, but it still needs a way to launch Claude again.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/start$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const startupTimeoutMs = Math.max(1000, Math.min(60_000, Number(body.startupTimeoutMs) || 60_000));
      let beforeStatus = null;
      try {
        beforeStatus = await bridgeRequest('getClaudeTabStatus', { tabId }, 1500);
      } catch (statusErr) {
        console.warn('[MobStart] preflight status failed tab=' + shortId(tabId, 12)
          + ' error=' + String(statusErr?.message || statusErr));
      }
      console.log('[MobStart] request tab=' + shortId(tabId, 12)
        + ' status=' + (beforeStatus?.status || '-')
        + ' tool=' + (beforeStatus?.toolType || beforeStatus?.commandType || '-')
        + ' session=' + shortId(beforeStatus?.sessionId || beforeStatus?.codexSessionId || beforeStatus?.claudeSessionId)
        + ' materialized=' + (beforeStatus?.conversationMaterialized === true)
        + ' canResume=' + (beforeStatus?.canResume === true)
        + ' bodyAction=start');
      if ((beforeStatus?.toolType === 'codex' || beforeStatus?.commandType === 'codex')
        && beforeStatus?.canResume === true
        && (beforeStatus?.sessionId || beforeStatus?.codexSessionId)) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: 'tab_has_resumable_session',
          reason: 'start_blocked_by_codex_resume_state',
          tabId,
          toolType: 'codex',
          commandType: 'codex',
          sessionId: beforeStatus.sessionId || beforeStatus.codexSessionId,
          codexSessionId: beforeStatus.codexSessionId || beforeStatus.sessionId,
          status: beforeStatus.status || 'inactive',
          conversationMaterialized: true,
          canResume: true,
          canCopySessionId: true,
          timelineCount: beforeStatus.timelineCount ?? null,
          materializationReason: beforeStatus.materializationReason || 'codex-session-bound',
        });
      }
      let data;
      try {
        data = await bridgeRequest('startAgentTab', { tabId }, Math.max(5000, Math.min(15_000, startupTimeoutMs)));
      } catch (bridgeErr) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: String(bridgeErr.message || bridgeErr),
        });
      }
      if (data?.success === false || data?.ok === false) {
        return sendJson(res, 409, { ...(data || {}), ok: false, success: false, ready: false });
      }
      try {
        const status = await waitForAgentReady(tabId, startupTimeoutMs);
        const startedTool = data?.toolType || status?.toolType || status?.commandType || data?.commandType;
        const needsStartupDefaults = startedTool === 'claude';
        let defaultsReady = !needsStartupDefaults;
        let defaultsError = null;
        let liveStatus = status;
        if (needsStartupDefaults) {
          try {
            const defaults = await bridgeRequest('waitAgentStartupDefaultsReady', { tabId, timeoutMs: startupTimeoutMs }, Math.max(5000, startupTimeoutMs));
            defaultsReady = defaults?.defaultsReady === true;
            defaultsError = defaults?.error || defaults?.reason || null;
          } catch (defaultsErr) {
            defaultsError = String(defaultsErr.message || defaultsErr);
            console.warn('[MobStart] startup defaults not ready after fresh start tab=' + shortId(tabId, 12)
              + ' runtimeStatus=' + (status?.status || '-')
              + ' error=' + defaultsError
              + ' continuingWithLiveRuntime=true');
          }
        }
        try {
          liveStatus = await readFreshReadyRuntimeStatus(tabId, 'start-after-defaults');
        } catch (freshErr) {
          console.warn('[MobStart] fresh runtime proof failed tab=' + shortId(tabId, 12)
            + ' error=' + String(freshErr?.message || freshErr)
            + ' status=' + (freshErr?.status?.status || '-'));
          return sendJson(res, freshErr?.statusCode || 503, {
            ...(data || {}),
            ok: false,
            success: false,
            ready: false,
            error: freshErr?.code || 'runtime_snapshot_unavailable',
            detail: String(freshErr?.message || freshErr),
            status: freshErr?.status?.status || null,
            inputReady: freshErr?.status?.inputReady === true,
            startupDefaultsReady: defaultsReady,
            startupDefaultsError: defaultsError,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          success: true,
          ready: true,
          ...(data || {}),
          startupDefaultsReady: defaultsReady,
          startupDefaultsError: defaultsError,
          status: liveStatus?.status || 'active',
          starting: liveStatus?.status === 'starting',
          stopping: liveStatus?.status === 'stopping',
          inputReady: liveStatus?.inputReady === true,
          conversationMaterialized: false,
          canResume: false,
          canCopySessionId: false,
          timelineCount: 0,
          materializationReason: 'timeline-empty',
        });
      } catch (readyErr) {
        return sendJson(res, readyErr?.code === 'codex_auth_required' ? 409 : 504, {
          ...(data || {}),
          ok: false,
          success: false,
          ready: false,
          error: String(readyErr.message || readyErr),
          status: readyErr.status || null,
        });
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, success: false, ready: false, error: String(e.message) });
    }
  }

  // Resume inactive Claude session (PTY tab whose `claude` process exited).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/resume$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const startupTimeoutMs = Math.max(1000, Math.min(60_000, Number(body.startupTimeoutMs) || 60_000));
      let data;
      try {
        data = await bridgeRequest('resumeClaudeTab', { tabId }, Math.max(5000, Math.min(15_000, startupTimeoutMs)));
      } catch (bridgeErr) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: String(bridgeErr.message || bridgeErr),
        });
      }
      if (data?.success === false || data?.ok === false) {
        return sendJson(res, 409, { ...(data || {}), ok: false, success: false, ready: false });
      }
      try {
        const status = await waitForAgentReady(tabId, startupTimeoutMs);
        let defaultsReady = false;
        let defaultsError = null;
        let liveStatus = status;
        try {
          const defaults = await bridgeRequest('waitAgentStartupDefaultsReady', { tabId, timeoutMs: startupTimeoutMs }, Math.max(5000, startupTimeoutMs));
          defaultsReady = defaults?.defaultsReady === true;
          defaultsError = defaults?.error || defaults?.reason || null;
        } catch (defaultsErr) {
          defaultsError = String(defaultsErr.message || defaultsErr);
          console.warn('[MobResume] startup defaults not ready after live resume tab=' + shortId(tabId, 12)
            + ' runtimeStatus=' + (status?.status || '-')
            + ' error=' + defaultsError
            + ' continuingWithLiveRuntime=true');
        }
        try {
          liveStatus = await readFreshReadyRuntimeStatus(tabId, 'resume-after-defaults');
        } catch (freshErr) {
          console.warn('[MobResume] fresh runtime proof failed tab=' + shortId(tabId, 12)
            + ' error=' + String(freshErr?.message || freshErr)
            + ' status=' + (freshErr?.status?.status || '-'));
          return sendJson(res, freshErr?.statusCode || 503, {
            ...(data || {}),
            ok: false,
            success: false,
            ready: false,
            error: freshErr?.code || 'runtime_snapshot_unavailable',
            detail: String(freshErr?.message || freshErr),
            status: freshErr?.status?.status || null,
            inputReady: freshErr?.status?.inputReady === true,
            startupDefaultsReady: defaultsReady,
            startupDefaultsError: defaultsError,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          success: true,
          ready: true,
          ...(data || {}),
          startupDefaultsReady: defaultsReady,
          startupDefaultsError: defaultsError,
          status: liveStatus?.status || 'active',
          starting: liveStatus?.status === 'starting',
          stopping: liveStatus?.status === 'stopping',
          inputReady: liveStatus?.inputReady === true,
        });
      } catch (readyErr) {
        return sendJson(res, readyErr?.code === 'codex_auth_required' ? 409 : 504, {
          ...(data || {}),
          ok: false,
          success: false,
          ready: false,
          error: String(readyErr.message || readyErr),
          status: readyErr.status || null,
        });
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, success: false, ready: false, error: String(e.message) });
    }
  }

  // Status snapshot for a PTY+Claude tab: active | busy | inactive.
  // Mobile polls this on chat-open to decide Resume-banner visibility.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/status$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const statusPrefix = '[WebStatus] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(statusPrefix, started);
    console.log(statusPrefix + ' START');
    try {
      const data = await bridgeRequest('getClaudeTabStatus', { tabId });
      clearPending();
      console.log(statusPrefix +
        ' status=' + (data?.status || '-') +
        ' busy=' + (data?.busy == null ? '-' : data.busy) +
        ' session=' + shortId(data?.sessionId) +
        ' materialized=' + (data?.conversationMaterialized === true) +
        ' timelineCount=' + (data?.timelineCount == null ? '-' : data.timelineCount) +
        ' canResume=' + (data?.canResume === true) +
        ' defaultsPending=' + (data?.startupDefaultsPending === true) +
        ' defaultsReady=' + (data?.startupDefaultsReady === true) +
        ' defaultsError=' + (data?.startupDefaultsError || '-') +
        ' command=' + (data?.commandType || '-') +
        ' tool=' + (data?.toolType || '-') +
        ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      clearPending();
      console.warn(statusPrefix + ' error=' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Truncate history (drop everything ≥ targetUuid). Used by mobile Edit/Repeat
  // — bridges to the renderer which then invokes the same `claude-sdk:truncate-history`
  // ipcMain handler the desktop UI uses. After 200 OK the caller sends the new
  // prompt via /send (with original or edited text) and Claude resumes off the
  // truncated tip.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/truncate$/);
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

  // Middle history compact-edit for Claude JSONL / Codex rollout. This is NOT
  // native `/rewind`: it calls the same core edit-range implementation as
  // desktop Timeline. It does not run Gemini or stop/restart a live agent.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/edit-range$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const prefix = '[WebEditRange] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(prefix, started);
    console.log(prefix + ' START');
    try {
      const body = await readBody(req);
      const compactText = cleanOptionalString(body.compactText, '').trim();
      if (!compactText) {
        clearPending();
        return sendJson(res, 400, { ok: false, success: false, error: 'compactText required' });
      }
      const target = await resolveEditRangeMutationTarget(tabId, body);
      console.log(prefix + ' BODY tool=' + target.toolType +
        ' sid=' + shortId(target.sessionId) +
        ' start=' + shortId(target.startUuid) +
        ' end=' + shortId(target.endUuid) +
        ' status=' + (target.status?.status || '-') +
        ' compactChars=' + compactText.length);
      const result = target.toolType === 'codex'
        ? await codexDataApi.editCodexRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
          compactText,
        })
        : await claudeDataApi.editRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
          compactText,
        });
      let adoptedSessionId = null;
      let adoptionError = null;
      if (target.toolType === 'codex' && result?.success !== false && result?.newSessionId) {
        try {
          await bridgeRequest('setCodexSessionId', {
            tabId,
            sessionId: result.newSessionId,
            reason: 'api-edit-range',
          }, 3000);
          adoptedSessionId = result.newSessionId;
        } catch (adoptErr) {
          adoptionError = String(adoptErr.message || adoptErr);
          console.warn(prefix + ' ADOPT_FAILED newSid=' + shortId(result.newSessionId) + ' error=' + adoptionError);
        }
      }
      clearPending();
      console.log(prefix + ' DONE tool=' + target.toolType +
        ' success=' + (result?.success === true) +
        ' removed=' + (result?.removedCount == null ? '-' : result.removedCount) +
        ' newSid=' + shortId(result?.newSessionId) +
        ' adopted=' + shortId(adoptedSessionId) +
        ' ms=' + (Date.now() - started));
      const statusCode = result?.success === false ? 409 : 200;
      return sendJson(res, statusCode, {
        ok: result?.success !== false,
        mode: 'compact',
        toolType: target.toolType,
        tabId,
        sessionId: target.sessionId,
        adoptedSessionId,
        adoptionError,
        startUuid: target.startUuid,
        endUuid: target.endUuid,
        ...result,
      });
    } catch (e) {
      clearPending();
      const statusCode = e.statusCode || 500;
      console.warn(prefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, statusCode, { ok: false, success: false, error: String(e.message || e), ...(e.details || {}) });
    }
  }

  // Middle history deletion for Claude JSONL / Codex rollout. Unlike /truncate,
  // this removes the selected range without inserting a compact replacement.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/delete-range$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const prefix = '[WebDeleteRange] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(prefix, started);
    console.log(prefix + ' START');
    try {
      const body = await readBody(req);
      const target = await resolveEditRangeMutationTarget(tabId, body, 'delete');
      console.log(prefix + ' BODY tool=' + target.toolType +
        ' sid=' + shortId(target.sessionId) +
        ' start=' + shortId(target.startUuid) +
        ' end=' + shortId(target.endUuid) +
        ' status=' + (target.status?.status || '-'));
      const result = target.toolType === 'codex'
        ? await codexDataApi.deleteCodexRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
        })
        : await claudeDataApi.deleteRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
        });
      let adoptedSessionId = null;
      let adoptionError = null;
      if (target.toolType === 'codex' && result?.success !== false && result?.newSessionId) {
        try {
          await bridgeRequest('setCodexSessionId', {
            tabId,
            sessionId: result.newSessionId,
            reason: 'api-delete-range',
          }, 3000);
          adoptedSessionId = result.newSessionId;
        } catch (adoptErr) {
          adoptionError = String(adoptErr.message || adoptErr);
          console.warn(prefix + ' ADOPT_FAILED newSid=' + shortId(result.newSessionId) + ' error=' + adoptionError);
        }
      }
      clearPending();
      console.log(prefix + ' DONE tool=' + target.toolType +
        ' success=' + (result?.success === true) +
        ' removed=' + (result?.removedCount == null ? '-' : result.removedCount) +
        ' fileDeleted=' + (result?.fileDeleted === true) +
        ' newSid=' + shortId(result?.newSessionId) +
        ' adopted=' + shortId(adoptedSessionId) +
        ' ms=' + (Date.now() - started));
      const statusCode = result?.success === false ? 409 : 200;
      return sendJson(res, statusCode, {
        ok: result?.success !== false,
        mode: 'delete',
        toolType: target.toolType,
        tabId,
        sessionId: target.sessionId,
        adoptedSessionId,
        adoptionError,
        startUuid: target.startUuid,
        endUuid: target.endUuid,
        ...result,
      });
    } catch (e) {
      clearPending();
      const statusCode = e.statusCode || 500;
      console.warn(prefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, statusCode, { ok: false, success: false, error: String(e.message || e), ...(e.details || {}) });
    }
  }

  // Rename tab (delegates to renderer store via bridge — only works for tabs
  // currently OPEN in the desktop). Returns 409 if the tab isn't open.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rename$/);
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

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/status$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setTabSessionStatus', { tabId, status: body.status || null });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Close tab (delegates to renderer store — same constraint as rename:
  // closed-only-when-open).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/close$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('closeTab', {
        tabId,
        aiBusyOverride: body.aiBusy === true || body.streaming === true
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Fork a materialized Claude/Codex session into a neighbouring PTY tab.
  // The renderer owns tab creation and pendingAction semantics; HTTP remains a
  // scenario boundary and never writes PTY commands itself.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/fork$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('forkToTab', { tabId });
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

  // Stop terminal runtime (or legacy SDK stream when the tab is still SDK).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/stop$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const session = sdkSessions.get(tabId);
    if (session) {
      try { session.query.close(); } catch {}
      sdkSessions.delete(tabId);
      return sendJson(res, 200, { stopped: true });
    }
    // Normal path: Claude/Codex terminal tab. Try stop via scenario bridge.
    try {
      const data = await runAgentStopScenario(tabId, 2000);
      const outcome = classifyAgentActionResult('stop', data);
      return sendJson(res, outcome.statusCode, outcome.body);
    } catch (e) {
      const outcome = classifyAgentActionBridgeError('stop', e);
      return sendJson(res, outcome.statusCode, outcome.body);
    }
  }

  // SOFT interrupt the CURRENT TURN (composer Stop button). Claude/Codex PTY
  // goes through the terminal scenario layer; legacy SDK still uses query.close()
  // as a warm interrupt. Distinct from /stop, which kills the terminal process.
  // See fact-mobile-claude-pty.md.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/interrupt$/);
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
      const data = await runAgentInterruptScenario(tabId, 2000);
      const outcome = classifyAgentActionResult('interrupt', { kind: 'pty', ...data });
      return sendJson(res, outcome.statusCode, outcome.body);
    } catch (e) {
      const outcome = classifyAgentActionBridgeError('interrupt', e);
      return sendJson(res, outcome.statusCode, outcome.body);
    }
  }

  // Read the current terminal composer draft after a deterministic interrupt.
  // Mobile uses the same bridge action as desktop History instead of keeping a
  // local "last sent prompt" fallback.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/draft$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const tabId = decId(m[1]);
    try {
      const data = await runAgentGrabDraftScenario(tabId, 5000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Non-mutating terminal-composer probe. Codex uses this before History/mobile
  // send: an empty dim-placeholder must not go through Ctrl+G/grab because that
  // changes TUI state. Claude currently has no visual probe, so the renderer
  // returns hasDraft:null and callers can fall back to the established grab path.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/draft-state$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    try {
      const data = await runAgentInspectDraftScenario(tabId, 5000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Native timeline rewind/backtrack for PTY Claude/Codex. The renderer routes
  // by live tab tool type to the same IPC handlers desktop Timeline uses.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rewind$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const rewindPrefix = '[WebRewind] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(rewindPrefix, started);
    console.log(rewindPrefix + ' START');
    try {
      const body = await readBody(req);
      const mode = body.mode === 'ai' ? 'ai' : 'native';
      const timeoutMs = mode === 'ai' ? 180000 : 20000;
      console.log(rewindPrefix +
        ' BODY mode=' + mode +
        ' targetIndex=' + (body.targetIndex == null ? '-' : body.targetIndex) +
        ' rewindable=' + (body.rewindableCount == null ? '-' : body.rewindableCount) +
        ' skipDuplicates=' + (body.skipDuplicates || 0) +
        ' timeoutMs=' + timeoutMs);
      const data = await runAgentRewindScenario(tabId, {
        targetIndex: body.targetIndex,
        targetText: body.targetText,
        targetFullText: body.targetFullText,
        rewindableCount: body.rewindableCount,
        skipDuplicates: body.skipDuplicates || 0,
        mode,
        startUuid: body.startUuid || body.targetUuid || null,
        endUuid: body.endUuid || null,
        additionalPrompt: body.additionalPrompt || null,
      }, timeoutMs);
      clearPending();
      console.log(rewindPrefix + ' DONE mode=' + mode + ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      clearPending();
      console.warn(rewindPrefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Answer (or stop) an AskUserQuestion from mobile. Body:
  //   { source:'pty'|'sdk', toolUseID, answers:{[questionText]:label|labels}, stop? }
  // Routes to main's answerClaudeQuestion (PTY → drive TUI keystrokes, SDK →
  // resolve the parked canUseTool Promise). No bridge — these run in main directly.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/answer-question$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const result = await runAgentAnswerQuestionScenario({
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
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/pending-question$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const q = getAgentPendingQuestionScenario(tabId);
    return sendJson(res, 200, { pendingQuestion: q });
  }

  // SDK params (model/effort/thinking) for a tab — read & update.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/params$/);
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

  // One-shot Codex PTY actions. This is intentionally separate from `/params`:
  // `/fast` is a live slash command, not persistent model/effort state.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/codex\/fast$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('sendCodexFast', { tabId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }

  // Prompt-queue ("Run after") for a tab — read live core + sibling AI-tabs, or
  // apply one mutation op. Mobile mirrors the desktop store; the desktop runner
  // does the firing. GET returns { queue, aiTabs }; POST body { op, args } maps
  // 1:1 to a store method (see App.tsx::mutatePromptQueue). Live deltas arrive
  // separately via the `queue-update` SSE event.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/queue$/);
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
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/timeline$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const t0 = Date.now();
    const requestId = crypto.randomBytes(4).toString('hex');
    const timelinePrefix = `[WebTiming] /timeline rid=${requestId} tab=${shortId(tabId, 12)}`;
    const clearPending = startRoutePendingLog(timelinePrefix, t0);
    console.log(`${timelinePrefix} START`);
    try {
      const tBridge = Date.now();
      const info = await resolveAgentSessionInfo(tabId, 1500);
      const sessionId = info?.sessionId || null;
      const cwd = info?.cwd || null;
      const toolType = info?.toolType || null;
      if (!sessionId || !toolType) {
        clearPending();
        console.log(`${timelinePrefix} NO_SESSION bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
        return sendJson(res, 200, { entries: [] });
      }
      if (transcriptService && (toolType === 'codex' || toolType === 'claude')) {
        const timelineResult = await transcriptService.getTimeline({ tabId, toolType, sessionId, cwd });
        if (!timelineResult?.success) {
          clearPending();
          console.log(`${timelinePrefix} TRANSCRIPT_NO_TIMELINE tool=${toolType} bridge=${tBridge-t0}ms total=${Date.now()-t0}ms error=${String(timelineResult?.error || '-')}`);
          return sendJson(res, 200, { entries: [], sessionId, toolType });
        }
        const entries = timelineResult.entries || [];
        let fullEntries = [];
        if (entries.some(e => e?.type === 'compact' || e?.role === 'compact' || e?.kind === 'compact')) {
          try {
            if (toolType === 'codex') {
              const full = await transcriptService.getHistory({ tabId, toolType, sessionId, cwd });
              fullEntries = Array.isArray(full?.entries) ? full.entries : [];
            } else {
              const full = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
              fullEntries = Array.isArray(full?.entries) ? full.entries : [];
            }
          } catch (summaryErr) {
            console.log(`[WebTiming] /timeline TRANSCRIPT_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
          }
        }
        const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
        const tParse = Date.now();
        clearPending();
        console.log(`${timelinePrefix} DONE tool=${toolType} source=transcript entries=${mobileEntries.length} bridge=${tBridge-t0}ms parse=${tParse-tBridge}ms total=${tParse-t0}ms`);
        return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
      }
      if (toolType === 'codex') {
        if (!loadCodexSessionRecords || !buildCodexTimeline) {
          clearPending();
          return sendJson(res, 500, { error: 'codex timeline parser not loaded' });
        }
        const loaded = await loadCodexSessionRecords(sessionId, cwd);
        if (!loaded?.success) {
          clearPending();
          console.log(`${timelinePrefix} CODEX_NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
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
        clearPending();
        console.log(`${timelinePrefix} DONE tool=codex entries=${mobileEntries.length} bridge=${tBridge-t0}ms parse=${tParse-tBridge}ms total=${tParse-t0}ms`);
        return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
      }
      if (!parseTimelineEntries || !findSessionFile) {
        clearPending();
        return sendJson(res, 500, { error: 'timeline parser not loaded' });
      }
      const found = findSessionFile(sessionId, cwd);
      if (!found) {
        clearPending();
        console.log(`${timelinePrefix} NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
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
      clearPending();
      console.log(`${timelinePrefix} DONE tool=claude entries=${mobileEntries.length} bridge=${tBridge-t0}ms find=${tFind-tBridge}ms parse=${tParse-tFind}ms total=${tParse-t0}ms`);
      return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
    } catch (e) {
      clearPending();
      console.log(`${timelinePrefix} ERROR ${String(e.message)} total=${Date.now()-t0}ms`);
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
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/history$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const t0 = Date.now();
    const lastRaw = parsed.query.last;
    const lastN = lastRaw != null ? Math.max(1, Math.min(20000, parseInt(String(lastRaw), 10) || 0)) : null;
    const afterUuid = typeof parsed.query.after === 'string' ? parsed.query.after : null;
    const beforeUuid = typeof parsed.query.before === 'string' ? parsed.query.before : null;
    const aroundUuid = typeof parsed.query.around === 'string' ? parsed.query.around : null;
    const radiusRaw = parsed.query.radius;
    const aroundRadius = radiusRaw != null ? Math.max(1, Math.min(500, parseInt(String(radiusRaw), 10) || 80)) : 80;
    const wantHistoryEntries = parsed.query.view === 'history' || parsed.query.entries === '1';
    const wantNdjson = /\bapplication\/x-ndjson\b/.test(req.headers['accept'] || '') || parsed.query.ndjson === '1';
    console.log(`[WebTiming] /history START tabId=${tabId.slice(0, 24)} last=${lastN || 'all'} after=${afterUuid ? afterUuid.slice(0, 8) : 'none'} before=${beforeUuid ? beforeUuid.slice(0, 8) : 'none'} around=${aroundUuid ? aroundUuid.slice(0, 8) : 'none'} radius=${aroundRadius} view=${wantHistoryEntries ? 'history' : 'messages'} ndjson=${wantNdjson}`);
    try {
      if (wantHistoryEntries) {
        let data = null;
        if (transcriptService) {
          try {
            const info = await resolveAgentSessionInfo(tabId, 1500);
            if (info?.toolType === 'codex' && info?.sessionId) {
              data = await transcriptService.getHistory({
                tabId,
                toolType: info.toolType,
                sessionId: info.sessionId,
                cwd: info.cwd || null,
              });
              if (data?.success) {
                data = { ...data, toolType: info.toolType, commandType: info.toolType, sessionId: info.sessionId };
              } else {
                data = null;
              }
            }
          } catch (e) {
            console.log(`[WebTiming] /history TRANSCRIPT_HISTORY_SKIP ${String(e.message)}`);
          }
        }
        if (!data) data = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
        let entries = Array.isArray(data?.entries) ? data.entries : [];
        const total = entries.length;
        let dropped = 0;
        if (aroundUuid) {
          const idx = entries.findIndex((e) => e && e.uuid === aroundUuid);
          if (idx >= 0) {
            const start = Math.max(0, idx - aroundRadius);
            const end = Math.min(entries.length, idx + aroundRadius + 1);
            entries = entries.slice(start, end);
            dropped = total - entries.length;
          } else {
            entries = [];
            dropped = total;
          }
        } else if (afterUuid) {
          const idx = entries.findIndex((e) => e && e.uuid === afterUuid);
          entries = idx >= 0 ? entries.slice(idx + 1) : [];
        }
        if (!aroundUuid && beforeUuid) {
          const idx = entries.findIndex((e) => e && e.uuid === beforeUuid);
          entries = idx >= 0 ? entries.slice(0, idx) : [];
        }
        if (!aroundUuid && lastN && entries.length > lastN) {
          dropped = entries.length - lastN;
          entries = entries.slice(entries.length - lastN);
        }
        const truncated = dropped > 0;
        const firstUuid = entries.length ? (entries[0]?.uuid || null) : null;
        const lastUuid = entries.length ? (entries[entries.length - 1]?.uuid || null) : null;
        const etagSrc = entries.map((e) => `${e?.uuid || ''}:${e?.queueStatus || ''}:${e?.deliveryStatus || ''}`).join('|');
        const etag = crypto.createHash('sha1').update(etagSrc).digest('hex').slice(0, 16);
        console.log(`[WebTiming] /history DONE view=history tool=${data?.toolType || '-'} total=${total} returned=${entries.length} dropped=${dropped} around=${aroundUuid ? aroundUuid.slice(0, 8) : 'none'} ms=${Date.now()-t0}`);
        return sendJson(res, 200, { ...data, entries, total, truncated, dropped, etag, firstUuid, lastUuid });
      }

      let data = null;
      if (transcriptService) {
        try {
          const info = await resolveAgentSessionInfo(tabId, 1500);
          if (info?.toolType === 'codex' && info?.sessionId) {
            data = await transcriptService.getMessages({
              tabId,
              toolType: info.toolType,
              sessionId: info.sessionId,
              cwd: info.cwd || null,
            });
            if (data?.success) {
              data = { ...data, toolType: info.toolType, commandType: info.toolType, sessionId: info.sessionId };
            } else {
              data = null;
            }
          }
        } catch (e) {
          console.log(`[WebTiming] /history TRANSCRIPT_MESSAGES_SKIP ${String(e.message)}`);
        }
      }
      if (!data) data = await bridgeRequest('loadSDKHistory', { tabId });
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

function releaseTranscriptSubscriptionsIfOrphan() {
  if (!transcriptService) return;
  for (const [tid, consumerId] of webTranscriptSubscriptions) {
    const set = subscribers.get(tid);
    const hasLiveSubscriber = set && Array.from(set).some((sink) => sink?.isAlive?.());
    if (hasLiveSubscriber) continue;
    webTranscriptSubscriptions.delete(tid);
    transcriptService.unsubscribe({ consumerId }).catch(() => {});
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
const BCAST_LOG_TYPES = new Set(['snapshot', 'busy', 'done', 'bridge-update', 'queue-update', 'ask-question', 'question-cancelled', 'project-activity', 'orchestration-update']);
function webBroadcast(tabId, payload) {
  payload = withMessageProjection(payload);
  const type = payload && payload.type;
  const loggable = BCAST_LOG_TYPES.has(type);
  if (type === 'busy' || type === 'done') {
    void processOrchestrationLifecycle(tabId, payload);
  }
  const runId = externalRunByTabId.get(tabId);
  const run = runId ? externalRuns.get(runId) : null;
  try {
    if (run) {
      if (type === 'busy') {
        run.status = payload.busy ? 'running' : 'idle';
        setExternalRunMeta(tabId, { status: run.status, sessionId: payload.sessionId || run.sessionId || null });
      } else if (type === 'done') {
        run.status = 'done';
        run.completedAt = Date.now();
        run.sessionId = payload.sessionId || run.sessionId || null;
        setExternalRunMeta(tabId, {
          status: 'done',
          completedAt: run.completedAt,
          sessionId: run.sessionId || null,
          autoStopMs: run.autoStopMs,
          autoCloseMs: run.autoCloseMs,
        });
      } else if (type === 'message' && run.status === 'sending') {
        run.status = 'running';
        setExternalRunMeta(tabId, { status: 'running', sessionId: run.sessionId || null });
      }
    }
  } catch (e) {
    console.warn('[WebBcast:MetaError] tab=' + shortId(tabId, 12) + ' type=' + type + ' run=' + (runId || '-') + ' error=' + (e?.message || String(e)));
  }
  const set = subscribers.get(tabId);
  if (!set || set.size === 0) {
    if (loggable || type === 'message') console.log('[WebBcast:DROP] tab=' + shortId(tabId, 12) + ' type=' + type + summarizeBroadcastPayload(payload) + ' noSubscribers (registered=' + subscribers.size + ')');
    return;
  }
  const envelope = tabId === PROJECT_ACTIVITY_TOPIC ? payload : { tabId, ...payload };
  const msg = JSON.stringify(envelope);
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
  if (run && type === 'done') {
    try {
      scheduleExternalRunCompletionTimers(run, 'turn-done');
    } catch (e) {
      console.warn('[WebBcast:StopScheduleError] tab=' + shortId(tabId, 12) + ' run=' + runId + ' error=' + (e?.message || String(e)));
    }
  }
}

function broadcastProjectActivity(reason = 'event') {
  const set = subscribers.get(PROJECT_ACTIVITY_TOPIC);
  if (!set || set.size === 0) return false;
  const payload = projectActivitySnapshot(reason);
  webBroadcast(PROJECT_ACTIVITY_TOPIC, payload);
  return true;
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
const webTranscriptSubscriptions = new Map();
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

async function startTranscriptSubscriptionForTab(tabId) {
  if (!transcriptService || !tabId) return;
  let status;
  try {
    status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
  } catch (e) {
    console.warn('[TranscriptWebSub] status failed tabId=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
    return;
  }
  const toolType = status?.toolType || status?.commandType;
  const sessionId = status?.sessionId || status?.claudeSessionId || status?.codexSessionId;
  if (!sessionId || (toolType !== 'claude' && toolType !== 'codex')) return;
  const consumerId = 'web:' + tabId;
  try {
    await transcriptService.subscribe({
      tabId,
      consumerId,
      toolType,
      sessionId,
      cwd: status.cwd || null,
    });
    webTranscriptSubscriptions.set(tabId, consumerId);
  } catch (e) {
    console.warn('[TranscriptWebSub] subscribe failed tabId=' + shortId(tabId, 12) +
      ' tool=' + toolType +
      ' session=' + shortId(sessionId) +
      ' err=' + (e?.message || e));
  }
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
  webBroadcast(tabId, {
    type: 'snapshot',
    sessionId: status.sessionId,
    busy: status.status === 'busy',
    sessionStatus: status.status,
    starting: status.status === 'starting',
    stopping: status.status === 'stopping',
  });

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
        startTranscriptSubscriptionForTab(tabId).catch(() => {});
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe' && msg.tabId) {
            subscribe(msg.tabId, sink);
            sendInitialSnapshot(msg.tabId, sink, sdkSessions).catch(() => {});
            startClaudeTabWatcher(msg.tabId).catch(() => {});
            startTranscriptSubscriptionForTab(msg.tabId).catch(() => {});
          }
        } catch {}
      });
      ws.on('close', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); releaseTranscriptSubscriptionsIfOrphan(); });
      ws.on('error', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); releaseTranscriptSubscriptionsIfOrphan(); });
    });
  });
}

// ───────── lifecycle ─────────

function start({ sdkSessions, computeActiveLoaders: computeFn, computeProjectActivity: computeProjectActivityFn, answerClaudeQuestion: answerFn, getClaudePendingQuestion: getQFn, transcriptService: transcriptServiceFn, resolveCodexRuntimeSessionInfo: resolveCodexRuntimeFn, getAgentTurnResult: getAgentTurnResultFn }) {
  if (httpServer) {
    console.log('[WebServer] already started');
    return;
  }
  if (!sdkSessions) throw new Error('start({sdkSessions}) — Map of live SDK sessions required');
  computeActiveLoaders = computeFn || null;
  computeProjectActivity = computeProjectActivityFn || null;
  answerClaudeQuestion = answerFn || null;
  getClaudePendingQuestion = getQFn || null;
  transcriptService = transcriptServiceFn || null;
  resolveCodexRuntimeSessionInfo = resolveCodexRuntimeFn || null;
  getAgentTurnResult = getAgentTurnResultFn || null;
  token = loadOrCreateToken();
  registerBridgeReplyHandler();
  void getOrchestrationRunStore().initialize()
    .then(() => reconcileActiveOrchestrations())
    .catch((error) => console.warn('[Orchestration] startup recovery failed:', error?.message || error));

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
  if (transcriptService) {
    for (const consumerId of webTranscriptSubscriptions.values()) {
      transcriptService.unsubscribe({ consumerId }).catch(() => {});
    }
    webTranscriptSubscriptions.clear();
  }
  httpServer = null;
  wss = null;
  computeActiveLoaders = null;
  computeProjectActivity = null;
  answerClaudeQuestion = null;
  getClaudePendingQuestion = null;
  transcriptService = null;
  resolveCodexRuntimeSessionInfo = null;
  getAgentTurnResult = null;
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

function updateExternalRunSettings(payload = {}) {
  const tabId = cleanOptionalString(payload.tabId, '');
  const runId = cleanOptionalString(payload.runId, '') || (tabId ? externalRunByTabId.get(tabId) : '');
  const run = runId ? externalRuns.get(runId) : null;
  if (!run?.tabId) return { ok: false, error: 'run not found' };

  if (Object.prototype.hasOwnProperty.call(payload, 'autoStopMs')) {
    run.autoStopMs = clampAutoStopMs(payload.autoStopMs);
  } else {
    run.autoStopMs = clampAutoStopMs(run.autoStopMs);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'autoCloseMs')) {
    run.autoCloseMs = clampAutoCloseMs(payload.autoCloseMs);
  } else {
    run.autoCloseMs = clampAutoCloseMs(run.autoCloseMs);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'collapsed')) {
    run.collapsed = payload.collapsed === true;
  }

  clearExternalRunTimer(run, 'stopTimer');
  clearExternalRunTimer(run, 'closeTimer');
  run.autoStopAt = null;
  run.autoCloseAt = null;

  const meta = {
    runId: run.runId,
    tabId: run.tabId,
    status: run.status,
    autoStopMs: run.autoStopMs,
    autoStopAt: null,
    autoCloseMs: run.autoCloseMs,
    autoCloseAt: null,
    collapsed: !!run.collapsed,
  };
  setExternalRunMeta(run.tabId, meta);

  if (run.status === 'done' || run.status === 'idle') {
    scheduleExternalRunCompletionTimers(run, 'settings');
  } else if (run.status === 'stopped' || run.status === 'stop_failed') {
    scheduleExternalRunClose(run, 'settings');
  }

  return {
    ok: true,
    runId: run.runId,
    tabId: run.tabId,
    externalRun: {
      ...meta,
      autoStopAt: run.autoStopAt || null,
      autoCloseAt: run.autoCloseAt || null,
    },
  };
}

async function listOrchestrationRunsForTab(tabId) {
  return (await getOrchestrationRunStore().listForTab(tabId)).map(withOrchestrationUrls);
}

async function acknowledgeOrchestrationRun(runId, tabId) {
  const run = await getOrchestrationRunStore().acknowledge(runId, tabId);
  if (run) emitOrchestrationRun(run, 'acknowledged');
  return run ? withOrchestrationUrls(run) : null;
}

module.exports = {
  start,
  stop,
  webBroadcast,
  broadcastProjectActivity,
  getInfo,
  updateExternalRunSettings,
  listOrchestrationRunsForTab,
  acknowledgeOrchestrationRun,
  notifyClaudeSessionAvailable,
  sendTabCompletionPush,
};
