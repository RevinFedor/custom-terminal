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
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PORT_FILE = join(homedir(), '.noted-terminal', 'mcp-port');

function getPort() {
  try {
    return parseInt(readFileSync(PORT_FILE, 'utf-8').trim());
  } catch {
    return null;
  }
}

async function httpPost(endpoint, body) {
  const port = getPort();
  if (!port) throw new Error('Noted Terminal is not running (no port file at ' + PORT_FILE + ')');

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
      description: 'Delegate a task to Claude Code. Claude will work in a visible terminal tab with full capabilities (file editing, bash, etc). The task runs asynchronously — this tool returns immediately with a taskId. The result will be automatically pasted back into your conversation when Claude finishes.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task description / prompt to send to Claude Code',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'send_claude_command',
      description: 'Send a command to the active Claude Code sub-agent (e.g. /compact, /model sonnet, /clear). Useful for managing Claude\'s context or switching models.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command to send (e.g. "/compact", "/model sonnet")',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'get_task_status',
      description: 'Check the status of a previously delegated task.',
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
          ppid,
        });
        return {
          content: [
            {
              type: 'text',
              text: 'Task accepted. ID: ' + result.taskId + '\nClaude is now working on your task in a visible terminal tab. The result will be automatically delivered back to this conversation when Claude finishes.',
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

      case 'get_task_status': {
        const result = await httpGet('/status/' + args.taskId);
        let text = 'Task ' + args.taskId + ': ' + result.status;
        if (result.result) text += '\nResult: ' + result.result.substring(0, 500);
        if (result.error) text += '\nError: ' + result.error;
        return {
          content: [{ type: 'text', text }],
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
