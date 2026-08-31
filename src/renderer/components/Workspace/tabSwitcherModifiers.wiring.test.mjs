// ОДИН контракт размещения на четыре поверхности.
//
// Боковой список, `Ctrl+Tab`/`Cmd+P`, меню оркестрации и чипы шапки задают один
// вопрос — «покажи мне эту вкладку» — и обязаны отвечать одинаково. Модельные
// тесты (`utils/tabPlacementResolver.test.mjs`) держат САМО правило; здесь —
// проводка, которую чистая модель не видит: какой жест куда идёт и что ни одна
// поверхность не завела собственный путь мимо общего.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..', '..');
const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');
const switcher = fs.readFileSync(path.join(here, 'TabSwitcherOverlay.tsx'), 'utf8');
const rows = fs.readFileSync(path.join(here, 'TabListRows.tsx'), 'utf8');
const orchestration = fs.readFileSync(path.join(here, 'OrchestrationStatusChip.tsx'), 'utf8');
const store = fs.readFileSync(path.join(rendererRoot, 'store/useWorkspaceStore.ts'), 'utf8');

const between = (source, start, end) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, at + start.length);
  assert.ok(to > at, `missing end marker: ${end}`);
  return source.slice(at, to);
};

test('боковой список: Shift выбирает диапазон, Cmd/Ctrl/Alt переключают отдельные строки', () => {
  const click = between(
    tabBar,
    'const handleTabClick = (e: React.MouseEvent, tabId: string) => {',
    '// OSC 133 Event-driven process status',
  );
  assert.match(click, /if \(e\.shiftKey\)[\s\S]{0,260}selectTabRange\(projectId, tabId, visibleRangeTabIds\)/);
  assert.match(click, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\)[\s\S]{0,260}toggleTabSelection/);
  assert.match(click, /activateTabFromSidebar\(tabId\);/);
  const shiftBranch = between(click, 'if (e.shiftKey) {', 'if (e.metaKey');
  assert.doesNotMatch(shiftBranch, /addTabToFocusedWindow|placeTab/);
  // Обычный клик не имеет своей ветки «добавить в текущее окно»: это и был тот
  // путь, который уносил вкладку из чужой раскладки.
  assert.doesNotMatch(click, /addTabToSplitPaneStrip|addTabToCenterStrip/);
});

