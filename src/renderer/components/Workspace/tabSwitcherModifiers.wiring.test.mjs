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

test('боковой список: обычный клик ведёт к вкладке, Shift переносит, Alt/Ctrl — выделение', () => {
  const click = between(
    tabBar,
    'const handleTabClick = (e: React.MouseEvent, tabId: string) => {',
    '// OSC 133 Event-driven process status',
  );
  assert.match(click, /if \(e\.altKey \|\| e\.ctrlKey\)[\s\S]{0,260}toggleTabSelection/);
  assert.match(click, /if \(e\.shiftKey\)[\s\S]{0,260}moveTabToFocusedWindow\(tabId\)/);
  assert.match(click, /activateTabFromSidebar\(tabId\);/);
  assert.doesNotMatch(click, /selectTabRange/);
  // Обычный клик не имеет своей ветки «добавить в текущее окно»: это и был тот
  // путь, который уносил вкладку из чужой раскладки.
  assert.doesNotMatch(click, /addTabToSplitPaneStrip|addTabToCenterStrip/);
});

test('оба жеста бокового списка идут через общее размещение стора', () => {
  assert.match(tabBar, /const moveTabToFocusedWindow = \(tabId: string\) => \{[\s\S]{0,400}placeTab\(projectId, tabId, \{ mode: 'move-here' \}\)/);
  const activate = between(
    tabBar,
    'const activateTabFromSidebar = (tabId: string) => {',
    'const handleTabClick =',
  );
  assert.match(activate, /placeTab\(projectId, tabId\)/);
});

test('переключатель: Shift и средний клик — один и тот же перенос', () => {
  const commit = between(
    switcher,
    'const commitRow = useCallback((row: Row | undefined, addToFocusedWindow = false) => {',
    '// Средний клик по строке',
  );
  assert.match(commit, /if \(addToFocusedWindow\) \{/);
  assert.match(commit, /placeTab\(row\.projectId, row\.tab\.id, \{ mode: 'move-here' \}\)/);
  assert.match(commit, /placeTab\(row\.projectId, row\.tab\.id\)/);
  // Своей арифметики полос у переключателя больше нет.
  assert.doesNotMatch(commit, /addTabToSplitPaneStrip|addTabToCenterStrip/);
  // Средний клик — тот же commitRow с поднятым флагом, а не вторая реализация.
  assert.match(switcher, /if \(e\.button === 1\) \{[\s\S]{0,200}commitRow\(row, true\);/);
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

test('плашка на карточке обещает ровно то, что сделает жест', () => {
  assert.match(rows, /export function resolveTabWindowAction\(/);
  assert.match(rows, /mode: PLACEMENT_MOVE_HERE/);
  assert.match(rows, /return describeTabPlacement\(plan\);/);
  // Подпись НЕ собирается на месте из флагов: второй ответ на «что произойдёт»
  // разошёлся бы с первым.
  assert.match(rows, /text=\{windowAction \|\| ''\}/);
  assert.match(rows, /data-tab-window-action=\{windowAction \|\| undefined\}/);
});

test('размещение решает чистый резолвер, стор только пишет', () => {
  const place = between(store, '  placeTab: (projectId, tabId, options) => {', '\n  isRestoring:');
  assert.match(place, /resolveTabPlacement\(\{ tabId, mode, \.\.\.placementWorldFromState\(st\) \}\)/);
  // Переход в чужое пространство — ПЕРЕД показом, иначе окно вкладки ещё не на
  // экране и правило окон отработает в чужой раскладке.
  assert.match(place, /if \(plan\.crossSpace && plan\.spaceId && plan\.spaceId !== get\(\)\.activeSpaceId\)[\s\S]{0,120}switchWorkspaceSpace\(plan\.spaceId\)/);
  // Перенос сначала снимает чип со СТАРОГО места — во всех пространствах, иначе
  // у одного живого терминала оказалось бы два чипа. Окно-ПОЛУЧАТЕЛЬ при этом
  // исключено: иначе жест по чипу этого же окна переставил бы его в конец
  // полосы, хотя человек его не двигал.
  assert.match(place, /if \(plan\.detach\) \{[\s\S]{0,1400}dropTabsFromOtherSpaces\(/);
  assert.match(place, /dropTabFromAllPaneStrips\(get\(\)\.splitPanes, tabId, \{[\s\S]{0,120}keepPaneIndex: plan\.paneIndex,/);
  // И заменяет показанную вкладку, а не дописывает чип в конец полосы.
  assert.match(place, /replacePaneShownTab\(get\(\)\.splitPanes, plan\.paneIndex, projectId, tabId\)/);
  assert.doesNotMatch(place, /addTabToCenterStrip/);
});

test('Shift-плашка и Cmd-действия процесса остаются разными сигналами', () => {
  assert.match(tabBar, /shiftPeekMode=\{[^}]*isShiftPressed && isMouseInTabBar\}/);
  assert.match(tabBar, /visible=\{shiftPeekMode && effectiveHovered && targetWindowAction !== null\}/);
  assert.match(tabBar, /verticalRestartStopMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.match(tabBar, /verticalRestartClearMode[\s\S]{0,420}&& cmdPeekMode/);
  assert.doesNotMatch(tabBar, /visible=\{cmdPeekMode && effectiveHovered && targetWindowAction/);
});

test('выбранная или наведённая строка переключателя владеет Shift-плашкой', () => {
  assert.match(switcher, /const selectedWindowAction = useWorkspaceStore\(\(state\): TabWindowAction => \{/);
  assert.match(switcher, /if \(!shiftPressed \|\| !selectedTabRow \|\| selectedTabRow\.missing\) return null;/);
  assert.match(switcher, /windowAction=\{shiftPressed && selected \? selectedWindowAction : null\}/);
});

test('клик, Enter и отпускание Ctrl передают взведённое Shift-действие', () => {
  const routed = switcher.match(/commitRow\([^;\n]+, shiftPressedRef\.current\)/g) || [];
  assert.equal(routed.length, 3, 'два пути Enter и отпускание Ctrl');
  assert.match(switcher, /commitRow\(row, e\.shiftKey\)/, 'модификаторы берутся из самого события');
  assert.match(switcher, /if \(e\.key === 'Control'\)[\s\S]{0,1000}commitRow\(effectiveRows\[idx\], shiftPressedRef\.current\)/);
});

test('Ctrl+Shift+Tab остаётся обратной навигацией; Shift-действие взводится после открытия', () => {
  assert.match(switcher, /setSelectedIndex\(-2 - \(shiftKey \? 1 : 0\)\)/);
  assert.match(switcher, /selectedIndex === -3[\s\S]{0,350}sel\[sel\.length - 1\]/);
  assert.match(switcher, /stepIndex\(rowsRef\.current, prev, e\.shiftKey \? -1 : \+1\)/);
  assert.match(switcher, /if \(e\.key === 'Shift' && cur !== null\) setShiftMode\(true\)/);
  assert.match(switcher, /\(e\.metaKey !== e\.ctrlKey\) && !e\.altKey && !e\.shiftKey && e\.code === 'KeyP'/);
  const searchHotkey = between(switcher, '// Cmd+P / Ctrl+P — open search mode', "if (cur === null) return;");
  assert.match(searchHotkey, /!e\.shiftKey/, 'сначала открыть, потом держать Shift для другого действия');
});
