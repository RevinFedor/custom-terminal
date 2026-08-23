// Правила рабочих пространств — без DOM и без стора.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SPACE_NAME,
  SPACE_LAYOUT_FIELDS,
  addSpace,
  captureSpaceLayout,
  emptySpaceLayout,
  inferSpaceProjectIds,
  removeSpace,
  reorderSpaces,
  renameSpace,
  restoreSpaces,
  spaceIndexHoldingTab,
  tabSpaceIndexMap,
  spaceTabCount,
  switchSpace,
  dropTabsFromOtherSpaces,
  reprojectTabsInSpaces,
  updateSpaceMetadata,
} from './workspaceSpacesModel.mjs';
import { allPaneTabIds, dropTabFromAllPaneStrips } from './splitPanesModel.mjs';

const p = (projectId, tabId, tabs) => (tabs ? { projectId, tabId, tabs } : { projectId, tabId });
const space = (id, name, layout = {}) => ({ id, name, layout: { ...emptySpaceLayout(), ...layout } });

test('сохранённая раскладка СТАНОВИТСЯ первым пространством, а не теряется', () => {
  // Человек закрыл приложение с разложенными окнами и обязан увидеть их же.
  const res = restoreSpaces(null, { splitPanes: [p('p1', 'a'), p('p1', 'b')], splitFocusedIndex: 1 });
  assert.equal(res.spaces.length, 1);
  assert.equal(res.spaces[0].name, DEFAULT_SPACE_NAME);
  assert.deepEqual(res.spaces[0].layout.splitPanes.map((x) => x.tabId), ['a', 'b']);
  assert.equal(res.spaces[0].layout.splitFocusedIndex, 1);
  assert.equal(res.activeSpaceId, res.spaces[0].id);
});

test('восстановление: активным становится сохранённое, а мусорный id не выбирает пустоту', () => {
  const saved = { spaces: [space('s1', 'main'), space('s2', 'фикс')], activeSpaceId: 's2' };
  assert.equal(restoreSpaces(saved, {}).activeSpaceId, 's2');
  assert.equal(restoreSpaces({ ...saved, activeSpaceId: 'нет такого' }, {}).activeSpaceId, 's1');
});

test('workflow reorder меняет только порядок и сохраняет layout identity', () => {
  const one = space('s1', 'one', { splitPanes: [p('p', 'a')] });
  const two = space('s2', 'two', { splitPanes: [p('p', 'b')] });
  const result = reorderSpaces([one, two], ['s2', 's1']);
  assert.deepEqual(result.spaces.map((entry) => entry.id), ['s2', 's1']);
  assert.equal(result.spaces[0], two);
  assert.equal(result.spaces[1], one);
  assert.equal(reorderSpaces([one, two], ['s1', 's2']), null);
  assert.equal(reorderSpaces([one, two], ['s1', 'missing']), null);
});

