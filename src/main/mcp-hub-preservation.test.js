'use strict';

// Adapted from the single Astra Pro return. SOURCE_ROOT selects the immutable
// pre-patch inputs for behavioural RED controls, not a replacement implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const sourceRoot = process.env.MCP_HUB_SOURCE_ROOT || path.resolve(__dirname, '../..');
const sourceRequire = createRequire(path.join(sourceRoot, 'src/main/mcp-hub.js'));
const { McpHub } = sourceRequire('./mcp-hub');
const { createMcpHubController } = sourceRequire('./mcp-hub-controller');
const NAMES = ['terminal', 'knowledge', 'browser', 'electron', 'ios', 'sc-desktop'];
const STUB = `const rl=require('readline').createInterface({input:process.stdin});
console.error(process.env.TOKEN || 'stub');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
const result=m.method==='initialize'?{serverInfo:{name:'stub'},capabilities:{tools:{}}}:
m.method==='tools/list'?{tools:[{name:'stub_tool'}]}:{token:process.env.TOKEN,
setting:process.env.NOTED_SERVICE_OPTION,identity:process.env.NOTED_PARENT_TAB_ID,launchPin:process.env.NOTED_MCP_EXPECTED_CONFIGURATION,admin:process.env.ANTHROPIC_ADMIN_API_KEY,meta:m.params?._meta};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.noted-terminal/mcp-hub.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = path.join(home, 'stub.cjs'); fs.writeFileSync(script, STUB);
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  const disabled = Object.fromEntries(NAMES.map(name => [name, { enabled: false }]));
  const binding = extra => ({ enabled: true, command: process.execPath, args: [script],
    stateful: false, env: {}, ...extra });
  const write = servers => fs.writeFileSync(file, JSON.stringify({ version: 1, servers }), { mode: 0o600 });
  return { home, file, script, env, disabled, binding, write };
}
const resolve = f => sourceRequire('./mcp-hub-config').resolveHubConfiguration(f.env);
const entry = (config, name) => config.status.entries.find(row => row.name === name);
const request = async (hub, name, method) => (await fetch(`http://127.0.0.1:${hub.actualPort}/mcp/${name}?tab=caller`, {
  method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
})).json();

