import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CENTER_PANE_INDEX,
  PLACEMENT_DEFAULT,
  PLACEMENT_ADD_HERE,
  findTabPlacement,
  focusedTarget,
  resolveTabPlacement,
} from './tabPlacementResolver.mjs';

const pane = (tabId, tabs) => (tabs
  ? { projectId: 'p', tabId, tabs: tabs.map((id) => ({ projectId: 'p', tabId: id })) }
  : { projectId: 'p', tabId });

const activeWith = (over = {}) => ({
  spaceId: 'space-1',
  splitPanes: [],
  splitFocusedIndex: 0,
  centerStrips: {},
  centerShownTabId: null,
  ...over,
});

test('обычный переход к вкладке ЕЁ окна не трогает текущее', () => {
  // Вкладка `b` лежит во втором окне и там же показана; человек стоит в первом.
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 0 });
  const plan = resolveTabPlacement({ tabId: 'b', active });
  assert.deepEqual(plan, { kind: 'reveal', spaceId: 'space-1', paneIndex: 1, crossSpace: false });
});

test('обычный переход к чипу, лежащему в окне, но не показанному — тоже в ЕГО окно', () => {
  const active = activeWith({ splitPanes: [pane('a'), pane('b', ['b', 'c'])], splitFocusedIndex: 0 });
  const plan = resolveTabPlacement({ tabId: 'c', active });
  assert.deepEqual(plan, { kind: 'reveal', spaceId: 'space-1', paneIndex: 1, crossSpace: false });
});

test('вкладка, разложенная в ДРУГОМ пространстве, ведёт туда, а не сюда', () => {
  const active = activeWith({ splitPanes: [pane('a')], splitFocusedIndex: 0 });
  const dormantSpaces = [{ id: 'space-2', splitPanes: [pane('z'), pane('b')] }];
  const plan = resolveTabPlacement({ tabId: 'b', active, dormantSpaces });
  assert.deepEqual(plan, { kind: 'reveal', spaceId: 'space-2', paneIndex: 1, crossSpace: true });
});

test('живая раскладка выигрывает у снимка чужого пространства', () => {
  // Одна вкладка может лежать в нескольких пространствах. Если она есть ЗДЕСЬ,
  // никуда не уходим — иначе переключение пространств зацикливается.
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 0 });
  const dormantSpaces = [{ id: 'space-2', splitPanes: [pane('b')] }];
  const plan = resolveTabPlacement({ tabId: 'b', active, dormantSpaces });
  assert.equal(plan.crossSpace, false);
  assert.equal(plan.spaceId, 'space-1');
});

test('без места вкладку показывает текущее окно — единственный случай, когда обычный переход меняет раскладку', () => {
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 1 });
  const plan = resolveTabPlacement({ tabId: 'newcomer', active });
  assert.deepEqual(plan, { kind: 'move', paneIndex: 1, detach: false });
});

test('уже показанная в текущем окне вкладка — жест ничего не меняет', () => {
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 1 });
  assert.deepEqual(resolveTabPlacement({ tabId: 'b', active }), { kind: 'noop' });
});

test('add-here добавляет вкладку из чужого окна в текущее и снимает со старого места', () => {
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 0 });
  const plan = resolveTabPlacement({ tabId: 'b', mode: PLACEMENT_ADD_HERE, active });
  assert.deepEqual(plan, { kind: 'append', paneIndex: 0, detach: true });
});

test('add-here по вкладке без места добавляет её, а обычный клик заменяет', () => {
  const active = activeWith({ splitPanes: [pane('a'), pane('b')], splitFocusedIndex: 1 });
  assert.deepEqual(
    resolveTabPlacement({ tabId: 'newcomer', active }),
    { kind: 'move', paneIndex: 1, detach: false },
  );
  assert.deepEqual(
    resolveTabPlacement({ tabId: 'newcomer', mode: PLACEMENT_ADD_HERE, active }),
    { kind: 'append', paneIndex: 1, detach: false },
  );
});

