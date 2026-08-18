// Полоса вкладок в окне — то, что чистая модель проверить не может.
//
// Правила самой полосы живут в splitPanesModel.mjs и покрыты там. Здесь
// закреплены места, где полоса встречается с остальным приложением: как её
// читают, как она переживает перезапуск, и чем она НЕ должна быть.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const header = fs.readFileSync(path.join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');
const strip = fs.readFileSync(path.join(workspaceDir, 'PaneTabStrip.tsx'), 'utf8');
const chip = fs.readFileSync(path.join(workspaceDir, 'PaneTabChip.tsx'), 'utf8');
const snapshot = fs.readFileSync(path.join(here, '..', 'utils', 'sessionSnapshot.mjs'), 'utf8');
const visitRule = fs.readFileSync(path.join(here, '..', 'utils', 'tabVisitHistoryRule.mjs'), 'utf8');

test('полосу читают строкой, а не массивом', () => {
  // Селектор, возвращающий массив, — новая ссылка на каждую запись в стор, то
  // есть перерисовка КАЖДОЙ шапки на любое изменение (Fingerprint Pattern,
  // fix-performance-lags.md). Полоса в шапке каждого окна, поэтому цена
  // умножается на число окон.
  assert.match(header, /const stripKey = useWorkspaceStore\(\(s\) => \{/);
  assert.match(header, /\.join\(','\)/);
  assert.doesNotMatch(header, /useWorkspaceStore\(\(s\) => paneTabs\(/);
});

test('вкладка с чипом считается «на экране» для Ctrl+Tab', () => {
  // Полоса — карта, которую человек строит сам, и вкладка в ней уже перед
  // глазами. Предложить её в Ctrl+Tab значит назвать одно и то же дважды и
  // отодвинуть вниз то, чего на экране действительно нет.
  assert.match(visitRule, /allPaneTabIds/);
});

test('полоса переживает перезапуск — и мёртвые чипы не воскресают', () => {
  assert.match(snapshot, /centerStrips/);
  assert.match(store, /restoredCenterStrips/);
  // Чип, чья вкладка не вернулась, восстановился бы строкой в никуда.
  assert.match(store, /openProjects\.get\(e\.projectId\)\?\.tabs\.has\(e\.tabId\)/);
  // Один чип — это не полоса: проект возвращается к поведению «как было до».
  assert.match(store, /if \(kept\.length > 1\) restoredCenterStrips\[pid\] = kept/);
});

test('обычная навигация не растит полосу', () => {
  // Иначе за час работы полоса съела бы весь список вкладок — и вместе с ним
  // весь Ctrl+Tab, который по правилу пропускает всё, что лежит в окнах.
  // Чипы добавляет только жест «ещё одну сюда».
  assert.match(store, /replaceInStrip\(strip, centerShownBefore \|\| '', projectId, tabId\)/);
  assert.match(header, /addTabToSplitPaneStrip\(paneIndex, owner, newTabId\)/);
  assert.match(header, /addTabToCenterStrip\(owner, newTabId\)/);
});

test('полоса центра адресуется по показанному проекту, а не по проекту вкладки', () => {
  // Полосы, как и окна, межпроектные: в полосе может стоять вкладка чужого
  // проекта, и чип, спросивший по СВОЕМУ проекту, обратился бы ко второй
  // полосе, на которую никто не смотрит. Один резолвер на всех, чтобы
  // «положить» и «убрать» не могли разойтись.
  assert.match(store, /centerStripKey: \(\) => get\(\)\.activeProjectId \|\| null/);
  // Ключ резолвит САМ стор, а вызывающий называет только вкладку: раньше чип
  // доставал полосу сам и мог спросить не ту.
  assert.match(store, /reorderCenterStripTab: \(_projectId, tabId, toIndex\) => \{/);
  assert.match(store, /removeTabFromCenterStrip: \(_projectId, tabId\) => \{/);
  // Исходящий чип — то, что показывал ЦЕНТР, снятое до перезаписи. Активная
  // вкладка целевого проекта — другое, как только переход межпроектный.
  assert.match(store, /const centerShownBefore = \(\(\) => \{/);
});

test('новая вкладка создаётся в фоне, а показывает её полоса', () => {
  // Активация внутри createTab сработала бы по правилу замены — то есть выкинула
  // бы из окна ровно тот чип, рядом с которым человек просил соседа.
  assert.match(header, /background: true/);
});

test('вкладка живёт в одном окне: чип — не копия', () => {
  // Один живой терминал нельзя нарисовать в двух местах, поэтому активация идёт
  // К вкладке, а не тащит её в сфокусированное окно.
  assert.match(store, /paneIndexHoldingTab/);
});

test('счётчик вместо скроллбара', () => {
  // Полоса — одна строка в двухстрочной шапке; горизонтальный скроллбар отнял бы
  // третью ради того, что счётчики говорят точнее.
  assert.match(strip, /data-strip-overflow/);
  assert.match(strip, /scrollbarWidth: 'none'/);
  assert.doesNotMatch(strip, /overflowX: 'scroll'/);
});

test('иконка проекта одна на группу подряд идущих вкладок', () => {
  // Иконка на каждом чипе стоит МЕЖДУ двумя чипами, и непонятно, чья она —
  // левого или правого.
  assert.match(strip, /groupStripByProject/);
});

test('показанный чип виден: шапка не спорит с окном под ней', () => {
  assert.match(strip, /scrollOffsetForChip/);
});

test('чип отвечает за себя сам', () => {
  // Один компонент на N чипов означал бы один набор подписок на все вкладки
  // окна — так лоадер и оказывается на соседе занятой вкладки.
  assert.match(chip, /useTabActivitySignals\(tabId\)/);
  assert.match(chip, /data-chip-shown/);
});

// ── Два жеста переноса: внутри полосы и между окнами ──────────────────────

const moveMenu = fs.readFileSync(path.join(workspaceDir, 'MoveToWindowMenu.tsx'), 'utf8');
const tabbar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');

test('порядок чипов меняют тем же перетаскиванием, что и карточки проектов', () => {
  // Свой HTML5-drag был бы третьим механизмом перетаскивания в одном
  // приложении и не умел бы показать, КУДА ляжет чип. Одна библиотека, один
  // язык: белая линия 2px по ближней кромке соседа.
  assert.match(chip, /from '@atlaskit\/pragmatic-drag-and-drop\/element\/adapter'/);
  assert.match(chip, /attachClosestEdge/);
  assert.match(chip, /data-pane-chip-drop-edge/);
  assert.match(chip, /width: 2,\n\s+background: '#fff',/);
  assert.doesNotMatch(chip, /onDragStart=\{/, 'HTML5-перетаскивания в разметке остаться не должно');
});

test('чип нельзя утащить в чужую полосу', () => {
  // Одна вкладка = одно окно: живой терминал не рисуется в двух местах.
  // Перенос между окнами — отдельный жест с НАЗВАННОЙ целью.
  assert.match(chip, /source\.data\.stripId === stripId/);
  assert.match(chip, /source\.data\.tabId !== tabId/);
});

test('сдвиг вправо считает изъятие своего же чипа', () => {
  // Тащим слева направо: как только чип вынут, всё после него съезжает на одну
  // позицию, и целевой индекс обязан уменьшиться — иначе чип встаёт на один
  // правее, чем показала линия.
  assert.match(chip, /if \(from < to\) to -= 1;/);
});

test('между окнами переносит НАЗВАННАЯ цель, а не жест через всю область', () => {
  assert.match(tabbar, /Move to window/);
  assert.match(tabbar, /<MoveToWindowMenu/);
  // Карта повторяет раскладку: сетка по колонкам, окна колонки — друг под
  // другом. Плоский ряд нарисовал бы раскладку, которой нет.
  assert.match(moveMenu, /gridTemplateColumns: `repeat\(\$\{columnCount\}/);
  assert.match(moveMenu, /windows\.filter\(\(w\) => w\.column === columnIndex\)/);
  // Вкладка уходит в КОНЕЦ полосы выбранного окна — тем же действием, что и
  // двойной клик по шапке.
  assert.match(moveMenu, /addTabToSplitPaneStrip\(target\.index, projectId, tabId\)/);
  assert.match(moveMenu, /addTabToCenterStrip\(projectId, tabId\)/);
});

test('окно, где вкладка уже лежит, не предлагается', () => {
  // Строка остаётся видимой — исчезающий пункт читается как «кнопка пропала».
  assert.match(moveMenu, /const homeIndex = windows\.find\(/);
  assert.match(moveMenu, /disabled=\{here\}/);
});

test('окно, где вкладка уже лежит, ищется по НОМЕРУ окна', () => {
  // Список окон идёт в экранном порядке, а `index` — номер самого окна. Как
  // только они разойдутся, сравнение по позиции в списке погасит чужой
  // прямоугольник — тот, куда человек как раз и целился.
  assert.match(moveMenu, /windows\.find\(\(w\) => w\.tabs\.some\(\(e\) => e\.tabId === tabId\)\)\?\.index \?\? -1/);
});

test('картинка показывает полосу центра, а не одну вкладку', () => {
  // Без сплита окно одно, но чипов в нём может быть несколько: раскладка окон о
  // полосе центра не знает — она живёт у проекта.
  assert.match(moveMenu, /centerStrips\[st\.activeProjectId \|\| ''\]/);
});

test('одна вкладка = одно окно: перенос ЗАБИРАЕТ чип у прежнего окна', () => {
  const model = fs.readFileSync(path.join(here, '..', 'utils', 'splitPanesModel.mjs'), 'utf8');
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  // Правило держит МОДЕЛЬ, а не вызывающий: класть вкладку в окно всегда значит
  // «теперь она здесь», поэтому отдельного шага «сначала убрать» ни у кого нет —
  // и следующий вызывающий не сможет его забыть.
  assert.match(model, /export function addTabToPane[\s\S]{0,900}?removeTabFromPane\(detached, index, tabId\)/);
  assert.doesNotMatch(moveMenu, /removeTabFrom/);
  // Дубликат гасил бы окно целиком — вместе с шапкой, потому что всю разметку
  // окна рисует показанная в нём вкладка. Если он всё-таки дошёл до рендера,
  // рисует ПЕРВОЕ окно и это видно в логе.
  assert.match(area, /duplicate pane tab=/);
  // И не переживает перезапуск.
  assert.match(model, /owner\.get\(e\.tabId\) === index/);
});
