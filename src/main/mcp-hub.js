// =============================================================================
// MCP Hub — one shared backend process per MCP server instead of a copy per
// AI session. Each of the six servers (knowledge, terminal, browser, electron,
// ios, sc-desktop) is spawned ONCE as a stdio child; Claude/Codex sessions
// connect over Streamable HTTP (POST JSON-RPC) to
//   http://127.0.0.1:<port>/mcp/<server>?tab=<tabId>&project=<projectId>&cwd=<cwd>
// The hub bridges HTTP <-> stdio, remaps JSON-RPC ids (many clients share one
// stdio pipe), answers `initialize` locally from a cached handshake, and
// injects the caller identity into params._meta.noted so stateful servers
// (terminal, electron, ios, knowledge) can route per-tab state.
//
// Identity sources (first wins):
//   1. Query params ?tab=&project=&cwd=   (Claude: ${VAR} expansion in url)
//   2. Authorization: Bearer <tab>|<project>|<cwd>  (Codex: bearer_token_env_var)
// No identity -> "external" client: servers fall back to cwd/default routing,
// same behavior as a standalone stdio spawn from a plain terminal.
//
// Crash policy: child exit -> pending requests fail, respawn with backoff.
// Tab close: main calls notifyClientClosed(tabId) -> hub sends
// notifications/noted/client-closed to stateful children so they dispose
// per-tab contexts (CDP connections, simulator sessions).
//
// Runs embedded in Electron main (start()/stop()) or standalone:
//   node src/main/mcp-hub.js --standalone [--port 53133]
// =============================================================================

const http = require('http');
const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { buildChildProcessEnv } = require('./child-process-env');
const { resolveHubConfiguration, CONFIG_HEADER, EXPECTED_CONFIG_ENV } = require('./mcp-hub-config');

const DEFAULT_PORT = 53133;
const HUB_VERSION = '1.1.0';
const HOME = os.homedir();

