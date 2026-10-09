import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { createStore } from 'zustand/vanilla';
import * as panes from '../utils/splitPanesModel.mjs';
import * as displays from '../utils/windowDisplayLayouts.mjs';
import * as spaces from '../utils/workspaceSpacesModel.mjs';
import { touchMru } from '../utils/tabSwitcherModel.mjs';
import { isVisitWorthRecording } from '../utils/tabVisitHistoryRule.mjs';
import { organizationPlacementIntent } from '../utils/workflowPlacementMembership.mjs';
import { tabNavigationLocation } from '../utils/tabNavigationLocation.mjs';
import * as links from '../utils/tabLinkNavigation.mjs';
import * as placement from '../utils/tabPlacementResolver.mjs';
import { webcrypto } from 'node:crypto';

// Run the actual store methods and its display-reconciliation boundary in
// Zustand. Only persistence, UI and renderer instrumentation are local seams.
const source = fs.readFileSync(new URL('./useWorkspaceStore.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('useWorkspaceStore.ts', source, ts.ScriptTarget.Latest, true);
const variable = name => ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(declaration => declaration.name.getText(ast) === name);
const factory = variable('useWorkspaceStore').initializer.arguments[0];
const setStatement = factory.body.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'set'));
let object = factory.body.statements.find(ts.isReturnStatement).expression;
while (ts.isParenthesizedExpression(object)) object = object.expression;
const names = [
  'showHiddenWindow', 'activateCenterTab', 'switchTab', 'touchGlobalTabMru',
  'getFocusedProjectId', 'requestTabListReveal', 'setProjectView', 'workspaceSpaceIndexOfTab',
  'addEmptySplitPane', 'addVerticalSplitPane',
  'minimizeWorkspaceWindow',
  'openTabById', 'placeTab', 'setViewingSubAgent',
];
const methods = names.map(name => {
  const property = object.properties.find(candidate => candidate.name?.getText(ast) === name);
  assert.ok(property && ts.isPropertyAssignment(property), name);
  return property.getText(ast);
});
assert.ok(setStatement);
const navigationOwner = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'withOwnedTabNavigation');
const code = transformSync('let ownedTabNavigation = null;\n' + navigationOwner.getText(ast) + '\n' + setStatement.getText(ast)
  + '\nconst activationFollowPatch = ' + variable('activationFollowPatch').initializer.getText(ast)
  + ';\nmodule.exports = {' + methods.join(',\n') + '};', { loader: 'ts', format: 'cjs' }).code;
const clone = value => JSON.parse(JSON.stringify(value));
const chip = (tabId, projectId = 'p') => ({ projectId, tabId });
const big = { key: 'external', internal: false };
const small = { key: 'builtin', internal: true };

