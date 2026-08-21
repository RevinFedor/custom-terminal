// Shift is one row-scoped action mode across the sidebar and global switcher.
// These wiring checks pin the paths that pure strip-model tests cannot see:
// click/Enter/Ctrl-release routing, the selected/hovered-row plaque, and the
// separation from Cmd-owned Restart/Stop/Clear alternatives.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');
const switcher = fs.readFileSync(path.join(here, 'TabSwitcherOverlay.tsx'), 'utf8');
const rows = fs.readFileSync(path.join(here, 'TabListRows.tsx'), 'utf8');

const between = (source, start, end) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, at + start.length);
  assert.ok(to > at, `missing end marker: ${end}`);
  return source.slice(at, to);
};

test('sidebar routes plain/Shift to add, Cmd to unified activation, Alt/Ctrl to selection', () => {
  const click = between(
    tabBar,
    'const handleTabClick = (e: React.MouseEvent, tabId: string) => {',
    '// OSC 133 Event-driven process status',
  );
  assert.match(click, /if \(e\.altKey \|\| e\.ctrlKey\)[\s\S]{0,260}toggleTabSelection/);
  assert.match(click, /if \(e\.metaKey && !e\.shiftKey\)[\s\S]{0,260}activateTabFromSidebar\(tabId\)/);
  assert.match(click, /addTabToFocusedWindow\(tabId\);/);
  assert.doesNotMatch(click, /selectTabRange/);
});

test('Shift plaque and Cmd process alternatives use separate signals', () => {
  assert.match(tabBar, /shiftPeekMode=\{[^}]*isShiftPressed && isMouseInTabBar\}/);
  assert.match(tabBar, /visible=\{shiftPeekMode && effectiveHovered && targetWindowAction !== null\}/);
  // Cmd remains wired to both existing process alternatives.
  assert.match(tabBar, /verticalRestartStopMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.match(tabBar, /verticalRestartClearMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.doesNotMatch(tabBar, /visible=\{cmdPeekMode && effectiveHovered && targetWindowAction/);
});

test('one exact-row resolver distinguishes add, open and shown no-op', () => {
  assert.match(rows, /export function resolveTabWindowAction\(/);
  assert.match(rows, /if \(pane\.projectId === projectId && pane\.tabId === tabId\) return null;/);
  assert.match(rows, /paneTabs\(pane\)\.some[\s\S]{0,220}\? 'open' : 'add'/);
  assert.match(rows, /if \(centerProjectId === projectId && shownTabId === tabId\) return null;/);
  assert.match(rows, /data-tab-window-action=\{windowAction \|\| undefined\}/);
  assert.match(rows, /text=\{windowAction === 'open' \? 'открыть в этом окне' : 'добавить в это окно'\}/);
});

test('switcher Shift commit uses the focused pane/centre; ordinary commit stays unified activation', () => {
  const commit = between(
    switcher,
    'const commitRow = useCallback((row: Row | undefined, addToFocusedWindow = false) => {',
    '// Middle-click on a row',
  );
  assert.match(commit, /if \(addToFocusedWindow\) \{/);
  assert.match(commit, /const action = resolveTabWindowAction\(state, row\.projectId, row\.tab\.id\);/);
  assert.match(commit, /if \(action === null\) return;/);
  assert.match(commit, /state\.addTabToSplitPaneStrip\(paneIndex, row\.projectId, row\.tab\.id\)/);
  assert.match(commit, /action === 'open'\) state\.activateCenterTab\(row\.projectId, row\.tab\.id\)/);
  assert.match(commit, /state\.addTabToCenterStrip\(row\.projectId, row\.tab\.id\)/);
  assert.match(commit, /useWorkspaceStore\.getState\(\)\.activateCenterTab\(row\.projectId, row\.tab\.id\)/);
});

test('selected or hovered switcher row owns the Shift plaque', () => {
  assert.match(switcher, /const selectedWindowAction = useWorkspaceStore\(\(state\): TabWindowAction => \{/);
  assert.match(switcher, /if \(!shiftPressed \|\| !selectedTabRow \|\| selectedTabRow\.missing\) return null;/);
  assert.match(switcher, /windowAction=\{shiftPressed && selected \? selectedWindowAction : null\}/);
});

test('click, Enter and Ctrl release all commit with the armed Shift action', () => {
  const routed = switcher.match(/commitRow\([^;\n]+, shiftPressedRef\.current\)/g) || [];
  assert.equal(routed.length, 3, 'two Enter paths and Ctrl release');
  assert.match(switcher, /commitRow\(row, e\.shiftKey\)/, 'pointer event owns click modifiers');
  assert.match(switcher, /if \(e\.key === 'Control'\)[\s\S]{0,1000}commitRow\(effectiveRows\[idx\], shiftPressedRef\.current\)/);
});

test('Ctrl+Shift+Tab remains reverse navigation; Shift action arms only after open', () => {
  assert.match(switcher, /setSelectedIndex\(-2 - \(shiftKey \? 1 : 0\)\)/);
  assert.match(switcher, /selectedIndex === -3[\s\S]{0,350}sel\[sel\.length - 1\]/);
  assert.match(switcher, /stepIndex\(rowsRef\.current, prev, e\.shiftKey \? -1 : \+1\)/);
  assert.match(switcher, /if \(e\.key === 'Shift' && cur !== null\) setShiftMode\(true\)/);
  assert.match(switcher, /\(e\.metaKey !== e\.ctrlKey\) && !e\.altKey && !e\.shiftKey && e\.code === 'KeyP'/);
  const searchHotkey = between(switcher, '// Cmd+P / Ctrl+P — open search mode', "if (cur === null) return;");
  assert.match(searchHotkey, /!e\.shiftKey/, 'open first, then hold Shift for the alternate action');
});