test('integration: portable update preserves exact six bindings from a persistent profile', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.home, '.claude/mcp'), { recursive: true });
  for (const name of NAMES.slice(0, 2)) fs.copyFileSync(f.script, path.join(f.home, '.claude/mcp', name + '-server.mjs'));
  const servers = Object.fromEntries(NAMES.map(name => [name, f.binding({ args: [f.script, '--configured-' + name],
    env: { TOKEN: 'private-config-value' }, stateful: name === 'ios', reapMarker: f.script })]));
  f.write(servers);
  const run = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(sourceRequire.resolve('./mcp-hub'))}).defaultServerDefs()))`],
    { env: f.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const actual = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(actual).sort(), [...NAMES].sort());
  for (const name of NAMES) { const { enabled, ...expected } = servers[name]; assert.deepEqual(actual[name], expected); }
});

test('integration: shared child identity and credentials never enter status or logs', async t => {
  const f = fixture(t), logs = [];
  const hub = new McpHub({ port: 0, log: line => logs.push(line), env: { ...f.env, TOKEN: 'inherited-token' },
    serverDefs: { browser: f.binding({ args: [f.script, 'argv-private-token'], env: {
      TOKEN: 'configured-token', NOTED_SERVICE_OPTION: 'kept', NOTED_PARENT_TAB_ID: 'wrong-tab',
      NOTED_MCP_EXPECTED_CONFIGURATION: 'wrong-pin', ANTHROPIC_ADMIN_API_KEY: 'admin-secret' } }) } });
  hub.reapOrphanedChildren = () => {};
  await hub.start({ eager: false });
  try {
    const response = await request(hub, 'browser', 'tools/call');
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.result.token, 'configured-token'); assert.equal(response.result.setting, 'kept');
    assert.equal(response.result.identity, undefined); assert.equal(response.result.admin, undefined);
    assert.equal(response.result.launchPin, undefined);
    assert.equal(response.result.meta.noted.tabId, 'caller');
    assert.doesNotMatch(JSON.stringify({ status: hub.status(), logs }), /configured-token|argv-private-token|wrong-tab|admin-secret/);
  } finally { await hub.stop(); }
});

test('integration: busy legacy hub is not replaced even by upgrade ensure', async t => {
  let writes = 0, spawns = 0;
  const legacy = http.createServer((req, res) => {
    if (req.url === '/mcp/_status') res.end(JSON.stringify({ pid: 999, servers: [
      { name: 'browser', up: true, initialized: true, pendingRequests: 1, recovering: false }] }));
    else { writes++; res.end('{"ok":true}'); setImmediate(() => { legacy.close(); legacy.closeAllConnections(); }); }
  });
  await new Promise(done => legacy.listen(0, '127.0.0.1', done));
  t.after(() => { legacy.closeAllConnections(); legacy.close(); });
  const controller = createMcpHubController({ port: legacy.address().port, startupTimeoutMs: 200, log() {},
    readConfiguration: () => ({ serverDefs: { browser: {} }, status: {}, fingerprint: 'test', canLaunch: true }),
    spawnImpl() { spawns++; throw new Error('must not spawn'); } });
  assert.equal((await controller.ensure({ upgrade: true })).pid, 999);
  assert.equal(writes, 0); assert.equal(spawns, 0);
});

test('integration: native hub URL identifies a route even when executable is unknown', () => {
  const { configServers } = sourceRequire('./codex-mcp-catalog');
  const rows = configServers({ mcp_servers: {
    alias: { url: 'http://127.0.0.1:53133/mcp/browser?secret=TOKEN' },
    remote: { url: 'https://example.test/mcp', http_headers: { Authorization: 'TOKEN' } } } });
  assert.equal(rows[0].hubServer, 'browser'); assert.equal(rows[1].hubServer, null);
  assert.doesNotMatch(JSON.stringify(rows), /TOKEN|http_headers/);
});

test('profile: fresh home has no optional processes; explicit disable wins over ENV', t => {
  const f = fixture(t), fresh = resolve(f);
  assert.deepEqual(fresh.serverDefs, {}); assert.equal(entry(fresh, 'browser').state, 'unconfigured');
  assert.equal(entry(fresh, 'terminal').state, 'not_installed');
  f.write(f.disabled); f.env.NOTED_BROWSER_MCP_PATH = f.script;
  const disabled = resolve(f); assert.deepEqual(disabled.serverDefs, {});
  assert.equal(disabled.status.needsReview, false); assert.equal(entry(disabled, 'browser').state, 'disabled');
});

test('profile: explicit ENV overrides defaults; invalid explicit path is not an absent optional', t => {
  const f = fixture(t); f.env.NOTED_TERMINAL_MCP_PATH = f.script;
  f.env.NOTED_BROWSER_MCP_PATH = path.join(f.home, 'missing.cjs');
  let config = resolve(f); assert.deepEqual(config.serverDefs.terminal.args, [f.script]);
  assert.equal(entry(config, 'browser').error, 'path_invalid');
  f.env.NOTED_BROWSER_MCP_PATH = f.script; config = resolve(f);
  assert.deepEqual(config.serverDefs.browser.args, [f.script]); assert.equal(config.serverDefs.browser.stateful, false);
  f.env.NOTED_BROWSER_MCP_PATH = ''; assert.equal(entry(resolve(f), 'browser').error, 'path_invalid');
});

test('preserving: a partial profile must not delete another explicitly configured ENV binding', t => {
  const f = fixture(t); f.env.NOTED_BROWSER_MCP_PATH = f.script;
  f.write({ 'sc-desktop': f.binding({ reapMarker: f.script, stateful: true }) });
  assert.equal(entry(resolve(f), 'browser').state, 'configured');
  assert.deepEqual(resolve(f).serverDefs.browser.args, [f.script]);
  f.write({ ...f.disabled, browser: f.binding({ command: 'node' }) });
  assert.equal(entry(resolve(f), 'browser').state, 'configured');
  f.env.NOTED_BROWSER_MCP_PATH = path.join(f.home, 'different.cjs');
  assert.equal(entry(resolve(f), 'browser').error, 'override_conflict');
  assert.equal(resolve(f).serverDefs.browser, undefined);
});

test('profile: malformed, oversized, unreadable and changed snapshots fail without writes/fallback', t => {
  const f = fixture(t); f.env.NOTED_BROWSER_MCP_PATH = f.script;
  for (const bytes of ['{', '{"version":2,"servers":{}}', '{"version":1,"servers":{"arbitrary":{}}}', ' '.repeat(65537)]) {
    fs.writeFileSync(f.file, bytes); fs.chmodSync(f.file, 0o640);
    const config = resolve(f); assert.equal(config.canLaunch, false); assert.equal(config.status.error, 'profile_invalid');
    assert.deepEqual(config.serverDefs, {}); assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  }
  const { resolveHubConfiguration } = sourceRequire('./mcp-hub-config');
  const unreadable = resolveHubConfiguration(f.env, { io: { ...fs, openSync() { throw Object.assign(new Error('SECRET'), { code: 'EACCES' }); } } });
  assert.equal(unreadable.status.error, 'profile_unreadable'); assert.doesNotMatch(JSON.stringify(unreadable.status), /SECRET/);
  f.write(f.disabled); let replaced = false;
  const changed = resolveHubConfiguration(f.env, { io: { ...fs, readSync(...args) {
    const count = fs.readSync(...args);
    if (!replaced) { replaced = true; fs.writeFileSync(f.file + '.next', fs.readFileSync(f.file)); fs.renameSync(f.file + '.next', f.file); }
    return count;
  } } });
  assert.equal(changed.status.error, 'profile_changed'); assert.equal(changed.canLaunch, false);
});

test('profile: invalid entry is visible, healthy bindings survive, retry/rollback are idempotent', t => {
  const f = fixture(t);
  f.write({ ...f.disabled, browser: f.binding(), ios: f.binding({ command: 'node', args: [path.join(f.home, 'missing')] }),
    electron: { enabled: true, type: 'http', url: 'http://example.test/TOKEN' } });
  const first = resolve(f), bytes = fs.readFileSync(f.file);
  assert.ok(first.serverDefs.browser); assert.equal(entry(first, 'ios').error, 'path_invalid');
  assert.equal(entry(first, 'electron').error, 'entry_invalid'); assert.equal(first.fingerprint, resolve(f).fingerprint);
  f.write(f.disabled); assert.notEqual(first.fingerprint, resolve(f).fingerprint);
  fs.writeFileSync(f.file, bytes); assert.equal(first.fingerprint, resolve(f).fingerprint);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.doesNotMatch(JSON.stringify(first.status), /TOKEN|command|args|env|http:/);
});

test('preserving: an orphan marker cannot name a directory or a missing file', t => {
  const f = fixture(t);
  for (const reapMarker of [f.home, path.join(f.home, 'missing-marker')]) {
    f.write({ ...f.disabled, browser: f.binding({ reapMarker }) });
    assert.equal(entry(resolve(f), 'browser').error, 'path_invalid');
  }
});

test('profile: installer preserves HTTP registrations, profile bytes and permissions', async t => {
  const f = fixture(t);
  const { installTerminalMcp } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/install-terminal-mcp.mjs')).href);
  const sourceDir = path.join(f.home, 'source'); fs.mkdirSync(sourceDir);
  for (const file of ['terminal-server.mjs', 'terminal-start-ai-request.mjs', 'terminal-prompt-catalog.mjs']) fs.writeFileSync(path.join(sourceDir, file), '// synthetic runtime\n');
  fs.mkdirSync(path.join(f.home, '.codex')); f.write({ ...f.disabled, browser: f.binding() });
  const claude = path.join(f.home, '.claude.json'), codex = path.join(f.home, '.codex/config.toml');
  fs.writeFileSync(claude, JSON.stringify({ mcpServers: { terminal: { type: 'http', url: 'http://localhost:53133/mcp/terminal' },
    browser: { type: 'http', url: 'http://localhost:53133/mcp/browser' }, other: { command: 'keep', args: ['TOKEN'] } } }));
  fs.writeFileSync(codex, '[mcp_servers.terminal]\nurl = "http://localhost:53133/mcp/terminal"\nenabled = false\n\n[mcp_servers.other]\ncommand = "keep"\n');
  const paths = [f.file, claude, codex]; paths.forEach(file => fs.chmodSync(file, 0o640));
  const before = paths.map(file => fs.readFileSync(file));
  const first = await installTerminalMcp({ home: f.home, sourceDir });
  const again = await installTerminalMcp({ home: f.home, sourceDir });
  assert.equal(first.changed.runtime, true); assert.equal(again.changed.runtime, false);
  assert.equal(first.changed.claude, false); assert.equal(first.changed.codex, false);
  paths.forEach((file, i) => { assert.deepEqual(fs.readFileSync(file), before[i]); assert.equal(fs.statSync(file).mode & 0o777, 0o640); });
});

async function detached(t, f, beforeSpawn = () => {}) {
  const reservation = http.createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const children = [];
  const make = extra => createMcpHubController({ port, script: sourceRequire.resolve('./mcp-hub'), env: f.env,
    executable: process.execPath, log() {}, spawnImpl(...args) { beforeSpawn(); const child = spawn(...args); children.push(child); return child; }, ...extra });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.ref(); const exited = new Promise(done => child.once('exit', done));
      await fetch(`http://127.0.0.1:${port}/mcp/_shutdown?pid=${child.pid}`, { method: 'POST' })
        .catch(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
      await exited;
    }
  });
  return { port, children, make };
}

