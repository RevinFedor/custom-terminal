import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

// Actual workflow-chip commit + store action + public setter boundary + the
// actual App bridge registration. This is a Node store/publication control, not a DOM,
// xterm, provider, SQLite, physical-input or compositor performance test.
// Source overrides let the identical test run against saved PRE/POST files.
const repositoryRoot = process.env.NOTED_WORKFLOW_MODULE_ROOT
  ? path.resolve(process.env.NOTED_WORKFLOW_MODULE_ROOT)
  : fileURLToPath(new URL('../../../', import.meta.url));
const sourcePath = process.env.NOTED_WORKFLOW_STORE_SOURCE
  ? path.resolve(process.env.NOTED_WORKFLOW_STORE_SOURCE)
  : fileURLToPath(new URL('./useWorkspaceStore.ts', import.meta.url));
const stripPath = process.env.NOTED_WORKFLOW_STRIP_SOURCE
  ? path.resolve(process.env.NOTED_WORKFLOW_STRIP_SOURCE)
  : fileURLToPath(new URL('../components/Workspace/SpaceStrip.tsx', import.meta.url));
const appPath = path.join(repositoryRoot, 'src/renderer/App.tsx');
const load = relative => import(pathToFileURL(path.join(repositoryRoot, relative)));
const [panes, spaces, displays, mru, visits, placement, navigation, selector, visuals, switcherContract] = await Promise.all([
  load('src/renderer/utils/splitPanesModel.mjs'),
  load('src/renderer/utils/workspaceSpacesModel.mjs'),
  load('src/renderer/utils/windowDisplayLayouts.mjs'),
  load('src/renderer/utils/tabSwitcherModel.mjs'),
  load('src/renderer/utils/tabVisitHistoryRule.mjs'),
  load('src/renderer/utils/workflowPlacementMembership.mjs'),
  load('src/renderer/utils/tabNavigationLocation.mjs'),
  load('src/renderer/utils/tabSwitcherSelector.mjs'),
  load('src/renderer/utils/workflowVisuals.mjs'),
  load('src/shared/workspace-switcher-contract.cjs'),
]);
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const ast = parse('useWorkspaceStore.ts', fs.readFileSync(sourcePath, 'utf8'));
const variable = name => ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(declaration => declaration.name.getText(ast) === name);
const factory = variable('useWorkspaceStore').initializer.arguments[0];
const setStatement = factory.body.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'set'));
assert.ok(setStatement, 'actual display/navigation/public setter must be present');
let object = factory.body.statements.find(ts.isReturnStatement).expression;
while (ts.isParenthesizedExpression(object)) object = object.expression;
const methods = ['switchWorkspaceSpace', 'touchGlobalTabMru'].map(name => {
  const property = object.properties.find(candidate => candidate.name?.getText(ast) === name);
  assert.ok(property && ts.isPropertyAssignment(property), name);
  return property.getText(ast);
});
const navigationOwner = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'withOwnedTabNavigation');
assert.ok(navigationOwner);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// Transparent entry counters in the complete actual snapshot module. Only
// increments are inserted; imports and all DTO/equality/publication bodies run.
// They measure completed synchronous work, including the later required sets.
const snapshotSource = fs.readFileSync(path.join(repositoryRoot,
  'src/renderer/utils/workspaceSwitcherSnapshot.mjs'), 'utf8');
const snapshotAst = parse('workspaceSwitcherSnapshot.mjs', snapshotSource);
const counters = { tabDto: '__dtoOperations.tabDtoCalls++;',
  rowsDto: '__dtoOperations.rowsDtoCalls++; __dtoOperations.rowsMapped += rows.length;' };
const insertions = snapshotAst.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && Object.hasOwn(counters, statement.name?.text)).map(statement => ({
    offset: statement.body.getStart(snapshotAst) + 1, source: '\n' + counters[statement.name.text] + '\n',
  })).sort((a, b) => b.offset - a.offset);