test('add-here добавляет и вкладку другого пространства', () => {
  const active = activeWith({ splitPanes: [pane('a')], splitFocusedIndex: 0 });
  const dormantSpaces = [{ id: 'space-2', splitPanes: [pane('b')] }];
  const plan = resolveTabPlacement({ tabId: 'b', mode: PLACEMENT_ADD_HERE, active, dormantSpaces });
  assert.deepEqual(plan, { kind: 'append', paneIndex: 0, detach: true });
});

test('add-here по чипу СВОЕГО окна, который не показан, показывает его', () => {
  const active = activeWith({ splitPanes: [pane('a', ['a', 'c'])], splitFocusedIndex: 0 });
  const plan = resolveTabPlacement({ tabId: 'c', mode: PLACEMENT_ADD_HERE, active });
  assert.deepEqual(plan, { kind: 'append', paneIndex: 0, detach: true });
});

test('add-here по уже показанной здесь вкладке ничего не делает', () => {
  const active = activeWith({ splitPanes: [pane('a')], splitFocusedIndex: 0 });
  assert.deepEqual(
    resolveTabPlacement({ tabId: 'a', mode: PLACEMENT_ADD_HERE, active }),
    { kind: 'noop' },
  );
});

test('add-here очищает legacy-дубликат другого workflow, даже если tab уже показан здесь', () => {
  const active = activeWith({ splitPanes: [pane('a')], splitFocusedIndex: 0 });
  const dormantSpaces = [{
    id: 'space-2',
    splitPanes: [],
    centerStrips: {},
    activeSpaceTab: { projectId: 'p', tabId: 'a' },
  }];
  assert.deepEqual(resolveTabPlacement({
    tabId: 'a',
    mode: PLACEMENT_ADD_HERE,
    active,
    dormantSpaces,
  }), { kind: 'append', paneIndex: 0, detach: true });
});

test('одиночный режим: полоса центра — тоже размещение', () => {
  const active = activeWith({
    centerStrips: { p: [{ projectId: 'p', tabId: 'a' }, { projectId: 'p', tabId: 'b' }] },
    centerShownTabId: 'a',
  });
  assert.deepEqual(findTabPlacement({ tabId: 'b', active }), {
    scope: 'active', spaceId: 'space-1', paneIndex: CENTER_PANE_INDEX, shown: false,
  });
  assert.deepEqual(resolveTabPlacement({ tabId: 'b', active }), {
    kind: 'reveal', spaceId: 'space-1', paneIndex: CENTER_PANE_INDEX, crossSpace: false,
  });
  assert.deepEqual(resolveTabPlacement({ tabId: 'a', active }), { kind: 'noop' });
});

test('одиночный режим без полосы: цель — центр', () => {
  const active = activeWith({});
  assert.equal(focusedTarget(active), CENTER_PANE_INDEX);
  assert.deepEqual(resolveTabPlacement({ tabId: 'a', active }), {
    kind: 'move', paneIndex: CENTER_PANE_INDEX, detach: false,
  });
});

test('activeSpaceTab — placement одиночного workflow без сохранённой полосы', () => {
  const active = activeWith({
    activeSpaceTab: { projectId: 'p', tabId: 'solo' },
    centerShownTabId: 'solo',
  });
  assert.deepEqual(resolveTabPlacement({ tabId: 'solo', active }), { kind: 'noop' });

  const other = activeWith({ centerShownTabId: 'a' });
  const dormantSpaces = [{
    id: 'space-2',
    splitPanes: [],
    centerStrips: {},
    activeSpaceTab: { projectId: 'p', tabId: 'solo' },
  }];
  assert.deepEqual(resolveTabPlacement({ tabId: 'solo', active: other, dormantSpaces }), {
    kind: 'reveal',
    spaceId: 'space-2',
    paneIndex: CENTER_PANE_INDEX,
    crossSpace: true,
  });
});

test('пустой tabId не описывает никакого действия', () => {
  assert.deepEqual(resolveTabPlacement({ tabId: '', active: activeWith({}) }), { kind: 'noop' });
  assert.equal(findTabPlacement({ tabId: '', active: activeWith({}) }), null);
  assert.equal(resolveTabPlacement({ tabId: 'x', mode: PLACEMENT_DEFAULT, active: activeWith({}) }).kind, 'move');
});
