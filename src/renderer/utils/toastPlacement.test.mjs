import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hiddenToastCountForChips,
  hiddenToastOwnerCounts,
  isErrorToast,
  isToastVisible,
  resolveToastHostTabId,
  visibleToastTabIds,
} from './toastPlacement.mjs';

const pane = (tabId) => ({ projectId: 'p', tabId });

test('split mode: every pane tab is visible, focus is irrelevant', () => {
  // Баг: уведомление про окно 0 исчезало, как только фокус уходил в окно 1,
  // хотя окно 0 всё это время на экране.
  const ids = visibleToastTabIds({ panes: [pane('a'), pane('b')], effectiveTabId: 'b' });
  assert.deepEqual(ids, ['a', 'b']);
});

test('single mode: the centre tab is the only visible one', () => {
  assert.deepEqual(visibleToastTabIds({ panes: [], effectiveTabId: 'a' }), ['a']);
  assert.deepEqual(visibleToastTabIds({ panes: [], effectiveTabId: null }), []);
});

test('empty placeholder panes contribute no tab', () => {
  const ids = visibleToastTabIds({ panes: [pane('a'), { projectId: '', tabId: '' }], effectiveTabId: 'a' });
  assert.deepEqual(ids, ['a']);
});

test('уведомление вкладки живёт в ЕЁ окне', () => {
  const visible = ['a', 'b'];
  assert.equal(resolveToastHostTabId({ tabId: 'a' }, visible), 'a');
  assert.equal(resolveToastHostTabId({ tabId: 'b' }, visible), 'b');
});

test('общее уведомление остаётся в углу приложения', () => {
  assert.equal(resolveToastHostTabId({}, ['a']), null);
  assert.equal(resolveToastHostTabId({ tabId: '' }, ['a']), null);
  assert.equal(isToastVisible({}, ['a']), true);
});

test('уведомление НЕВИДИМОЙ вкладки не показывается текстом нигде', () => {
  // Прежнее правило отправляло его в угол приложения. Плашка про работу,
  // которой не видно, вставала поверх окна, к которому не относится.
  assert.equal(resolveToastHostTabId({ tabId: 'zzz' }, ['a', 'b']), null);
  assert.equal(isToastVisible({ tabId: 'zzz' }, ['a', 'b']), false);
});

test('красным чип красят только ошибки', () => {
  assert.equal(isErrorToast({ type: 'error' }), true);
  assert.equal(isErrorToast({ type: 'warning' }), true);
  assert.equal(isErrorToast({ type: 'success' }), false);
  assert.equal(isErrorToast(null), false);
});

test('счётчик ошибок собирается по НЕВИДИМЫМ вкладкам', () => {
  const toasts = [
    { id: '1', tabId: 'hidden', type: 'error' },
    { id: '2', tabId: 'hidden', type: 'error' },
    { id: '3', tabId: 'hidden', type: 'success' },
    { id: '4', tabId: 'shown', type: 'error' },
    { id: '5', type: 'error' },
  ];
  const counts = hiddenToastOwnerCounts(toasts, ['shown']);
  assert.equal(counts.get('hidden'), 2, 'только ошибки, и только невидимой вкладки');
  assert.equal(counts.has('shown'), false, 'видимая показывает плашку, а не метку');
  assert.equal(counts.has(''), false, 'общее уведомление ничей чип не красит');
});

test('красная сумма счётчика ×N считается по тем же числам', () => {
  const counts = new Map([['a', 2], ['b', 1]]);
  assert.equal(hiddenToastCountForChips(counts, ['a', 'b']), 3);
  assert.equal(hiddenToastCountForChips(counts, ['a']), 2);
  assert.equal(hiddenToastCountForChips(counts, ['нет-такой']), 0);
  assert.equal(hiddenToastCountForChips(null, ['a']), 0);
});

test('показали вкладку — её уведомление возвращается в её окно, не дублируясь', () => {
  const toast = { id: '1', tabId: 'a', type: 'error' };
  // Пока не видно: текста нет, есть метка на чипе.
  assert.equal(isToastVisible(toast, ['b']), false);
  assert.equal(hiddenToastOwnerCounts([toast], ['b']).get('a'), 1);
  // Показали: текст в её окне, метки больше нет.
  assert.equal(isToastVisible(toast, ['a', 'b']), true);
  assert.equal(resolveToastHostTabId(toast, ['a', 'b']), 'a');
  assert.equal(hiddenToastOwnerCounts([toast], ['a', 'b']).size, 0);
});
