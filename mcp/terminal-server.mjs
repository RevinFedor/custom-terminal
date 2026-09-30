#!/usr/bin/env node
// =============================================================================
// MCP Terminal Server — one API-first surface for full Noted Terminal sessions
// Standalone process. Communicates with Noted Terminal via HTTP on localhost.
// Implements MCP JSON-RPC 2.0 over stdio (zero SDK dependencies).
//
// Live control, durable cross-tab delegation, transcript inspection/editing,
// task plans, and file linking all delegate to existing app/API scenarios.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import { buildStartAiRequest } from './terminal-start-ai-request.mjs';
import { buildPromptCatalog, buildPromptResult, selectPrompt } from './terminal-prompt-catalog.mjs';
const execFileAsync = promisify(execFile);

// Isolated dev/E2E instances publish both their MCP and Project API discovery
// files outside ~/.noted-terminal. Reads and mutations must resolve through
// the same directory; otherwise current_context/list_tabs hit dev while
// delegate_to_session/send_prompt silently jump to the production web API.
const PORT_DIR = process.env.NOTED_DISCOVERY_DIR
  ? resolve(process.env.NOTED_DISCOVERY_DIR)
  : join(homedir(), '.noted-terminal');
const TOKEN_PATH = join(PORT_DIR, 'web-token.txt');

// Resolve project CWD: --project /path, or CLAUDE_PROJECT_DIR, or cwd
const projectArgIdx = process.argv.indexOf('--project');
const PROJECT_CWD = (projectArgIdx !== -1 && process.argv[projectArgIdx + 1])
  ? process.argv[projectArgIdx + 1]
  : process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Authoritative project id, propagated from Electron main via Claude PTY env
// when this MCP server runs as a child of a Claude that was spawned inside
// Noted Terminal. When set, every HTTP call carries `parentProjectId` so main
// scopes list/create/run/kill/restart to this exact project — no cwd guessing.
// Empty string means: not pinned (legacy callers, helper scripts launched from
// /tmp, etc.). In that case routing falls back to cwd-based logic.
const EXTERNAL_MODE = process.env.NOTED_TERMINAL_EXTERNAL === '1' || process.argv.includes('--external');
const ENV_PARENT_PROJECT_ID = EXTERNAL_MODE ? '' : (process.env.NOTED_PARENT_PROJECT_ID || '');
const ENV_PARENT_TAB_ID = EXTERNAL_MODE ? '' : (process.env.NOTED_PARENT_TAB_ID || '');

// Per-request identity. Behind an MCP hub one shared process serves many AI
// sessions: the hub injects the caller's {tabId, projectId, cwd} into
// params._meta.noted and the dispatcher runs each request inside an
// AsyncLocalStorage scope carrying it. Direct stdio spawns (one process per
// session) have no _meta and keep using the env-derived values.
const requestIdentity = new AsyncLocalStorage();
function PARENT_TAB_ID() {
  const meta = requestIdentity.getStore();
  return (meta && meta.tabId) || ENV_PARENT_TAB_ID;
}
function PARENT_PROJECT_ID() {
  const meta = requestIdentity.getStore();
  return (meta && meta.projectId) || ENV_PARENT_PROJECT_ID;
}
function PROJECT_CWD_() {
  const meta = requestIdentity.getStore();
  return (meta && meta.cwd) || PROJECT_CWD;
}
function MAIN_PID_HINT() {
  const meta = requestIdentity.getStore();
  const fromMeta = parseInt((meta && meta.mainPid) || '', 10);
  if (fromMeta) return fromMeta;
  return parseInt(process.env.NOTED_MAIN_PID || '', 10);
}

process.stderr.write(`[terminal-server] Project CWD: ${PROJECT_CWD}\n`);
if (ENV_PARENT_PROJECT_ID) {
  process.stderr.write(`[terminal-server] parentProjectId: ${ENV_PARENT_PROJECT_ID} tabId: ${ENV_PARENT_TAB_ID}\n`);
}
if (EXTERNAL_MODE) {
  process.stderr.write('[terminal-server] external project discovery mode enabled\n');
}

// ---------------------------------------------------------------------------
// Port Discovery (same as mcp-server.mjs)
// ---------------------------------------------------------------------------

// Read every live port file and parse its JSON payload (port, pid, openProjectPaths).
// Backwards-compatible: legacy port files contained only the bare port number;
// treat that as { port, openProjectPaths: [] } and fall back to mtime selection.
function listLiveInstances() {
  const out = [];
  try {
    const files = readdirSync(PORT_DIR).filter(f => f.startsWith('mcp-port-'));
    for (const f of files) {
      const pid = parseInt(f.replace('mcp-port-', ''));
      if (!pid) continue;
      try { process.kill(pid, 0); } catch { continue; } // dead, skip
      const full = join(PORT_DIR, f);
      let raw;
      try { raw = readFileSync(full, 'utf-8').trim(); } catch { continue; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch { payload = { port: parseInt(raw), openProjectPaths: [] }; } // legacy
      if (!payload.port) continue;
      const mtime = (() => { try { return statSync(full).mtimeMs; } catch { return 0; } })();
      out.push({ ...payload, pid, mtime });
    }
  } catch {}
  return out;
}

function listLiveVoiceInstances() {
  const out = [];
  try {
    const files = readdirSync(PORT_DIR).filter(f => /^voice-web-server-\d+\.json$/.test(f));
    for (const f of files) {
      const pid = parseInt(f.match(/^voice-web-server-(\d+)\.json$/)?.[1] || '', 10);
      if (!pid) continue;
      try { process.kill(pid, 0); } catch { continue; }
      const full = join(PORT_DIR, f);
      let payload;
      try { payload = JSON.parse(readFileSync(full, 'utf-8').trim()); } catch { continue; }
      if (!payload.port) continue;
      const mtime = (() => { try { return statSync(full).mtimeMs; } catch { return 0; } })();
      out.push({ ...payload, pid, mtime });
    }
  } catch {}
  out.sort((a, b) => (b.updatedAt || b.mtime || 0) - (a.updatedAt || a.mtime || 0));
  return out;
}

function listLiveWebInstances() {
  const out = [];
  try {
    const files = readdirSync(PORT_DIR).filter(f => /^web-server-\d+\.json$/.test(f));
    for (const f of files) {
      const pid = parseInt(f.match(/^web-server-(\d+)\.json$/)?.[1] || '', 10);
      if (!pid) continue;
      try { process.kill(pid, 0); } catch { continue; }
      const full = join(PORT_DIR, f);
      let payload;
      try { payload = JSON.parse(readFileSync(full, 'utf-8').trim()); } catch { continue; }
      if (!payload.port) continue;
      const mtime = (() => { try { return statSync(full).mtimeMs; } catch { return 0; } })();
      out.push({ ...payload, pid, mtime });
    }
  } catch {}
  out.sort((a, b) => (b.updatedAt || b.mtime || 0) - (a.updatedAt || a.mtime || 0));
  return out;
}

function readSharedToken() {
  try { return readFileSync(TOKEN_PATH, 'utf-8').trim(); }
  catch { return ''; }
}

// Pick the instance that owns the requested cwd. Priority order:
//   1. NOTED_MAIN_PID env hint — Claude was spawned by exactly one Electron
//      main, its PTY env knows that main's PID. This wins unconditionally
//      because cwd-routing has ties when dev+prod both open the same cwd.
//   2. cwd longest-prefix match against each instance's openProjectPaths.
//   3. Most-recently-updated port file (fallback for tools running outside any
//      open project, e.g. from /tmp).
function pickInstance(cwd) {
  const instances = listLiveInstances();
  if (!instances.length) return null;
  // Priority 1: env-pinned main pid
  const hintPid = MAIN_PID_HINT();
  if (hintPid) {
    const pinned = instances.find(i => i.pid === hintPid);
    if (pinned) return pinned;
    // pinned pid not in live list — fall through, instance probably died
  }
  // Priority 2: cwd longest-prefix
  const target = cwd || PROJECT_CWD_();
  if (target) {
    let best = null;
    let bestLen = -1;
    for (const inst of instances) {
      for (const p of inst.openProjectPaths || []) {
        if (typeof p !== 'string' || !p) continue;
        if (target === p || target.startsWith(p + '/')) {
          if (p.length > bestLen) {
            bestLen = p.length;
            best = inst;
          }
        }
      }
    }
    if (best) return best;
  }
  // Priority 3: most-recent mtime
  instances.sort((a, b) => b.mtime - a.mtime);
  return instances[0];
}

function getPort(cwd) {
  const inst = pickInstance(cwd);
  return inst ? inst.port : null;
}

function projectNameFromPath(p) {
  if (typeof p !== 'string' || !p) return '';
  return basename(p) || p;
}

function listOpenProjects() {
  const projects = new Map();
  for (const inst of listLiveInstances()) {
    const rich = Array.isArray(inst.openProjects) ? inst.openProjects : [];
    const rows = rich.length
      ? rich
      : (Array.isArray(inst.openProjectPaths) ? inst.openProjectPaths : []).map(p => ({
        id: '',
        path: p,
        name: projectNameFromPath(p),
      }));
    for (const row of rows) {
      if (!row) continue;
      const id = typeof row.id === 'string' ? row.id : '';
      const path = typeof row.path === 'string' ? row.path : '';
      if (!id && !path) continue;
      const key = id || path;
      if (projects.has(key)) continue;
      projects.set(key, {
        id,
        path,
        name: typeof row.name === 'string' && row.name ? row.name : projectNameFromPath(path),
        port: inst.port,
        pid: inst.pid,
        isPackaged: !!inst.isPackaged,
        updatedAt: inst.updatedAt || 0,
      });
    }
  }
  return [...projects.values()].sort((a, b) => (a.name || a.path).localeCompare(b.name || b.path));
}

function findOpenProject({ projectId, cwd } = {}) {
  const projects = listOpenProjects();
  if (projectId) {
    return projects.find(p => p.id === projectId) || null;
  }
  if (cwd) {
    let best = null;
    let bestLen = -1;
    for (const p of projects) {
      if (!p.path) continue;
      if (cwd === p.path || cwd.startsWith(p.path + '/')) {
        if (p.path.length > bestLen) {
          best = p;
          bestLen = p.path.length;
        }
      }
    }
    return best;
  }
  return null;
}

function projectHint(args = {}, tabId) {
  const projectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID() || '';
  const decodedCwd = cwdFromTabId(tabId || args.tabId);
  const cwd = args.cwd || decodedCwd || PROJECT_CWD_();
  const project = findOpenProject({ projectId, cwd });
  return {
    projectId,
    cwd: project?.path || cwd,
    port: project?.port || null,
    pid: project?.pid || null,
  };
}

function resolveExternalCreateTarget(args = {}) {
  const explicitProjectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID() || '';
  if (explicitProjectId || args.cwd) return projectHint(args);
  if (!EXTERNAL_MODE) return projectHint(args);

  const projects = listOpenProjects();
  if (projects.length === 0) {
    throw new Error('Noted Terminal is not running or has no open projects. Open Noted Terminal, then call list_projects.');
  }
  if (projects.length > 1) {
    const list = projects.map(p => '- ' + (p.name || p.path || p.id) + (p.id ? ' (projectId: ' + p.id + ')' : '') + (p.path ? ' — ' + p.path : '')).join('\n');
    throw new Error('Multiple Noted Terminal projects are open. Pass projectId or cwd.\n' + list);
  }
  return { projectId: projects[0].id, cwd: projects[0].path || PROJECT_CWD_(), port: projects[0].port, pid: projects[0].pid || null };
}

function buildSourceMeta() {
  return {
    server: 'terminal',
    mode: EXTERNAL_MODE ? 'external' : 'internal',
    projectId: PARENT_PROJECT_ID() || '',
    tabId: PARENT_TAB_ID() || '',
    cwd: PROJECT_CWD_(),
  };
}

function qs(params) {
  const pairs = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}

async function liveSessionSnapshot(sessionId, cwd) {
  try {
    const result = await httpGet('/overseer/sessions', cwd);
    return (result.sessions || []).find((session) => session.sessionId === sessionId) || null;
  } catch (error) {
    return { lifecycleUnavailable: true, error: String(error?.message || error) };
  }
}

async function historyResultWithLifecycle(sessionId, cwd, result) {
  const lifecycle = await liveSessionSnapshot(sessionId, cwd);
  return {
    lifecycle,
    waitGate: lifecycle?.lifecycleUnavailable
      ? 'Lifecycle unavailable. Do not infer completion from stable transcript text.'
      : lifecycle?.busy
        ? 'BUSY: transcript blocks may still be partial.'
        : lifecycle
          ? 'NOT BUSY: the latest transcript state is complete.'
          : 'Session is not attached to an open tab; no live completion signal is available.',
    ...result,
  };
}

function simpleAgentCommand(command) {
  const c = typeof command === 'string' ? command.trim().toLowerCase() : '';
  if (c === 'claude' || c === 'codex') return c;
  return null;
}

// tabId format: <base64(projectPath)>-tab-<N> for path-derived projects, or
// <something>-tab-<N> for legacy `new_project_*` IDs. Try to decode the base64 prefix
// back to a filesystem path; if it's a valid path, use it to pick the instance.
function cwdFromTabId(tabId) {
  if (typeof tabId !== 'string') return null;
  const m = tabId.match(/^(.+)-tab-\d+$/);
  if (!m) return null;
  const prefix = m[1];
  // Filter to plausible base64
  if (!/^[A-Za-z0-9+/=]+$/.test(prefix)) return null;
  try {
    const decoded = Buffer.from(prefix, 'base64').toString('utf-8');
    // Path must start with / and contain printable chars only
    if (decoded.startsWith('/') && !/[^\x20-\x7e]/.test(decoded)) return decoded;
  } catch {}
  return null;
}

async function httpGet(endpoint, hintCwd) {
  const port = getPort(hintCwd);
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');

  return httpGetOnPort(port, endpoint);
}

async function httpGetOnPort(port, endpoint) {
  const res = await fetch('http://127.0.0.1:' + port + endpoint);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

async function httpPost(endpoint, body, hintCwd) {
  const port = getPort(hintCwd || (body && body.cwd));
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');

  return httpPostOnPort(port, endpoint, body);
}

async function httpPostOnPort(port, endpoint, body) {
  const res = await fetch('http://127.0.0.1:' + port + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

function pickWebInstance(target = {}) {
  const instances = listLiveWebInstances();
  if (!instances.length) throw new Error('Noted Terminal web server is not running (no live web-server-*.json in ' + PORT_DIR + ')');

  const hintPid = MAIN_PID_HINT();
  if (hintPid) {
    const pinned = instances.find(i => i.pid === hintPid);
    if (pinned) return pinned;
  }
  if (target.pid) {
    const pinned = instances.find(i => i.pid === target.pid);
    if (pinned) return pinned;
  }
  return instances[0];
}

function apiAuthHeaders() {
  const token = readSharedToken();
  if (!token) throw new Error('Shared web token not found at ' + TOKEN_PATH);
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  };
}

async function httpApiGet(target, endpoint) {
  const inst = pickWebInstance(target);
  const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
    headers: apiAuthHeaders(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error('HTTP ' + res.status + ': ' + (json.error || text));
    error.code = json.code;
    error.revision = json.revision;
    throw error;
  }
  return json;
}

async function httpApiPost(target, endpoint, body) {
  const inst = pickWebInstance(target);
  const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
    method: 'POST',
    headers: apiAuthHeaders(),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

async function httpApiPatch(target, endpoint, body) {
  const inst = pickWebInstance(target);
  const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
    method: 'PATCH',
    headers: apiAuthHeaders(),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error('HTTP ' + res.status + ': ' + (json.error || text));
    error.code = json.code;
    error.revision = json.revision;
    error.prompt = json.prompt;
    throw error;
  }
  return json;
}

async function httpPromptLibraryMutation(target, method, endpoint, body) {
  const inst = pickWebInstance(target);
  const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
    method,
    headers: apiAuthHeaders(),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    if (json.code === 'app_update_required' || (res.status === 404 && !json.code)) {
      throw new Error('This Noted Terminal instance does not support saved-prompt mutation yet; install a build containing the prompt-library API. No fallback whole-library save was attempted.');
    }
    const error = new Error('HTTP ' + res.status + ': ' + (json.error || text));
    error.code = json.code;
    error.revision = json.revision;
    error.prompt = json.prompt;
    error.group = json.group;
    throw error;
  }
  return json;
}

async function readPromptCatalog(target) {
  try {
    return { payload: await httpApiGet(target, '/api/prompt-library'), legacy: false };
  } catch (error) {
    if (!/HTTP 404/.test(error?.message || '') || error?.code) throw error;
    // Pre-update installs only expose this legacy full-library read route.
    return { payload: await httpApiGet(target, '/api/prompts'), legacy: true };
  }
}

async function observeVoiceInstallOwner(instance) {
  if (!Number.isInteger(instance?.pid) || instance.pid <= 0
    || !Number.isInteger(instance?.port) || instance.port <= 0 || instance.port > 65535) return false;
  try {
    // These discovery files predate isPackaged metadata. A live PID alone is
    // insufficient: old files can point at a reused browser/system PID, and a
    // fresh private Electron dev is not the durable production install owner.
    const command = await execFileAsync('/bin/ps', ['-p', String(instance.pid), '-o', 'comm='], { timeout: 2000 });
    if (command.stdout.trim() !== '/Applications/Voice Record.app/Contents/MacOS/Voice Record') return false;
    const listener = await execFileAsync('/usr/sbin/lsof', [
      '-nP', '-a', '-p', String(instance.pid), '-iTCP:' + instance.port, '-sTCP:LISTEN', '-Fp',
    ], { timeout: 2000 });
    return listener.stdout.split(/\r?\n/).includes('p' + instance.pid);
  } catch { return false; }
}

async function selectVoiceInstallInstance() {
  const candidates = listLiveVoiceInstances();
  const observed = await Promise.all(candidates.map(async instance =>
    await observeVoiceInstallOwner(instance) ? instance : null));
  const unique = new Map(observed.filter(Boolean).map(instance => [instance.pid + ':' + instance.port, instance]));
  if (unique.size !== 1) {
    throw new Error('Voice Record production installer must have one verified installed process and listening port; found '
      + unique.size + '. Private dev instances and stale discovery files are not install targets.');
  }
  return [...unique.values()][0];
}

async function httpPostVoice(endpoint, body) {
  const token = readSharedToken();
  if (!token) throw new Error('Shared web token not found at ' + TOKEN_PATH);
  const inst = await selectVoiceInstallInstance();
  // A possibly dispatched install must not fall through to a second app after
  // HTTP/transport failure. Read this exact owner's job before any new request.
  const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('Voice Record pid=' + inst.pid + ' port=' + inst.port
    + ' HTTP ' + res.status + ': ' + (json.error || text));
  return { port: inst.port, pid: inst.pid, body: json };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

const WINDOW_TARGET_SCHEMA = {
  type: 'object',
  description: 'Where a tab/window belongs. Defaults resolve from the full session that called Terminal MCP, never from the user\'s unrelated last click.',
  properties: {
    spaceId: { type: 'string', description: 'Exact workflow id from list_windows. Omit to use the source tab workflow.' },
    space: { type: 'string', enum: ['source', 'active'], description: 'Use the source tab workflow (default) or the workflow currently visible to the user.' },
    anchor: { type: 'string', enum: ['source', 'focused'], description: 'Use the window containing the source tab (default) or the saved focused window of the selected workflow.' },
    anchorTabId: { type: 'string', description: 'Use the window that contains this exact tab as the anchor.' },
    windowRef: { type: 'string', description: 'Opaque exact window reference returned by list_windows; stale refs fail instead of addressing a different window.' },
    windowIndex: { type: 'integer', description: 'Compatibility window index from list_windows. Prefer windowRef.' },
    mode: { type: 'string', enum: ['same-window', 'new-window'], description: 'Add to the anchor window (default) or create a separate window relative to it.' },
    side: { type: 'string', enum: ['right', 'left', 'above', 'below'], description: 'For new-window: right/left creates a column; above/below creates a row in the anchor column.' },
    insertIndex: { type: 'integer', description: 'Exact chip insertion index. Default is immediately after the source tab when it is in the target window, otherwise the end.' },
    reveal: { type: 'boolean', description: 'Switch the visible workflow/focus to the result. Default false; background work must not steal the UI.' },
  },
};

const CONTEXT_FILES_SCHEMA = {
  type: 'array',
  maxItems: 16,
  description: 'Optional local text files resolved by Noted Terminal at send time. The caller passes paths only; file bodies never enter the caller model context.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or a path relative to the calling full session cwd.' },
      role: {
        type: 'string',
        enum: ['source', 'instructions'],
        description: 'source preserves UTF-8 text; instructions additionally expands @include and removes @ai/transclude metadata.',
      },
      label: { type: 'string', description: 'Optional visible file-chip label. Defaults to the basename.' },
    },
    required: ['path'],
  },
};

