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

test('middle-click on the chip CLEARS the window, it does not close it', () => {
  // The pane is a window the user built: a stray middle-click must not be able
  // to destroy it. The tab leaves the window (and keeps living in the sidebar);
  // closing the window itself is the placeholder's own ✕.
  const aux = block(chrome, 'onAuxClick={(e) => {', 'style={{');
  const restoreAt = aux.indexOf('restoreSplitPanePreviousTab(tabId)');
  const clearAt = aux.indexOf('clearTabFromSplitPane(tabId)');
  // Step-back first (a file pane returns to what it showed before), then clear
  // — so the gesture is never dead.
  assert.ok(restoreAt >= 0 && clearAt > restoreAt);
  assert.ok(!aux.includes('removeTabFromSplit'), 'the chip must not remove the pane');
});

test('clearing a pane empties it and never leaves the centre on a hidden tab', () => {
  const clear = block(store, 'clearTabFromSplitPane: (tabId) => {', '\n\n  removeTabFromSplit:');
  assert.match(clear, /emptyPaneByClosedTab\(splitPanes, splitFocusedIndex, tabId\)/);
  // A pane that just became a placeholder holds no tab, so it cannot answer
  // "what is on screen" — naming it would leave the centre on nothing.
  assert.match(clear, /focusedAfter && focusedAfter\.tabId \? focusedAfter : null/);
  assert.match(clear, /activateCenterTab\(next\.projectId, next\.tabId\)/);
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

test('closing a tab reads the survivor from the model, and never names a placeholder', () => {
  // The same question ("which pane stayed on screen"), so the same answer —
  // the local re-derivation this replaced matched an empty placeholder too,
  // and activating a placeholder does nothing at all.
  //
  // Since closing a tab now EMPTIES its pane instead of removing it, the
  // focused pane itself can be the placeholder that was just emptied: it must
  // be skipped by the same rule, not merely by the model's own answer.
  const close = block(store, 'let splitSurvivor: SplitPane | null = null;', 'if (workspace.activeTabId === tabId)');
  assert.match(close, /focusedAfter && focusedAfter\.tabId \? focusedAfter : null/);
  assert.match(close, /\.survivor/);
  // The fallback scans the RESULT of the model call, never the pre-close list.
  assert.match(close, /splitRes\.panes\.find\(\(p\) => p\.tabId\)/);
  assert.doesNotMatch(close, /\bsplitPanes\.find\(/);
});

test('closing a TAB empties its pane; only "remove from workspace" deletes the pane', () => {
  // Reported live: a tab open in the second column was closed from the sidebar
  // and the whole pane went with it — the layout collapsed as a side effect of
  // deleting something else.
  const close = block(store, 'let splitSurvivor: SplitPane | null = null;', 'if (workspace.activeTabId === tabId)');
  assert.match(close, /emptyPaneByClosedTab\(splitPanes, splitFocusedIndex, tabId\)/);
  assert.doesNotMatch(close, /removePaneByTab\(/, 'closing a tab must not remove the pane');
  // …while the explicit gesture still removes it.
  const removeFromSplit = block(store, 'removeTabFromSplit: (tabId) => {', '\n  },');
  assert.match(removeFromSplit, /removePaneByTab\(splitPanes, splitFocusedIndex, tabId\)/);
});

// ── One pointer: activation brings the sidebar along ──────────────────────

test('the chip uses the single activation path — activation itself moves the sidebar', () => {
  // One-pointer model: switchTab writes BOTH activeProjectId and
  // focusedProjectId (activationFollowPatch), so the chip needs no special
  // project-following method. activateTabAndProject is gone.
  assert.match(chrome, /activateCenterTab\(projectId, tabId\)/);
  assert.doesNotMatch(chrome, /activateTabAndProject\(/);
  assert.doesNotMatch(store, /activateTabAndProject/);
});

test('switchTab moves both pointers together', () => {
  const patch = block(store, 'const activationFollowPatch = (', '\n);');
  assert.match(patch, /activeProjectId: projectId, focusedProjectId: projectId/);
  // No-op guard: both already there → empty patch, no re-render.
  assert.match(patch, /st\.activeProjectId === projectId && st\.focusedProjectId === projectId/);
  // switchTab is the single consumer — every activation funnels through it.
  assert.match(store, /\.\.\.activationFollowPatch\(get\(\), projectId\)/);
});

test('an explicit project click still parks the sidebar without touching the centre', () => {
  const show = block(store, 'showWorkspace: (projectId) => {', '\n  },');
  assert.match(show, /focusedProjectId: projectId/);
  assert.doesNotMatch(show, /switchTab\(/, 'a project click must not swap the visible tab');
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

test('activateCenterTab delegates the sidebar move to switchTab, not showWorkspace', () => {
  // The sidebar follows activation INSIDE switchTab (one write, no project
  // navigation side effects like the project-history reshuffle showWorkspace
  // does). activateCenterTab must not duplicate it.
  const activateCenter = block(
    store,
    'activateCenterTab: (projectId, tabId) => {',
    '\n\n  isRestoring:',
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

// ── Global Ctrl+Tab (per-pane scope removed 2026-08-17) ───────────────────

const switcher = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'TabSwitcherOverlay.tsx'),
  'utf8',
);

test('the switcher is global-only: no pane scope anywhere', () => {
  // Per-pane Ctrl+Tab was removed: the user picks tabs by the sidebar's map,
  // and a pane-local journal answered a question nobody asked. The jump into a
  // visible pane lives in switchTab (resolveSplitActivation), not here.
  assert.doesNotMatch(switcher, /paneScope/);
  assert.doesNotMatch(switcher, /resolveSwitcherScope/);
  assert.doesNotMatch(switcher, /workspaceOwnsKeyboard/);
});

test('a visible tab is a legal Ctrl+Tab target — the model does not skip on-screen tabs', () => {
  // Committing a visible tab JUMPS focus to its pane; skipping it would make
  // "one Ctrl+Tab back after an accidental pane click" impossible.
  const model = fs.readFileSync(
    path.join(here, '..', 'utils', 'tabSwitcherModel.mjs'),
    'utf8',
  );
  const initial = block(model, 'export function initialCtrlIndex(', '\n}');
  assert.doesNotMatch(initial, /onScreen/);
});

test('middle click forgets a row and does NOT navigate or close the window', () => {
  const rowDown = block(switcher, 'onPointerDown={(e) => {\n                    e.preventDefault();', '}}\n                />');
  const forgetAt = rowDown.indexOf('forgetRow(row)');
  const commitAt = rowDown.indexOf('commitRow(row)');
  assert.ok(forgetAt >= 0 && commitAt > forgetAt, 'the middle-click branch must precede the pick');
  assert.match(rowDown, /if \(e\.button === 1\) \{ forgetRow\(row\); return; \}/);
  const forget = block(switcher, 'const forgetRow = useCallback(', '}, []);');
  assert.match(forget, /forgetGlobalTabVisit\(/);
});

test('forgetting a global row clears the durable stamp too', () => {
  // Restore derives the order from each tab lastActivatedAt and uses the saved
  // array only for unstamped tabs — clearing just the array would let the
  // entry come back on the next launch.
  const forget = block(store, 'forgetGlobalTabVisit: (projectId, tabId) => {', '\n  },');
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