assert.equal(insertions.length, 2, 'actual rowsDto and tabDto entry points');
let countedSnapshot = snapshotSource;
for (const insertion of insertions) countedSnapshot = countedSnapshot.slice(0, insertion.offset)
  + insertion.source + countedSnapshot.slice(insertion.offset);
const snapshotCode = transpile(countedSnapshot);
const storeCode = transpile('let ownedTabNavigation = null;\n' + navigationOwner.getText(ast)
  + '\n' + setStatement.getText(ast) + '\napi.setState = set;\n'
  + 'const tabIdsOfPanesInLayout = ' + variable('tabIdsOfPanesInLayout').initializer.getText(ast)
  + ';\nmodule.exports = {' + methods.join(',\n') + ',__withOwnedTabNavigation:withOwnedTabNavigation};');

// Execute the same subscription owner as App. An equivalent hand-written
// subscriber could otherwise hide a missed synchronous refresh/revision.
const appAst = parse('App.tsx', fs.readFileSync(appPath, 'utf8'));
const registrationEffects = [];
function visitApp(node) {
  if (ts.isCallExpression(node) && node.expression.getText(appAst) === 'useEffect'
    && node.arguments[0]?.getText(appAst).includes("ipcRenderer.invoke('workspace-switcher:register')")) {
    registrationEffects.push(node.arguments[0]);
  }
  ts.forEachChild(node, visitApp);
}
visitApp(appAst);
assert.equal(registrationEffects.length, 1, 'one actual App switcher subscription owner');
const effectCode = transpile('module.exports=' + registrationEffects[0].getText(appAst));
// Run the caller's actual argument and synchronous post-switch focus/pending
// sequence. An invented options argument would miss a disconnected UI hunk.
const stripAst = parse('SpaceStrip.tsx', fs.readFileSync(stripPath, 'utf8'));
const stripCommits = [];
function visitStrip(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(stripAst) === 'commitSwitch') {
    stripCommits.push(node.initializer);
  }
  ts.forEachChild(node, visitStrip);
}
visitStrip(stripAst);
assert.equal(stripCommits.length, 1, 'one actual workflow-chip commit');
const stripCode = transpile('module.exports = id => { const commitSwitch = '
  + stripCommits[0].getText(stripAst) + '; commitSwitch(); };');
const normal = value => JSON.parse(JSON.stringify(value));
const ref = (tabId, projectId = 'namespace') => ({ projectId, tabId });

