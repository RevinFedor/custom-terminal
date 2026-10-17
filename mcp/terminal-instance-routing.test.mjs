import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import * as fs from 'node:fs';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const source = fs.readFileSync(process.env.TERMINAL_ROUTING_SOURCE || new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const executable = source.slice(0, source.lastIndexOf('// stdio transport')).replace(/^import .*;\n/gm, '');
function harness(t, onRequest = null) {
  const root = fs.mkdtempSync(join(tmpdir(), 'terminal-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = { host: join(root, 'home/.noted-terminal'), private: join(root, 'private') };
  const instances = Object.fromEntries(Object.entries(roots).map(([name, directory], index) => {
    fs.mkdirSync(directory, { recursive: true });
    const item = { directory, pid: 101 + index, mcpPort: 41001 + index * 2, webPort: 41002 + index * 2,
      instanceId: randomUUID(), webId: randomUUID() };
    fs.writeFileSync(join(directory, 'mcp-port-' + item.pid), JSON.stringify({ port: item.mcpPort,
      pid: item.pid, instanceId: item.instanceId, openProjectPaths: ['/same'], openProjects: [{ id: 'P', path: '/same', name }] }));
    fs.writeFileSync(join(directory, 'web-server-' + item.pid + '.json'), JSON.stringify({ port: item.webPort, pid: item.pid, instanceId: item.webId }));
    fs.writeFileSync(join(directory, 'web-token.txt'), name + '-token');
    return [name, item];
  }));
  const calls = [], dead = new Set();
  const context = vm.createContext({ ...fs, AsyncLocalStorage, Buffer, URL, URLSearchParams,
    basename, join, resolve, isAbsolute, promisify, execFile, randomUUID,
    homedir: () => join(root, 'home'), process: { env: {}, argv: ['node', 'terminal-server.mjs'],
      cwd: () => '/same', stderr: { write() {} }, kill(pid) { if (dead.has(pid)) throw Object.assign(Error('gone'), { code: 'ESRCH' }); } },
    fetch: async (url, options = {}) => {
      const u = new URL(url), owner = Object.entries(instances).find(([, i]) => [i.mcpPort, i.webPort].includes(Number(u.port)))?.[0];
      const call = { owner, url: u.pathname, port: Number(u.port), method: options.method || 'GET',
        headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call); if (onRequest) await onRequest(call, instances);
      const body = u.pathname === '/api/me' ? { capabilities: { tabInspection: { version: 1 }, tabMessages: { version: 1, replyTo: true, durable: true } } }
        : u.pathname === '/terminal/tabs' ? { tabs: [{ tabId: owner + '-tab', id: owner + '-tab', name: owner }] }
          : u.pathname === '/api/terminal-tabs/inspect' ? { version: 1, tabs: [{ tabId: owner + '-tab', exists: true }] }
            : u.pathname === '/api/tab-messages' ? { ok: true, accepted: true, messageId: owner + '-message', deliveryState: 'sent' }
              : { ok: true, owner };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  vm.runInContext(executable + '\nglobalThis.dispatch=handleRequest;', context);
  const identity = (name, legacy = false) => ({ tabId: name + '-tab', projectId: 'P', cwd: '/same', mainPid: String(instances[name].pid),
    ...(!legacy ? { instanceRoute: Buffer.from(JSON.stringify({ version: 1, discoveryDir: roots[name], instanceId: instances[name].instanceId })).toString('base64url') } : {}) });
  let id = 0;
  return { context, instances, calls, roots, dead, identity,
    call: async (name, args, caller) => JSON.parse(await context.dispatch({ id: ++id, method: 'tools/call', params: { name, arguments: args,
      ...(caller ? { _meta: { noted: caller } } : {}) } })).result };
}

test('actual dispatcher isolates concurrent private and legacy host calls including message source', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const h = harness(t, async call => { if (call.owner === 'private' && call.url === '/api/me') await gate; });
  const pending = h.call('inspect_tabs', { tabIds: ['private-tab'] }, h.identity('private'));
  const host = await h.call('inspect_tabs', { tabIds: ['host-tab'] }, h.identity('host', true));
  assert.equal(host.structuredContent.tabs[0].tabId, 'host-tab'); release();
  assert.equal((await pending).structuredContent.tabs[0].tabId, 'private-tab');
  const sent = await h.call('send_message', { tabId: 'private-receiver', text: 'question', requestId: 'one' }, h.identity('private'));
  assert.equal(sent.isError, undefined);
  const post = h.calls.find(c => c.method === 'POST');
  assert.equal(post.owner, 'private'); assert.equal(post.body.sourceTabId, 'private-tab');
  assert.equal(post.headers.Authorization, 'Bearer private-token');
  assert.equal(post.headers['x-noted-main-pid'], '102');
  assert.equal(post.headers['x-noted-instance-id'], h.instances.private.webId);
  const ctx = await h.call('current_context', {}, h.identity('private'));
  assert.equal(ctx.structuredContent.tabId, 'private-tab');
  assert.equal(ctx.structuredContent.tab.name, 'private');
  assert.ok(h.calls.some(c => c.owner === 'private' && c.port === h.instances.private.mcpPort));
});

for (const fault of ['missing-root', 'missing-mcp', 'missing-web', 'dead', 'replaced', 'cross-pid', 'invalid', 'legacy-missing-pid']) {
  test('explicit binding refuses without any host request: ' + fault, async t => {
    const h = harness(t), owner = h.identity('private'), p = h.instances.private;
    if (fault === 'missing-root') fs.rmSync(p.directory, { recursive: true });
    if (fault === 'missing-mcp') fs.unlinkSync(join(p.directory, 'mcp-port-' + p.pid));
    if (fault === 'missing-web') fs.unlinkSync(join(p.directory, 'web-server-' + p.pid + '.json'));
    if (fault === 'dead') h.dead.add(p.pid);
    if (fault === 'replaced' || fault === 'cross-pid') {
      const file = join(p.directory, 'mcp-port-' + p.pid), row = JSON.parse(fs.readFileSync(file));
      if (fault === 'replaced') row.instanceId = randomUUID(); else row.pid = 101;
      fs.writeFileSync(file, JSON.stringify(row));
    }
    if (fault === 'invalid') owner.instanceRoute = 'not-json';
    if (fault === 'legacy-missing-pid') delete owner.instanceRoute;
    const result = await h.call('send_message', { tabId: 'host-tab', text: 'never write', requestId: 'negative' }, owner);
    assert.equal(result.isError, true); assert.equal(h.calls.length, 0);
  });
}

test('a replacement between capability GET and mutation cannot change pinned route', async t => {
  const h = harness(t, (call, instances) => {
    if (call.url !== '/api/me') return;
    const p = instances.private, file = join(p.directory, 'web-server-' + p.pid + '.json');
    fs.writeFileSync(file, JSON.stringify({ port: instances.host.webPort, pid: p.pid, instanceId: randomUUID() }));
  });
  const r = await h.call('send_message', { tabId: 'receiver', text: 'never write', requestId: 'r' }, h.identity('private'));
  assert.equal(r.isError, true); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET');
});

test('anonymous callers retain ordinary global discovery, tool arguments cannot supply a route', async t => {
  const h = harness(t);
  const r = await h.call('inspect_tabs', { tabIds: ['host-tab'] });
  assert.equal(r.structuredContent.tabs[0].tabId, 'host-tab');
  const bad = await h.call('send_message', { tabId: 'host-tab', text: 'x', instanceRoute: h.identity('private').instanceRoute }, h.identity('host', true));
  assert.equal(bad.isError, undefined);
  const post = h.calls.find(c => c.method === 'POST');
  assert.equal(post.owner, 'host', 'unknown tool argument cannot override transport identity');
  assert.equal(post.body.instanceRoute, undefined);
});

test('direct stdio keeps its explicit environment route without shared request metadata', async t => {
  const h = harness(t);
  h.context.process.env.NOTED_MAIN_PID = '102';
  h.context.process.env.NOTED_MCP_INSTANCE_ROUTE = h.identity('private').instanceRoute;
  const result = await h.call('inspect_tabs', { tabIds: ['private-tab'] });
  assert.equal(result.structuredContent.tabs[0].tabId, 'private-tab');
  assert.ok(h.calls.every(c => c.owner === 'private'));
});
