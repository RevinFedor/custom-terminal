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
const paneChip = fs.readFileSync(path.join(workspaceDir, 'PaneTabChip.tsx'), 'utf8');
const pendingOperation = fs.readFileSync(path.join(workspaceDir, 'TabPendingOperation.tsx'), 'utf8');
const tabListRows = fs.readFileSync(path.join(workspaceDir, 'TabListRows.tsx'), 'utf8');
const signals = fs.readFileSync(path.join(workspaceDir, 'TabSignals.tsx'), 'utf8');
const spacesModel = fs.readFileSync(path.join(here, '..', 'utils', 'workspaceSpacesModel.mjs'), 'utf8');
const workflowBadges = fs.readFileSync(path.join(workspaceDir, 'WorkflowActivityBadges.tsx'), 'utf8');
const workflowActivity = fs.readFileSync(path.join(here, '..', 'utils', 'workflowActivityCounts.mjs'), 'utf8');

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
  // Родитель подписан только на порядок id. Имя/иконка/projectIds читаются
  // гранулярно самим чипом; длинный data URL не пересобирается на каждый write
  // стора и selector не возвращает массив (Fingerprint Pattern).
  assert.match(strip, /s\.spaces\.map\(\(space\) => space\.id\)\.join\('\\u0000'\)/);
  assert.match(strip, /s\.spaces\.find\(\(space\) => space\.id === id\)\?\.icon/);
});

test('полоса стоит НАД окнами и внутри рабочей области', () => {
  // Пространство помнит раскладку окон — значит говорит про то, что справа от
  // бокового списка, а не про сам список.
  const center = workspace.indexOf('data-workspace-center');
  const at = workspace.indexOf('<SpaceStrip');
  assert.ok(at > center, 'внутри центральной колонки');
  assert.ok(at < workspace.indexOf('<TerminalArea'), 'выше окон');
});