test('profile: detached launch/reopen, drift, observation and rollback share one generation', async t => {
  const f = fixture(t); f.write({ ...f.disabled, browser: f.binding({ env: { TOKEN: 'first-secret' } }) });
  const bytes = fs.readFileSync(f.file), d = await detached(t, f), controller = d.make();
  const [first, coalesced] = await Promise.all([controller.ensure(), controller.ensure()]);
  assert.equal(first.pid, coalesced.pid); assert.equal(first.configurationApplied, true);
  assert.equal((await request({ actualPort: d.port }, 'browser', 'tools/list')).result.tools[0].name, 'stub_tool');
  assert.equal((await d.make().ensure()).pid, first.pid);
  f.write({ ...f.disabled, browser: f.binding({ env: { TOKEN: 'second-secret' } }) });
  const changed = await controller.ensure(); assert.equal(changed.pid, first.pid); assert.equal(changed.configurationApplied, false);
  assert.equal(changed.servers[0].restarts, 0);
  const observer = d.make({ canSpawn: false }); assert.equal((await observer.ensure()).configurationApplied, false);
  assert.equal((await observer.restart()).ok, false);
  assert.equal((await controller.restart('browser')).configurationApplied, false);
  fs.writeFileSync(f.file, '{'); assert.equal((await controller.ensure()).pid, first.pid);
  assert.equal((await controller.status()).desiredConfiguration.error, 'profile_invalid');
  fs.writeFileSync(f.file, bytes); const restored = await controller.status();
  assert.equal(restored.configurationApplied, true); assert.equal(d.children.length, 1);
  assert.doesNotMatch(JSON.stringify(restored), /first-secret|second-secret|fingerprint|"command"|"env"|"args"/);
  const publicStatus = await (await fetch(`http://127.0.0.1:${d.port}/mcp/_status`)).json();
  assert.equal(publicStatus.configurationMatches, false);
  assert.doesNotMatch(JSON.stringify(publicStatus), /secret|fingerprint|"command"|"env"|"args"/);
});

