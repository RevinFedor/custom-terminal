import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

// Full-module VM loader, as in the other *.actual tests. No extracted handler
// bodies or copied transport/commit algorithms. Each fixture gets fresh owners.
const directory = path.dirname(new URL(import.meta.url).pathname);
const nodeRequire = createRequire(import.meta.url);
const compiled = new Map();
const plain = value => JSON.parse(JSON.stringify(value));

function eventHost() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, patch = {}) {
      const event = {type, button: 0, buttons: 1, isPrimary: true, pointerId: 7,
        clientX: 20, clientY: 20, metaKey: false, preventDefault() {},
        stopImmediatePropagation() {}, ...patch};
      // DOM dispatch does not invoke a listener added during this dispatch.
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    count(type) { return listeners.get(type)?.size || 0; },
  };
}

function strip(paneKey = 'pane:0', spaceId = 'w') {
  const order = ['x', 'a', 'b', 'c', 'z'];
  const element = {
    dataset: {paneKey, spaceId, paneTabDropZone: 'strip'},
    scrollLeft: 0, scrollTop: 0, scrollWidth: 500,
    closest(selector) { return selector === '[data-pane-tab-drop-zone]' ? this : null; },
    matches() { return true; },
    getBoundingClientRect: () => ({left: 0, top: 0, right: 500, bottom: 40, width: 500}),
    querySelectorAll: () => order.map((id, index) => ({dataset: {stripTabId: id},
      getBoundingClientRect: () => ({left: index * 100, right: (index + 1) * 100,
        top: 0, bottom: 40})})),
  };
  return element;
}

