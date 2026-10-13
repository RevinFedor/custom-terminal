import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const focusJS = transpile(read('./tabPrimaryInputFocus.ts'));
const uiAST = ts.createSourceFile('useUIStore.ts', read('../store/useUIStore.ts'), ts.ScriptTarget.Latest, true);
const resolver = uiAST.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(decl => decl.name.getText(uiAST) === 'resolveTabTerminalPrimary'));
assert.ok(resolver, 'use the actual primary-surface resolver');
const uiExports = {};
vm.runInNewContext(transpile(resolver.getText(uiAST)), { exports: uiExports });

// Check the paired producer without mounting TerminalArea or any live provider.
const areaAST = ts.createSourceFile('TerminalArea.tsx', read('../components/Workspace/TerminalArea.tsx'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const producers = [];
const attribute = (node, name) => node.attributes.properties.find(prop => prop.name?.getText(areaAST) === name);
function visit(node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && attribute(node, 'data-terminal-pane-wrapper')) producers.push(node);
  ts.forEachChild(node, visit);
}
visit(areaAST);
const tabProducer = producers.filter(node => attribute(node, 'data-terminal-pane-wrapper')
  .initializer?.expression?.getText(areaAST) === 'tab.id');
assert.equal(tabProducer.length, 1);
const idExpression = attribute(tabProducer[0], 'id')?.initializer?.expression;
assert.ok(idExpression, 'the retained tab producer must supply its exact lookup ID');
const wrapperId = vm.runInNewContext(`tab => (${idExpression.getText(areaAST)})`);

function harness({ tabId = 'tab-a', onObserve } = {}) {
  const nodes = new Map(), lookups = [], events = [], observers = [];
  const body = { tagName: 'BODY', className: '', closest: () => null };
  const tab = { id: tabId, tabType: 'terminal', commandType: 'codex' };
  const workspace = { activeTabId: tabId, tabs: new Map([[tabId, tab]]) };
  const state = { view: 'workspace', activeProjectId: 'P', splitPanes: [], splitFocusedIndex: 0,
    openProjects: new Map([['P', workspace]]) };
  const ui = { activeArea: 'workspace', historyPanelOpenTabs: {}, terminalIsPrimaryTabs: {}, newTabPrimarySurface: 'history' };
  const document = { body, activeElement: body, documentElement: {},
    getElementById(id) { lookups.push(id); return nodes.get(id) ?? null; },
    querySelectorAll() { assert.fail('focus must not enumerate the retained DOM'); },
    querySelector() { assert.fail('focus must use the exact browser ID lookup'); },
  };
  class Observer {
    connected = false;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.connected = true; this.target = target; this.options = options; onObserve?.(h); }
    disconnect() { this.connected = false; }
  }
  const context = vm.createContext({
    document, MutationObserver: Observer, exports: {},
    console: { warn() {} }, performance: { timeOrigin: 100000, now: () => 10 },
    window: { dispatchEvent: event => events.push({ type: event.type, detail: { ...event.detail } }) },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    setTimeout() { assert.fail('focus must not wait for a timer'); },
    requestAnimationFrame() { assert.fail('focus must stay in the ready commit'); },
    require(name) {
      if (name.includes('useUIStore')) return { ...uiExports, useUIStore: { getState: () => ui } };
      if (name.includes('useWorkspaceStore')) return { useWorkspaceStore: { getState: () => state } };
      if (name.includes('ptyAgentOwner')) return { resolvePtyAgentOwner };
      if (name.includes('uiPerformanceDiagnostics')) return { uiPerformancePhase() {} };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  vm.runInContext(focusJS, context);
  const h = { nodes, lookups, events, observers, document, state, ui, tab, workspace,
    focus: context.exports.requestTabPrimaryInputFocus,
    focusWorkspace: context.exports.requestFocusedWorkspacePrimaryInput,
    mount(id = tabId, { presented = '1', isolated = '0', ariaHidden = null } = {}) {
      const node = { id: wrapperId({ id }), isConnected: true, ariaHidden,
        dataset: { terminalPaneWrapper: id, terminalSurfacePresented: presented, paneFocusIsolated: isolated },
        getAttribute(name) { assert.equal(name, 'aria-hidden'); return this.ariaHidden; },
      };
      nodes.set(node.id, node);
      return node;
    },
    wake() { for (const observer of observers) if (observer.connected) observer.callback([]); },
  };
  return h;
}

test('only nonempty retained tab wrappers produce stable exact IDs', () => {
  assert.equal(producers.length, 2, 'one tab wrapper and the empty placeholder');
  for (const producer of producers.filter(node => node !== tabProducer[0])) {
    assert.equal(attribute(producer, 'id'), undefined, 'empty placeholders have no focus lookup ID');
  }
  const ids = ['tab-a', 'tab-a:child', 'tab:[a]#"/\\é'];
  assert.equal(new Set(ids.map(id => wrapperId({ id }))).size, ids.length);
  for (const id of ids) {
    const h = harness({ tabId: id }); h.mount(); h.focus(id, 'exact-id');
    assert.equal(h.events.length, 1);
    assert.deepEqual(h.lookups, [wrapperId({ id })]);
  }
});

test('ready focus dispatches synchronously with one lookup regardless of unrelated retained nodes', () => {
  for (const count of [0, 512]) {
    const h = harness();
    for (let i = 0; i < count; i++) h.nodes.set(wrapperId({ id: `other-${i}` }), {
      get dataset() { assert.fail('unrelated retained wrapper was read'); },
    });
    h.mount(); h.focus('tab-a', 'workflow-strip-click');
    assert.equal(h.observers.length, 0);
    assert.deepEqual(h.lookups, [wrapperId({ id: 'tab-a' })]);
    assert.deepEqual(h.events, [{ type: 'history-panel:focus-composer', detail: {
      tabId: 'tab-a', reason: 'workflow-strip-click', immediate: true,
      selectionStart: Number.MAX_SAFE_INTEGER, selectionEnd: Number.MAX_SAFE_INTEGER,
    } }]);
  }
});

const invalidWrappers = {
  missing: h => h.nodes.clear(),
  'wrong DOM ID': (h, node) => { h.nodes.delete(node.id); node.id = 'unrelated-id'; h.nodes.set(node.id, node); },
  disconnected: (_h, node) => { node.isConnected = false; },
  'wrong tab owner': (_h, node) => { node.dataset.terminalPaneWrapper = 'tab-b'; },
  'single-center History owner': (_h, node) => { node.dataset.terminalPaneWrapper = 'single-center-history:tab-a'; },
  'single-center Timeline owner': (_h, node) => { node.dataset.terminalPaneWrapper = 'single-center-timeline:tab-a'; },
  hidden: (_h, node) => { node.dataset.terminalSurfacePresented = '0'; },
  'missing presentation proof': (_h, node) => { delete node.dataset.terminalSurfacePresented; },
  isolated: (_h, node) => { node.dataset.paneFocusIsolated = '1'; },
  'aria hidden': (_h, node) => { node.ariaHidden = 'true'; },
};
for (const [name, invalidate] of Object.entries(invalidWrappers)) {
  test(`${name} cannot focus; a current valid wrapper wakes the pending intent`, () => {
    const h = harness(); invalidate(h, h.mount()); h.focus('tab-a', 'pending');
    assert.equal(h.events.length, 0);
    assert.equal(h.observers.length, 1);
    assert.equal(h.lookups.length, 2, 'initial check plus observe-after-check guard');
    h.mount(); h.wake();
    assert.equal(h.events.length, 1);
    assert.equal(h.lookups.length, 3);
    assert.equal(h.observers[0].connected, false);
    h.observers[0].callback([]);
    assert.equal(h.events.length, 1, 'cleared intent cannot dispatch twice');
  });
}

test('pending observer keeps child insertion and exact presentation-attribute wakes', () => {
  const h = harness(); h.focus('tab-a', 'not-mounted-yet');
  const observer = h.observers[0];
  assert.equal(observer.target, h.document.documentElement);
  assert.deepEqual(JSON.parse(JSON.stringify(observer.options)), {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-terminal-surface-presented', 'data-pane-focus-isolated', 'aria-hidden'],
  });
  const node = h.mount('tab-a', { presented: '0', isolated: '1', ariaHidden: 'true' });
  h.wake(); node.dataset.terminalSurfacePresented = '1'; h.wake();
  node.dataset.paneFocusIsolated = '0'; h.wake();
  assert.equal(h.events.length, 0);
  node.ariaHidden = null; h.wake();
  assert.equal(h.events.length, 1);
});

test('presentation changing during observe is focused before the request returns', () => {
  const h = harness({ onObserve: h => h.mount() });
  h.focus('tab-a', 'observe-race');
  assert.equal(h.events.length, 1);
  assert.equal(h.lookups.length, 2);
  assert.equal(h.observers[0].connected, false);
});

test('same-ID replacement is read fresh on pending wakes and subsequent requests', () => {
  const h = harness(); const old = h.mount('tab-a', { presented: '0' });
  h.focus('tab-a', 'replacement');
  old.dataset.terminalSurfacePresented = '1'; old.isConnected = false;
  const current = h.mount('tab-a', { presented: '0' }); h.wake();
  assert.equal(h.events.length, 0, 'the old node becoming ready proves nothing');
  current.dataset.terminalSurfacePresented = '1'; h.wake();
  assert.equal(h.events.length, 1);
  current.isConnected = false; h.nodes.delete(current.id);
  h.focus('tab-a', 'removed-again');
  assert.equal(h.events.length, 1, 'no cached ready element survives removal');
  h.mount(); h.wake(); assert.equal(h.events.length, 2);
});

test('rapid navigation cancels the old intent even if an old observer callback arrives', () => {
  const h = harness(); const a = h.mount('tab-a', { presented: '0' });
  h.focus('tab-a', 'old');
  h.workspace.tabs.set('tab-b', { ...h.tab, id: 'tab-b' }); h.workspace.activeTabId = 'tab-b';
  const b = h.mount('tab-b', { presented: '0' }); h.focus('tab-b', 'new');
  assert.equal(h.observers[0].connected, false);
  a.dataset.terminalSurfacePresented = '1'; h.observers[0].callback([]); h.wake();
  assert.equal(h.events.length, 0);
  b.dataset.terminalSurfacePresented = '1'; h.wake();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].detail.tabId, 'tab-b');
  assert.equal(h.events[0].detail.reason, 'new');
  h.observers[0].callback([]); assert.equal(h.events.length, 1);
});

test('pending dispatch rechecks workspace, project, focused pane and external editable ownership', () => {
  const guards = [
    h => { h.state.view = 'dashboard'; },
    h => { h.ui.activeArea = 'sidebar'; },
    h => { h.state.activeProjectId = 'other-project'; },
    h => { h.workspace.activeTabId = 'tab-b'; },
    h => { h.state.splitPanes = [{ projectId: 'P', tabId: 'tab-b' }]; },
    h => { h.state.splitPanes = [{ projectId: 'other-project', tabId: 'tab-a' }]; },
    h => { h.state.splitPanes = [{ projectId: 'P', tabId: 'tab-a' }]; h.state.splitFocusedIndex = 1; },
    h => { h.workspace.tabs.delete('tab-a'); },
    h => { h.tab.tabType = 'file'; },
    ...['INPUT', 'TEXTAREA', 'SELECT', 'DIV'].map(tagName => h => {
      h.document.activeElement = { tagName, isContentEditable: tagName === 'DIV', closest: () => null };
    }),
  ];
  for (const guard of guards) {
    const h = harness(); h.mount('tab-a', { presented: '0' }); h.focus('tab-a', 'guarded');
    guard(h); h.mount(); h.wake();
    assert.equal(h.events.length, 0, String(guard));
    assert.equal(h.observers[0].connected, false);
  }
});

test('old pane editor yields to the current focused pane, independently of active project', () => {
  const h = harness(); h.mount();
  h.state.activeProjectId = 'other-project'; h.state.splitPanes = [{ projectId: 'P', tabId: 'tab-a' }];
  h.document.activeElement = { tagName: 'TEXTAREA', closest: () => ({ dataset: { terminalPaneWrapper: 'tab-old' } }) };
  h.focusWorkspace('pane-header-click');
  assert.equal(h.events.length, 1); assert.equal(h.events[0].detail.tabId, 'tab-a');
});

test('SDK, agent History, terminal-primary and plain xterm retain their routing', () => {
  const routes = [
    ['sdk', h => { h.tab.tabType = 'claude-sdk'; }, 'claude-sdk:focus-composer'],
    ['history', () => {}, 'history-panel:focus-composer'],
    ['terminal', h => { h.ui.terminalIsPrimaryTabs['tab-a'] = true; }, 'nt:window-refocus-active'],
    ['side history', h => { h.ui.terminalIsPrimaryTabs['tab-a'] = true; h.ui.historyPanelOpenTabs['tab-a'] = true; }, 'history-panel:focus-composer'],
    ['plain shell', h => { h.tab.commandType = null; }, 'nt:window-refocus-active'],
  ];
  for (const [name, prepare, type] of routes) {
    const h = harness(); const node = h.mount();
    delete node.dataset.paneFocusIsolated; prepare(h); h.focus('tab-a', name);
    assert.equal(h.events.length, 1); assert.equal(h.events[0].type, type);
    if (name === 'sdk') assert.equal(h.events[0].detail.focusEnd, true);
  }
});

test('empty placeholder and absent focused tab cannot acquire primary input', () => {
  const h = harness(); h.focus('', 'empty');
  h.state.splitPanes = [{ projectId: '', tabId: '' }]; h.focusWorkspace('empty-pane');
  assert.equal(h.lookups.length, 0); assert.equal(h.observers.length, 0);
  h.nodes.set('empty-placeholder', { dataset: { terminalPaneWrapper: 'empty' } });
  h.focus('empty', 'placeholder');
  assert.equal(h.events.length, 0);
});
