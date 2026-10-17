'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ProjectPromptCatalogService } = require('./project-prompt-catalog');
const { observeCommittedPromptLayouts } = require('./prompt-catalog-layout-commits');
const support = require('./project-prompt-catalog.test-support.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('actual store commit→prepared catalog→awaited IPC→UI wake reorders only its configured source', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-layout-integration-')));
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  for (const root of [a, b]) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    for (const name of ['a', 'z']) fs.writeFileSync(path.join(root, 'docs', name + '.prompt.md'), 'own tiny fixture');
  }
  const row = root => ({ id: root, rootId: root, rootPath: root, projectId: 'N', enabled: true });
  const registry = { sourcesForTab: id => [row(id === 'T' ? a : b)],
    createSourcesReader: () => id => registry.sourcesForTab(id),
    listSourceScopes: () => [{ id: 'tab:T', tabId: 'T' }, { id: 'tab:B', tabId: 'B' }],
    read: () => ({ version: 1, revision: 1, roots: [] }) };
  const db = { getProjectById: () => ({ id: 'N', name: 'N' }) };
  const layouts = new Map(), empty = { orderByParent: {}, visualParentByPath: {} };
  const store = { get: root => layouts.get(root) || { revision: 0, layout: empty },
    put(root, layout) { const value = { revision: this.get(root).revision + 1, layout };
      layouts.set(root, value); return { ok: true, ...value }; } };
  const opened = new Map();
  const asyncFs = { ...fs.promises, opendir: async root => {
    opened.set(root, (opened.get(root) || 0) + 1); return fs.promises.opendir(root);
  } };
  const ipc = new EventEmitter(), handlers = new Map();
  const service = new ProjectPromptCatalogService({ db, rootRegistry: registry, layoutStore: store,
    asyncFs, watch: false, authorityFence: support.controlledFence(db),
    onChanged: change => ipc.emit('project-prompts:changed', {}, change) });
  let observation, observer;
  t.after(() => { observation?.close(); observer?.close(); service.close(); fs.rmSync(base, { recursive: true, force: true }); });
  await support.tab(service, 'T'); await support.tab(service, 'B');
  const ipcModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'ipc/project-prompts.js'), 'utf8'), {
    module: ipcModule, exports: ipcModule.exports,
    require: () => ({ ipcMain: { handle: (key, callback) => handlers.set(key, callback), removeHandler: key => handlers.delete(key) },
      BrowserWindow: { getAllWindows: () => [] } }),
  });
  const unregister = ipcModule.exports.register({ service }); t.after(unregister);
  ipc.invoke = async (key, ...args) => { await tick(); return handlers.get(key)({}, ...args); };
  const ui = await import('../renderer/components/Workspace/promptTabSourcesModel.mjs');
  const states = []; let resolveReady;
  let ready = new Promise(resolve => { resolveReady = resolve; });
  observation = ui.observePreparedPromptCatalog({ ipc, targetKey: 'captured-T',
    read: () => ui.loadPickerPromptCatalog(ipc, { tabId: 'T', organizationReady: true }),
    acceptsChange: change => ui.promptCatalogChangeAffectsTarget(change, { tabId: 'T', organizationReady: true }),
    isCurrent: () => true, onState: state => { states.push(state); if (state.status === 'ready') resolveReady(state); } });
  const initial = await ready;
  assert.deepEqual(initial.data.prompts.map(p => p.title), ['a', 'z']);
  const other = service.prepared.slots.get(b), otherEpoch = other.epoch, otherSnapshot = other.snapshot;
  const otherReads = opened.get(path.join(b, 'docs'));
  observer = observeCommittedPromptLayouts(store, root => service.onLayoutCommitted(root));
  ready = new Promise(resolve => { resolveReady = resolve; });
  const committed = store.put(a, { orderByParent: { [path.join(a, 'docs')]:
    [path.join(a, 'docs/z.prompt.md'), path.join(a, 'docs/a.prompt.md')] }, visualParentByPath: {} });
  assert.equal(committed.ok, true);
  assert.equal(observation.receiver.canSelect(initial.sequence), false);
  assert.equal(other.epoch, otherEpoch); assert.equal(other.snapshot, otherSnapshot);
  const updated = await ready;
  assert.deepEqual(updated.data.prompts.map(p => p.title), ['z', 'a']);
  assert.ok(states.some(state => state.status === 'stale'));
  assert.equal(opened.get(path.join(b, 'docs')), otherReads);
  const beforeWarm = [...opened.values()].reduce((sum, n) => sum + n, 0);
  const warm = await ui.loadPickerPromptCatalog(ipc, { tabId: 'T', organizationReady: true });
  assert.deepEqual(warm.prompts.map(p => p.id), updated.data.prompts.map(p => p.id));
  assert.equal([...opened.values()].reduce((sum, n) => sum + n, 0), beforeWarm);
});
