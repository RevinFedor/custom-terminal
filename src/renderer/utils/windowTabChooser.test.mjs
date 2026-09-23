// «Новая вкладка» — правила МЕСТА в окне, у которого ещё нет вкладки.
//
// Проверяется главное обещание фичи: до выбора агента в приложении не
// появляется ничего durable, а после выбора вкладка встаёт РОВНО на место
// открытой страницы выбора — даже если человек за это время ушёл в другое
// окно. Модель здесь чистая, поэтому все случаи держатся без DOM и без стора.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allPaneSlotIds,
  allPaneTabIds,
  closeChooserSlot,
  mergeChooserSlots,
  collapseLonePane,
  describeWorkspace,
  isBareEmptyPane,
  isEmptyPane,
  materializeChooserSlot,
  openChooserSlotInPane,
  paneChooserSlots,
  paneIndexHoldingTab,
  paneSlots,
  paneTabs,
  removePaneAt,
  removePanesByProject,
  removeTabFromPane,
  replacePaneShownTab,
  resolveSplitActivation,
  sanitizePanes,
  setChooserSlotDirectory,
  splitAvailability,
  splitPanesFingerprint,
} from './splitPanesModel.mjs';
import {
  chooserActionNeedsClipboardSession,
  locateChooserSlot,
  nextChooserSlotId,
  resolveChooserLaunchPlan,
  resolveChooserSlotContext,
} from './windowTabChooser.mjs';
import { resolvePaneSurfaceHotkeyTabId } from './paneSurfaceHotkeyTarget.mjs';
import { paneStripRenderItems } from './paneStripLayout.mjs';

const twoWindows = () => [
  { projectId: 'p', tabId: 't1' },
  { projectId: 'p', tabId: 't2' },
];

test('открытая заготовка не является вкладкой ни для одного читателя вкладок', () => {
  const { panes } = openChooserSlotInPane(twoWindows(), 0, 's1');

  assert.deepEqual(paneTabs(panes[0]), [{ projectId: 'p', tabId: 't1' }]);
  assert.deepEqual(allPaneTabIds(panes), ['t1', 't2']);
  assert.equal(paneIndexHoldingTab(panes, 's1'), -1);
  // Внешние клиенты (Terminal MCP, карта окон, поиск) видят только вкладки.
  assert.deepEqual(
    describeWorkspace(panes, 0).windows[0].tabs,
    [{ projectId: 'p', tabId: 't1' }],
  );
});

test('заготовка НЕ делает окно свободным местом для чужой раскладки', () => {
  const { panes } = openChooserSlotInPane([{ projectId: '', tabId: '' }], 0, 's1');
  assert.equal(isEmptyPane(panes[0]), true, 'показывать всё ещё нечего');
  assert.equal(isBareEmptyPane(panes[0]), false, 'но окно уже не пустое');
  // Пустая заглушка блокирует деление; окно с открытой страницей выбора — нет
  // смысла проверять иначе: оба сообщения читает одна и та же проверка.
  assert.equal(splitAvailability(panes, 0).horizontal, true);
});

test('одинокое окно с заготовкой не схлопывается в одиночный центр', () => {
  const { panes } = openChooserSlotInPane([{ projectId: 'p', tabId: 't1' }], 0, 's1');
  assert.equal(collapseLonePane(panes), null);

  // …а обычное одинокое окно по-прежнему схлопывается.
  assert.deepEqual(collapseLonePane([{ projectId: 'p', tabId: 't1' }]), {
    panes: [],
    focusedIndex: 0,
  });
});

test('удаление соседнего окна не выбрасывает заготовку', () => {
  const opened = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  const res = removePaneAt(opened, 0, 1);
  assert.equal(res.panes.length, 1);
  assert.deepEqual(paneChooserSlots(res.panes[0]).map((s) => s.slotId), ['s1']);
});

test('закрытие проекта не уносит заготовку вместе со своими вкладками', () => {
  const opened = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  const res = removePanesByProject(opened, 0, 'p');
  assert.equal(res.panes.length, 1);
  assert.deepEqual(paneChooserSlots(res.panes[0]).map((s) => s.slotId), ['s1']);
});

