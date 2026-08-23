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

  assert.match(workspace, /<TabSidebar[\s\S]{0,400}processStatus=\{processStatus\}[\s\S]{0,400}busyTabs=\{busyTabs\}/);
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
  assert.match(area, /opacity: shownInPane \? 1 : 0/);
  assert.match(area, /willChange: 'opacity'/);
  assert.match(surface, /const presentationGeometryStable = previousGeometryKeyRef\.current === geometryKey;/);
  assert.match(surface, /HISTORY_SURFACE_PRESENTATION_EVENT/);
  assert.match(history, /if \(!preservePresentationGeometry\) \{[\s\S]{0,100}initialLoadDoneRef\.current = false;/);
  assert.match(terminal, /effectiveActive \|\| keepPromptQueueMounted/);
  assert.match(chrome, /const h = stripWrap[\s\S]{0,100}getBoundingClientRect\(\)[\s\S]{0,80}: rowH/,
    'one-row headers must not force workspace layout');
  assert.match(strip, /revealActiveFromCache/);
  const activeEffect = strip.slice(strip.indexOf('useLayoutEffect(() => {\n    revealActiveFromCache'));
  assert.doesNotMatch(activeEffect.slice(0, 180), /offsetLeft|offsetWidth/,
    'active space changes must consume cached chip geometry');
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