function fixture({ chooser = false, vacant = false, customLayout = null } = {}) {
  const original = {
    splitPanes: [
      { ...chip('a'), windowId: 'left', column: 0 },
      { ...chip('b'), windowId: 'outgoing', column: 1,
        tabs: [chip('b'), { slotId: 'outgoing-slot', projectId: 'p', cwd: '/outgoing' }, chip('b2', 'q')],
        history: [chip('older-b')], detachedTabs: [chip('removed-b')] },
      { ...chip('old'), windowId: 'incoming', column: 2,
        tabs: [
          { slotId: 'leading', projectId: 'p', cwd: '/leading' }, chip('old'),
          { slotId: 'middle', projectId: 'q', cwd: '/middle' }, chip('target', 'q'),
          { slotId: 'trailing', projectId: 'q', cwd: '/trailing' },
        ], history: [chip('older')], detachedTabs: [chip('removed')] },
      { ...chip('d'), windowId: 'other-hidden', column: 2 },
    ],
    splitFocusedIndex: 0,
    splitSizes: { cols: [.3, .3, .4], rows: [[1], [1], [.6, .4]] },
  };
  if (chooser) original.splitPanes = panes.selectChooserSlot(original.splitPanes, 2, 'middle').panes;
  if (vacant) original.splitPanes[2] = panes.vacantPaneWithTabs(original.splitPanes[2], panes.paneTabs(original.splitPanes[2]));
  const layout = customLayout || displays.applyWindowDisplay(displays.applyWindowDisplay(original, big), small);
  const workspace = (projectId, ids, activeTabId) => ({
    projectId, activeTabId, currentView: 'home', tabHistory: [activeTabId], selectedTabIds: [activeTabId],
    tabs: new Map(ids.map(id => [id, {
      id, lastActivatedAt: 100, isRunning: false,
      ...(['old', 'target'].includes(id) ? { completionNotificationFired: true, completionNotificationFiredAt: 90 } : {}),
    }])),
  });
  const initial = {
    ...layout, workspaceDisplay: small, isRestoring: false,
    activeSpaceId: 'main', activeSpaceTab: chip('a'), activeProjectId: 'p', focusedProjectId: 'p',
    view: 'workspace', centerStrips: {}, projectHistory: ['p', 'q'],
    globalTabMru: [chip('a'), chip('old'), chip('q-other', 'q')],
    openProjects: new Map([
      ['p', workspace('p', ['a', 'b', 'old', 'd', 'unplaced'], 'a')],
      ['q', workspace('q', ['target', 'b2', 'q-other'], 'q-other')],
    ]),
    spaces: [
      { id: 'main', name: 'Main', layout },
      { id: 'dormant', name: 'Other', layout: displays.applyWindowDisplay({
        splitPanes: [{ ...chip('target', 'q'), windowId: 'dormant-window' }], splitFocusedIndex: 0,
      }, small) },
    ],
    tabListRevealRequest: null, tabCatalog: {},
  };
  const effects = [], writes = [];
  const store = createStore((baseSet, get) => {
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, baseSet, get, ...panes, ...displays, ...spaces, ...links, ...placement, touchMru, isVisitWorthRecording,
      organizationPlacementIntent,tabNavigationLocation,crypto:webcrypto,
      performance, console: { log() {}, warn() {}, info() {} },
      startTransition: fn => fn(), requestAnimationFrame: fn => fn(), markRendererActivity: () => () => {},
      emitTabCompletionNotificationCleared: event => effects.push({ kind: 'notification', ...event }),
      saveTabs: projectId => effects.push({ kind: 'save-tabs', projectId }),
      useUIStore: { getState: () => ({ setActiveArea: area => effects.push({ kind: 'area', area }) }) },
    });
    return { ...initial, ...module.exports,
      saveSession: () => effects.push({ kind: 'save-session' }),
      ensureTabRuntime: async () => true,
      switchWorkspaceSpace: () => assert.fail('reveal must stay in the current workflow'),
    };
  });
  store.subscribe(state => writes.push(clone({
    pane: state.splitPanes[state.splitFocusedIndex], mru: state.globalTabMru, active: state.activeSpaceTab,
  })));
  return { store, effects, writes, reveal: (...args) => store.getState().showHiddenWindow(...args) };
}

function snapshot(state) {
  return clone({ ...spaces.captureSpaceLayout(state),
    view: state.view, activeProjectId: state.activeProjectId, focusedProjectId: state.focusedProjectId,
    activeSpaceId: state.activeSpaceId, spaces: state.spaces, globalTabMru: state.globalTabMru,
    projectHistory: state.projectHistory, tabListRevealRequest: state.tabListRevealRequest,
    projects: [...state.openProjects].map(([id, workspace]) => [id, { ...workspace, tabs: [...workspace.tabs] }]),
  });
}

function oneVisibleWithHidden({ placeholder = false } = {}) {
  return displays.reconcileWindowDisplay({
    windowDisplayKey: small.key, windowDisplayLayouts: {}, splitFocusedIndex: 0, splitSizes: null,
    splitPanes: [
      { ...chip('a'), windowId: 'left' },
      ...(placeholder ? [{ projectId: '', tabId: '', windowId: 'blank', column: 1 }] : []),
      { ...chip('old'), windowId: 'incoming', displayHidden: true, column: 1,
        tabs: [chip('old'), chip('target', 'q')], history: [chip('older')], detachedTabs: [chip('removed')] },
    ],
  }, small);
}