test('legacy workflow получает проекты из всей раскладки, а новая metadata сохраняется как есть', () => {
  const legacy = restoreSpaces({
    spaces: [{
      id: 's1',
      name: 'main',
      layout: {
        activeProjectId: 'p1',
        splitPanes: [{ projectId: 'p2', tabId: 'a', tabs: [{ projectId: 'p3', tabId: 'b' }] }],
        centerStrips: { p4: [{ projectId: 'p4', tabId: 'c' }] },
      },
    }],
    activeSpaceId: 's1',
  }, {});
  assert.deepEqual(legacy.spaces[0].projectIds, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(legacy.spaces[0].icon, undefined, 'отсутствующая legacy icon остаётся различима от явного reset');

  const modern = restoreSpaces({
    spaces: [{ id: 's1', name: 'main', icon: 'data:image/svg+xml,x', projectIds: ['p4', 'p4', 'p2'], layout: {} }],
    activeSpaceId: 's1',
  }, {});
  assert.equal(modern.spaces[0].icon, 'data:image/svg+xml,x');
  assert.deepEqual(modern.spaces[0].projectIds, ['p4', 'p2']);
});

test('проекты workflow выводятся и из активной вкладки, и из вложенных pane chips', () => {
  assert.deepEqual(inferSpaceProjectIds({
    activeSpaceTab: { projectId: 'p0', tabId: 'z' },
    splitPanes: [{
      projectId: 'p1',
      tabId: 'a',
      tabs: [{ projectId: 'p2', tabId: 'b' }, { projectId: 'p1', tabId: 'a' }],
    }],
  }), ['p0', 'p1', 'p2']);
});

test('новое пространство ПУСТОЕ — ничего не создаётся само', () => {
  const res = addSpace([space('s1', 'main')], 's1', 's2');
  assert.deepEqual(res.spaces[1].layout, emptySpaceLayout());
  assert.deepEqual(res.spaces[1].projectIds, []);
  assert.equal(res.spaces[1].icon, null);
  assert.equal(res.activeSpaceId, 's2', 'и сразу становится текущим');
});

test('metadata workflow меняется без перезаписи раскладки', () => {
  const before = space('s1', 'main', { splitPanes: [p('p1', 'a')] });
  const res = updateSpaceMetadata([before], 's1', {
    icon: 'data:image/svg+xml,new',
    projectIds: ['p2', 'p1', 'p2'],
  });
  assert.equal(res.space.icon, 'data:image/svg+xml,new');
  assert.deepEqual(res.space.projectIds, ['p2', 'p1']);
  assert.equal(res.space.layout, before.layout, 'layout сохраняет identity и содержимое');
  assert.equal(updateSpaceMetadata(res.spaces, 's1', { projectIds: ['p2', 'p1'] }), null);
});

test('имена не повторяются: второе «Пространство» получает номер', () => {
  let list = [space('s1', 'main')];
  list = addSpace(list, 's1', 's2').spaces;
  list = addSpace(list, 's2', 's3').spaces;
  assert.deepEqual(list.map((s) => s.name), ['main', 'Пространство', 'Пространство 2']);
});

test('последнее пространство не удаляется', () => {
  assert.equal(removeSpace([space('s1', 'main')], 's1', 's1'), null);
});

test('удалили текущее — переходим к соседу справа, иначе слева', () => {
  const list = [space('s1'), space('s2'), space('s3')];
  assert.equal(removeSpace(list, 's2', 's2').activeSpaceId, 's3');
  assert.equal(removeSpace(list, 's3', 's3').activeSpaceId, 's2');
  // Удалили ЧУЖОЕ — взгляд не двигается.
  assert.equal(removeSpace(list, 's2', 's1').activeSpaceId, 's2');
});

test('переименование: пустое имя не имя', () => {
  const list = [space('s1', 'main')];
  assert.equal(renameSpace(list, 's1', '   '), null);
  assert.equal(renameSpace(list, 's1', 'main'), null, 'то же имя — не правка');
  assert.equal(renameSpace(list, 's1', ' ресерч ').spaces[0].name, 'ресерч');
});

test('переключение СНАЧАЛА записывает уходящую раскладку', () => {
  // Раскладка живёт в общем состоянии: без снимка переключение затрёт её.
  const list = [space('s1', 'main'), space('s2', 'фикс')];
  const res = switchSpace(list, 's1', 's2', { splitPanes: [p('p1', 'a')], splitFocusedIndex: 0 });
  assert.deepEqual(res.spaces[0].layout.splitPanes.map((x) => x.tabId), ['a']);
  assert.deepEqual(res.layout.splitPanes, [], 'а отдаёт раскладку целевого');
  assert.equal(res.activeSpaceId, 's2');
});

test('переключение в себя — ничего не происходит', () => {
  assert.equal(switchSpace([space('s1')], 's1', 's1', {}), null);
  assert.equal(switchSpace([space('s1')], 's1', 'нет такого', {}), null);
});

test('снимок раскладки берёт ВСЕ поля, даже отсутствующие', () => {
  // Поле, забытое в одном из переключений, теряется молча — тот же класс
  // ошибки, что «закрытие приложения стирало раскладку».
  const shot = captureSpaceLayout({ splitPanes: [p('p1', 'a')] });
  assert.deepEqual(Object.keys(shot).sort(), [...SPACE_LAYOUT_FIELDS].sort());
  assert.equal(shot.splitSizes, null);
  assert.deepEqual(shot.centerStrips, {});
});

test('число рядом с именем: РАЗНЫЕ вкладки, а не сумма чипов', () => {
  // Вкладка, показанная в одном окне и лежащая чипом в другом, — одна вкладка.
  const s = space('s1', 'main', {
    splitPanes: [
      p('p1', 'a', [{ projectId: 'p1', tabId: 'a' }, { projectId: 'p1', tabId: 'b' }]),
      p('p1', 'c'),
    ],
  });
  assert.equal(spaceTabCount(s, allPaneTabIds), 3);
});

test('число считает и полосу одиночного центра — окон нет, а чипы есть', () => {
  const s = space('s1', 'main', {
    centerStrips: { p1: [{ projectId: 'p1', tabId: 'a' }, { projectId: 'p1', tabId: 'b' }] },
  });
  assert.equal(spaceTabCount(s, allPaneTabIds), 2);
});

test('одиночный центр без strip считается по activeSpaceTab', () => {
  const s = space('s1', 'main', {
    activeSpaceTab: { projectId: 'p1', tabId: 'solo' },
  });
  assert.equal(spaceTabCount(s, allPaneTabIds), 1);
  assert.equal(spaceIndexHoldingTab([s], 'solo', allPaneTabIds), 0);
});

test('в каком пространстве лежит вкладка — номер для карточки в списке', () => {
  const list = [
    space('s1', 'main', { splitPanes: [p('p1', 'a')] }),
    space('s2', 'фикс', { splitPanes: [p('p1', 'b')] }),
    space('s3', 'ресерч', { centerStrips: { p1: [{ projectId: 'p1', tabId: 'c' }] } }),
  ];
  assert.equal(spaceIndexHoldingTab(list, 'b', allPaneTabIds), 1);
  assert.equal(spaceIndexHoldingTab(list, 'c', allPaneTabIds), 2, 'полоса центра тоже раскладка');
  assert.equal(spaceIndexHoldingTab(list, 'нигде', allPaneTabIds), -1);
});

test('вкладка в нескольких пространствах называет ПЕРВОЕ', () => {
  // Номер должен быть один и тот же при каждом взгляде, а не зависеть от того,
  // куда её положили последней.
  const list = [
    space('s1', 'main', { splitPanes: [p('p1', 'a')] }),
    space('s2', 'фикс', { splitPanes: [p('p1', 'a')] }),
  ];
  assert.equal(spaceIndexHoldingTab(list, 'a', allPaneTabIds), 0);
  assert.equal(spaceIndexHoldingTab(list, 'a', allPaneTabIds, 's2'), 1, 'активное место выигрывает');
  assert.equal(tabSpaceIndexMap(list, allPaneTabIds, 's2').get('a'), 1);
});

// ── Закрытая вкладка не должна пережить себя в чужом пространстве ─────────

test('закрытая вкладка убирается из окон ОСТАЛЬНЫХ пространств', () => {
  // Текущее чистят обычные пути; окна остальных они не видят вовсе, и чип,
  // указывающий в никуда, дожил бы до возврата в это пространство — на экране
  // это окно без разметки, а не «лишний чип».
  const list = [
    space('s1', 'main', { splitPanes: [p('p1', 'a')] }),
    space('s2', 'фикс', { splitPanes: [p('p1', 'b'), p('p1', 'c')] }),
  ];
  const res = dropTabsFromOtherSpaces(list, 's1', ['b'], dropTabFromAllPaneStrips);
  // Окно, потерявшее последнюю вкладку, становится ЗАГЛУШКОЙ на своём месте —
  // ровно как в видимой раскладке: «убрать содержимое» ≠ «убрать окно».
  assert.deepEqual(res.spaces[1].layout.splitPanes.map((x) => x.tabId), ['', 'c']);
  assert.deepEqual(res.spaces[0].layout.splitPanes.map((x) => x.tabId), ['a'], 'текущее не трогаем');
});

test('чистка задевает и полосы центра чужого пространства', () => {
  const list = [
    space('s1', 'main'),
    space('s2', 'фикс', { centerStrips: { p1: [{ projectId: 'p1', tabId: 'a' }, { projectId: 'p1', tabId: 'b' }] } }),
  ];
  const res = dropTabsFromOtherSpaces(list, 's1', ['b'], dropTabFromAllPaneStrips);
  // Один чип — это не полоса: запись исчезает целиком.
  assert.deepEqual(res.spaces[1].layout.centerStrips, {});
});

test('перенос/закрытие чистит activeSpaceTab одиночного чужого workflow', () => {
  const list = [
    space('s1', 'main'),
    space('s2', 'solo', { activeSpaceTab: { projectId: 'p1', tabId: 'a' } }),
  ];
  const res = dropTabsFromOtherSpaces(list, 's1', ['a'], dropTabFromAllPaneStrips);
  assert.equal(res.spaces[1].layout.activeSpaceTab, null);
});

test('нечего убирать — нет и записи', () => {
  const list = [space('s1', 'main'), space('s2', 'фикс', { splitPanes: [p('p1', 'b')] })];
  assert.equal(dropTabsFromOtherSpaces(list, 's1', [], dropTabFromAllPaneStrips), null);
  assert.equal(dropTabsFromOtherSpaces(list, 's1', ['нет такой'], dropTabFromAllPaneStrips), null);
});

test('смена проекта переписывает владельца вкладки во всех workflow snapshots', () => {
  const list = [space('s1', 'main', {
    splitPanes: [p('old', 'a')],
    centerStrips: { old: [p('old', 'a'), p('old', 'b')] },
    activeSpaceTab: p('old', 'a'),
  })];
  const next = reprojectTabsInSpaces(
    list,
    (tabId) => tabId === 'a',
    'new',
    (panes, moved, projectId) => panes.map((pane) => moved(pane.tabId) ? { ...pane, projectId } : pane),
  );
  assert.equal(next[0].layout.splitPanes[0].projectId, 'new');
  assert.equal(next[0].layout.centerStrips.old[0].projectId, 'new');
  assert.equal(next[0].layout.centerStrips.old[1].projectId, 'old');
  assert.equal(next[0].layout.activeSpaceTab.projectId, 'new');
});
