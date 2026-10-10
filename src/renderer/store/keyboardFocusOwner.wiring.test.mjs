import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(renderer, 'App.tsx'), 'utf8');
const store = readFileSync(join(renderer, 'store/useWorkspaceStore.ts'), 'utf8');
const sidebar = readFileSync(join(renderer, 'components/Workspace/TabSidebar.tsx'), 'utf8');
const terminalArea = readFileSync(join(renderer, 'components/Workspace/TerminalArea.tsx'), 'utf8');
const switcher = readFileSync(join(renderer, 'components/Workspace/TabSwitcherOverlay.tsx'), 'utf8');
const paneChip = readFileSync(join(renderer, 'components/Workspace/PaneTabChip.tsx'), 'utf8');
const tabBar = readFileSync(join(renderer, 'components/Workspace/TabBar.tsx'), 'utf8');
const paneStrip = readFileSync(join(renderer, 'components/Workspace/PaneTabStrip.tsx'), 'utf8');
const spaceStrip = readFileSync(join(renderer, 'components/Workspace/SpaceStrip.tsx'), 'utf8');
const history = readFileSync(join(renderer, 'components/Workspace/HistoryPanel.tsx'), 'utf8');
const primaryFocus = readFileSync(join(renderer, 'utils/tabPrimaryInputFocus.ts'), 'utf8');
const css = readFileSync(join(renderer, 'styles/globals.css'), 'utf8');