test('manual minimize preserves the window and content, remembers only this display choice',()=>{
  const f=fixture(),before=f.store.getState(),outgoing=before.splitPanes.find(p=>p.windowId==='outgoing');
  const external=clone(before.windowDisplayLayouts.external);
  assert.equal(before.minimizeWorkspaceWindow('main','outgoing'),true);
  const next=f.store.getState(),hidden=next.splitPanes.find(p=>p.windowId==='outgoing');
  assert.equal(hidden.displayHidden,true);assert.deepEqual(panes.paneSlots(hidden),panes.paneSlots(outgoing));
  assert.deepEqual(hidden.history,outgoing.history);assert.deepEqual(hidden.detachedTabs,outgoing.detachedTabs);
  assert.deepEqual(next.windowDisplayLayouts.external,external);assert.equal(next.activeSpaceTab.tabId,'a');
  const roundTrip=displays.applyWindowDisplay(displays.applyWindowDisplay(next,big),small);
  assert.equal(roundTrip.splitPanes.find(p=>p.windowId==='outgoing').displayHidden,true);
  assert.equal(next.minimizeWorkspaceWindow('another-workflow','left'),false);
  assert.equal(next.minimizeWorkspaceWindow('main','outgoing'),false);
});

test('secondary link returns a previously swapped hidden window to its second column, not the focused first',async()=>{
  const f=fixture();
  assert.equal(f.reveal(1,'incoming',chip('target','q')),true);
  assert.equal(f.reveal(1,'outgoing',chip('b')),true);
  f.store.getState().activateCenterTab('p','a');
  assert.equal(f.store.getState().splitFocusedIndex,0);
  const left=f.store.getState().splitPanes[0];
  const strips=f.store.getState().splitPanes.map(pane=>[pane.windowId,clone(panes.paneSlots(pane))]);
  assert.equal(await f.store.getState().openTabById('target',{reason:'orchestration-linked-tab'}),true);
  const state=f.store.getState();
  assert.equal(state.splitFocusedIndex,1);
  assert.equal(state.splitPanes[0],left);
  assert.equal(state.splitPanes[1].windowId,'incoming');
  assert.equal(state.splitPanes[1].tabId,'target');
  for(const [id,strip] of strips)assert.deepEqual(panes.paneSlots(state.splitPanes.find(p=>p.windowId===id)),strip);
});

test('secondary link without a position on this display uses the current visible window',async()=>{
  const f=fixture();
  assert.equal(await f.store.getState().openTabById('target'),true);
  assert.equal(f.store.getState().splitPanes[0].windowId,'incoming');
  assert.equal(f.store.getState().splitFocusedIndex,0);
});

test('portal link without remembered position uses its source window, not another global focus',async()=>{
  const f=fixture(); f.store.getState().activateCenterTab('p','b');
  assert.equal(f.store.getState().splitFocusedIndex,1);
  assert.equal(await f.store.getState().openTabById('target',{sourceTabId:'a'}),true);
  assert.equal(f.store.getState().splitPanes[0].windowId,'incoming');
  assert.equal(f.store.getState().splitPanes[1].windowId,'outgoing');
  assert.equal(f.store.getState().splitFocusedIndex,0);
});

test('remembered hidden destination survives another display and JSON reopen',async()=>{
  const f=fixture();
  f.reveal(1,'incoming',chip('target','q')); f.reveal(1,'outgoing',chip('b'));
  const returned=displays.applyWindowDisplay(displays.applyWindowDisplay(f.store.getState(),big),small);
  const reopened=fixture({customLayout:clone(spaces.captureSpaceLayout(returned))});
  reopened.store.getState().activateCenterTab('p','a');
  assert.equal(await reopened.store.getState().openTabById('target'),true);
  assert.equal(reopened.store.getState().splitFocusedIndex,1);
  assert.equal(reopened.store.getState().splitPanes[0].windowId,'left');
});

test('late runtime completion after hidden reveal cannot refocus the window or claim navigation success',async()=>{
  const f=fixture(); f.reveal(1,'incoming',chip('target','q')); f.reveal(1,'outgoing',chip('b'));
  f.store.getState().activateCenterTab('p','a');
  let finish;
  f.store.setState({ensureTabRuntime:id=>id==='target' ? new Promise(resolve=>{finish=resolve;}) : Promise.resolve(true)});
  const opening=f.store.getState().openTabById('target');
  assert.equal(f.store.getState().splitFocusedIndex,1);
  assert.equal(await f.store.getState().openTabById('a'),true);
  finish(true);assert.equal(await opening,false);
  assert.equal(f.store.getState().splitFocusedIndex,0);
  assert.equal(f.store.getState().activeSpaceTab.tabId,'a');
});

