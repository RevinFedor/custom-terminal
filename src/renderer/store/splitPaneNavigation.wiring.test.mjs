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
// Чип вкладки в шапке окна уехал из SplitPaneChrome в свой файл — сами правила
// не изменились, изменился только их адрес.
const chip = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'PaneTabChip.tsx'),
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

// ── Middle-click removes the named chip; history restore is a separate flow ─

test('stepping back applies to a normal MOVE HERE tab, not only to a file', () => {
  // Explicit MOVE HERE removes the displaced tab from every strip, so history
  // is the only exact record of what this pane showed before. A file-only gate
  // made middle-click leave an ordinary moved tab's pane empty.
  const restore = block(
    store,
    'restoreSplitPanePreviousTab: (tabId) => {',
    '\n\n  removeEmptySplitPane:',
  );
  const callAt = restore.indexOf('restorePanePreviousTab(');
  assert.ok(callAt >= 0, 'pane history model is not consulted');
  assert.doesNotMatch(restore, /tabType\s*!==\s*['"]file['"]/);
});

test('middle-click on the chip CLEARS the window, it does not close it', () => {
  // The pane is a window the user built: a stray middle-click must not be able
  // to destroy it. The tab leaves the window (and keeps living in the sidebar);
  // closing the window itself is the placeholder's own ✕.
  const aux = block(chip, 'onAuxClick={(e) => {', 'style={{');
  const clearAt = aux.indexOf('clearTabFromSplitPane(tabId)');
  assert.ok(clearAt >= 0);
  assert.doesNotMatch(aux, /restoreSplitPanePreviousTab\(tabId\)/);
  assert.ok(!aux.includes('removeTabFromSplit'), 'the chip must not remove the pane');
});

test('middle-click in the sidebar is Shift-add-here, never full close', () => {
  const componentStart = tabBar.indexOf('const TabItem = memo');
  const componentEnd = tabBar.indexOf('// ──', componentStart);
  const tabItem = tabBar.slice(componentStart, componentEnd > componentStart ? componentEnd : undefined);
  const aux = block(tabItem, 'onAuxClick={(e) => {', '\n    >');
  assert.match(aux, /onMiddleClick\(\)/);
  assert.doesNotMatch(aux, /onClose/);
  const routes = tabBar.match(/onMiddleClick=\{\(\) => addTabToFocusedWindow\(tab\.id\)\}/g) || [];
  assert.equal(routes.length, 3, 'all sidebar tab render paths share add-here');
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
  assert.match(chip, /activateCenterTab\(projectId, tabId\)/);
  assert.doesNotMatch(chip, /activateTabAndProject\(/);
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
  assert.match(workspace, /paneMenuOwnerKey[\s\S]{0,1200}?\.join\('\|'\)/);
  // Only OTHER projects: the sidebar already owns its own menu. (Читается по
  // всей полосе панели, не только по показанному чипу: правый клик по
  // припаркованному чипу открывает то же меню.)
  assert.match(workspace, /\.projectId !== sidebarPid/);
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
  const focusAt = onDown.indexOf('focusSplitPane(idx,');
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

test('re-clicking the focused pane restores its project after sidebar parking', () => {
  const terminalArea = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'TerminalArea.tsx'),
    'utf8',
  );
  const onDown = block(terminalArea, 'const onPointerDown = (e: PointerEvent) => {', '\n    };');
  assert.match(onDown, /if \(!e\.metaKey \|\| idx !== st\.splitFocusedIndex\) \{[\s\S]{0,160}st\.focusSplitPane\(idx,/);
  assert.doesNotMatch(onDown, /Number\.isFinite\(idx\) && idx !== st\.splitFocusedIndex/);
  const paneStrip = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'PaneTabStrip.tsx'),
    'utf8',
  );
  assert.match(paneStrip, /store\.focusSplitPane\(paneIndex\)/);
});

// ── Свежесть следует за ФОКУСОМ, а не за появлением на экране ─────────────

test('свежесть пишется на каждой активации, включая уже видимую вкладку', () => {
  // Симптом, который это чинит: правило «отмечать, только если вкладка ПОЯВИЛАСЬ»
  // замораживало позицию всего, что лежит в панели. В такой вкладке можно было
  // работать полдня без единой записи (она не появлялась — она уже была там), а
  // уход с экрана событием не является вовсе. Позиция стояла на месте, и каждая
  // чужая активация толкала её на шаг вниз: *«вкладка отходит всё назад и назад»*.
  //
  // Видимость больше не решает, писать ли; она решает только, что предлагать —
  // и решает это переключатель над своими строками.
  const touch = block(store, 'touchGlobalTabMru: (projectId, tabId) => {', '\n\n  forgetGlobalTabVisit:');
  assert.match(touch, /isVisitWorthRecording\(\{ tabId \}\)/);
  assert.doesNotMatch(touch, /visibleBefore/, 'снимок «что было видно» больше не нужен');
  assert.doesNotMatch(touch, /onScreenTabIds/, 'видимость здесь не спрашивают');
  // Ни один вызывающий не передаёт третий аргумент — иначе он бы намекал, что
  // видимость всё ещё что-то решает.
  assert.doesNotMatch(store, /touchGlobalTabMru\([^)]*,[^)]*,[^)]*\)/);
});

