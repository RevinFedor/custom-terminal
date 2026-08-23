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
const store = read(path.join(here, 'useWorkspaceStore.ts'));
const shared = read(path.resolve(here, '../../../../noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js'));

test('pane chips, headers and bodies share one explicit drag protocol', () => {
  assert.match(chip, /PANE_TAB_DND_TYPE/);
  assert.match(chip, /source\.data\.tabId !== tabId \|\| previewOnly/);
  assert.match(strip, /data-pane-tab-drop-zone="strip"/);
  assert.match(body, /data-pane-tab-drop-zone="body"/);
  assert.match(body, /В конец окна/);
  assert.match(area, /<PaneTabBodyDropZone paneIndex=\{inPane \? visiblePaneIndex : null\}/);
  assert.match(area, /<PaneTabBodyDropZone paneIndex=\{paneIndex\}/);
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

test('plain sidebar hierarchy commit cannot rewrite pane or workflow ownership', () => {
  const start = store.indexOf('applyTabLayout: (projectId');
  const end = store.indexOf('\n  updateTabCwd:', start);
  const bodyText = store.slice(start, end);
  assert.doesNotMatch(bodyText, /splitPanes\s*:|activeSpaceId\s*:|splitFocusedIndex\s*:|activeTabId\s*:/);
});

test('release commits the painted pane target instead of resolving again', () => {
  assert.match(chip, /const paintedTarget = getPaneTabDragSnapshot\(\)\.target/);
  assert.match(strip, /const paintedTarget = getPaneTabDragSnapshot\(\)\.target/);
});