test('minimizing the last visible window keeps a picker access point without revealing a hidden tab',()=>{
  const f=fixture({customLayout:oneVisibleWithHidden()}),state=f.store.getState(),mru=clone(state.globalTabMru);
  assert.equal(state.minimizeWorkspaceWindow('main','left'),true);
  const next=f.store.getState(),visible=next.splitPanes.filter(p=>!p.displayHidden);
  assert.equal(visible.length,1);assert.equal(visible[0].tabId,'');assert.notEqual(visible[0].windowId,'left');
  assert.equal(next.activeSpaceTab,null);assert.deepEqual(next.globalTabMru,mru);
  assert.equal(next.splitPanes.find(p=>p.windowId==='left').displayHidden,true);
  assert.equal(next.minimizeWorkspaceWindow('main',visible[0].windowId),false,'access placeholder cannot grow an endless hidden empty-window list');
  assert.equal(f.store.getState().splitPanes.length,next.splitPanes.length);
  assert.equal(next.showHiddenWindow(next.splitFocusedIndex,'left'),true);
  assert.equal(f.store.getState().splitPanes.some(p=>p.windowId===visible[0].windowId),false);
  assert.equal(f.store.getState().activeSpaceTab.tabId,'a');
});

for (const side of ['right', 'left', 'above', 'below']) {
  test(`actual ${side} split reveals the existing hidden window atomically instead of making a blank`, () => {
    const initial = oneVisibleWithHidden();
    const f = fixture({ customLayout: initial });
    const state = f.store.getState();
    const opened = ['right', 'left'].includes(side)
      ? state.addEmptySplitPane(0, side)
      : state.addVerticalSplitPane(0, side);
    assert.equal(opened, true);
    const next = f.store.getState();
    assert.equal(next.splitPanes.length, 2);
    assert.ok(next.splitPanes.every(pane => !pane.displayHidden && pane.tabId));
    const incoming = next.splitPanes[next.splitFocusedIndex];
    assert.equal(incoming.windowId, 'incoming');
    assert.equal(incoming.tabId, 'old');
    assert.deepEqual(panes.paneSlots(incoming), panes.paneSlots(initial.splitPanes[1]));
    assert.deepEqual(incoming.history, initial.splitPanes[1].history);
    assert.deepEqual(incoming.detachedTabs, initial.splitPanes[1].detachedTabs);
    assert.ok(f.writes.every(write => write.pane.windowId === 'incoming'), 'no transient empty focused pane');
    assert.equal(next.activeSpaceTab.tabId, 'old');
    assert.equal(next.windowDisplayLayouts.builtin.positions.length, 2);
  });
}

test('actual picker consumes a new empty slot, so switching cannot toggle back to a hidden ghost', () => {
  const initial = oneVisibleWithHidden({ placeholder: true });
  const f = fixture({ customLayout: initial });
  assert.equal(f.reveal(1, 'incoming', chip('target', 'q')), true);
  const state = f.store.getState();
  assert.equal(state.splitPanes.length, 2);
  assert.ok(state.splitPanes.every(pane => !pane.displayHidden));
  assert.equal(state.splitPanes[1].windowId, 'incoming');
  assert.equal(state.splitPanes[1].tabId, 'target');
  assert.ok(!JSON.stringify(state.windowDisplayLayouts).includes('blank'));
  assert.equal(f.reveal(1, 'blank'), false);
});

test('split can recover the existing blank slot from the reported bad layout without making a third column', () => {
  const f = fixture({ customLayout: oneVisibleWithHidden({ placeholder: true }) });
  assert.equal(f.store.getState().addEmptySplitPane(0), true);
  assert.equal(f.store.getState().splitPanes.length, 2);
  assert.ok(f.store.getState().splitPanes.every(pane => !pane.displayHidden && pane.tabId));
});

