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

test('клик по вкладке слева ДОБАВЛЯЕТ её в конец полосы, а не заменяет показанную', () => {
  // Замена молча уносила из окна ту вкладку, которую человек туда сам положил.
  // Юзер: *«чтобы она не заменяла текущую, а открывалась в конце»*.
  //
  // От бесконечного роста полосу держит другое правило: вкладка, уже лежащая в
  // каком-то окне, не добавляется второй раз — её ПОКАЗЫВАЮТ там, где она
  // живёт. Значит каждая вкладка попадает в полосу ровно один раз.
  assert.match(store, /const next = insertIntoStrip\(strip, projectId, tabId\);/);
  assert.doesNotMatch(store, /replaceInStrip/);
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

test('имя вкладки в полосе не обрезается', () => {
  // Многоточие стояло ровно там, где был ответ, — на поверхности, вся работа
  // которой в том, чтобы сказать, какая вкладка какая. Уезжает за край — про
  // это говорят счётчики, а не огрызок имени.
  assert.doesNotMatch(chip, /maxWidth: inStrip \? 220/);
  assert.match(chip, /inStrip\n\s+\? \{ whiteSpace: 'nowrap' \}/);
});

test('счётчик скрытых красится цветом агента и растёт столбиком', () => {
  // Одно число отвечает «сколько», а спрашивают «что»: две Claude и один Codex
  // — другая ситуация, чем три Codex. Цвет берётся из ОБЩЕЙ таблицы вкладок:
  // вторая таблица на одну полосу разошлась бы с первой.
  assert.match(strip, /groupOverflowByKind/);
  assert.match(strip, /from '\.\/tabChrome'/);
  assert.match(strip, /flexDirection: 'column'/);
  assert.match(strip, /data-strip-overflow-kind/);
  // Цвет вкладки меняется в момент старта агента — часто уже за краем. Без
  // подписки квадратик остался бы серым до случайной прокрутки.
  assert.match(strip, /const kindsKey = useWorkspaceStore/);
  assert.match(strip, /shownTabId, kindsKey\]/);
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
  assert.match(moveMenu, /gridTemplateColumns: columnWidths/);
  assert.match(moveMenu, /windows\.filter\(\(w\) => w\.column === columnIndex\)/);
  // Вкладка уходит в КОНЕЦ полосы выбранного окна — тем же действием, что и
  // двойной клик по шапке.
  assert.match(moveMenu, /addTabToSplitPaneStrip\(target\.index, projectId, tabId\)/);
  assert.match(moveMenu, /addTabToCenterStrip\(projectId, tabId\)/);
});

test('переименование в чипе выглядит и работает как в боковом списке', () => {
  // Жест один — «переименовать вкладку», — и разное поведение на двух
  // поверхностях читается как две разные функции.
  //
  // Весь текст выделен: переименовывают, чтобы НАЗВАТЬ заново, и первая буква
  // должна заменить старое имя. Курсор внутри текста заставляет сначала
  // стирать, а куда он встанет — зависит от места клика, то есть один жест
  // давал бы разный результат от раза к разу.
  assert.match(chip, /node\.focus\(\);\n\s+node\.select\(\);/);
  // Ровно один раз: `ref` зовётся и на каждую букву, а повторный select
  // выделял бы только что набранное — следующая буква стирала бы предыдущую.
  assert.match(chip, /if \(!node \|\| renameFocusedRef\.current\) return;/);
  assert.doesNotMatch(chip, /autoFocus/);
  // Рамка тенью: тень не занимает места, и чип не раздувается на время
  // правки, сдвигая соседей по полосе. Та же строка, что в боковом списке.
  assert.match(chip, /boxShadow: 'inset 0 0 0 1px var\(--color-accent\)'/);
  assert.match(tabbar, /boxShadow: 'inset 0 0 0 1px var\(--color-accent\)'/);
});

test('окно, где вкладка уже лежит, не предлагается', () => {
  // Строка остаётся видимой — исчезающий пункт читается как «кнопка пропала».
  assert.match(moveMenu, /const homeIndex = mode === 'swap'/);
  assert.match(moveMenu, /disabled=\{here\}/);
});

test('окно, где вкладка уже лежит, ищется по НОМЕРУ окна', () => {
  // Список окон идёт в экранном порядке, а `index` — номер самого окна. Как
  // только они разойдутся, сравнение по позиции в списке погасит чужой
  // прямоугольник — тот, куда человек как раз и целился.
  assert.match(moveMenu, /windows\.find\(\(w\) => w\.tabs\.some\(\(e\) => e\.tabId === tabId\)\)\?\.index \?\? -1/);
});

test('карта окон отвечает на ОДИН вопрос двумя способами: перенос и обмен', () => {
  // Картинка та же, потому что вопрос тот же — «какое окно». Разное только то,
  // что произойдёт с выбранным: примет вкладку или поменяется целиком.
  assert.match(moveMenu, /export type WindowPickMode = 'move' \| 'swap'/);
  assert.match(moveMenu, /store\.swapSplitPanes\(sourcePaneIndex, target\.index\)/);
  // При обмене «своё» — окно, ОТКУДА меняем: поменять его с самим собой нельзя,
  // и прямоугольник обязан это сказать, а не молча ничего не делать.
  assert.match(moveMenu, /\? \(sourcePaneIndex \?\? -1\)/);
  // Обмен вызывается из меню перегородки ПЕРВЫМ пунктом: он про уже
  // существующие окна, а оба следующих создают новое.
  assert.match(header, /<MoveToWindowMenu\n\s+mode="swap"/);
  assert.match(header, /Поменять местами/);
});

test('карта окон не пересказывает жест словами', () => {
  // Подпись объясняла ровно то, что человек в этот момент и делает, а картинка
  // повторяет раскладку на экране и читается без расшифровки (юзер, 2026-08-18).
  assert.doesNotMatch(moveMenu, /Наведите на окно/);
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

test('рисунок раскладки повторяет ПРОПОРЦИИ экрана, а не раздаёт всем поровну', () => {
  // Фиксированная высота у каждого прямоугольника — второй ответ на вопрос
  // «какой величины это окно», и он расходится с первым: окно во всю высоту
  // колонки рисовалось половиной просто потому, что рядом стояло второе.
  // Доли берём у самой рабочей области, вместе с перетянутыми перегородками.
  assert.match(moveMenu, /paneGridRects\(st\.splitPanes, st\.splitSizes\)/);
  assert.match(moveMenu, /flex: `\$\{Math\.max\(w\.heightPct, 1\)\} 1 0`/);
  assert.match(moveMenu, /columnWidths\.map\(\(w\) => `\$\{Math\.max\(w, 8\)\}fr`\)/);
  assert.doesNotMatch(moveMenu, /height: 46/);
  // Перегородки двигает человек — рисунок обязан пересчитаться следом.
  assert.match(moveMenu, /splitSizesFingerprint\(s\.splitSizes\)/);
});

// ── Git и копирование сессии переехали к своим вопросам ───────────────────

test('Git отвечает про вкладку ЭТОГО окна, а не про активную', () => {
  // В верхней полосе Git был один на всё приложение и говорил про активную
  // вкладку. С несколькими окнами это стало враньём: в каждом может быть свой
  // worktree и своя ветка. Теперь на вопрос «какая тут ветка» отвечает шапка
  // того окна, над которым человек смотрит.
  const tools = fs.readFileSync(path.join(workspaceDir, 'WorkspaceTitleBarTools.tsx'), 'utf8');
  assert.doesNotMatch(tools, /GitStatusButton/);
  assert.match(header, /<GitStatusButton/);
  // Путь — вкладки (worktree), проект — проектный: он опознаёт сохранённое
  // состояние панели, и подмена пересоздавала бы её на каждом переключении.
  assert.match(header, /tabCwd=\{gitCwd\}/);
  assert.match(header, /projectPath=\{gitProjectPath\}/);
});

test('панель Git раскрывается от своей кнопки и доводится общим механизмом', () => {
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  // Раньше якорем была общая верхняя полоса — под окном внизу слева такой
  // полосы нет, и панель ушла бы за экран.
  assert.doesNotMatch(git, /data-project-toolbar/);
  assert.match(git, /triggerRef\.current!\.getBoundingClientRect\(\)/);
  // Тот же доводчик, что у меню вкладки и меню деления: третьего способа
  // позиционировать всплывающую панель в приложении быть не должно.
  assert.match(git, /clampMenuToViewport\(\{/);
  // Место под панель считается от ЕЁ края, а не от нуля.
  assert.match(git, /window\.innerWidth - clamped\.x - PANEL_MARGIN/);
});

test('копирование сессии живёт в одном месте на кнопку и на меню', () => {
  const tabbarSrc = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');
  const chip = fs.readFileSync(path.join(workspaceDir, 'CopySessionButton.tsx'), 'utf8');
  // Вторая реализация разошлась бы с первой на первом же изменении фильтров
  // или правила выбора Codex-сессии.
  assert.match(tabbarSrc, /copySessionsToClipboard\(\{/);
  assert.match(chip, /copySessionsToClipboard\(\{/);
  assert.doesNotMatch(tabbarSrc, /claude:export-clean-session/);
  // Действие — у вкладки, о которой говорят; настройки — в нижней полосе,
  // рядом с прочими умолчаниями приложения.
  assert.match(chip, /Settings Copy/);
  assert.doesNotMatch(chip, /Copy session/);
});

test('⌘-клик выбирает ОКНО, не съезжая из чужого проекта', () => {
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  // Обычный клик по окну означает «я работаю здесь» и двигает оба указателя:
  // центр и боковое меню. Обратный порядок этим правилом ломался: человек уже
  // стоит в чужом проекте и выбирает, КУДА оттуда положить вкладку — а чтобы
  // назвать окно, надо по нему кликнуть, и список, из которого он собирался
  // выбирать, тут же уезжает.
  assert.match(area, /st\.focusSplitPane\(idx, e\.metaKey \? \{ keepSidebar: true \} : undefined\)/);
  // Тот же жест на чипе: цель можно назвать и по шапке.
  assert.match(chip, /focusSplitPane\(paneIndex, \{ keepSidebar: true \}\)/);
  // Тихий режим двигает ТОЛЬКО рамку фокуса — центр остаётся на прежней
  // вкладке. «Выбранное окно» и «показанная вкладка» здесь и должны разойтись.
  assert.match(store, /if \(options\?\.keepSidebar\) \{\n\s+if \(splitFocusedIndex !== paneIndex\) \{/);
});

// ── Полоса: ширина чипа и доводка до края ─────────────────────────────────

test('чип в полосе не сжимается — иначе соседи наезжают друг на друга', () => {
  // У чипа нет обрезки по ширине намеренно (под нижней кромкой висят квадратики
  // задач), и переносов в нём нет. Значит сжатая ОБЁРТКА не делает чип уже — она
  // просто отдаёт его края соседям: строка «влезает», прокручивать нечего, а
  // имена наползают одно на другое. Ужимает только одиночный чип: он делит
  // строку с кнопками окна.
  assert.match(strip, /flexShrink: inStrip \? 0 : 1/);
});

test('клик по чипу у края доводит полосу до него', () => {
  // Обрезанный краем чип остаётся кликабельным — значит им и пользуются, и
  // выбранной оказывалась вкладка, чьё имя так и осталось разрезанным.
  // Перехват на ПОГРУЖЕНИИ: сам чип останавливает всплытие.
  assert.match(strip, /onClickCapture=\{\(e\) => \{/);
  assert.match(strip, /revealChip\(clicked\)/);
});

test('возврат в окно тоже доводит полосу до его вкладки', () => {
  // Уехал вбок, ушёл в соседнее окно, вернулся: вкладка та же, `shownTabId` не
  // менялся — правило «показать при смене» молчало, и окно встречало обрезанным
  // именем собственной вкладки.
  assert.match(strip, /s\.splitFocusedIndex === paneIndex/);
  assert.match(strip, /\[shownTabId, inStrip, paneFocused, revealChip\]/);
});

// ── Git в шапке окна ──────────────────────────────────────────────────────

test('ширина чипа Git постоянна — он делит строку с вкладками', () => {
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  // Каждое изменение его ширины перемеряет полосу вкладок и пересчитывает
  // счётчики «×N». Поэтому у названия и у числа свои постоянные окошки, а
  // «проверяю репозиторий» занимает ровно столько же, сколько готовый ответ.
  assert.match(git, /GIT_CHIP_NAME_SLOT_PX/);
  assert.match(git, /GIT_CHIP_COUNT_SLOT_PX/);
  assert.match(git, /width: GIT_CHIP_NAME_SLOT_PX/);
  assert.match(git, /width: GIT_CHIP_COUNT_SLOT_PX/);
  assert.doesNotMatch(git, /minWidth: 28,\n\s+height: 16/);
});

test('порог названия ветки мерит ОКНО, а не строку заголовка', () => {
  const git = fs.readFileSync(path.join(workspaceDir, 'GitStatusButton.tsx'), 'utf8');
  // Заголовок — строка во всю ширину окна, и своему содержимому она всегда
  // достаточна: порог по ней не наступал никогда, название показывалось в любом
  // окне. Мерить надо ту коробку, чью ширину человек и меняет перегородкой.
  assert.match(git, /closest\('\[data-terminal-pane-wrapper\]'\)/);
});

test('Git виден по тем же правилам, что кнопка деления', () => {
  // Действия окна видны у окна в фокусе, у прочих — при наведении на шапку.
  // Своё правило видимости у Git было бы вторым ответом на один вопрос.
  assert.match(header, /<div data-split-button style=\{\{ display: 'flex', alignItems: 'stretch', height: 20/);
});
