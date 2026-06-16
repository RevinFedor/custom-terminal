#!/usr/bin/env node
// =============================================================================
// MCP Terminal Server — manage terminal tabs in Noted Terminal
// Standalone process. Communicates with Noted Terminal via HTTP on localhost.
// Implements MCP JSON-RPC 2.0 over stdio (zero SDK dependencies).
//
// Tools: list_tabs, restart_process, run_command, start_ai, send_prompt,
//        read_output, create_tab, kill_process, stop_ai, run_chain
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const PORT_DIR = join(homedir(), '.noted-terminal');
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
const PARENT_PROJECT_ID = EXTERNAL_MODE ? '' : (process.env.NOTED_PARENT_PROJECT_ID || '');
const PARENT_TAB_ID = EXTERNAL_MODE ? '' : (process.env.NOTED_PARENT_TAB_ID || '');

process.stderr.write(`[terminal-server] Project CWD: ${PROJECT_CWD}\n`);
if (PARENT_PROJECT_ID) {
  process.stderr.write(`[terminal-server] parentProjectId: ${PARENT_PROJECT_ID} tabId: ${PARENT_TAB_ID}\n`);
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
  const hintPid = parseInt(process.env.NOTED_MAIN_PID || '', 10);
  if (hintPid) {
    const pinned = instances.find(i => i.pid === hintPid);
    if (pinned) return pinned;
    // pinned pid not in live list — fall through, instance probably died
  }
  // Priority 2: cwd longest-prefix
  const target = cwd || PROJECT_CWD;
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
  const projectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID || '';
  const decodedCwd = cwdFromTabId(tabId || args.tabId);
  const cwd = args.cwd || decodedCwd || PROJECT_CWD;
  const project = findOpenProject({ projectId, cwd });
  return {
    projectId,
    cwd: project?.path || cwd,
    port: project?.port || null,
  };
}

function resolveExternalCreateTarget(args = {}) {
  const explicitProjectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID || '';
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
  return { projectId: projects[0].id, cwd: projects[0].path || PROJECT_CWD, port: projects[0].port };
}

