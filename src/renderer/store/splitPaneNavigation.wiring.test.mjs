// The two navigation rules of the pane header chip, pinned to the source that
// implements them.
//
// Both bugs these cover looked like "the click does nothing / does the wrong
// thing", and both were invisible to the pure model tests: the model was right
// each time, and the wiring around it asked it the wrong question.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const chrome = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'SplitPaneChrome.tsx'),
  'utf8',
);
const tabBar = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'TabBar.tsx'),
  'utf8',
);
const workspace = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'Workspace.tsx'),
  'utf8',
);

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

// ── Middle-click closes the pane ──────────────────────────────────────────

test('stepping back is gated on the pane showing a FILE', () => {
  // Pane-level recency is recorded on EVERY activation, so "this pane has a
  // previous tab" is true for almost every pane that has been used. Without the
  // file check, middle-click swapped content instead of closing the pane —
  // i.e. the gesture never closed anything on a pane the user had worked in.
  const restore = block(
    store,
    'restoreSplitPanePreviousTab: (tabId) => {',
    '\n\n  removeEmptySplitPane:',
  );
  const gateAt = restore.indexOf("tabType !== 'file'");
  const callAt = restore.indexOf('restorePanePreviousTab(');
  assert.ok(gateAt >= 0, 'expected a file-type gate');
  assert.ok(callAt > gateAt, 'the gate must run BEFORE the model is consulted');
  assert.match(restore, /if \(shownTab\?\.tabType !== 'file'\) return false;/);
});

test('the chip still falls through to removal, so the gesture is never dead', () => {
  const aux = block(chrome, 'onAuxClick={(e) => {', 'style={{');
  const restoreAt = aux.indexOf('restoreSplitPanePreviousTab(tabId)');
  const removeAt = aux.indexOf('removeTabFromSplit(tabId)');
  assert.ok(restoreAt >= 0 && removeAt > restoreAt);
});

test('collapsing to single mode moves the center to the SURVIVING tab', () => {
  // res.panes is empty on collapse, so res.panes[focusedIndex] is undefined and
  // the center silently stayed on the tab that had just been removed.
  const remove = block(
    store,
    'removeTabFromSplit: (tabId) => {',
    '\n\n  addEmptySplitPane:',
  );
  assert.match(remove, /res\.panes\[res\.focusedIndex\] \|\| res\.survivor/);
  assert.match(remove, /activateCenterTab\(next\.projectId, next\.tabId\)/);
});

