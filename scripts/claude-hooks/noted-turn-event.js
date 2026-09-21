#!/usr/bin/env node
'use strict';

// Claude Code hook -> Noted Terminal bridge. Claude waits for this process,
// so failures never block the CLI indefinitely. A transport deadline is NOT
// permission to abandon a still-buffered write after an ACK-sized timeout.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const LEGACY_SOCK = '/tmp/noted-terminal-claude-hook.sock';
const DISCOVERY_DIR = path.join(os.homedir(), '.noted-terminal');
const DIAG = process.env.NOTED_CLAUDE_HOOK_DIAG
  || '/tmp/noted-claude-hook-diag.log';
const MAX_TOOL_METADATA_CHARS = 128 * 1024;

function boundedHookValue(value, budget = { remaining: MAX_TOOL_METADATA_CHARS }, depth = 0) {
  if (budget.remaining <= 0 || depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const text = value.slice(0, budget.remaining);
    budget.remaining -= text.length;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      if (budget.remaining <= 0) break;
      result.push(boundedHookValue(item, budget, depth + 1));
    }
    return result;
  }
  if (typeof value !== 'object') return null;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (budget.remaining <= 0) break;
    result[key] = boundedHookValue(nested, budget, depth + 1);
  }
  return result;
}

function diag(line) {
  try {
    fs.appendFileSync(DIAG, new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}

function readDiscoveries() {
  let files;
  try {
    files = fs.readdirSync(DISCOVERY_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.startsWith('claude-hook-') || !file.endsWith('.json')) continue;
    const fullPath = path.join(DISCOVERY_DIR, file);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry.sock !== 'string' || !entry.sock) continue;
    if (typeof entry.pid === 'number') {
      try {
        process.kill(entry.pid, 0);
      } catch {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }
    }
    entry.openProjectPaths = Array.isArray(entry.openProjectPaths)
      ? entry.openProjectPaths
      : [];
    out.push(entry);
  }
  return out;
}

function pickInstance(cwd, instances) {
  if (instances.length === 0) return null;
  const hintedPid = Number.parseInt(process.env.NOTED_MAIN_PID || '', 10);
  if (hintedPid) {
    const pinned = instances.find((entry) => entry.pid === hintedPid);
    if (pinned) return pinned;
  }

  let best = null;
  let bestLength = -1;
  if (cwd) {
    for (const instance of instances) {
      for (const projectPath of instance.openProjectPaths) {
        if (typeof projectPath !== 'string' || !projectPath) continue;
        if (cwd === projectPath || cwd.startsWith(projectPath + '/')) {
          if (projectPath.length > bestLength) {
            best = instance;
            bestLength = projectPath.length;
          }
        }
      }
    }
  }
  if (best) return best;
  return instances.slice().sort(
    (left, right) => (right.updatedAt || 0) - (left.updatedAt || 0),
  )[0];
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    diag('PARSE_ERR ppid=' + process.ppid
      + ' raw_len=' + raw.length
      + ' err=' + error.message);
    process.exit(0);
    return;
  }

  const event = payload.hook_event_name
    || process.env.CLAUDE_HOOK_EVENT
    || 'unknown';
  const cwd = payload.cwd || process.env.PWD || '';
  const envelopePayload = {
    event,
    // The first turn can finish before statusLine binds its JSONL. Main accepts
    // this PID only after proving that the Claude child belongs to a PTY tab.
    ppid: process.ppid,
    session_id: payload.session_id || null,
    // A subagent shares its parent's session/PID. Do not discard the fields
    // that distinguish its StopFailure/tool events from the main conversation.
    agent_id: payload.agent_id ?? null,
    agent_type: payload.agent_type ?? null,
    agent_transcript_path: payload.agent_transcript_path ?? null,
    prompt_id: payload.prompt_id ?? null,
    cwd: payload.cwd || null,
    transcript_path: payload.transcript_path || null,
    last_assistant_message: payload.last_assistant_message || null,
    stop_hook_active: payload.stop_hook_active || false,
    tool_name: payload.tool_name || null,
    tool_use_id: payload.tool_use_id || null,
    tool_input: boundedHookValue(payload.tool_input),
    tool_response: boundedHookValue(payload.tool_response),
    error: boundedHookValue(payload.error),
    error_details: event === 'StopFailure' ? boundedHookValue(payload.error_details) : null,
    ts: Date.now(),
  };
  // The exact accepted prompt is causal identity for one UserPromptSubmit
  // event. It is never mirrored into diagnostics and is omitted from every
  // other event. Older main builds safely ignore this additive field.
  if (event === 'UserPromptSubmit' && typeof payload.prompt === 'string') {
    envelopePayload.prompt = payload.prompt;
  }
  const envelope = JSON.stringify(envelopePayload) + '\n';

  const instances = readDiscoveries();
  const chosen = pickInstance(cwd, instances);
  const socketPath = chosen ? chosen.sock : LEGACY_SOCK;
  diag('FIRED event=' + event
    + ' ppid=' + process.ppid
    + ' sid=' + String(payload.session_id || 'null').slice(0, 8)
    + ' sock=' + socketPath
    + ' chosenPid=' + (chosen && chosen.pid)
    + ' scope=' + (payload.agent_id || payload.agent_transcript_path ? 'subagent' : 'main')
    + ' promptId=' + JSON.stringify(payload.prompt_id ?? null)
    + ' agentId=' + JSON.stringify(payload.agent_id ?? null));

  const client = net.createConnection(socketPath);
  let done = false;
  let wroteAt = 0;
  let phase = 'connecting';
  let deadline = null;
  const envelopeBytes = Buffer.byteLength(envelope);
  const finish = (outcome) => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    diag('EXIT event=' + event
      + ' ppid=' + process.ppid
      + ' phase=' + phase
      + ' bytes=' + envelopeBytes
      + ' pendingBytes=' + client.writableLength
      + ' outcome=' + outcome);
    try { client.destroy(); } catch {}
    process.exit(0);
  };
  const boundPhase = (nextPhase, timeoutMs) => {
    phase = nextPhase;
    clearTimeout(deadline);
    deadline = setTimeout(() => finish('timeout_' + nextPhase), timeoutMs);
  };

  let ackBuffer = '';
  client.setEncoding('utf8');
  client.on('data', (chunk) => {
    ackBuffer += chunk;
    if (ackBuffer.split('\n').includes('ok')) {
      const latency = wroteAt ? Date.now() - wroteAt : -1;
      finish('acked_' + latency + 'ms');
    }
  });
  client.on('connect', () => {
    // A large UTF-8 prompt can exceed the kernel's socket buffer. The write
    // callback, not connect() or elapsed wall time, says all bytes were flushed.
    // Main must parse the terminating newline before it can acknowledge them.
    boundPhase('writing', 5000);
    client.write(envelope, (error) => {
      if (done) return;
      if (error) return finish('write_err:' + error.code);
      wroteAt = Date.now();
      boundPhase('awaiting_ack', 1000);
    });
  });
  client.on('error', (error) => finish('sock_err:' + error.code));
  client.on('end', () => finish('peer_closed_without_ack'));
  boundPhase('connecting', 1000);
});
