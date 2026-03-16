#!/usr/bin/env node
// =============================================================================
// MCP Knowledge Server — searches docs/knowledge/ via Haiku semantic routing
// Zero dependencies. Implements MCP JSON-RPC 2.0 over stdio.
//
// Tool: docs_search(query) → Haiku selects 2-5 files → returns their contents
// Tool: docs_reindex(parallel) → rebuilds .semantic-index.json via build-index.sh
// =============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFile } from 'child_process';

// Resolve project root: --project /path, or CLAUDE_PROJECT_DIR, or cwd
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectArgIdx = process.argv.indexOf('--project');
const PROJECT_DIR = (projectArgIdx !== -1 && process.argv[projectArgIdx + 1])
  ? process.argv[projectArgIdx + 1]
  : process.env.CLAUDE_PROJECT_DIR || process.cwd();
const INDEX_PATH = join(PROJECT_DIR, '.semantic-index.json');

let index = [];
try {
  index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  process.stderr.write(`[knowledge-server] Loaded ${index.length} entries from index\n`);
} catch (e) {
  process.stderr.write(`[knowledge-server] Cannot load index: ${e.message}\n`);
}

// ---------------------------------------------------------------------------
// Haiku Router (same logic as semantic-router.sh)
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = `You are a Semantic Router for a software project.
Task: select ALL files from the index that are ACTUALLY needed to solve the developer request. No limit on count — if the request touches 10 topics, return 10 files.

SELECTION ALGORITHM:

STEP 1 — Identify the SYMPTOM:
What exactly is broken or needed? UI not updating? Data empty? Process crashing?

STEP 2 — Think about ROOT CAUSE, not keywords:
Do NOT grab a file by word overlap! Think about the CAUSE.

STEP 3 — Check the "symptoms" field in each index entry:
Every entry has a "symptoms" array with descriptions of WHEN that file is needed.
Compare the request against ALL symptoms. This is the PRIMARY matching mechanism.

STEP 4 — Check cross-domain bridges:
a) Zustand silent mutation — "not updating", "stale" → fix-zustand-silent-mutation.md
b) Sync marker timing — paste/command "hangs", "lost" → fix-stale-sync-markers.md
c) Paste path routing — paste "breaks", "duplicates" → fact-terminal-core.md
d) CSS visibility chain — terminal "garbage", "not redrawn" → fact-terminal-rendering.md
e) JSONL chain — Timeline/export "wrong", "skips" → fact-backtrace-jsonl.md
f) React useEffect + IPC — button "disappears" after tab create → fact-terminal-core.md
g) Vite escaping — escape sequences "broken" after build → fix-environment.md

STEP 5 — Scan implicit tags across ALL entries.

RULES:
- Select as many files as needed to cover ALL aspects of the request. No upper limit.
- Do NOT artificially limit to 2-5 files. If the query covers multiple topics, include files for EACH topic.
- All docs in docs/knowledge/ (flat structure: fix-* and fact-*).

Respond ONLY with a valid JSON array of paths. No markdown, no explanations.
Example: ["docs/knowledge/fact-terminal-core.md", "docs/knowledge/fix-zustand-silent-mutation.md"]`;

