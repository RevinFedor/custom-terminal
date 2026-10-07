const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('IPC routes exact-tab reads/CAS writes, exposes errors, and removes every owned handler', () => {
  const handlers = new Map();
  const sends = [];
  const oldLoad = Module._load;
  const file = require.resolve('./project-prompts');
  Module._load = function(name, ...args) {
    if (name === 'electron') return {
      ipcMain: { handle: (name, handler) => {
        assert.equal(handlers.has(name), false, 'channel must be registered once');
        handlers.set(name, handler);
      }, removeHandler: name => handlers.delete(name) },
      BrowserWindow: { getAllWindows: () => [
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } },
        { isDestroyed: () => true },
      ] },
    };
    return oldLoad.call(this, name, ...args);
  };
  let ipc;
  try { delete require.cache[file]; ipc = require(file); }
  finally { Module._load = oldLoad; delete require.cache[file]; }
  const calls = [];
  const service = Object.fromEntries(['listTab', 'getTabSources', 'setTabSources', 'getSources', 'setSources', 'listProject', 'usageForRoot']
    .map(method => [method, (...args) => { calls.push({ method, args }); return { method, args }; }]));
  const cleanup = ipc.register({ service });
  const request = { tabId: 'opaque:tab', rootIds: [], mutationId: 'same-request', expectedRevision: 8 };
  for (const [channel, argument, method] of [
    ['project-prompts:list-tab', 'opaque:tab', 'listTab'],
    ['project-prompts:get-tab-sources', 'opaque:tab', 'getTabSources'],
    ['project-prompts:set-tab-sources', request, 'setTabSources'],
    ['project-prompts:list', 'legacy', 'listProject'],
    ['project-prompts:get-sources', 'legacy', 'getSources'],
    ['project-prompts:usage-for-root', '/root', 'usageForRoot'],
  ]) {
    const result = handlers.get(channel)({}, argument);
    assert.equal(result.success, true);
    assert.equal(calls.at(-1).method, method);
    assert.equal(calls.at(-1).args[0], argument);
  }
  handlers.get('project-prompts:set-sources')({}, { projectId: 'legacy', roots: ['/root'] });
  assert.deepEqual(calls.at(-1), { method: 'setSources', args: ['legacy', ['/root']] });
  service.setTabSources = () => { throw Object.assign(new Error('root_revision_changed'), { code: 'root_revision_changed' }); };
  assert.deepEqual(handlers.get('project-prompts:set-tab-sources')({}, request), {
    success: false, error: 'root_revision_changed', code: 'root_revision_changed', paths: undefined,
  });
  const change = { tabIds: ['opaque:tab'], projectIds: [], reason: 'sources-changed' };
  ipc.broadcastProjectPromptsChanged(change);
  assert.deepEqual(sends, [['project-prompts:changed', change]]);
  assert.equal(handlers.size, 7);
  cleanup();
  assert.equal(handlers.size, 0);
});
