'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const DISCOVERY_DIR = path.join(os.homedir(), '.noted-terminal');
const TOKEN_PATH = path.join(DISCOVERY_DIR, 'web-token.txt');
const PROD_APP_MARKER = '/Applications/Noted Terminal.app';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidCommand(pid) {
  try {
    return execSync('ps -p ' + Number(pid) + ' -o command=', {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
  } catch {
    return '';
  }
}

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return null; }
}

function findProdServer({ forcePort = null } = {}) {
  if (forcePort) return { port: Number(forcePort), pid: null, cmd: '(forced)', forced: true };
  let files = [];
  try { files = fs.readdirSync(DISCOVERY_DIR).filter((name) => /^web-server-\d+\.json$/.test(name)); }
  catch { return null; }
  const candidates = [];
  for (const file of files) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, file), 'utf8')); }
    catch { continue; }
    if (!record?.pid || !record?.port || !pidAlive(record.pid)) continue;
    const cmd = pidCommand(record.pid);
    if (!cmd.includes(PROD_APP_MARKER)) continue;
    candidates.push({
      port: Number(record.port),
      pid: Number(record.pid),
      updatedAt: Number(record.updatedAt) || 0,
      cmd,
    });
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] || null;
}

// Installation may quit the app. Failure to read discovery/ps is not proof
// that it is absent. Keep the legacy nullable reader for non-destructive
// callers; the observed installer uses this explicit three-state result.
function inspectProdServer({ forcePort = null, fileSystem = fs, discoveryDir = DISCOVERY_DIR,
  processSnapshot = () => execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 1500 }) } = {}) {
  let files, snapshot;
  try {
    files = fileSystem.readdirSync(discoveryDir).filter(name => /^web-server-\d+\.json$/.test(name));
  } catch (error) {
    return { status: 'unknown', server: null, reason: 'discovery_read_failed' };
  }
  try { snapshot = processSnapshot(); }
  catch { return { status: 'unknown', server: null, reason: 'process_snapshot_failed' }; }
  const commands = new Map();
  for (const line of String(snapshot).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  if (!commands.size) return { status: 'unknown', server: null, reason: 'empty_process_snapshot' };
  const mainMarker = PROD_APP_MARKER + '/Contents/MacOS/Noted Terminal';
  const prodPids = [...commands].filter(([, command]) => (command === mainMarker || command.startsWith(mainMarker + ' '))
    && !command.includes(' --type=') && !command.includes('mcp-hub.js')).map(([pid]) => pid);
  if (!prodPids.length) return { status: 'absent', server: null };
  const candidates = [];
  for (const file of files) {
    const pid = Number(file.match(/\d+/)[0]);
    if (!prodPids.includes(pid)) continue;
    let record;
    try { record = JSON.parse(fileSystem.readFileSync(path.join(discoveryDir, file), 'utf8')); }
    catch { continue; }
    if (Number(record?.pid) !== pid || !Number.isInteger(Number(record?.port))
      || Number(record.port) <= 0 || Number(record.port) > 65535) continue;
    if (forcePort && Number(record.port) !== Number(forcePort)) continue;
    candidates.push({ port: Number(record.port), pid, updatedAt: Number(record.updatedAt) || 0, cmd: commands.get(pid) });
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates.length ? { status: 'found', server: candidates[0] }
    : { status: 'unknown', server: null, reason: forcePort ? 'forced_port_not_live_prod' : 'live_prod_discovery_unavailable' };
}

function requestJson({
  port,
  token,
  method = 'GET',
  requestPath,
  body = null,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch {
            const error = new Error('bad JSON (HTTP ' + res.statusCode + '): ' + raw.slice(0, 160));
            error.statusCode = res.statusCode;
            return reject(error);
          }
        }
        resolve({ statusCode: Number(res.statusCode) || 0, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForProdServer({
  token,
  previousPid = null,
  timeoutMs = 180_000,
  pollMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const server = findProdServer();
    if (server && (!previousPid || server.pid !== previousPid)) {
      try {
        const response = await requestJson({
          port: server.port,
          token,
          requestPath: '/api/me',
          timeoutMs: 2500,
        });
        if (response.statusCode === 200 && response.body?.ok === true) return server;
        lastError = new Error('new app API returned HTTP ' + response.statusCode);
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(pollMs);
  }
  const error = new Error('replacement Noted Terminal did not expose its API before timeout'
    + (lastError ? ': ' + lastError.message : ''));
  error.cause = lastError || undefined;
  throw error;
}

module.exports = {
  DISCOVERY_DIR,
  TOKEN_PATH,
  findProdServer,
  inspectProdServer,
  readToken,
  requestJson,
  sleep,
  waitForProdServer,
};