test('жесты полосы: create/delete сохраняются, ПКМ открывает меню действий', () => {
  // Человек уже умеет это делать этажом ниже; другой набор жестов на соседней
  // строке читался бы как другая сущность.
  assert.match(strip, /onDoubleClick=\{\(e\) => \{\n\s+e\.stopPropagation\(\);\n\s+useWorkspaceStore\.getState\(\)\.addWorkspaceSpace\(\)/);
  assert.match(strip, /onContextMenu=/);
  assert.match(strip, /removeWorkspaceSpace\(id\)/);
  assert.match(strip, /data-workflow-context-menu=\{id\}/);
  assert.match(strip, /Переименовать/);
  assert.match(strip, /Иконка и проекты…/);
  // Переименование начинается только из menu с ВЫДЕЛЕННЫМ текстом.
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


test('новое пространство — ПУСТОЕ ОКНО, а Settings может создать его в фоне', () => {
  // «Окон нет» в этом приложении означает одиночный режим, а он всегда
  // показывает вкладку центра — со стороны это читается как «моя вкладка
  // переехала в новое пространство». Юзер: *«мы создали новое пространство, я
  // потом буду туда по отдельности тыкать какие-то вкладки… у меня будет пустое
  // окно»*.
  const add = store.slice(store.indexOf('addWorkspaceSpace: (options) => {'));
  const body = add.slice(0, add.indexOf('\n  },'));
  assert.match(body, /splitPanes: \[\{ projectId: '', tabId: '' \}\]/);
  assert.ok(!/splitPanes: \[\],/.test(body), 'пустой список окон вернул бы одиночный режим');
  assert.match(body, /if \(!activate\) \{/);
  assert.match(body, /set\(\{ spaces: res\.spaces \}\)/);
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

test('обычный клик ведёт К ВКЛАДКЕ, Shift добавляет её сюда', () => {
  const click = tabBar.slice(
    tabBar.indexOf('const handleTabClick = (e: React.MouseEvent, tabId: string) => {'),
    tabBar.indexOf('// OSC 133 Event-driven process status'),
  );
  // Alt/Ctrl по-прежнему означают multi-select, Shift — не range-select.
  assert.match(click, /if \(e\.altKey \|\| e\.ctrlKey\) \{[\s\S]{0,260}toggleTabSelection\(projectId, tabId, true\)/);
  assert.doesNotMatch(click, /selectTabRange/);
  // Обычный клик (и ⌘-клик) — общее размещение: вкладка с местом показывается
  // ТАМ, включая переход в её пространство. Своей ветки «добавить сюда» у него
  // больше нет — именно она уносила вкладку из чужой раскладки.
  assert.match(click, /if \(e\.shiftKey\) \{[\s\S]{0,300}addTabToFocusedWindow\(tabId\)/);
  assert.match(click, /activateTabFromSidebar\(tabId\);/);
  assert.doesNotMatch(click, /addTabToSplitPaneStrip|addTabToCenterStrip/);
  assert.doesNotMatch(tabBar, /addTabToSplit\(projectId, tabId\)\)/, 'жест больше не создаёт окно');

  // Подпись — та же плашка на границе карточки, но её включает Shift. Cmd
  // остаётся отдельным сигналом для Restart/Stop/Clear.
  assert.match(signals, /export const TAB_CMD_HINT_FONT_PX = 12;/);
  assert.match(signals, /top: -Math\.round\(TAB_CMD_HINT_FONT_PX \* 0\.28\)/);
  assert.match(tabBar, /visible=\{shiftPeekMode && effectiveHovered && targetWindowAction !== null\}/);
  assert.match(tabBar, /verticalRestartStopMode[\s\S]{0,500}cmdPeekMode/);
  // Один резолвер обслуживает список, переключатель и меню оркестрации.
  assert.match(tabListRows, /mode: PLACEMENT_ADD_HERE/);
  assert.match(tabListRows, /return describeTabPlacement\(plan\);/);
});

test('никакая живая вкладка не прячется из бокового списка', () => {
  // Здесь проверялось скрытие `windowScoped`-вкладки, созданной прямо в полосе
  // окна. Оно делало живую вкладку НЕДОСТУПНОЙ, как только чип уходил из
  // полосы, а страховка «вернуть строку» вместо возврата давала фантомный
  // «Терминал» после закрытия. Одна вкладка — одна строка, всегда.
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.doesNotMatch(chrome, /windowScoped: true/);
  // Вкладка из полосы — обычная строка-СОСЕД показанной, не её ребёнок.
  assert.match(chrome, /createTabAfterCurrent\(owner, EMPTY_TAB_NAME, cwd, \{/);
  assert.match(chrome, /visualParentTabId: '',/);
  assert.doesNotMatch(tabBar, /hiddenWindowScopedTabIds/);
  assert.match(tabBar, /const mainTabsBase = allTabs;/);
});

test('пространство возвращает вкладку, на которой человек стоял', () => {
  // Раскладка без активной вкладки показывала центр от соседнего пространства.
  assert.match(spacesModel, /'activeSpaceTab',/);
  assert.match(store, /set\(\{ activeSpaceTab: \{ projectId, tabId \} \}\);/);
  // Вкладка проверяется той же меркой, что и окна: пока сюда не возвращались,
  // её могли закрыть.
  assert.match(store, /let tabAlive = !!savedTab\?\.tabId && alive\(savedTab\.projectId, savedTab\.tabId\);/);
  // Уехавшую в другое пространство вкладку не восстанавливаем: активация
  // немедленно увела бы из пространства, в которое человек только что кликнул
  // («кликаю на пространство 2, перекидывает в 1»).
  assert.match(store, /const heldElsewhere = spaceIndexHoldingTab\(/);
  assert.match(store, /if \(heldElsewhere\) tabAlive = false;/);
  // Возврат идёт через обычную активацию: она же двигает боковой список,
  // свежесть и окно, которое эту вкладку показывает.
  assert.match(store, /if \(!alreadyShown\) get\(\)\.activateCenterTab\(savedTab\.projectId, savedTab\.tabId\);/);
});

test('activity badge переехал с проекта на workflow и считает его дочерние проекты', () => {
  const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');
  // Старые два числа workflow и project-level зелёный badge удалены.
  assert.doesNotMatch(strip, /data-space-tab-count|data-space-busy-count/);
  assert.doesNotMatch(app, /activeProcessCount\?: number/);
  // Workflow читает все вкладки явно привязанных проектов: фоновый процесс не
  // исчезает только потому, что его chip сейчас не разложен в окне.
  assert.match(strip, /projectIds\.forEach\(\(projectId\) => \{/);
  assert.match(strip, /s\.openProjects\.get\(projectId\)\?\.tabs\.forEach/);
  assert.match(strip, /processAlive: processStatus\.get\(tabId\) === true/);
  assert.match(strip, /busy: busyTabs\.get\(tabId\) === true/);
  assert.match(strip, /pasteBusy: pasteBusyTabs\.get\(tabId\) === true/);
  assert.match(strip, /inheritedBusy: inheritedBusyTabIds\.has\(tabId\)/);
  assert.match(strip, /<WorkflowActivityBadges/);
  assert.match(workflowActivity, /return \{ activeCount, busyCount \}/);
  assert.match(workflowBadges, /data-workflow-active-count/);
  assert.match(workflowBadges, /data-workflow-busy-count/);
  assert.match(workflowBadges, /'--noted-ring-color': '#f59e0b'/);
  // Наведение отвечает «попадёшь сюда» и НЕ дотягивает до текущего состояния —
  // иначе полоса перестанет отвечать, где человек находится.
  assert.match(strip, /const \[hovered, setHovered\] = useState\(false\);/);
  assert.match(strip, /onMouseEnter=\{\(\) => setHovered\(true\)\}/);
  assert.match(strip, /hovered \? 'rgba\(255,255,255,0\.055\)' : 'transparent'/);
});

test('workflow metadata durable и project имеет одного родителя', () => {
  assert.match(spacesModel, /projectIds: Array\.isArray\(s\.projectIds\)/);
  assert.match(spacesModel, /icon: typeof s\.icon === 'string'/);
  assert.match(spacesModel, /export function updateSpaceMetadata/);
  assert.match(store, /updateWorkspaceSpaceMetadata: \(id, updates\) => \{/);
  assert.match(store, /const claimed = new Set\(res\.space\.projectIds \|\| \[\]\)/);
  assert.match(store, /filter\(\(projectId: string\) => !claimed\.has\(projectId\)\)/);
  assert.match(snapshot, /\? \{ \.\.\.space, layout: captureSpaceLayout\(state\) \}/);
});


test('действия окна — блочный сосед; скрытый focus-блок сохраняет scroll-space без чёрной коробки', () => {
  // Третья итерация (2026-08-20). Слой ПОВЕРХ полосы дал три бага разом: чип
  // уезжал под кнопки («вкладка должна оканчиваться там, где начинается
  // гит»), колесо полосы молчало (clientWidth включал закрытую часть — полоса
  // «думала», что прокручивать нечего), подложка рисовала вторую вертикальную
  // границу рядом с рамкой Git. Юзер: «он, наверное, всегда должен быть
  // блочным, по логике».
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  const at = chrome.indexOf('data-split-pane-actions');
  const box = chrome.slice(at, at + 1800);
  assert.match(box, /position: 'relative',/);
  assert.ok(!/position: 'absolute'/.test(box), 'ряд больше не absolute-слой');
  assert.match(box, /flexShrink: 0,/);
  // Ростом с один чип, кнопки тянутся на высоту ряда.
  assert.match(box, /height: chipH,/);
  assert.match(box, /alignItems: 'stretch',/);
  // Инлайнового фона и подложек нет: ряд ничего не перекрывает.
  assert.ok(!/background: '#1e1e1e',/.test(box), 'фону поверх чипов неоткуда взяться');
  // Git+split принадлежат focus-owner. Вне фокуса измеряемый блок absolute и
  // hidden, а его ширина становится trailing reserve внутри scroller.
  assert.match(chrome, /data-split-pane-focus-actions/);
  assert.match(chrome, /position: focusActionsVisible \? 'relative' : 'absolute'/);
  assert.match(chrome, /visibility: focusActionsVisible \? 'visible' : 'hidden'/);
  assert.match(chrome, /endInsetPx=\{hiddenFocusReservePx\}/);
  assert.match(chrome, /data-split-strip-menu-button/);
  const strip = fs.readFileSync(path.join(workspaceDir, 'PaneTabStrip.tsx'), 'utf8');
  assert.match(strip, /data-pane-strip-end-reserve/);
  assert.match(strip, /flex: `0 0 \$\{Math\.max\(0, endInsetPx\)\}px`/);
});

test('ширина focus-actions измеряется событием layout и не становится вторым viewport formula', () => {
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.match(chrome, /const \[focusActionsWidth, setFocusActionsWidth\] = useState\(0\)/);
  assert.match(chrome, /new ResizeObserver/);
  assert.match(chrome, /focusActionsWidth \+ 2/);
  assert.doesNotMatch(chrome, /clientWidth\s*-\s*focusActionsWidth/);
  assert.ok(!/STRIP_MENU_BUTTON_INSET/.test(chrome), 'резерв под три точки удалён');
});

test('перенос вкладок: настройка живёт в сторе и переживает перезапуск', () => {
  const store = fs.readFileSync(path.join(here, 'useUIStore.ts'), 'utf8');
  assert.match(store, /paneTabStripWrap: boolean;/);
  // Двойная запись, как у остальных режимов раскладки: localStorage — чтобы
  // применилось в первом кадре, SQLite — чтобы пережило смену dev-порта.
  assert.match(store, /localStorage\.setItem\('noted-terminal-pane-strip-wrap'/);
  assert.match(store, /key: APP_STATE_KEY_PANE_STRIP_WRAP, value: v/);
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  // Пункт меню — переключатель с галочкой-состоянием, а не два пункта.
  assert.match(chrome, /data-split-strip-menu-item="wrap"/);
  assert.match(chrome, /role="menuitemcheckbox"/);
  assert.match(chrome, /aria-checked=\{stripWrap\}/);
  assert.match(chrome, /Перенос вкладок/);
  // Три точки видны ВСЕГДА: это вопрос про вкладки окна, а не действие над ним.
  const at = chrome.indexOf('data-split-strip-menu-button');
  assert.ok(at > 0, 'кнопка меню полосы существует');
  const button = chrome.slice(at, at + 1400);
  assert.ok(!/data-split-button/.test(button),
    'три точки не помечены как действие окна — иначе они гасли бы вне фокуса');
});

test('автодовод выбранной вкладки — отдельная настройка, по умолчанию выключена', () => {
  const store = fs.readFileSync(path.join(here, 'useUIStore.ts'), 'utf8');
  assert.match(store, /paneTabStripAutoReveal: boolean;/);
  assert.match(store, /localStorage\.getItem\('noted-terminal-pane-strip-auto-reveal'\) === 'true'/);
  assert.match(store, /key: APP_STATE_KEY_PANE_STRIP_AUTO_REVEAL, value: v/);
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.match(chrome, /data-split-strip-menu-item="auto-reveal"/);
  assert.match(chrome, /aria-checked=\{stripAutoReveal\}/);
  assert.match(chrome, /Показывать выбранную/);
  assert.match(chrome, /autoReveal=\{stripAutoReveal\}/);
});

test('шапка окна СООБЩАЕТ измеренную высоту, а не только предсказанную', () => {
  // В переносе высота шапки — следствие раскладки: сколько строк заняли чипы.
  // Предсказать её по настройкам нельзя, поэтому она измеряется и публикуется,
  // а содержимое окна отступает на неё.
  const chrome = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
  assert.match(chrome, /export const PANE_HEADER_HEIGHT_VAR = '--pane-header-h';/);
  assert.match(chrome, /splitPaneHeaderHeightVar = \(paneIndex: number\)/);
  assert.match(chrome, /host\.style\.setProperty\(heightVar, h \+ 'px'\)/);
  assert.match(chrome, /wrapper\?\.style\.setProperty\(TAB_SURFACE_HEADER_HEIGHT_VAR, h \+ 'px'\)/,
    'измерение должно переживать размонтирование chrome скрытого пространства');
  // И снимается при размонтировании: окно переживает свою шапку (пустая панель
  // рисует собственную), и чужая высота сдвинула бы её содержимое.
  assert.match(chrome, /host\.style\.removeProperty\(heightVar\)/);
  // Запасное значение обязательно — у пустой панели своя шапка, она эту
  // переменную не ставит.
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  assert.match(area, /var\(\$\{TAB_SURFACE_HEADER_HEIGHT_VAR\}, var\(\$\{splitPaneHeaderHeightVar\(layoutPaneIndex\)\}, \$\{attachRowH\}px\)\)/);
  const workspace = fs.readFileSync(path.join(workspaceDir, 'Workspace.tsx'), 'utf8');
  assert.match(workspace, /data-pane-header-host/);
  assert.match(workspace, /height: `var\(\$\{PANE_HEADER_HEIGHT_VAR\}, \$\{attachRowH\}px\)`/);
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
  const btn = signals.slice(at, signals.indexOf('data-tab-status-marker-menu', at));
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
  // Вращаемая рамка верна только для круга; овал Git и овал счётчика workflow
  // используют conic-градиент под маской формы.
  const css = fs.readFileSync(path.join(here, '..', 'styles', 'globals.css'), 'utf8');
  assert.match(css, /\.noted-shape-ring \{/);
  assert.match(css, /conic-gradient\(/);
  assert.match(css, /mask-composite: exclude/);
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  assert.match(git, /data-git-chip-spinner[\s\S]{0,200}noted-shape-ring/);
  assert.ok(!/data-git-chip-spinner[\s\S]{0,300}animate-spin/.test(git), 'овал git больше не вращает рамку');
  assert.match(workflowBadges, /noted-shape-ring absolute inset-0 rounded-full/);
});

test('порог имени ветки Git — настройка, а не константа', () => {
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  assert.match(git, /BRANCH_MIN_STORAGE_KEY/);
  assert.match(git, /branchNameMinHostPx/);
  assert.match(git, /Branch name min width/);
  assert.match(git, /width >= branchMinHostPx/);
});

test('переключение пространства не пересобирает окна: форма — про все пространства сразу', () => {
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  const surface = fs.readFileSync(path.join(workspaceDir, 'SplitPaneSurface.tsx'), 'utf8');

  // Форма (окно / одиночный центр) — структура дерева. Считать её по ОДНОМУ
  // видимому пространству значит переворачивать её на каждом переключении, и
  // React обязан снести окно вместе с живым терминалом. Прод 19.08: 200–330мс
  // блокировки на клик + повторная заливка буферов до 920КБ на вкладку.
  assert.match(area, /hiddenSpaceLayouts/, 'форму и геометрию должны назначать и скрытые пространства');
  assert.match(area, /resolveTabPanePlacement\(tab\.id, activeSpaceLayout, hiddenSpaceLayouts\)/);
  assert.match(area, /splitPaneRectStyle\(layoutPaneIndex, layoutPanes, layoutSizes\)/,
    'скрытая поверхность обязана сохранить настоящий прямоугольник, а не inset:0');
  assert.match(area, /stacked=\{paneStacked\}/,
    'скрытая stacked-панель не должна разворачивать компактный composer');

  // Место (какое окно, где лежит, что показывает) остаётся за ВИДИМЫМ
  // пространством: чужое окно стоит, но не показывается и номера не имеет.
  assert.match(area, /const shownInPane = visiblePaneIndex >= 0;/);
  assert.match(area, /\{\.\.\.\(shownInPane \? \{ 'data-split-pane-index': visiblePaneIndex \} : \{\}\)\}/);
  assert.match(area, /opacity: shownInPane \? 1 : 0/);
  assert.match(area, /willChange: 'opacity'/,
    'тёплое пространство должно переключать готовые compositor layers');
  // display:none схлопнул бы окно в 0×0 и убил бы WebGL-контекст терминала;
  // visibility:hidden сохранил бы размеры, но выбросил готовые пиксели.
  assert.doesNotMatch(area, /inPane && !shownInPane[\s\S]{0,120}display: 'none'/);

  // Окно, которое НИ РАЗУ не показывали, поверхностей не строит.
  assert.match(area, /dormant=\{!shownInPane\}/);
  assert.match(area, /paneIndex=\{Math\.max\(0, layoutPaneIndex\)\}/);
  assert.match(area, /geometryKey=\{paneGeometryKey\}/);
  // Построенное — живёт дальше, включая скрытые пространства: возврат обязан
  // быть МГНОВЕННЫМ, значит в кадре переключения не должно строиться ничего.
  // Юзер: «нужно всё-таки, чтобы переключение пространств было мгновенным…
  // чтобы оно жило как бы на фоне».
  assert.match(surface, /const \[surfacesAwake, setSurfacesAwake\] = useState\(\(\) => !dormant\);/);
  assert.match(surface, /if \(surfacesAwake\) return;/, 'обратной дороги в «разобрать» нет');
  assert.doesNotMatch(surface, /setSurfacesAwake\(false\)/, 'построенная поверхность не разбирается');
  assert.match(surface, /enabled: workspaceVisible && surfacesAwake/);
  // Первая постройка всё ещё по одному окну на кадр: пять комплектов одним
  // куском стоили 230мс+ блокировки, и даже hover не отрисовывался.
  assert.match(surface, /framesLeft = Math\.max\(1, paneIndex\)/);
  assert.match(surface, /\{historySelected && surfacesAwake && \(/);
  assert.match(surface, /\{showTimeline && surfacesAwake && \(/);
  assert.match(surface, /\{showControlBar && surfacesAwake && \(/);
  assert.match(surface, /preservePresentationGeometry=\{presentationGeometryStable\}/,
    'тёплый show/hide не должен перевзводить scroll restore при той же геометрии');
  // Живое, но скрытое окно невидимо и для КЛАВИАТУРЫ: его поле ввода иначе
  // ловило бы Tab, уводя курсор туда, чего человек не видит.
  assert.match(area, /inert=\{inPane && !shownInPane\}/);
});

test('форк и compact fork говорят, что идут: подпись вместо названия на исходной карточке', () => {
  // Меню закрывалось, и дальше секундами не происходило ничего видимого:
  // копирование переписки на большой сессии долгое. Юзер: «до момента
  // появления новой вкладки нужен лоадер… название заменять на надпись».
  assert.match(store, /pendingOperation\?: string;/);
  assert.match(store, /setTabPendingOperation: \(projectId, tabId, label\) => \{/);
  // Подпись НЕ сохраняется в базу: операция короче жизни приложения, и
  // восстановленное «делается форк» было бы ложью о работе, которой нет.
  const at = store.indexOf('setTabPendingOperation: (projectId, tabId, label)');
  const body = store.slice(at, at + 700);
  assert.doesNotMatch(body, /saveTabs\(/);

  // Тот же renderer используется и карточкой sidebar, и pane-chip: операция
  // принадлежит вкладке, поэтому две физические поверхности не могут разойтись.
  assert.match(tabBar, /<TabPendingOperation label=\{pendingOperationLabel\}/);
  assert.match(paneChip, /<TabPendingOperation label=\{pendingOperationLabel\}/);
  assert.match(pendingOperation, /data-tab-pending-operation-spinner/);
  assert.match(pendingOperation, /data-tab-pending-operation/);
  // Все три действия меню ставят подпись и снимают её на ЛЮБОМ выходе.
  assert.match(tabBar, /const operationLabel = 'делается форк\.\.\.';/);
  assert.match(tabBar, /setTabPendingOperation\(projectId, tab\.id, 'делается форк\.\.\.'\)/);
  // Три снятия: ранний возврат при отказе compact + по одному `finally` на
  // каждый из двух форков. `finally` покрывает и успех, и ошибку, поэтому
  // отдельных снятий на них не нужно.
  assert.equal((tabBar.match(/clearOperationLabel\(\);/g) || []).length, 3);
  assert.equal((tabBar.match(/\} finally \{\n\s+clearOperationLabel\(\);/g) || []).length, 2);
});
