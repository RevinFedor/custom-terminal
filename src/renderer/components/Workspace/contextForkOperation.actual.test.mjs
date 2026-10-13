import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real TabBar caller: the regression was a loader/claim after its
// first await, so testing an isolated busy-state helper would miss the bug.
const source = fs.readFileSync(new URL('./TabBar.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('TabBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleContextFork') {
    handler = node.initializer.getText(parsed);
  }
  ts.forEachChild(node, visit);
};
visit(parsed);
assert.ok(handler, 'actual Fork caller exists');
const compiled = ts.transpile(`const action = ${handler}; action;`, { target: ts.ScriptTarget.ES2022 });

function fixture({ resolveSource = async () => 'source-session', invoke = async () => ({ success: true, newSessionId: 'compact-session' }) } = {}) {
  const renderedTab = { id: 'source-tab', name: 'source', cwd: '/fixture', codexSessionId: 'source-session' };
  const liveTab = { ...renderedTab };
  const events = [];
  const store = {
    openProjects: new Map([['project', { tabs: new Map([[liveTab.id, liveTab]]) }]]),
    setTabPendingOperation(_project, _tab, label) {
      liveTab.pendingOperation = label || undefined;
      events.push({ type: 'label', label });
    },
    async createTabAfterCurrent(...args) { events.push({ type: 'create', args }); await resolveSource(); return 'child-tab'; },
  };
  const context = {
    contextMenu: { tabId: liveTab.id },
    workspace: { tabs: new Map([[liveTab.id, renderedTab]]), projectPath: '/fixture' },
    projectId: 'project', contextForkProvider: 'codex', contextForkSessionAvailable: true,
    useWorkspaceStore: { getState: () => store },
    tabContextSurface: () => ({ kind: 'pane', paneIndex: 1 }), renameHostRef: { current: {} },
    setContextMenu: () => events.push({ type: 'close-menu' }),
    resolveContextForkSessionId: async (...args) => { events.push({ type: 'proof' }); return resolveSource(...args); },
    placeContextCreatedTab: (...args) => events.push({ type: 'place', args }),
    showToast: (...args) => events.push({ type: 'toast', args }),
    ipcRenderer: { invoke }, console: { warn() {} },
  };
  return { action: vm.runInNewContext(compiled, context), liveTab, store, events };
}

test('first click allocates the child before history work and a second surface cannot duplicate the pending request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ resolveSource: () => gate });
  const pending = f.action(false);
  assert.equal(f.liveTab.pendingOperation, 'делается форк...');
  assert.equal(f.events[0].type, 'label');
  assert.equal(f.events.filter(event => event.type === 'proof').length, 0);
  await f.action(false);
  assert.equal(f.events.filter(event => event.type === 'proof').length, 0);
  assert.equal(f.events.filter(event => event.type === 'create').length, 1, 'claim precedes allocation, proof belongs to Main');
  release('source-session');
  await pending;
  const created = f.events.filter(event => event.type === 'create');
  assert.equal(created.length, 1);
  assert.equal(created[0].args[3].pendingAction.sessionId, 'source-session');
  assert.equal(created[0].args[3].pendingAction.contextFork.sourceTabId, 'source-tab');
  assert.equal(created[0].args[3].nameSetManually, false);
  assert.equal(created[0].args[3].codexSessionId, undefined, 'parent is not the target History identity');
  assert.equal(created[0].args[3].background, true, 'existing placement/focus contract is preserved');
  assert.equal(f.liveTab.pendingOperation, undefined);
  await f.action(false);
  assert.equal(f.events.filter(event => event.type === 'create').length, 2, 'a later independent Fork remains available');
});

test('allocation failure always releases the source label without a ready announcement', async () => {
  const f = fixture({ resolveSource: async () => { throw new Error('allocation failed'); } });
  await f.action(true);
  assert.equal(f.liveTab.pendingOperation, undefined);
  assert.equal(f.events.some(event => event.type === 'place'), false);
  assert.equal(f.events.filter(event => event.type === 'toast').length, 1);
});

test('compact copy is deferred to target launch; stale cleanup leaves a newer source label alone', async () => {
  const compact = fixture({ invoke: async () => { throw Error('copy must not precede target'); } });
  await compact.action(true);
  assert.equal(compact.liveTab.pendingOperation, undefined);
  assert.equal(compact.events.some(event => event.type === 'toast'), false);
  assert.equal(compact.events.find(event => event.type === 'create').args[3].pendingAction.contextFork.fromLatestCompact, true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ resolveSource: () => gate });
  const pending = f.action(false);
  f.liveTab.pendingOperation = 'another operation';
  release(null);
  await pending;
  assert.equal(f.liveTab.pendingOperation, 'another operation');
});
