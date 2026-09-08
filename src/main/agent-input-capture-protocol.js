'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROTOCOL_VERSION = 2;
const CAPTURE_HELPER_BASENAME = 'noted-code-grab-v2.js';
const CAPTURE_MODES = new Set(['grab', 'copy', 'clear', 'restore', 'put']);

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeExclusiveJson(filePath, value) {
  const candidate = filePath + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(candidate, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    // link is exclusive AND exposes complete contents. open('wx') followed by
    // write would briefly expose an empty decision to the competing process.
    fs.linkSync(candidate, filePath);
    return value;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readJson(filePath);
  } finally {
    try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function lockPathForPid(directory, pid) {
  return path.join(directory, 'noted-grab-v2-' + Number(pid) + '.json');
}

function operationMatches(left, right) {
  return !!left && !!right
    && left.protocol === PROTOCOL_VERSION
    && right.protocol === PROTOCOL_VERSION
    && left.operationId === right.operationId
    && left.ownerId === right.ownerId
    && left.terminalId === right.terminalId;
}

function readDecision(intent) { return readJson(path.join(intent.operationDir, 'decision.json')); }
function readOutcome(intent) { return readJson(path.join(intent.operationDir, 'outcome.json')); }

function buildAgentDraftTransfer(intent, outcome, snapshot, helperId) {
  if (intent?.mode !== 'grab' || !snapshot
    || !operationMatches(outcome, intent) || outcome.applied !== true
    || outcome.helperId !== helperId) return null;
  return {
    id: intent.operationId,
    tabId: intent.tabId,
    text: String(snapshot.text || ''),
    images: Number(snapshot.images || 0),
    imagePaths: Array.isArray(snapshot.imagePaths) ? snapshot.imagePaths.map(ref => ({ ...ref })) : [],
  };
}

// Commit and cancellation compete for ONE exclusive filesystem record. A
// timeout must never erase an already-issued Ctrl+G, nor may a delayed socket
// response grant permission after the helper gave up and returned unchanged.
function decide(intent, decision, extra = {}) {
  return writeExclusiveJson(path.join(intent.operationDir, 'decision.json'), {
    protocol: PROTOCOL_VERSION,
    ownerId: intent.ownerId,
    terminalId: intent.terminalId,
    operationId: intent.operationId,
    decision,
    ...extra,
  });
}

function removeOwnedAliases(intent, directory) {
  for (const pid of intent.pids) {
    const lockPath = lockPathForPid(directory, pid);
    if (operationMatches(readJson(lockPath), intent)) fs.unlinkSync(lockPath);
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

class AgentInputCaptureProtocol {
  constructor({ directory = '/tmp', ownerId = crypto.randomUUID(), now = Date.now } = {}) {
    this.directory = directory;
    this.ownerId = ownerId;
    this.now = now;
    this.operations = new Map();
  }

  arm({ tabId, terminalId, agent, mode, pids, sock, generation, text, timeoutMs = 3000 }) {
    if (!CAPTURE_MODES.has(mode)) throw new Error('unsupported_capture_mode');
    const uniquePids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 1);
    if (!uniquePids.length || !terminalId) throw new Error('capture_owner_missing');
    for (const pid of uniquePids) {
      const previous = readJson(lockPathForPid(this.directory, pid));
      if (!previous) continue;
      // A different PTY/main incarnation cannot own a helper parented by this
      // new PTY. Same-incarnation intents are NEVER replaced on a timer.
      if (previous.ownerId !== this.ownerId || previous.terminalId !== terminalId) {
        fs.unlinkSync(lockPathForPid(this.directory, pid));
      } else {
        const error = new Error('external_editor_pending_drain');
        error.operationId = previous.operationId;
        throw error;
      }
    }
    const operationId = crypto.randomUUID();
    const operationDir = path.join(this.directory, 'noted-grab-operation-' + operationId);
    fs.mkdirSync(operationDir, { mode: 0o700 });
    const intent = {
      protocol: PROTOCOL_VERSION,
      operationId,
      operationDir,
      ownerId: this.ownerId,
      ownerPid: process.pid,
      terminalId,
      tabId,
      agent,
      mode,
      pids: uniquePids,
      sock,
      generation,
      createdAt: this.now(),
      deadlineAt: this.now() + timeoutMs,
      ...(typeof text === 'string' ? { text } : {}),
    };
    try {
      fs.writeFileSync(path.join(operationDir, 'intent.json'), JSON.stringify(intent), { mode: 0o600 });
      for (const pid of uniquePids) {
        fs.writeFileSync(lockPathForPid(this.directory, pid), JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
      }
    } catch (error) {
      removeOwnedAliases(intent, this.directory);
      fs.rmSync(operationDir, { recursive: true, force: true });
      throw error;
    }
    this.operations.set(operationId, intent);
    return intent;
  }

  matchesEnvelope(intent, envelope) {
    const helper = intent && readJson(path.join(intent.operationDir, 'helper.json'));
    return this.operations.get(intent?.operationId) === intent
      && operationMatches(intent, envelope)
      && envelope.stage === 'prepare'
      && envelope.tabId === intent.tabId
      && envelope.mode === intent.mode
      && envelope.agent === intent.agent
      && intent.pids.includes(Number(envelope.ppid))
      && typeof envelope.helperId === 'string'
      && envelope.helperId.length > 0
      && helper?.helperId === envelope.helperId
      && helper.helperPid === Number(envelope.pid);
  }

  authorize(intent, envelope, current) {
    if (!this.matchesEnvelope(intent, envelope)) return { decision: 'cancel', reason: 'capture_operation_mismatch' };
    if (!current || this.now() >= intent.deadlineAt) {
      return this.cancel(intent, current ? 'external_editor_timeout' : 'capture_generation_changed');
    }
    return decide(intent, 'commit', { helperId: envelope.helperId, helperPid: Number(envelope.pid) });
  }

  cancel(intent, reason) {
    if (!fs.existsSync(intent.operationDir)) return { decision: 'cancel', reason: 'capture_operation_released' };
    return decide(intent, 'cancel', { reason });
  }

  // Call only after the parent-return edge, an exact helper-exit/outcome pair,
  // or authoritative process-generation retirement. Conditional alias cleanup
  // prevents an old callback from deleting a newer operation's dispatch slot.
  release(intent, { parentReturned = false, processRetired = false, helperExited = false } = {}) {
    const outcome = readOutcome(intent);
    if (!processRetired && (!(parentReturned || helperExited) || !operationMatches(outcome, intent))) return false;
    if (processRetired) this.cancel(intent, 'capture_generation_changed');
    // Retirement may precede actual child death (kill has only been sent).
    // Leave the cancelled PID dispatch in that case: a late old helper still
    // parented by that CLI must not reinterpret a missing file as manual Ctrl+G.
    const ownerGone = processRetired && intent.pids.every(pid => isProcessAlive(pid) === false);
    if (!processRetired || operationMatches(outcome, intent) || ownerGone) {
      removeOwnedAliases(intent, this.directory);
    }
    this.operations.delete(intent.operationId);
    // An unstarted retired helper may still hold this intent. Keep its cancel
    // record until it returns; removing it would turn cancellation into absence.
    if (operationMatches(outcome, intent) || ownerGone) fs.rmSync(intent.operationDir, { recursive: true, force: true });
    return true;
  }

  reconcileReturned(intent, processAlive = isProcessAlive) {
    const outcome = readOutcome(intent);
    return operationMatches(outcome, intent)
      && processAlive(Number(outcome.helperPid)) === false
      && this.release(intent, { helperExited: true });
  }
}

module.exports = {
  AgentInputCaptureProtocol,
  buildAgentDraftTransfer,
  CAPTURE_HELPER_BASENAME,
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
};
