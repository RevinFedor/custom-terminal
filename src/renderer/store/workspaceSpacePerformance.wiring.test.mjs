import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(new URL(import.meta.url).pathname);
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const read = (name) => fs.readFileSync(path.join(workspaceDir, name), 'utf8');

test('space switch reuses app-wide tab status instead of polling the new sidebar project', () => {
  const workspace = read('Workspace.tsx');
  const sidebar = read('TabSidebar.tsx');
  const tabBar = read('TabBar.tsx');
  const area = read('TerminalArea.tsx');
  const chrome = read('SplitPaneChrome.tsx');
  const strip = read('PaneTabStrip.tsx');
  const chip = read('PaneTabChip.tsx');
  const signals = read('TabSignals.tsx');

  assert.match(workspace, /<PersistentTabSidebarStack[\s\S]{0,500}processStatus=\{processStatus\}[\s\S]{0,400}busyTabs=\{busyTabs\}/);
  assert.match(sidebar, /sharedProcessStatus=\{processStatus\}/);
  assert.match(sidebar, /sharedBusyTabs=\{busyTabs\}/);
  assert.match(tabBar, /const processStatus: ReadonlyMap<string, boolean> = sharedProcessStatus \|\| localProcessStatus;/);

  const syncGuard = tabBar.indexOf('if (sharedProcessStatus) return;');
  const batchInvoke = tabBar.indexOf("ipcRenderer.invoke('terminal:getCommandStates'", syncGuard);
  assert.ok(syncGuard >= 0 && batchInvoke > syncGuard,
    'the shared snapshot must short-circuit before the full TabBar batch');

  // The same rule must reach pane chips. Before this chain existed, changing
  // workflow retargeted every pane-index chrome and each chip independently
  // called terminal:getCommandState; production main issued six process-tree
  // lookups on every visit.
  assert.match(workspace, /<TerminalArea[\s\S]{0,180}sharedActivity=\{sharedTabActivity\}/);
  assert.match(area, /<SplitPaneAttachRow[\s\S]{0,220}sharedActivity=\{sharedActivity\}/);
  assert.match(chrome, /<PaneTabStrip[\s\S]{0,400}sharedActivity=\{sharedActivity\}/);
  assert.match(strip, /<PaneTabChip[\s\S]{0,500}sharedActivity=\{sharedActivity\}/);
  assert.match(chip, /useTabActivitySignals\(tabId, sharedActivity\)/);
  assert.match(signals, /if \(hasSharedProcess && hasSharedBusy\) return undefined;/);
});

test('dormant pane keeps its portal host and exact presentation geometry', () => {
  const area = read('TerminalArea.tsx');
  const surface = read('SplitPaneSurface.tsx');
  const history = read('HistoryPanel.tsx');
  const terminal = read('Terminal.tsx');
  const chrome = read('SplitPaneChrome.tsx');
  const strip = read('SpaceStrip.tsx');

  assert.match(area, /promptQueuePortalHostId=\{inPane \? splitPaneQueueHostId\(tab\.id\) : promptQueuePortalHostId\}/);
  assert.match(area, /const paneRect = inPane[\s\S]{0,180}splitPaneRectStyle\(layoutPaneIndex, layoutPanes, layoutSizes\)/);
  assert.match(area, /const paneStacked = inPane && paneIsStacked\(layoutPanes, layoutPaneIndex\)/);
  assert.match(area, /opacity: terminalSurfacePresented \? 1 : 0/);
  assert.match(area, /willChange: 'opacity'/);
  assert.match(surface, /const presentationGeometryStable = previousGeometryKeyRef\.current === geometryKey;/);
  assert.match(surface, /HISTORY_SURFACE_PRESENTATION_EVENT/);
  assert.match(history, /if \(!preservePresentationGeometry\) \{[\s\S]{0,100}initialLoadDoneRef\.current = false;/);
  assert.match(terminal, /effectiveActive \|\| keepPromptQueueMounted/);
  const headerHeightStart = chrome.indexOf('// Шапка СООБЩАЕТ окну свою настоящую высоту.');
  const headerHeightEnd = chrome.indexOf('// Clamp the strip menu into the window', headerHeightStart);
  const headerHeightPath = chrome.slice(headerHeightStart, headerHeightEnd);
  assert.doesNotMatch(headerHeightPath, /getBoundingClientRect\(/,
    'neither one-row nor wrapped headers may force workspace layout during the switch commit');
  assert.match(headerHeightPath, /new ResizeObserver/);
  assert.match(headerHeightPath, /}, \[paneIndex, stripWrap, rowH\]\);/);
  assert.match(strip, /revealActiveFromCache/);
  const activeEffect = strip.slice(strip.indexOf('useLayoutEffect(() => {\n    revealActiveFromCache'));
  assert.doesNotMatch(activeEffect.slice(0, 180), /offsetLeft|offsetWidth/,
    'active space changes must consume cached chip geometry');
});