async function fixture(options = {}) {
  const outgoing = { ...spaces.emptySpaceLayout(),
    windowDisplayKey: 'screen', activeProjectId: 'namespace', focusedProjectId: 'namespace',
    activeSpaceTab: ref('away'), splitPanes: [{ ...ref('away'), windowId: 'away-window' }],
  };
  const incoming = { ...spaces.emptySpaceLayout(),
    windowDisplayKey: 'screen', activeProjectId: 'namespace', focusedProjectId: 'namespace',
    activeSpaceTab: ref('busy'), splitPanes: [{ ...ref('busy'), windowId: 'busy-window',
      tabs: [ref('busy'), ref('parked')], history: [ref('older')],
    }], ...options.incoming,
  };
  const ids = ['away', 'busy', 'parked', 'older'];
  while (ids.length < (options.tabCount || 4)) ids.push('retained-' + ids.length);
  const tabs = new Map(ids.map(id => [id, { id, name: id, tabType: 'terminal', commandType: 'codex',
    lastActivatedAt: 100, codexSessionId: 'same-sid-' + id, isAiBusy: id === 'busy',
    pendingDraft: 'same draft ' + id, undo: { id }, unknownSend: { id: 'H-' + id, replay: false },
  }]));
  const workspace = { projectId: 'namespace', projectPath: '/fixture', tabs,
    activeTabId: 'away', currentView: 'terminal', viewingSubAgentTabId: null,
    selectedTabIds: ['away'], tabHistory: ['away'], tabGroups: [],
  };
  const initial = { ...outgoing, workspaceDisplay: { key: 'screen', internal: false },
    isRestoring: false, organizationReady: true, view: 'workspace',
    activeSpaceId: 'away-flow',
    spaces: [{ id: 'away-flow', name: 'Away', layout: outgoing },
      { id: 'busy-flow', name: 'Busy', layout: incoming }],
    openProjects: new Map([['namespace', workspace]]), projectHistory: ['namespace'],
    globalTabMru: [ref('away'), ref('busy'), ref('parked')],
    tabWorkflowMembership: Object.fromEntries(ids.map(id => [id,
      { workflowId: id === 'away' ? 'away-flow' : 'busy-flow', revision: 1 }])),
    pendingTabWorkflowMembership: {}, tabCatalog: {},
    activeTabNavigationIntent: null, navigationRevision: 5, navigationMutationOwner: null,
  };
  initial.navigationKey = navigation.tabNavigationLocation(initial);
  if (Object.hasOwn(options, 'intent')) initial.activeTabNavigationIntent = options.intent;
  if (Object.hasOwn(options, 'navigationKey')) initial.navigationKey = options.navigationKey;
  const effects = [], writes = [], publications = [], captures = [];
  const dtoOperations = { tabDtoCalls: 0, rowsDtoCalls: 0, rowsMapped: 0 };
  const snapshotModule = { exports: {} };
  const snapshotImports = { '../../shared/workspace-switcher-contract.cjs': switcherContract,
    './tabSwitcherSelector.mjs': selector, './workflowVisuals.mjs': visuals };
  vm.runInNewContext(snapshotCode, { module: snapshotModule, exports: snapshotModule.exports,
    __dtoOperations: dtoOperations, require: specifier => {
      assert.ok(Object.hasOwn(snapshotImports, specifier), 'actual snapshot import: ' + specifier);
      return snapshotImports[specifier];
    },
  });
  const store = createStore((baseSet, get, api) => {
    const module = { exports: {} };
    vm.runInNewContext(storeCode, {
      module, baseSet, get, api, ...panes, ...spaces, ...displays, ...navigation,
      organizationPlacementIntent: placement.organizationPlacementIntent,
      switchSpaceInList: spaces.switchSpace, touchMru: mru.touchMru,
      isVisitWorthRecording: visits.isVisitWorthRecording,
      console: { log() {}, warn() {} }, performance,
      requestAnimationFrame: () => 1, markRendererActivity: () => () => {},
      // Named seams: persistence, renderer diagnostics and non-already-shown
      // activation. This fixture neither executes nor imitates those systems.
      saveTabs: (projectId, ownedTabs) => effects.push({ kind: 'save-tabs', projectId, ownedTabs }),
    });
    return { ...initial, ...module.exports,
      saveSession: () => effects.push({ kind: 'save-session' }),
      activateCenterTab: (projectId, tabId) => effects.push({ kind: 'activate', projectId, tabId }),
    };
  });
  store.subscribe(state => writes.push({ state, activeSpaceId: state.activeSpaceId,
    intent: state.activeTabNavigationIntent, navigationRevision: state.navigationRevision,
    navigationKey: state.navigationKey, mru: normal(state.globalTabMru),
  }));
  const projects = createStore(() => ({ projects: { namespace: { name: 'Project', icon: 'data:image/png;base64,AAAA' } } }));
  const ipcListeners = new Map(), missingListeners = new Set(), startupListeners = new Set();
  let initialized;
  const ready = new Promise(resolve => { initialized = resolve; });
  const ipcRenderer = {
    invoke: channel => { assert.equal(channel, 'workspace-switcher:register'); return Promise.resolve({ epoch: 'test-epoch' }); },
    send: (channel, value) => {
      if (channel === 'workspace-switcher:changed') {
        publications.push({ clock: normal(value), activeSpaceId: store.getState().activeSpaceId,
          mru: normal(store.getState().globalTabMru) });
        initialized();
      } else assert.equal(channel, 'workspace-switcher:unregister');
    },
    on: (channel, listener) => ipcListeners.set(channel, listener),
    removeListener: (channel, listener) => { if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel); },
  };
  const module = { exports: null }, workspaceSwitcherRef = { current: null };
  vm.runInNewContext(effectCode, {
    module, ipcRenderer, workspaceSwitcherRef, useWorkspaceStore: store, useProjectsStore: projects,
    // Counting a read does not cache, clone, skip or replace a production
    // projection. The actual snapshot's accepted scalar/fallback path runs.
    createWorkspaceSwitcherSnapshot: options => snapshotModule.exports.createWorkspaceSwitcherSnapshot({ ...options,
      readWorkspace: () => { const state = options.readWorkspace(); captures.push(state.activeSpaceId); return state; },
    }),
    getStartupRestoreProgress: () => ({ blocking: false, phase: 'complete' }),
    INBOX_PROJECT_NAME: 'Inbox', fileExistsVerdict: () => undefined,
    probeFiles: async (_paths, force) => assert.equal(force, true),
    subscribeMissingFiles: listener => { missingListeners.add(listener); return () => missingListeners.delete(listener); },
    subscribeStartupRestoreProgress: listener => { startupListeners.add(listener); return () => startupListeners.delete(listener); },
    console: { warn: (...args) => assert.fail(args.join(' ')) },
  });
  const dispose = module.exports();
  await ready;
  assert.ok(workspaceSwitcherRef.current);
  assert.equal(publications.length, 1);
  writes.length = 0; captures.length = 0; publications.length = 0;
  for (const key of Object.keys(dtoOperations)) dtoOperations[key] = 0;
  const stripEffects = [], switchQueuedRef = { current: true };
  const stripModule = { exports: null };
  vm.runInNewContext(stripCode, {
    module: stripModule, useWorkspaceStore: store, switchQueuedRef,
    setPending: pending => stripEffects.push({ kind: 'pending', pending }),
    useUIStore: { getState: () => ({ setActiveArea: area => stripEffects.push({ kind: 'active-area', area }) }) },
    requestFocusedWorkspacePrimaryInput: reason => stripEffects.push({ kind: 'primary-input', reason }),
    // The pre-existing fail-safe is recorded, not executed as an invented
    // scheduler. Store work and publication must finish in this call.
    window: { setTimeout: (_callback, delay) => { stripEffects.push({ kind: 'fail-safe', delay }); return 1; } },
  });
  return { store, effects, writes, publications, captures, projects, workspaceSwitcherRef,
    stripEffects, switchQueuedRef, dtoOperations, dispose, action: stripModule.exports,
    directAction: (id, options) => store.getState().switchWorkspaceSpace(id, options),
  };
}