// Finder/login launches have only /usr/bin:/bin:/usr/sbin:/sbin. Do not make
// shared tools depend on how the app happened to be launched, or a shell RC.
function buildMcpEnvironment(source = process.env) {
  const env = buildChildProcessEnv({}, source);
  const runtimeDir = /^node(?:js)?(?:\.exe)?$/i.test(path.basename(process.execPath))
    ? path.dirname(process.execPath) : null;
  const entries = [runtimeDir, ...(env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'),
    path.join(HOME, '.claude/local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [...new Set(entries.filter(Boolean))].join(path.delimiter);
  return env;
}

function resolveNodeExecutable(env = process.env) {
  for (const dir of buildMcpEnvironment(env).PATH.split(path.delimiter)) {
    const file = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  throw new Error('Node.js не найден: установите Node.js и повторите запуск MCP');
}

// Compatibility export: membership only, never a native-client config importer.
function defaultServerDefs(source = process.env) {
  return resolveHubConfiguration(source).serverDefs;
}

const HANDSHAKE = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'noted-mcp-hub', version: '1.0.0' },
  },
};

const CATALOG_METHODS = new Set([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);
const DEFAULT_CATALOG_TIMEOUT_MS = 4000;

function canOwnGlobalHub(env = process.env) {
  return env.NOTED_E2E_TEST !== 'true';
}

class ChildServer {
  constructor(name, def, log, { catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS, env = process.env } = {}) {
    this.name = name;
    this.def = def;
    this.log = log;
    this.catalogTimeoutMs = catalogTimeoutMs;
    this.proc = null;
    this.rl = null;
    this.pending = new Map(); // internalId -> { resolve, reject, timer }
    this.nextId = 1;
    this.initResult = null;   // cached initialize result from the child
    this.initPromise = null;
    this.restarts = 0;
    this.lastExit = null;
    this.lastError = null;
    this.startedAt = null;
    this.backoffMs = 1000;
    this.stopped = false;
    this.respawnTimer = null;
    this.recoveryPromise = null;
    this.lastResponseAt = null;
    this.lastRecovery = null;
    this.env = env;
    this.restartPromise = null;
    this.restarting = false;
  }

  status() {
    return {
      name: this.name,
      up: !!(this.proc?.pid && this.proc.exitCode === null && this.proc.signalCode === null),
      pid: this.proc?.pid || null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
      pendingRequests: this.pending.size,
      initialized: !!this.initResult,
      recovering: this.restarting || !!this.recoveryPromise,
      lastResponseAt: this.lastResponseAt,
      lastRecovery: this.lastRecovery,
    };
  }

  ensureStarted() {
    if (this.restartPromise) return this.restartPromise;
    return this._ensureStarted();
  }

  _ensureStarted() {
    if (this.stopped) return Promise.reject(new Error(`hub stopped`));
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._spawnAndInit().catch((err) => {
      this.initPromise = null; // allow retry on next request
      throw err;
    });
    return this.initPromise;
  }

  _spawnAndInit() {
    return new Promise((resolve, reject) => {
      const { command, args, env } = this.def;
      let proc;
      try {
        // Children are SHARED across sessions: strip per-session identity vars
        // that a standalone hub launched from inside an AI tab would inherit.
        const baseEnv = buildMcpEnvironment(this.env);
        for (const key of Object.keys(baseEnv)) {
          if (key.startsWith('NOTED_') || key === 'CLAUDE_PROJECT_DIR') delete baseEnv[key];
        }
        const childEnv = buildMcpEnvironment({ ...baseEnv, ...env });
        const executable = command === 'node' ? resolveNodeExecutable(childEnv) : command;
        // Explicit per-server env must not reintroduce another tab's identity.
        for (const key of ['NOTED_PARENT_TAB_ID', 'NOTED_PARENT_PROJECT_ID', 'NOTED_MAIN_PID',
          'NOTED_MCP_IDENTITY', 'NOTED_MCP_INSTANCE_ROUTE', 'NOTED_DISCOVERY_DIR', 'CLAUDE_PROJECT_DIR', EXPECTED_CONFIG_ENV]) delete childEnv[key];
        this.log(`[MCPHub] spawn ${this.name}`);
        proc = spawn(executable, args, {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: HOME,
        });
      } catch (err) {
        this.lastError = err.code || 'spawn failed';
        reject(err);
        return;
      }
      this.proc = proc;
      this.startedAt = Date.now();
      this.lastError = null;

      let settled = false;
      const failStartup = (why) => {
        if (settled) return;
        settled = true;
        this.lastError = why;
        reject(new Error(`${this.name}: ${why}`));
      };

      proc.on('error', (err) => {
        this.log(`[MCPHub] ${this.name} spawn error: ${err.code || 'unknown'}`);
        failStartup(`spawn error: ${err.code || 'unknown'}`);
        this._onExit(proc, null, null);
      });
      proc.stdin.on('error', (err) => {
        // EPIPE after a failed spawn must not terminate the whole shared hub.
        failStartup(`stdin error: ${err.code || 'unknown'}`);
      });

      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.log(`[MCPHub:${this.name}:err] stderr received (content withheld)`);
      });

      this.rl = readline.createInterface({ input: proc.stdout, terminal: false });
      this.rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try {
          // MCP stdio is newline-delimited JSON. Treat each line independently:
          // one accidental stdout diagnostic must not poison every later reply.
          msg = JSON.parse(line);
        } catch (error) {
          this.lastError = 'invalid stdout line';
          this.log(`[MCPHub] ${this.name} ignored non-JSON stdout`);
          return;
        }
        if (this.proc === proc) this._onMessage(msg);
      });

      proc.on('exit', (code, signal) => {
        failStartup(`exited during startup (code=${code} signal=${signal})`);
        this._onExit(proc, code, signal);
      });

      // Handshake: initialize -> initialized. Cache result for local replies.
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        failStartup('initialize timeout (20s)');
        try { proc.kill('SIGTERM'); } catch {}
      }, 20000);
      this.pending.set(id, {
        method: 'initialize',
        startedAt: Date.now(),
        resolve: (result) => {
          clearTimeout(timer);
          this.initResult = result;
          this._writeRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
          settled = true;
          this.log(`[MCPHub] ${this.name} ready (pid ${proc.pid})`);
          resolve(result);
        },
        reject: () => { clearTimeout(timer); failStartup('initialize rejected'); },
      });
      this._writeRaw({ ...HANDSHAKE, id });
    });
  }

  _onMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      this.lastResponseAt = Date.now();
      this.lastError = null;
      if (msg.error) entry.reject(Object.assign(new Error(msg.error.message || 'MCP error'), { rpcError: msg.error }));
      else entry.resolve(msg.result);
      return;
    }
    // Server-initiated request/notification. None of our six servers use
    // these toward the client; log and drop.
    if (msg && msg.method) {
      this.log(`[MCPHub] ${this.name} server-initiated ${msg.method} dropped`);
    }
  }

  _onExit(proc, code, signal) {
    if (this.proc !== proc) return; // old generation cannot clear its replacement
    const up = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.log(`[MCPHub] ${this.name} exited code=${code} signal=${signal} uptime=${up}s pending=${this.pending.size}`);
    this.lastExit = { code, signal, at: Date.now() };
    for (const [, entry] of this.pending) {
      entry.reject(new Error(`${this.name} process exited (code=${code})`));
    }
    this.pending.clear();
    try { this.rl?.close(); } catch {}
    this.rl = null;
    this.proc = null;
    this.initResult = null;
    this.initPromise = null;
    if (!this.stopped && !this.restarting) {
      // Lazy respawn: next request re-triggers ensureStarted. Also schedule an
      // eager respawn with backoff so tools/list from a fresh session works
      // immediately after a crash.
      this.restarts += 1;
      const delay = Math.min(this.backoffMs, 30000);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (!this.stopped && !this.initPromise) {
          this.ensureStarted().then(() => { this.backoffMs = 1000; }).catch(() => {});
        }
      }, delay);
      if (this.respawnTimer.unref) this.respawnTimer.unref();
    }
  }

  _writeRaw(obj) {
    if (!this.proc || this.proc.exitCode !== null) throw new Error(`${this.name} not running`);
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // Forward a client request; returns the child's `result` (throws on error).
  async request(method, params, { timeoutMs = 0 } = {}) {
    await this.ensureStarted();
    this.backoffMs = 1000;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          const error = new Error(`${this.name}.${method} timed out after ${timeoutMs}ms`);
          error.code = 'MCP_REQUEST_TIMEOUT';
          this.lastError = error.message;
          reject(error);
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        startedAt: Date.now(),
        resolve: (r) => { if (timer) clearTimeout(timer); resolve(r); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try {
        this._writeRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  async requestCatalog(method, params) {
    try {
      return await this.request(method, params, { timeoutMs: this.catalogTimeoutMs });
    } catch (error) {
      const timedOut = error?.code === 'MCP_REQUEST_TIMEOUT';
      // Concurrent catalog callers are rejected when the first timeout kills
      // the child. They join the same recovery and retry instead of failing.
      if (!timedOut && !this.recoveryPromise) throw error;
      // Catalog recovery cannot cancel an in-flight tool operation.
      if (!this.recoveryPromise && [...this.pending.values()].some(entry => !CATALOG_METHODS.has(entry.method))) throw error;
      if (!this.recoveryPromise) {
        this.lastRecovery = {
          at: Date.now(),
          method,
          reason: String(error.message || error),
        };
        this.log(`[MCPHub] ${this.name} catalog stalled; restarting before retry: ${this.lastRecovery.reason}`);
        this.recoveryPromise = this.restart().finally(() => {
          this.recoveryPromise = null;
        });
      }
      await this.recoveryPromise;
      return await this.request(method, params, { timeoutMs: this.catalogTimeoutMs });
    }
  }

  notify(method, params) {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { this._writeRaw({ jsonrpc: '2.0', method, params }); } catch {}
  }

  restart() {
    if (this.restartPromise) return this.restartPromise;
    if (this.stopped) return Promise.reject(new Error('hub stopped'));
    this.restarting = true;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    this.restartPromise = Promise.resolve().then(async () => {
      this.log(`[MCPHub] manual restart ${this.name}`);
      this.restarts += 1;
      await this._terminate();
      this.backoffMs = 1000;
      return this._ensureStarted();
    }).finally(() => { this.restarting = false; this.restartPromise = null; });
    return this.restartPromise;
  }

  _terminate() {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); proc.removeListener('exit', done); proc.removeListener('error', done); resolve(); };
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
      proc.once('exit', done);
      proc.once('error', done);
      if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) {
        this._onExit(proc, proc.exitCode, proc.signalCode); done();
      } else { try { proc.kill('SIGTERM'); } catch { done(); } }
    });
  }

  stop() {
    this.stopped = true;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    return this._terminate();
  }
}