test('выбор существующей вкладки — тоже ответ странице выбора: место заполняется', () => {
  // Человек ответил не кнопкой, а кликом по вкладке слева. Место заполнено, и
  // чип открытой страницы выбора обязан уйти вместе с ней — иначе он остался
  // бы в полосе навсегда после того, как человек её уже закрыл.
  let panes = [
    { projectId: 'p', tabId: 't1', tabs: [{ projectId: 'p', tabId: 't1' }, { projectId: 'p', tabId: 't2' }] },
    { projectId: 'p', tabId: 't3' },
  ];
  panes = openChooserSlotInPane(panes, 0, 's1', { at: 1 }).panes;

  const activated = resolveSplitActivation(panes, 0, 'p', 't5');
  assert.deepEqual(
    paneSlots(activated.panes[0]).map((s) => s.tabId),
    ['t1', 't5', 't2'],
    'вкладка встала на место заготовки, а не в конец полосы',
  );
  assert.equal(paneChooserSlots(activated.panes[0]).length, 0);
});

test('активация забирает только ПОКАЗАННУЮ заготовку, припаркованная остаётся', () => {
  let panes = openChooserSlotInPane([{ projectId: 'p', tabId: 't1' }, { projectId: 'p', tabId: 't3' }], 0, 'sA').panes;
  panes = openChooserSlotInPane(panes, 0, 'sB').panes;
  assert.equal(panes[0].selectedSlotId, 'sB');

  const activated = resolveSplitActivation(panes, 0, 'p', 't7');
  assert.deepEqual(
    paneSlots(activated.panes[0]).map((s) => s.tabId || s.slotId),
    ['t1', 'sA', 't7'],
  );
});

test('несколько заготовок независимы: закрытие одной сохраняет вторую и окно', () => {
  let panes = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  panes = openChooserSlotInPane(panes, 0, 's2').panes;
  assert.deepEqual(allPaneSlotIds(panes), ['s1', 's2']);

  const closed = closeChooserSlot(panes, 0, 's1');
  assert.deepEqual(paneChooserSlots(closed.panes[0]).map((s) => s.slotId), ['s2']);
  assert.equal(closed.panes.length, 2, 'окно остаётся');
  // Соседний чип не включается сам: следующего владельца выбирает явный клик.
  assert.equal(closed.panes[0].tabId, '');
});

test('вкладка встаёт РОВНО на место заготовки, а не в конец полосы', () => {
  let panes = [{
    projectId: 'p',
    tabId: 't1',
    tabs: [{ projectId: 'p', tabId: 't1' }, { projectId: 'p', tabId: 't2' }],
  }];
  panes = openChooserSlotInPane(panes, 0, 's1', { at: 1 }).panes;
  assert.deepEqual(
    paneSlots(panes[0]).map((s) => s.tabId || s.slotId),
    ['t1', 's1', 't2'],
  );

  const placed = materializeChooserSlot(panes, 0, 's1', 'p', 't9');
  assert.deepEqual(
    paneSlots(placed.panes[0]).map((s) => s.tabId),
    ['t1', 't9', 't2'],
  );
  assert.equal(placed.panes[0].tabId, 't9', 'новая вкладка показывается');
  assert.equal(paneChooserSlots(placed.panes[0]).length, 0, 'заготовка исчезла');
});

test('материализация забирает вкладку из прежнего окна: одна вкладка — одно окно', () => {
  const panes = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  const placed = materializeChooserSlot(panes, 0, 's1', 'p', 't2');
  assert.equal(paneIndexHoldingTab(placed.panes, 't2'), 0);
  assert.deepEqual(placed.emptied, [1]);
});

test('перезапуск возвращает заготовки на свои места и ничего не запускает', () => {
  let panes = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  panes = openChooserSlotInPane(panes, 1, 's2').panes;
  const fromDisk = JSON.parse(JSON.stringify(panes));

  const restored = sanitizePanes(fromDisk, 0, () => true);
  assert.deepEqual(allPaneSlotIds(restored.panes), ['s1', 's2']);
  assert.equal(restored.panes[0].selectedSlotId, 's1');
  // Ни одной вкладки заготовка на восстановлении не создаёт.
  assert.deepEqual(allPaneTabIds(restored.panes), ['t1', 't2']);
});