test('settled 658-tab return spends no whole subscriber pass on the old workflow before planning', async t => {
  const f = await fixture({ tabCount: 658 }); t.after(f.dispose);
  const before = f.store.getState(), tab = before.openProjects.get('namespace').tabs.get('busy');
  const kept = { ...tab };
  f.action('busy-flow');
  if (process.env.NOTED_WORKFLOW_OPERATION_REPORT) {
    fs.writeFileSync(process.env.NOTED_WORKFLOW_OPERATION_REPORT, JSON.stringify({
      engine: { node: process.version, v8: process.versions.v8 },
      source: Object.fromEntries([['store', sourcePath], ['strip', stripPath]].map(([key, filename]) => {
        const bytes = fs.readFileSync(filename);
        return [key, { path: filename, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
      })),
      scope: 'complete synchronous actual commitSwitch after initialization; synthetic 658-tab fixture',
      subscriberPulses: f.writes.length, subscriberWorkflowOrder: f.writes.map(write => write.activeSpaceId),
      captureCalls: f.captures.length, captureWorkflowOrder: f.captures,
      dtoOperations: f.dtoOperations,
      semanticPublications: f.publications.map(p => ({ revision: p.clock.revision,
        activeSpaceId: p.activeSpaceId, mru: p.mru.map(x => x.tabId) })),
      stripEffects: f.stripEffects,
      limit: 'operation counts, not timings; persistence/DOM/provider/physical input/compositor are named seams',
    }, null, 2) + '\n');
  }
  assert.deepEqual(f.writes.map(write => write.activeSpaceId), ['busy-flow', 'busy-flow'],
    'only layout and real MRU writes: equal-null cancellation must not fan out to retained subscribers');
  assert.deepEqual(f.captures, ['busy-flow', 'busy-flow']);
  assert.equal(f.dtoOperations.tabDtoCalls, 2 * 658, 'one complete DTO pass physically removed');
  assert.equal(f.dtoOperations.rowsDtoCalls, 2);
  const after = f.store.getState();
  assert.equal(after.openProjects, before.openProjects);
  assert.equal(after.openProjects.get('namespace').tabs, before.openProjects.get('namespace').tabs);
  assert.equal(after.openProjects.get('namespace').tabs.get('busy'), tab);
  assert.equal(tab.codexSessionId, kept.codexSessionId); assert.equal(tab.pendingDraft, kept.pendingDraft);
  assert.equal(tab.undo, kept.undo); assert.equal(tab.unknownSend, kept.unknownSend); assert.equal(tab.isAiBusy, true);
  assert.equal(after.activeSpaceTab.tabId, 'busy');
  assert.equal(after.splitPanes[after.splitFocusedIndex].tabId, 'busy');
  assert.equal(after.navigationRevision, before.navigationRevision + 1);
  assert.deepEqual(normal(after.splitPanes[0].history), [ref('older')]);
  assert.deepEqual(panes.paneTabs(after.splitPanes[0]).map(x => x.tabId), ['busy', 'parked']);
  assert.equal(f.effects.filter(effect => effect.kind === 'activate').length, 0);
  assert.equal(f.effects.filter(effect => effect.kind === 'save-tabs').length, 1);
  assert.deepEqual(f.stripEffects, [
    { kind: 'pending', pending: false }, { kind: 'active-area', area: 'workspace' },
    { kind: 'primary-input', reason: 'workflow-strip-click' }, { kind: 'fail-safe', delay: 600 },
  ]);
  assert.equal(f.switchQueuedRef.current, false);
});

test('actual App publication remains synchronous: destination first, then the real MRU revision', async t => {
  const f = await fixture(); t.after(f.dispose);
  f.action('busy-flow');
  assert.deepEqual(f.publications.map(p => [p.clock.revision, p.activeSpaceId, p.mru[0].tabId]),
    [[2, 'busy-flow', 'away'], [3, 'busy-flow', 'busy']]);
  f.action('away-flow');
  assert.deepEqual(f.publications.slice(2).map(p => [p.clock.revision, p.activeSpaceId, p.mru[0].tabId]),
    [[4, 'away-flow', 'busy'], [5, 'away-flow', 'away']]);
});

for (const target of ['away-flow', 'absent-flow']) {
  test('settled same/missing target has no no-op notification: ' + target, async t => {
    const f = await fixture(); t.after(f.dispose); const before = f.store.getState();
    f.action(target);
    assert.equal(f.store.getState(), before);
    assert.equal(f.writes.length, 0); assert.equal(f.captures.length, 0);
    assert.equal(f.publications.length, 0); assert.equal(f.effects.length, 0);
  });
  test('a genuine pending navigation is cancelled synchronously even for ' + target, async t => {
    const intent = { id: 'pending-owner', tabId: 'busy' };
    const f = await fixture({ intent }); t.after(f.dispose);
    f.action(target);
    assert.equal(f.store.getState().activeTabNavigationIntent, null);
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].intent, null);
    assert.equal(f.captures.length, 1); assert.equal(f.publications.length, 0);
    assert.equal(f.store.getState().navigationRevision, 5);
  });
}