function searchKnowledge(query) {
  return new Promise((resolve) => {
    if (!query || !query.trim()) {
      resolve({ found: 0, message: 'Empty query', files: [] });
      return;
    }

    const indexCompact = JSON.stringify(index);
    const userMsg = `Developer request: ${query}\n\nAvailable index:\n${indexCompact}`;

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    process.stderr.write(`[knowledge-server] Routing query via Haiku: "${query.slice(0, 80)}..."\n`);

    const child = execFile('claude', [
      '-p',
      '--model', 'haiku',
      '--system-prompt', ROUTER_PROMPT,
      '--no-session-persistence'
    ], {
      cwd: PROJECT_DIR,
      env,
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        process.stderr.write(`[knowledge-server] Haiku error: ${error.message}\n`);
        if (stderr) process.stderr.write(`[knowledge-server] Haiku stderr: ${stderr.slice(0, 500)}\n`);
        resolve({ found: 0, error: error.message, stderr: stderr?.slice(0, 300), files: [] });
        return;
      }

      // Parse file list from Haiku response
      let filePaths = [];
      try {
        filePaths = JSON.parse(stdout.trim());
      } catch {
        // Try extracting paths from non-JSON response
        const matches = stdout.match(/"[^"]+\.md"/g);
        if (matches) {
          filePaths = matches.map(m => m.replace(/"/g, ''));
        }
      }

      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        process.stderr.write(`[knowledge-server] Haiku returned no files. Raw: ${stdout.slice(0, 200)}\n`);
        resolve({ found: 0, message: 'Haiku returned no matching files', raw: stdout.slice(0, 300), files: [] });
        return;
      }

      // Return paths + symptoms (no content — Claude reads via Read tool)
      const files = filePaths.map(relPath => {
        const entry = index.find(e => e.path === relPath);
        return {
          path: relPath,
          fullPath: join(PROJECT_DIR, relPath),
          symptoms: entry?.symptoms || []
        };
      });

      process.stderr.write(`[knowledge-server] Haiku selected ${files.length} files: ${filePaths.map(p => p.split('/').pop()).join(', ')}\n`);
      resolve({
        found: files.length,
        query,
        instruction: 'Use the Read tool to read these files before proceeding.',
        files
      });
    });

    // Send query via stdin
    child.stdin.write(userMsg);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

function reindex(parallel = 5) {
  return new Promise((resolve) => {
    const script = join(PROJECT_DIR, 'scripts', 'ai', 'build-index.sh');
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    process.stderr.write(`[knowledge-server] Reindexing with --parallel ${parallel}...\n`);

    execFile('bash', [script, '--parallel', String(parallel)], {
      cwd: PROJECT_DIR,
      env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        process.stderr.write(`[knowledge-server] Reindex error: ${error.message}\n`);
        resolve({ success: false, error: error.message, stdout: stdout?.slice(-2000), stderr: stderr?.slice(-2000) });
        return;
      }

      try {
        index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
        process.stderr.write(`[knowledge-server] Reindex done. Reloaded ${index.length} entries.\n`);
      } catch (e) {
        process.stderr.write(`[knowledge-server] Reindex done but failed to reload: ${e.message}\n`);
      }

      const lines = stdout.trim().split('\n');
      const summary = lines.slice(-15).join('\n');
      resolve({ success: true, summary, entries: index.length });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP Protocol (JSON-RPC 2.0 over stdio, newline-delimited)
// ---------------------------------------------------------------------------

const TOOL_DEF = {
  name: 'docs_search',
  description:
    'Search project knowledge base (docs/knowledge/) for architecture docs, known bugs, workarounds, and subsystem behavior. ' +
    'Uses Haiku AI to semantically select 2-5 most relevant files. ' +
    'Use BEFORE modifying complex subsystems or when debugging unfamiliar issues. ' +
    'Query should describe what you need to know in English.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you need to know — describe the problem, symptom, or subsystem'
      }
    },
    required: ['query']
  }
};

const REINDEX_DEF = {
  name: 'docs_reindex',
  description:
    'Rebuild the semantic index (.semantic-index.json) by running build-index.sh. ' +
    'Uses Haiku to generate tags and symptoms for each docs/knowledge/ file. ' +
    'Run after adding or significantly changing knowledge files. Takes 2-5 minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      parallel: {
        type: 'number',
        description: 'Number of parallel Haiku workers (default: 5)'
      }
    }
  }
};

function handleMessage(msg) {
  const { method, params, id } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'knowledge-server', version: '2.0.0' }
      }
    };
  }

  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return null;
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [TOOL_DEF, REINDEX_DEF] } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    if (name === 'docs_search') {
      searchKnowledge(args.query).then((result) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }) + '\n');
      });
      return '__async__';
    }

    if (name === 'docs_reindex') {
      reindex(args.parallel || 5).then((result) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }) + '\n');
      });
      return '__async__';
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      }
    };
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return null;
}

// Stdio transport
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = handleMessage(msg);
    if (response !== null && response !== '__async__') {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch (e) {
    process.stderr.write(`[knowledge-server] Parse error: ${e.message}\n`);
  }
});

process.stderr.write(`[knowledge-server] Started. PROJECT_DIR=${PROJECT_DIR}\n`);