test('заготовка начинает с корня проекта и хранит выбранную директорию отдельно', () => {
  let panes = openChooserSlotInPane(twoWindows(), 0, 's1', {
    projectId: 'p',
    cwd: '/project/root',
  }).panes;
  panes = openChooserSlotInPane(panes, 0, 's2', {
    projectId: 'p',
    cwd: '/project/root',
  }).panes;

  assert.equal(paneChooserSlots(panes[0]).find((slot) => slot.slotId === 's1').cwd, '/project/root');
  panes = setChooserSlotDirectory(panes, 0, 's1', '/project/worktree').panes;
  assert.equal(paneChooserSlots(panes[0]).find((slot) => slot.slotId === 's1').cwd, '/project/worktree');
  assert.equal(paneChooserSlots(panes[0]).find((slot) => slot.slotId === 's2').cwd, '/project/root');

  panes = setChooserSlotDirectory(panes, 0, 's1', '/project/worktree ').panes;
  assert.equal(
    paneChooserSlots(panes[0]).find((slot) => slot.slotId === 's1').cwd,
    '/project/worktree ',
    'a space in the selected directory name is data, not input formatting',
  );
});

test('выбранная директория переживает перестройку полосы и restore', () => {
  let panes = openChooserSlotInPane(twoWindows(), 0, 's1', {
    projectId: 'p',
    cwd: '/project/root',
  }).panes;
  const rootKey = splitPanesFingerprint(panes);
  panes = setChooserSlotDirectory(panes, 0, 's1', '/project/worktree').panes;
  assert.notEqual(splitPanesFingerprint(panes), rootKey, 'window refs observe the launch context change');

  // Removing a neighbouring tab runs through mergeChooserSlots — the place
  // may move, but its own launch context must not be reconstructed or lost.
  panes = removeTabFromPane(panes, 0, 't1').panes;
  assert.equal(paneChooserSlots(panes[0])[0].cwd, '/project/worktree');
  const restored = sanitizePanes(JSON.parse(JSON.stringify(panes)), 0, () => true);
  assert.equal(paneChooserSlots(restored.panes[0])[0].cwd, '/project/worktree');
});

test('launch context prefers the exact chooser directory over a neighbour cwd', () => {
  const pane = {
    projectId: '',
    tabId: '',
    selectedSlotId: 's1',
    tabs: [
      { projectId: 'p', tabId: 'old' },
      { projectId: 'p', slotId: 's1', cwd: '/project/worktree' },
    ],
  };
  const context = resolveChooserSlotContext(pane, 's1', {
    projectExists: (id) => id === 'p',
  });
  assert.equal(context.projectId, 'p');
  assert.equal(context.cwd, '/project/worktree');
  assert.equal(context.cwdTabId, 'old', 'neighbour remains only the sidebar insertion anchor');
});

test('окно с заготовкой переживает перезапуск, даже если его вкладка исчезла', () => {
  const panes = openChooserSlotInPane([{ projectId: 'p', tabId: 't1' }], 0, 's1').panes;
  const restored = sanitizePanes(panes, 0, () => false);
  assert.equal(restored.panes.length, 1);
  assert.deepEqual(allPaneSlotIds(restored.panes), ['s1']);
});

test('один и тот же id заготовки в двух окнах снимается на восстановлении', () => {
  const restored = sanitizePanes([
    { projectId: '', tabId: '', tabs: [{ slotId: 'x' }] },
    { projectId: '', tabId: '', tabs: [{ slotId: 'x' }] },
  ], 0, () => true);
  assert.equal(allPaneSlotIds(restored.panes).length, 1);
});

test('раскладка БЕЗ заготовок даёт прежний отпечаток до последнего байта', () => {
  // Отпечаток попадает в опорные ссылки Terminal MCP и в границы memo: новое
  // поле, дописанное безусловно, переименовало бы каждое окно приложения.
  assert.equal(
    splitPanesFingerprint(twoWindows()),
    '[{"column":0,"projectId":"p","tabId":"t1","tabs":[["p","t1"]]},'
    + '{"column":1,"projectId":"p","tabId":"t2","tabs":[["p","t2"]]}]',
  );
});

test('отпечаток различает и наличие заготовки, и то, какая из них показана', () => {
  const one = openChooserSlotInPane(twoWindows(), 0, 's1').panes;
  const two = openChooserSlotInPane(one, 0, 's2').panes;
  assert.notEqual(splitPanesFingerprint(twoWindows()), splitPanesFingerprint(one));
  assert.notEqual(splitPanesFingerprint(one), splitPanesFingerprint(two));
});

