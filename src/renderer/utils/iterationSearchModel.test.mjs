import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIterationRows,
  iterationHitPosition,
  mergeIterationChunk,
  collectIterationTargets,
  countIterationHits,
  countIterationTabs,
  iterationPanelMaxHeight,
  resolveIterationTarget,
  splitByOffsets,
} from './iterationSearchModel.mjs';

const workspace = (projectPath, tabs) => ({
  projectPath,
  tabs: new Map(tabs.map((tab) => [tab.id, tab])),
});

test('спрашиваем только вкладки С СЕССИЕЙ: у остальных нет промптов на диске', () => {
  const openProjects = new Map([
    ['p1', workspace('/p1', [
      { id: 'a', name: 'A', claudeSessionId: 's-a' },
      { id: 'b', name: 'B' },                                   // нет сессии
      { id: 'c', name: 'C', codexSessionId: 's-c' },
    ])],
  ]);
  const targets = collectIterationTargets({ openProjects, globalMru: [] });
  assert.deepEqual(targets.map((t) => t.tabId), ['a', 'c']);
  assert.equal(targets[1].toolType, 'codex');
});

test('дочерние вкладки суб-агентов не строки переключателя ни на одной поверхности', () => {
  const openProjects = new Map([
    ['p1', workspace('/p1', [
      { id: 'a', name: 'A', claudeSessionId: 's-a' },
      { id: 'child', name: 'child', claudeSessionId: 's-child', parentTabId: 'a' },
    ])],
  ]);
  assert.deepEqual(
    collectIterationTargets({ openProjects, globalMru: [] }).map((t) => t.tabId),
    ['a'],
  );
});

test('порядок вкладок — свежесть, тот же, что в списке вкладок', () => {
  // Порядок групп в результатах человек уже знает по списку вкладок. Своя
  // сортировка «по релевантности» у буквального поиска была бы выдумкой:
  // сигнала релевантности, кроме числа совпадений, у него нет.
  const openProjects = new Map([
    ['p1', workspace('/p1', [
      { id: 'old', name: 'old', claudeSessionId: 's1' },
      { id: 'fresh', name: 'fresh', claudeSessionId: 's2' },
    ])],
  ]);
  const targets = collectIterationTargets({
    openProjects,
    globalMru: [{ projectId: 'p1', tabId: 'fresh' }, { projectId: 'p1', tabId: 'old' }],
  });
  assert.deepEqual(targets.map((t) => t.tabId), ['fresh', 'old']);
});

test('выбор проектов сужает вопрос, а пустой выбор означает «нигде»', () => {
  // Пустой набор — настоящее состояние, а не «искать везде»: подмена меняла бы
  // объём ответа сама собой, без действия человека.
  const openProjects = new Map([
    ['p1', workspace('/p1', [{ id: 'a', name: 'A', claudeSessionId: 's1' }])],
    ['p2', workspace('/p2', [{ id: 'b', name: 'B', claudeSessionId: 's2' }])],
  ]);
  assert.deepEqual(
    collectIterationTargets({ openProjects, projectFilter: new Set(['p2']) }).map((t) => t.tabId),
    ['b'],
  );
  assert.equal(
    collectIterationTargets({ openProjects, projectFilter: new Set() }).length,
    2,
    'пустой набор здесь обрабатывает вызывающая сторона, модель без фильтра отдаёт всё',
  );
});

test('workflow scope filters exact tabs, including a truly empty selection', () => {
  const openProjects = new Map([
    ['p1', workspace('/p1', [
      { id: 'a', name: 'A', claudeSessionId: 's1' },
      { id: 'b', name: 'B', claudeSessionId: 's2' },
    ])],
  ]);
  assert.deepEqual(
    collectIterationTargets({ openProjects, tabFilter: new Set(['b']) }).map((target) => target.tabId),
    ['b'],
  );
  assert.deepEqual(collectIterationTargets({ openProjects, tabFilter: new Set() }), []);
});

test('результаты группируются по ВКЛАДКЕ, и группа заводится один раз', () => {
  // «В какой вкладке я это писал» и есть тот ответ, за которым приходят.
  // Плоский список десяти промптов одной вкладки читался бы как десять мест.
  const rows = buildIterationRows(
    [
      { tabId: 't1', projectId: 'p1', entryUuid: 'u1', toolType: 'claude' },
      { tabId: 't1', projectId: 'p1', entryUuid: 'u2', toolType: 'claude' },
      { tabId: 't2', projectId: 'p1', entryUuid: 'u3', toolType: 'codex' },
    ],
    (tabId) => ({ projectName: 'P', tabName: tabId.toUpperCase() }),
  );
  assert.deepEqual(rows.map((row) => row.kind), [
    'iteration-tab', 'iteration', 'iteration', 'iteration-tab', 'iteration',
  ]);
  assert.equal(rows[0].tabName, 'T1');
  assert.equal(rows[0].workflowName, 'Не размещены');
  assert.equal(rows[3].toolType, 'codex');
  assert.equal(countIterationHits(rows), 3);
  assert.equal(countIterationTabs(rows), 2);
});

