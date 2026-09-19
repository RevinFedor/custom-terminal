'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createMcpHubController } = require('./mcp-hub-controller');

const STUB = `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;const result=m.method==='initialize'?{serverInfo:{name:'stub'},capabilities:{tools:{}}}:{tools:[{name:'ready'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function fixture(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-controller-'));
  const script = path.join(dir, 'hub.cjs');
  fs.writeFileSync(script, `const {McpHub}=require(${JSON.stringify(require.resolve('./mcp-hub'))});
    const hub=new McpHub({port:${port},log(){},serverDefs:{stub:{command:'node',args:['-e',${JSON.stringify(STUB)}],env:{}}}});
    hub.start().then(()=>process.send({type:'mcp-hub:ready',status:{pid:process.pid,capabilities:{restartAll:true,launchEnvironment:1},...hub.status()}})).catch(error=>process.send({type:'mcp-hub:error',error:error.message},()=>process.exit(1)));
  `);
  const children = [];
  const make = overrides => createMcpHubController({ port, script, log() {}, executable: process.execPath,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    spawnImpl(...args) { const proc = spawn(...args); children.push(proc); return proc; }, ...overrides });
  return { make, children, async close() {
    for (const proc of children) {
      if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) continue;
      proc.ref(); // production detaches; the test owns and awaits this process
      const exited = new Promise(resolve => proc.once('exit', resolve));
      await fetch(`http://127.0.0.1:${port}/mcp/_shutdown`, { method: 'POST' }).catch(() => proc.kill('SIGTERM'));
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('controller: concurrent start and quick reopen reuse one detached hub; restart is ready', async () => {
  const f = fixture(await freePort());
  try {
    const controller = f.make();
    const [one, two] = await Promise.all([controller.ensure(), controller.ensure()]);
    assert.equal(one.pid, two.pid); assert.equal(f.children.length, 1);
    const reopened = f.make();
    assert.equal((await reopened.ensure()).pid, one.pid);
    const result = await reopened.restart();
    assert.equal(result.ok, true); assert.equal(result.servers[0].initialized, true);
    assert.equal(f.children.length, 1, 'app reopening and server restart do not duplicate the hub');
    const single = await reopened.restart('stub');
    assert.equal(single.ok, true); assert.equal(single.server.initialized, true);
  } finally { await f.close(); }
});

test('controller: legacy 0/6 ENOENT is repaired on ensure and old port closes before replacement', async () => {
  const legacy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp/_status') res.end(JSON.stringify({ version: '1.0.0', pid: 999,
      servers: [{ name: 'stub', up: false, initialized: false, pendingRequests: 0, lastError: 'spawn node ENOENT' }] }));
    else if (req.url.startsWith('/mcp/_shutdown')) {
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => { legacy.close(); legacy.closeAllConnections(); });
    }
  });
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  const f = fixture(legacy.address().port);
  try {
    const controller = f.make();
    const st = await controller.ensure();
    assert.notEqual(st.pid, 999);
    assert.equal(st.capabilities.launchEnvironment, 1);
    assert.equal((await controller.restart()).ok, true);
  } finally { legacy.closeAllConnections(); legacy.close(); await f.close(); }
});

test('controller: isolated E2E cannot spawn or replace the shared hub', async () => {
  const controller = createMcpHubController({ port: await freePort(), canSpawn: false,
    spawnImpl() { assert.fail('E2E must not spawn'); } });
  assert.equal(await controller.ensure(), null);
  assert.equal((await controller.restart()).ok, false);
});

test('controller: launch errors return an explicit failed restart', async () => {
  const f = fixture(await freePort());
  try {
    const result = await f.make({ executable: '/missing-mcp-runtime' }).restart();
    assert.equal(result.ok, false); assert.match(result.error, /ENOENT/);
  } finally { await f.close(); }
});

test('controller: Electron run-as-node starts the hub under minimal Finder environment', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture(await freePort());
  try {
    const controller = f.make({ executable: path.resolve(__dirname, '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') });
    const first = await controller.ensure();
    assert.ok(first.pid);
    assert.equal((await controller.restart('stub')).ok, true);
  } finally { await f.close(); }
});