function fixture({free = false, noLease = false, sourcePaneKey = 'pane:0'} = {}) {
  const window = eventHost(), frames = new Map(), subscribers = new Set();
  const writes = [], effects = [], pointerMoves = [], sidebarDrops = [];
  let frameId = 0, pointed = strip(sourcePaneKey), current = true, acceptSidebar = false;
  const state = {
    // Deliberately select the synchronous legacy writer, not the parent's
    // organization capture/admission suite or the durable async writer.
    organizationReady: false, activeSpaceId: 'w', activeProjectId: 'p',
    openProjects: new Map([['p', {activeTabId: 'a', tabs: new Map([['b', {}], ['c', {}]])}]]),
    splitPanes: [{tabId: 'a'}, {tabId: 'z'}],
    centerStrips: {main: ['x', 'a', 'b', 'c', 'z'].map(tabId => ({projectId: 'p', tabId}))},
    centerStripKey: () => 'main', getFocusedProjectId: () => 'p',
    moveTabsToWindowStrip(...args) { writes.push(args); return true; },
    commitWorkflowDrag() { assert.fail('unexpected async organization writer'); },
  };
  const store = {getState: () => state, subscribe(listener) {
    subscribers.add(listener); return () => subscribers.delete(listener);
  }};
  const unused = () => assert.fail('organization admission is outside this legacy fixture');
  const doubles = {
    '../store/useWorkspaceStore': {useWorkspaceStore: store},
    './uiPerformanceDiagnostics.mjs': {uiDragDiagnostic() {}, uiDragAdmission() {}, uiDragDiagnosticsEnabled: () => false},
    './interactionCursor': {acquireInteractionCursor: () => () => effects.push('cursor-release')},
    './horizontalRowDragPreview': {createHorizontalRowDragPreview: () => ({
      element: {dataset: {}, style: {}}, move() {}, remove() { effects.push('preview-remove'); },
    })},
    './historyForegroundPriority.mjs': {historyForegroundPriority: {
      beginInteraction() { effects.push('interaction-start'); }, endInteraction() { effects.push('interaction-end'); },
    }},
    './workflowDragModel.mjs': {captureWorkflowDrag: unused, workflowDragRequest: unused, workflowDragSourceValid: unused},
    react: {useSyncExternalStore() { assert.fail('no React mount in SOURCE tests'); }},
  };
  const context = vm.createContext({console: {log() {}}, crypto: {randomUUID}, performance,
    window, document: {elementFromPoint: () => pointed},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = {exports: {}};
    modules.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename.replace(/\.mjs$/, '.js'),
      compilerOptions: {allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    }).outputText);
    const require = specifier => {
      if (Object.hasOwn(doubles, specifier)) return doubles[specifier];
      if (!specifier.startsWith('.')) return nodeRequire(specifier);
      let resolved = path.resolve(path.dirname(filename), specifier);
      if (!path.extname(resolved)) resolved += '.ts';
      return load(resolved);
    };
    const wrapper = vm.runInContext('(function(require,module,exports){\n' + compiled.get(filename) + '\n})', context, {filename});
    wrapper(require, module, module.exports);
    return module.exports;
  }
  const bridge = load(path.join(directory, 'paneTabDragBridge.ts'));
  const pointer = load(path.join(directory, 'paneTabPointerBridge.ts'));
  const navigation = load(path.join(directory, 'tabDragNavigationBridge.ts'));
  const commit = load(path.join(directory, 'paneTabDropCommit.ts'));
  const gesture = load(path.join(directory, 'paneTabPointerGesture.ts'));
  const model = load(path.join(directory, 'paneStripSelectionModel.mjs'));
  const source = {owner: 'pane', rootTabId: 'b', sourcePaneKey, sourceSpaceId: 'w',
    entries: ['b', 'c'].map(tabId => ({projectId: 'p', tabId})),
    ...(!noLease && {groupDrag: {boundary: free ? {kind: 'free'} : model.paneStripGroupDragBoundary(
      [{id: 'color', revision: 4, tabIds: ['a', 'b', 'c']}],
      {sourceIds: ['b', 'c'], order: ['x', 'a', 'b', 'c', 'z']}), isCurrent: () => current}}),
  };
  pointer.subscribePaneTabPointer(() => {
    if (pointer.getPaneTabPointerSnapshot().active) pointerMoves.push(pointer.getPaneTabPointerSnapshot());
  });
  pointer.subscribePaneTabPointerDrop(snapshot => { sidebarDrops.push(snapshot); return acceptSidebar; });
  const chip = {...eventHost(), closest: () => null};
  const unbind = gesture.bindPaneTabPointerDrag(chip, () => source);
  const flush = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
  };
  return {source, state, writes, effects, bridge, pointer, navigation, commit, pointerMoves, sidebarDrops,
    get pendingFrames() { return frames.size; },
    get activeSubscriptions() { return subscribers.size; },
    get moveListeners() { return window.count('pointermove'); },
    invalidate(notify = false) { current = false; if (notify) [...subscribers].forEach(listener => listener(state)); },
    adopt() { acceptSidebar = true; },
    pointAt(element) { pointed = element; },
    hover(kind) { pointed = {closest: selector => selector === (kind === 'workflow'
      ? '[data-space-chip]' : '[data-structured-project-drop-target]')
      ? {dataset: {spaceChip: 'other-w', projectId: 'other-p'}} : null}; },
    start() { chip.dispatch('pointerdown', {target: chip}); window.dispatch('pointermove', {clientX: 30}); flush(); },
    move(x = 30) { window.dispatch('pointermove', {clientX: x}); flush(); },
    meta() { window.dispatch('keydown', {key: 'Meta'}); flush(); },
    up(x = 30) { window.dispatch('pointerup', {clientX: x}); },
    dispose() { gesture.cancelPaneTabPointerDrag('test-cleanup'); unbind(); },
  };
}

function clean(f) {
  assert.equal(f.bridge.getPaneTabDragSnapshot().active, false);
  assert.equal(f.pointer.getPaneTabPointerSnapshot().active, false);
  assert.equal(f.navigation.getTabDragNavigationSnapshot().target, null);
  assert.equal(f.pendingFrames, 0);
  assert.equal(f.activeSubscriptions, 0);
  assert.equal(f.moveListeners, 0);
  assert.deepEqual(f.effects.slice(-3), ['preview-remove', 'cursor-release', 'interaction-end']);
}

test('locked member gesture never publishes sidebar adoption or workflow/project hover navigation', t => {
  const f = fixture(); t.after(() => f.dispose());
  f.adopt(); f.start();
  for (const kind of ['workflow', 'project']) {
    f.hover(kind); f.move(); f.meta();
    assert.equal(f.navigation.getTabDragNavigationSnapshot().target, null);
    assert.equal(f.bridge.getPaneTabDragSnapshot().target, null);
    assert.equal(f.bridge.getPaneTabDragSnapshot().active, true);
  }
  // A sidebar row outside either strip/navigation zone has no adoption lease.
  f.pointAt({closest: () => null}); f.move(); f.up();
  assert.equal(f.pointerMoves.length, 0);
  assert.equal(f.sidebarDrops.length, 0);
  assert.equal(f.writes.length, 0);
  clean(f);
});