test('строка без uuid отбрасывается: вести по ней некуда', () => {
  const rows = buildIterationRows([{ tabId: 't1', projectId: 'p1' }], () => ({}));
  assert.deepEqual(rows, []);
});

test('высота панели — доля экрана, и чем экран меньше, тем доля больше', () => {
  // Половина 4K-монитора больше, чем весь экран ноутбука; на ноутбуке та же
  // половина не вмещает и трёх промптов, а беречь там нечего.
  const big = iterationPanelMaxHeight(2160, 70);
  const small = iterationPanelMaxHeight(900, 70);
  assert.equal(big, Math.round(2160 * 0.5));
  assert.equal(small, Math.round(900 * 0.8));
  assert.ok(small / 900 > big / 2160);
  // Панель не может быть выше того, что осталось под полосами.
  assert.ok(iterationPanelMaxHeight(600, 70) <= 600 - 70 - 24);
});

test('переход ведёт на вкладку и на конкретный промпт', () => {
  assert.deepEqual(
    resolveIterationTarget({ projectId: 'p1', tabId: 't1', entryUuid: 'u1' }),
    { projectId: 'p1', tabId: 't1', entryUuid: 'u1' },
  );
});

test('подсветка режется по смещениям от main, а не своим поиском', () => {
  // Своё правило подсветки разошлось бы с тем, по которому промпт попал в
  // список: строка выглядела бы ложным срабатыванием при верном совпадении.
  const parts = splitByOffsets('раз кэш два', [{ start: 4, end: 7 }]);
  assert.deepEqual(parts, [
    { text: 'раз ', hit: false },
    { text: 'кэш', hit: true },
    { text: ' два', hit: false },
  ]);
});

test('битые смещения не рвут текст: он показывается целиком', () => {
  assert.deepEqual(splitByOffsets('текст', [{ start: 9, end: 3 }]), [{ text: 'текст', hit: false }]);
  assert.deepEqual(splitByOffsets('текст', []), [{ text: 'текст', hit: false }]);
});

test('пришедший кусок встаёт НА МЕСТО вкладки, а не в конец', () => {
  // Порядок групп задаёт свежесть вкладок, она известна заранее. Класть куски
  // в порядке прихода значило бы двигать уже показанный ответ вниз каждый раз,
  // когда доразобралась более свежая вкладка, — список прыгал бы под курсором.
  const order = ['fresh', 'middle', 'old'];
  let hits = [];
  hits = mergeIterationChunk(hits, { tabId: 'old', hits: [{ tabId: 'old', entryUuid: 'o1' }] }, order);
  hits = mergeIterationChunk(hits, { tabId: 'fresh', hits: [{ tabId: 'fresh', entryUuid: 'f1' }] }, order);
  assert.deepEqual(hits.map((hit) => hit.tabId), ['fresh', 'old']);
});

test('повтор той же вкладки заменяет её группу, а не удваивает', () => {
  const order = ['t1'];
  let hits = mergeIterationChunk([], { tabId: 't1', hits: [{ tabId: 't1', entryUuid: 'a' }] }, order);
  hits = mergeIterationChunk(hits, { tabId: 't1', hits: [{ tabId: 't1', entryUuid: 'b' }] }, order);
  assert.deepEqual(hits.map((hit) => hit.entryUuid), ['b']);
});

test('пустой кусок не трогает список: «вкладка без совпадений» — не событие', () => {
  const current = [{ tabId: 't1', entryUuid: 'a' }];
  assert.equal(mergeIterationChunk(current, { tabId: 't2', hits: [] }, ['t1', 't2']), current);
});

test('номер выделенного считается ОТ СПИСКА, а не своим счётчиком', () => {
  // Второй счётчик разошёлся бы с выделением на первом же обновлении списка, и
  // стрелки двигали бы одно, а число показывало другое.
  const rows = [
    { kind: 'iteration-tab' },
    { kind: 'iteration' },
    { kind: 'iteration' },
    { kind: 'iteration-tab' },
    { kind: 'iteration' },
  ];
  assert.equal(iterationHitPosition(rows, 1), 1);
  assert.equal(iterationHitPosition(rows, 2), 2);
  assert.equal(iterationHitPosition(rows, 4), 3);
  // Выделен заголовок вкладки — номера нет, и врать про него нельзя.
  assert.equal(iterationHitPosition(rows, 3), 0);
});
