import test from 'node:test';
import assert from 'node:assert/strict';
import { beginComposerReturnPreparation as begin, finishComposerReturnPreparation as finish,
  composerReturnPreparationView as view } from './historyComposerReturnPreparation.mjs';

const owner = { tabId: 'A', sourceSessionId: 'sid', handoffId: 'H', token: 'T' };
test('real request is visible only to its exact tab/session', () => {
  const running = begin([], owner);
  assert.equal(view(running, 'A', 'sid').label, 'Возвращаю сообщение…');
  assert.equal(view(running, 'B', 'sid'), null);
  assert.equal(view(running, 'A', 'replacement'), null);
  assert.equal(view(finish(running, owner), 'A', 'sid'), null);
});
test('late old finally cannot clear a newer return or another tab', () => {
  const newer = { ...owner, token: 'new', handoffId: 'new-H' };
  const other = { ...owner, tabId: 'B' };
  const running = begin(begin(begin([], owner), newer), other);
  const after = finish(running, owner);
  assert.equal(view(after, 'A', 'sid').count, 1);
  assert.equal(view(after, 'B', 'sid').count, 1);
  assert.strictEqual(finish(after, owner), after);
});
test('overlapping returns remain represented when they settle out of order', () => {
  const next = { ...owner, handoffId: 'H2' };
  const running = begin(begin([], owner), next);
  assert.equal(view(running, 'A', 'sid').count, 2);
  assert.equal(view(finish(running, next), 'A', 'sid').count, 1);
});
test('status never retains or serializes the full authoring message', () => {
  const input = { ...owner };
  Object.defineProperty(input, 'text', { get() { throw Error('body read forbidden'); } });
  const running = begin([], input);
  assert.deepEqual(Object.keys(running[0]).sort(), ['handoffId', 'sourceSessionId', 'tabId', 'token']);
  assert.equal(JSON.stringify(running).includes('text'), false);
});
test('duplicate presentation does not create another operation or publish', () => {
  const running = begin([], owner);
  assert.strictEqual(begin(running, owner), running);
});
