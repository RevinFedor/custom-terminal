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

const DEFAULT_PORT = 53133;
const HUB_VERSION = '1.0.0';
const HOME = os.homedir();

// Same six servers as ~/.claude.json / ~/.codex/config.toml. `stateful` marks
// servers that receive client-closed notifications for per-tab cleanup.
function defaultServerDefs() {
  return {
    knowledge: {
      command: 'node',
      args: [path.join(HOME, '.claude/mcp/knowledge-server.mjs')],
      env: {
        KNOWLEDGE_DISABLE_GEMINI: 'true',
        KNOWLEDGE_DISABLE_CLAUDE_P: 'true',
        KNOWLEDGE_ROUTER_PROVIDER: 'codex',
        KNOWLEDGE_CODEX_MODEL: 'gpt-5.6-luna',
        KNOWLEDGE_CODEX_EFFORT: 'low',
        KNOWLEDGE_INDEX_PROVIDER: 'codex',
      },
      stateful: false,
    },
    terminal: {
      command: 'node',
      args: [path.join(HOME, '.claude/mcp/terminal-server.mjs')],
      env: {},
      stateful: false, // identity is per-call via _meta, no per-tab resources held
    },
    browser: {
      command: 'node',
      args: ['/Users/fedor/Desktop/sc-desktop/mcp/browser/index.js'],
      env: {},
      stateful: false, // multi-client safe by design (shared bridge.js)
    },
    electron: {
      command: 'node',
      args: ['/Users/fedor/Desktop/electron-mcp/src/index.mjs'],
      env: {},
      stateful: true, // per-tab CDP connections
    },
    ios: {
      command: 'node',
      args: ['/Users/fedor/Desktop/ios-mcp/src/index.mjs'],
      env: {},
      stateful: true, // per-tab simulator/appium sessions
    },
    'sc-desktop': {
      command: '/Users/fedor/Desktop/sc-desktop/mcp/run.sh',
      args: [],
      env: {},
      stateful: false,
      // run.sh execs Electron with server.js — the orphan on ps shows server.js,
      // not run.sh, so the reaper needs the real marker.
      reapMarker: '/Users/fedor/Desktop/sc-desktop/mcp/server.js',
    },
  };
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

class ChildServer {
  constructor(name, def, log) {
    this.name = name;
    this.def = def;
    this.log = log;
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
  }

  status() {
    return {
      name: this.name,
      up: !!(this.proc && this.proc.exitCode === null),
      pid: this.proc?.pid || null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
      pendingRequests: this.pending.size,
      initialized: !!this.initResult,
    };
  }

  ensureStarted() {
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
      this.log(`[MCPHub] spawn ${this.name}: ${command} ${args.join(' ')}`);
      let proc;
      try {
        // Children are SHARED across sessions: strip per-session identity vars
        // that a standalone hub launched from inside an AI tab would inherit.
        const baseEnv = { ...process.env };
        for (const key of Object.keys(baseEnv)) {
          if (key.startsWith('NOTED_') || key === 'CLAUDE_PROJECT_DIR') delete baseEnv[key];
        }
        proc = spawn(command, args, {
          env: { ...baseEnv, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: HOME,
        });
      } catch (err) {
        this.lastError = String(err.message || err);
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
        this.log(`[MCPHub] ${this.name} spawn error: ${err.message}`);
        failStartup(`spawn error: ${err.message}`);
        this._onExit(null, null);
      });

      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.log(`[MCPHub:${this.name}:err] ${text.slice(0, 500)}`);
      });

      this.rl = readline.createInterface({ input: proc.stdout, terminal: false });
      let buffer = '';
      this.rl.on('line', (line) => {
        if (!line.trim()) return;
        // Some servers (terminal-server) may emit multi-line JSON; accumulate.
        buffer += line;
        let msg;
        try { msg = JSON.parse(buffer); buffer = ''; }
        catch { return; } // incomplete JSON — keep accumulating
        this._onMessage(msg);
      });

      proc.on('exit', (code, signal) => {
        failStartup(`exited during startup (code=${code} signal=${signal})`);
        this._onExit(code, signal);
      });

      // Handshake: initialize -> initialized. Cache result for local replies.
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        failStartup('initialize timeout (20s)');
      }, 20000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.initResult = result;
          this._writeRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
          settled = true;
          this.log(`[MCPHub] ${this.name} ready (pid ${proc.pid}, server ${result?.serverInfo?.name || '?'} ${result?.serverInfo?.version || ''})`);
          resolve(result);
        },
        reject: (err) => { clearTimeout(timer); failStartup(String(err?.message || err)); },
      });
      this._writeRaw({ ...HANDSHAKE, id });
    });
  }

  _onMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
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

  _onExit(code, signal) {
    if (this.proc === null && this.initPromise === null) return; // already handled
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
    if (!this.stopped) {
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
          reject(new Error(`${this.name}.${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
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

  notify(method, params) {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { this._writeRaw({ jsonrpc: '2.0', method, params }); } catch {}
  }

  async restart() {
    const proc = this.proc;
    this.log(`[MCPHub] manual restart ${this.name}`);
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
    }
    this.backoffMs = 1000;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    return this.ensureStarted();
  }

  stop() {
    this.stopped = true;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      setTimeout(() => { try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    }
  }
}

// ---------------------------------------------------------------------------

function parseIdentity(req, urlObj) {
  const q = urlObj.searchParams;
  let tab = q.get('tab') || '';
  let project = q.get('project') || '';
  let cwd = q.get('cwd') || '';
  let mainPid = q.get('mainPid') || '';
  // Claude leaves `${VAR}` literally when the variable is missing (external
  // sessions without NOTED_* env). Treat unexpanded placeholders as empty.
  if (tab.startsWith('${')) tab = '';
  if (project.startsWith('${')) project = '';
  if (cwd.startsWith('${')) cwd = '';
  if (mainPid.startsWith('${')) mainPid = '';
  if (!tab) {
    const auth = String(req.headers['authorization'] || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    // Identity bearer format: <tab>|<project>|<cwd>|<mainPid>. A token without
    // any '|' is not our format (some client sending a real auth token) —
    // treat as anonymous rather than mistaking it for a tab id.
    if (m && m[1].includes('|')) {
      const [t, p, c, mp] = m[1].split('|');
      tab = t || '';
      project = project || p || '';
      cwd = cwd || c || '';
      mainPid = mainPid || mp || '';
    }
  }
  return { tabId: tab, projectId: project, cwd, mainPid };
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
  constructor({ port = DEFAULT_PORT, log = (l) => console.log(l), serverDefs = null } = {}) {
    this.port = port;
    this.log = log;
    this.children = new Map();
    for (const [name, def] of Object.entries(serverDefs || defaultServerDefs())) {
      this.children.set(name, new ChildServer(name, def, log));
    }
    this.httpServer = null;
    this.actualPort = null;
    this.knownClients = new Map(); // tabId -> lastSeen ms (for TTL cleanup)
    this.sweepTimer = null;
  }

  status() {
    return {
      port: this.actualPort,
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
      const marker = child.def.reapMarker
        || (child.def.args && child.def.args.length ? child.def.args[child.def.args.length - 1] : child.def.command);
      if (marker) needles.push(marker);
    }
    for (const line of rows) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const args = m[3];
      if (ppid !== 1 || pid === process.pid) continue;
      if (needles.some((n) => args.includes(n))) {
        try {
          process.kill(pid, 'SIGTERM');
          this.log('[MCPHub] reaped orphaned server pid ' + pid + ' (' + args.slice(0, 80) + ')');
        } catch {}
      }
    }
  }

  async start({ eager = true } = {}) {
    this.reapOrphanedChildren();
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
    if (eager) {
      // Warm all servers so first tool call in a fresh session is instant.
      for (const child of this.children.values()) {
        child.ensureStarted().catch((err) => this.log(`[MCPHub] eager start ${child.name} failed: ${err.message}`));
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

  async stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const child of this.children.values()) child.stop();
    if (this.httpServer) {
      await new Promise((r) => this.httpServer.close(r));
      this.httpServer = null;
    }
  }

  async _handleHttp(req, res) {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const parts = urlObj.pathname.split('/').filter(Boolean); // ['mcp', '<name>']
    if (parts[0] !== 'mcp') return sendJson(res, 404, { error: 'not found' });

    if (parts[1] === '_status') {
      return sendJson(res, 200, { version: HUB_VERSION, pid: process.pid, ...this.status() });
    }
    // Control endpoints (used by Noted Terminal main over HTTP — the hub is a
    // detached process, so in-proc calls are not available to the app).
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
        this.log(`[MCPHub] ${child.name} rpc failure: ${err.message}`);
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

    const result = await child.request(method, params);
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  }
}

module.exports = { McpHub, defaultServerDefs, DEFAULT_PORT };

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
    }).catch((err) => {
      console.error(`[MCPHub] failed to start: ${err.message}`);
      process.exit(1);
    });
    process.on('SIGINT', () => hub.stop().then(() => process.exit(0)));
    process.on('SIGTERM', () => hub.stop().then(() => process.exit(0)));
  }
}