test('адрес операции — id заготовки, а не индекс окна', () => {
  const active = { spaceId: 'main', splitPanes: openChooserSlotInPane(twoWindows(), 1, 's1').panes };
  assert.deepEqual(locateChooserSlot({ slotId: 's1', active }), {
    scope: 'active',
    spaceId: 'main',
    paneIndex: 1,
  });

  // Заготовка спящего workflow находится, но помечена как чужая: создавать в
  // неё вкладку молча — значит писать в раскладку, которой человек не видит.
  const dormant = [{ id: 'other', splitPanes: openChooserSlotInPane(twoWindows(), 0, 's9').panes }];
  assert.equal(
    locateChooserSlot({ slotId: 's9', active: { spaceId: 'main', splitPanes: [] }, dormantSpaces: dormant }).scope,
    'dormant',
  );
  assert.equal(locateChooserSlot({ slotId: 'gone', active }), null);
});

test('id заготовки не может совпасть с id вкладки', () => {
  const id = nextChooserSlotId(['newtab-a']);
  assert.match(id, /^newtab-/);
  assert.doesNotMatch(id, /-tab-\d+$/);
});

test('каждый ответ страницы выбора разбирается в один известный путь создания', () => {
  // «Терминал» ВСЕГДА записывает роль: сюда доходит только названный ответ, и
  // забытый флаг возвращал бы вкладку в состояние, принимающее запуск агента.
  assert.equal(resolveChooserLaunchPlan('terminal').commandType, 'generic');
  assert.deepEqual(resolveChooserLaunchPlan('claude').pendingAction, { type: 'claude-new' });
  assert.deepEqual(resolveChooserLaunchPlan('codex').pendingAction, { type: 'codex-new' });
  assert.equal(resolveChooserLaunchPlan('sdk').kind, 'sdk');
  assert.equal(resolveChooserLaunchPlan('nonsense'), null);

  assert.equal(chooserActionNeedsClipboardSession('claude-fork'), true);
  assert.equal(chooserActionNeedsClipboardSession('terminal'), false);
});


// ── R1–R7: разрывы, найденные независимой проверкой первого прохода ────────

test('R5: удаление вкладки не переставляет выживших соседей', () => {
  // `[A, заготовка, B]` минус A обязано дать `[заготовка, B]`. Прежний счёт по
  // сырому индексу давал `[B, заготовка]`: заготовка «стояла второй», и второй
  // после пересборки оказалась позиция после B.
  const before = [
    { projectId: 'p', tabId: 'A' },
    { slotId: 's1' },
    { projectId: 'p', tabId: 'B' },
  ];
  assert.deepEqual(
    mergeChooserSlots(before, [{ projectId: 'p', tabId: 'B' }]).map((e) => e.tabId || e.slotId),
    ['s1', 'B'],
  );
  // Явная перестановка вкладок счёт не меняет: заготовка между теми же соседями.
  assert.deepEqual(
    mergeChooserSlots(before, [
      { projectId: 'p', tabId: 'B' },
      { projectId: 'p', tabId: 'A' },
    ]).map((e) => e.tabId || e.slotId),
    ['B', 's1', 'A'],
  );
});

test('R5: полоса рисуется тем же canonical порядком, что и модель', () => {
  const slots = [
    { projectId: 'p', tabId: 'A' },
    { slotId: 's1' },
    { projectId: 'p', tabId: 'B' },
  ];
  const survivors = [{ projectId: 'p', tabId: 'B' }];
  assert.deepEqual(
    paneStripRenderItems(slots, survivors).map((i) => (i.kind === 'chooser' ? i.slotId : i.tabIds)),
    ['s1', ['B']],
  );
  assert.deepEqual(
    paneStripRenderItems(slots, survivors).map((i) => (i.kind === 'chooser' ? i.slotId : i.tabIds)),
    mergeChooserSlots(slots, survivors).map((e) => (e.slotId ? e.slotId : [e.tabId])),
  );
});

test('R2: припаркованное место заполняется, не отбирая показанную вкладку', () => {
  // Окно успело показать другую настоящую вкладку, пока поднимался процесс.
  let panes = openChooserSlotInPane([
    { projectId: 'p', tabId: 't1' },
    { projectId: 'p', tabId: 't2' },
  ], 0, 's1').panes;
  panes = resolveSplitActivation(panes, 0, 'p', 't1').panes;
  assert.equal(panes[0].tabId, 't1', 'место осталось припаркованным чипом');

  const placed = materializeChooserSlot(panes, 0, 's1', 'p', 'tNew');
  assert.ok(placed, 'заполнение припаркованного места больше не отказывает');
  assert.equal(placed.shown, false, 'экран у человека не отбирается');
  assert.equal(placed.panes[0].tabId, 't1');
  assert.ok(paneSlots(placed.panes[0]).some((s) => s.tabId === 'tNew'));
});