test('лишняя отметка не превращается в запись всего списка вкладок', () => {
  // Теперь пишет КАЖДАЯ активация, в том числе повторный клик по той же
  // вкладке, а каждая отметка стоит полной записи списка вкладок проекта.
  // Уже самая свежая → относительный порядок не изменится, писать нечего.
  const touch = block(store, 'touchGlobalTabMru: (projectId, tabId) => {', '\n\n  forgetGlobalTabVisit:');
  assert.match(touch, /const isAlreadyFreshest = globalTabMru\[0\]\?\.tabId === tabId;/);
  // …но вкладка без отметки обязана её получить, даже стоя первой: после
  // перезапуска порядок выводится из отметок, а её может ранжировать всего лишь
  // сохранённый запасной список. Пропустив её, оставили бы её без отметки
  // навсегда — и на следующем запуске она провалилась бы под все отмеченные.
  assert.match(touch, /if \(tab && \(!isAlreadyFreshest \|\| !tab\.lastActivatedAt\)\)/);
  assert.match(touch, /if \(isAlreadyFreshest\) return;/);
});

test('добавление вкладки в панель отмечается единой точкой активации', () => {
  // Раньше здесь была отдельная отметка со снимком экрана ДО записи панели:
  // активация после неё видела вкладку уже видимой и правило её отбрасывало.
  // Теперь видимость ничего не решает, поэтому вторая отметка — просто дубль.
  const addTab = block(store, 'addTabToSplit: (projectId, tabId) => {', '\n\n  clearTabFromSplitPane:');
  assert.doesNotMatch(addTab, /touchGlobalTabMru/);
  assert.match(addTab, /activateCenterTab\(projectId, tabId\)/);
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

test('Ctrl+Tab offers only what is NOT on screen; Cmd+P offers everything', () => {
  // The gesture means "bring back what I cannot see", so a tab filling half the
  // screen is not an answer. Search is the opposite: an existing tab must be
  // findable by name whatever is visible, or the search lies about what exists.
  const build = block(switcher, 'function computeRowsFromStores(', '\n}');
  assert.match(build, /hideOnScreen/);
  // Uses the SAME "what is visible" answer as the visit rule — two definitions
  // would let the list and the history disagree about which tabs count.
  assert.match(build, /onScreenTabIds\(\{/);
  assert.match(build, /!hidden\.has\(t\.id\)/);
  // ctrl → filtered, search → not.
  assert.match(switcher, /computeRowsFromStores\(mode === 'search' \? query : '', mode === 'ctrl'\)/);
  // The fast tap (Ctrl released before the first frame) must filter too, or it
  // would land on a tab the visible list does not even offer.
  const ctrlCommit = block(switcher, 'const commitCtrlSelection = useCallback(', '\n\n  // Средний клик');
  assert.match(ctrlCommit, /computeRowsFromStores\('', true\)/);
  const keyUp = block(switcher, 'const onKeyUp = (e: KeyboardEvent) => {', '\n    };');
  assert.match(keyUp, /commitCtrlSelection\('control-release', inputDelay\)/);
});

test('the CURRENT tab is the one visible tab kept, and it is pinned to row 1', () => {
  // "Where am I → where am I going": row 1 is the anchor, and the highlight sits
  // on row 2. Without it the panel opened straight onto the target and the first
  // row read as "the current tab" while pointing at the wrong one.
  //
  // One condition decides the exemption AND the pin. Splitting them is how row 1
  // would come to mean different things depending on what is on screen.
  const build = block(switcher, 'function computeRowsFromStores(', '\n}');
  assert.match(build, /const anchorTabId = hideOnScreen \? currentTabId : null;/);
  // Exempt from the ON-SCREEN filter only — sub-agent children are still never
  // switcher rows, whatever the user happens to be focused on.
  assert.match(build, /!t\.parentTabId && \(t\.id === anchorTabId \|\| !hidden \|\| !hidden\.has\(t\.id\)\)/);
  assert.match(build, /pinnedFirstTabId: anchorTabId/);
  // Search must NOT pin: a current tab floated above a match would read as a
  // search result. Same expression, and it is null whenever hideOnScreen is off.
  assert.doesNotMatch(build, /pinnedFirstTabId: currentTabId/);
});

test('the anchor outranks recency, and is never what releasing Ctrl picks', () => {
  const model = fs.readFileSync(
    path.join(here, '..', 'utils', 'tabSwitcherModel.mjs'),
    'utf8',
  );
  // Being looked at is not recorded as a visit (tabVisitHistoryRule), so the
  // current tab is frequently NOT the head of the history — the pin cannot be
  // left to the MRU.
  assert.match(model, /pinnedFirstTabId && tab\.id === pinnedFirstTabId\)\s*\n?\s*\? -1/);
  // …and the highlight skips it, so it stays an anchor rather than a target.
  const initial = block(model, 'export function initialCtrlIndex(', '\n}');
  assert.match(initial, /entry\.tabId === activeTabId\) continue;/);
  // Nothing but the anchor → select NOTHING. Falling back to the current tab
  // would re-activate it, and activation switches the project view and drags
  // the sidebar to that row — not a no-op.
  assert.match(initial, /if \(activeTabId && selectable\.length > 0\) return -1;/);
});

test('the anchor row does not look like a target', () => {
  // Two rings in one list would ask "which of these am I picking?". The anchor
  // gets a left rail and dimmed text instead; the selection ring stays the
  // property of the row the keyboard is on.
  assert.match(switcher, /anchor=\{anchor\}/);
  assert.match(switcher, /mode === 'ctrl' && !!activeTabId && tab\.id === activeTabId/);
  const rows = fs.readFileSync(
    path.join(here, '..', 'components', 'Workspace', 'TabListRows.tsx'),
    'utf8',
  );
  assert.match(rows, /selected[\s\S]{0,120}: \(anchor \? 'inset 2px 0 0 0 #6e6e76' : 'none'\)/);
  // Colour, not opacity alone — an alpha-only difference is what video codecs
  // eat on dark backgrounds (AI-Optimized UI rule).
  assert.match(rows, /anchor \? '#9a9a9f' : '#e6e6e6'/);
});

test('"everything is on screen" is said UNDER the anchor, not instead of the list', () => {
  // The ctrl list is never empty now (it always holds the anchor), so the old
  // empty-state wording would never appear. Two different facts, two places:
  // no tabs at all vs. nowhere to go back to.
  assert.match(switcher, /mode === 'ctrl'\s*\n?\s*\? 'Нет открытых вкладок'/);
  assert.match(switcher, /nothingToReturnTo &&[\s\S]{0,600}Все вкладки уже на экране/);
  // Counted from the rows themselves so it cannot disagree with what is drawn.
  assert.match(switcher, /const nothingToReturnTo = rows\.filter\(\(r\) => r\.kind === 'tab'\)\.length <= 1;/);
});

test('the ctrl list recomputes when the panes change', () => {
  // Which tabs are on screen is part of that list's CONTENT: a tab must return
  // to it the moment its pane empties. A string selector, never the array —
  // Fingerprint Pattern.
  assert.match(switcher, /const onScreenKey = useWorkspaceStore\(\(s\) => onScreenTabIds\(\{/);
  assert.match(switcher, /\}\)\.join\(','\)\);/);
  const memoDeps = block(switcher, 'const rows: Row\[\] = useMemo(', '\n  useEffect(');
  assert.match(memoDeps, /onScreenKey/);
  // …and when the ANCHOR changes: row 1 is the current tab, so switching tabs
  // with the panel closed must rebuild the list before it reopens. A string
  // selector for the same reason.
  assert.match(switcher, /const activeTabId = useWorkspaceStore\(\(s\) => \(/);
  assert.match(memoDeps, /activeTabId/);
});

test('средний клик по строке переключателя — тот же перенос, что Shift', () => {
  // Раньше он ЗАБЫВАЛ запись. Жест-«удалить» на списке, который открывают,
  // чтобы куда-то перейти, стоил дороже, чем помогал: промах молча выкидывал
  // вкладку из переключателя. Теперь оба жеста идут одним `commitRow`.
  const rowDown = block(switcher, 'onPointerDown={(e) => {\n                    e.preventDefault();', '}}\n                />');
  const middleAt = rowDown.indexOf('commitRow(row, true)');
  const commitAt = rowDown.indexOf('commitRow(row, e.shiftKey)');
  assert.ok(middleAt >= 0 && commitAt > middleAt, 'ветка среднего клика идёт перед обычным выбором');
  assert.match(rowDown, /if \(e\.button === 1\) \{\s*if \(missing\) return;\s*commitRow\(row, true\);/);
  assert.doesNotMatch(switcher, /forgetRow/);
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
  // (and, before that, the pane's column) would quietly reset on every switch.
  const model = fs.readFileSync(
    path.join(here, '..', 'utils', 'splitPanesModel.mjs'),
    'utf8',
  );
  const activation = block(model, 'export function resolveSplitActivation(', '\n}');
  assert.match(activation, /paneWithHistoryFrom\(/);
  assert.doesNotMatch(activation, /prevProjectId:/);
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

// ── Переименование происходит там, где на него нажали ─────────────────────

test('Rename из шапки окна открывает поле ВВОДА в этой шапке, а не в боковом списке', () => {
  // Меню вкладки одно на всё приложение — оно принадлежит боковому списку.
  // Его пункт «Rename» открывал поле ввода ТАМ, где живёт меню, а не там,
  // откуда его позвали: пользователь нажимал правой кнопкой на вкладке в шапке
  // окна, а поле появлялось в боковом списке, часто вообще вне видимой части.
  // Enter при этом менял имя правильно — то есть переименование «работало», но
  // выглядело так, будто произошло не с той вкладкой.
  //
  // Теперь поверхность, открывшая меню, представляется по имени, и «Rename»
  // возвращает запрос ей.
  const opener = block(
    tabBar,
    'export function openTabContextMenuAt(',
    '\n// Маркеры реальных задач',
  );
  assert.match(opener, /renameHost/, 'открыватель обязан уметь назвать себя');

  const renameItem = block(tabBar, '  const handleContextRename = () => {', '\n  };');
  // Ключевое: при наличии хозяина СВОЁ поле не открывается — иначе на одну
  // вкладку было бы два поля ввода, и видно было бы не то.
  assert.match(renameItem, /renameHostRef\.current/);
  assert.match(renameItem, /TAB_RENAME_REQUEST_EVENT/);
  assert.match(renameItem, /\}\s*else if \(tab\) \{\s*\n\s*startTabRename\(tab\);/);

  // Чип вкладки в шапке окна: и представляется, и слушает ответ.
  assert.match(chip, /openTabContextMenuAt\(projectId, tabId, e\.clientX, e\.clientY, \{ renameHost: renameHostId \}\)/);
  assert.match(chip, /window\.addEventListener\(TAB_RENAME_REQUEST_EVENT/);
  // Имя хозяина включает НОМЕР ПАНЕЛИ, а не только вкладку: одна и та же
  // вкладка может быть видна и в шапке одиночного режима, и в панели — начать
  // правку должна ровно та, на которой нажали.
  assert.match(chip, /const renameHostId = `split-pane-header:\$\{paneIndex \?\? 'center'\}:\$\{tabId\}`/);
});

test('обычный правый клик в боковом списке по-прежнему переименовывает у себя', () => {
  // Метка хозяина живёт ровно столько, сколько открытое меню. Свой правый клик
  // обязан её снять — иначе следующий «Rename» уехал бы в шапку окна, которая
  // звала меню до этого.
  const handler = block(tabBar, '  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {', '\n  };');
  assert.match(handler, /renameHostRef\.current = null;/);
});
