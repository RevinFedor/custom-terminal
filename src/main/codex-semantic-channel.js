'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 2;

function defaultSocketRoot(platform = process.platform, pid = process.pid) {
  if (platform === 'darwin' || platform === 'linux') {
    // sockaddr_un.sun_path is only ~104 bytes on macOS. os.tmpdir() expands
    // to a long /var/folders/... path and produced a listener Rust could not
    // address. Keep the whole generated socket comfortably below that limit.
    return path.join('/tmp', 'noted-codex-' + pid);
  }
  return path.join(os.tmpdir(), 'noted-terminal-codex-events-' + pid);
}

function shortSocketName(tabId) {
  return crypto.createHash('sha256').update(String(tabId || '')).digest('hex').slice(0, 20);
}

const CODE_MODE_HOST_EXECUTABLE_NAME = 'codex-code-mode-host';

/**
 * Decide whether a Codex tab may be pointed at Noted's patched `codex` binary.
 *
 * Codex >= 0.147 spawns `codex-code-mode-host` resolved relative to its own
 * executable. Our patched binary lives in a bare bin dir, so exporting it
 * without the companion host hands Codex a layout where every Code Mode tool
 * call fails closed with "host executable was not found". For models the server
 * marks `code_mode_only` there is no direct-tool fallback, so the session
 * becomes unusable — a strictly worse outcome than losing the semantic
 * side-channel. Prefer a working session and let the user's own Codex run.
 */
function decideCodexBinaryOverride({
  hasSemanticChannel,
  codexBinPath,
  platform = process.platform,
  fileExists = (candidate) => fs.existsSync(candidate),
} = {}) {
  if (!hasSemanticChannel) {
    return { enabled: false, reason: 'no-semantic-channel', hostPath: null };
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    return { enabled: false, reason: 'unsupported-platform', hostPath: null };
  }
  if (!codexBinPath || !fileExists(codexBinPath)) {
    return { enabled: false, reason: 'missing-codex-binary', hostPath: null };
  }
  const executable = platform === 'win32'
    ? `${CODE_MODE_HOST_EXECUTABLE_NAME}.exe`
    : CODE_MODE_HOST_EXECUTABLE_NAME;
  const hostPath = path.join(path.dirname(codexBinPath), executable);
  if (!fileExists(hostPath)) {
    return { enabled: false, reason: 'missing-code-mode-host', hostPath };
  }
  return { enabled: true, reason: 'ok', hostPath };
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.v !== PROTOCOL_VERSION) return null;
  if (typeof value.instanceId !== 'string' || !value.instanceId) return null;
  if (!Number.isInteger(value.seq) || value.seq < 0) return null;
  if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) return null;
  if (typeof value.event.type !== 'string' || !value.event.type) return null;
  return {
    v: value.v,
    instanceId: value.instanceId,
    pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
    seq: value.seq,
    droppedBefore: value.droppedBefore === true,
    event: value.event,
  };
}

async function createCodexSemanticChannelServer({
  tabId,
  onEvent,
  log = console,
  socketRoot = defaultSocketRoot(),
} = {}) {
  if (!tabId) throw new TypeError('tabId is required');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');
  await fs.promises.mkdir(socketRoot, { recursive: true, mode: 0o700 });
  try { await fs.promises.chmod(socketRoot, 0o700); } catch {}
  const socketPath = path.join(
    socketRoot,
    shortSocketName(tabId) + '-' + crypto.randomBytes(4).toString('hex') + '.sock',
  );
  await fs.promises.unlink(socketPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  const sockets = new Set();
  let activeInstanceId = null;
  let activeSocket = null;
  let closed = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let connectionInstanceId = null;
    let lastSequence = null;

    const rejectConnection = (reason) => {
      log.warn?.('[CodexSemanticChannel] reject tab=' + String(tabId).slice(-12)
        + ' reason=' + reason);
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      if (closed || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER_BYTES) {
        rejectConnection('buffer-limit');
        return;
      }
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const raw = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (raw.length === 0) continue;
        if (raw.length > MAX_LINE_BYTES) {
          rejectConnection('line-limit');
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          rejectConnection('invalid-json');
          return;
        }
        const envelope = validateEnvelope(parsed);
        if (!envelope) {
          rejectConnection('invalid-envelope');
          return;
        }
        if (envelope.event.type === 'hello') {
          if (envelope.seq !== 0) {
            rejectConnection('hello-sequence');
            return;
          }
          connectionInstanceId = envelope.instanceId;
          activeInstanceId = envelope.instanceId;
          activeSocket = socket;
          lastSequence = 0;
          onEvent({ ...envelope, tabId, gap: false });
          continue;
        }
        if (!connectionInstanceId || envelope.instanceId !== connectionInstanceId) {
          rejectConnection('event-before-hello');
          return;
        }
        if (activeInstanceId !== connectionInstanceId) {
          continue;
        }
        const gap = envelope.droppedBefore === true
          || lastSequence === null
          || envelope.seq !== lastSequence + 1;
        lastSequence = envelope.seq;
        onEvent({ ...envelope, tabId, gap });
      }
    });
    socket.on('error', (error) => {
      log.warn?.('[CodexSemanticChannel] socket error tab=' + String(tabId).slice(-12)
        + ' error=' + (error?.message || String(error)));
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (connectionInstanceId
        && activeInstanceId === connectionInstanceId
        && activeSocket === socket) {
        activeSocket = null;
        onEvent({
          v: PROTOCOL_VERSION,
          tabId,
          instanceId: connectionInstanceId,
          pid: null,
          seq: lastSequence ?? 0,
          droppedBefore: false,
          gap: false,
          event: { type: 'disconnect' },
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  try { await fs.promises.chmod(socketPath, 0o600); } catch {}

  const close = async (reason = 'close') => {
    if (closed) return false;
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.unlink(socketPath).catch((error) => {
      if (error?.code !== 'ENOENT') {
        log.warn?.('[CodexSemanticChannel] unlink failed tab=' + String(tabId).slice(-12)
          + ' reason=' + reason + ' error=' + (error?.message || String(error)));
      }
    });
    return true;
  };

  return { socketPath, close };
}

module.exports = {
  CODE_MODE_HOST_EXECUTABLE_NAME,
  MAX_BUFFER_BYTES,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  createCodexSemanticChannelServer,
  decideCodexBinaryOverride,
  defaultSocketRoot,
  shortSocketName,
  validateEnvelope,
};