test('обычный клик и middle-click сохраняют два явных placement режима', () => {
  assert.match(tabBar, /const addTabToFocusedWindow = \(tabId: string\) => \{[\s\S]{0,400}placeTab\(projectId, tabId, \{ mode: 'add-here' \}\)/);
  const activate = between(
    tabBar,
    'const activateTabFromSidebar = (tabId: string) => {',
    'const handleTabClick =',
  );
  assert.match(activate, /placeTab\(projectId, tabId\)/);
});

test('переключатель: только средний клик добавляет последним чипом', () => {
  const commit = between(
    switcher,
    'const commitRow = useCallback((row: Row | undefined, addToFocusedWindow = false) => {',
    '// Средний клик по строке',
  );
  assert.match(commit, /if \(addToFocusedWindow\) \{/);
  assert.match(commit, /placeTab\(row\.projectId, row\.tab\.id, \{ mode: 'add-here' \}\)/);
  assert.match(commit, /placeTab\(row\.projectId, row\.tab\.id\)/);
  // Своей арифметики полос у переключателя больше нет.
  assert.doesNotMatch(commit, /addTabToSplitPaneStrip|addTabToCenterStrip/);
  // Средний клик — единственный consumer add-here.
  assert.match(switcher, /if \(e\.button === 1\) \{[\s\S]{0,200}commitRow\(row, true\);/);
  assert.doesNotMatch(switcher, /shiftPressed|selectedWindowAction|data-tab-switcher-shift-mode/);
  assert.match(switcher, /commitCtrlSelection[\s\S]{0,1800}commitRow\(row\);/);
  // И он больше НЕ удаляет запись из истории.
  assert.doesNotMatch(switcher, /forgetGlobalTabVisit/);
});

test('меню оркестрации — тот же consumer, а не прямой switchTab', () => {
  const open = between(
    orchestration,
    'const openLinkedTab = useCallback(async (run: OrchestrationRun) => {',
    'const runAction = useCallback(',
  );
  assert.match(open, /placeTab\(projectId, linkedTabId\)/);
  assert.doesNotMatch(open, /switchTab\(projectId, linkedTabId\)/);
});

test('Shift hover и Shift click используют один exact visible range', () => {
  assert.match(tabBar, /resolveTabRangeSelection\(visibleRangeTabIds, workspace\.activeTabId, shiftRangeTargetId\)/);
  assert.match(tabBar, /selectTabRange\(projectId, tabId, visibleRangeTabIds\)/);
  assert.match(tabBar, /data-tab-range-preview-count=\{shiftRangePreviewActive \? shiftRangePreviewIds\.length/);
  assert.match(tabBar, /isSelected=\{selectedForDisplay\(tab\.id\)\}/);
  assert.match(tabBar, /isRangePreview=\{shiftRangePreviewActive && shiftRangePreviewSet\.has\(tab\.id\)\}/);
  assert.doesNotMatch(tabBar, /shiftPeekMode|resolveTabWindowAction|sidebar-add-here[^'\n]*Shift/);
  assert.doesNotMatch(rows, /TabCmdHint|data-tab-window-action|resolveTabWindowAction/);
  const storeRange = between(store, '  selectTabRange: (projectId, tabId, orderedTabIds) => {', '\n  clearSelection:');
  assert.match(storeRange, /resolveTabRangeSelection\(order, workspace\.activeTabId, tabId\)/);
  assert.match(storeRange, /workspace\.selectedTabIds = rangeIds/);
  assert.doesNotMatch(storeRange, /\.\.\.workspace\.selectedTabIds/);
});

test('range preview cannot read drag state through a render-time TDZ', () => {
  const dragStateAt = tabBar.indexOf('const [isDraggingTab, setIsDraggingTab] = useState(false)');
  const rangePreviewAt = tabBar.indexOf('const shiftRangePreviewActive =');
  assert.ok(dragStateAt >= 0 && rangePreviewAt > dragStateAt,
    'isDraggingTab must be initialized before Shift preview is evaluated');
});

test('размещение решает чистый резолвер, стор только пишет', () => {
  const place = between(store, '  placeTab: (projectId, tabId, options) => {', '\n  isRestoring:');
  assert.match(place, /resolveTabPlacement\(\{ tabId, mode, \.\.\.placementWorldFromState\(st\) \}\)/);
  // Переход в чужое пространство — ПЕРЕД показом, иначе окно вкладки ещё не на
  // экране и правило окон отработает в чужой раскладке.
  assert.match(place, /if \(plan\.crossSpace && plan\.spaceId && plan\.spaceId !== get\(\)\.activeSpaceId\)[\s\S]{0,120}switchWorkspaceSpace\(plan\.spaceId\)/);
  // Добавление сначала снимает чип со СТАРОГО места — во всех пространствах, иначе
  // у одного живого терминала оказалось бы два чипа. Окно-ПОЛУЧАТЕЛЬ при этом
  // исключено: иначе жест по чипу этого же окна переставил бы его в конец
  // полосы, хотя человек его не двигал.
  assert.match(place, /if \(plan\.detach\) \{[\s\S]{0,1400}dropTabsFromOtherSpaces\(/);
  assert.match(place, /dropTabFromAllPaneStrips\(get\(\)\.splitPanes, tabId, \{[\s\S]{0,120}keepPaneIndex: plan\.paneIndex,/);
  assert.match(place, /if \(plan\.kind === 'append'\)/);
  assert.match(place, /addTabToSplitPaneStrip\(plan\.paneIndex, projectId, tabId\)/);
  assert.match(place, /addTabToCenterStrip\(projectId, tabId\)/);
  // Обычный move по-прежнему заменяет показанную вкладку.
  assert.match(place, /replacePaneShownTab\(get\(\)\.splitPanes, plan\.paneIndex, projectId, tabId\)/);
});

test('Cmd-действия процесса не смешиваются с range preview', () => {
  assert.match(tabBar, /verticalRestartStopMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.match(tabBar, /verticalRestartClearMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.match(tabBar, /transition: isRangePreview[\s\S]{0,80}\? 'none'/);
});

test('Ctrl+Shift+Tab остаётся только обратной навигацией', () => {
  assert.match(switcher, /setSelectedIndex\(-2 - \(shiftKey \? 1 : 0\)\)/);
  assert.match(switcher, /selectedIndex === -3[\s\S]{0,350}sel\[sel\.length - 1\]/);
  assert.match(switcher, /stepIndex\(rowsRef\.current, prev, e\.shiftKey \? -1 : \+1\)/);
  assert.doesNotMatch(switcher, /setShiftMode|shiftPressedRef/);
  assert.match(switcher, /\(e\.metaKey !== e\.ctrlKey\) && !e\.altKey && !e\.shiftKey && e\.code === 'KeyP'/);
  const searchHotkey = between(switcher, '// Cmd+P / Ctrl+P — open search mode', "if (cur === null) return;");
  assert.match(searchHotkey, /!e\.shiftKey/, 'сначала открыть, потом держать Shift для другого действия');
});