test('a genuine pending intent retires before a different workflow is published', async t => {
  const f = await fixture({ intent: { id: 'pending-owner', tabId: 'older' } }); t.after(f.dispose);
  f.action('busy-flow');
  assert.deepEqual(f.writes.map(write => [write.activeSpaceId, write.intent]),
    [['away-flow', null], ['busy-flow', null], ['busy-flow', null]]);
});

test('owned navigation retains its exact intent and mutation owner through return', async t => {
  const intent = { id: 'pending-owner', tabId: 'busy' };
  const f = await fixture({ intent }); t.after(f.dispose);
  f.store.getState().__withOwnedTabNavigation(intent.id, () => f.action('busy-flow'));
  assert.equal(f.store.getState().activeTabNavigationIntent, intent);
  assert.equal(f.store.getState().navigationMutationOwner, intent.id);
  assert.deepEqual(f.writes.map(write => write.activeSpaceId), ['busy-flow', 'busy-flow']);
});

for (const key of [null, undefined, 'stale-location']) {
  test('the old setter still adopts an absent/stale navigation key: ' + String(key), async t => {
    const f = await fixture({ navigationKey: key }); t.after(f.dispose);
    f.action('away-flow');
    assert.equal(f.writes.length, 1);
    assert.equal(f.store.getState().navigationKey, navigation.tabNavigationLocation(f.store.getState()));
    assert.equal(f.store.getState().navigationRevision, key === 'stale-location' ? 6 : 5);
  });
}

