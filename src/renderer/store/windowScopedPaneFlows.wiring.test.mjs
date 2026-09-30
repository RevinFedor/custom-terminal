// Вкладка, созданная ЖЕСТОМ ОКНА, — обычная вкладка проекта.
//
// Раньше она помечалась «только для окна» (`windowScoped`) и пряталась из
// бокового списка: полоса чипов считалась её основной поверхностью навигации.
// Это делало живую вкладку НЕДОСТУПНОЙ — чип уходил из полосы (средний клик,
// перенос, чистка при возврате в пространство), и добраться до вкладки
// становилось нечем при живом shell и целой истории. Страховка «вернуть строку,
// когда размещения не осталось» опиралась на ответ, недостоверный ровно в этот
// момент, и вместо возврата давала фантомный «Терминал» после закрытия.
//
// Поле `windowScoped` осталось в схеме и переживает перезапуск (старые сессии
// его несут), но поведения за ним больше нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const repoRoot = path.resolve(rendererRoot, '..', '..');
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const chrome = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/SplitPaneChrome.tsx'), 'utf8');
const area = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TerminalArea.tsx'), 'utf8');
const tabBar = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TabBar.tsx'), 'utf8');
const tabSidebar = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TabSidebar.tsx'), 'utf8');
const tabLocationLine = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TabLocationLine.tsx'), 'utf8');
const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');
const database = fs.readFileSync(path.join(repoRoot, 'src/main/database.js'), 'utf8');

