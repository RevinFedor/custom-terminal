'use strict';

const path = require('node:path');
const { tokenizeCommand } = require('../shared/history-action-grammar.cjs');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader',
  '--title', '--conditions', '-C', '--inspect-port', '--max-old-space-size', '--max_old_space_size']);
const NODE_SWITCH_FLAGS = new Set(['--no-warnings', '--trace-warnings', '--trace-deprecation',
  '--enable-source-maps', '--inspect', '--inspect-brk', '--preserve-symlinks', '--preserve-symlinks-main']);

function isClaudeEntrypoint(value) {
  const text = String(value || '');
  return path.basename(text).toLowerCase() === 'claude'
    || /(?:^|\/)@anthropic-ai\/(?:claude-code|claude-agent-sdk)\/cli\.(?:js|mjs|cjs)$/i.test(text)
    || /\/(?:\.local\/share\/)?claude\/versions\/\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(text);
}

function classifyClaudeProcessCommand(commandLine) {
  // Reuse the project's quote-aware tokenizer. Do not scan command text for
  // provider names: Node MCP clients carry those names in their JSON payloads.
  const tokens = tokenizeCommand(String(commandLine || ''));
  if (isClaudeEntrypoint(tokens[0])) {
    return { proofKind: 'claude-native-cli', args: tokens.slice(1) };
  }
  if (path.basename(tokens[0] || '').toLowerCase() !== 'node') return null;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const token = tokens[index++];
    if (token === '--') break;
    const flag = token.split('=', 1)[0];
    if (NODE_VALUE_FLAGS.has(flag)) {
      if (!token.includes('=')) {
        if (index >= tokens.length) return null;
        index++;
      }
    } else if (!NODE_SWITCH_FLAGS.has(flag)) {
      // In particular -e/--eval, -p/--print, --run and --check execute client
      // code or another entrypoint. A later "claude" token is not its script.
      return null;
    }
  }
  if (!isClaudeEntrypoint(tokens[index])) return null;
  return { proofKind: 'claude-node-cli', args: tokens.slice(index + 1) };
}

function claudeProcessSessionArgument(commandLine, sessionId) {
  const target = String(sessionId || '').trim().toLowerCase();
  if (!SESSION_ID_RE.test(target)) return null;
  const process = classifyClaudeProcessCommand(commandLine);
  if (!process) return null;
  for (let index = 0; index < process.args.length; index++) {
    const token = process.args[index];
    if (token === '--') break;
    const match = token.match(/^(--resume|-r|--session-id)(?:=(.*))?$/);
    if (!match) continue;
    const value = match[2] === undefined ? process.args[index + 1] : match[2];
    if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) continue;
    if (value.toLowerCase() === target) return { proofKind: process.proofKind + ':' + match[1] };
  }
  return null;
}

module.exports = { classifyClaudeProcessCommand, claudeProcessSessionArgument };
