'use strict';

const path = require('node:path');
const os = require('node:os');
const { CodexAppServerClient } = require('./codex-account-profiles');
const { defaultServerDefs, DEFAULT_PORT } = require('./mcp-hub');

function catalogError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCode(error) {
  if (error?.code === 'ENOENT') return 'codex_unavailable';
  if (error?.code === -32601) return 'api_unsupported';
  if (error?.code === 'invalid_catalog') return 'invalid_catalog';
  if (/timed out/i.test(error?.message || '')) return 'timeout';
  return 'catalog_unavailable';
}

function safeAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

function hubTarget(value, port, names) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.port !== String(port)) return null;
    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    const name = match ? decodeURIComponent(match[1]) : null;
    return names.includes(name) ? name : null;
  } catch { return null; }
}

// Return display metadata only. Native config also contains instructions,
// auth headers, environment values and command arguments: none cross IPC.
function configServers(config, { hubPort = DEFAULT_PORT, hubNames = Object.keys(defaultServerDefs()) } = {}) {
  const entries = config?.mcp_servers ?? {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw catalogError('invalid_catalog');
  return Object.entries(entries).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw catalogError('invalid_catalog');
    const http = typeof value.url === 'string';
    return {
      id: 'config:' + name,
      name,
      source: 'config',
      enabled: value.enabled !== false,
      transport: http ? 'http' : typeof value.command === 'string' ? 'stdio' : 'unknown',
      address: http ? safeAddress(value.url) : typeof value.command === 'string' ? path.basename(value.command) : null,
      hubServer: http ? hubTarget(value.url, hubPort, hubNames) : null,
    };
  });
}

function pluginServers(detail, summary, config) {
  if (typeof summary.id !== 'string' || typeof summary.name !== 'string'
    || !detail?.plugin || !Array.isArray(detail.plugin.mcpServers)) throw catalogError('invalid_catalog');
  const settings = config.plugins?.[summary.id] || {};
  const enabled = typeof settings.enabled === 'boolean' ? settings.enabled : summary.enabled !== false;
  return detail.plugin.mcpServers.map(name => {
    if (typeof name !== 'string' || !name) throw catalogError('invalid_catalog');
    return {
      id: 'plugin:' + summary.id + ':' + name,
      name,
      source: 'plugin',
      pluginId: summary.id,
      pluginName: summary.name,
      enabled: enabled && settings.mcp_servers?.[name]?.enabled !== false,
      transport: 'plugin',
      address: null,
      hubServer: null,
    };
  });
}

