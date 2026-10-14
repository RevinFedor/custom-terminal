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
const sidebarCursorChip = read(path.join(workspace, 'SidebarTabDragCursorChip.tsx'));
const app = read(path.join(renderer, 'App.tsx'));
const store = read(path.join(here, 'useWorkspaceStore.ts'));
const shared = read(path.resolve(here, '../../../vendor/noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js'));
const sidebarBridge = read(path.join(renderer, 'utils/sidebarTabDragBridge.mjs'));
const pointerGesture = read(path.join(renderer, 'utils/paneTabPointerGesture.ts'));

test('pane chips, headers and bodies share one explicit drag protocol', () => {
  assert.match(chip, /bindPaneTabPointerDrag/);
  assert.match(strip, /canDrop: \(\{ source \}\) =>[\s\S]{0,100}source\.data\.type === PANE_TAB_DND_TYPE/);
  assert.match(strip, /!element\.closest\('\[data-pane-focus-isolated="1"\]'\)/);
  assert.match(strip, /data-pane-tab-drop-zone="strip"/);
  assert.match(body, /data-pane-tab-drop-zone=\{enabled \? 'body' : undefined\}/);
  assert.match(body, /!state\.splitPanes\[paneIndex\]\.displayHidden/);
  assert.match(body, /В конец окна/);
  assert.match(area, /data-pane-tab-drop-host=\{paneIndex\}/);
  assert.match(area, /<PaneTabBodyDropZone paneIndex=\{paneIndex\}/);
  assert.doesNotMatch(area, /<PaneTabBodyDropZone paneIndex=\{inPane \? visiblePaneIndex : null\}/,
    'persistent hidden tab trees must not keep active body drop targets');
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
  assert.match(tabBar, /externalDrag: externalOutlineDragRequest/);
  assert.match(tabBar, /commitExternalDrag\?\.\('pane-tab-pointerup'\)/);
  assert.match(tabBar, /zone: 'sidebar-end'/);
  assert.match(store, /detachTabsFromWorkspaceWindows: \(rawTabIds\)/);
  const detachStart = store.indexOf('detachTabsFromWorkspaceWindows: (rawTabIds)');
  const detachEnd = store.indexOf('\n  swapSplitPanes:', detachStart);
  assert.match(store.slice(detachStart, detachEnd), /dropTabsFromOtherSpaces\([\s\S]*tabIds/);
  assert.match(tabBar, /externalDragReplacement: true/);
  assert.match(shared, /controlledSource\?\.externalDragReplacement === true/);
});

test('sidebar project navigation hands the exact root and subtree to the destination host', () => {
  assert.match(tabBar, /beginSidebarTabDrag\(\{/);
  assert.match(tabBar, /const tabIds = resolveOutlineTabDragPayload\(sourceNode\)\.projectIds/);
  assert.match(tabBar, /const sidebarCrossProjectProjection = useMemo/);
  assert.match(tabBar, /const sidebarDragProjectionKey = getSidebarTabDragProjectionKey\(sidebarDragOrigin\)/);
  assert.doesNotMatch(tabBar, /projectId, sidebarDragOrigin\.revision\]\)/);
  assert.match(tabBar, /<SidebarTabDragCursorChip enabled=/);
  assert.match(sidebarCursorChip, /data-sidebar-tab-drag-cursor-chip/);
  assert.match(sidebarCursorChip, /sidebarDragCursorChip\.count > 1/);
  assert.match(sidebarCursorChip, /pointerEvents: 'none'/);
  assert.match(tabBar, /menuOnlyForProject[\s\S]{0,120}focusedSidebarProjectId !== projectId/);
  assert.match(tabBar, /disabled: menuOnlyForProject \|\| !isVerticalLayout/);
  assert.match(tabBar, /externalSidebarSource: metadata,[\s\S]{0,100}externalDragReplacement: true/);
  assert.match(tabBar, /ownerKey: `sidebar-project:\$\{sidebarDragOrigin\.sessionId\}:\$\{projectId\}`/);
  assert.match(tabBar, /const externalOutlineDragRequest = externalPaneDragRequest \|\| externalSidebarDragRequest/);
  assert.match(tabBar, /tabOutlineDnd\.cancel\('cross-project-owner-transferred'\)/);
  assert.match(sidebarBridge, /historyForegroundPriority\.beginInteraction/);
  assert.match(sidebarBridge, /pointerup[\s\S]*pointercancel[\s\S]*mouseup[\s\S]*dragend/);
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

test('drag keeps wrapped row geometry and immediate pointer preview without edge scrolling', () => {
  assert.doesNotMatch(strip, /revealChip|data-pane-strip-end-reserve/);
  const bridge = read(path.join(renderer, 'utils/paneTabDragBridge.ts'));
  assert.doesNotMatch(bridge, /horizontalDragAutoScrollDelta/);
  assert.match(bridge, /wrap: true/);
  assert.match(bridge, /const dragCenterX = Number\(clientX\) \|\| 0/);
  assert.doesNotMatch(bridge, /anchorDeltaX|effectiveClientX/);
  assert.match(pointerGesture, /createHorizontalRowDragPreview/);
  assert.match(pointerGesture, /data(set)?\.paneTabPointerDragPreview/);
  assert.match(chip, /data-pane-chip-drag-placeholder/);
});