test('split with a stale hidden selection does not publish an empty or foreign window', () => {
  const f = fixture({ customLayout: oneVisibleWithHidden() });
  f.store.getState().openProjects.get('p').tabs.delete('old');
  const before = snapshot(f.store.getState());
  assert.equal(f.store.getState().addEmptySplitPane(0), false);
  assert.equal(f.store.getState().addVerticalSplitPane(0, 'below'), false);
  assert.deepEqual(snapshot(f.store.getState()), before);
  assert.equal(f.writes.length, 0);
});

test('actual reveal selects a parked real tab before navigation/MRU, preserving mixed order and every other window', () => {
  const f = fixture();
  const before = snapshot(f.store.getState());
  const original = f.store.getState().splitPanes;
  assert.equal(f.reveal(1, 'incoming', { projectId: 'q', tabId: 'target' }), true);
  const state = f.store.getState();
  assert.equal(state.splitFocusedIndex, 1);
  assert.equal(state.splitPanes[1].tabId, 'target');
  assert.equal(state.splitPanes[1].projectId, 'q');
  assert.deepEqual(panes.paneSlots(state.splitPanes[1]), panes.paneSlots(original[2]));
  assert.deepEqual(state.splitPanes[2], {
    ...original[1], displayHidden: true, displayRect: panes.paneGridRects(original, state.splitSizes)[1],
  });
  assert.equal(state.splitPanes[0], original[0]);
  assert.equal(state.splitPanes[3], original[3]);
  assert.deepEqual(clone(state.windowDisplayLayouts.external), before.windowDisplayLayouts.external);
  assert.deepEqual(clone(state.spaces), before.spaces);
  assert.deepEqual(clone(state.projectHistory), before.projectHistory);
  assert.equal(state.activeProjectId, 'q');
  assert.equal(state.focusedProjectId, 'q');
  assert.deepEqual(clone(state.activeSpaceTab), chip('target', 'q'));
  assert.deepEqual(clone(state.globalTabMru), [chip('target', 'q'), ...before.globalTabMru]);
  assert.equal(state.openProjects.get('q').activeTabId, 'target');
  assert.equal(state.openProjects.get('q').currentView, 'terminal');
  assert.deepEqual(clone(state.openProjects.get('q').tabHistory), ['q-other', 'target']);
  assert.deepEqual(clone(state.tabListRevealRequest), { ...chip('target', 'q'), seq: 1 });
  assert.equal(state.openProjects.get('p').tabs.get('old').lastActivatedAt, 100);
  assert.equal(state.openProjects.get('p').tabs.get('old').completionNotificationFired, true);
  assert.ok(f.writes.length > 0);
  assert.ok(f.writes.every(write => write.pane.windowId === 'incoming' && write.pane.tabId === 'target'));
  assert.deepEqual(f.effects.filter(effect => effect.kind === 'save-tabs'), [{ kind: 'save-tabs', projectId: 'q' }]);
  assert.deepEqual(f.effects.filter(effect => effect.kind === 'notification'), [{ kind: 'notification', ...chip('target', 'q') }]);
});

for (const chooser of [false, true]) {
  test('actual chooser reveal never activates a real tab, initially selected=' + chooser, () => {
    const f = fixture({ chooser });
    const before = snapshot(f.store.getState());
    assert.equal(f.reveal(1, 'incoming', { slotId: 'middle' }), true);
    const state = f.store.getState();
    const after = snapshot(state);
    assert.equal(state.splitPanes[1].tabId, '');
    assert.equal(state.splitPanes[1].projectId, '');
    assert.equal(state.splitPanes[1].selectedSlotId, 'middle');
    assert.deepEqual(panes.paneSlots(state.splitPanes[1]), panes.paneSlots(before.splitPanes[2]));
    for (const key of ['activeProjectId', 'focusedProjectId', 'activeSpaceTab', 'globalTabMru', 'projects', 'spaces', 'tabListRevealRequest']) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.deepEqual(f.effects, [{ kind: 'area', area: 'workspace' }, { kind: 'save-session' }]);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].pane.selectedSlotId, 'middle');
  });
}