test('a legacy undefined intent still becomes null through the original setter', async t => {
  const f = await fixture({ intent: undefined }); t.after(f.dispose);
  f.action('absent-flow');
  assert.equal(f.writes.length, 1); assert.equal(f.store.getState().activeTabNavigationIntent, null);
});

test('in-place navigation fields still cross the old navigation revision boundary', async t => {
  const f = await fixture(); t.after(f.dispose);
  f.store.getState().openProjects.get('namespace').currentView = 'home';
  f.action('away-flow');
  assert.equal(f.writes.length, 1); assert.equal(f.store.getState().navigationRevision, 6);
  assert.equal(f.store.getState().navigationKey, navigation.tabNavigationLocation(f.store.getState()));
});

for (const change of [{ windowId: 'replaced-window' }, { tabId: 'parked' }, { displayHidden: true }]) {
  test('in-place focused pane change retains the old revision boundary: ' + Object.keys(change)[0], async t => {
    const f = await fixture(); t.after(f.dispose);
    const state = f.store.getState();
    Object.assign(state.splitPanes[state.splitFocusedIndex], change);
    f.action('away-flow');
    assert.equal(f.writes.length, 1); assert.equal(f.store.getState().navigationRevision, 6);
    assert.equal(f.store.getState().navigationKey, navigation.tabNavigationLocation(f.store.getState()));
  });
}

test('a synchronous cancellation subscriber keeps its reentrant intent and exact event order', async t => {
  const f = await fixture({ intent: { id: 'old-owner', tabId: 'older' } }); t.after(f.dispose);
  const nextIntent = { id: 'reentrant-owner', tabId: 'parked' };
  let reentered = false;
  const unsubscribe = f.store.subscribe(state => {
    if (!reentered && state.activeTabNavigationIntent === null) {
      reentered = true;
      f.store.setState({ activeTabNavigationIntent: nextIntent });
    }
  });
  t.after(unsubscribe);
  f.action('away-flow');
  assert.equal(f.store.getState().activeTabNavigationIntent, nextIntent);
  assert.deepEqual(f.writes.map(write => [write.activeSpaceId, write.intent]),
    [['away-flow', null], ['away-flow', nextIntent]]);
  assert.deepEqual(f.captures, ['away-flow', 'away-flow']);
  assert.equal(f.publications.length, 0);
});

