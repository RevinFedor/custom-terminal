#!/usr/bin/env node
'use strict';

// Versioned deliberately: old production mains still use noted-code-grab.js.
// Install this file together with agent-input-capture-protocol.js; never replace
// the legacy helper underneath a live main with an incompatible protocol.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  PROTOCOL_VERSION,
  CAPTURE_MODES,
  decide,
  isProcessAlive,
  lockPathForPid,
  operationMatches,
  readDecision,
  readJson,
  readOutcome,
  removeOwnedAliases,
  writeExclusiveJson,
} = require('./agent-input-capture-protocol');

async function runCaptureHelper({
  file,
  directory = '/tmp',
  env = process.env,
  pid = process.pid,
  ppid = process.ppid,
  socketTimeoutMs = 1500,
  runEditor = (binary, args) => spawnSync(binary, args, { stdio: 'inherit' }),
  connect = socketPath => net.createConnection(socketPath),
} = {}) {
  if (!file || ppid <= 1) return { action: 'preserve', reason: 'no_live_parent' };
  const manual = () => {
    const tokens = String(env.NOTED_ORIGINAL_EDITOR || '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return { action: 'manual', status: 0 };
    const result = runEditor(tokens[0], tokens.slice(1).concat(file));
    return { action: 'manual', status: result?.status ?? 0 };
  };
  let intent;
  try { intent = readJson(lockPathForPid(directory, ppid)); }
  catch { return { action: 'preserve', reason: 'unreadable_capture_intent' }; }
  if (!intent) return manual();
  // A malformed/foreign automatic request is NOT a manual editor request.
  if (intent.protocol !== PROTOCOL_VERSION
    || !CAPTURE_MODES.has(intent.mode)
    || intent.ownerId !== env.NOTED_GRAB_OWNER_ID
    || intent.terminalId !== env.NOTED_GRAB_TERMINAL_ID
    || !Array.isArray(intent.pids) || !intent.pids.includes(ppid)
    || path.dirname(intent.operationDir || '') !== directory
    || path.basename(intent.operationDir || '') !== 'noted-grab-operation-' + intent.operationId) {
    return { action: 'preserve', reason: 'capture_owner_mismatch' };
  }
  const helperId = crypto.randomUUID();
  const claim = writeExclusiveJson(path.join(intent.operationDir, 'helper.json'), { helperId, helperPid: pid });
  if (claim?.helperId !== helperId) {
    const priorOutcome = readOutcome(intent);
    if (operationMatches(priorOutcome, intent)
      && priorOutcome.helperId === claim?.helperId
      && isProcessAlive(Number(claim.helperPid)) === false) {
      // This invocation itself proves the CLI has re-entered external editor
      // AFTER the previous helper exited. It is not the old delayed invocation.
      // Leave the outcome for the main to reconcile its still-pending record.
      removeOwnedAliases(intent, directory);
      return manual();
    }
    return { action: 'preserve', reason: 'capture_already_claimed' };
  }
  let original;
  try { original = fs.readFileSync(file, 'utf8'); }
  catch { decide(intent, 'cancel', { reason: 'editor_file_unreadable' }); return { action: 'preserve', reason: 'editor_file_unreadable' }; }
  const restore = intent.mode === 'restore' || intent.mode === 'put';
  // Claude appends one transport newline; Codex writes the exact composer
  // bytes (external_editor.rs::run_editor). Trimming Codex drops real input.
  const text = restore ? String(intent.text || '')
    : intent.agent === 'claude' ? original.replace(/\n$/, '') : original;
  const envelope = {
    event: 'GrabInput',
    stage: 'prepare',
    protocol: PROTOCOL_VERSION,
    operationId: intent.operationId,
    ownerId: intent.ownerId,
    terminalId: intent.terminalId,
    tabId: intent.tabId,
    mode: intent.mode,
    agent: intent.agent,
    helperId,
    pid,
    ppid,
    text,
  };

  return new Promise(resolve => {
    let client;
    let finished = false;
    let timer;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // A socket failure races the main's authorization through the same
      // exclusive decision. If cancellation wins, even a later ACK cannot
      // change the file. If commit won, the main already owns the captured text.
      const decision = readDecision(intent) || decide(intent, 'cancel', { reason });
      const authorized = operationMatches(decision, intent)
        && decision.decision === 'commit'
        && decision.helperId === helperId
        && isProcessAlive(Number(intent.ownerPid)) === true;
      let applied = false;
      let error = null;
      if (authorized) {
        try {
          // Do not overwrite a file changed by an unexpected concurrent editor.
          if (fs.readFileSync(file, 'utf8') !== original) throw new Error('editor_file_changed');
          if (intent.mode === 'grab' || intent.mode === 'clear') fs.writeFileSync(file, '');
          else if (restore) fs.writeFileSync(file, text);
          applied = true;
        } catch (failure) { error = failure.code || failure.message; }
      }
      const outcome = {
        protocol: PROTOCOL_VERSION,
        operationId: intent.operationId,
        ownerId: intent.ownerId,
        terminalId: intent.terminalId,
        helperId,
        helperPid: pid,
        applied,
        preserved: !applied || intent.mode === 'copy',
        reason: error || (authorized ? 'committed' : decision.reason || reason),
      };
      fs.writeFileSync(path.join(intent.operationDir, 'outcome.json'), JSON.stringify(outcome), { mode: 0o600 });
      try { client?.destroy(); } catch {}
      resolve({ action: applied ? intent.mode : 'preserve', ...outcome });
    };
    timer = setTimeout(() => finish('helper_socket_timeout'), socketTimeoutMs);
    try { client = connect(intent.sock); }
    catch { finish('helper_socket_error'); return; }
    let buffer = '';
    client.setEncoding('utf8');
    client.on('connect', () => client.write(JSON.stringify(envelope) + '\n'));
    client.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { finish('invalid_capture_ack'); return; }
      if (!operationMatches(response, intent) || response.helperId !== helperId) {
        finish('capture_ack_mismatch'); return;
      }
      finish('capture_ack');
    });
    client.on('error', () => finish('helper_socket_error'));
    client.on('end', () => finish('helper_socket_closed'));
  });
}

module.exports = { runCaptureHelper };
if (require.main === module) {
  runCaptureHelper({ file: process.argv[2] })
    .then(result => { process.exitCode = result.status || 0; })
    .catch(error => {
      console.error('[GrabInputHelper] capture failed:', error.code || error.message);
      process.exitCode = 1;
    });
}
