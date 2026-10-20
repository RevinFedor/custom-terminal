'use strict';
// Unit tests for the MCP hub: identity parsing, JSON-RPC id remapping,
// crash-respawn, client-closed fanout. Uses a stub child (node -e) instead of
// the real six servers so the suite runs in milliseconds.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpHub, canOwnGlobalHub, buildMcpEnvironment } = require('./mcp-hub.js');

// Minimal MCP server over stdio: replies to initialize/tools/list/tools/call,
// echoes params._meta back from tools/call so tests can see injected identity.
const STUB = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } });
  else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }] });
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: JSON.stringify({ meta: m.params._meta || null, args: m.params.arguments,
    inheritedRoute: process.env.NOTED_MCP_INSTANCE_ROUTE !== undefined, inheritedDiscovery: process.env.NOTED_DISCOVERY_DIR !== undefined }) }] });
  else if (m.method === 'noise') { process.stdout.write('diagnostic that is not JSON\\n'); reply({ ok: true }); }
  else if (m.method === 'boom') process.exit(7);
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }) + '\\n');
});
`;

function stubDefs() {
  return { stub: { command: process.execPath, args: ['-e', STUB], env: {}, stateful: true } };
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('test request timeout')));
    req.end(data);
  });
}

function stallOnceDefs(markerPath) {
  const source = `
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stall-once', version: '1' } });
  else if (m.method === 'tools/list' && !fs.existsSync(process.env.STALL_MARKER)) fs.writeFileSync(process.env.STALL_MARKER, 'stalled');
  else if (m.method === 'tools/list') reply({ tools: [{ name: 'recovered', inputSchema: { type: 'object' } }] });
});
`;
  return { stub: { command: process.execPath, args: ['-e', source], env: { STALL_MARKER: markerPath }, stateful: false } };
}

test('hub: isolated E2E instances cannot own the global port', () => {
  assert.equal(canOwnGlobalHub({ NOTED_E2E_TEST: 'true' }), false);
  assert.equal(canOwnGlobalHub({ NOTED_E2E_TEST: 'false' }), true);
  assert.equal(canOwnGlobalHub({}), true);
});

test('hub: Finder PATH starts node children and env-node wrappers without sharing session identity', async () => {
  const sourceEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NOTED_PARENT_TAB_ID: 'private',
    CLAUDE_PROJECT_DIR: '/private-project', ANTHROPIC_ADMIN_API_KEY: 'must-not-leak' };
  const defs = { direct: { command: 'node', args: ['-e', STUB], env: {} },
    wrapper: { command: '/usr/bin/env', args: ['node', '-e', STUB], env: {} } };
  const hub = new McpHub({ port: 0, log() {}, env: sourceEnv, serverDefs: defs });
  await hub.start({ eager: false });
  try {
    for (const name of Object.keys(defs)) {
      const response = await post(hub.actualPort, '/mcp/' + name, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(response.body.result.tools[0].name, 'echo');
    }
    assert.equal(buildMcpEnvironment(sourceEnv).ANTHROPIC_ADMIN_API_KEY, undefined);
    assert.equal(sourceEnv.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'do not rewrite parent environment');
  } finally { await hub.stop(); }
});

test('hub: overlapping all/individual restarts replace each child once and immediately serve requests', async () => {
  const defs = stubDefs(); defs.second = { ...defs.stub };
  const hub = new McpHub({ port: 0, log() {}, serverDefs: defs });
  await hub.start({ eager: false });
  try {
    await Promise.all([...hub.children.values()].map(c => c.ensureStarted()));
    const before = hub.status().servers.map(s => s.pid);
    const all = hub.restartAll();
    const [result, individual, again, call] = await Promise.all([all, hub.restartServer('stub'), hub.restartAll(),
      post(hub.actualPort, '/mcp/stub', { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })]);
    assert.equal(result.ok, true); assert.equal(again.ok, true); assert.equal(individual.initialized, true);
    assert.equal(call.body.result.tools[0].name, 'echo');
    hub.status().servers.forEach((s, i) => { assert.notEqual(s.pid, before[i]); assert.equal(s.restarts, 1); assert.equal(s.recovering, false); });
  } finally { await hub.stop(); }
});

test('hub: restart-all reports partial failure instead of a false success', async () => {
  const hub = new McpHub({ port: 0, log() {}, serverDefs: { ...stubDefs(), broken: { command: '/missing-node-for-test', args: [], env: {} } } });
  await hub.start({ eager: false });
  try {
    const response = await post(hub.actualPort, '/mcp/_restart-all', {});
    assert.equal(response.body.ok, false);
    assert.equal(response.body.servers.find(s => s.name === 'stub').initialized, true);
    assert.match(response.body.servers.find(s => s.name === 'broken').lastError, /ENOENT/);
    assert.equal(hub.children.get('broken').status().up, false);
  } finally { await hub.stop(); }
});

test('hub: losing a port race never reaps the existing hub children', async () => {
  const first = new McpHub({ port: 0, log() {}, serverDefs: stubDefs() });
  await first.start({ eager: false });
  const second = new McpHub({ port: first.actualPort, log() {}, serverDefs: stubDefs() });
  let reaped = false;
  second.reapOrphanedChildren = () => { reaped = true; };
  try { await assert.rejects(second.start(), { code: 'EADDRINUSE' }); assert.equal(reaped, false); }
  finally { await first.stop(); await second.stop(); }
});

test('hub: stale shutdown request cannot stop a newer owner of the same port', async () => {
  const hub = new McpHub({ port: 0, log() {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const response = await post(hub.actualPort, '/mcp/_shutdown?pid=' + (process.pid + 1), {});
    assert.equal(response.status, 409);
    const listed = await post(hub.actualPort, '/mcp/stub', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(listed.body.result.tools[0].name, 'echo');
  } finally { await hub.stop(); }
});

test('hub: initialize served from cache, tools/call forwards with identity meta', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const init = await post(hub.actualPort, '/mcp/stub', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'stub');

    const call = await post(hub.actualPort, '/mcp/stub?tab=T1&project=P1&cwd=/x', {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } },
    });
    assert.equal(call.status, 200);
    const payload = JSON.parse(call.body.result.content[0].text);
    assert.equal(payload.meta.noted.tabId, 'T1');
    assert.equal(payload.meta.noted.projectId, 'P1');
    assert.equal(payload.meta.noted.cwd, '/x');
    assert.deepEqual(payload.args, { a: 1 });
  } finally {
    await hub.stop();
  }
});

test('hub: bearer identity parsed, non-pipe token ignored', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const withPipe = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} },
    }, { authorization: 'Bearer T2|P2|/y|123' });
    const p1 = JSON.parse(withPipe.body.result.content[0].text);
    assert.equal(p1.meta.noted.tabId, 'T2');
    assert.equal(p1.meta.noted.mainPid, '123');

    const plain = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} },
    }, { authorization: 'Bearer sometoken' });
    const p2 = JSON.parse(plain.body.result.content[0].text);
    assert.equal(p2.meta.noted.tabId, '');
  } finally {
    await hub.stop();
  }
});

test('hub: opaque app instance route survives bearer/query transport, never shared child env', async () => {
  const hub = new McpHub({ port: 0, log() {}, env: { ...process.env,
    NOTED_MCP_INSTANCE_ROUTE: 'must-not-inherit', NOTED_DISCOVERY_DIR: '/private/not-shared' }, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    for (const query of [false, true]) {
      const route = Buffer.from(JSON.stringify({ version: 1, discoveryDir: '/private/fixture', instanceId: 'boot' })).toString('base64url');
      const result = await post(hub.actualPort, '/mcp/stub' + (query ? '?tab=T&mainPid=123&instanceRoute=' + route : ''),
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { noted: { instanceRoute: 'forged' } } } },
        query ? {} : { authorization: 'Bearer T|P|/fixture|123|' + route });
      const echoed = JSON.parse(result.body.result.content[0].text);
      assert.equal(echoed.meta.noted.instanceRoute, route);
      assert.equal(echoed.inheritedRoute, false);
      assert.equal(echoed.inheritedDiscovery, false);
    }
  } finally { await hub.stop(); }
});

test('hub: non-JSON child stdout does not poison later replies', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const noisy = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 31, method: 'noise', params: {},
    });
    assert.equal(noisy.body.result.ok, true);
    const listed = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 32, method: 'tools/list', params: {},
    });
    assert.equal(listed.body.result.tools[0].name, 'echo');
  } finally {
    await hub.stop();
  }
});

test('hub: stalled tools/list restarts one child and retries once', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.SC_OWN_HOST_FIXTURE_ROOT || os.tmpdir(), 'mcp-hub-stall-'));
  const markerPath = path.join(dir, 'stalled');
  const hub = new McpHub({
    port: 0,
    log: () => {},
    serverDefs: stallOnceDefs(markerPath),
    catalogTimeoutMs: 80,
  });
  await hub.start({ eager: false });
  try {
    const listed = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 33, method: 'tools/list', params: {},
    });
    assert.equal(listed.body.result.tools[0].name, 'recovered');
    assert.ok(hub.children.get('stub').status().restarts >= 1);
  } finally {
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub: stop is not pinned by an incomplete HTTP request', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  const socket = net.connect({ host: '127.0.0.1', port: hub.actualPort });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      'POST /mcp/stub HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\n'
      + 'Content-Type: application/json\r\n'
      + 'Content-Length: 100000\r\n'
      + 'Connection: keep-alive\r\n\r\n{',
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    const startedAt = Date.now();
    await hub.stop();
    assert.ok(Date.now() - startedAt < 1000, 'shutdown should force-close pinned HTTP connections');
  } finally {
    socket.destroy();
    await hub.stop();
  }
});

test('hub: unexpanded ${VAR} placeholders treated as empty', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const call = await post(hub.actualPort, '/mcp/stub?tab=' + encodeURIComponent('${NOTED_PARENT_TAB_ID:-}'), {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} },
    });
    const p = JSON.parse(call.body.result.content[0].text);
    assert.equal(p.meta.noted.tabId, '');
  } finally {
    await hub.stop();
  }
});

test('hub: child crash fails pending, next request respawns', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const child = hub.children.get('stub');
    await child.ensureStarted();
    const pid1 = child.proc.pid;
    child.proc.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 300));
    const call = await post(hub.actualPort, '/mcp/stub', {
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: {} },
    });
    assert.equal(call.status, 200);
    assert.ok(call.body.result, 'respawned child served the call: ' + JSON.stringify(call.body).slice(0, 200));
    assert.notEqual(child.proc.pid, pid1);
    assert.ok(child.restarts >= 1);
  } finally {
    await hub.stop();
  }
});

test('hub: unknown server 404, _status lists servers', async () => {
  const hub = new McpHub({ port: 0, log: () => {}, serverDefs: stubDefs() });
  await hub.start({ eager: false });
  try {
    const missing = await post(hub.actualPort, '/mcp/nope', { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
    assert.equal(missing.status, 404);
    const st = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: hub.actualPort, path: '/mcp/_status' }, (res) => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
      }).on('error', reject);
    });
    assert.equal(st.servers.length, 1);
    assert.equal(st.servers[0].name, 'stub');
  } finally {
    await hub.stop();
  }
});