// ---------------------------------------------------------------------------

function parseIdentity(req, urlObj) {
  const q = urlObj.searchParams;
  let tab = q.get('tab') || '';
  let project = q.get('project') || '';
  let cwd = q.get('cwd') || '';
  let mainPid = q.get('mainPid') || '';
  let instanceRoute = q.get('instanceRoute') || '';
  // Claude leaves `${VAR}` literally when the variable is missing (external
  // sessions without NOTED_* env). Treat unexpanded placeholders as empty.
  if (tab.startsWith('${')) tab = '';
  if (project.startsWith('${')) project = '';
  if (cwd.startsWith('${')) cwd = '';
  if (mainPid.startsWith('${')) mainPid = '';
  if (instanceRoute.startsWith('${')) instanceRoute = '';
  if (!tab) {
    const auth = String(req.headers['authorization'] || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    // Identity bearer format: <tab>|<project>|<cwd>|<mainPid>. A token without
    // any '|' is not our format (some client sending a real auth token) —
    // treat as anonymous rather than mistaking it for a tab id.
    if (m && m[1].includes('|')) {
      const [t, p, c, mp, route] = m[1].split('|');
      tab = t || '';
      project = project || p || '';
      cwd = cwd || c || '';
      mainPid = mainPid || mp || '';
      instanceRoute = instanceRoute || route || '';
    }
  }
  return { tabId: tab, projectId: project, cwd, mainPid, ...(instanceRoute ? { instanceRoute } : {}) };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

class McpHub {
  constructor({
    port = DEFAULT_PORT,
    log = (l) => console.log(l),
    serverDefs = null,
    catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
    env = process.env,
  } = {}) {
    this.port = port;
    this.log = log;
    this.children = new Map();
    this.configuration = serverDefs === null ? resolveHubConfiguration(env) : null;
    this.expectedConfiguration = env[EXPECTED_CONFIG_ENV];
    for (const [name, def] of Object.entries(serverDefs || this.configuration.serverDefs)) {
      this.children.set(name, new ChildServer(name, def, log, { catalogTimeoutMs, env }));
    }
    this.httpServer = null;
    this.actualPort = null;
    this.knownClients = new Map(); // tabId -> lastSeen ms (for TTL cleanup)
    this.sweepTimer = null;
    this.restartAllPromise = null;
  }

  status() {
    return {
      port: this.actualPort,
      configuration: this.configuration?.status || null,
      servers: Array.from(this.children.values()).map((c) => c.status()),
      clients: Array.from(this.knownClients.entries()).map(([tabId, lastSeen]) => ({ tabId, lastSeen })),
    };
  }

  // A previous hub killed with SIGKILL leaves its six children orphaned under
  // launchd (ppid 1). They are OUR paths and no session's stdio child (those
  // have a live claude/codex parent), so reaping them on startup is safe and
  // prevents double fleets. bridge.js is intentionally NOT in this list.
  reapOrphanedChildren() {
    let rows = [];
    try {
      const out = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 }).toString();
      rows = out.split('\n');
    } catch { return; }
    const needles = [];
    for (const child of this.children.values()) {
      // Generic commands/last arbitrary argv are not ownership evidence.
      const script = child.def.args?.[0];
      const marker = child.def.reapMarker ||
        (/^node(?:js)?(?:\.exe)?$/i.test(path.basename(child.def.command)) && script && path.isAbsolute(script) ? script : null);
      if (marker && path.isAbsolute(marker)) needles.push(marker);
    }
    for (const line of rows) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const args = m[3];
      if (ppid !== 1 || pid === process.pid) continue;
      const ownsMarker = marker => {
        let at = args.indexOf(marker);
        while (at !== -1) {
          const end = at + marker.length;
          if ((at === 0 || /[\s"']/.test(args[at - 1]))
            && (end === args.length || /[\s"']/.test(args[end]))) return true;
          at = args.indexOf(marker, at + marker.length);
        }
        return false;
      };
      if (needles.some(ownsMarker)) {
        try {
          process.kill(pid, 'SIGTERM');
          this.log('[MCPHub] reaped orphaned server pid ' + pid);
        } catch {}
      }
    }
  }

  async start({ eager = true } = {}) {
    if (this.configuration && !this.configuration.canLaunch) throw new Error(this.configuration.status.error);
    // Controller pinned the reviewed read before spawn. A newer file cannot
    // execute first and merely report configurationApplied:false afterwards.
    if (this.configuration && this.expectedConfiguration !== undefined
      && this.expectedConfiguration !== this.configuration.fingerprint) throw new Error('profile_changed_before_launch');
    await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this._handleHttp(req, res));
      srv.on('error', (err) => reject(err));
      srv.listen(this.port, '127.0.0.1', () => {
        this.actualPort = srv.address().port;
        this.httpServer = srv;
        this.log(`[MCPHub] listening on http://127.0.0.1:${this.actualPort}/mcp/<server>`);
        resolve();
      });
    });
    // Only the winner of the port bind owns recovery. A second app starting
    // concurrently must not touch servers belonging to the existing hub.
    this.reapOrphanedChildren();
    if (eager) {
      // Warm all servers so first tool call in a fresh session is instant.
      for (const child of this.children.values()) {
        child.ensureStarted().catch(() => this.log(`[MCPHub] eager start ${child.name} failed`));
      }
    }
    // TTL sweep: forget clients silent for 6h, notify stateful servers.
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - 6 * 3600 * 1000;
      for (const [tabId, lastSeen] of this.knownClients) {
        if (lastSeen < cutoff) {
          this.knownClients.delete(tabId);
          this.notifyClientClosed(tabId);
        }
      }
    }, 15 * 60 * 1000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
    return this;
  }

  // Called by main when a tab closes; also by TTL sweep.
  notifyClientClosed(tabId) {
    if (!tabId) return;
    this.knownClients.delete(tabId);
    for (const child of this.children.values()) {
      if (child.def.stateful) child.notify('notifications/noted/client-closed', { clientId: tabId });
    }
  }

  async restartServer(name) {
    const child = this.children.get(name);
    if (!child) throw new Error(`unknown server: ${name}`);
    await child.restart();
    return child.status();
  }

  restartAll() {
    if (this.restartAllPromise) return this.restartAllPromise;
    this.restartAllPromise = Promise.allSettled([...this.children.values()].map(child => child.restart()))
      .then(results => ({ ok: results.every(result => result.status === 'fulfilled'), ...this.status() }))
      .finally(() => { this.restartAllPromise = null; });
    return this.restartAllPromise;
  }

  async stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.children.values()].map(child => child.stop()));
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(finish);
        // Streamable-HTTP clients can keep idle sockets alive after their
        // request has timed out. Do not let those sockets pin the global port
        // during a controlled hub replacement.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        setTimeout(finish, 500).unref?.();
      });
    }
  }

  async _handleHttp(req, res) {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const parts = urlObj.pathname.split('/').filter(Boolean); // ['mcp', '<name>']
    if (parts[0] !== 'mcp') return sendJson(res, 404, { error: 'not found' });

    if (parts[1] === '_status') {
      return sendJson(res, 200, { version: HUB_VERSION, pid: process.pid,
        capabilities: { restartAll: true, launchEnvironment: 1, configuration: 1, instanceRouting: 1 }, ...this.status(),
        configurationMatches: this.configuration ? req.headers[CONFIG_HEADER] === this.configuration.fingerprint : null });
    }
    // Control endpoints (used by Noted Terminal main over HTTP — the hub is a
    // detached process, so in-proc calls are not available to the app).
    if (parts[1] === '_restart-all' && req.method === 'POST') {
      return sendJson(res, 200, await this.restartAll());
    }
    if (parts[1] === '_restart' && req.method === 'POST') {
      const name = parts[2];
      try {
        const st = await this.restartServer(name);
        return sendJson(res, 200, { ok: true, server: st });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err.message || err) });
      }
    }
    if (parts[1] === '_client-closed' && req.method === 'POST') {
      const tabId = urlObj.searchParams.get('tab') || '';
      this.notifyClientClosed(tabId);
      return sendJson(res, 200, { ok: true });
    }
    if (parts[1] === '_shutdown' && req.method === 'POST') {
      const expectedPid = urlObj.searchParams.get('pid');
      if (expectedPid && Number(expectedPid) !== process.pid) {
        return sendJson(res, 409, { ok: false, error: 'hub generation changed' });
      }
      sendJson(res, 200, { ok: true });
      setTimeout(() => this.stop().then(() => process.exit(0)), 50);
      return;
    }
    const child = this.children.get(parts[1]);
    if (!child) return sendJson(res, 404, { error: `unknown server: ${parts[1]}` });

    if (req.method === 'GET') {
      // No server->client stream offered; spec allows 405 here.
      res.writeHead(405, { allow: 'POST, DELETE' });
      return res.end();
    }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 30_000_000) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      if (Array.isArray(msg)) {
        return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batching not supported' } });
      }
      const identity = parseIdentity(req, urlObj);
      if (identity.tabId) this.knownClients.set(identity.tabId, Date.now());
      try {
        await this._handleRpc(child, msg, identity, res);
      } catch (err) {
        this.log(`[MCPHub] ${child.name} rpc failure`);
        if (!res.headersSent) {
          const rpcError = err.rpcError || { code: -32000, message: String(err.message || err) };
          sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, error: rpcError });
        }
      }
    });
  }

  async _handleRpc(child, msg, identity, res) {
    const { method, id } = msg;

    // Notifications (no id): accept, forward the meaningful ones.
    if (id === undefined || id === null && method) {
      if (method && !method.startsWith('notifications/')) {
        // request with null id — treat as notification-ish, still 202
      }
      // Swallow initialized (hub already did the handshake once).
      res.writeHead(202); res.end();
      return;
    }

    if (method === 'initialize') {
      const initResult = await child.ensureStarted();
      // Echo the child's negotiated capabilities; keep child's protocolVersion.
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: initResult });
    }
    if (method === 'ping') {
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    }
    // Claude probes with server/discover before initialize; none of our six
    // servers implement it. Answer locally instead of forwarding — keeps the
    // children's stderr and our log free of method-not-found noise.
    if (method === 'server/discover') {
      return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: server/discover' } });
    }

    // Inject caller identity for stateful/per-project servers.
    const params = { ...(msg.params || {}) };
    params._meta = { ...(params._meta || {}), noted: identity };

    const result = CATALOG_METHODS.has(method)
      ? await child.requestCatalog(method, params)
      : await child.request(method, params);
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  }
}

module.exports = { McpHub, defaultServerDefs, canOwnGlobalHub, DEFAULT_PORT, buildMcpEnvironment, resolveNodeExecutable };

// ---------------------------------------------------------------------------
// Standalone mode for development / testing without Electron.
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--standalone')) {
    const portIdx = argv.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1], 10) : DEFAULT_PORT;
    const hub = new McpHub({ port });
    hub.start().then(() => {
      console.log(`[MCPHub] standalone ready on ${hub.actualPort}`);
      process.send?.({ type: 'mcp-hub:ready', status: { version: HUB_VERSION, pid: process.pid,
        capabilities: { restartAll: true, launchEnvironment: 1, configuration: 1 }, ...hub.status() } });
    }).catch((err) => {
      console.error(`[MCPHub] failed to start: ${err.message}`);
      if (process.send) process.send({ type: 'mcp-hub:error', error: err.message }, () => process.exit(1));
      else process.exit(1);
    });
    process.on('SIGINT', () => hub.stop().then(() => process.exit(0)));
    process.on('SIGTERM', () => hub.stop().then(() => process.exit(0)));
  }
}