function buildSourceMeta() {
  return {
    server: 'terminal',
    mode: EXTERNAL_MODE ? 'external' : 'internal',
    projectId: PARENT_PROJECT_ID || '',
    tabId: PARENT_TAB_ID || '',
    cwd: PROJECT_CWD,
  };
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

async function httpPostVoice(endpoint, body) {
  const token = readSharedToken();
  if (!token) throw new Error('Shared web token not found at ' + TOKEN_PATH);
  const instances = listLiveVoiceInstances();
  if (!instances.length) throw new Error('Voice Record web server is not running (no live voice-web-server-*.json in ' + PORT_DIR + ')');

  let lastError = null;
  for (const inst of instances) {
    try {
      const res = await fetch('http://127.0.0.1:' + inst.port + endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
      return { port: inst.port, pid: inst.pid, body: json };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Voice Record web server request failed');
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List live Noted Terminal projects visible to the MCP bridge. Use this first when the caller is an external app (for example Voice Record) and there is no parent terminal tab/project.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_tabs',
    description: 'List terminal tabs. In Claude/Codex inside Noted Terminal, this is scoped to the parent project. In external mode (Voice Record), omit projectId/cwd to list tabs across all open Noted Terminal projects, or pass projectId/cwd to scope one project. By default returns only green devServer tabs; pass color="" to see all tabs. AI tabs include sessionId when known so you can jump into overseer MCP reads.',
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
    description: 'Send text to a live AI tab (Claude, Codex, or Gemini) using the correct TUI-safe path instead of a raw shell write. Default `submit=true` sends the prompt immediately. Pass `submit=false` to paste an editable draft into the agent input without pressing Enter. Use this for AI tabs; use run_command for generic shells.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'AI tab ID from list_tabs' },
        prompt: { type: 'string', description: 'Prompt text to paste into the live AI session' },
        submit: { type: 'boolean', description: 'Default true. Set false to leave the prompt editable in the input box.' },
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
        model: { type: 'string', description: 'Optional Codex model override' },
        effort: { type: 'string', description: 'Optional Codex effort override' },
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
    description: 'Create a new terminal tab in the parent project (the one that owns this Claude session). By default the tab opens in background and does not steal the user\'s active tab; pass background=false only when the user explicitly asks to focus it. When NOTED_PARENT_PROJECT_ID is set, the tab is placed in that project unconditionally, ignoring which project the user is currently looking at. AI commands are routed through native launch hooks when command is "codex", "claude", "codex-c <sessionId>", "codex-f <sessionId>", "claude-c <sessionId>", "claude-f <sessionId>", or "claude --resume <sessionId>". Other commands are treated as devServer/shell commands.\n\nIMPORTANT — REUSE EXISTING TABS BEFORE CREATING NEW ONES:\nBefore calling create_tab with a dev-server command (npm run dev / pnpm dev / yarn dev / vite / next dev), ALWAYS call list_tabs first. list_tabs returns the green devServer tabs by default — these are the project\'s existing dev-server channels. If one already exists for this project:\n  - If it is RUNNING and you want to pick up code changes → use restart_process (Ctrl+C → re-run original command, same shell, output buffer preserved).\n  - If it is IDLE / running a different command → use kill_process + run_command, or restart_process with the `command` override.\nOnly call create_tab when list_tabs returned ZERO green tabs for this project. Creating a fresh tab on every iteration accumulates orphan tabs in the user\'s UI and leaks processes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tab name (e.g. "build-watch", "run-dev")' },
        cwd: { type: 'string', description: 'Working directory (default: project root)' },
        command: { type: 'string', description: 'Command to run on creation (e.g. "npm run dev")' },
        color: { type: 'string', description: 'Tab color override' },
        background: { type: 'boolean', description: 'Default true. Keep MCP-created tabs in background; set false only when the user explicitly wants focus.' },
        projectId: { type: 'string', description: 'Optional Noted Terminal project id from list_projects. Required in external mode when multiple projects are open and cwd is omitted.' },
      },
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
    description: 'Ask the external Voice Record app to run Noted Terminal `npm run build:install`. Use this instead of run_command/build:i when the caller is inside Noted Terminal: the app will quit/reinstall/reopen, while Voice Record survives and sends a completion prompt back to the originating AI tab after the original tab/session is restored. This tool returns as soon as Voice Record accepts the job; it does not wait for the build. Before spawning the build, Voice Record OBSERVES the running prod app via GET /api/active-loaders and waits until every OTHER session (neighbour tabs/projects with a live Claude/Codex/Gemini turn or a running process like `npm run dev`) goes idle — the caller\'s own tab is excluded so it never deadlocks on itself. Because build:install pkills the whole app, this protects residual neighbour work; the wait can be long if a neighbour project is mid-turn. Progress (current blockers / phase pending→observing→building→finished) is visible in Voice Record GET /api/terminal/build-install under job.phase and job.wait.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Optional success prompt Voice Record should send back to the originating AI tab after install and session restore. Default is a short Russian completion message.',
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
      serverInfo: { name: 'noted-terminal-tabs', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized') return null; // no response needed

  if (method === 'tools/list') {
    return jsonRpcResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await callTool(name, args || {});
      return jsonRpcResponse(id, { content: [{ type: 'text', text: result }] });
    } catch (err) {
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: 'Error: ' + err.message }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, 'Method not found: ' + method);
}

async function callTool(name, args) {
  switch (name) {
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

    case 'list_tabs': {
      const color = args.color !== undefined ? args.color : 'green';
      const colorParam = color ? '&color=' + encodeURIComponent(color) : '';
      const requestedProjectId = args.projectId || args.parentProjectId || PARENT_PROJECT_ID || '';
      const requestedCwd = args.cwd || '';
      const listAll = args.allProjects === true || (EXTERNAL_MODE && !requestedProjectId && !requestedCwd && !PARENT_PROJECT_ID);

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
        const params = ['cwd=' + encodeURIComponent(target.cwd || PROJECT_CWD)];
        if (color) params.push('color=' + encodeURIComponent(color));
        if (target.projectId) params.push('parentProjectId=' + encodeURIComponent(target.projectId));
        const result = target.port
          ? await httpGetOnPort(target.port, '/terminal/tabs?' + params.join('&'))
          : await httpGet('/terminal/tabs?' + params.join('&'), target.cwd);
        tabs = (result.tabs || []).map(t => ({ ...t, projectId: target.projectId || undefined }));
        scope = target.projectId ? ('project id ' + target.projectId) : (target.cwd || PROJECT_CWD);
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
      return (args.submit === false ? 'Prompt pasted into tab ' : 'Prompt sent to tab ') + args.tabId + '. Status: ' + result.status;
    }

    case 'start_ai': {
      const target = projectHint(args, args.tabId);
      const body = {
        tabId: args.tabId,
        agent: args.agent,
        sessionId: args.sessionId || undefined,
        mode: args.mode || undefined,
        cwd: args.cwd || target.cwd || undefined,
        model: args.model || undefined,
        effort: args.effort || undefined,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
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

    case 'create_tab': {
      const target = resolveExternalCreateTarget(args);
      const cwd = args.cwd || target.cwd || PROJECT_CWD;
      const body = {
        name: args.name || undefined,
        cwd,
        command: args.command || undefined,
        color: args.color || undefined,
        background: args.background !== false,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/create', body)
        : await httpPost('/terminal/create', body, cwd);
      return 'Tab creation initiated in ' + (args.background === false ? 'foreground' : 'background') + '. ' + (args.command ? 'Running: ' + args.command : 'Empty shell.');
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
      const body = {
        tabId: args.tabId,
        parentProjectId: target.projectId || undefined,
        sourceMeta: buildSourceMeta(),
      };
      const result = target.port
        ? await httpPostOnPort(target.port, '/terminal/ai-stop', body)
        : await httpPost('/terminal/ai-stop', body, target.cwd);
      return 'AI stopped in tab ' + args.tabId + '. Status: ' + result.status;
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
      const returnToTabId = args.returnToTabId || args.tabId || PARENT_TAB_ID || '';
      const target = projectHint({ projectId: args.projectId, cwd: args.cwd }, returnToTabId || undefined);
      let sessionId = args.sessionId || '';
      let tabName = '';
      let commandType = '';

      if (returnToTabId && !sessionId) {
        try {
          const params = ['cwd=' + encodeURIComponent(target.cwd || PROJECT_CWD), 'color='];
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
        projectId: target.projectId || PARENT_PROJECT_ID || '',
        projectPath: target.cwd || PROJECT_CWD,
        source: 'terminal-mcp',
        prompt: args.prompt || '',
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
      text += '\nVoice Record will first WAIT for every other Noted Terminal session (neighbour tabs/projects mid-turn or running a process) to go idle before spawning the build; your own tab' + (returnToTabId ? ' (' + returnToTabId + ')' : '') + ' is excluded from that wait. Live blockers + phase are in GET /api/terminal/build-install (job.phase / job.wait).';
      if (returnTo) {
        text += '\nReturn target: tab=' + (returnTo.tabId || '-') + (sessionId ? ' session=' + sessionId : ' session=(not yet known)');
        if (tabName || commandType) text += ' (' + [tabName, commandType].filter(Boolean).join(', ') + ')';
        text += '\nVoice Record will wait for Noted Terminal to reopen, for this tab/session to be restored, then it will send the completion prompt via /terminal/ai-prompt.';
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
