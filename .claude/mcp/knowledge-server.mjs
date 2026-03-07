#!/usr/bin/env node
// =============================================================================
// MCP Knowledge Server — searches docs/knowledge/ via .semantic-index.json
// Zero dependencies. Implements MCP JSON-RPC 2.0 over stdio.
//
// Tool: docs_search(query) → returns matched file contents
// Scoring: keyword match against tags + symptoms (3x boost for symptom hits)
// =============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFile } from 'child_process';

// Resolve project root: --project /path, or CLAUDE_PROJECT_DIR, or cwd, or relative to script
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectArgIdx = process.argv.indexOf('--project');
const PROJECT_DIR = (projectArgIdx !== -1 && process.argv[projectArgIdx + 1])
  ? process.argv[projectArgIdx + 1]
  : process.env.CLAUDE_PROJECT_DIR || process.cwd();
const INDEX_PATH = join(PROJECT_DIR, '.semantic-index.json');

const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 50000;
const MAX_RESULTS = 5;

let index = [];
try {
  index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  process.stderr.write(`[knowledge-server] Loaded ${index.length} entries from index\n`);
} catch (e) {
  process.stderr.write(`[knowledge-server] Cannot load index: ${e.message}\n`);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[_\-/.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function scoreEntry(entry, queryTokens) {
  let score = 0;

  const symptomsText = (entry.symptoms || []).join(' ').toLowerCase();
  const explicitText = (entry.explicit || []).join(' ').toLowerCase();
  const implicitText = (entry.implicit || []).join(' ').toLowerCase();
  const pathText = (entry.path || '').toLowerCase();

  for (const token of queryTokens) {
    if (symptomsText.includes(token)) score += 3;
    if (explicitText.includes(token)) score += 2;
    if (implicitText.includes(token)) score += 1;
    if (pathText.includes(token)) score += 2;
  }

  return score;
}

function searchKnowledge(query) {
  if (!query || !query.trim()) {
    return { found: 0, message: 'Empty query', files: [] };
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { found: 0, message: 'No searchable tokens in query', files: [] };
  }

  const scored = index.map(entry => ({ ...entry, score: scoreEntry(entry, tokens) }));
  const matches = scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  if (matches.length === 0) {
    return {
      found: 0,
      message: `No docs matched query: "${query}". Try different terms.`,
      available_tags: index.slice(0, 10).map(e => e.explicit.slice(0, 3)).flat(),
      files: []
    };
  }

  let totalChars = 0;
  const files = [];

  for (const m of matches) {
    const filePath = join(PROJECT_DIR, m.path);
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + '\n\n[... truncated, use Read tool for full file ...]';
      }
    } catch {
      content = `[Error reading file: ${m.path}]`;
    }

    totalChars += content.length;
    files.push({
      path: m.path,
      score: m.score,
      symptoms: m.symptoms,
      content
    });

    if (totalChars >= MAX_TOTAL_CHARS) break;
  }

  return { found: files.length, query, files };
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
    'Use BEFORE modifying complex subsystems or when debugging unfamiliar issues. ' +
    'Query should be specific technical terms in English. ' +
    'Examples: "zustand state mutation stale update", "JSONL backtrace compact boundary", "paste hang timeout sync marker", "timeline range scroll".',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — specific technical terms describing what you need to know'
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

  // Initialize
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'knowledge-server', version: '1.0.0' }
      }
    };
  }

  // Notifications — no response
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return null;
  }

  // List tools
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [TOOL_DEF, REINDEX_DEF] } };
  }

  // Call tool
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'docs_search') {
      const result = searchKnowledge(args.query);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      };
    }
    if (name === 'docs_reindex') {
      // Async — need to respond after completion
      reindex(args.parallel || 5).then((result) => {
        const response = {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
        };
        process.stdout.write(JSON.stringify(response) + '\n');
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

  // Unknown method — return error
  if (id !== undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
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