test('left sidebar is an explicit keyboard-focus surface with visible ownership', () => {
  assert.match(app, /data-keyboard-focus-owner=\{activeArea\}/);
  assert.match(app, /closest\?\.\('\[data-keyboard-focus-surface="sidebar"\]'\)/);
  assert.match(sidebar, /data-keyboard-focus-surface="sidebar"/);
  assert.match(sidebar, /setActiveArea\('sidebar'\)/);
  assert.match(terminalArea, /setActiveArea\('workspace'\)/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-tab-sidebar/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-split-pane-focus-frame="1"/);
  assert.doesNotMatch(
    css,
    /data-keyboard-focus-owner="sidebar" \[data-split-pane-focus-actions\] \{[\s\S]{0,180}display: none/,
    'sidebar focus may dim pane actions but must not change strip width',
  );
  assert.match(paneChip, /data-chip-active=\{shown && paneFocused \? '1' : '0'\}/);
  assert.match(paneChip, /active=\{shown\}/);
  assert.doesNotMatch(
    css,
    /\[data-split-pane-tab-chip\]\[data-chip-shown="1"\]/,
    'keyboard focus must not dim the selected chip in any window',
  );
});

test('shared tab-menu actions do not steal keyboard ownership from their source pane', () => {
  const sidebarCapture = sidebar.slice(
    sidebar.indexOf('onPointerDownCapture={(event) => {'),
    sidebar.indexOf('\n      }}', sidebar.indexOf('onPointerDownCapture={(event) => {')),
  );
  assert.match(sidebarCapture, /closest\?\.\('\[data-tab-context-menu\]'\)/);
  const guardAt = sidebarCapture.indexOf("[data-tab-context-menu]");
  const ownerAt = sidebarCapture.indexOf("setActiveArea('sidebar')");
  assert.ok(guardAt >= 0 && ownerAt > guardAt,
    'Full/Remove from a pane menu must preserve the existing pane owner');
});

test('Cmd+T asks the common focus resolver and sidebar creation has no pane placement', () => {
  const start = app.indexOf('// Cmd+T - New Tab or New Project');
  const end = app.indexOf('// Arrow keys for project navigation', start);
  const body = app.slice(start, end);
  assert.match(body, /const keyboardTarget = readKeyboardFocusTarget\(\)/);
  assert.match(body, /keyboardTarget\.kind === 'sidebar'/);
  assert.match(body, /createTabAfterCurrent\(sidebarProjectId,[\s\S]*background: true/);
  assert.match(body, /pendingEditTabId: newTabId/);
  const sidebarBranch = body.slice(body.indexOf("keyboardTarget.kind === 'sidebar'"), body.indexOf("keyboardTarget.kind === 'pane'"));
  assert.doesNotMatch(sidebarBranch, /addTabToSplitPaneStrip|placeTab\(/);
});

test('Cmd+W detaches the exact focused pane tab and an empty pane is a no-op', () => {
  const start = app.indexOf('// Cmd+W - Close Tab/Project');
  const end = app.indexOf('// Cmd+, - Toggle Settings Modal', start);
  const body = app.slice(start, end);
  assert.match(body, /if \(!keyboardTarget\.projectId \|\| !keyboardTarget\.tabId\) return/);
  assert.match(body, /detachTabFromWindow\([\s\S]*keyboardTarget\.projectId,[\s\S]*keyboardTarget\.tabId,[\s\S]*keyboardTarget\.paneIndex/);
  // Открытая страница выбора — это то, что окно ПОКАЗЫВАЕТ, и Cmd+W закрывает
  // её, а не скрытую за ней прежнюю вкладку окна (NWT-1).
  assert.match(body, /closeWindowTabChooser\(keyboardTarget\.paneIndex, openChooserId\)/);
  assert.doesNotMatch(body.slice(body.indexOf("keyboardTarget.kind === 'pane'"), body.indexOf('const targetProjectId')), /closeTab\(/);
  const detachStart = store.indexOf('detachTabFromWindow: (projectId, tabId, paneIndex) => {');
  const detach = store.slice(detachStart, store.indexOf('\n  removeTabFromSplit:', detachStart));
  assert.doesNotMatch(detach, /restoreSplitPanePreviousTab\(tabId\)/,
    'local Cmd+W is removal, never an implicit pane-history navigation');
  assert.match(detach, /clearTabFromSplitPane\(tabId\)/);
  assert.match(detach, /removeTabFromCenterStrip\(projectId, tabId\)/);
  assert.match(detach, /splitPanes: \[\{ projectId: '', tabId: '' \}\]/);
  assert.match(detach, /activeSpaceTab: null/);
});

test('R3: команды рабочей вкладки не адресуются AI, скрытому за страницей выбора', () => {
  const workspace = readFileSync(join(renderer, 'components/Workspace/Workspace.tsx'), 'utf8');
  // Резолвер отвечает «рабочей вкладки здесь нет», и КАЖДЫЙ caller обязан
  // этот ответ донести. Прежде гард стоял, а следующей же строкой возвращался
  // fallback на активную вкладку — то есть гард сам себя отменял.
  const surfaceTarget = readFileSync(join(renderer, 'utils/paneSurfaceHotkeyTarget.mjs'), 'utf8');
  assert.match(surfaceTarget, /if \(paneShowsChooser\(pane\)\) return null/);

  // Ctrl+Enter / очередь промптов.
  assert.match(workspace, /if \(!targetTabId\) return;/);
  // Cmd+\]: `paneTab || effectiveTab` восстанавливал fallback после гарда.
  assert.doesNotMatch(workspace, /const target = paneTab \|\| effectiveTab;/);
  assert.match(workspace, /shows the new-tab chooser/);
  // Cmd+\[: `|| undefined` возвращал прежний fallback внутрь swapPrimarySurface.
  assert.doesNotMatch(workspace, /swapPrimarySurface\(resolvePaneSurfaceHotkeyTabId\(\{[\s\S]{0,240}\}\) \|\| undefined\)/);
  assert.match(workspace, /if \(!swapTargetTabId\) return;/);
});

test('S4: Escape принадлежит открытому меню, а окно ему уступает', () => {
  const overlay = readFileSync(join(renderer, 'utils/overlayDismissGesture.mjs'), 'utf8');
  // Меню полосы участвует в общем владении жестом.
  assert.match(overlay, /'\[data-pane-new-tab-menu\]'/);
  assert.match(overlay, /export function escapeBelongsToOverlay\(doc\)/);
  // Обработчик пустого окна регистрируется раньше меню, поэтому обязан
  // уступать: иначе его stopImmediatePropagation закрывал страницу выбора
  // вместо меню, открытого поверх неё.
  const escape = terminalArea.slice(
    terminalArea.indexOf('if (focusedEmptyPaneIndex < 0) return;'),
    terminalArea.indexOf('}, [focusedEmptyPaneIndex]);'),
  );
  const yieldAt = escape.indexOf('if (escapeBelongsToOverlay(document)) return;');
  // Ищем сам ВЫЗОВ, а не слово в комментарии рядом: комментарий выше как раз
  // называет `stopImmediatePropagation`, и поиск по голому имени прошёл бы
  // мимо настоящего порядка.
  const stopAt = escape.indexOf('e.stopImmediatePropagation();');
  assert.ok(yieldAt >= 0 && stopAt > yieldAt,
    'уступка стоит ДО перехвата события');
});

test('S4: команда меню сверяет раскладку, а не только workflow', () => {
  // spaceId не защищает от закрытия/перестановки окон ВНУТРИ того же
  // workflow: освободившийся номер окна тут же занимает другое окно.
  const action = paneStrip.slice(
    paneStrip.indexOf('const createTabHere = useCallback('),
    paneStrip.indexOf('const scrollBy = '),
  );
  assert.match(action, /menu\.layoutRevision !== splitPanesFingerprint\(store\.splitPanes\)/);
  assert.match(action, /menu\.spaceId !== store\.activeSpaceId/);
});

test('global switcher commit returns keyboard ownership to its displayed pane', () => {
  const commit = switcher.slice(switcher.indexOf('const commitRow ='), switcher.indexOf('// Средний клик по строке'));
  assert.match(commit, /setActiveArea\('workspace'\)/);
  const refocus = app.slice(app.indexOf('const handleWindowRefocus ='), app.indexOf("ipcRenderer.on('window:refocus-active'"));
  assert.match(refocus, /activeArea !== 'workspace'/);
  assert.match(refocus, /requestFocusedWorkspacePrimaryInput\('browser-window-refocus'\)/);
});

test('explicit tab and workflow focus returns input to the primary authoring surface', () => {
  assert.doesNotMatch(primaryFocus, /requestAnimationFrame|setTimeout|primaryInputFocusRequestVersion/);
  assert.match(primaryFocus, /new MutationObserver\(\(\) => \{/);
  assert.match(primaryFocus, /tabPresentationReady\(pending\.tabId\)/);
  assert.match(primaryFocus, /phase=armed/);
  assert.match(primaryFocus, /focusedPane\.tabId !== tabId/);
  assert.match(primaryFocus, /focusedEditableBelongsToUser\(\)/);
  assert.match(primaryFocus, /historyPanelOpenTabs\[tabId\] === true/);
  assert.match(primaryFocus, /history-panel:focus-composer/);
  assert.match(primaryFocus, /claude-sdk:focus-composer/);
  assert.match(primaryFocus, /focusEnd: true/);
  assert.match(primaryFocus, /selectionStart: Number\.MAX_SAFE_INTEGER/);
  assert.match(primaryFocus, /selectionEnd: Number\.MAX_SAFE_INTEGER/);
  assert.match(primaryFocus, /nt:window-refocus-active/);
  assert.match(primaryFocus, /\[Focus:PrimaryInput\]/);
  const sidebarActivation = tabBar.slice(
    tabBar.indexOf('const activateTabFromSidebar ='),
    tabBar.indexOf('const handleTabClick ='),
  );
  assert.match(sidebarActivation, /setActiveArea\('workspace'\)/);
  assert.match(tabBar, /requestTabPrimaryInputFocus\(tabId, 'sidebar-tab-click'\)/);
  assert.match(paneChip, /requestTabPrimaryInputFocus\(tabId, 'pane-tab-chip-click'\)/);
  assert.match(paneStrip, /requestFocusedWorkspacePrimaryInput\('pane-header-click'\)/);
  assert.match(terminalArea, /requestFocusedWorkspacePrimaryInput\('pane-body-click'\)/);
  const paneBodyFocusSelector = terminalArea.slice(
    terminalArea.indexOf('const preservesOwnFocus ='),
    terminalArea.indexOf(');', terminalArea.indexOf('const preservesOwnFocus =')) + 2,
  );
  assert.doesNotMatch(paneBodyFocusSelector, /\[data-history-owner\]|\[data-timeline\]/);
  assert.match(spaceStrip, /requestFocusedWorkspacePrimaryInput\('workflow-strip-click'\)/);
  assert.match(switcher, /requestTabPrimaryInputFocus\(row\.tab\.id, 'tab-switcher-commit'\)/);
  assert.match(history, /if \(detail\.immediate\) applyFocus\(\)/);
  const sdk = readFileSync(join(renderer, 'components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx'), 'utf8');
  assert.match(sdk, /textarea && focusEnd[\s\S]{0,120}setSelectionRange\(textarea\.value\.length, textarea\.value\.length\)/);
});