test('actual pointer geometry clamps POST-removal slots and legacy release writes the painted slot once', t => {
  for (const [x, expected] of [[-100, 1], [900, 2]]) {
    const f = fixture(); t.after(() => f.dispose()); f.start(); f.move(x);
    const painted = f.bridge.getPaneTabDragSnapshot().target;
    assert.equal(painted.at, expected);
    assert.equal(f.writes.length, 0);
    // Final pointerup is inside the zone but has no painted frame of its own.
    f.up(250);
    assert.deepEqual(plain(f.writes.map(args=>args.slice(0,4))), [[0, f.source.entries, expected, 'a']]);
    assert.deepEqual(plain(f.writes[0][4]),plain(painted),'row intent follows the last painted target too');
    f.up(); assert.equal(f.writes.length, 1);
    assert.equal(f.sidebarDrops.length, 0);
    clean(f);
  }
});

test('stale group at release cannot claim or call the synchronous writer, even without a store wake', t => {
  for (const notify of [false, true]) {
    const f = fixture(); t.after(() => f.dispose()); f.start(); f.move(900);
    const {source, target} = f.bridge.getPaneTabDragSnapshot();
    f.invalidate(notify);
    assert.equal(f.bridge.claimPaneTabDragDrop('b'), null);
    assert.equal(f.commit.commitPaneTabDrop(source, target), false);
    f.up(); assert.equal(f.writes.length, 0);
    clean(f);
  }
});

test('legacy painted commit rechecks group currency after claim and before writer invocation', t => {
  const f = fixture(); t.after(() => f.dispose()); f.start();
  let proofs = 0;
  f.source.groupDrag.isCurrent = () => ++proofs === 1;
  const result = f.commit.commitPaintedPaneTabDrop('b');
  assert.equal(result.claimed, true);
  assert.equal(result.committed, false);
  assert.equal(proofs, 2);
  assert.equal(f.writes.length, 0);
  f.up(); clean(f);
});

test('synchronous legacy center writer receives clamped scope and returns its actual rejection', t => {
  const f = fixture({sourcePaneKey: 'center'}); t.after(() => f.dispose());
  const target = {zone: 'body', paneKey: 'center', paneIndex: null, spaceId: 'w', at: Infinity};
  assert.equal(f.commit.commitPaneTabDrop(f.source, {...target, spaceId: 'other-w'}), false);
  assert.equal(f.commit.commitPaneTabDrop(f.source, {...target, paneKey: 'pane:1', paneIndex: 1}), false);
  assert.equal(f.writes.length, 0);
  f.state.moveTabsToWindowStrip = (...args) => { f.writes.push(args); return false; };
  assert.equal(f.commit.commitPaneTabDrop(f.source, target), false);
  assert.deepEqual(plain(f.writes.map(args=>args.slice(0,4))), [[null, f.source.entries, 2, 'a']]);
  assert.equal(f.writes[0][4].at,2);
});

test('free and unscoped drags preserve hover navigation, sidebar priority and cross-pane legacy drop', t => {
  for (const options of [{free: true}, {noLease: true}]) {
    for (const adopted of [true, false]) {
      const f = fixture(options); t.after(() => f.dispose()); f.start();
      for (const kind of ['workflow', 'project']) {
        f.hover(kind); f.move();
        assert.equal(f.navigation.getTabDragNavigationSnapshot().target.kind, kind);
      }
      f.pointAt(strip('pane:1')); f.move(900);
      assert.equal(f.bridge.getPaneTabDragSnapshot().target.at, 3);
      if (adopted) f.adopt();
      f.up();
      assert.ok(f.pointerMoves.length > 0);
      assert.equal(f.sidebarDrops.length, 1);
      assert.equal(f.sidebarDrops[0].source.rootTabId, 'b');
      assert.deepEqual(plain(f.writes.map(args=>args.slice(0,4))), adopted ? [] : [[1, f.source.entries, 3, 'b']]);
      clean(f);
    }
  }
});
