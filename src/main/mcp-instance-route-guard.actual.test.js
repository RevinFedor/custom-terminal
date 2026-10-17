'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const guardedCallback = (source, start, end) => source.slice(source.indexOf(start) + start.length, source.indexOf(end, source.indexOf(start)));

for (const [surface, body] of [
  ['mcp', guardedCallback(main, 'mcpHttpServer = http.createServer(async (req, res) => {', '    // Resolve which project owns')],
  ['api', guardedCallback(web, 'httpServer = http.createServer((req, res) => {', '    const parsed = url.parse(req.url, true);')],
]) {
  test('actual ' + surface + ' ingress rejects replaced instance before dispatch, legacy remains accepted', async () => {
    assert.ok(body.includes('mcp_instance_route_changed'));
    for (const headers of [{}, { 'x-noted-main-pid': '7', 'x-noted-instance-id': 'expected' },
      { 'x-noted-main-pid': '8', 'x-noted-instance-id': 'expected' },
      { 'x-noted-main-pid': '7', 'x-noted-instance-id': 'replacement' }]) {
      let dispatches = 0, status;
      const ctx = vm.createContext({ process: { pid: 7 }, appRuntimeIdentity: { instanceId: 'expected' }, webServerInstanceId: 'expected',
        sendJson: (_res, code) => { status = code; }, dispatched: () => dispatches++ });
      const invoke = vm.runInContext('(async (req,res) => {' + body + '\ndispatched();})', ctx);
      await invoke({ headers }, { setHeader() {}, writeHead(code) { status = code; }, end() {} });
      const valid = !headers['x-noted-main-pid'] || headers['x-noted-main-pid'] === '7' && headers['x-noted-instance-id'] === 'expected';
      assert.equal(dispatches, valid ? 1 : 0); if (!valid) assert.equal(status, 409);
    }
  });
}

test('Main route producer contains only generation and discovery, and PTY/SDK use that same producer', () => {
  const start = main.indexOf('function mcpInstanceRouteIdentity()');
  const end = main.indexOf('\n}', start) + 2;
  const ctx = vm.createContext({ Buffer, MCP_PORT_DIR: '/private/fixture', appRuntimeIdentity: { instanceId: 'generation' } });
  const value = vm.runInContext(main.slice(start, end) + ';mcpInstanceRouteIdentity()', ctx);
  assert.deepEqual(JSON.parse(Buffer.from(value, 'base64url')), { version: 1, discoveryDir: '/private/fixture', instanceId: 'generation' });
  assert.match(main, /NOTED_MCP_INSTANCE_ROUTE: mcpInstanceRouteIdentity\(\)/);
  assert.match(main, /process\.pid \+ '\|' \+ mcpInstanceRouteIdentity\(\)/);
  assert.match(main, /'&instanceRoute=' \+ encodeURIComponent\(mcpInstanceRouteIdentity\(\)\)/);
});
