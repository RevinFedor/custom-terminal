#!/usr/bin/env node
// MCP Server for Noted Terminal: Gemini → Claude delegation
// Standalone process launched by Gemini CLI as an MCP tool server.
// Communicates with Noted Terminal's main process via HTTP on localhost.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const PORT_DIR = join(homedir(), '.noted-terminal');

// Walk up process tree from a PID, returning ancestor PIDs
// Chain: mcp-server → Gemini CLI → zsh/bash → Electron (node-pty)
function getAncestorPids(startPid, levels) {
  const pids = [];
  let pid = startPid;
  for (let i = 0; i < levels; i++) {
    try {
      const ppid = parseInt(execSync('ps -p ' + pid + ' -o ppid=', { encoding: 'utf-8' }).trim());
      if (!ppid || ppid <= 1) break;
      pids.push(ppid);
      pid = ppid;
    } catch {
      break;
    }
  }
  return pids;
}

function getPort() {
  // Strategy 1: Walk up process tree to find our Electron instance's port file
  // Chain: mcp-server(ppid=Gemini) → Gemini → zsh → Electron
  const ancestors = getAncestorPids(process.ppid, 4);
  for (const pid of ancestors) {
    try {
      const port = parseInt(readFileSync(join(PORT_DIR, 'mcp-port-' + pid), 'utf-8').trim());
      if (port > 0) return port;
    } catch {}
  }

  // Strategy 2: Fallback — find most recent port file with a live process
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

  // Strategy 3: Legacy single file (backward compat during migration)
  try {
    return parseInt(readFileSync(join(PORT_DIR, 'mcp-port'), 'utf-8').trim());
  } catch {}

  return null;
}

async function httpPost(endpoint, body) {
  const port = getPort();
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');

  const url = 'http://127.0.0.1:' + port + endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  }
  return json;
}

async function httpGet(endpoint) {
  const port = getPort();
  if (!port) throw new Error('Noted Terminal is not running');

  const url = 'http://127.0.0.1:' + port + endpoint;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  }
  return json;
}

