// Шрам 01Nov: ОДИН отвергнутый перенос вкладки в полосе окна заблокировал все
// действия с группами. «Свернуть», Ungroup, «Добавить в группу» и CREATE
// отвечали `workflow_strip_release_deferral_invalid`, и это переживало
// перезапуск приложения.
//
// Механика. Отвергнутый релиз остаётся «несогласованной парой». Пока она жива,
// КАЖДЫЙ снимок организации несёт `stripReleaseDeferrals` — просьбу «сохрани
// канонический W ровно таким, какой он сейчас у Main». Main сверяет эту просьбу
// с тем же самым snapshot, который renderer прислал. Сверка сходится, только
// пока локальная раскладка ещё равна одному из двух значений пары. Как только
// пользователь поработал дальше и раскладка ушла от обоих, просьба перестаёт
// описывать что-либо достижимое — и отказывает навсегда, вместе со всей
// организацией, а не только с переносом.
//
// Здесь проверяется ровно эта граница: мёртвая пара снимается, живая остаётся.
import test from 'node:test';
import assert from 'node:assert/strict';

import {organizationSnapshot} from './workflowOrganizationClient.mjs';
import {applyPaneStripReleasePublication} from './paneStripReleasePair.mjs';

const clone = structuredClone;
const tab = (tabId) => ({projectId: 'P', tabId});
const layoutOf = (...tabIds) => ({
  splitPanes: [{windowId: 'win', projectId: 'P', tabId: tabIds[0] || '', tabs: tabIds.map(tab)}],
  centerStrips: {},
});
const field = (revision) => ({version: 1, revision, groups: [
  {id: 'g', revision: 1, color: '#abcdef', collapsed: true, tabIds: ['a', 'b']},
]});

// Точка, в которой пара родилась: Main держит A,B,C, пользователь перетащил C
// вперёд, Main отказал. Пара запоминает оба состояния, статус — «не согласована».
function stateWithRejectedPair({local, canonical = layoutOf('a', 'b', 'c')} = {}) {
  const target = layoutOf('c', 'a', 'b');
  return {
    activeSpaceId: 'other',
    spaces: [{id: 'W', kind: 'user', stripColorGroups: field(1), layout: clone(local)}],
    tabWorkflowMembership: {a: {tabId: 'a', workflowId: 'W', revision: 1}},
    pendingTabWorkflowMembership: {},
    tabCatalog: {a: {tabId: 'a', active: true}},
    paneStripReleasedPairs: {
      version: 1,
      commands: {},
      workflows: {
        W: {
          workflowId: 'W',
          status: 'unreconciled',
          beforeLayout: clone(canonical),
          layout: clone(target),
          field: field(1),
          intent: {version: 2, workflowId: 'W', rootTabIds: ['c'], activeBasis: [['c', true]]},
          canonical: {layout: clone(canonical), field: field(1), publicationRevision: 10},
        },
      },
    },
  };
}

test('живая пара по-прежнему просит Main сохранить канонический workflow', () => {
  // Локальная раскладка всё ещё равна той, что пара показывает пользователю:
  // просьба осмысленна, Main сможет её проверить. Ничего не меняем.
  const state = stateWithRejectedPair({local: layoutOf('c', 'a', 'b')});
  const snapshot = organizationSnapshot(state);
  assert.equal(snapshot.stripReleaseDeferrals?.length, 1);
  assert.equal(snapshot.stripReleaseDeferrals[0].workflowId, 'W');
});

test('пара, равная канону, тоже остаётся: её ещё можно согласовать', () => {
  const state = stateWithRejectedPair({local: layoutOf('a', 'b', 'c')});
  assert.equal(organizationSnapshot(state).stripReleaseDeferrals?.length, 1);
});

test('мёртвая пара снимается и не блокирует действия с группами', () => {
  // Пользователь поработал дальше: раскладка не равна ни канону A,B,C, ни
  // цели пары C,A,B. Сверка Main не сойдётся никогда — значит, просьбы быть
  // не должно, а рабочее пространство сохраняется обычным образом.
  const state = stateWithRejectedPair({local: layoutOf('b', 'c', 'a')});
  const snapshot = organizationSnapshot(state);
  assert.equal(snapshot.stripReleaseDeferrals, undefined, 'мёртвая просьба не уходит в Main');
  assert.equal(snapshot.spaces.length, 1);
  assert.deepEqual(
    snapshot.spaces[0].layout.splitPanes[0].tabs.map((entry) => entry.tabId),
    ['b', 'c', 'a'],
    'отправляется текущее состояние пользователя, а не подменённое парой',
  );
});

test('мёртвая пара удаляется из состояния, а не воскресает после перезапуска', () => {
  // Снятия в снимке мало: запись лежит в сохранённой сессии и вернулась бы с
  // ней. Очередная публикация от Main обязана её убрать.
  const state = stateWithRejectedPair({local: layoutOf('b', 'c', 'a')});
  const published = [{id: 'W', kind: 'user', layout: layoutOf('a', 'b', 'c'), stripColorGroups: field(1)}];
  const next = applyPaneStripReleasePublication(
    state, {}, published, {revision: 11}, state.tabCatalog, undefined, state.tabWorkflowMembership,
  );
  assert.equal(next.paneStripReleasedPairs.workflows.W, undefined, 'мёртвая пара удалена');
});

test('пара, которую публикация ещё может согласовать, переживает её', () => {
  // Та же публикация, но локальная раскладка по-прежнему совпадает с парой:
  // это нормальное ожидание ответа, удалять нечего.
  const state = stateWithRejectedPair({local: layoutOf('c', 'a', 'b')});
  const published = [{id: 'W', kind: 'user', layout: layoutOf('a', 'b', 'c'), stripColorGroups: field(1)}];
  const next = applyPaneStripReleasePublication(
    state, {}, published, {revision: 11}, state.tabCatalog, undefined, state.tabWorkflowMembership,
  );
  assert.equal(next.paneStripReleasedPairs.workflows.W?.status, 'unreconciled', 'живая пара сохранена');
});

test('совпадение публикации с парой по-прежнему закрывает её как успех', () => {
  // Отдельная уже существующая ветка: Main в итоге опубликовал ровно то, чего
  // пара добивалась. Она закрывается как выполненная, а не как мёртвая.
  const state = stateWithRejectedPair({local: layoutOf('c', 'a', 'b')});
  const published = [{id: 'W', kind: 'user', layout: layoutOf('c', 'a', 'b'), stripColorGroups: field(1)}];
  const next = applyPaneStripReleasePublication(
    state, {}, published, {revision: 11}, state.tabCatalog, undefined, state.tabWorkflowMembership,
  );
  assert.equal(next.paneStripReleasedPairs.workflows.W, undefined);
});