test('actual real-tab reveal from a selected chooser preserves that chooser in the mixed strip', () => {
  const f = fixture({ chooser: true });
  const strip = clone(panes.paneSlots(f.store.getState().splitPanes[2]));
  assert.equal(f.reveal(1, 'incoming', { projectId: 'q', tabId: 'target' }), true);
  const pane = f.store.getState().splitPanes[1];
  assert.equal(pane.tabId, 'target');
  assert.equal(pane.selectedSlotId, undefined);
  assert.deepEqual(panes.paneSlots(pane), strip);
});

test('two-argument reveal keeps the incoming real, chooser or vacant selection', () => {
  for (const options of [{}, { chooser: true }, { vacant: true }]) {
    const f = fixture(options);
    const incoming = clone(f.store.getState().splitPanes[2]);
    assert.equal(f.reveal(1, 'incoming'), true);
    const pane = f.store.getState().splitPanes[1];
    assert.equal(pane.tabId, incoming.tabId);
    assert.equal(pane.selectedSlotId, incoming.selectedSlotId);
    assert.deepEqual(panes.paneSlots(pane), panes.paneSlots(incoming));
    assert.equal(f.effects.filter(effect => effect.kind === 'save-tabs').length, incoming.tabId ? 1 : 0);
  }
});

test('foreign/malformed selection, closed tab/project and stale window cause zero store, focus or persistence writes', () => {
  const cases = [
    { selection: chip('a') }, { selection: chip('d') }, { selection: chip('unplaced') },
    { selection: chip('target') }, { selection: chip('old', 'q') }, { selection: chip('missing') },
    { selection: { slotId: 'outgoing-slot' } }, { selection: { slotId: 'missing' } },
    { selection: { ...chip('old'), slotId: 'middle' } }, { selection: { tabId: 'old' } },
    { selection: null }, { selection: { slotId: '' } },
    { selection: chip('target', 'q'), prepare: state => state.openProjects.get('q').tabs.delete('target') },
    { selection: chip('target', 'q'), prepare: state => state.openProjects.delete('q') },
    { prepare: state => state.openProjects.get('p').tabs.delete('old') },
    { selection: { slotId: 'middle' }, windowId: 'closed-window' },
    { selection: { slotId: 'middle' }, windowId: 'left' },
    { selection: { slotId: 'middle' }, targetIndex: 2 },
  ];
  for (const entry of cases) {
    const f = fixture();
    entry.prepare?.(f.store.getState());
    const identity = f.store.getState();
    const before = snapshot(identity);
    assert.equal(f.reveal(entry.targetIndex ?? 1, entry.windowId ?? 'incoming', entry.selection), false, JSON.stringify(entry));
    assert.equal(f.store.getState(), identity);
    assert.deepEqual(snapshot(f.store.getState()), before);
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.writes, []);
  }
});

test('chooser reveal remains valid when a parked real tab has closed', () => {
  const f = fixture();
  f.store.getState().openProjects.get('p').tabs.delete('old');
  assert.equal(f.reveal(1, 'incoming', { slotId: 'middle' }), true);
  assert.equal(f.store.getState().splitPanes[1].selectedSlotId, 'middle');
  assert.equal(f.effects.some(effect => effect.kind === 'save-tabs'), false);
});

test('repeated reveal is a strict no-op; subsequent window swaps retain the explicit selection', () => {
  const f = fixture();
  assert.equal(f.reveal(1, 'incoming', { projectId: 'q', tabId: 'target' }), true);
  const after = snapshot(f.store.getState());
  const writes = f.writes.length, effects = f.effects.length;
  for (const selection of [undefined, chip('target', 'q'), { slotId: 'middle' }]) {
    assert.equal(f.reveal(1, 'incoming', selection), false);
    assert.deepEqual(snapshot(f.store.getState()), after);
    assert.equal(f.writes.length, writes);
    assert.equal(f.effects.length, effects);
  }
  assert.equal(f.reveal(1, 'outgoing'), true);
  assert.equal(f.reveal(1, 'incoming'), true);
  assert.equal(f.store.getState().splitPanes[1].tabId, 'target');
  assert.deepEqual(panes.paneSlots(f.store.getState().splitPanes[1]), panes.paneSlots(after.splitPanes[1]));
});