for (const target of ['away-flow', 'absent-flow', 'busy-flow']) {
  test('shared callers retain the original settled notification sequence: ' + target, async t => {
    const f = await fixture(); t.after(f.dispose);
    f.directAction(target);
    const expected = target === 'busy-flow' ? ['away-flow', 'busy-flow', 'busy-flow'] : ['away-flow'];
    assert.deepEqual(f.writes.map(write => write.activeSpaceId), expected);
    assert.deepEqual(f.captures, expected);
  });
  test('shared callers retain an unpublished in-place metadata publication: ' + target, async t => {
    const f = await fixture(); t.after(f.dispose);
    const state = f.store.getState();
    state.openProjects.get('namespace').tabs.get('busy').name = 'Unpublished title';
    state.spaces[1].name = 'Unpublished workflow name';
    f.directAction(target);
    assert.deepEqual(f.publications.map(p => [p.clock.revision, p.activeSpaceId]), target === 'busy-flow'
      ? [[2, 'away-flow'], [3, 'busy-flow'], [4, 'busy-flow']] : [[2, 'away-flow']]);
    const rows = await f.workspaceSwitcherRef.current.read({ epoch: 'test-epoch', scope: 'desktop' });
    assert.ok(rows.rows.some(row => row.kind === 'tab' && row.title === 'Unpublished title'));
    assert.ok(rows.rows.some(row => row.kind === 'workflow' && row.title === 'Unpublished workflow name'));
  });
}

test('a non-opted options object cannot omit the shared publication boundary', async t => {
  const f = await fixture(); t.after(f.dispose);
  f.directAction('away-flow', {});
  assert.equal(f.writes.length, 1); assert.equal(f.captures.length, 1);
});

test('same-reference Map/Tab changes publish fresh values synchronously before and after return', async t => {
  const f = await fixture(); t.after(f.dispose);
  const state = f.store.getState(), ownedMap = state.openProjects, tabMap = ownedMap.get('namespace').tabs;
  tabMap.get('busy').name = 'fresh background title';
  state.spaces[1].name = 'Renamed workflow';
  f.store.setState({ openProjects: ownedMap });
  assert.equal(f.publications.length, 1, 'no identity cache may swallow a real store notification');
  assert.equal(f.publications[0].clock.revision, 2);
  f.action('busy-flow');
  assert.deepEqual(f.publications.map(p => p.clock.revision), [2, 3, 4]);
  const rows = await f.workspaceSwitcherRef.current.read({ epoch: 'test-epoch', scope: 'desktop' });
  assert.ok(rows.rows.some(row => row.kind === 'tab' && row.tabId === 'busy' && row.title === 'fresh background title'));
  assert.ok(rows.rows.some(row => row.kind === 'workflow' && row.title === 'Renamed workflow'));
  const before = f.publications.length;
  tabMap.get('busy').name = 'second title';
  f.store.setState({ openProjects: ownedMap });
  assert.equal(f.publications.length, before + 1);
  assert.equal(f.publications.at(-1).clock.revision, 5);
});

test('a closed saved selection still sanitizes the incoming layout through the original planner', async t => {
  const f = await fixture(); t.after(f.dispose);
  const map = f.store.getState().openProjects;
  map.get('namespace').tabs.delete('busy');
  f.store.setState({ openProjects: map });
  f.writes.length = 0;
  f.action('busy-flow');
  assert.equal(f.store.getState().activeSpaceId, 'busy-flow');
  assert.equal(f.store.getState().activeSpaceTab, null);
  assert.ok(f.store.getState().splitPanes.every(pane => pane.tabId !== 'busy'));
  assert.equal(f.effects.filter(effect => effect.kind === 'activate').length, 0);
});

test('Home and non-already-shown activation retain their original substantive route', async t => {
  const home = await fixture(); t.after(home.dispose);
  home.store.setState({ view: 'dashboard' }); home.writes.length = 0;
  home.action('away-flow');
  assert.equal(home.store.getState().view, 'workspace');
  assert.equal(home.writes.length, 1);
  const legacy = await fixture({ incoming: { splitPanes: [] } }); t.after(legacy.dispose);
  legacy.action('busy-flow');
  assert.deepEqual(legacy.effects.filter(effect => effect.kind === 'activate'),
    [{ kind: 'activate', projectId: 'namespace', tabId: 'busy' }]);
});