const MODEL_SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['catalog', 'custom'],
      description: 'catalog selects an exact current catalog entry; custom passes an intentional user-supplied runtime id.',
    },
    id: { type: 'string', description: 'Exact catalog selection id or intentional custom runtime id.' },
  },
  required: ['kind', 'id'],
};

const EXTERNAL_RESEARCH_FILES_SCHEMA = {
  type: 'array',
  maxItems: 1000,
  description: 'Local files uploaded by SC Desktop. Pass paths/ranges only; this MCP does not read file bodies into the calling model context.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or a path relative to the calling full session cwd.' },
      startLine: { type: 'integer', minimum: 1, description: 'Optional inclusive 1-based first line.' },
      endLine: { type: 'integer', minimum: 1, description: 'Optional inclusive 1-based last line.' },
      lines: { type: 'string', description: 'Optional compact inclusive range such as 10-80.' },
      name: { type: 'string', description: 'Optional upload name.' },
    },
    required: ['path'],
  },
};

const EXTERNAL_RESEARCH_OPTIONS_SCHEMA = {
  type: 'object',
  description: 'Provider-owned SC Desktop options. Omitted values keep SC Desktop defaults; do not guess model ids.',
  properties: {
    mode: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    thinking: { type: 'boolean' },
    research: { type: 'boolean' },
    sources: { type: 'boolean' },
    speed: { type: 'string' },
    temporaryChat: { type: 'boolean' },
    autoClose: { type: 'boolean' },
    systemInstruction: { type: 'string' },
  },
  additionalProperties: true,
};

const EXTERNAL_CONVERSATION_IMPORT_PROMPT = '[SC internal read-only conversation import] Return the already existing final result without sending any message to the provider.';

function normalizeChatGPTConversationImportUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('A valid ChatGPT conversation URL is required'); }
  if (url.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) {
    throw new Error('ChatGPT conversation URL must be on https://chatgpt.com');
  }
  if (!/^\/c\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('ChatGPT conversation URL must look like https://chatgpt.com/c/<conversation-id>');
  }
  url.protocol = 'https:';
  url.hostname = 'chatgpt.com';
  url.port = '';
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}

function externalResearchFilesForApi(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error('files must be an array');
  return value.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('each file must be an object with path');
    const requestedPath = String(file.path || '').trim();
    if (!requestedPath) throw new Error('each file needs a path');
    return {
      path: resolve(PROJECT_CWD_(), requestedPath),
      ...(file.startLine != null ? { startLine: Number(file.startLine) } : {}),
      ...(file.endLine != null ? { endLine: Number(file.endLine) } : {}),
      ...(String(file.lines || '').trim() ? { lines: String(file.lines).trim() } : {}),
      ...(String(file.name || '').trim() ? { name: String(file.name).trim() } : {}),
    };
  });
}

function contextFilesForApi(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error('files must be an array');
  return value.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('each file must be an object with path');
    const requestedPath = String(file.path || '').trim();
    if (!requestedPath) throw new Error('each file needs a path');
    const role = String(file.role || 'source').trim();
    if (role !== 'source' && role !== 'instructions') {
      throw new Error('file role must be source or instructions');
    }
    return {
      path: resolve(PROJECT_CWD_(), requestedPath),
      role,
      ...(String(file.label || '').trim() ? { label: String(file.label).trim() } : {}),
    };
  });
}

async function contextFilesForSupportedTarget(target, value) {
  const files = contextFilesForApi(value);
  if (!files || files.length === 0) return files;
  let capabilities;
  try {
    capabilities = await httpApiGet(target, '/api/me');
  } catch (error) {
    throw new Error(
      'Cannot verify server-resolved context files on the target Noted Terminal backend. '
      + 'Nothing was sent. Restart/update Noted Terminal before retrying. '
      + String(error?.message || error),
    );
  }
  if (Number(capabilities?.capabilities?.contextFiles?.version) !== 1) {
    throw new Error(
      'The target Noted Terminal backend does not support server-resolved context files. '
      + 'Nothing was sent. Restart/update Noted Terminal before retrying.',
    );
  }
  return files;
}

async function ensureAgentModelSelectionSupport(target, args) {
  if (!args?.modelSelection) return;
  const capabilities = await httpApiGet(target, '/api/me');
  if (Number(capabilities?.capabilities?.agentModelSelection?.version) !== 1) {
    throw new Error(
      'This Noted Terminal instance does not support typed agent model selection. '
      + 'Nothing was created or sent. Rebuild/reinstall the app before retrying.',
    );
  }
}

async function ensureExternalResearchOrchestrationSupport(target) {
  const capabilities = await httpApiGet(target, '/api/me');
  if (Number(capabilities?.capabilities?.externalResearchOrchestration?.version) !== 1) {
    throw new Error(
      'This Noted Terminal instance does not support tracked external research orchestration. '
      + 'Nothing was started. Rebuild/reinstall the app before retrying.',
    );
  }
}

const STRUCTURED_JSON_TOOLS = new Set([
  'get_tab_context', 'list_tab_contexts', 'set_tab_responsibility', 'publish_context_update',
  'current_context',
  'list_agent_models',
  'list_windows',
  'create_tab',
  'create_window',
  'open_tabs_in_window',
  'arrange_windows',
  'fork_tab',
  'delegate_to_session',
  'start_external_research',
  'import_external_conversation',
  'continue_external_research',
]);

