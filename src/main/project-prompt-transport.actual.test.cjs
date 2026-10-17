'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
test('THREE actual IPC reads await and preserve async errors; Settings and CAS remain synchronous', async () => {
  const handlers = new Map(), filename = path.join(__dirname, 'ipc/project-prompts.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename)); const old = m.require.bind(m);
  m.require = id => id === 'electron' ? { ipcMain: { handle: (k, f) => handlers.set(k, f), removeHandler: k => handlers.delete(k) }, BrowserWindow: { getAllWindows: () => [] } } : old(id);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  const receipt = { mutationId: 'm', revision: 2 }, service = { getSources: () => [], getTabSources: () => [], setSources: () => receipt, setTabSources: () => receipt,
    listTab: async () => ({ prompts: [] }), listProject: async () => ({ prompts: [] }), usageForRoot: async () => [] };
  const cleanup = m.exports.register({ service });
  for (const [key, method] of [['list-tab', 'listTab'], ['list', 'listProject'], ['usage-for-root', 'usageForRoot']]) {
    const result = await handlers.get('project-prompts:' + key)({}, 'target'); assert.equal(result.success, true); assert.ok(!(result.data instanceof Promise));
    service[method] = async () => { throw Object.assign(Error('prompt_catalog_preparing'), { code: 'prompt_catalog_preparing' }); };
    assert.equal((await handlers.get('project-prompts:' + key)({}, 'target')).code, 'prompt_catalog_preparing');
  }
  assert.equal(handlers.get('project-prompts:set-tab-sources')({}, receipt).data, receipt);
  assert.ok(!(handlers.get('project-prompts:get-tab-sources')({}, 'target') instanceof Promise)); cleanup(); assert.equal(handlers.size, 0);
});
test('exact actual HTTP GET awaits usage and preserves status/code, uses async causal run rather than syncWork', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), start = source.indexOf("  if (parsed.pathname === '/api/project-prompt-usage'");
  const end = source.indexOf('\n  // Rename a project.', start); assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const run = new AsyncFunction('req', 'res', 'parsed', 'projectPromptCatalog', 'cleanOptionalString', 'path', 'perfCausal', 'sendJson', source.slice(start, end));
  const rows = [{ path: '/fixture.prompt.md', projects: [] }], request = { method: 'GET' }, parsed = { pathname: '/api/project-prompt-usage', query: { root: '/fixture' } };
  const perf = { async run(_name, _fields, work) { return await work(); }, syncWork() { throw Error('async lifetime syncWork'); } };
  const send = (_res, status, body) => ({ status, body });
  const call = service => run(request, {}, parsed, service, x => x, path, perf, send);
  const result = await call({ usageForRoot: async () => rows }); assert.equal(result.status, 200); assert.equal(result.body.usages, rows);
  for (const [code, status] of [['prompt_catalog_preparing', 503], ['prompt_catalog_changed', 409], ['prompt_catalog_failed', 503], ['root_binding_forward_version', 409]]) {
    const result = await call({ usageForRoot: async () => { throw Object.assign(Error(code), { code, statusCode: status }); } });
    assert.equal(result.status, status); assert.equal(result.body.ok, false); assert.equal(result.body.code, code);
  }
});
