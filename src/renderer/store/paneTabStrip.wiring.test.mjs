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
const card = fs.readFileSync(path.join(workspaceDir, 'TabCard.tsx'), 'utf8');
const terminalArea = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
const bridge = fs.readFileSync(path.join(here, '..', 'utils', 'paneTabDragBridge.ts'), 'utf8');
const pointerGesture = fs.readFileSync(path.join(here, '..', 'utils', 'paneTabPointerGesture.ts'), 'utf8');
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

test('единая активация МЕНЯЕТ показанный чип; add-here использует append-путь', () => {
  // Replace остаётся контрактом единой активации (sidebar, Ctrl+Tab/Cmd+P и
  // другие входы). Middle-click add-here вызывает addTabTo*Strip отдельно и
  // не попадает в эту ветку. Прежняя
  // вкладка после активации уходит в историю окна (⌘[ вернёт).
  assert.match(store, /const next = replaceInStrip\(strip, shownBefore \|\| '', projectId, tabId\);/);
  // В конец полосы по-прежнему кладут двойной клик по шапке и Move to window.
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

test('полоса окна всегда переносит вкладки без скрытого горизонтального ряда', () => {
  // Inline places wrap around the first-row action float. Keeping the former
  // flex container would reinstate a reserved right column on every row.
  assert.match(strip, /data-pane-tab-strip-wrap="true"/);
  const flow=strip.slice(strip.indexOf('data-pane-tab-strip-scroller'),strip.indexOf('{renderItems.map'));
  assert.match(flow, /display: 'block'/);
  assert.doesNotMatch(flow, /display: 'flex'|whiteSpace: 'nowrap'/);
  assert.match(strip, /overflowX: 'clip'/);
  assert.doesNotMatch(strip, /data-strip-overflow|onWheel=|onScroll=/);
});

test('имя вкладки в полосе не обрезается', () => {
  // Многоточие стояло ровно там, где был ответ, — на поверхности, вся работа
  // которой в том, чтобы сказать, какая вкладка какая. Уезжает за край — про
  // это говорят счётчики, а не огрызок имени.
  assert.doesNotMatch(chip, /maxWidth: inStrip \? 220/);
  assert.match(chip, /truncate=\{!inStrip\}/);
  assert.match(card, /overflow: truncate \? 'hidden' : undefined/);
  assert.match(card, /whiteSpace: 'nowrap'/);
});

test('полоса не измеряет скрытые вкладки и не подписывается на их цвета', () => {
  assert.doesNotMatch(strip, /groupOverflowByKind|kindsKey|revealChip|new ResizeObserver/);
});

test('иконка проекта одна на группу подряд идущих вкладок', () => {
  // Иконка на каждом чипе стоит МЕЖДУ двумя чипами, и непонятно, чья она —
  // левого или правого.
  assert.match(strip, /groupStripByProject/);
});

test('показанный чип остаётся в переносимой полосе без автопрокрутки', () => {
  assert.match(strip, /shown=\{tabId === shownTabId\}/);
  assert.doesNotMatch(strip, /scrollOffsetForChip|requestReveal/);
});

test('чип отвечает за себя сам', () => {
  // Один компонент на N чипов означал бы один набор подписок на все вкладки
  // окна — так лоадер и оказывается на соседе занятой вкладки.
  assert.match(chip, /projectId=\{projectId\} tabId=\{tabId\}/);
  assert.match(chip, /sharedActivity=\{sharedActivity\}/);
  assert.match(card, /useTabActivitySignals\(tabId, signalSnapshot\)/);
  assert.match(chip, /data-chip-shown/);
  assert.match(chip, /data-chip-active=\{shown && paneFocused \? '1' : '0'\}/);
  assert.match(
    chip,
    /active=\{shown\}/,
    'каждое окно подсвечивает свою показанную вкладку независимо от фокуса',
  );
  assert.doesNotMatch(chip, /active: shown[,}]/);
  assert.match(strip, /paneFocused=\{focused\}/);
});

// ── Два жеста переноса: внутри полосы и между окнами ──────────────────────

const moveMenu = fs.readFileSync(path.join(workspaceDir, 'MoveToWindowMenu.tsx'), 'utf8');
const tabbar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');

test('порядок чипов меняют тем же перетаскиванием, что и карточки проектов', () => {
  // Чип — только source. Вся полоса является одним target и показывает
  // будущий порядок самими чипами; per-chip target/белая линия создавали
  // конкурирующего владельца release и лишний feedback.
  assert.match(chip, /bindPaneTabPointerDrag/);
  assert.doesNotMatch(chip, /dropTargetForElements|attachClosestEdge|data-pane-chip-drop-edge/);
  assert.match(strip, /ref=\{stripRootRef\}/);
  assert.match(strip, /dropTargetForElements\(\{/);
  assert.match(strip, /useHorizontalOrderPreview/);
  assert.doesNotMatch(chip, /onDragStart=\{/, 'HTML5-перетаскивания в разметке остаться не должно');
});

test('чип переезжает в чужую полосу, но не получает второго владельца', () => {
  assert.match(strip, /source\.data\.type === PANE_TAB_DND_TYPE/);
  assert.match(strip, /commitPaintedPaneTabDrop\(sourceState\.rootTabId\)/);
  assert.match(store, /moveTabsToPane\(st\.splitPanes, paneIndex, entries/);
});

test('точный slot считается без удерживаемого source и release берёт painted target', () => {
  assert.match(bridge, /createHorizontalDragGeometryCache\(\)/);
  assert.match(bridge, /excludedIds: excludedTabIds/);
  assert.match(bridge, /readChips: \(\) => Array\.from\(strip\.querySelectorAll/);
  assert.match(bridge, /ownerKey: `\$\{spaceId \|\| 'unknown'\}:\$\{paneKey\}`/);
  assert.match(bridge, /claimPaneTabDragDrop/);
  assert.match(strip, /commitPaintedPaneTabDrop/);
  assert.match(pointerGesture, /createHorizontalRowDragPreview/);
  assert.match(strip, /dragPlaceholder=\{paneDrag\.active/);
  assert.doesNotMatch(strip, /anchorDeltaX/);
});

test('прямой DnD переносит между окнами, а карта остаётся точным fallback', () => {
  assert.match(strip, /data-pane-tab-drop-zone="strip"/);
  assert.match(chip, /bindPaneTabPointerDrag/);
  assert.match(tabbar, /Move to window/);
  assert.match(tabbar, /<MoveToWindowMenu/);
  // Карта повторяет раскладку: сетка по колонкам, окна колонки — друг под
  // другом. Плоский ряд нарисовал бы раскладку, которой нет.
  assert.match(moveMenu, /gridTemplateColumns: columnWidths/);
  assert.match(moveMenu, /windows\.filter\(\(w\) => w\.column === columnIndex\)/);
  // Меню по-прежнему кладёт в конец, когда точное pointer-placement не нужен.
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
  assert.match(chip, /useInlineRenameInputRef\(renaming\)/);
  assert.match(chip, /ref=\{renameInput\.ref\}/);
  // Ровно один раз гарантирует общий callback-ref; controlled rerender не
  // может выделить уже набранный текст повторно.
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

test('карта сохраняет ширины колонок, но цели остаются компактными строками', () => {
  // Горизонтальная форма помогает узнать окно; высота target-кнопки — это уже
  // плотность меню. Растягивать её до реальной высоты pane превращало обычную
  // цель в 104px dashboard-card.
  assert.match(moveMenu, /paneGridRects\(st\.splitPanes, st\.splitSizes\)/);
  assert.match(moveMenu, /flex: `0 0 \$\{WINDOW_PICKER_METRICS\.cellHeight\}px`/);
  assert.match(moveMenu, /\.map\(\(w\) => `minmax\(0, \$\{Math\.max\(w, 8\)\}fr\)`\)/);
  assert.doesNotMatch(moveMenu, /height: 46/);
  // Перегородки двигает человек — рисунок обязан пересчитаться следом.
  assert.match(moveMenu, /splitSizesFingerprint\(s\.splitSizes\)/);
});

// ── Git и копирование сессии переехали к своим вопросам ───────────────────

test('один Git в общей шапке следует показанной вкладке фокусного окна', () => {
  const tools = fs.readFileSync(path.join(workspaceDir, 'WorkspaceTitleBarTools.tsx'), 'utf8');
  const target = fs.readFileSync(path.join(workspaceDir, 'FocusedWorkspaceGitStatus.tsx'), 'utf8');
  assert.match(tools, /<FocusedWorkspaceGitStatus/);
  assert.doesNotMatch(header, /<PersistentPaneGitStatus/);
  assert.match(target, /state\.splitPanes\[state\.splitFocusedIndex\]/);
  assert.match(target, /tabCwd: tab\.cwd/);
  assert.match(target, /projectPath: workspace\.projectPath/);
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

test('⌘-клик по телу выбирает окно; по чипу убирает только этот чип', () => {
  const area = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
  // Обычный клик по окну означает «я работаю здесь» и двигает оба указателя:
  // центр и боковое меню. Обратный порядок этим правилом ломался: человек уже
  // стоит в чужом проекте и выбирает, КУДА оттуда положить вкладку — а чтобы
  // назвать окно, надо по нему кликнуть, и список, из которого он собирался
  // выбирать, тут же уезжает.
  assert.match(area, /st\.focusSplitPane\(idx, e\.metaKey \? \{ keepSidebar: true \} : undefined\)/);
  // На самом чипе bare Cmd+click — alias среднего клика: убрать именно его,
  // оставив окно и вкладку в боковом списке. Комбинированное сочетание всё ещё
  // доходит до focus-only ветки ниже.
  const click = chip.slice(chip.indexOf('onClick={(e) => {'), chip.indexOf('onDoubleClick='));
  assert.ok(click.indexOf('removeFromWindow(e)') < click.indexOf('focusSplitPane(paneIndex, { keepSidebar: true })'));
  assert.match(click, /if \(e\.metaKey && !e\.ctrlKey && !e\.altKey && !e\.shiftKey\)/);
  assert.match(click, /focusSplitPane\(paneIndex, \{ keepSidebar: true \}\)/);
  // Тихий режим на теле окна по-прежнему двигает ТОЛЬКО рамку фокуса — центр
  // остаётся на прежней вкладке.
  assert.match(store, /if \(options\?\.keepSidebar\) \{\n\s+if \(splitFocusedIndex !== paneIndex\) \{/);
});

// ── Полоса: ширина чипа и доводка до края ─────────────────────────────────

test('чип в полосе не сжимается — иначе соседи наезжают друг на друга', () => {
  // У чипа нет обрезки по ширине намеренно (под нижней кромкой висят квадратики
  // задач), и переносов в нём нет. Значит сжатая ОБЁРТКА не делает чип уже — она
  // просто отдаёт его края соседям: строка «влезает», прокручивать нечего, а
  // имена наползают одно на другое. Ужимает только одиночный чип: он делит
  // строку с кнопками окна.
  // В ПЕРЕНОСЕ действует то же правило и по той же причине: сжимать чип, чтобы
  // строка «влезла», там особенно бессмысленно — на то и перенос, чтобы лишний
  // чип ушёл строкой ниже целым.
  assert.match(strip, /flexShrink: 0, minWidth: 0/);
});

test('меню не предлагает удалённые scroll-mode и автодовод', () => {
  assert.doesNotMatch(header, /data-split-strip-menu-item="(?:wrap|auto-reveal)"/);
  assert.doesNotMatch(strip, /autoReveal|endInsetPx|scrollLeft/);
});

test('возврат фокуса сохраняет зарезервированную геометрию кнопок', () => {
  assert.match(header, /data-wrap-reserved="1"/);
  assert.match(header, /visibility: focusActionsVisible \? 'visible' : 'hidden'/);
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

test('освобождённая шапка даёт прямой вход к скрытым окнам', () => {
  assert.doesNotMatch(header, /<PersistentPaneGitStatus/);
  assert.match(header, /<HiddenWindowPicker paneIndex=\{paneIndex\}/);
  const picker = fs.readFileSync(path.join(workspaceDir, 'HiddenWindowPicker.tsx'), 'utf8');
  assert.match(picker, /state\.showHiddenWindow\(index, candidateId, selected\)/);
  assert.match(picker, /chooseWindow\(candidate\.id, tab\)/);
});

test('средний клик по shown-чипу оставляет vacant body и не выбирает соседа', () => {
  const model = fs.readFileSync(path.join(here, '..', 'utils', 'splitPanesModel.mjs'), 'utf8');
  assert.match(model, /const removedShown = pane\.tabId === tabId/);
  assert.match(model, /const shown = removedShown \? '' : pane\.tabId/);
  assert.doesNotMatch(model, /const fromHistory = pane\.tabId === tabId/);
});

test('в одиночном режиме Remove материализует тот же vacant window', () => {
  const remove = store.slice(
    store.indexOf('  removeTabFromCenterStrip: (_projectId, tabId) => {'),
    store.indexOf('  arrangeSplitPanes: (spec) => {'),
  );
  assert.match(remove, /splitPanes: \[vacantPaneWithTabs\(\{\}, rest\)\]/);
  assert.match(remove, /activeSpaceTab: null/);
  assert.doesNotMatch(remove, /activateCenterTab\(heir\.projectId, heir\.tabId\)/);
});

test('vacant pane keeps parked chips visible in its header, with no shown owner', () => {
  const emptyProjection = terminalArea.slice(
    terminalArea.indexOf('splitPanes.forEach((pane, paneIndex) => {'),
    terminalArea.indexOf('for (const tabId of tabLayerNodeCacheRef.current.keys())'),
  );
  assert.match(emptyProjection, /<SplitPaneAttachRow[\s\S]*tabId=""[\s\S]*vacant/);
  assert.match(emptyProjection, /paneLayout=\{splitPanes\}/,
    'canonical chrome reads parked entries from the exact pane layout');
  assert.match(header, /if \(!tabExists && !vacant\) return null/);
  assert.match(header, /shownTabId=\{vacant \? '' : tabId\}/);
  assert.doesNotMatch(header, /data-vacant-pane-label/);
});

test('Cmd+T окна открывает МЕСТО выбора там, где стоит человек', () => {
  const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');
  const hotkey = app.slice(
    app.indexOf("      // Cmd+T - New Tab or New Project"),
    app.indexOf('      // Arrow keys for project navigation'),
  );
  // Обновлено вместе с оконным входом «Новая вкладка» (NWT-1): pane-owned
  // Cmd+T и двойной клик по полосе — один жест, и оба открывают страницу
  // выбора. Пройти этот путь двумя разными способами нельзя, иначе один вход
  // молча делал бы то, от чего второй отказался.
  assert.match(hotkey, /const keyboardTarget = readKeyboardFocusTarget\(\)/);
  assert.match(hotkey, /keyboardTarget\.kind === 'pane'/);
  assert.match(hotkey, /const paneIndex = keyboardTarget\.paneIndex/);
  assert.match(hotkey, /openWindowTabChooser\(paneIndex >= 0 \? paneIndex : null\)/);
  // Sidebar-фокус выше по-прежнему создаёт durable строку списка.
  assert.match(hotkey, /keyboardTarget\.kind === 'sidebar'/);
  const paneBranch = hotkey.slice(hotkey.indexOf("keyboardTarget.kind === 'pane'"));
  assert.doesNotMatch(paneBranch, /createTabAfterCurrent\(/,
    'оконный Cmd+T больше не создаёт вкладку до выбора агента');
});
