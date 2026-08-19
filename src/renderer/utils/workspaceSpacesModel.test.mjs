// Правила рабочих пространств — без DOM и без стора.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SPACE_NAME,
  SPACE_LAYOUT_FIELDS,
  addSpace,
  captureSpaceLayout,
  emptySpaceLayout,
  removeSpace,
  renameSpace,
  restoreSpaces,
  spaceIndexHoldingTab,
  spaceTabCount,
  switchSpace,
  dropTabsFromOtherSpaces,
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

test('новое пространство ПУСТОЕ — ничего не создаётся само', () => {
  const res = addSpace([space('s1', 'main')], 's1', 's2');
  assert.deepEqual(res.spaces[1].layout, emptySpaceLayout());
  assert.equal(res.activeSpaceId, 's2', 'и сразу становится текущим');
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

test('нечего убирать — нет и записи', () => {
  const list = [space('s1', 'main'), space('s2', 'фикс', { splitPanes: [p('p1', 'b')] })];
  assert.equal(dropTabsFromOtherSpaces(list, 's1', [], dropTabFromAllPaneStrips), null);
  assert.equal(dropTabsFromOtherSpaces(list, 's1', ['нет такой'], dropTabFromAllPaneStrips), null);
});