test('preserving: replacing the desired profile before launch cannot execute the replacement', async t => {
  const f = fixture(t); f.write(f.disabled);
  const d = await detached(t, f, () => f.write({ ...f.disabled, browser: f.binding() }));
  const controller = d.make();
  await assert.rejects(controller.ensure(), /profile_changed_before_launch/);
  assert.equal(await controller.status(), null, 'changed binding never acquires the listener or starts children');
  assert.equal(d.children.length, 1);
});

test('profile: bad cold config refuses spawn; correction allows retry; observer stays read-only', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{'); const d = await detached(t, f), controller = d.make();
  await assert.rejects(controller.ensure(), /profile_invalid/); assert.equal(d.children.length, 0);
  assert.equal(await d.make({ canSpawn: false }).ensure(), null);
  f.write(f.disabled); assert.equal((await controller.ensure()).configurationApplied, true); assert.equal(d.children.length, 1);
});

test('integration: catalog timeout cannot cancel an active tool call', async () => {
  const source = `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{
    const m=JSON.parse(line);const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    if(m.method==='initialize')reply({capabilities:{tools:{}}});
    if(m.method==='tools/call')setTimeout(()=>reply({ok:true}),120);});`;
  const hub = new McpHub({ port: 0, log() {}, catalogTimeoutMs: 20,
    serverDefs: { browser: { command: process.execPath, args: ['-e', source], env: {} } } });
  const child = hub.children.get('browser');
  try {
    await child.ensureStarted(); const pid = child.proc.pid;
    const call = child.request('tools/call', {}).then(value => ({ value }), error => ({ error }));
    await new Promise(done => setImmediate(done));
    await assert.rejects(child.requestCatalog('tools/list', {}), { code: 'MCP_REQUEST_TIMEOUT' });
    assert.deepEqual(await call, { value: { ok: true } }); assert.equal(child.proc.pid, pid); assert.equal(child.restarts, 0);
  } finally { await hub.stop(); }
});