const TOOLS = [
  {
    name: 'get_tab_context',
    description: 'Read a tab responsibility, linked working Markdown files, and pending context updates. Does not launch or message the agent. Omit tabId for this full session. Before updating another tab, edit its linked Markdown when present; otherwise publish_context_update to that other tab. Reading your own tab with no linked Markdown is not a reason to publish an update to yourself.',
    inputSchema: { type: 'object', properties: {
      tabId: { type: 'string' }, projectId: { type: 'string' }, cwd: { type: 'string' },
    } },
  },
  {
    name: 'list_tab_contexts',
    description: 'Discover tabs by their user-assigned responsibility (область ответственности), including linked Markdown paths and pending update summaries. Defaults to the caller workflow; pass allWorkflows=true to inspect all persisted tabs. This reads metadata only, never transcripts and never starts agents.',
    inputSchema: { type: 'object', properties: {
      spaceId: { type: 'string', description: 'Explicit workflow id, otherwise use the caller placement.' },
      allWorkflows: { type: 'boolean', description: 'Return every tab instead of only the caller workflow.' },
      projectId: { type: 'string' }, cwd: { type: 'string' },
    } },
  },
  {
    name: 'set_tab_responsibility',
    description: 'Set the tab область ответственности as plain text agreed with the user. Omit tabId to describe this session. Another tab may be addressed when the user asks an orchestrator to assign responsibilities. This persists metadata and does not send a prompt.',
    inputSchema: { type: 'object', properties: {
      tabId: { type: 'string' }, projectId: { type: 'string' },
      description: { type: 'string', maxLength: 12000, description: 'User-agreed scope, exclusions and important feature relationships. Empty string clears it.' },
    }, required: ['description'] },
  },
  {
    name: 'publish_context_update',
    description: 'Queue a working-state update for ANOTHER tab WITHOUT sending a message or waking an agent. The target must differ from current_context.tabId; self-updates are rejected, including when your own tab has no linked Markdown. Describe a new fact that affects the target responsibility, not a report to yourself. The orange chip attaches to the target next real prompt. Prefer editing its linked working Markdown when present. requestId deduplicates exact retries.',
    inputSchema: { type: 'object', properties: {
      tabId: { type: 'string' }, projectId: { type: 'string' },
      title: { type: 'string', description: 'Short change label.' },
      text: { type: 'string', maxLength: 100000, description: 'What changed, why it affects this tab, and any remaining constraints. Do not ask the target to start work now.' },
      requestId: { type: 'string', description: 'Optional stable id for this exact update.' },
    }, required: ['tabId', 'text'] },
  },
  {
    name: 'list_projects',
    description: 'List live Noted Terminal projects visible to the MCP bridge. Use this first when the caller is an external app (for example Voice Record) and there is no parent terminal tab/project.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_agent_models',
    description: 'Read the live Claude/Codex model catalog from Noted Terminal. Before a model-specific create or send, use one returned id in modelSelection:{kind:"catalog",id}. Custom runtime ids are intentionally absent and use kind:"custom" only when the user explicitly supplied one.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional project id used to select the running Noted Terminal instance.' },
        cwd: { type: 'string', description: 'Optional project path used to select the running Noted Terminal instance.' },
      },
    },
  },
  {
    name: 'list_prompts',
    description: 'List the saved prompts currently available to the user in Noted Terminal. Returns a compact catalog only: title, group, ids, attached-file count, and text lengths. It never returns all prompt bodies. Use get_prompt to read one selected prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter by prompt title or group name.' },
        projectId: { type: 'string', description: 'Optional project id used to select the correct running Noted Terminal instance.' },
        cwd: { type: 'string', description: 'Optional project path used to select the correct running Noted Terminal instance.' },
      },
    },
  },
  {
    name: 'get_prompt',
    description: 'Read one saved Noted Terminal prompt. Select it by promptId (preferred) or exact title. mode="own" returns only the prompt\'s own short instruction and attached file paths; mode="resolved" returns the live Prompt API\'s assembled inline/mobile text with readable attached-file contents. Reading a prompt does not mean applying it as instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        promptId: { type: 'string', description: 'Stable prompt id returned by list_prompts.' },
        title: { type: 'string', description: 'Exact prompt title. Use promptId when titles are duplicated.' },
        mode: { type: 'string', enum: ['own', 'resolved'], description: 'Default resolved. own excludes attached-file contents from model output; resolved returns the API-assembled inline/mobile text. Unreadable linked files can be omitted and are listed in filePaths.' },
        projectId: { type: 'string', description: 'Optional project id used to select the correct running Noted Terminal instance.' },
        cwd: { type: 'string', description: 'Optional project path used to select the correct running Noted Terminal instance.' },
      },
      anyOf: [{ required: ['promptId'] }, { required: ['title'] }],
    },
  },
  {
    name: 'update_prompt',
    description: 'Update one saved Noted Terminal prompt by stable promptId. Read it first with get_prompt and pass its revision; a stale revision is rejected without changing the prompt. title, text, filePaths and position are optional individually; use move_prompt for group or parent changes. Neighbouring prompts are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        promptId: { type: 'string', description: 'Stable prompt id returned by get_prompt.' },
        revision: { type: 'string', description: 'Exact revision returned by get_prompt.' },
        title: { type: 'string', description: 'Replacement title. May contain punctuation including /.' },
        text: { type: 'string', description: 'Replacement own prompt text; attached files are not changed.' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Replacement linked-file list.' },
        position: { type: 'integer', minimum: 0, description: 'Zero-based insertion index among the current siblings, matching Settings order.' },
        projectId: { type: 'string', description: 'Optional project id used to select the correct running Noted Terminal instance.' },
        cwd: { type: 'string', description: 'Optional project path used to select the correct running Noted Terminal instance.' },
      },
      required: ['promptId', 'revision'],
    },
  },
  {
    name: 'list_prompt_catalog',
    description: 'List the saved-prompt library without prompt bodies or resolved attached files. Returns groups and compact prompt metadata including stable ids and revisions.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'read_prompts',
    description: 'Read an explicit selected set of saved prompts. This never reads the whole library by default. mode="own" excludes attached-file bodies; mode="resolved" returns the same assembled text used for insertion.',
    inputSchema: { type: 'object', properties: { promptIds: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['own', 'resolved'] }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['promptIds'] },
  },
  {
    name: 'create_prompt',
    description: 'Create one saved prompt. stableId is optional; title, text, filePaths, groupId, parentPromptId and position match Settings fields. position is a zero-based insertion index among siblings. A child inherits its parent group.',
    inputSchema: { type: 'object', properties: { stableId: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, groupId: { type: ['number', 'null'] }, parentPromptId: { type: ['string', 'null'] }, position: { type: 'integer', minimum: 0 }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'move_prompt',
    description: 'Move or reparent a saved prompt by stable id. position is a zero-based insertion index among the destination siblings; omitted parentPromptId preserves the current parent, while explicit null detaches it. Moving a parent moves its whole subtree to the same group. Pass the current revision; missing parents, cycles, and cross-group links are rejected.',
    inputSchema: { type: 'object', properties: { promptId: { type: 'string' }, revision: { type: 'string' }, groupId: { type: ['number', 'null'] }, parentPromptId: { type: ['string', 'null'] }, position: { type: 'integer', minimum: 0 }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['promptId', 'revision'] },
  },
  {
    name: 'delete_prompt',
    description: 'Delete one saved prompt with revision CAS. Settings semantics apply: direct children become roots; deeper descendants remain under their immediate parent.',
    inputSchema: { type: 'object', properties: { promptId: { type: 'string' }, revision: { type: 'string' }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['promptId', 'revision'] },
  },
  {
    name: 'create_prompt_group',
    description: 'Create a saved-prompt group. position is a zero-based insertion index among groups. Groups use their persistent numeric id as the stable group id.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, position: { type: 'integer', minimum: 0 }, isCollapsed: { type: 'boolean' }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'get_prompt_group',
    description: 'Read one saved-prompt group and its revision.',
    inputSchema: { type: 'object', properties: { groupId: { type: 'number' }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['groupId'] },
  },
  {
    name: 'update_prompt_group',
    description: 'Update one saved-prompt group with revision CAS. position is a zero-based insertion index among groups; name, description and isCollapsed match Settings fields.',
    inputSchema: { type: 'object', properties: { groupId: { type: 'number' }, revision: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, position: { type: 'integer', minimum: 0 }, isCollapsed: { type: 'boolean' }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['groupId', 'revision'] },
  },
  {
    name: 'delete_prompt_group',
    description: 'Delete one saved-prompt group with revision CAS. Settings semantics apply: its prompts become ungrouped while their parent-child links remain.',
    inputSchema: { type: 'object', properties: { groupId: { type: 'number' }, revision: { type: 'string' }, projectId: { type: 'string' }, cwd: { type: 'string' } }, required: ['groupId', 'revision'] },
  },
  {
    name: 'list_tabs',
    description: 'List terminal tabs. In Claude/Codex inside Noted Terminal, this is scoped to the parent project. In external mode (Voice Record), omit projectId/cwd to list tabs across all open Noted Terminal projects, or pass projectId/cwd to scope one project. By default returns only green devServer tabs; pass color="" to see all tabs. AI tabs include sessionId for the history tools in this same MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        color: {
          type: 'string',
          description: 'Filter by tab color. Default: "green" (devServer tabs). Pass empty string for all tabs. Options: green, claude, gemini, default, red, blue, yellow, purple.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Noted Terminal project id from list_projects. Preferred in external mode.',
        },
        cwd: {
          type: 'string',
          description: 'Optional project path / cwd to scope the tab list.',
        },
        allProjects: {
          type: 'boolean',
          description: 'When true, list tabs across every open Noted Terminal project.',
        },
      },
    },
  },
  {
    name: 'current_context',
    description: 'Return the Noted Terminal project, tab, cwd, and known AI session for the full session that owns this MCP process. Use this when the user says "this tab", asks the session to rename itself, or wants to attach a file to itself. Outside Noted Terminal the parent identifiers are unavailable and explicit projectId/tabId must be used.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'complete_task',
    description: 'Loop-only completion acknowledgement. Call exactly once near the end only when THIS current user turn contains the app-injected terminal_task_completion_protocol and the repeated task is genuinely complete. Never call it for an ordinary/manual request, a normal delegation result, or merely because the tool/global instructions mention task completion. The backend rejects turns not proven to originate from Prompt Queue Loop. Active child Terminal MCP delegations, partial work, waiting, and errors also block completion.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'rename_tab',
    description: 'Rename an open Noted Terminal tab through the Project API. Inside a full Noted Terminal session, omit tabId to rename the current tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Optional target tab. Defaults to the full session that owns this MCP process.' },
        name: { type: 'string', description: 'New visible tab name.' },
        projectId: { type: 'string', description: 'Optional project id for external or cross-project calls.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close an open Noted Terminal tab through the Project API. Use this after get_delegation_result for a one-off full-session test that will not be reused. Idle tabs close normally; force=true is only for an explicitly approved close while the agent is still busy.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Target tab to close.' },
        projectId: { type: 'string', description: 'Optional project id for external or cross-project calls.' },
        force: { type: 'boolean', description: 'Allow closing a busy/streaming AI tab. Default false.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'link_file',
    description: 'Attach an existing file as a purple child tab under an open AI session, using the same hierarchy as desktop drag-and-drop. Inside a full Noted Terminal session, omit tabId to attach to itself. Passing another tabId attaches to that session, including across open projects. Repeating the same file+parent operation reuses the existing child.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing file path. Relative paths resolve from the MCP project cwd.' },
        tabId: { type: 'string', description: 'Optional target AI tab. Defaults to the full session that owns this MCP process.' },
        projectId: { type: 'string', description: 'Optional project id for external or cross-project calls.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delegate_to_session',
    description: 'Start a persistent cross-tab delegation through the Project API. `files` sends local UTF-8 text as server-resolved context snapshots; pass paths and roles only, never read large bodies into this caller context. This is for a separate visible Claude/Codex session, not for a temporary internal subagent. It returns immediately with a durable runId; only a non-empty runId proves success, while an error, null, or missing runId means nothing was sent and must be reported as failure. The source tab receives one completion notification, and get_delegation_result reads the final outcome in one request. A delegation created by an executor is linked to that executor run automatically and waits for nested Terminal MCP delegations by default.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task sent to the target full session.' },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional saved Noted Terminal prompt ids or exact titles. The Project API resolves their bodies at send time and attaches them as prompt chips without returning the bodies to this caller.',
        },
        files: CONTEXT_FILES_SCHEMA,
        sourceTabId: { type: 'string', description: 'Optional source tab. Defaults to the session that owns this MCP process.' },
        targetTabId: { type: 'string', description: 'Existing target AI tab. Mutually exclusive with creating via targetProjectId.' },
        targetProjectId: { type: 'string', description: 'Project where a new target session should be created.' },
        cwd: { type: 'string', description: 'Explicit working-directory override for a newly created target. Omit unless the user requested another directory; a same-project child inherits the source tab cwd.' },
        windowTarget: WINDOW_TARGET_SCHEMA,
        toolType: { type: 'string', enum: ['claude', 'codex'], description: 'Provider for a newly created target. Default claude.' },
        name: { type: 'string', description: 'Visible name for a newly created target tab.' },
        label: { type: 'string', description: 'Short orchestration label shown in the source/target UI.' },
        modelSelection: MODEL_SELECTION_SCHEMA,
        model: { type: 'string', description: 'Legacy literal model field retained for older callers. New model-specific calls must use modelSelection.' },
        effort: { type: 'string', description: 'Optional Codex effort override.' },
        thinking: { type: 'string', description: 'Optional Claude thinking mode.' },
        placement: { type: 'string', enum: ['child', 'root'], description: 'Placement for a newly created target. Default child when source and target are in the same project; use root for an independent session.' },
        parentTabId: { type: 'string', description: 'Optional explicit visual parent for a newly created target in the target project.' },
        forkFromTabId: { type: 'string', description: 'Optional open Claude/Codex tab whose history should seed the new target. The default is a fork from its latest real compact; the child keeps the source provider and cwd.' },
        fullHistoryFork: { type: 'boolean', description: 'Default false. When forkFromTabId is set, copy the full source history instead of starting at its latest compact. Use only when the user explicitly requests the full history.' },
        compactBeforeTask: { type: 'boolean', description: 'Default false. After the fork is ready, run one exact native /compact and wait for its completion before the task prompt may cross Enter.' },
        parentRunId: { type: 'string', description: 'Optional explicit orchestration parent. Normally inferred from the source tab active run.' },
        waitForDescendants: { type: 'boolean', description: 'Default true. Keep the parent run active until nested Terminal MCP delegations are consumed. Set false only when an early report is intentional.' },
        notifySource: { type: 'boolean', description: 'Default true. Queue one short completion notification in the source input.' },
        queue: { type: 'boolean', description: 'Default true. Queue on a busy target instead of failing.' },
        runId: { type: 'string', description: 'Optional idempotency key.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'start_external_research',
    description: 'Start a tracked browser consultation through SC Desktop without creating a Claude/Codex tab. Returns quickly with a durable runId; finish the current turn after acceptance. Noted Terminal waits in the background, shows the run in the existing orchestration UI, and sends one short completion notification to this source session. Read the full answer exactly once with get_delegation_result after that notification. An existing untracked ChatGPT link may be passed as conversationUrl to send a new question there. For a persistent ChatGPT review conversation pass options:{mode:"chat",temporaryChat:false,autoClose:true}; model and effort remain explicit caller choices.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task for the browser model. File bodies belong in files, not in this text.' },
        provider: { type: 'string', enum: ['chatgpt', 'claude', 'perplexity'], description: 'SC Desktop provider. Default chatgpt.' },
        options: EXTERNAL_RESEARCH_OPTIONS_SCHEMA,
        files: EXTERNAL_RESEARCH_FILES_SCHEMA,
        conversationUrl: { type: 'string', description: 'Optional existing ChatGPT conversation URL. Prefer continue_external_research when continuing a prior tracked run.' },
        sourceTabId: { type: 'string', description: 'Optional source tab; defaults to the full session calling this tool.' },
        label: { type: 'string', description: 'Short label for the orchestration tracker.' },
        parentRunId: { type: 'string', description: 'Optional exact causal parent; normally inferred from the current source turn.' },
        waitForDescendants: { type: 'boolean', description: 'Default true, preserving the current orchestration descendant gate.' },
        notifySource: { type: 'boolean', description: 'Default true. Deliver one short completion/failure notification without replacing a foreign draft.' },
        runId: { type: 'string', minLength: 2, maxLength: 194, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]+$', description: 'Optional Noted Terminal idempotency key. The SC job gets a deterministic separate jobId.' },
        projectId: { type: 'string' },
        cwd: { type: 'string', description: 'Optional project cwd used only to locate the owning Noted Terminal instance.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'continue_external_research',
    description: 'Send a new question and current file versions to the same ChatGPT conversation as one completed external-research run. This always creates a new runId and SC jobId; previousRunId supplies only the durable conversation identity and default provider/options, so the old answer can never be returned as the new review. After acceptance finish the current turn, then read the result once through get_delegation_result when notified.',
    inputSchema: {
      type: 'object',
      properties: {
        previousRunId: { type: 'string', description: 'Completed tracked run whose conversationUrl should be continued.' },
        prompt: { type: 'string', description: 'New follow-up question.' },
        options: EXTERNAL_RESEARCH_OPTIONS_SCHEMA,
        files: EXTERNAL_RESEARCH_FILES_SCHEMA,
        sourceTabId: { type: 'string', description: 'Optional source tab; defaults to this full session.' },
        label: { type: 'string' },
        parentRunId: { type: 'string' },
        waitForDescendants: { type: 'boolean' },
        notifySource: { type: 'boolean' },
        runId: { type: 'string', minLength: 2, maxLength: 194, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]+$', description: 'Optional new idempotency key. Must not reuse previousRunId.' },
        projectId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['previousRunId', 'prompt'],
    },
  },
  {
    name: 'import_external_conversation',
    description: 'Import the current final answer from an existing ChatGPT conversation URL as a tracked read-only run. Nothing is pasted or sent to ChatGPT. The tool returns a durable runId/jobId, then the normal completion notification and one get_delegation_result deliver the result. Repeat the same runId only to recover the same import; use a new runId after the conversation receives a newer answer.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Existing URL in the form https://chatgpt.com/c/<conversation-id>.' },
        waitForFinal: { type: 'boolean', description: 'Default false. If true, keep observing the existing conversation for up to timeoutMs instead of failing when its current user-turn has no final yet.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000, description: 'Only with waitForFinal. Default 1800000 (30 minutes).' },
        sources: { type: 'boolean', description: 'Include the source list in result.text. Structured sources are retained regardless.' },
        includeActivity: { type: 'boolean', description: 'Default false. Include potentially very large provider tool/activity details for forensic use.' },
        autoClose: { type: 'boolean', description: 'Default true. Close only the dedicated import tab after SC confirms the local result.' },
        sourceTabId: { type: 'string', description: 'Optional source tab; defaults to this full session.' },
        label: { type: 'string', description: 'Short label for the orchestration tracker.' },
        parentRunId: { type: 'string' },
        waitForDescendants: { type: 'boolean' },
        notifySource: { type: 'boolean' },
        runId: { type: 'string', minLength: 2, maxLength: 194, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]+$', description: 'Optional idempotency key for this exact URL import.' },
        projectId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_delegation',
    description: 'Read the durable status of one cross-tab delegation. Prefer the completion notification over repeated polling; call this for an explicit status check or after restart.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        cwd: { type: 'string', description: 'Optional project cwd used to locate the owning app instance.' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_delegation_result',
    description: 'Read the final answer or terminal failure for a full-session delegation or tracked external research run in one request. External research also returns jobId, conversationUrl and its structured SC result. A 202 response means the result is not ready; wait for the source completion notification instead of polling in a loop.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        maxChars: { type: 'integer', description: 'Maximum answer characters, default 100000 and max 250000.' },
        cwd: { type: 'string', description: 'Optional project cwd used to locate the owning app instance.' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'cancel_delegation',
    description: 'Cancel a durable delegation. By default only the run is cancelled; set interrupt=true to also soft-interrupt the target turn.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        interrupt: { type: 'boolean' },
        cwd: { type: 'string', description: 'Optional project cwd used to locate the owning app instance.' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'list_open_sessions',
    description: 'Read the live lifecycle of open Claude/Codex sessions: tab identity, model, context usage, and authoritative busy/status state. This is a status tool, not transcript search. When the user asks where a topic/feature appeared, call search_sessions first instead of list_open_sessions followed by list_turns across candidates. A response is complete only when busy=false or the lifecycle reports a terminal completion event.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional cwd to choose a Noted Terminal instance.' },
      },
    },
  },
  {
    name: 'search_sessions',
    description: 'Primary tool for questions like "where / in which tab / on which iteration did I discuss or implement X". Search open and archived Claude/Codex sessions across projects using ordinary keyword matching over user prompts and assistant text. Copy a short contiguous phrase likely present verbatim in the original prompt, preferably a UI position, visible label, or exact action. Do not assemble scattered nouns: all meaningful query words must match. If there is no result, retry once with a contiguous subphrase; never fall back to list_open_sessions plus list_turns across candidates. A transport error (fetch failed, timeout, app/port unavailable, non-empty errors) is not a zero-match result and must not trigger transcript reads. Results already include title, tabId, sessionId, zero-based iterationIndex, totalIterations, and previews. Do not call list_turns merely to reconfirm a match. Supports today/yesterday and explicit created/closed date windows. It compares only user prompts and visible assistant text, so it can never show who edited a file: for a code identifier, a path, or the question which session changed X, use search_transcripts instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Copy a contiguous 2-4 word phrase verbatim from the user request; positions, labels, and exact actions beat scattered feature nouns. Every meaningful word must occur in the session title, user prompt, or assistant text. If there is no match, retry once with a contiguous subphrase. Omit only to list sessions in a selected date/project window.' },
        project: { type: 'string', description: 'Optional exact project id, name, or path. Omit to search every project.' },
        period: { type: 'string', enum: ['today', 'yesterday'], description: 'Optional local-calendar shortcut.' },
        dateField: { type: 'string', enum: ['activity', 'created', 'closed'], description: 'Default activity: closed_at for archived sessions and created_at for open sessions.' },
        dateFrom: { type: 'string', description: 'Optional inclusive ISO timestamp/date or epoch.' },
        dateTo: { type: 'string', description: 'Optional exclusive ISO timestamp/date or epoch.' },
        includeOpen: { type: 'boolean', description: 'Default true.' },
        includeClosed: { type: 'boolean', description: 'Default true.' },
        maxCandidates: { type: 'integer', description: 'Maximum newest sessions to inspect, default 100 and maximum 250.' },
        candidateOffset: { type: 'integer', description: 'Offset into the date/project-filtered session catalog. Increase it while hasMoreCandidates=true when searching older sessions.' },
        maxMatches: { type: 'integer', description: 'Maximum returned matching iterations, default 50 and maximum 200.' },
        matchesPerSession: { type: 'integer', description: 'Maximum matches from one session, default 3 and maximum 10.' },
        cwd: { type: 'string', description: 'Optional cwd used only to select the running Noted Terminal instance.' },
      },
    },
  },
  {
    name: 'search_transcripts',
    description: 'Literal grep over the raw Claude/Codex transcript files, including tool calls, patches, commands and their output. Use it for code identifiers, file paths, error strings and the question "which session edited / touched X" — search_sessions cannot answer that, because it only compares user prompts and visible assistant text and never sees an edit. Query is an exact substring, not keywords: pass the symbol or path verbatim, no quotes and no wildcards. Pass kinds="edit" to keep only matches that came from an actual file edit (apply_patch, Edit/Write); without it a symbol from already-committed code also matches every session that merely read the file. Matches are returned newest-first with timestamp, changed paths and a diff snippet. Codex resume copies the parent transcript into the new rollout, so one historical edit legitimately appears in several sessions — the newest timestamp is where it happened. Narrow with project and a date window before widening maxCandidates: a full pass reads tens of gigabytes. The date window here means when the transcript was last written, not when the tab was created or closed, because a long-running session opened weeks ago still edits files today. `outsideDateWindow` and `unresolvedSessions` report what the window and missing transcript files excluded, so an empty result is never confused with a proven absence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact substring to find, e.g. a function name, identifier, file path or error text. Not tokenized: it is matched verbatim.' },
        kinds: { type: 'string', description: 'Optional comma-separated record kinds to keep: edit (file edits), tool (other tool calls and output), prompt (user messages), reply (assistant text and reasoning). Default: every kind.' },
        caseSensitive: { type: 'boolean', description: 'Default true, which is what code identifiers need. Set false for prose.' },
        project: { type: 'string', description: 'Optional exact project id, name, or path. Omit to search every project.' },
        period: { type: 'string', enum: ['today', 'yesterday'], description: 'Optional local-calendar shortcut, applied to when the transcript was last written.' },
        dateFrom: { type: 'string', description: 'Optional inclusive ISO timestamp/date or epoch, compared against transcript write time.' },
        dateTo: { type: 'string', description: 'Optional exclusive ISO timestamp/date or epoch, compared against transcript write time.' },
        includeOpen: { type: 'boolean', description: 'Default true.' },
        includeClosed: { type: 'boolean', description: 'Default true.' },
        maxCandidates: { type: 'integer', description: 'Maximum newest sessions to scan, default 100 and maximum 250.' },
        candidateOffset: { type: 'integer', description: 'Offset into the date/project-filtered session catalog. Increase it while hasMoreCandidates=true.' },
        maxMatches: { type: 'integer', description: 'Maximum returned matches, default 50 and maximum 200.' },
        matchesPerSession: { type: 'integer', description: 'Maximum matches from one session, default 3 and maximum 10.' },
        cwd: { type: 'string', description: 'Optional cwd used only to select the running Noted Terminal instance.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_stats',
    description: 'Read metadata and size statistics for one Claude/Codex transcript without loading its content. Includes totalIterations, app-owned compact/fork historyEvents, separate visual tab relations, the live lifecycle wait gate, context/model data when available, Timeline note counts, and docs activity. Fork iteration coordinates are zero-based and describe the parent session at fork time.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_session_progress',
    description: 'Read tool-operation progress for a running Claude/Codex full session without rereading its transcript. The first call returns a bounded recent snapshot and nextCursor; pass that cursor on the next explicit check to receive only newer operations. This is stateless and does not replace the lifecycle completion notification.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        cursor: { type: 'string', description: 'Opaque nextCursor returned by the previous call.' },
        limit: { type: 'integer', description: 'Maximum operations to return, default 25 and maximum 100.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_turns',
    description: 'Map turns inside one already-selected session; this is not a cross-session search tool. Use search_sessions first for topic/feature lookup, then call list_turns only when its match preview is insufficient to reconstruct chronology. Inspect one session at a time, normally with kind="user", from="latest_compact" or from="end", and a small page; paginate only as evidence requires. Never call it across several candidate sessions just to find a phrase, and never repeat the same call with unchanged arguments. Returns zero-based iterationIndex values, compact boundaries, previews, block sizes, UUIDs, tools, notes, and docs markers; read full content only through targeted turn tools.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        limit: { type: 'integer', description: 'Default 50, maximum 500.' },
        offset: { type: 'integer', description: 'Pagination offset.' },
        from: { type: 'string', enum: ['latest_compact', 'end', 'start'], description: 'Default latest_compact. Start at the latest compact summary/boundary and read its tail; end reads the newest page; start preserves chronological pagination from the first turn.' },
        kind: { type: 'string', description: 'Optional user, compact_summary, or compact_boundary filter.' },
        includeNoise: { type: 'boolean', description: 'Include command/system/interrupted noise prompts.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_turn_evidence',
    description: 'Read bounded provider evidence for ONE already-selected historical turn. Without operationId returns a paged compact map of exact tool identities and result states. Pass an operationId from that map to read only that call\'s bounded input and result/error; inputStart/inputEnd and resultStart/resultEnd page through large values. It also returns model/effort provenance from provider records; unknown or changed-within-turn stays explicit. Do not use this to scan a session or replace list_turns.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer', description: 'Exact turnIndex already selected through search_sessions or list_turns.' },
        operationId: { type: 'string', description: 'Optional exact operationId from this turn\'s compact evidence map.' },
        maxChars: { type: 'integer', description: 'Per input/result limit for one selected operation; default 12000, maximum 65536.' },
        operationOffset: { type: 'integer', description: 'Offset for the compact operation map; default 0.' },
        operationLimit: { type: 'integer', description: 'Map page size; default 50, maximum 200.' },
        inputStart: { type: 'integer', description: 'Character offset for the selected operation input.' },
        inputEnd: { type: 'integer', description: 'Exclusive character offset for the selected operation input.' },
        resultStart: { type: 'integer', description: 'Character offset for the selected operation result/error.' },
        resultEnd: { type: 'integer', description: 'Exclusive character offset for the selected operation result/error.' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'list_notes',
    description: 'List user-authored Timeline notes, rewind markers, and orphan notes for a session. Use this first when the user names a Timeline anchor.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_user_prompt',
    description: 'Read one user prompt after search_sessions or list_turns has identified its exact turnIndex. This is targeted evidence, not a way to scan a session. Optionally slice by character offsets; negative offsets are supported.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'get_thinking',
    description: 'Read thinking only from an already-selected turn. Omit block first for a size/preview map; then pass one block and, for a large block, a needed character range.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer' },
        block: { type: 'integer' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'get_assistant_text',
    description: 'Read assistant text only from an already-selected turn. Omit block first for a size/preview map; then pass one block and, for a large block, a needed character range. The result includes lifecycle and must not be treated as final while busy=true.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer' },
        block: { type: 'integer' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'fork_session',
    description: 'Create an independent Claude history fork before editing. This edits history through the existing backend pipeline and does not start or control a live process. Codex history fork/edit is unsupported.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'propose_edit',
    description: 'Dry-run a Claude transcript compact/delete operation through the same backtrace and range expansion used by Timeline. Always show this plan to the user before apply_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        startUuid: { type: 'string' },
        endUuid: { type: 'string' },
        mode: { type: 'string', enum: ['compact', 'delete'] },
      },
      required: ['sessionId', 'startUuid', 'endUuid', 'mode'],
    },
  },
  {
    name: 'apply_edit',
    description: 'Apply an explicitly approved Claude transcript compact/delete operation through the existing atomic history pipeline. Default autoFork=true preserves the source session. Always call propose_edit and obtain user confirmation first.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        startUuid: { type: 'string' },
        endUuid: { type: 'string' },
        mode: { type: 'string', enum: ['compact', 'delete'] },
        compactText: { type: 'string', description: 'Required for compact mode.' },
        autoFork: { type: 'boolean', description: 'Default true. Use false only for follow-up edits on the returned fork.' },
      },
      required: ['sessionId', 'startUuid', 'endUuid', 'mode'],
    },
  },
  {
    name: 'get_tab_plan',
    description: 'Read the structured task plan of one Noted Terminal tab together with the current task-status catalog and descriptions. Inside Noted Terminal, omit tabId to use the parent tab that owns this agent. Call this before proposing any plan creation or update.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Optional tab ID from list_tabs. Defaults to the parent tab of this agent.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id. Use in external mode.' },
      },
    },
  },
  {
    name: 'apply_tab_plan_changes',
    description: 'Atomically apply an already user-approved set of changes to a tab task plan. The whole call is one undo step. NEVER call this before showing the exact proposed changes to the user and receiving explicit approval. Inside Noted Terminal, omit tabId to update the parent tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Optional tab ID from list_tabs. Defaults to the parent tab of this agent.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id. Use in external mode.' },
        operations: {
          type: 'array',
          minItems: 1,
          description: 'Approved delta. Supported types: replace_plan, add_task, update_task, remove_task, archive_task, restore_task, add_subtask, update_subtask, remove_subtask.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['replace_plan', 'add_task', 'update_task', 'remove_task', 'archive_task', 'restore_task', 'add_subtask', 'update_subtask', 'remove_subtask'] },
              taskId: { type: 'string' },
              subtaskId: { type: 'string' },
              title: { type: 'string' },
              statusId: { type: ['string', 'null'] },
              afterTaskId: { type: 'string' },
              afterSubtaskId: { type: 'string' },
              subtasks: { type: 'array', items: { type: 'object' } },
              tasks: { type: 'array', items: { type: 'object' } },
            },
            required: ['type'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'restart_process',
    description: 'Restart a terminal process. Sends Ctrl+C to stop the current command, waits for it to finish, then re-runs the command. The shell stays alive — only the running process is restarted. Use this after changing code that requires a full process restart (e.g. main.js changes in Electron, backend server changes).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID from list_tabs' },
        command: { type: 'string', description: 'Optional: override the restart command (default: reuse original command)' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'run_command',
    description: 'Send a command to an existing terminal tab. The command is typed into the terminal and Enter is pressed. Use for one-off commands in a running shell.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID from list_tabs' },
        command: { type: 'string', description: 'Command to execute' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId', 'command'],
    },
  },
  {
    name: 'send_prompt',
    description: 'Send text to a Claude/Codex tab through the Project API scenario layer. `files` attaches local UTF-8 text by path: Noted Terminal reads and snapshots it server-side, so this caller must not call read_file or paste the body itself. Files require submit=true. Default `submit=true` resumes a stopped process and can restore the exact closed tab from History before sending; a deleted or ambiguous target fails explicitly. It handles busy/readiness/draft preflight and returns only after delivery is accepted. If a previous response was pending/unknown, pass its exact handoffId to read the same operation safely; never invent a new retry for that prompt. Pass `submit=false` only for an already-live tab to paste an editable draft without pressing Enter. Use run_command for generic shells.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        prompt: { type: 'string', description: 'Prompt text to paste into the live AI session' },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional saved Noted Terminal prompt ids or exact titles. Their bodies are resolved server-side and delivered as visible prompt chips.',
        },
        files: CONTEXT_FILES_SCHEMA,
        submit: { type: 'boolean', description: 'Default true. Set false to leave the prompt editable in the input box.' },
        modelSelection: MODEL_SELECTION_SCHEMA,
        model: { type: 'string', description: 'Legacy literal model field retained for older callers. New model-specific calls must use modelSelection.' },
        effort: { type: 'string', description: 'Optional effort override for scenario send.' },
        thinking: { type: 'string', description: 'Optional thinking mode override for scenario send.' },
        queue: { type: 'boolean', description: 'When true, queue the prompt if the agent is busy instead of failing.' },
        handoffId: { type: 'string', description: 'Optional exact operation id from a previous pending/unknown response. Reusing it must query the same send without a second paste/Enter.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId', 'prompt'],
    },
  },
  {
    name: 'start_ai',
    description: 'Start or resume an AI process (Claude, Codex, or Gemini) in an existing terminal tab using Noted Terminal native launch hooks. This is the AI-safe alternative to run_command("codex"/"claude"): it marks the tab as an AI tab and starts the correct session watcher. For a new tab, call create_tab with command "codex", "claude", "codex-c <sessionId>", or "claude-c <sessionId>".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Existing terminal tab ID from list_tabs' },
        agent: { type: 'string', enum: ['claude', 'codex', 'gemini'], description: 'Which AI CLI to start' },
        sessionId: { type: 'string', description: 'Optional session UUID to resume. Omit for a fresh session.' },
        mode: { type: 'string', enum: ['new', 'continue', 'fork'], description: 'Optional. Defaults to continue when sessionId is present, otherwise new. Codex supports fork; Claude fork should use create_tab command "claude-f <sessionId>".' },
        cwd: { type: 'string', description: 'Optional working directory override' },
        modelSelection: MODEL_SELECTION_SCHEMA,
        model: { type: 'string', description: 'Legacy literal model field retained for older callers. New model-specific calls must use modelSelection.' },
        effort: { type: 'string', description: 'Optional Claude/Codex effort override' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId', 'agent'],
    },
  },
  {
    name: 'read_output',
    description: 'Read recent terminal output from a tab. Returns the last N lines from the output buffer. Useful for checking build errors, server logs, or command results.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID from list_tabs' },
        lines: { type: 'integer', description: 'Number of lines to read (default: 50, max: 500)' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'create_tab',
    description: 'Create a durable terminal/Claude/Codex tab through the acknowledged Project API. With `windowTarget`, the source tab determines “current workflow/window”; same-window inserts immediately after the source chip, while new-window + below/above creates a row in its column and right/left creates a column. Creation, placement, and AI launch are one guarded flow: placement failure rolls the new tab back before launch. Without `windowTarget`, the historical background/unplaced behavior remains for dev servers and service tabs. Omitted cwd inherits the source tab cwd when the target remains in the same project; pass cwd only for an explicit user-requested override. background defaults true and never steals the user UI.\n\nIMPORTANT — reuse existing dev-server tabs: call list_tabs first; restart/reuse a matching green tab instead of accumulating duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tab name (e.g. "build-watch", "run-dev")' },
        cwd: { type: 'string', description: 'Explicit working-directory override. Omit to inherit the source tab cwd in the same project.' },
        command: { type: 'string', description: 'Command to run on creation (e.g. "npm run dev")' },
        color: { type: 'string', description: 'Tab color override' },
        background: { type: 'boolean', description: 'Default true. Keep MCP-created tabs in background; set false only when the user explicitly wants focus.' },
        modelSelection: MODEL_SELECTION_SCHEMA,
        model: { type: 'string', description: 'Legacy literal model field retained for older callers. New model-specific calls must use modelSelection.' },
        effort: { type: 'string', description: 'Optional effort override for a new Codex or Claude session; applied by the startup transaction before its first prompt.' },
        placement: { type: 'string', enum: ['child', 'root'], description: 'AI tabs default to child of the current full session in the same project. Use root for an independent session.' },
        parentTabId: { type: 'string', description: 'Optional explicit visual parent for a new AI tab.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Required in external mode when multiple projects are open and cwd is omitted.' },
        windowTarget: WINDOW_TARGET_SCHEMA,
      },
    },
  },
  {
    name: 'list_windows',
    description: 'Read every workflow and its normalized windows, including dormant layouts. Each window has an opaque revision-bound windowRef, screen column/row, its ordered tab strip, and shownTabId. Inside a full session the response also names every placement of the source tab and its preferred “current window”; this is not inferred from the user\'s unrelated active workflow. Use windowRef for an explicitly selected window and source/focused targets for intent-based commands.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional Noted Terminal project id. Use in external mode to pick the instance.' },
        cwd: { type: 'string', description: 'Optional project path used to pick the instance.' },
        spaceId: { type: 'string', description: 'Optional workflow id to select from the returned all-workflow layout.' },
      },
    },
  },
  {
    name: 'create_window',
    description: 'Create one empty workspace window relative to the source/focused/exact anchor. `below`/`above` adds a row in the same column; `right`/`left` adds a column. The operation can update a dormant workflow without switching the user to it.',
    inputSchema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['right', 'left', 'above', 'below'], description: 'Default right.' },
        windowTarget: WINDOW_TARGET_SCHEMA,
        focus: { type: 'boolean', description: 'Make the new empty window the saved focused window of its workflow.' },
        reveal: { type: 'boolean', description: 'Also switch the visible UI to that workflow/window. Default false.' },
        projectId: { type: 'string', description: 'Optional instance-routing hint only; it does not choose the workflow.' },
        cwd: { type: 'string', description: 'Optional instance-routing hint.' },
      },
    },
  },
  {
    name: 'open_tabs_in_window',
    description: 'Move existing tabs into one exact workspace window. Defaults to the source tab window and inserts immediately after the source tab. This changes placement only; it does not clone processes or conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        tabs: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          description: 'Tab ids or {projectId, tabId} entries.',
        },
        windowTarget: WINDOW_TARGET_SCHEMA,
        show: { type: 'boolean', description: 'Show the first moved tab in the target window. Default true.' },
        reveal: { type: 'boolean', description: 'Switch the visible UI to the target workflow/window. Default false.' },
        projectId: { type: 'string', description: 'Optional instance-routing hint only.' },
        cwd: { type: 'string', description: 'Optional instance-routing hint.' },
      },
      required: ['tabs'],
    },
  },
  {
    name: 'arrange_windows',
    description: 'Place several existing tabs into new workspace windows in ONE atomic step. `windowTarget` chooses the source/focused/exact anchor even in a dormant workflow. Nesting carries shape: [["A"],["B"]] means two windows; [["A","B"]] means one window with two chips. side right/left creates a new area beside the anchor; side above/below adds rows to the anchor column; divide rows stacks several new windows in one new column. Named tabs move from their old window placements. Use create_window for one empty window and open_tabs_in_window for one existing target strip.',
    inputSchema: {
      type: 'object',
      properties: {
        windows: {
          type: 'array',
          description: 'Outer array = windows in order; inner array = the tabs inside one window, first one shown. Entries are tab ids or {projectId, tabId}.',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } },
            ],
          },
        },
        side: { type: 'string', enum: ['right', 'left', 'above', 'below'], description: 'Where the new area goes relative to the anchor window. Default "right".' },
        divide: { type: 'string', enum: ['columns', 'rows'], description: 'How several windows split the new area: "columns" side by side (default), "rows" stacked. Ignored for side above/below, which always stacks into the anchor column.' },
        anchorIndex: { type: 'number', description: 'Window index (from list_windows) to place relative to. Default: the focused window.' },
        windowTarget: WINDOW_TARGET_SCHEMA,
        show: { type: 'boolean', description: 'Show/focus the first arranged tab inside the target workflow. Default true.' },
        reveal: { type: 'boolean', description: 'Also switch the visible UI to the target workflow. Default false.' },
        projectId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['windows'],
    },
  },
  {
    name: 'fork_tab',
    description: 'Fork a LIVE agent tab: a new tab continues a COPY of the conversation. Provider/session come from the source tab. It refuses a busy or unmaterialized source. By default it forks from the latest context compaction. `windowTarget` can atomically place the fork beside the source or in a new row/column; otherwise it stays background/unplaced as before.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab to fork (from list_tabs / list_windows).' },
        fullHistory: { type: 'boolean', description: 'Fork the WHOLE transcript instead of the source\'s latest context compaction. Default false — the compaction point is what the desktop menu uses and is much cheaper.' },
        name: { type: 'string', description: 'Name for the new tab. Default: "<source name>_compact" / "_fork".' },
        background: { type: 'boolean', description: 'Default true. false shows/reveals the placed fork.' },
        windowTarget: WINDOW_TARGET_SCHEMA,
        projectId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'kill_process',
    description: 'Kill a terminal process. The PTY is terminated but the tab remains.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'stop_ai',
    description: 'Gracefully stop a live AI process (Claude, Codex, or Gemini) in a tab without killing the shell tab itself. Uses the app\'s AI-specific stop flow, not a raw PTY kill. Use this for AI tabs; use kill_process for generic shells or dev-server processes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'interrupt_ai',
    description: 'Soft-interrupt the current Claude/Codex turn through the shared scenario layer. This matches the composer Stop button and is distinct from stop_ai, which stops the runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'read_draft',
    description: 'Read the live terminal composer draft after interrupt/rollback through the shared scenario layer.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'draft_state',
    description: 'Probe whether a terminal composer has a draft without mutating TUI state. Prefer this before send/rollback decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'rewind_ai',
    description: 'Run native or AI rewind for a Claude/Codex terminal tab through the shared scenario layer. Use exact target fields from the history/timeline item when available.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        mode: { type: 'string', enum: ['native', 'ai'], description: 'Default native. ai builds a compact/rewind prompt.' },
        targetIndex: { type: 'integer', description: 'Timeline/history index to rewind to, when available.' },
        targetText: { type: 'string', description: 'Short target text shown in the history UI.' },
        targetFullText: { type: 'string', description: 'Full target prompt/assistant text, when available.' },
        rewindableCount: { type: 'integer', description: 'Number of rewindable items visible to the caller.' },
        skipDuplicates: { type: 'integer', description: 'Number of duplicate prompt entries to skip.' },
        startUuid: { type: 'string', description: 'Start UUID for AI rewind range.' },
        endUuid: { type: 'string', description: 'End UUID for AI rewind range.' },
        targetUuid: { type: 'string', description: 'Fallback target UUID.' },
        additionalPrompt: { type: 'string', description: 'Optional extra instruction for AI rewind.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_pending_question',
    description: 'Read the current AskUserQuestion pending on a Claude/Codex tab, if any.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'answer_question',
    description: 'Answer or stop an AskUserQuestion on a Claude/Codex tab through the shared scenario layer.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        source: { type: 'string', enum: ['pty', 'sdk'], description: 'Question source. Default pty.' },
        toolUseID: { type: 'string', description: 'Tool use id from get_pending_question, when available.' },
        questions: { type: 'array', description: 'Questions payload from get_pending_question.', items: { type: 'object' } },
        answers: { type: 'object', description: 'Map question text to selected label/value.' },
        stop: { type: 'boolean', description: 'When true, cancel/stop the question instead of answering.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Use when tabId is not path-derived.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'run_chain',
    description: 'Run a sequence of steps in order. Each step waits for the previous one to complete before starting. Use for build pipelines like: build package → restart dev server.\n\nStep actions:\n- "run": Execute a command and wait for it to finish\n- "restart": Kill and restart the terminal process\n- "kill": Kill the process',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['run', 'restart', 'kill'], description: 'Step action' },
              tabId: { type: 'string', description: 'Tab ID' },
              command: { type: 'string', description: 'Command for "run" action, or override command for "restart"' },
              waitForCompletion: { type: 'boolean', description: 'For "run": wait until command finishes (default: true)' },
            },
            required: ['action', 'tabId'],
          },
          description: 'Array of steps to execute sequentially',
        },
        projectId: {
          type: 'string',
          description: 'Optional Noted Terminal project id from list_projects. Required in external mode when step tabIds are not path-derived.',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'build_install_noted_terminal',
    description: 'Ask the external Voice Record app to run Noted Terminal `npm run build:install`. Use this instead of run_command/build:i when the caller is inside Noted Terminal: the app will quit/reinstall/reopen, while Voice Record survives and can send a completion prompt back to the originating AI tab after the original tab/session is restored. This tool returns as soon as Voice Record accepts the job; it does not wait for the build. Before spawning the build, Voice Record OBSERVES the running prod app via GET /api/active-loaders and waits until every OTHER blocker goes idle: live Claude/Codex/Gemini turns and shell commands that were actually launched by Restart after. Manual shell commands like `npm run dev`, `npm run build`, or `./deploy.sh` are not blockers by themselves. The caller\'s own tab is excluded so it never deadlocks on itself. Progress (current blockers / phase pending→observing→building→finished) is visible in Voice Record GET /api/terminal/build-install under job.phase and job.wait.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Optional success prompt Voice Record should send back to the originating AI tab after install and session restore. Default is a short Russian completion message.',
        },
        notifyOnSuccess: {
          type: 'boolean',
          description: 'Default true. Set false for a fire-and-forget install that still excludes the originating busy tab from the idle wait but sends no success prompt after restart.',
        },
        failurePrompt: {
          type: 'string',
          description: 'Optional failure prompt. Sent only when notifyOnFailure=true and Noted Terminal becomes reachable.',
        },
        notifyOnFailure: {
          type: 'boolean',
          description: 'Default false. If true, Voice Record also tries to notify the originating tab when build:install exits non-zero.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'How long Voice Record should wait after build exit for Noted Terminal and the return tab/session to become available. Default 10 minutes.',
        },
        pollMs: {
          type: 'integer',
          description: 'Polling interval while waiting for the app/tab/session to reappear. Default 1500ms.',
        },
        returnToTabId: {
          type: 'string',
          description: 'Override the tab that should receive the completion prompt. Defaults to NOTED_PARENT_TAB_ID of this AI process.',
        },
        sessionId: {
          type: 'string',
          description: 'Override the expected AI sessionId. Defaults to the current tab sessionId when discoverable through list_tabs.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Noted Terminal project id. Defaults to NOTED_PARENT_PROJECT_ID.',
        },
        cwd: {
          type: 'string',
          description: 'Optional project path. Defaults to the current project cwd.',
        },
      },
    },
  },
];

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return jsonRpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'noted-terminal', version: '2.0.0' },
    });
  }

  if (method === 'notifications/initialized') return null; // no response needed

  if (method === 'tools/list') {
    return jsonRpcResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const noted = params?._meta?.noted || null;
    try {
      const result = await requestIdentity.run(noted, () => callTool(name, args || {}));
      const toolResult = { content: [{ type: 'text', text: result }] };
      if (STRUCTURED_JSON_TOOLS.has(name)) {
        try {
          toolResult.structuredContent = JSON.parse(result);
        } catch {}
      }
      return jsonRpcResponse(id, toolResult);
    } catch (err) {
      const toolResult = {
        content: [{ type: 'text', text: 'Error: ' + err.message }],
        isError: true,
      };
      if (STRUCTURED_JSON_TOOLS.has(name)) {
        toolResult.structuredContent = { ok: false, error: err.message };
      }
      return jsonRpcResponse(id, toolResult);
    }
  }

  return jsonRpcError(id, -32601, 'Method not found: ' + method);
}