test('hidden pane terminals prewarm through a completion-serial queue and expose paint attribution', () => {
  const area = read('TerminalArea.tsx');
  const surface = read('SplitPaneSurface.tsx');
  const terminal = read('Terminal.tsx');

  assert.match(area, /isActiveProject=\{persistentPane \|\| latched \|\| actualProjectActive\}/,
    'a hidden persistent pane must be eligible for xterm warm-init before first presentation');
  assert.match(terminal, /let terminalWarmRunning = false;/);
  assert.match(terminal, /terminalWarmRunning = true;[\s\S]{0,500}await init\(\)/,
    'the next xterm may start only after the previous warm init actually settles');
  assert.match(terminal, /getStartupRestoreProgress\(\)\.blocking/,
    'hidden xterm prewarm must not compete with auto-resume admission');
  assert.match(terminal, /terminal-present:/,
    'xterm drain/paint after hydration must not remain none-marked');
  assert.match(surface, /pane-prewarm:/,
    'background surface construction must identify its own React commit');
  assert.match(surface, /subscribeStartupRestoreProgress/,
    'dormant History/Timeline prewarm starts only after startup admission is complete');
  assert.match(surface, /presented=\{initialPresentedRef\.current\}[\s\S]{0,160}presentationExternallyManaged/,
    'background History pixels and first visible History must share one physical Virtuoso mode');
  assert.doesNotMatch(surface, /presentationPrimed|setPresentationPrimed/,
    'first workflow visit must not discard the DOM produced by background prewarm');
  assert.match(area, /\[Perf:TerminalAreaCommit\]/);
  assert.match(area, /\[Perf:TerminalAreaPaint\]/);
});

test('workflow switch log separates planning, store write, activation and paint frames', () => {
  const store = fs.readFileSync(path.join(here, '..', 'store', 'useWorkspaceStore.ts'), 'utf8');
  const activity = fs.readFileSync(path.join(here, '..', 'utils', 'rendererActivityTrail.ts'), 'utf8');
  const probe = fs.readFileSync(path.join(here, '..', 'utils', 'perfFreezeProbe.ts'), 'utf8');

  assert.match(store, /\[Perf:WorkflowSwitchStart\]/);
  assert.match(store, /planMs=/);
  assert.match(store, /setMs=/);
  assert.match(store, /activationMs=/);
  assert.match(store, /\[Perf:WorkflowSwitchFrame2\]/);
  assert.match(store, /\[Perf:TabSwitchStart\]/);
  assert.match(store, /activePointerMs=/);
  assert.match(store, /mruMs=/);
  assert.match(store, /spaceRouteMs=/);
  assert.match(store, /placementMs=/);
  assert.match(store, /finalSetMs=/);
  assert.match(activity, /export function recentRendererActivities/);
  assert.match(probe, /recentRendererActivities\(taskStartAbs\)/);
});

test('warm workflow switch performs no synchronous sidebar geometry read', () => {
  const tabBar = read('TabBar.tsx');
  const restoreEffectStart = tabBar.indexOf('// Applying the offset is not a single-shot operation');
  const restoreEffectEnd = tabBar.indexOf('// The user always wins over a pending restore', restoreEffectStart);
  assert.ok(restoreEffectStart >= 0 && restoreEffectEnd > restoreEffectStart);
  const restoreEffect = tabBar.slice(restoreEffectStart, restoreEffectEnd);
  const observerAt = restoreEffect.indexOf('const observer = new ResizeObserver');
  assert.ok(observerAt >= 0, 'restore remains event-driven by ResizeObserver');
  assert.doesNotMatch(
    restoreEffect.slice(0, observerAt),
    /applyPendingRestore\(\)/,
    'project switch must not force scrollHeight/clientHeight before observer delivery',
  );

  const sharedDndPath = path.resolve(
    here,
    '../../../../noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js',
  );
  const sharedDnd = fs.readFileSync(sharedDndPath, 'utf8');
  const effectStart = sharedDnd.indexOf('const renderedRows = rows.map');
  const changedBranch = sharedDnd.indexOf('if (!layoutChanged)', effectStart);
  const realGeometryRead = sharedDnd.indexOf('scrollTop: scroller.scrollTop', changedBranch);
  const skippedBranch = sharedDnd.indexOf('if (skippedReason)', changedBranch);
  const skippedReturn = sharedDnd.indexOf('return undefined;', skippedBranch);
  assert.ok(effectStart >= 0 && changedBranch > effectStart);
  assert.ok(skippedBranch > changedBranch && skippedReturn > skippedBranch);
  assert.ok(realGeometryRead > skippedReturn,
    'DND may read scrollTop only after proving that a captured FLIP will run');
});