test('R4: проект берётся у КОНКРЕТНОГО места, а не у первого чипа окна', () => {
  // Полоса `[B, A]`, показана A, заготовка стоит рядом с A. Прежний код брал
  // «первый чип с проектом» и запускал в B.
  const pane = {
    projectId: 'projA',
    tabId: 'a1',
    tabs: [
      { projectId: 'projB', tabId: 'b1' },
      { projectId: 'projA', tabId: 'a1' },
      { slotId: 's1', projectId: 'projA' },
    ],
  };
  const ctx = resolveChooserSlotContext(pane, 's1', { fallbackProjectId: 'projFallback' });
  assert.equal(ctx.projectId, 'projA');
  assert.equal(ctx.cwdTabId, 'a1');
});

test('R4: закрытый проект места даёт явный отказ, а не молчаливый чужой проект', () => {
  const pane = { projectId: 'gone', tabId: '', tabs: [{ slotId: 's1', projectId: 'gone' }] };
  const ctx = resolveChooserSlotContext(pane, 's1', {
    projectExists: (id) => id === 'projLive',
    fallbackProjectId: '',
  });
  assert.equal(ctx.projectId, null, 'вызывающий обязан сказать человеку причину');

  // С боковым меню как fallback место всё же получает адрес.
  const withFallback = resolveChooserSlotContext(pane, 's1', {
    projectExists: (id) => id === 'projLive',
    fallbackProjectId: 'projLive',
  });
  assert.equal(withFallback.projectId, 'projLive');
});

test('R3: окно со страницей выбора не адресует команды скрытому AI', () => {
  const panes = openChooserSlotInPane([
    { projectId: 'p', tabId: 'busyAi' },
    { projectId: 'p', tabId: 'other' },
  ], 0, 's1').panes;
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({ panes, focusedIndex: 0, activeTabId: 'busyAi' }),
    null,
    'ответ «рабочей вкладки здесь нет», а не прежний fallback',
  );
  // Пустая заглушка без мест сохраняет прежний fallback.
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({
      panes: [{ projectId: '', tabId: '' }, { projectId: 'p', tabId: 'other' }],
      focusedIndex: 0,
      activeTabId: 'other',
    }),
    'other',
  );
});


// ── S3: замена и удаление — разные события ────────────────────────────────

test('S3: замена A→X сохраняет место заготовки, удаление A — сдвигает', () => {
  const withChooser = () => [{
    projectId: 'p',
    tabId: 'A',
    tabs: [
      { projectId: 'p', tabId: 'A' },
      { slotId: 's1' },
      { projectId: 'p', tabId: 'B' },
    ],
  }, { projectId: 'p', tabId: 'C' }];

  // ЗАМЕНА: обычная активация X в окне, где показана A. X встаёт на место A,
  // заготовка остаётся между X и B.
  const replaced = resolveSplitActivation(withChooser(), 0, 'p', 'X');
  assert.deepEqual(
    paneSlots(replaced.panes[0]).map((e) => e.tabId || e.slotId),
    ['X', 's1', 'B'],
  );

  // УДАЛЕНИЕ: A уходит из окна совсем — слева от заготовки не осталось вкладок.
  const removed = removeTabFromPane(withChooser(), 0, 'A');
  assert.deepEqual(
    paneSlots(removed.panes[0]).map((e) => e.tabId || e.slotId),
    ['s1', 'B'],
  );
});

test('S3: явная замена в НАЗВАННОМ окне подчиняется тому же правилу', () => {
  const panes = [{
    projectId: 'p',
    tabId: 'A',
    tabs: [
      { projectId: 'p', tabId: 'A' },
      { slotId: 's1' },
      { projectId: 'p', tabId: 'B' },
    ],
  }, { projectId: 'p', tabId: 'C' }];
  const res = replacePaneShownTab(panes, 0, 'p', 'X');
  assert.deepEqual(
    paneSlots(res.panes[0]).map((e) => e.tabId || e.slotId),
    ['X', 's1', 'B'],
  );
});