async function callTool(name, args) {
  switch (name) {
    case 'get_tab_context':
    case 'set_tab_responsibility':
    case 'publish_context_update': {
      const tabId = args.tabId || PARENT_TAB_ID();
      if (!tabId) throw new Error('tabId is required outside a full Noted Terminal session');
      const sourceTabId = PARENT_TAB_ID();
      if (name === 'publish_context_update' && sourceTabId && tabId === sourceTabId) {
        throw new Error('context_update_self_target: publish_context_update is for another tab. Your own work is already in this session; keep your own checkpoint in its working Markdown, not in a self-addressed update chip.');
      }
      const target = projectHint(args, tabId);
      const endpoint = '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/work-context';
      const result = name === 'get_tab_context'
        ? await httpApiGet(target, endpoint)
        : name === 'set_tab_responsibility'
          ? await httpApiPost(target, endpoint + '/responsibility', { description: args.description })
          : await httpApiPost(target, endpoint + '/updates', {
            title: args.title, text: args.text, requestId: args.requestId,
            sourceTabId: sourceTabId || undefined,
          });
      return JSON.stringify(result, null, 2);
    }
    case 'list_tab_contexts': {
      const target = projectHint(args, PARENT_TAB_ID());
      let ids = null;
      let spaceId = args.spaceId || null;
      if (args.allWorkflows !== true) {
        const workspace = await httpApiGet(target, '/api/workspace?sourceTabId=' + encodeURIComponent(PARENT_TAB_ID() || ''));
        spaceId ||= workspace.sourceContext?.preferredPlacement?.spaceId || workspace.activeSpaceId;
        const space = (workspace.spaces || []).find((item) => item.id === spaceId);
        if (!space) throw new Error('workflow not found; use list_windows to select a workflow');
        ids = [...new Set((space.windows || []).flatMap((window) => (window.tabs || []).map((tab) => tab.tabId)))];
        if (ids.length === 0) return JSON.stringify({ ok: true, spaceId, tabs: [] });
      }
      const result = await httpApiGet(target, '/api/tab-contexts' + (ids ? '?tabIds=' + encodeURIComponent(ids.join(',')) : ''));
      return JSON.stringify({ ...result, spaceId }, null, 2);
    }
    case 'list_projects': {
      const projects = listOpenProjects();
      if (!projects.length) {
        return 'No live Noted Terminal projects found. Open Noted Terminal first; the MCP bridge reads ~/.noted-terminal/mcp-port-* discovery files.';
      }
      let text = 'Noted Terminal projects (' + projects.length + '):\n';
      for (const p of projects) {
        text += '\n- ' + (p.name || p.path || p.id || 'Untitled');
        if (p.id) text += '\n  Project ID: ' + p.id;
        if (p.path) text += '\n  Path: ' + p.path;
        text += '\n  Instance PID: ' + p.pid + ' | Port: ' + p.port;
        text += '\n';
      }
      return text;
    }

    case 'list_agent_models': {
      const target = projectHint(args, PARENT_TAB_ID());
      return JSON.stringify(await httpApiGet(target, '/api/agent-models'), null, 2);
    }

    case 'list_prompts': {
      const target = projectHint(args);
      const { payload } = await readPromptCatalog(target);
      return JSON.stringify(buildPromptCatalog(payload, args.query), null, 2);
    }

    case 'get_prompt': {
      const target = projectHint(args);
      const { payload, legacy } = await readPromptCatalog(target);
      const prompt = selectPrompt(payload, args);
      const mode = args.mode === 'own' ? 'own' : 'resolved';
      if (legacy) return JSON.stringify(buildPromptResult(payload, prompt, mode), null, 2);
      const read = await httpPromptLibraryMutation(target, 'POST', '/api/prompt-library/read', {
        promptIds: [prompt.id], mode,
      });
      const selected = read?.prompts?.[0];
      if (!selected) throw new Error('Prompt read returned no prompt data');
      return JSON.stringify(buildPromptResult({ groups: payload.groups || [], prompts: [selected] }, selected, mode), null, 2);
    }

    case 'update_prompt': {
      if (args.title === undefined && args.text === undefined && args.filePaths === undefined && args.position === undefined) {
        throw new Error('Pass title, text, filePaths, or position to update a saved prompt.');
      }
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(
        target,
        'PATCH',
        '/api/prompts/' + encodeURIComponent(args.promptId),
        { revision: args.revision, title: args.title, text: args.text, filePaths: args.filePaths, position: args.position },
      );
      const prompt = result?.prompt;
      if (!prompt) throw new Error('Prompt update returned no prompt data');
      return JSON.stringify({
        ...buildPromptResult({ prompts: [prompt] }, prompt, 'own'),
        revision: prompt.revision || null,
      }, null, 2);
    }

    case 'list_prompt_catalog': {
      const target = projectHint(args);
      const { payload: result, legacy } = await readPromptCatalog(target);
      if (legacy) throw new Error('This Noted Terminal instance does not support the compact prompt catalog yet; install a build containing the prompt-library API.');
      return JSON.stringify(result, null, 2);
    }

    case 'read_prompts': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'POST', '/api/prompt-library/read', {
        promptIds: args.promptIds, mode: args.mode || 'own',
      });
      return JSON.stringify(result, null, 2);
    }

    case 'create_prompt': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'POST', '/api/prompts', {
        stableId: args.stableId, title: args.title, text: args.text, filePaths: args.filePaths,
        groupId: args.groupId, parentPromptId: args.parentPromptId, position: args.position,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'move_prompt': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'POST', '/api/prompts/' + encodeURIComponent(args.promptId) + '/move', {
        revision: args.revision, groupId: args.groupId, parentPromptId: args.parentPromptId, position: args.position,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'delete_prompt': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'DELETE', '/api/prompts/' + encodeURIComponent(args.promptId), { revision: args.revision });
      return JSON.stringify(result, null, 2);
    }

    case 'create_prompt_group': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'POST', '/api/prompt-groups', {
        name: args.name, description: args.description, position: args.position, isCollapsed: args.isCollapsed,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'get_prompt_group': {
      const target = projectHint(args);
      const result = await httpApiGet(target, '/api/prompt-groups/' + encodeURIComponent(args.groupId)).catch((error) => {
        if (/HTTP 404/.test(error.message) && !error.code) throw new Error('This Noted Terminal instance does not support saved-prompt groups yet; install a build containing the prompt-library API.');
        throw error;
      });
      return JSON.stringify(result, null, 2);
    }

    case 'update_prompt_group': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'PATCH', '/api/prompt-groups/' + encodeURIComponent(args.groupId), {
        revision: args.revision, name: args.name, description: args.description, position: args.position, isCollapsed: args.isCollapsed,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'delete_prompt_group': {
      const target = projectHint(args);
      const result = await httpPromptLibraryMutation(target, 'DELETE', '/api/prompt-groups/' + encodeURIComponent(args.groupId), { revision: args.revision });
      return JSON.stringify(result, null, 2);
    }

    case 'list_tabs': {
      const color = args.color !== undefined ? args.color : 'green';
      const colorParam = color ? '&color=' + encodeURIComponent(color) : '';
      const requestedProjectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID() || '';
      const requestedCwd = args.cwd || '';
      const listAll = args.allProjects === true || (EXTERNAL_MODE && !requestedProjectId && !requestedCwd && !PARENT_PROJECT_ID());

      let tabs = [];
      let scope = '';
      if (listAll) {
        const projects = listOpenProjects();
        if (!projects.length) {
          return 'No live Noted Terminal projects found. Open Noted Terminal first, then call list_projects.';
        }
        scope = 'all open Noted Terminal projects';
        for (const p of projects) {
          const params = [];
          if (p.id) params.push('parentProjectId=' + encodeURIComponent(p.id));
          if (p.path) params.push('cwd=' + encodeURIComponent(p.path));
          if (color) params.push('color=' + encodeURIComponent(color));
          const result = await httpGetOnPort(p.port, '/terminal/tabs?' + params.join('&'));
          const projectTabs = (result.tabs || []).map(t => ({ ...t, projectId: p.id, projectName: p.name, projectPath: p.path }));
          tabs.push(...projectTabs);
        }
      } else {
        const target = projectHint({ projectId: requestedProjectId, cwd: requestedCwd });
        const params = ['cwd=' + encodeURIComponent(target.cwd || PROJECT_CWD_())];
        if (color) params.push('color=' + encodeURIComponent(color));
        if (target.projectId) params.push('parentProjectId=' + encodeURIComponent(target.projectId));
        const result = target.port
          ? await httpGetOnPort(target.port, '/terminal/tabs?' + params.join('&'))
          : await httpGet('/terminal/tabs?' + params.join('&'), target.cwd);
        tabs = (result.tabs || []).map(t => ({ ...t, projectId: target.projectId || undefined }));
        scope = target.projectId ? ('project id ' + target.projectId) : (target.cwd || PROJECT_CWD_());
      }

      if (tabs.length === 0) {
        return 'No terminal tabs found' + (color ? ' with color "' + color + '"' : '') + ' in ' + scope;
      }

      let text = 'Terminal tabs (' + tabs.length + '):\n';
      for (const t of tabs) {
        const status = t.isAlive ? (t.isRunning ? 'RUNNING' : 'IDLE') : 'DEAD';
        text += '\n- ' + t.name + ' [' + status + ']';
        text += '\n  ID: ' + t.tabId;
        if (t.projectId) text += '\n  Project ID: ' + t.projectId;
        if (t.projectName) text += '\n  Project: ' + t.projectName;
        text += '\n  Color: ' + t.color + ' | Type: ' + t.commandType;
        if (t.sessionId) text += '\n  Session: ' + t.sessionId;
        text += '\n  CWD: ' + (t.cwd || t.projectPath || '');
        if (t.initialCommand) text += '\n  Command: ' + t.initialCommand;
        if (t.pid) text += '\n  PID: ' + t.pid;
        text += '\n';
      }
      return text;
    }

    case 'current_context': {
      if (!PARENT_TAB_ID() && !PARENT_PROJECT_ID()) {
        return JSON.stringify({
          insideNotedTerminalSession: false,
          projectCwd: PROJECT_CWD_(),
          message: 'No parent tab identity is available. Pass explicit projectId/tabId to session-scoped tools.',
        }, null, 2);
      }
      const target = projectHint({ projectId: PARENT_PROJECT_ID(), cwd: PROJECT_CWD_() }, PARENT_TAB_ID());
      const params = ['cwd=' + encodeURIComponent(target.cwd || PROJECT_CWD_()), 'color='];
      if (target.projectId) params.push('parentProjectId=' + encodeURIComponent(target.projectId));
      const result = target.port
        ? await httpGetOnPort(target.port, '/terminal/tabs?' + params.join('&'))
        : await httpGet('/terminal/tabs?' + params.join('&'), target.cwd);
      const tab = (result.tabs || []).find((candidate) => candidate.tabId === PARENT_TAB_ID()) || null;
      let workspace = null;
      let workingContext = null;
      try {
        const result = await httpApiGet(target, '/api/terminal-tabs/' + encodeURIComponent(PARENT_TAB_ID()) + '/work-context');
        workingContext = result.context;
      } catch {}
      try {
        workspace = await httpApiGet(
          target,
          '/api/workspace?sourceTabId=' + encodeURIComponent(PARENT_TAB_ID()),
        );
      } catch {}
      return JSON.stringify({
        insideNotedTerminalSession: true,
        projectId: target.projectId || PARENT_PROJECT_ID() || null,
        projectCwd: target.cwd || PROJECT_CWD_(),
        tabId: PARENT_TAB_ID() || null,
        tab,
        workingContext,
        workspace: workspace ? {
          activeSpaceId: workspace.activeSpaceId || null,
          spacesFingerprint: workspace.spacesFingerprint || null,
          sourceContext: workspace.sourceContext || null,
        } : null,
      }, null, 2);
    }

    case 'complete_task': {
      if (EXTERNAL_MODE || !PARENT_TAB_ID()) {
        throw new Error('complete_task is available only inside the full Noted Terminal session that owns this MCP process');
      }
      const target = projectHint({ projectId: PARENT_PROJECT_ID(), cwd: PROJECT_CWD_() }, PARENT_TAB_ID());
      const result = await httpApiPost(
        target,
        '/api/terminal-tabs/' + encodeURIComponent(PARENT_TAB_ID()) + '/complete-task',
        { sourceMeta: buildSourceMeta() },
      );
      return JSON.stringify({
        ok: true,
        message: 'Current turn marked complete. Finish the final response now; do not start more work in this turn.',
        ...result,
      }, null, 2);
    }

    case 'rename_tab': {
      const tabId = args.tabId || PARENT_TAB_ID();
      const name = String(args.name || '').trim();
      if (!tabId) throw new Error('tabId is required outside a parent Noted Terminal session');
      if (!name) throw new Error('name is required');
      const target = projectHint(args, tabId);
      const result = await httpApiPost(
        target,
        '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/rename',
        { name },
      );
      return JSON.stringify({ ok: true, ...result }, null, 2);
    }

    case 'link_file': {
      const tabId = args.tabId || PARENT_TAB_ID();
      if (!tabId) throw new Error('tabId is required outside a parent Noted Terminal session');
      const requestedPath = String(args.path || '').trim();
      if (!requestedPath) throw new Error('path is required');
      const filePath = resolve(PROJECT_CWD_(), requestedPath);
      const target = projectHint(args, tabId);
      const result = await httpApiPost(
        target,
        '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/link-file',
        { path: filePath },
      );
      return JSON.stringify({ ok: true, ...result }, null, 2);
    }

    case 'delegate_to_session': {
      const sourceTabId = args.sourceTabId || PARENT_TAB_ID();
      if (!sourceTabId) throw new Error('sourceTabId is required outside a parent Noted Terminal session');
      const targetProjectId = args.targetProjectId
        || (!args.targetTabId && !args.windowTarget ? PARENT_PROJECT_ID() : undefined);
      const targetToolType = args.toolType
        || (args.targetTabId || args.forkFromTabId ? undefined : 'claude');
      if (!args.targetTabId && !targetProjectId && !args.forkFromTabId && !args.windowTarget) {
        throw new Error('targetTabId, targetProjectId, forkFromTabId, or windowTarget is required');
      }
      const target = projectHint({
        projectId: targetProjectId || PARENT_PROJECT_ID(),
        cwd: PROJECT_CWD_(),
      }, args.forkFromTabId || sourceTabId);
      await ensureAgentModelSelectionSupport(target, args);
      const result = await httpApiPost(target, '/api/orchestrations', {
        runId: args.runId || undefined,
        sourceTabId,
        targetTabId: args.targetTabId || undefined,
        targetProjectId: targetProjectId || (!args.windowTarget ? target.projectId : undefined),
        toolType: targetToolType,
        name: args.name || undefined,
        label: args.label || undefined,
        prompt: args.prompt,
        cwd: args.cwd || undefined,
        windowTarget: args.windowTarget || undefined,
        prompts: args.prompts || undefined,
        files: await contextFilesForSupportedTarget(target, args.files),
        modelSelection: args.modelSelection || undefined,
        model: args.model || undefined,
        effort: args.effort || undefined,
        thinking: args.thinking || undefined,
        placement: args.placement || 'child',
        parentTabId: args.parentTabId || undefined,
        forkFromTabId: args.forkFromTabId || undefined,
        fullHistoryFork: args.fullHistoryFork === true,
        compactBeforeTask: args.compactBeforeTask === true,
        parentRunId: args.parentRunId || undefined,
        sourceMeta: buildSourceMeta(),
        waitForDescendants: args.waitForDescendants !== false,
        notifySource: args.notifySource !== false,
        queue: args.queue !== false,
      });
      const runId = result?.runId || result?.run?.runId;
      if (!runId) throw new Error('Project API accepted delegation without a durable runId');
      return JSON.stringify({ ...result, runId }, null, 2);
    }

    case 'start_external_research':
    case 'import_external_conversation':
    case 'continue_external_research': {
      const sourceTabId = args.sourceTabId || PARENT_TAB_ID();
      if (!sourceTabId) throw new Error('sourceTabId is required outside a full Noted Terminal session');
      if (name === 'continue_external_research'
        && args.runId
        && args.runId === args.previousRunId) {
        throw new Error('a follow-up needs a new runId; do not reuse previousRunId');
      }
      const target = projectHint({
        projectId: args.projectId || PARENT_PROJECT_ID(),
        cwd: args.cwd || PROJECT_CWD_(),
      }, sourceTabId);
      const importUrl = name === 'import_external_conversation'
        ? normalizeChatGPTConversationImportUrl(args.url)
        : null;
      await ensureExternalResearchOrchestrationSupport(target);
      const result = await httpApiPost(target, '/api/external-research/orchestrations', {
        runId: args.runId || undefined,
        sourceTabId,
        prompt: name === 'import_external_conversation' ? EXTERNAL_CONVERSATION_IMPORT_PROMPT : args.prompt,
        provider: name === 'continue_external_research' ? undefined : (name === 'start_external_research' ? (args.provider || 'chatgpt') : 'chatgpt'),
        options: name === 'import_external_conversation' ? {
          readOnlyImport: true,
          importWaitForFinal: args.waitForFinal === true,
          importTimeoutMs: Math.max(10_000, Math.min(1_800_000, Number(args.timeoutMs) || 1_800_000)),
          sources: args.sources === true,
          importIncludeActivity: args.includeActivity === true,
          autoClose: args.autoClose !== false,
        } : args.options,
        files: name === 'import_external_conversation' ? undefined : externalResearchFilesForApi(args.files),
        conversationUrl: name === 'import_external_conversation'
          ? importUrl
          : (name === 'start_external_research' ? args.conversationUrl : undefined),
        continueFromRunId: name === 'continue_external_research' ? args.previousRunId : undefined,
        label: args.label || (name === 'import_external_conversation' ? 'Импорт ChatGPT по ссылке' : undefined),
        parentRunId: args.parentRunId || undefined,
        waitForDescendants: args.waitForDescendants !== false,
        notifySource: args.notifySource !== false,
        sourceMeta: buildSourceMeta(),
      });
      const runId = result?.runId || result?.run?.runId;
      const jobId = result?.jobId || result?.run?.externalResearchJobId;
      if (!runId || !jobId) {
        throw new Error('Project API accepted external research without durable runId/jobId identity');
      }
      return JSON.stringify({ ...result, runId, jobId }, null, 2);
    }

    case 'get_delegation': {
      const target = projectHint({ cwd: args.cwd || PROJECT_CWD_() });
      const result = await httpApiGet(
        target,
        '/api/orchestrations/' + encodeURIComponent(args.runId),
      );
      return JSON.stringify(result, null, 2);
    }

    case 'get_delegation_result': {
      const target = projectHint({ cwd: args.cwd || PROJECT_CWD_() });
      const maxChars = Math.max(500, Math.min(250_000, Number(args.maxChars) || 100_000));
      const result = await httpApiGet(
        target,
        '/api/orchestrations/' + encodeURIComponent(args.runId) + '/result?maxChars=' + maxChars,
      );
      return JSON.stringify(result, null, 2);
    }

    case 'cancel_delegation': {
      const target = projectHint({ cwd: args.cwd || PROJECT_CWD_() });
      const result = await httpApiPost(
        target,
        '/api/orchestrations/' + encodeURIComponent(args.runId) + '/cancel',
        { interrupt: args.interrupt === true },
      );
      return JSON.stringify(result, null, 2);
    }

    case 'list_open_sessions': {
      const result = await httpGet('/overseer/sessions', args.cwd || PROJECT_CWD_());
      return JSON.stringify({
        waitRule: 'Treat assistant output as final only when busy=false or a terminal completion event is present.',
        ...result,
      }, null, 2);
    }

    case 'search_sessions': {
      const endpoint = '/overseer/search-sessions' + qs({
        query: args.query,
        project: args.project,
        period: args.period,
        dateField: args.dateField,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        includeOpen: args.includeOpen === false ? 0 : undefined,
        includeClosed: args.includeClosed === false ? 0 : undefined,
        maxCandidates: args.maxCandidates,
        candidateOffset: args.candidateOffset,
        maxMatches: args.maxMatches,
        matchesPerSession: args.matchesPerSession,
      });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(result, null, 2);
    }

    case 'search_transcripts': {
      const endpoint = '/overseer/search-transcripts' + qs({
        query: args.query,
        kinds: args.kinds,
        caseSensitive: args.caseSensitive === false ? 0 : undefined,
        project: args.project,
        period: args.period,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        includeOpen: args.includeOpen === false ? 0 : undefined,
        includeClosed: args.includeClosed === false ? 0 : undefined,
        maxCandidates: args.maxCandidates,
        candidateOffset: args.candidateOffset,
        maxMatches: args.maxMatches,
        matchesPerSession: args.matchesPerSession,
      });
      let result;
      try {
        result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      } catch (error) {
        // Старая установка отвечает безымянным 404 на неизвестный overseer-route.
        // Без этой подсказки агент читает «Unknown overseer route» как «ничего не
        // найдено» и уходит грепать файлы сессий шеллом мимо MCP.
        if (/HTTP 404/.test(error?.message || '') && !error?.code) {
          throw new Error('This Noted Terminal instance does not expose /overseer/search-transcripts yet; rebuild and reinstall the app, then refresh Terminal MCP. This is an app-update requirement, not an empty result, and transcript files must not be read through shell tools instead.');
        }
        throw error;
      }
      return JSON.stringify(result, null, 2);
    }

    case 'session_stats': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId) + '/stats' + qs({ cwd: args.cwd });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'get_session_progress': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId) + '/progress' + qs({
        cwd: args.cwd,
        cursor: args.cursor,
        limit: args.limit,
      });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'list_turns': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId) + '/turns' + qs({
        cwd: args.cwd,
        limit: args.limit,
        offset: args.offset,
        from: args.from || 'latest_compact',
        kind: args.kind,
        includeNoise: args.includeNoise ? 1 : undefined,
      });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'get_turn_evidence': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId)
        + '/turn/' + args.turnIndex + '/evidence'
        + qs({
          cwd: args.cwd,
          operationId: args.operationId,
          maxChars: args.maxChars,
          operationOffset: args.operationOffset,
          operationLimit: args.operationLimit,
          inputStart: args.inputStart,
          inputEnd: args.inputEnd,
          resultStart: args.resultStart,
          resultEnd: args.resultEnd,
        });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'list_notes': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId) + '/notes' + qs({ cwd: args.cwd });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(result, null, 2);
    }

    case 'get_user_prompt': {
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId)
        + '/turn/' + args.turnIndex + '/user'
        + qs({ cwd: args.cwd, start: args.start, end: args.end });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'get_thinking':
    case 'get_assistant_text': {
      const part = name === 'get_thinking' ? 'thinking' : 'text';
      const endpoint = '/overseer/session/' + encodeURIComponent(args.sessionId)
        + '/turn/' + args.turnIndex + '/' + part
        + qs({ cwd: args.cwd, block: args.block, start: args.start, end: args.end });
      const result = await httpGet(endpoint, args.cwd || PROJECT_CWD_());
      return JSON.stringify(
        await historyResultWithLifecycle(args.sessionId, args.cwd || PROJECT_CWD_(), result),
        null,
        2,
      );
    }

    case 'fork_session': {
      const result = await httpPost('/overseer/fork', {
        sessionId: args.sessionId,
        cwd: args.cwd,
      }, args.cwd || PROJECT_CWD_());
      return JSON.stringify(result, null, 2);
    }

    case 'propose_edit': {
      const result = await httpPost('/overseer/propose-edit', {
        sessionId: args.sessionId,
        cwd: args.cwd,
        startUuid: args.startUuid,
        endUuid: args.endUuid,
        mode: args.mode,
      }, args.cwd || PROJECT_CWD_());
      return JSON.stringify(result, null, 2);
    }

    case 'apply_edit': {
      const result = await httpPost('/overseer/apply-edit', {
        sessionId: args.sessionId,
        cwd: args.cwd,
        startUuid: args.startUuid,
        endUuid: args.endUuid,
        mode: args.mode,
        compactText: args.compactText,
        autoFork: args.autoFork === undefined ? true : args.autoFork === true,
      }, args.cwd || PROJECT_CWD_());
      return JSON.stringify(result, null, 2);
    }

    case 'get_tab_plan': {
      const tabId = args.tabId || PARENT_TAB_ID();
      if (!tabId) throw new Error('tabId is required outside a parent Noted Terminal tab');
      const target = projectHint(args, tabId);
      const projectParam = target.projectId
        ? '&parentProjectId=' + encodeURIComponent(target.projectId)
        : '';
      const endpoint = '/terminal/tab-plan?tabId=' + encodeURIComponent(tabId) + projectParam;
      const result = target.port
        ? await httpGetOnPort(target.port, endpoint)
        : await httpGet(endpoint, target.cwd);
      return JSON.stringify(result, null, 2);
    }

    case 'apply_tab_plan_changes': {
      const tabId = args.tabId || PARENT_TAB_ID();
      if (!tabId) throw new Error('tabId is required outside a parent Noted Terminal tab');
      const target = projectHint(args, tabId);
      const body = {
        tabId,
        operations: args.operations,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/tab-plan/apply', body)
        : await httpPost('/terminal/tab-plan/apply', body, target.cwd);
      return JSON.stringify({
        success: result.success === true,
        changed: result.changed === true,
        tabId,
        plan: result.document,
      }, null, 2);
    }

    case 'restart_process': {
      const target = projectHint(args, args.tabId);
      const body = {
        tabId: args.tabId,
        command: args.command || undefined,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/restart', body)
        : await httpPost('/terminal/restart', body, target.cwd);
      return 'Restart initiated for tab ' + args.tabId + '. Status: ' + result.status;
    }

    case 'run_command': {
      const target = projectHint(args, args.tabId);
      const body = {
        tabId: args.tabId,
        command: args.command,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/run', body)
        : await httpPost('/terminal/run', body, target.cwd);
      return 'Command sent to tab ' + args.tabId + ': ' + args.command;
    }

    case 'send_prompt': {
      const target = projectHint(args, args.tabId);
      if (args.submit !== false) {
        await ensureAgentModelSelectionSupport(target, args);
        const result = await httpApiPost(
          target,
          '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/send',
          {
            prompt: args.prompt,
            prompts: args.prompts || undefined,
            files: await contextFilesForSupportedTarget(target, args.files),
            modelSelection: args.modelSelection || undefined,
            model: args.model || undefined,
            effort: args.effort || undefined,
            thinking: args.thinking || undefined,
            source: 'terminal-mcp',
            queue: args.queue === true,
            handoffId: args.handoffId || undefined,
          },
        );
        if (result.status === 'delivery-unknown' || result.deliveryUnknown === true) {
          return 'Prompt delivery state is unknown for tab ' + args.tabId
            + '; do not retry with a new operation.'
            + (result.handoffId ? ' Recheck only this handoff: ' + result.handoffId + '.' : '');
        }
        if (result.status === 'audit-pending' || result.auditPending === true) {
          return 'Prompt Enter crossed in tab ' + args.tabId
            + ' through Project API scenario layer. Exact delivery confirmation is pending; do not retry this handoff.'
            + (result.handoffId ? ' Handoff: ' + result.handoffId + '.' : '');
        }
        return 'Prompt sent to tab ' + args.tabId + ' through Project API scenario layer. Status: ' + (result.status || 'sent')
          + (result.queued ? ' (queued)' : '')
          + (result.handoffId ? '. Handoff: ' + result.handoffId : '');
      }

      if (Array.isArray(args.files) && args.files.length > 0) {
        throw new Error('files require submit=true so the Project API can resolve one atomic snapshot');
      }

      const body = {
        tabId: args.tabId,
        prompt: args.prompt,
        submit: args.submit !== false,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/ai-prompt', body)
        : await httpPost('/terminal/ai-prompt', body, target.cwd);
      return 'Prompt pasted as editable draft into tab ' + args.tabId + '. Status: ' + result.status;
    }

    case 'start_ai': {
      const target = projectHint(args, args.tabId);
      const provider = args.agent === 'claude' || args.agent === 'codex' ? args.agent : null;
      await ensureAgentModelSelectionSupport(target, args);
      const resolvedSelection = provider && args.modelSelection
        ? await httpApiPost(target, '/api/agent-models/resolve', {
            toolType: provider,
            modelSelection: args.modelSelection,
          })
        : null;
      const selectedModel = resolvedSelection?.model || args.model;
      const body = buildStartAiRequest({ ...args, model: selectedModel }, target, buildSourceMeta());
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/ai-start', body)
        : await httpPost('/terminal/ai-start', body, target.cwd);
      return 'AI start requested in tab ' + args.tabId + ': ' + result.agent + ' ' + result.status + (result.sessionId ? ' session=' + result.sessionId : '');
    }

    case 'read_output': {
      const lines = Math.min(args.lines || 50, 500);
      const target = projectHint(args, args.tabId);
      const idParam = target.projectId ? '&parentProjectId=' + encodeURIComponent(target.projectId) : '';
      const endpoint = '/terminal/output?tabId=' + encodeURIComponent(args.tabId) + '&lines=' + lines + idParam;
      const result = target.port
        ? await httpGetOnPort(target.port, endpoint)
        : await httpGet(endpoint, target.cwd);
      if (!result.output || result.output.trim().length === 0) {
        return 'No output captured for tab ' + args.tabId;
      }
      return 'Last ' + result.lines + ' lines from tab ' + args.tabId + ':\n\n' + result.output;
    }

    case 'close_tab': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiPost(
        target,
        '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/close',
        {
          requireIdle: args.force !== true,
          aiBusy: args.force === true,
        },
      );
      return JSON.stringify({
        ok: result?.success !== false && result?.closed !== false,
        tabId: args.tabId,
        ...result,
      }, null, 2);
    }

    case 'list_windows': {
      const target = resolveExternalCreateTarget(args);
      const sourceTabId = PARENT_TAB_ID() || '';
      const data = await httpApiGet(
        target,
        '/api/workspace' + (sourceTabId ? '?sourceTabId=' + encodeURIComponent(sourceTabId) : ''),
      );
      if (args.spaceId) {
        data.selectedSpace = (data.spaces || []).find((space) => space.id === args.spaceId) || null;
        if (!data.selectedSpace) throw new Error('Workflow not found: ' + args.spaceId);
      }
      return JSON.stringify(data, null, 2);
    }

    case 'create_window': {
      const target = resolveExternalCreateTarget(args);
      const windowTarget = {
        ...(args.windowTarget || {}),
        mode: 'new-window',
        side: args.side || args.windowTarget?.side || 'right',
        reveal: args.reveal === true || args.windowTarget?.reveal === true,
      };
      const data = await httpApiPost(target, '/api/workspace/windows', {
        sourceTabId: PARENT_TAB_ID() || undefined,
        windowTarget,
        side: windowTarget.side,
        focus: args.focus === true,
        reveal: windowTarget.reveal === true,
      });
      return JSON.stringify(data, null, 2);
    }

    case 'open_tabs_in_window': {
      const target = resolveExternalCreateTarget(args);
      const data = await httpApiPost(target, '/api/workspace/place-tabs', {
        sourceTabId: PARENT_TAB_ID() || undefined,
        windowTarget: args.windowTarget || {},
        entries: args.tabs,
        show: args.show !== false,
        focus: args.show !== false,
        reveal: args.reveal === true || args.windowTarget?.reveal === true,
      });
      return JSON.stringify(data, null, 2);
    }

    case 'arrange_windows': {
      const target = resolveExternalCreateTarget(args);
      // A bare id is a window of one tab, so the caller can write
      // `windows: ["a", "b"]` for the common "each in its own window" case.
      const windows = (Array.isArray(args.windows) ? args.windows : [])
        .map((entry) => (Array.isArray(entry) ? entry : [entry]));
      const windowTarget = {
        ...(args.windowTarget || {}),
        ...(Number.isInteger(args.anchorIndex) && !args.windowTarget?.windowRef
          ? { windowIndex: args.anchorIndex }
          : {}),
      };
      const data = await httpApiPost(target, '/api/workspace/arrange', {
        windows,
        side: args.side,
        divide: args.divide,
        anchorIndex: args.anchorIndex,
        sourceTabId: PARENT_TAB_ID() || undefined,
        windowTarget: Object.keys(windowTarget).length > 0 ? windowTarget : undefined,
        show: args.show !== false,
        focus: args.show !== false,
        reveal: args.reveal === true || args.windowTarget?.reveal === true,
      });
      return JSON.stringify(data, null, 2);
    }

    case 'fork_tab': {
      const target = resolveExternalCreateTarget(args);
      const data = await httpApiPost(
        target,
        '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/fork',
        {
          name: args.name,
          fullHistory: args.fullHistory === true,
          background: args.background !== false,
          windowTarget: args.windowTarget || undefined,
        },
      );
      return JSON.stringify(data, null, 2);
    }

    case 'create_tab': {
      const target = resolveExternalCreateTarget(args);
      const agent = simpleAgentCommand(args.command);
      if (agent) await ensureAgentModelSelectionSupport(target, args);
      const body = {
        projectId: args.projectId || undefined,
        fallbackProjectId: target.projectId || PARENT_PROJECT_ID() || undefined,
        name: args.name || undefined,
        cwd: args.cwd || undefined,
        command: args.command || undefined,
        color: args.color || undefined,
        background: args.background !== false,
        sourceTabId: PARENT_TAB_ID() || undefined,
        windowTarget: args.windowTarget || undefined,
        placement: args.placement || 'child',
        parentTabId: args.parentTabId || undefined,
        modelSelection: agent ? args.modelSelection || undefined : undefined,
        model: agent ? args.model || undefined : undefined,
        effort: args.effort || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = agent
        ? await httpApiPost(target, '/api/agent-tabs', { ...body, toolType: agent })
        : await httpApiPost(target, '/api/terminal-tabs', body);
      return JSON.stringify(result, null, 2);
    }

    case 'kill_process': {
      const target = projectHint(args, args.tabId);
      const body = {
        tabId: args.tabId,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/kill', body)
        : await httpPost('/terminal/kill', body, target.cwd);
      return 'Process killed in tab ' + args.tabId;
    }

    case 'stop_ai': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiPost(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/stop', {});
      if (result.stopped === false) {
        return 'AI stop requested for tab ' + args.tabId + ', but no active session was stopped. Reason: ' + (result.reason || 'unknown');
      }
      return 'AI stop requested for tab ' + args.tabId + ' through Project API scenario layer.';
    }

    case 'interrupt_ai': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiPost(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/interrupt', {});
      if (result.interruptConfirmed === true) {
        return 'AI turn interruption confirmed for tab ' + args.tabId + '.';
      }
      if (result.interruptRequested === true) {
        return 'Interrupt request delivered to the active AI turn in tab ' + args.tabId
          + '; turn interruption is not yet confirmed.';
      }
      if (result.interrupted === false) {
        return 'AI interrupt requested for tab ' + args.tabId + ', but no active turn was interrupted. Reason: ' + (result.reason || 'unknown');
      }
      return 'Interrupt request delivered to the active AI turn in tab ' + args.tabId + ' through Project API scenario layer.';
    }

    case 'read_draft': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiGet(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/draft');
      // A consumed draft is a structured transfer. Returning just non-empty
      // text loses image paths, ownership/result fields and recovery evidence.
      return JSON.stringify({ tabId: args.tabId, ...result }, null, 2);
    }

    case 'draft_state': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiGet(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/draft-state');
      return 'Draft state for tab ' + args.tabId + ':\n\n' + JSON.stringify(result, null, 2);
    }

    case 'rewind_ai': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiPost(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/rewind', {
        mode: args.mode || 'native',
        targetIndex: args.targetIndex,
        targetText: args.targetText,
        targetFullText: args.targetFullText,
        rewindableCount: args.rewindableCount,
        skipDuplicates: args.skipDuplicates || 0,
        startUuid: args.startUuid || args.targetUuid || undefined,
        endUuid: args.endUuid || undefined,
        additionalPrompt: args.additionalPrompt || undefined,
      });
      return 'Rewind requested for tab ' + args.tabId + ':\n\n' + JSON.stringify(result, null, 2);
    }

    case 'get_pending_question': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiGet(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/pending-question');
      return 'Pending question for tab ' + args.tabId + ':\n\n' + JSON.stringify(result.pendingQuestion || null, null, 2);
    }

    case 'answer_question': {
      const target = projectHint(args, args.tabId);
      const result = await httpApiPost(target, '/api/terminal-tabs/' + encodeURIComponent(args.tabId) + '/answer-question', {
        source: args.source || 'pty',
        toolUseID: args.toolUseID || undefined,
        questions: args.questions || undefined,
        answers: args.answers || {},
        stop: args.stop === true,
      });
      return 'Question action result for tab ' + args.tabId + ':\n\n' + JSON.stringify(result, null, 2);
    }

    case 'run_chain': {
      const firstStep = Array.isArray(args.steps) ? args.steps.find(s => s && s.tabId) : null;
      const target = projectHint(args, firstStep?.tabId);
      const body = {
        steps: args.steps,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/chain', body)
        : await httpPost('/terminal/chain', body, target.cwd);
      let text = 'Chain completed (' + (result.results || []).length + ' steps):\n';
      for (const r of (result.results || [])) {
        text += '\n- ' + r.step + ' → ' + r.status;
        if (r.error) text += ' (error: ' + r.error + ')';
      }
      return text;
    }

    case 'build_install_noted_terminal': {
      const returnToTabId = args.returnToTabId || args.tabId || PARENT_TAB_ID() || '';
      const target = projectHint({ projectId: args.projectId, cwd: args.cwd }, returnToTabId || undefined);
      let sessionId = args.sessionId || '';
      let tabName = '';
      let commandType = '';

      if (returnToTabId && !sessionId) {
        try {
          const params = ['cwd=' + encodeURIComponent(target.cwd || PROJECT_CWD_()), 'color='];
          if (target.projectId) params.push('parentProjectId=' + encodeURIComponent(target.projectId));
          const result = target.port
            ? await httpGetOnPort(target.port, '/terminal/tabs?' + params.join('&'))
            : await httpGet('/terminal/tabs?' + params.join('&'), target.cwd);
          const tab = (result.tabs || []).find(t => t && t.tabId === returnToTabId);
          if (tab) {
            sessionId = tab.sessionId || tab.claudeSessionId || tab.codexSessionId || tab.geminiSessionId || '';
            tabName = tab.name || '';
            commandType = tab.commandType || '';
          }
        } catch {
          // Return callback can still use tabId even if session lookup failed.
        }
      }

      const returnTo = returnToTabId || sessionId ? {
        tabId: returnToTabId,
        sessionId,
        projectId: target.projectId || PARENT_PROJECT_ID() || '',
        projectPath: target.cwd || PROJECT_CWD_(),
        source: 'terminal-mcp',
        prompt: args.prompt || '',
        notifyOnSuccess: args.notifyOnSuccess !== false,
        failurePrompt: args.failurePrompt || '',
        notifyOnFailure: args.notifyOnFailure === true,
        timeoutMs: args.timeoutMs || undefined,
        pollMs: args.pollMs || undefined,
      } : undefined;

      const result = await httpPostVoice('/api/terminal/build-install', { returnTo });
      const job = result.body?.job || {};
      let text = 'Voice Record accepted Noted Terminal build:install.';
      text += '\nVoice Record: pid=' + result.pid + ' port=' + result.port;
      if (job.id) text += '\nJob: ' + job.id;
      text += '\nVoice Record will first WAIT for every other Noted Terminal blocker (neighbour tabs/projects mid-turn or a Restart-after-owned shell command) to go idle before spawning the build; your own tab' + (returnToTabId ? ' (' + returnToTabId + ')' : '') + ' is excluded from that wait. Manual shell commands are not blockers by themselves. Live blockers + phase are in GET /api/terminal/build-install (job.phase / job.wait).';
      if (returnTo) {
        text += '\nReturn target: tab=' + (returnTo.tabId || '-') + (sessionId ? ' session=' + sessionId : ' session=(not yet known)');
        if (tabName || commandType) text += ' (' + [tabName, commandType].filter(Boolean).join(', ') + ')';
        text += args.notifyOnSuccess === false
          ? '\nSuccess callback disabled; the return target is retained only to exclude this busy tab from the idle wait.'
          : '\nVoice Record will wait for Noted Terminal to reopen, for this tab/session to be restored, then it will send the completion prompt via the Project API scenario send path.';
      } else {
        text += '\nNo return target was available, so this is fire-and-forget with status only in Voice Record GET /api/terminal/build-install.';
      }
      return text;
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
  buffer += line;
  try {
    const msg = JSON.parse(buffer);
    buffer = '';
    const response = await handleRequest(msg);
    if (response) {
      process.stdout.write(response + '\n');
    }
  } catch {
    // Incomplete JSON — accumulate
  }
});

process.stderr.write('[terminal-server] MCP server started\n');