// Create MCP server
const server = new Server(
  { name: 'noted-terminal', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'delegate_to_claude',
      description: 'Delegate a task to Claude Code. Claude runs in a visible terminal tab with full capabilities (file editing, bash, etc). IMPORTANT: This is fire-and-forget. The result will be AUTOMATICALLY delivered back into your terminal when Claude finishes — you do NOT need to poll or check status. After calling this tool, simply continue with your other work or wait for the result to appear in your conversation. Do NOT call get_task_status in a loop.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task description / prompt to send to Claude Code. If you need a specific model, put the /model command on the first line followed by the prompt on the next line.',
          },
          name: {
            type: 'string',
            description: 'Optional: custom name for the agent tab (e.g. "refactor-auth", "fix-bug-123"). If not provided, defaults to "claude-sub".',
          },
          session_id: {
            type: 'string',
            description: 'Optional: existing Claude session UUID to resume. If provided, the agent will continue this session instead of starting fresh. Use this to attach an existing conversation as a sub-agent.',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'send_claude_command',
      description: 'Send a slash command to the active Claude Code sub-agent (e.g. /compact, /model sonnet, /clear). Only use this for managing Claude\'s context or switching models. Do NOT use this to check status — results are delivered automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The slash command to send (e.g. "/compact", "/model sonnet")',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'continue_claude',
      description: 'Send a follow-up message to an EXISTING Claude Code sub-agent. Use this instead of delegate_to_claude when you want to continue a conversation with the same agent (same session, same context). The agent must have been previously created via delegate_to_claude. If the agent\'s process died (e.g. after app restart), it will be automatically resumed. The result will be AUTOMATICALLY delivered back — no need to poll. You can also rename the agent tab by passing the optional "name" parameter.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID from the original delegate_to_claude call',
          },
          prompt: {
            type: 'string',
            description: 'The follow-up message to send to the existing Claude agent',
          },
          name: {
            type: 'string',
            description: 'Optional: rename the agent tab (e.g. "refactor-auth", "fix-bug-123")',
          },
        },
        required: ['taskId', 'prompt'],
      },
    },
    {
      name: 'list_sub_agents',
      description: 'List all Claude Code sub-agents linked to your current Gemini tab. Returns task IDs, session IDs, and status for each agent. Use this to discover existing agents before calling continue_claude, especially after app restart when you may not remember task IDs.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'read_claude_history',
      description: 'Read the conversation history of a Claude Code sub-agent. By default returns ONLY the LAST turn (last_n=1). You control what to read via last_n.\n\nUse this when you need to understand WHAT Claude did and WHY — not just the final result. Returns Claude\'s thinking process, responses, and actions.\n\nDetail levels:\n- "summary": Only the last response with thinking (quick check)\n- "full" (default): User prompts, Claude thinking, responses, and action labels\n- "with_code": Same as full but includes edit diffs and command output\n\nExamples:\n- Quick check last response: detail="summary" (last_n is ignored for summary)\n- Re-read last turn with code: detail="with_code", last_n=1\n- Get context of last 3 turns: last_n=3\n- Full session dump: last_n=0 (all turns, use sparingly)',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID from delegate_to_claude or list_sub_agents',
          },
          detail: {
            type: 'string',
            enum: ['summary', 'full', 'with_code'],
            description: 'Level of detail. "summary" = last response only, "full" = turns with thinking and action labels, "with_code" = full + edit diffs and command output. Default: "full"',
          },
          last_n: {
            type: 'integer',
            description: 'Number of recent turns to return. Default: 1 (last turn only). Set to 0 for all turns (use sparingly — sessions can be very large).',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'get_task_status',
      description: 'Check the status of a delegated task. Use this ONLY if you need a one-time diagnostic check. Do NOT poll this in a loop — results are automatically delivered to your terminal when the task completes.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID returned by delegate_to_claude',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'update_docs',
      description: 'Run "Update Docs" analysis on one or more Claude sub-agent sessions via API. Exports each agent\'s session history, sends it with the documentation prompt to an AI API (Claude or Gemini), and returns the analysis results directly.\n\nUse list_sub_agents first to get task IDs. This is SYNCHRONOUS — results are returned in the tool response. Processing may take 30-120 seconds per session depending on size.',
      inputSchema: {
        type: 'object',
        properties: {
          taskIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of task IDs from list_sub_agents. Each session will be analyzed independently.',
          },
          provider: {
            type: 'string',
            enum: ['claude', 'gemini'],
            description: 'Which API to use for analysis. Default: "gemini".',
          },
        },
        required: ['taskIds'],
      },
    },
    {
      name: 'close_sub_agent',
      description: 'Close a Claude Code sub-agent tab. The tab will be closed and removed from the UI (same as Cmd+W). Use this to clean up sub-agents that have finished their work. The session history is preserved in the archive.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID of the sub-agent to close (from list_sub_agents or delegate_to_claude)',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'adopt_agent',
      description: 'Adopt an existing Claude Code tab as your sub-agent. The session will be summarized via API and the context will be automatically injected into your conversation. Use this to attach already-running Claude tabs to your orchestration. The summary will appear as [Adopted Agent Context] — read it and continue working.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'The tab ID of the existing Claude tab to adopt. Use list_sub_agents or check the terminal UI for available tabs.',
          },
        },
        required: ['tabId'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Get caller's PPID (Gemini CLI PID) for tab matching
  const ppid = process.ppid;

  try {
    switch (name) {
      case 'delegate_to_claude': {
        const result = await httpPost('/delegate', {
          prompt: args.prompt,
          name: args.name || undefined,
          session_id: args.session_id || undefined,
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Task accepted. ID: ' + result.taskId + (args.session_id ? ' (resuming session ' + args.session_id.substring(0, 8) + '...)' : '') + '\nClaude is now working in a terminal tab. The result will be AUTOMATICALLY injected into your conversation when done — no need to poll or check status.' + '\n\nIMPORTANT: Do NOT fabricate or predict Claude\'s response. Do NOT generate [claude sub-agent response] tags. Say a brief confirmation and STOP generating.',
            },
          ],
        };
      }

      case 'continue_claude': {
        const result = await httpPost('/continue', {
          taskId: args.taskId,
          prompt: args.prompt,
          name: args.name || undefined,
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Follow-up sent to agent ' + args.taskId + '. The result will be AUTOMATICALLY injected into your conversation when done — no need to poll or check status.' + '\n\nIMPORTANT: Do NOT fabricate or predict the response. Say a brief confirmation and STOP generating. Wait for the real [Claude Sub-Agent Response].',
            },
          ],
        };
      }

      case 'send_claude_command': {
        const result = await httpPost('/command', {
          command: args.command,
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Command sent: ' + args.command,
            },
          ],
        };
      }

      case 'list_sub_agents': {
        const result = await httpGet('/sub-agents?ppid=' + ppid);
        const agents = result.agents || [];
        if (agents.length === 0) {
          return {
            content: [{ type: 'text', text: 'No sub-agents found for your current Gemini tab. Use delegate_to_claude to create one.' }],
          };
        }
        let text = 'Sub-agents (' + agents.length + '):\n';
        for (const a of agents) {
          text += '\n- ' + (a.tabName || 'claude-sub') + ' (Task ID: ' + a.taskId + ')';
          if (a.claudeSessionId) text += '\n  Session: ' + a.claudeSessionId.substring(0, 8) + '...';
          // Semantic state for Gemini (no implementation details like PTY)
          if (a.claudeActive) {
            text += '\n  State: ACTIVE — Claude is running and ready for follow-up';
            text += '\n  Action: Use continue_claude to send a follow-up message';
          } else {
            text += '\n  State: IDLE — Claude finished previous task and is not running';
            text += '\n  Tasks completed: ' + (a.taskCount || 0);
            text += '\n  Action: Use continue_claude to give a new task (agent will auto-resume)';
          }
          text += '\n';
        }
        return {
          content: [{ type: 'text', text }],
        };
      }

      case 'read_claude_history': {
        const detail = args.detail || 'full';
        const lastN = args.last_n !== undefined ? args.last_n : 1;
        let url = '/claude-history/' + args.taskId + '?detail=' + detail + '&last_n=' + lastN + '&ppid=' + ppid;
        const result = await httpGet(url);
        let header = 'Total turns: ' + (result.totalTurns || 0);
        if (result.lastN > 0) header += ', showing last ' + result.lastN;
        return {
          content: [
            {
              type: 'text',
              text: header + '\n\n' + (result.content || '(No history available)'),
            },
          ],
        };
      }

      case 'get_task_status': {
        const result = await httpGet('/status/' + args.taskId);
        let text = 'Task ' + args.taskId + ': ' + result.status;
        if (result.result) text += '\nResult: ' + result.result.substring(0, 500);
        if (result.error) text += '\nError: ' + result.error;
        return {
          content: [{ type: 'text', text }],
        };
      }

      case 'update_docs': {
        const result = await httpPost('/update-docs', {
          taskIds: args.taskIds,
          provider: args.provider || undefined,
          ppid,
        });

        const results = result.results || [];
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results returned.' }],
            isError: true,
          };
        }

        let text = 'Update Docs — ' + results.length + ' session(s) analyzed:\n';
        for (const r of results) {
          text += '\n' + '='.repeat(60) + '\n';
          text += 'Task: ' + r.taskId + '\n';
          if (r.success) {
            text += r.text + '\n';
            if (r.usage) {
              const inK = r.usage.input_tokens ? (r.usage.input_tokens / 1000).toFixed(1) + 'K' : '?';
              const outK = r.usage.output_tokens ? (r.usage.output_tokens / 1000).toFixed(1) + 'K' : '?';
              text += '\n[Tokens — in: ' + inK + ', out: ' + outK + ']\n';
            }
          } else {
            text += 'ERROR: ' + r.error + '\n';
          }
        }
        return {
          content: [{ type: 'text', text }],
        };
      }

      case 'close_sub_agent': {
        const result = await httpPost('/close-sub-agent', {
          taskId: args.taskId,
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Sub-agent closed. Tab ' + (result.claudeTabId || args.taskId) + ' has been removed.',
            },
          ],
        };
      }

      case 'adopt_agent': {
        const result = await httpPost('/adopt', {
          tabId: args.tabId,
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Adopting tab ' + args.tabId + ' as sub-agent. Task ID: ' + result.taskId + '\nThe session is being summarized via API. The context will be AUTOMATICALLY injected into your conversation when ready.\n\nIMPORTANT: Do NOT fabricate the summary. Wait for the real [Adopted Agent Context] to appear.',
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: 'Unknown tool: ' + name }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: 'Error: ' + error.message }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running on stdio
}

main().catch((error) => {
  console.error('MCP Server fatal error:', error);
  process.exit(1);
});
