const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexMcpCatalogReader, configServers, pluginServers } = require('./codex-mcp-catalog');

function harness() {
  let time = 1000;
  let config = { mcp_servers: { external: { url: 'https://example.test/mcp' } } };
  let installed = { marketplaces: [] };
  let detail = { plugin: { mcpServers: ['plugin_tool'] } };
  let failure = null;
  let gate = null;
  const methods = [];
  const clients = [];
  const reader = createCodexMcpCatalogReader({ now: () => time, log() {}, clientFactory: () => {
    const client = { closed: false, async start() {}, close() { this.closed = true; },
      async request(method, params) {
        methods.push({ method, params });
        if (gate) await gate;
        if (failure === method) throw new Error('private-secret-must-not-escape');
        if (method === 'config/read') return { config };
        if (method === 'plugin/installed') return installed;
        if (method === 'plugin/read') return detail;
        throw new Error('unexpected native request: ' + method);
      } };
    clients.push(client);
    return client;
  } });
  return { reader, clients, methods,
    advance(ms = 3000) { time += ms; },
    config(value) { config = value; }, installed(value) { installed = value; }, detail(value) { detail = value; },
    fail(method) { failure = method; }, block(promise) { gate = promise; },
  };
}

test('display DTO excludes credentials, command arguments, endpoint secrets and raw config', () => {
  const rows = configServers({ developer_instructions: 'private', mcp_servers: {
    remote: { url: 'https://user:password@example.test/private-token?api_key=SECRET#secret',
      http_headers: { Authorization: 'Bearer SECRET' }, env: { TOKEN: 'SECRET' } },
    local: { command: '/private/bin/my-mcp', args: ['--token', 'SECRET'], enabled: false },
    alias: { url: 'http://localhost:53133/mcp/terminal?token=SECRET' },
    other: { url: 'http://localhost:53134/mcp/terminal' },
  } });
  assert.equal(rows[0].address, 'https://example.test');
  assert.equal(rows[1].address, 'my-mcp');
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[2].hubServer, 'terminal');
  assert.equal(rows[3].hubServer, null);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /SECRET|password|private-token|developer_instructions|http_headers|args|env/);
});

test('plugin MCP uses native metadata and per-plugin/server enablement, without inventing connection state', () => {
  const rows = pluginServers({ plugin: { mcpServers: ['a', 'b'], secret: 'SECRET' } },
    { id: 'design@market', name: 'design', enabled: true },
    { plugins: { 'design@market': { mcp_servers: { b: { enabled: false } } } } });
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[0].source, 'plugin');
  assert.equal(rows[0].transport, 'plugin');
  assert.equal(rows[0].hubServer, null);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|connected|initialized/);
});

test('adding and removing servers updates the next snapshot without service-specific code', async () => {
  const h = harness();
  try {
    assert.deepEqual((await h.reader.read()).servers.map(s => s.name), ['external']);
    h.config({ mcp_servers: { replacement: { command: 'node' } } }); h.advance();
    assert.deepEqual((await h.reader.read()).servers.map(s => s.name), ['replacement']);
    h.config({ mcp_servers: {} }); h.advance();
    assert.deepEqual((await h.reader.read()).servers, []);
    assert.equal(h.clients.length, 1);
    assert.ok(h.methods.every(x => ['config/read', 'plugin/installed', 'plugin/read'].includes(x.method)),
      'discovery never initializes MCP connections, starts threads or calls tools');
  } finally { h.reader.close(); }
});

test('concurrent copies share one read and TTL; another cwd has its own snapshot', async () => {
  const h = harness(); let release;
  try {
    h.block(new Promise(resolve => { release = resolve; }));
    const first = h.reader.read({ cwd: '/repo-a' });
    const second = h.reader.read({ cwd: '/repo-a' });
    assert.equal(first, second);
    release(); await first;
    h.block(null);
    const calls = h.methods.length;
    await h.reader.read({ cwd: '/repo-a' });
    assert.equal(h.methods.length, calls);
    h.config({ mcp_servers: { b: { command: 'node' } } });
    const b = await h.reader.read({ cwd: '/repo-b' });
    assert.deepEqual(b.servers.map(s => s.name), ['b']);
    assert.equal(h.clients[0].closed, true, 'metadata client switches scope without touching agents');
    assert.equal((await h.reader.read({ cwd: '/repo-a' })).servers[0].name, 'external');
  } finally { h.reader.close(); }
});

test('configuration failure preserves last data for its scope and never returns secrets', async () => {
  const h = harness();
  try {
    await h.reader.read({ cwd: '/repo-a' });
    h.fail('config/read'); h.advance();
    const failed = await h.reader.read({ cwd: '/repo-a' });
    assert.equal(failed.servers[0].name, 'external');
    assert.equal(failed.stale, true);
    assert.equal(failed.error, 'catalog_unavailable');
    assert.doesNotMatch(JSON.stringify(failed), /private-secret/);
    assert.deepEqual((await h.reader.read({ cwd: '/repo-b' })).servers, [], 'another scope does not inherit old rows');
  } finally { h.reader.close(); }
});

test('plugin change, disablement and partial errors retain useful data while exposing an incomplete read', async () => {
  const h = harness();
  try {
    h.installed({ marketplaces: [{ name: 'market', path: '/market/marketplace.json',
      plugins: [{ installed: true, id: 'design@market', name: 'design', enabled: true }] }] });
    const first = await h.reader.read();
    assert.equal(first.servers.length, 2);
    h.config({ mcp_servers: {}, plugins: { 'design@market': { enabled: false } } }); h.advance();
    const disabled = await h.reader.read();
    assert.equal(disabled.servers[0].enabled, false);
    assert.equal(h.clients.length, 2, 'native plugin settings changes refresh only the metadata client');
    h.fail('plugin/read'); h.advance(31000);
    const failed = await h.reader.read();
    assert.equal(failed.error, 'plugins_unavailable');
    assert.equal(failed.servers[0].enabled, false);
    h.fail(null); h.installed({ marketplaces: [] }); h.advance();
    assert.deepEqual((await h.reader.read()).servers, [], 'uninstalled plugin rows disappear');
  } finally { h.reader.close(); }
});

test('whole-read deadline releases the owned metadata process instead of an indefinite spinner', async () => {
  let rejectRequest;
  let closed = false;
  const reader = createCodexMcpCatalogReader({ totalTimeoutMs: 15, idleMs: 20, log() {},
    clientFactory: () => ({ async start() {},
      request() { return new Promise((_resolve, reject) => { rejectRequest = reject; }); },
      close() { closed = true; rejectRequest?.(new Error('closed')); },
    }) });
  try {
    // Keep the event loop alive while the production deadline is unref'ed.
    const keepalive = setTimeout(() => {}, 100);
    const result = await reader.read(); clearTimeout(keepalive);
    assert.equal(result.error, 'timeout');
    assert.equal(closed, true);
  } finally { reader.close(); }
});
