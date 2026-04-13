#!/usr/bin/env node
// =============================================================================
// MCP Terminal Server — manage terminal tabs in Noted Terminal
// Standalone process. Communicates with Noted Terminal via HTTP on localhost.
// Implements MCP JSON-RPC 2.0 over stdio (zero SDK dependencies).
//
// Tools: list_tabs, restart_process, run_command, read_output,
//        create_tab, kill_process, run_chain
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const PORT_DIR = join(homedir(), '.noted-terminal');

// Resolve project CWD: --project /path, or CLAUDE_PROJECT_DIR, or cwd
const projectArgIdx = process.argv.indexOf('--project');
const PROJECT_CWD = (projectArgIdx !== -1 && process.argv[projectArgIdx + 1])
  ? process.argv[projectArgIdx + 1]
  : process.env.CLAUDE_PROJECT_DIR || process.cwd();

process.stderr.write(`[terminal-server] Project CWD: ${PROJECT_CWD}\n`);

// ---------------------------------------------------------------------------
// Port Discovery (same as mcp-server.mjs)
// ---------------------------------------------------------------------------

function getPort() {
  // Find most recent port file with a live process
  try {
    const files = readdirSync(PORT_DIR).filter(f => f.startsWith('mcp-port-'));
    let best = null;
    let bestMtime = 0;
    for (const f of files) {
      const pid = parseInt(f.replace('mcp-port-', ''));
      if (!pid) continue;
      try {
        process.kill(pid, 0); // check alive
        const mtime = statSync(join(PORT_DIR, f)).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          best = f;
        }
      } catch {} // dead process, skip
    }
    if (best) {
      return parseInt(readFileSync(join(PORT_DIR, best), 'utf-8').trim());
    }
  } catch {}

  return null;
}

async function httpGet(endpoint) {
  const port = getPort();
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');

  const res = await fetch('http://127.0.0.1:' + port + endpoint);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

async function httpPost(endpoint, body) {
  const port = getPort();
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');

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

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_tabs',
    description: 'List terminal tabs in the current project. By default returns only green (devServer) tabs — the ones running npm run dev or similar long-running processes. Pass color="" to see all tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        color: {
          type: 'string',
          description: 'Filter by tab color. Default: "green" (devServer tabs). Pass empty string for all tabs. Options: green, claude, gemini, default, red, blue, yellow, purple.',
        },
      },
    },
  },
  {
    name: 'restart_process',
    description: 'Restart a terminal process. Kills the current PTY and re-creates it with the same working directory and initial command. Use this after changing code that requires a full process restart (e.g. main.js changes in Electron, backend server changes).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID from list_tabs' },
        command: { type: 'string', description: 'Optional: override the restart command (default: reuse original command)' },
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
      },
      required: ['tabId', 'command'],
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
      },
      required: ['tabId'],
    },
  },
  {
    name: 'create_tab',
    description: 'Create a new terminal tab with an optional command. If a command is provided, the tab will be marked as devServer (green color) automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tab name (e.g. "build-watch", "run-dev")' },
        cwd: { type: 'string', description: 'Working directory (default: project root)' },
        command: { type: 'string', description: 'Command to run on creation (e.g. "npm run dev")' },
        color: { type: 'string', description: 'Tab color override' },
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
      },
      required: ['steps'],
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
    case 'list_tabs': {
      const color = args.color !== undefined ? args.color : 'green';
      const colorParam = color ? '&color=' + encodeURIComponent(color) : '';
      const result = await httpGet('/terminal/tabs?cwd=' + encodeURIComponent(PROJECT_CWD) + colorParam);
      const tabs = result.tabs || [];

      if (tabs.length === 0) {
        return 'No terminal tabs found' + (color ? ' with color "' + color + '"' : '') + ' in project: ' + PROJECT_CWD;
      }

      let text = 'Terminal tabs (' + tabs.length + '):\n';
      for (const t of tabs) {
        const status = t.isAlive ? (t.isRunning ? 'RUNNING' : 'IDLE') : 'DEAD';
        text += '\n- ' + t.name + ' [' + status + ']';
        text += '\n  ID: ' + t.tabId;
        text += '\n  Color: ' + t.color + ' | Type: ' + t.commandType;
        text += '\n  CWD: ' + t.cwd;
        if (t.initialCommand) text += '\n  Command: ' + t.initialCommand;
        if (t.pid) text += '\n  PID: ' + t.pid;
        text += '\n';
      }
      return text;
    }

    case 'restart_process': {
      const result = await httpPost('/terminal/restart', {
        tabId: args.tabId,
        command: args.command || undefined,
      });
      return 'Restart initiated for tab ' + args.tabId + '. Status: ' + result.status;
    }

    case 'run_command': {
      const result = await httpPost('/terminal/run', {
        tabId: args.tabId,
        command: args.command,
      });
      return 'Command sent to tab ' + args.tabId + ': ' + args.command;
    }

    case 'read_output': {
      const lines = Math.min(args.lines || 50, 500);
      const result = await httpGet('/terminal/output?tabId=' + encodeURIComponent(args.tabId) + '&lines=' + lines);
      if (!result.output || result.output.trim().length === 0) {
        return 'No output captured for tab ' + args.tabId;
      }
      return 'Last ' + result.lines + ' lines from tab ' + args.tabId + ':\n\n' + result.output;
    }

    case 'create_tab': {
      const result = await httpPost('/terminal/create', {
        name: args.name || undefined,
        cwd: args.cwd || PROJECT_CWD,
        command: args.command || undefined,
        color: args.color || undefined,
      });
      return 'Tab creation initiated. ' + (args.command ? 'Running: ' + args.command : 'Empty shell.');
    }

    case 'kill_process': {
      const result = await httpPost('/terminal/kill', { tabId: args.tabId });
      return 'Process killed in tab ' + args.tabId;
    }

    case 'run_chain': {
      const result = await httpPost('/terminal/chain', { steps: args.steps });
      let text = 'Chain completed (' + (result.results || []).length + ' steps):\n';
      for (const r of (result.results || [])) {
        text += '\n- ' + r.step + ' → ' + r.status;
        if (r.error) text += ' (error: ' + r.error + ')';
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