function createCodexMcpCatalogReader({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  clientFactory = options => new CodexAppServerClient(options),
  now = Date.now,
  ttlMs = 2500,
  pluginTtlMs = 30000,
  idleMs = 15000,
  requestTimeoutMs = 5000,
  totalTimeoutMs = 12000,
  hubPort = DEFAULT_PORT,
  hubNames = Object.keys(defaultServerDefs()),
  log = message => console.log(message),
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const pluginCache = new Map();
  let client = null;
  let clientScope = null;
  let pluginSettingsKey = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  let disposed = false;

  function releaseClient() {
    clearTimeout(idleTimer);
    idleTimer = null;
    client?.close();
    client = null;
    clientScope = null;
    pluginSettingsKey = null;
  }

  async function getClient(scope) {
    if (disposed) throw catalogError('catalog_unavailable');
    if (client && clientScope !== scope) releaseClient();
    if (!client) {
      const candidate = clientFactory({ codexHome, requestTimeoutMs,
        initializeCapabilities: { experimentalApi: true } });
      client = candidate;
      clientScope = scope;
      try { await candidate.start(); }
      catch (error) { releaseClient(); throw error; }
    }
    return client;
  }

  async function load(scope, previous) {
    const started = now();
    clearTimeout(idleTimer);
    let code = null;
    let servers = previous?.servers || [];
    let fetchedAt = previous?.fetchedAt || null;
    let deadlineExpired = false;
    const deadline = setTimeout(() => { deadlineExpired = true; releaseClient(); }, totalTimeoutMs);
    deadline.unref?.();
    try {
      let active = await getClient(scope);
      const result = await active.request('config/read', { includeLayers: false, cwd: scope || null });
      const config = result?.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw catalogError('invalid_catalog');
      servers = configServers(config, { hubPort, hubNames });
      fetchedAt = new Date(now()).toISOString();

      // Plugin enablement is part of the native client's configuration snapshot.
      // Refresh only this metadata client when those settings change. It owns
      // no threads, MCP connections, model turns or other Noted sessions.
      const nextSettingsKey = JSON.stringify(config.plugins || {});
      if (pluginSettingsKey !== null && pluginSettingsKey !== nextSettingsKey) {
        releaseClient();
        active = await getClient(scope);
      }
      pluginSettingsKey = nextSettingsKey;

      try {
        const installed = await active.request('plugin/installed', { cwds: scope ? [scope] : [] });
        if (!Array.isArray(installed?.marketplaces)) throw catalogError('invalid_catalog');
        if (installed.marketplaceLoadErrors?.length) code = 'plugins_unavailable';
        const jobs = [];
        for (const marketplace of installed.marketplaces) {
          if (!Array.isArray(marketplace.plugins)) throw catalogError('invalid_catalog');
          for (const summary of marketplace.plugins.filter(plugin => plugin.installed)) {
            jobs.push({ marketplace, summary });
          }
        }
        let nextJob = 0;
        const collected = await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
          const rows = [];
          while (nextJob < jobs.length) {
            const { marketplace, summary } = jobs[nextJob++];
            try {
              const key = JSON.stringify([scope, summary.id, marketplace.path || marketplace.name,
                summary.version, summary.localVersion, summary.installedAt]);
              const cached = pluginCache.get(key);
              let names = cached?.names;
              if (!cached || now() - cached.checkedAt >= pluginTtlMs) {
                const detail = await active.request('plugin/read', {
                  pluginName: summary.name,
                  marketplacePath: marketplace.path || null,
                  ...(!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}),
                });
                // Cache only server names, not skill bodies or credentials.
                pluginServers(detail, summary, config);
                names = detail.plugin.mcpServers;
                pluginCache.set(key, { names, checkedAt: now() });
                while (pluginCache.size > 128) pluginCache.delete(pluginCache.keys().next().value);
              }
              rows.push(...pluginServers({ plugin: { mcpServers: names } }, summary, config));
            } catch {
              code = 'plugins_unavailable';
              rows.push(...(previous?.servers || []).filter(row => row.pluginId === summary.id));
            }
          }
          return rows;
        }));
        servers.push(...collected.flat());
        if (installed.marketplaceLoadErrors?.length) {
          const currentIds = new Set(servers.map(row => row.id));
          servers.push(...(previous?.servers || []).filter(row => row.source === 'plugin' && !currentIds.has(row.id)));
        }
      } catch (error) {
        code = error?.code === -32601 ? 'plugins_unsupported' : 'plugins_unavailable';
        servers.push(...(previous?.servers || []).filter(row => row.source === 'plugin'));
      }
    } catch (error) {
      code = errorCode(error);
      releaseClient();
    }
    clearTimeout(deadline);
    if (deadlineExpired) code = 'timeout';
    const snapshot = {
      servers: [...new Map(servers.map(row => [row.id, row])).values()]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      fetchedAt,
      stale: code !== null,
      error: code,
    };
    log('[McpCatalog] read result=' + (code || 'ok') + ' rows=' + snapshot.servers.length
      + ' elapsedMs=' + Math.max(0, now() - started));
    return snapshot;
  }

  function read({ cwd = null } = {}) {
    const scope = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : '';
    const cached = cache.get(scope);
    if (cached && now() - cached.checkedAt < ttlMs) return Promise.resolve(cached.snapshot);
    if (inflight.has(scope)) return inflight.get(scope);
    const pending = queue.then(() => load(scope, cached?.snapshot)).then(snapshot => {
      cache.delete(scope);
      cache.set(scope, { checkedAt: now(), snapshot });
      while (cache.size > 16) cache.delete(cache.keys().next().value);
      return snapshot;
    }).finally(() => {
      inflight.delete(scope);
      if (!inflight.size && !disposed) {
        idleTimer = setTimeout(releaseClient, idleMs);
        idleTimer.unref?.();
      }
    });
    inflight.set(scope, pending);
    queue = pending.catch(() => {});
    return pending;
  }

  return { read, close() { disposed = true; releaseClient(); cache.clear(); pluginCache.clear(); } };
}

module.exports = { createCodexMcpCatalogReader, configServers, pluginServers };
