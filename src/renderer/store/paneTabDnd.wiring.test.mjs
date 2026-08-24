import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const workspace = path.join(renderer, 'components', 'Workspace');
const read = (file) => fs.readFileSync(file, 'utf8');

const chip = read(path.join(workspace, 'PaneTabChip.tsx'));
const strip = read(path.join(workspace, 'PaneTabStrip.tsx'));
const body = read(path.join(workspace, 'PaneTabBodyDropZone.tsx'));
const area = read(path.join(workspace, 'TerminalArea.tsx'));
const tabBar = read(path.join(workspace, 'TabBar.tsx'));
const app = read(path.join(renderer, 'App.tsx'));
const store = read(path.join(here, 'useWorkspaceStore.ts'));
const shared = read(path.resolve(here, '../../../../noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js'));

test('pane chips, headers and bodies share one explicit drag protocol', () => {
  assert.match(chip, /PANE_TAB_DND_TYPE/);
  assert.match(strip, /canDrop: \(\{ source \}\) => source\.data\.type === PANE_TAB_DND_TYPE/);
  assert.match(strip, /data-pane-tab-drop-zone="strip"/);
  assert.match(body, /data-pane-tab-drop-zone="body"/);
  assert.match(body, /В конец окна/);
  assert.match(area, /<PaneTabBodyDropZone paneIndex=\{inPane \? visiblePaneIndex : null\}/);
  assert.match(area, /<PaneTabBodyDropZone paneIndex=\{paneIndex\}/);
  assert.doesNotMatch(chip, /dropTargetForElements/,
    'chips are drag sources; the stable strip root is the only horizontal target owner');
  assert.match(strip, /ref=\{stripRootRef\}/);
});