test('integration: reaper uses explicit marker or node script, never generic argv', () => {
  const source = `const cp=require('child_process');
    cp.execFileSync=()=>Buffer.from('111 1 unrelated --stdio\\n222 1 node /owned/entry.js\\n333 1 electron /owned/sc.js\\n444 55 node /owned/entry.js\\n555 1 node /owned/entry.js.old\\n666 1 electron /owned/sc.js.backup\\n');
    const killed=[];process.kill=pid=>killed.push(pid);
    const {McpHub}=require(${JSON.stringify(sourceRequire.resolve('./mcp-hub'))});
    const hub=new McpHub({log(){},serverDefs:{browser:{command:'node',args:['/owned/entry.js','--stdio'],env:{}},
      'sc-desktop':{command:'/owned/wrapper',args:[],env:{},reapMarker:'/owned/sc.js'}}});
    hub.reapOrphanedChildren();process.stdout.write(JSON.stringify(killed));`;
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), [222, 333]);
});

test('profile: bare IPC readiness cannot attest desired config when status read fails', async () => {
  const { EventEmitter } = require('node:events');
  const controller = createMcpHubController({ port: 1, script: 'synthetic', env: {}, log() {},
    readConfiguration: () => ({ serverDefs: {}, status: { entries: [] }, fingerprint: 'pinned', canLaunch: true }),
    fetchImpl: async () => { throw new Error('synthetic unavailable status'); },
    spawnImpl() { const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      queueMicrotask(() => child.emit('message', { type: 'mcp-hub:ready', status: { pid: 123, servers: [], configurationMatches: true } })); return child; },
  });
  assert.equal((await controller.ensure()).configurationApplied, false);
});

test('actual Main status IPC reports unreadable desired config even without a listener', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(sourceRoot, 'src/main/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('mcp-hub:status'");
  const end = source.indexOf("  ipcMain.handle('mcp-hub:codex-catalog'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const desired = { error: 'profile_invalid', entries: [], needsReview: true };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    mcpHubStatus: async () => null, MCP_HUB_PORT: 53133,
    mcpHubController: { configuration: () => desired },
  });
  const result = await handler();
  assert.equal(result.down, true); assert.equal(result.configurationApplied, false);
  assert.strictEqual(result.desiredConfiguration, desired);
});