test('двойной клик по полосе открывает МЕСТО выбора, а не создаёт вкладку', () => {
  // Обновлено вместе с оконным входом «Новая вкладка» (NWT-1): прежде этот
  // жест сразу создавал вкладку с живым shell. Теперь до выбора агента ничего
  // durable не появляется, поэтому проверяется обратное — что путь создания
  // отсюда УБРАН и остался только открывающий место вызов.
  assert.match(chrome, /openWindowTabChooser\(/);
  assert.doesNotMatch(chrome, /createTabAfterCurrent\(/,
    'шапка окна больше не создаёт вкладку сама: это делает общий путь стора');
  // Ни одна точка создания больше не помечает вкладку «только для окна».
  assert.doesNotMatch(chrome, /windowScoped: true/);
  assert.doesNotMatch(area, /windowScoped: true/);
});

test('R2: замок на запуск принадлежит МЕСТУ и переживает remount страницы', () => {
  // Локальный флаг «занято» внутри страницы выбора исчезал при её пересборке
  // (смена workflow, перерисовка окна, второй вход из меню), и повторное
  // нажатие заводило вторую вкладку на одно место.
  assert.match(store, /const chooserLaunchesInFlight = new Map</);
  assert.match(store, /const inflight = chooserLaunchesInFlight\.get\(slotId\);/);
  assert.match(store, /chooserLaunchesInFlight\.set\(slotId, \{ action, promise: run \}\)/);
  assert.match(store, /chooserLaunchesInFlight\.delete\(slotId\)/);
  const page = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/PaneChooserPage.tsx'), 'utf8');
  assert.doesNotMatch(page, /if \(busyAction\) return/,
    'страница показывает занятость, но защитой больше не является');
  assert.match(page, /subscribeWindowChooserLaunch\(slotId, listener\)/);
  assert.match(page, /getWindowChooserLaunchAction\(slotId\)/);
  assert.doesNotMatch(page, /setBusyAction/,
    'повторный клик и remount не подменяют действие общей операции');
});

test('R2: запоздавший результат заполняет своё место и в спящем workflow', () => {
  // Прежде поиск после await шёл только по активной раскладке
  // (`dormantSpaces: []`), и человек, ушедший в другой workflow, терял
  // результат вовсе.
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  assert.doesNotMatch(launch, /dormantSpaces: \[\]/,
    'поиск после await обязан смотреть и в спящие раскладки');
  assert.doesNotMatch(launch, /located\.scope !== 'active'/,
    'спящий workflow — законный адрес, а не причина отказать');
  // Спящая раскладка правится на месте, без переключения экрана человеку.
  assert.match(launch, /space\.id === placementRef\.spaceId/);
  assert.doesNotMatch(launch, /switchWorkspaceSpace\(/);
});

test('R2: активация отдельно от размещения проверяет текущую цель фокуса', () => {
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  assert.match(launch, /if \(focusStillHere\) \{/);
  assert.match(launch, /after\.splitPanes\[after\.splitFocusedIndex\]\?\.tabId === createdTabId/);
});

test('S1: отмена происходит ДО публикации, а не закрытием готовой вкладки', () => {
  // Эвристика «принят ли результат» удалена вместе со своей ложной моделью:
  // ни session id, ни `nameSetManually` (его фабрика SDK ставит себе сама) не
  // доказывают ни принятия AI, ни отсутствия набранного человеком черновика.
  const chooser = fs.readFileSync(path.join(rendererRoot, 'utils/windowTabChooser.mjs'), 'utf8');
  assert.doesNotMatch(chooser, /chooserResultIsAccepted/);
  assert.doesNotMatch(store, /chooserResultIsAccepted/);
  // Отмена живёт в границе создания: вопрос задаётся между persist и publish.
  const commit = fs.readFileSync(path.join(rendererRoot, 'utils/tabCreationCommit.mjs'), 'utf8');
  assert.match(commit, /canPublish/);
  assert.match(commit, /cancelled: true/);
  const persistAt = commit.indexOf('const snapshot = await persist(candidateTabs)');
  const guardAt = commit.indexOf('canPublish(candidateTabs)', persistAt);
  const publishAt = commit.indexOf('publish(candidateTabs);');
  assert.ok(persistAt >= 0 && guardAt > persistAt && publishAt > guardAt,
    'проверка стоит ПОСЛЕ persist и ПЕРЕД publish');
  // Уже опубликованную вкладку автоматическим закрытием никто не убирает.
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  assert.doesNotMatch(launch, /closeTab\(/,
    'отмена создания не превращается в обычное закрытие рабочей вкладки');
  assert.doesNotMatch(launch, /archive/);
});

test('S1: SDK и SDK-форк проходят ту же границу публикации', () => {
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  // Обе SDK-ветки получают guard; лишнего PTY и второго лаунчера не заводится.
  const sdkCalls = launch.match(/createSDKTab\(/g) || [];
  assert.equal(sdkCalls.length, 2, 'обычный SDK и SDK-форк');
  const guarded = launch.match(/canPublish,\n\s+onPublish,/g) || [];
  assert.ok(guarded.length >= 2, 'обе ветки передают guard в фабрику');
  // Привязка источника форка ставится только у опубликованного результата.
  assert.match(launch, /if \(createdTabId\) \{\n\s+get\(\)\.updateSDKState\(/);
});

test('S1: неудавшийся откат не объявляется успешной отменой', () => {
  assert.match(store, /creationSnapshot\.cancelled === true && rollback\?\.success !== false/);
  assert.match(store, /tab_creation_rollback_failed/);
});

test('S2: показ места не даёт права забрать фокус у другого окна', () => {
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  assert.match(launch, /after\.splitFocusedIndex === publishedPlacement\.paneIndex/);
  assert.match(launch, /publishedPlacement\.spaceId === after\.activeSpaceId/);
  assert.match(launch, /uiArea === 'workspace'/);
  assert.doesNotMatch(launch, /set\(\{ splitFocusedIndex: /,
    'запоздавший результат не двигает рамку фокуса');
});

test('R6: `×` закрывает окно целиком, а не отказывает при открытой заготовке', () => {
  assert.match(store, /closeWindowPane: \(paneIndex\) => \{/);
  const close = store.slice(
    store.indexOf('closeWindowPane: (paneIndex) => {'),
    store.indexOf('\n  focusSplitPane:'),
  );
  assert.match(close, /removePaneAt\(st\.splitPanes, st\.splitFocusedIndex, paneIndex\)/);
  assert.doesNotMatch(close, /paneChooserSlots\([\s\S]{0,40}\)\.length > 0\) return/,
    'кнопка окна не может быть видимой и мёртвой одновременно');
});

test('вкладка для выбранного места создаётся ОДНИМ общим путём стора', () => {
  // Кнопки страницы выбора и три команды меню окна обязаны сходиться в один
  // путь: второй лаунчер разошёлся бы с первым на первом же изменении правил
  // запуска (гард жизненного цикла, авто-имя, проверки Codex).
  assert.match(store, /createTabForWindowChooser: async \(slotId, action\) => \{/);
  assert.match(store, /resolveChooserLaunchPlan\(action\)/);
  assert.match(store, /materializeChooserSlot\(/);
  // Адрес операции — id места, а не индекс окна после await.
  assert.match(store, /locateChooserSlot\(\{/);
});

test('путь новой вкладки остаётся прежней строкой, но выбирает cwd до запуска', () => {
  assert.match(tabSidebar, /paneChooserSlots\(pane\)/);
  assert.match(tabSidebar, /ipcRenderer\.invoke\('app:select-directory'/);
  assert.match(tabSidebar, /buttonLabel: 'Выбрать'/);
  assert.match(tabSidebar, /setWindowTabChooserDirectory\(/);
  assert.match(tabLocationLine, /data-window-chooser-location/);
  assert.match(tabLocationLine, /explicitCwd === undefined \? tabCwd : explicitCwd/);
  assert.doesNotMatch(tabLocationLine, />\s*Папка:/,
    'визуально строка остаётся только путём без новой подписи');
});

test('все ответы chooser получают его cwd, включая SDK', () => {
  const launch = store.slice(
    store.indexOf('createTabForWindowChooser: async (slotId, action) => {'),
    store.indexOf('\n  moveTabsToWindowStrip:'),
  );
  assert.match(launch, /const cwd = context\.cwd \|\| projectPath \|\| ''/);
  assert.doesNotMatch(launch, /cwdTab\?\.cwd/,
    'Cmd+T больше не наследует cwd исходной вкладки');
  assert.match(launch, /createSDKTab\(targetProjectId, undefined, \{\s*cwd,/);
  assert.match(launch, /\{ cwd, background: true, canPublish, onPublish \}/);
});

test('прямой выбор пустого окна использует общий guard создания и размещения', () => {
  // Пользователь уже выбрал агента. Техническое место даёт операции адрес,
  // а второе подтверждение выбора не требуется.
  const launch = area.slice(area.indexOf('const launchIntoEmptyPane'), area.indexOf('  }, []);', area.indexOf('const launchIntoEmptyPane')));
  assert.match(launch, /openWindowTabChooser\(paneIndex\)/);
  assert.match(launch, /createTabForWindowChooser\(slotId, action\)/);
  assert.doesNotMatch(launch, /createTabAfterCurrent\(|createSDKTab\(|ipcRenderer\./);
});

test('новая строка — СОСЕД текущей, после всего её поддерева', () => {
  // Вставка «сразу после» разрывала карточку родителя пополам: новая строка
  // вставала между ним и его детьми и выглядела оторванной от жеста.
  assert.match(store, /const afterVisualSubtreePlacement = \(rejectsInheritedParent \|\| options\?\.afterVisualSubtree === true\)/);
  assert.match(store, /resolveSiblingInsertionIndex\(\{/);
  assert.match(store, /parentOf: Object\.fromEntries\(/);
  const placement = store.slice(store.indexOf('const afterVisualSubtreePlacement ='), store.indexOf('const insertIndex = afterVisualSubtreePlacement'));
  assert.doesNotMatch(placement, /!targetGroupId/, 'visual subtree не перестаёт быть поддеревом внутри group');
});

test('живая вкладка не прячется из бокового списка ни при каком размещении', () => {
  assert.doesNotMatch(tabBar, /hiddenWindowScopedTabIds/);
  assert.match(tabBar, /const mainTabsBase = allTabs;/);
});

test('Shift+Cmd+T delegates both close kinds to the window-ordered serialized restore', () => {
  assert.match(app, /const targetPaneIndex = ws\.splitPanes\.length > 0 \? ws\.splitFocusedIndex : -1/);
  assert.doesNotMatch(app, /ws\.restoreLastDetachedTabToSplitPane\(targetPaneIndex\)/);
  assert.match(app, /ws\.reopenLastClosedTab\(restoreProjectId, targetPaneIndex >= 0/);
  assert.match(store, /chooseWindowCloseAction\(detached,archived\)/);
  assert.match(store, /project:peek-window-tab-history/);
  assert.match(store, /restoreLastDetachedTabToSplitPane: \(paneIndex, expectedTabId\) => \{/);
  assert.match(store, /const keepFocusedEmpty = detachedPaneIndex === splitFocusedIndex/);
  assert.match(store, /if \(keepFocusedEmpty\) \{/);
  assert.match(store, /reopenLastClosedTab: \(projectId, options\) => \{/);
  assert.match(store, /background: !!target/);
  assert.match(store, /addTabToSplitPaneStrip\(restoredTarget\.index,restoreProjectId,result\.tabId\)/);
});

test('поле переживает сохранение и восстановление — старые сессии не ломаются', () => {
  assert.match(database, /ALTER TABLE tabs ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /ALTER TABLE tab_history ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /windowScoped: t\.window_scoped === 1 \|\| undefined/);
  assert.match(database, /tab\.windowScoped \? 1 : 0/);
  assert.match(store, /windowScoped: entry\.window_scoped === 1 \|\| undefined/);
  assert.match(store, /windowScoped: tab\.windowScoped/);
});

test('закрытие вкладки стирает ВСЕ её следы размещения — иначе появляется фантом', () => {
  // «Где эта вкладка лежит» отвечали четыре источника: окна текущего
  // пространства, снимки остальных, полосы центра и запись «что показывало это
  // пространство». Последняя переживала закрытие, и любой вопрос о месте
  // закрытой вкладки отвечал «здесь» — это и порождало фантомную строку.
  const close = store.slice(
    store.indexOf('  closeTab: async (projectId, tabId, options) => {'),
    store.indexOf('  restoreTabHistoryEntry: async (projectId, historyId, options = {}) => {'),
  );
  assert.match(close, /dropTabFromAllPaneHistories\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /dropTabFromAllPaneDetachedTabs\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /dropTabsFromOtherSpaces\([\s\S]{0,180}?\[tabId\],[\s\S]{0,80}?dropTabFromAllPaneStrips,[\s\S]{0,80}?vacantPaneWithTabs/);
  assert.match(close, /dropTabFromAllPaneStrips\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /if \(get\(\)\.activeSpaceTab\?\.tabId === tabId\) set\(\{ activeSpaceTab: null \}\)/);
});
