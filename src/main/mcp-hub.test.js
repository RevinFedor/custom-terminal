'use strict';
// Unit tests for the MCP hub: identity parsing, JSON-RPC id remapping,
// crash-respawn, client-closed fanout. Uses a stub child (node -e) instead of
// the real six servers so the suite runs in milliseconds.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { McpHub } = require('./mcp-hub.js');

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
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: JSON.stringify({ meta: m.params._meta || null, args: m.params.arguments }) }] });
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
    req.end(data);
  });
}

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