test('closing a tab reads the survivor from the model, not a private copy', () => {
  // The same question ("which pane stayed on screen"), so the same answer. The
  // local re-derivation here matched an empty placeholder too, and activating a
  // placeholder does nothing at all.
  const close = block(store, 'let splitSurvivor: SplitPane | null = null;', 'if (workspace.activeTabId === tabId)');
  assert.match(close, /splitRes\.panes\[splitRes\.focusedIndex\] \|\| splitRes\.survivor/);
  assert.doesNotMatch(close, /splitPanes\.find\(/);
});

// ── Left click brings the project along ───────────────────────────────────

test('the chip navigates to the tab AND its project', () => {
  // Panes are cross-project, so this chip can name a tab the sidebar is not
  // showing. activateCenterTab deliberately never moves the sidebar.
  assert.match(chrome, /activateTabAndProject\(projectId, tabId\)/);
  assert.doesNotMatch(
    chrome,
    /onClick=\{\(e\) => \{[\s\S]{0,600}?activateCenterTab\(projectId, tabId\)/,
    'the chip must not use the tab-only path for its left click',
  );
});

test('project moves before the tab, so the reveal lands in the right list', () => {
  const activate = block(
    store,
    'activateTabAndProject: (projectId, tabId) => {',
    '\n  isRestoring:',
  );
  const showAt = activate.indexOf('showWorkspace(projectId)');
  const activateAt = activate.indexOf('activateCenterTab(projectId, tabId)');
  assert.ok(showAt >= 0 && activateAt > showAt,
    'showWorkspace must run first — it is the only writer of the sidebar pointer');
  // A tab that no longer exists must not move the sidebar to its project.
  assert.match(activate, /if \(!workspace \|\| !workspace\.tabs\.has\(tabId\)\) return;/);
});

test('a right click opens the menu without navigating anywhere', () => {
  // Only the LEFT click carries navigation. Opening a menu ABOUT a tab must not
  // move the sidebar, the centre or the pane focus — inspecting is not switching.
  //
  // The first fix here did navigate, as a way to give the request a listener:
  // the menu is built from its own project, and only the sidebar's single list
  // was mounted. The right answer is the opposite direction — mount a hidden
  // list for the other pane's project, so the menu comes to the project.
  const opener = block(
    tabBar,
    'export function openTabContextMenuAt(',
    '\n// Маркеры реальных задач',
  );
  assert.doesNotMatch(opener, /showWorkspace\(/, 'a right click must not move the sidebar');
  assert.doesNotMatch(opener, /activateCenterTab\(/, 'a right click must not move the centre');
  assert.doesNotMatch(opener, /focusSplitPane\(/, 'a right click must not move pane focus');
  assert.match(opener, /dispatchEvent\(new CustomEvent\(TAB_CONTEXT_MENU_EVENT/);
});

test('every pane project has a menu owner mounted', () => {
  // Panes are cross-project; the sidebar shows one project. Without an owner for
  // the others, the request is dropped and the right click does nothing at all.
  assert.match(workspace, /menuOnlyForProject/);
  assert.match(workspace, /paneMenuOwnerProjectIds\.map/);
  // Selector must return a STRING, never a fresh array — an array literal is a
  // new reference every render and re-renders the workspace on any store write.
  assert.match(workspace, /paneMenuOwnerKey[\s\S]{0,600}?\.join\('\|'\)/);
  // Only OTHER projects: the sidebar already owns its own menu.
  assert.match(workspace, /pane\.projectId !== sidebarPid/);
  // menuOnlyForProject renders no list — otherwise there would be two visible
  // tab lists with two selections.
  assert.match(tabBar, /menuOnlyForProject \? null :/);
});

test('the click that dismisses a menu does not also focus the pane', () => {
  // A click while a menu is open belongs to the MENU: its job is to close it.
  // Pane focus listens on pointerdown in the CAPTURE phase while every dismiss
  // handler is on mousedown in the bubble phase, so without this guard focus
  // always won the race — reported as "right-click pane 1 from pane 2, then click
  // in pane 1, and pane 1 takes focus".
  const terminalArea = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'TerminalArea.tsx'),
    'utf8',
  );
  const onDown = block(terminalArea, 'const onPointerDown = (e: PointerEvent) => {', '\n    };');
  const guardAt = onDown.indexOf('notePointerDownForDismissal(document)');
  const focusAt = onDown.indexOf('focusSplitPane(idx)');
  assert.ok(guardAt >= 0, 'expected the dismissal guard');
  assert.ok(focusAt > guardAt, 'the guard must run BEFORE focus moves');
  assert.match(onDown, /if \(notePointerDownForDismissal\(document\)\) return;/);
});

test('tab switching everywhere else still leaves the sidebar alone', () => {
  // The whole reason this is a separate method: activateCenterTab is the rule
  // for every other surface and must keep NOT moving the project.
  const activateCenter = block(
    store,
    'activateCenterTab: (projectId, tabId) => {',
    '\n\n  activateTabAndProject:',
  );
  assert.doesNotMatch(activateCenter, /showWorkspace\(/);
  assert.doesNotMatch(activateCenter, /focusedProjectId:/);
});

// ── The two pane writers that bypass switchTab still record the visit ─────

test('setSplitPaneTab and addTabToSplit touch the global history themselves', () => {
  // The visit rule lives in touchGlobalTabMru, and switchTab feeds it. But two
  // paths write a pane DIRECTLY and never pass through switchTab: the pane
  // header's hover list (setSplitPaneTab) and "add to workspace" (addTabToSplit).
  // Both make a tab APPEAR — the definition of a visit — yet the hover list left
  // no trace in the global history (reported live). Each must touch with its own
  // PRE-write snapshot: after the pane write the tab is already visible, and a
  // live read would classify the visit as "nothing new appeared".
  const setPane = block(store, 'setSplitPaneTab: (paneIndex, projectId, tabId) => {', '\n\n  restoreSplitPanePreviousTab:');
  {
    const snapAt = setPane.indexOf('const visibleBefore = onScreenTabIds(');
    const writeAt = setPane.indexOf('set({ splitPanes: next })');
    const touchAt = setPane.indexOf('touchGlobalTabMru(projectId, tabId, visibleBefore)');
    assert.ok(snapAt >= 0, 'setSplitPaneTab must snapshot the screen');
    assert.ok(writeAt > snapAt, 'the snapshot must be taken BEFORE the pane write');
    assert.ok(touchAt > writeAt, 'and the touch happens with that pre-write picture');
  }
  const addTab = block(store, 'addTabToSplit: (projectId, tabId) => {', '\n\n  removeTabFromSplit:');
  {
    const snapAt = addTab.indexOf('const visibleBefore = onScreenTabIds(');
    const writeAt = addTab.indexOf('set({ splitPanes: res.panes');
    const touchAt = addTab.indexOf('touchGlobalTabMru(projectId, tabId, visibleBefore)');
    assert.ok(snapAt >= 0, 'addTabToSplit must snapshot the screen');
    assert.ok(writeAt > snapAt, 'snapshot BEFORE the pane write');
    assert.ok(touchAt > writeAt, 'touch with the pre-write picture');
  }
});

// ── Per-pane Ctrl+Tab ─────────────────────────────────────────────────────

const switcher = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'TabSwitcherOverlay.tsx'),
  'utf8',
);

test('the switcher scope is resolved ONCE at open, not read per keystroke', () => {
  // Scope must not shift under the keys mid-cycle: the rows are already drawn
  // from one history, and a scope that re-derives on every step would swap the
  // list out from under the selection.
  const openCtrl = block(switcher, 'const openCtrl = useCallback(', '}, []);');
  assert.match(openCtrl, /resolveSwitcherScope\(/);
  assert.match(openCtrl, /setPaneScope\(/);
  // The step branch only moves the index.
  const stepBranch = block(switcher, "if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab')", 'return;');
  assert.doesNotMatch(stepBranch, /resolveSwitcherScope\(/);
});

test('the fast tap resolves the pane scope too', () => {
  // Ctrl can be released before React renders; without this the classic
  // A-to-B toggle would silently fall back to the GLOBAL history even though
  // the user was working inside a pane.
  const keyUp = block(switcher, 'const onKeyUp = (e: KeyboardEvent) => {', '\n    };');
  const resolveAt = keyUp.indexOf('resolveSwitcherScope(');
  const globalAt = keyUp.indexOf('initialCtrlIndex(');
  assert.ok(resolveAt >= 0, 'fast tap must resolve the scope');
  assert.ok(globalAt > resolveAt, 'the global fallback comes AFTER the pane branch');
});

test('a pane list is anchored at its pane, never at the window corner', () => {
  // Same lesson as the toast fix: a surface about one pane must appear at that
  // pane. Here it also answers "whose history am I walking".
  assert.match(switcher, /data-terminal-pane-wrapper\]\[data-split-pane-index="\$\{paneScope\.paneIndex\}"/);
  assert.match(switcher, /data-tab-switcher-scope/);
});

test('middle click forgets a row and does NOT navigate or close the window', () => {
  const rowDown = block(switcher, 'onPointerDown={(e) => {\n                    e.preventDefault();', '}}\n                />');
  const forgetAt = rowDown.indexOf('forgetRow(row)');
  const commitAt = rowDown.indexOf('commitRow(row)');
  assert.ok(forgetAt >= 0 && commitAt > forgetAt, 'the middle-click branch must precede the pick');
  assert.match(rowDown, /if \(e\.button === 1\) \{ forgetRow\(row\); return; \}/);
  // forgetRow routes by scope: the pane list edits the pane, the global list
  // edits the global order.
  const forget = block(switcher, 'const forgetRow = useCallback(', '}, []);');
  assert.match(forget, /forgetPaneTabVisit\(/);
  assert.match(forget, /forgetGlobalTabVisit\(/);
});

test('forgetting a global row clears the durable stamp too', () => {
  // Restore derives the order from each tab lastActivatedAt and uses the saved
  // array only for unstamped tabs — clearing just the array would let the
  // entry come back on the next launch.
  const forget = block(store, 'forgetGlobalTabVisit: (projectId, tabId) => {', '\n\n  forgetPaneTabVisit:');
  assert.match(forget, /delete tab\.lastActivatedAt/);
  assert.match(forget, /dropFromMru\(/);
});

test('closing a tab purges it from every pane history', () => {
  assert.match(store, /dropTabFromAllPaneHistories\(get\(\)\.splitPanes, tabId\)/);
});

test('the pane object is only ever rebuilt through the history carrier', () => {
  // A pane is rebuilt from scratch on activation, so anything not explicitly
  // carried is erased — hand-assembling {projectId, tabId} is how the history
  // would quietly reset on every switch.
  const setPane = block(store, 'setSplitPaneTab: (paneIndex, projectId, tabId) => {', '\n\n  restoreSplitPanePreviousTab:');
  assert.match(setPane, /paneWithHistoryFrom\(/);
  assert.doesNotMatch(setPane, /prevProjectId: target\.projectId/);
});

test('Ctrl+P opens the same search as Cmd+P, in the overlay AND out of the PTY', () => {
  assert.match(switcher, /\(e\.metaKey !== e\.ctrlKey\)[\s\S]{0,120}KeyP/);
  const terminal = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'Terminal.tsx'),
    'utf8',
  );
  // Both xterm key handlers must swallow it: Ctrl+P is readline "previous
  // line", so leaking it would edit the command line while the panel opens.
  const swallows = terminal.match(/\(event\.metaKey !== event\.ctrlKey\)[\s\S]{0,120}KeyP/g) || [];
  assert.equal(swallows.length, 2, 'both handlers must swallow Ctrl+P');
});