test('sidebar Cmd resolves a pane target before shared folder navigation', () => {
  const externalAt = shared.indexOf('let externalTarget = null;');
  const navigationAt = shared.indexOf('if (current.navigationMode) {', externalAt);
  assert.ok(externalAt > 0 && navigationAt > externalAt);
  assert.match(shared, /metaKey: !!\(event\?\.metaKey \|\| drag\.navigationMode\)/);
  assert.match(tabBar, /if \(metaKey\) \{[\s\S]{0,500}resolvePaneTabDropTarget/);
  assert.match(tabBar, /owner: 'sidebar'/);
  assert.match(tabBar, /commitPaneTabDrop/);
});

test('drag payload follows the destination contract: project subtree, pane roots', () => {
  assert.match(tabBar, /paneRootTabIds: payload\.rootIds/);
  assert.match(tabBar, /projectTransferTabIds: payload\.projectIds/);
  assert.match(tabBar, /const paneRootTabIds = resolveOutlineTabDragPayload\(sourceNode\)\.rootIds/);
  assert.match(tabBar, /entries: paneRootTabIds\.map\(\(tabId\) => \(\{ projectId, tabId \}\)\)/);
  assert.match(tabBar, /const projectTabIds = resolveOutlineTabDragPayload\(sourceNode\)\.projectIds/);
  assert.match(app, /tabData\.projectTransferTabIds \|\| tabData\.selectedTabIds/);
  assert.match(app, /data-tab-project-drop-count=/);
  assert.match(tabBar, /data-tab-drag-subtree-count=/);
});

test('project ownership move preserves hierarchy inside the payload and detaches only true orphans', () => {
  const start = store.indexOf('moveTabsToProject: async (sourceProjectId');
  const end = store.indexOf('\n  moveTabGroupToProject:', start);
  const bodyText = store.slice(start, end);
  assert.match(bodyText, /const movingSet = new Set\(movingIds\)/);
  assert.match(bodyText, /!tab\.visualParentTabId \|\| !movingSet\.has\(tab\.visualParentTabId\)/);
  assert.match(bodyText, /candidate\.visualParentTabId && !src\.tabs\.has\(candidate\.visualParentTabId\)/);
});

test('window drop is one pane-model commit, not clear then append', () => {
  const start = store.indexOf('moveTabsToWindowStrip: (paneIndex');
  const end = store.indexOf('\n  swapSplitPanes:', start);
  const bodyText = store.slice(start, end);
  assert.match(bodyText, /moveTabsToPane\(st\.splitPanes/);
  assert.match(bodyText, /set\(\{[\s\S]{0,180}splitPanes: result\.panes,[\s\S]{0,120}splitFocusedIndex: paneIndex/);
  assert.match(bodyText, /dropTabsFromOtherSpaces\([\s\S]{0,180}movedTabIds/);
  assert.doesNotMatch(bodyText, /clearTabFromSplitPane|addTabToSplitPaneStrip/);
});

test('pane-to-sidebar handoff adopts the same gesture and can detach every workflow placement', () => {
  assert.match(tabBar, /externalDrag: externalPaneDragRequest/);
  assert.match(tabBar, /commitExternalDrag\?\.\('pane-tab-pointerup'\)/);
  assert.match(tabBar, /zone: 'sidebar-end'/);
  assert.match(store, /detachTabsFromWorkspaceWindows: \(rawTabIds\)/);
  const detachStart = store.indexOf('detachTabsFromWorkspaceWindows: (rawTabIds)');
  const detachEnd = store.indexOf('\n  swapSplitPanes:', detachStart);
  assert.match(store.slice(detachStart, detachEnd), /dropTabsFromOtherSpaces\([\s\S]*tabIds/);
  assert.match(tabBar, /externalDragReplacement: true/);
  assert.match(shared, /controlledSource\?\.externalDragReplacement === true/);
});

test('every release proof closes pointer, navigation and pane-drag bridges together', () => {
  assert.match(app, /const finishPaneGesture = \(reason: string\) => \{/);
  assert.match(app, /const drag = getPaneTabDragSnapshot\(\)/);
  assert.match(app, /paneTabDropTargetContainsPoint/);
  assert.match(app, /commitPaintedPaneTabDrop\(rootTabId\)/);
  assert.match(app, /finishPaneTabPointer\(\);[\s\S]{0,100}endPaneTabDrag\(rootTabId\)/);
  assert.match(app, /if \(event\.buttons === 0\) finishPaneGesture\('buttons-zero'\)/);
  assert.match(app, /const onPointerCancel = \(\) => cancelPaneGesture\(\)/);
});

test('plain sidebar hierarchy commit cannot rewrite pane or workflow ownership', () => {
  const start = store.indexOf('applyTabLayout: (projectId');
  const end = store.indexOf('\n  updateTabCwd:', start);
  const bodyText = store.slice(start, end);
  assert.doesNotMatch(bodyText, /splitPanes\s*:|activeSpaceId\s*:|splitFocusedIndex\s*:|activeTabId\s*:/);
});

test('release commits the painted pane target instead of resolving again', () => {
  assert.match(strip, /commitPaintedPaneTabDrop\(sourceState\.rootTabId\)/);
  assert.match(body, /commitPaintedPaneTabDrop\(sourceState\.rootTabId\)/);
  assert.doesNotMatch(chip, /endPaneTabDrag\(tabId\)/,
    'source cleanup must not erase the painted target before the global release barrier');
});

test('drag keeps overflow geometry stable, reveals body append and supports horizontal edge scroll', () => {
  assert.match(strip, /if \(getPaneTabDragSnapshot\(\)\.active\) return false/);
  assert.match(strip, /pendingRevealReasonRef\.current = 'body-drop-preview'/);
  assert.match(strip, /revealChip\(rootTabId\)/);
  assert.match(strip, /data-pane-strip-end-reserve/);
  const bridge = read(path.join(renderer, 'utils/paneTabDragBridge.ts'));
  assert.match(bridge, /horizontalDragAutoScrollDelta/);
  assert.match(bridge, /const dragCenterX = Number\(clientX\) \|\| 0/);
  assert.doesNotMatch(bridge, /anchorDeltaX|effectiveClientX/);
  assert.match(chip, /getOffset: centerUnderPointer/);
  assert.match(chip, /data-pane-tab-native-drag-preview/);
  assert.match(chip, /data-pane-chip-drag-placeholder/);
});
