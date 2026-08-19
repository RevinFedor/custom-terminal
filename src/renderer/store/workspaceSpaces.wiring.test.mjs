// Рабочие пространства — места, где они встречаются с остальным приложением.
//
// Сами правила живут в workspaceSpacesModel.mjs и покрыты там. Здесь закреплено
// то, что чистая модель проверить не может: как пространства переживают
// перезапуск, кто чистит их окна и чем полоса НЕ должна быть.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const strip = fs.readFileSync(path.join(workspaceDir, 'SpaceStrip.tsx'), 'utf8');
const map = fs.readFileSync(path.join(workspaceDir, 'PaneMap.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(workspaceDir, 'Workspace.tsx'), 'utf8');
const snapshot = fs.readFileSync(path.join(here, '..', 'utils', 'sessionSnapshot.mjs'), 'utf8');
const layoutConsts = fs.readFileSync(path.join(here, '..', 'constants', 'layout.ts'), 'utf8');
const tabBar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');
const signals = fs.readFileSync(path.join(workspaceDir, 'TabSignals.tsx'), 'utf8');

test('раскладка остаётся на верхнем уровне, пространство её СНИМАЕТ и КЛАДЁТ', () => {
  // Поля раскладки читают десятки мест. Завернуть каждое чтение в «раскладку
  // текущего пространства» значило бы переписать их все ради одного нового слоя
  // — и первое же забытое чтение молча смотрело бы в чужую раскладку.
  assert.match(store, /captureSpaceLayout\(st\)/);
  assert.match(store, /set\(\{ spaces: res\.spaces, activeSpaceId: res\.activeSpaceId, \.\.\.layout \}\)/);
});

test('пространства переживают перезапуск, и старая раскладка становится первым', () => {
  // Человек закрыл приложение с разложенными окнами и обязан увидеть их же, а
  // не пустое «main».
  assert.match(snapshot, /spaces:/);
  assert.match(snapshot, /activeSpaceId:/);
  assert.match(store, /restoreSpaces\(sessionState as any, restoredLayout\)/);
  // Текущему кладём ВЫЧИЩЕННУЮ раскладку: обе описывают одно, но мёртвые
  // вкладки убраны только в первой.
  assert.match(store, /\{ \.\.\.space\.layout, \.\.\.restoredLayout \}/);
});

test('раскладка чужого пространства чистится при ВОЗВРАТЕ в него', () => {
  // Пока в пространство не вернулись, его окна могут указывать на вкладки,
  // закрытые за это время; вкладки проектов, не открытых в этом запуске, на
  // старте вообще неизвестны. Момент возврата — первый, когда ответ «жива ли
  // вкладка» достоверен.
  const body = store.slice(store.indexOf('switchWorkspaceSpace: (id) =>'));
  assert.match(body.slice(0, 2000), /sanitizePanes\(layout\.splitPanes/);
  assert.match(body.slice(0, 2000), /packSplitSizes\(scrubbed\.panes/);
});

test('закрытая вкладка убирается из окон ВСЕХ пространств', () => {
  // Раскладка остальных лежит в снимках, обычные пути её не видят — чип,
  // указывающий на закрытую вкладку, дожил бы до возврата и нарисовался бы там
  // окном без разметки.
  assert.match(store, /dropTabsFromOtherSpaces\(st\.spaces, st\.activeSpaceId, \[tabId\]/);
  // И при закрытии ПРОЕКТА — пачкой, а не по вкладке за раз.
  assert.match(store, /const doomed = Array\.from\(workspace\?\.tabs\.keys\(\) \|\| \[\]\)/);
});

test('клик по вкладке из другого пространства ведёт ТУДА, а не заводит второе место', () => {
  // Вкладка, разложенная в другом пространстве, уже имеет своё место; открыть
  // её здесь значило бы завести ей второе. Переход стоит ПЕРЕД правилом окон,
  // чтобы то отработало уже в нужной раскладке.
  const at = store.indexOf('const holder = get().workspaceSpaceIndexOfTab(tabId)');
  const paneRule = store.indexOf('const splitRes = resolveSplitActivation(splitPanes, splitFocusedIndex, projectId, tabId)');
  assert.ok(at > 0 && at < paneRule, 'переход в пространство идёт до правила окон');
});

test('полоса читает пространства строкой, а не массивом', () => {
  // Селектор, отдающий объекты, — новая ссылка на каждую запись в стор
  // (правило Fingerprint).
  assert.match(strip, /s\.spaces\.map\(\(x\) => `\$\{x\.id\}:\$\{x\.name\}`\)\.join\(','\)/);
});

test('полоса стоит НАД окнами и внутри рабочей области', () => {
  // Пространство помнит раскладку окон — значит говорит про то, что справа от
  // бокового списка, а не про сам список.
  const center = workspace.indexOf('data-workspace-center');
  const at = workspace.indexOf('<SpaceStrip />');
  assert.ok(at > center, 'внутри центральной колонки');
  assert.ok(at < workspace.indexOf('<TerminalArea'), 'выше окон');
});

test('жесты полосы — те же, что у вкладок', () => {
  // Человек уже умеет это делать этажом ниже; другой набор жестов на соседней
  // строке читался бы как другая сущность.
  assert.match(strip, /onDoubleClick=\{\(e\) => \{\n\s+e\.stopPropagation\(\);\n\s+useWorkspaceStore\.getState\(\)\.addWorkspaceSpace\(\)/);
  assert.match(strip, /onContextMenu=/);
  assert.match(strip, /removeWorkspaceSpace\(id\)/);
  // Переименование начинается с ВЫДЕЛЕННЫМ текстом, и выделяем ровно один раз:
  // `ref` зовётся на каждую букву, и повторный select() стирал бы набранное.
  assert.match(strip, /node\.select\(\)/);
  assert.match(strip, /focusedRef\.current = true/);
});

test('карта в списке рисует раскладку ТОГО пространства, где вкладка лежит', () => {
  // Вопрос «где она открыта» не перестаёт иметь ответ оттого, что смотрят в
  // другую раскладку.
  assert.match(map, /const at = s\.workspaceSpaceIndexOfTab\(tabId\)/);
  // Чужое помечается РАМКОЙ и номером, а не приглушением: самый блёклый цвет
  // уже занят чужими окнами, ниже него ничего нет.
  assert.match(map, /boxShadow: foreign \? 'inset 0 0 0 1px/);
  assert.match(map, /PANE_MAP_SPACE_SLOT_W_PX/);
  // Место под цифру резервируется всегда — иначе имена вкладок дёргаются.
  assert.match(map, /color: foreign \? '#b9b9c0' : 'transparent'/);
});


test('новое пространство — ПУСТОЕ ОКНО, а не «окон нет»', () => {
  // «Окон нет» в этом приложении означает одиночный режим, а он всегда
  // показывает вкладку центра — со стороны это читается как «моя вкладка
  // переехала в новое пространство». Юзер: *«мы создали новое пространство, я
  // потом буду туда по отдельности тыкать какие-то вкладки… у меня будет пустое
  // окно»*.
  const add = store.slice(store.indexOf('addWorkspaceSpace: () => {'));
  const body = add.slice(0, add.indexOf('\n  },'));
  assert.match(body, /splitPanes: \[\{ projectId: '', tabId: '' \}\]/);
  assert.ok(!/splitPanes: \[\],/.test(body), 'пустой список окон вернул бы одиночный режим');
});

test('одинокое окно С ВКЛАДКОЙ схлопывается, ПУСТОЕ остаётся — одним правилом', () => {
  // Одно окно с вкладкой и есть одиночный режим, просто другими словами. Три
  // места приходят к этому состоянию (активация, перенос из меню окон, чистка
  // при возврате), и своё «если» в каждом разошлось бы на первом же случае.
  const model = fs.readFileSync(path.join(here, '..', 'utils', 'splitPanesModel.mjs'), 'utf8');
  assert.match(model, /export function collapseLonePane\(panes\)/);
  assert.match(model, /if \(list\.length !== 1 \|\| !list\[0\] \|\| !list\[0\]\.tabId\) return null;/);
  assert.match(store, /if \(collapseLonePane\(res\.panes\)\)/);
  // Раскладка из одних пустых окон обязана переживать чистку: это состояние
  // только что созданного пространства.
  assert.ok(
    !/!unique\.some\(\(p\) => p\.tabId\)\) return \{ panes: \[\]/.test(model),
    'правило «нет ни одной вкладки — нечего восстанавливать» съедало пустое пространство',
  );
});

test('полоса пространств той же меры, что строка проектов', () => {
  // Две строки-переключателя одной высоты читаются как один язык. Высота берётся
  // ИЗ строки проектов, а не повторяется числом.
  assert.match(layoutConsts, /export const SPACE_STRIP_H = TITLE_BAR_H;/);
  assert.match(strip, /height: PROJECT_CARD_MAX_H/);
  assert.match(strip, /useUIStore\(\(s\) => s\.projectTabsFontSize\)/);
});

test('⌘-клик по вкладке открывает НОВОЕ окно, и подпись про это стоит на рамке', () => {
  // Обычный клик кладёт вкладку в окно, где фокус; ⌘ заводит рядом ещё одно.
  assert.match(tabBar, /\} else if \(e\.metaKey\) \{/);
  assert.match(tabBar, /addTabToSplit\(projectId, tabId\)\)/);
  // Отказ (вкладка уже в окне, колонки кончились) обязан приводить к обычной
  // активации: клик не может молчать.
  assert.match(tabBar, /if \(!useWorkspaceStore\.getState\(\)\.addTabToSplit\(projectId, tabId\)\) \{\n\s+useWorkspaceStore\.getState\(\)\.activateCenterTab/);
  // Множественный выбор не потерян — у него сменилась клавиша.
  assert.match(tabBar, /\} else if \(e\.altKey \|\| e\.ctrlKey\) \{/);
  assert.match(tabBar, /toggleTabSelection\(projectId, tabId, true\)/);
  // Подпись — на границе карточки, смещена ВНУТРЬ, 12px, только пока ⌘ зажат и
  // только там, где жест сработает.
  assert.match(signals, /export const TAB_CMD_HINT_FONT_PX = 12;/);
  assert.match(signals, /top: -Math\.round\(TAB_CMD_HINT_FONT_PX \* 0\.28\)/);
  assert.match(tabBar, /<TabCmdHint text="открыть в новом окне" visible=\{cmdPeekMode && effectiveHovered && canOpenInNewWindow\} \/>/);
  assert.match(tabBar, /paneIndexHoldingTab\(s\.splitPanes, tab\.id\) < 0/);
});


test('действия окна — absolute-слой поверх полосы, видимый только в фокусе', () => {
  // Пока Git и деление держали место в строке, нефокусное узкое окно отдавало
  // ширину под невидимые кнопки и чипы обрезались там, где на экране пусто.
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.match(chrome, /data-split-pane-actions/);
  const at = chrome.indexOf('data-split-pane-actions');
  const box = chrome.slice(at, at + 900);
  assert.match(box, /position: 'absolute'/);
  const css = fs.readFileSync(path.join(here, '..', 'styles', 'globals.css'), 'utf8');
  // Только фокус, без hover-проявления, и невидимый слой не ест клики чипов.
  assert.match(css, /\[data-split-attach-row\]:not\(\[data-focused\]\) \[data-split-pane-actions\] \{\n  opacity: 0;\n  pointer-events: none;/);
  assert.ok(!/:not\(\[data-focused\]\):hover \[data-split/.test(css), 'hover-проявление у нефокусных убрано');
});

test('уголок фокусного окна тянет обе перегородки, тем же resizeFractions', () => {
  const model = fs.readFileSync(path.join(here, '..', 'utils', 'splitPanesModel.mjs'), 'utf8');
  assert.match(model, /export function splitCornerDescriptors\(panes, focusedIndex, sizes = null\)/);
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.match(chrome, /splitCornerDescriptors\(panes, focusedIndex, sizes\)/);
  assert.match(chrome, /data-split-corner/);
  // Обе оси одним ходом — никакой отдельной диагональной математики.
  assert.match(chrome, /col: \{ dividerIndex: corner\.colDividerIndex \}/);
  assert.match(chrome, /row: \{ columnIndex: corner\.rowColumnIndex, dividerIndex: corner\.rowDividerIndex \}/);
});

test('маркер статуса кликабелен и не активирует вкладку', () => {
  const signals = fs.readFileSync(path.join(workspaceDir, 'TabSignals.tsx'), 'utf8');
  assert.match(signals, /export function TabStatusMarkerButton\(/);
  // Обе фазы: pointerdown (фокус берётся раньше click) и click (активация).
  const at = signals.indexOf('data-tab-status-marker-button');
  const btn = signals.slice(at, at + 1200);
  assert.match(btn, /onPointerDown=\{\(e\) => \{\n\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+e\.stopPropagation\(\);/);
  assert.match(btn, /cursor: 'pointer'/);
  // Split-фокус живёт на window-capture-pointerdown — исключение там.
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  assert.match(area, /data-tab-status-marker-button.*data-task-plan-status-trigger/);
  // Обе вкладочные поверхности используют кнопку, не пассивный маркер.
  const tabBar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');
  const chip = fs.readFileSync(path.join(workspaceDir, 'PaneTabChip.tsx'), 'utf8');
  assert.match(tabBar, /<TabStatusMarkerButton/);
  assert.match(chip, /<TabStatusMarkerButton/);
});

test('дуга-лоадер следует форме, а не вращает рамку', () => {
  // Вращаемая рамка верна только для круга; овал Git и овал счётчика проекта
  // используют conic-градиент под маской формы.
  const css = fs.readFileSync(path.join(here, '..', 'styles', 'globals.css'), 'utf8');
  assert.match(css, /\.noted-shape-ring \{/);
  assert.match(css, /conic-gradient\(/);
  assert.match(css, /mask-composite: exclude/);
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  assert.match(git, /data-git-chip-spinner[\s\S]{0,200}noted-shape-ring/);
  assert.ok(!/data-git-chip-spinner[\s\S]{0,300}animate-spin/.test(git), 'овал git больше не вращает рамку');
  const app = fs.readFileSync(path.join(here, '..', '..', 'renderer', 'App.tsx'), 'utf8');
  assert.match(app, /noted-shape-ring absolute inset-0 rounded-full/);
});

test('порог имени ветки Git — настройка, а не константа', () => {
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  assert.match(git, /BRANCH_MIN_STORAGE_KEY/);
  assert.match(git, /branchNameMinHostPx/);
  assert.match(git, /Branch name min width/);
  assert.match(git, /width >= branchMinHostPx/);
});
