#!/usr/bin/env node
'use strict';

// Claude Code hook -> Noted Terminal bridge. Claude waits for this process,
// so every failure is silent and the total socket budget stays bounded.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const LEGACY_SOCK = '/tmp/noted-terminal-claude-hook.sock';
const DISCOVERY_DIR = path.join(os.homedir(), '.noted-terminal');
const DIAG = process.env.NOTED_CLAUDE_HOOK_DIAG
  || '/tmp/noted-claude-hook-diag.log';

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
    cwd: payload.cwd || null,
    transcript_path: payload.transcript_path || null,
    last_assistant_message: payload.last_assistant_message || null,
    stop_hook_active: payload.stop_hook_active || false,
    tool_name: payload.tool_name || null,
    tool_input: payload.tool_input || null,
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
    + ' chosenPid=' + (chosen && chosen.pid));

  const client = net.createConnection(socketPath);
  let done = false;
  let wroteAt = 0;
  const finish = (outcome) => {
    if (done) return;
    done = true;
    diag('EXIT event=' + event
      + ' ppid=' + process.ppid
      + ' outcome=' + outcome);
    try { client.destroy(); } catch {}
    process.exit(0);
  };

  let ackBuffer = '';
  client.setEncoding('utf8');
  client.on('data', (chunk) => {
    ackBuffer += chunk;
    if (ackBuffer.includes('\n')) {
      const latency = wroteAt ? Date.now() - wroteAt : -1;
      finish('acked_' + latency + 'ms');
    }
  });
  client.on('connect', () => {
    client.write(envelope, () => { wroteAt = Date.now(); });
  });
  client.on('error', (error) => finish('sock_err:' + error.code));
  setTimeout(() => { if (wroteAt) finish('sent_no_ack'); }, 150);
  setTimeout(() => finish('timeout_250ms'), 250);
});
