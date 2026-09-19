'use strict';

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const { buildMcpEnvironment } = require('./mcp-hub');

// Main owns launch/recovery, not the six stdio transports. Startup uses a
// one-shot IPC readiness signal; shutdown waits for the old HTTP socket to
// close, so quick app reopen cannot race a port still held by the old hub.
function createMcpHubController({ port, script, canSpawn = true, log = console.log,
  executable = process.execPath, env = process.env, fetchImpl = fetch, spawnImpl = spawn,
  startupTimeoutMs = 12000 } = {}) {
  const base = 'http://127.0.0.1:' + port;
  let inflight = null;
  const ready = server => server.up && server.initialized && !server.recovering;
  async function status(timeoutMs = 1200) {
    try {
      const response = await fetchImpl(base + '/mcp/_status', { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const value = await response.json();
      return Array.isArray(value.servers) ? value : null;
    } catch { return null; }
  }
  async function post(route) {
    const response = await fetchImpl(base + route, { method: 'POST', signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'MCP HTTP ' + response.status);
    return result;
  }
  function shutdown(expectedPid) {
    return new Promise((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: true });
      let acknowledged = false;
      const finish = error => { clearTimeout(timer); agent.destroy(); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Хаб не освободил порт после остановки')), startupTimeoutMs);
      const req = http.request(base + '/mcp/_shutdown?pid=' + encodeURIComponent(expectedPid), { method: 'POST', agent }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { acknowledged = res.statusCode === 200 && JSON.parse(body).ok === true; }
          catch {}
          if (!acknowledged) finish(new Error('Хаб отказал в остановке'));
        });
      });
      req.on('socket', socket => socket.once('close', () => {
        finish(acknowledged ? null : new Error('Остановка хаба не подтверждена'));
      }));
      req.on('error', finish);
      req.end();
    });
  }
  function launch() {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(executable, [script, '--standalone', '--port', String(port)], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: buildMcpEnvironment({ ...env, ELECTRON_RUN_AS_NODE: '1' }), cwd: os.homedir(),
      });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child.connected) child.disconnect();
        child.unref();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Хаб не подтвердил запуск')), startupTimeoutMs);
      child.once('error', error => finish(error));
      child.once('exit', (code, signal) => {
        // Another app may win the bind while both are starting. Reuse that
        // exact listener; do not terminate its children or spawn another copy.
        void status().then(st => finish(st ? null : new Error(`Хаб завершился при запуске (${code ?? signal})`), st));
      });
      child.once('message', message => {
        if (message?.type === 'mcp-hub:ready') finish(null, message.status);
        else if (message?.type === 'mcp-hub:error') {
          void status().then(st => finish(st ? null : new Error(message.error), st));
        }
      });
      log('[MCPHub] spawned detached hub pid ' + child.pid + ' on :' + port);
    });
  }
  function ensure({ upgrade = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const existing = await status();
      const brokenLaunch = existing && existing.servers.length > 0
        && existing.servers.every(server => !ready(server) && !server.pendingRequests)
        && existing.servers.some(server => /ENOENT|code=127/.test(server.lastError || ''));
      const needsUpgrade = existing && !existing.capabilities?.launchEnvironment && (upgrade || brokenLaunch);
      if (existing && !needsUpgrade) return existing;
      if (!canSpawn) return existing; // E2E may observe, never own/replace global hub
      if (existing) {
        log('[MCPHub] replacing legacy hub pid ' + existing.pid + ' with repaired launch environment');
        try { await shutdown(existing.pid); }
        catch (error) {
          const replacement = await status();
          if (replacement && replacement.pid !== existing.pid) return replacement;
          throw error;
        }
      }
      return launch();
    })().finally(() => { inflight = null; });
    return inflight;
  }
  async function restart(name) {
    if (!canSpawn) return { ok: false, error: 'Изолированный тест не может перезапускать общий MCP-хаб' };
    try {
      const st = await ensure({ upgrade: true });
      if (!st) return { ok: false, error: 'MCP-хаб недоступен' };
      if (name) return await post('/mcp/_restart/' + encodeURIComponent(name));
      if (st.capabilities?.restartAll) return await post('/mcp/_restart-all');
      // Observe-only E2E must not replace an existing older hub.
      return { ok: false, error: 'Для общего перезапуска нужно обновить MCP-хаб' };
    } catch (error) {
      log('[MCPHub] restart failed: ' + error.message);
      return { ok: false, error: error.message };
    }
  }
  return { status, ensure, restart };
}

module.exports = { createMcpHubController };
