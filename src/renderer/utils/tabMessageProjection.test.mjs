import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { nextRequestSuccessExpiry, REQUEST_SUCCESS_VISIBLE_MS } from './requestTrackerVisibility.mjs';

const compiled = { exports: {} };
const output = buildSync({ entryPoints: [new URL('./tabMessageProjection.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
new Function('module', 'exports', output)(compiled, compiled.exports);
const { mergeTabMessages: merge, tabMessageThreads: threads, tabMessageDelivery: delivery, tabMessageQuestionLabel: label } = compiled.exports;
const question = (patch = {}) => ({ messageId: 'q1', kind: 'question', sourceTabId: 'a', sourceProjectId: 'pa', sourceSessionId: 'sa', targetTabId: 'b', targetProjectId: 'pb', targetSessionId: 'sb', deliveryState: 'sent', createdAt: 10, updatedAt: 20, ...patch });
const reply = (patch = {}) => question({ messageId: 'r1', kind: 'reply', replyTo: 'q1', sourceTabId: 'b', targetTabId: 'a', ...patch });

test('confirmed question and reply leave the live tracker after four seconds, not History', () => {
  const { tabMessageSuccessAt, tabMessageVisibleInTracker } = compiled.exports;
  const index = merge({}, [question(), reply({ updatedAt: 1000 })]);
  for (const tabId of ['a', 'b']) {
    const [thread] = threads(index, tabId);
    assert.equal(tabMessageSuccessAt(thread), 1000);
    assert.equal(tabMessageVisibleInTracker(thread, tabId, 4999), true);
    assert.equal(tabMessageVisibleInTracker(thread, tabId, 5000), false);
    assert.equal(threads(index, tabId).length, 1);
    assert.equal(thread.question.sourceDismissedAt, undefined);
  }
  assert.equal(REQUEST_SUCCESS_VISIBLE_MS, 4000);
});

test('pending, missing and failed reply never disappear as a success', () => {
  const { tabMessageSuccessAt, tabMessageVisibleInTracker, tabMessagePresentation } = compiled.exports;
  for (const deliveryState of ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed']) {
    const [thread] = threads(merge({}, [question(), reply({ deliveryState })]), 'a');
    assert.equal(tabMessageSuccessAt(thread), null);
    assert.equal(tabMessageVisibleInTracker(thread, 'a', 100000), true);
    assert.equal(tabMessagePresentation(thread).icon, delivery(thread.reply).icon);
  }
  for (const input of [[question()], [question({ replyMessageId: 'r1', answeredAt: 30 })],
    [question({ deliveryState: 'unconfirmed' }), reply()]]) {
    const [thread] = threads(merge({}, input), 'a');
    assert.equal(tabMessageSuccessAt(thread), null);
    assert.equal(tabMessageVisibleInTracker(thread, 'a', 100000), true);
  }
});

test('other participant dismissal and late body hydration do not revive completed messages', () => {
  const { tabMessageSuccessAt, tabMessageVisibleInTracker } = compiled.exports;
  let index = merge({}, [question({ updatedAt: 100 }), reply({ updatedAt: '2026-10-04T18:00:00Z' })]);
  const completedAt = Date.parse('2026-10-04T18:00:00Z');
  index = merge(index, [question({ updatedAt: completedAt + 10000, targetDismissedAt: completedAt + 10000 }),
    reply({ updatedAt: 200, text: 'late full body' })]);
  const [thread] = threads(index, 'a');
  assert.equal(tabMessageSuccessAt(thread), completedAt);
  assert.equal(tabMessageVisibleInTracker(thread, 'a', completedAt + 10001), false);
  assert.equal(thread.reply.text, 'late full body');
});

test('success timer advances to every next expiry, including message-only updates', () => {
  assert.equal(nextRequestSuccessExpiry([1000, 2000, null, undefined, NaN], 3000), 5000);
  assert.equal(nextRequestSuccessExpiry([1000, 2000], 5020), 6000);
  assert.equal(nextRequestSuccessExpiry([1000, 2000], 6020), null);
  assert.equal(nextRequestSuccessExpiry([0, null, -10], 0), null);
});

test('dismissal stays per participant and does not erase history or a failed reply', () => {
  const { tabMessageDismissed, tabMessageReplyPresentation, tabMessagePeer } = compiled.exports;
  let state = merge({}, [question({ sourceDismissedAt: 30, updatedAt: 30 })]);
  state = merge(state, [question({ sourceDismissedAt: null, updatedAt: 40, replyMessageId: 'r1' }), reply({ deliveryState: 'failed' })]);
  const [sent] = threads(state, 'a');
  const [received] = threads(state, 'b');
  assert.equal(tabMessageDismissed(sent.question, 'a'), true);
  assert.equal(tabMessageDismissed(received.question, 'b'), false);
  assert.equal(tabMessageReplyPresentation(sent).icon, 'error');
  assert.equal(tabMessagePeer(sent).sourceTabId, 'b');
  assert.equal(tabMessagePeer(received).sourceTabId, 'a');
  assert.equal(threads(state, 'a').length, 1, 'hidden still belongs to shared history');
});

test('two stages keep answer delivery distinct without treating saved text as received', () => {
  const { tabMessageReplyPresentation } = compiled.exports;
  const [waiting] = threads(merge({}, [question()]), 'a');
  assert.equal(tabMessageReplyPresentation(waiting).label, 'Ожидает ответа');
  const [saved] = threads(merge({}, [question({ replyMessageId: 'r1' })]), 'a');
  assert.notEqual(tabMessageReplyPresentation(saved).icon, 'delivered');
  for (const deliveryState of ['queued', 'unconfirmed', 'waiting-for-input', 'failed', 'sent']) {
    const [thread] = threads(merge({}, [question(), reply({ deliveryState })]), 'a');
    assert.deepEqual(tabMessageReplyPresentation(thread), delivery(thread.reply));
  }
});

test('answer existence survives reverse delivery failure without changing question delivery', () => {
  const [thread] = threads(merge({}, [question(), reply({ deliveryState: 'failed', error: 'draft conflict' })]), 'a');
  assert.equal(thread.answerAvailable, true);
  assert.equal(thread.question.deliveryState, 'sent');
  assert.equal(delivery(thread.question).icon, 'delivered');
  assert.equal(delivery(thread.reply).icon, 'error');
  assert.equal(thread.reply.error, 'draft conflict');
  assert.equal(label(thread.question, thread.answerAvailable), 'Доставлено');
});

test('same tabs and reversed reply order remain two addressed questions', () => {
  const rows = threads(merge({}, [question(), question({ messageId: 'q2', createdAt: 11 }), reply({ messageId: 'r2', replyTo: 'q2' }), reply()]), 'a');
  assert.deepEqual(rows.map(t => [t.question.messageId, t.reply.messageId]), [['q2', 'r2'], ['q1', 'r1']]);
  assert.equal(rows.every(t => t.incoming === false), true);
  assert.equal(threads(merge({}, rows.flatMap(t => [t.question, t.reply])), 'b').every(t => t.incoming), true);
  assert.deepEqual(threads(merge({}, [question()]), 'unrelated'), []);
});

test('queued is static waiting and sent is delivered waiting for an answer', () => {
  for (const deliveryState of ['queued', 'pending', 'sent', 'waiting-for-input', 'unconfirmed', 'failed']) {
    assert.equal(delivery(question({ deliveryState })).spinning, false);
  }
  assert.equal(delivery(question({ deliveryState: 'queued' })).icon, 'waiting');
  assert.equal(delivery(question({ deliveryState: 'sending' })).spinning, true);
  assert.equal(label(question(), false), 'Доставлено · ждёт ответа');
});

test('old list/event after get never rolls back status, reply association, error or exact text', () => {
  const full = question({ updatedAt: 40, replyMessageId: 'r1', answeredAt: 39, text: '  Exact\n\nquestion  ' });
  const index = merge({}, [full, reply({ updatedAt: 50, deliveryState: 'failed', text: 'Exact answer', error: 'reverse failure' })]);
  const after = merge(index, [question({ deliveryState: 'queued', updatedAt: 19, text: 'stale' }), reply({ deliveryState: 'pending', updatedAt: 20, error: null })]);
  assert.deepEqual(after, index);
  assert.equal(index.q1.text, full.text);
  assert.equal(threads(after, 'a')[0].answerAvailable, true);
});

test('late full body fills metadata-only newer event without reverting it; metadata preserves loaded body', () => {
  let index = merge({}, [question({ updatedAt: 50, deliveryState: 'failed', error: 'new failure' })]);
  index = merge(index, [question({ updatedAt: 30, text: 'immutable body' })]);
  assert.equal(index.q1.updatedAt, 50);
  assert.equal(index.q1.deliveryState, 'failed');
  assert.equal(index.q1.error, 'new failure');
  assert.equal(index.q1.text, 'immutable body');
  index = merge(index, [question({ updatedAt: 60, error: null })]);
  assert.equal(index.q1.text, 'immutable body');
  assert.equal(index.q1.error, null);
});

test('reply link cannot attach another question answer, even if messageId was supplied', () => {
  const [thread] = threads(merge({}, [question({ replyMessageId: 'r1' }), reply({ replyTo: 'q2' })]), 'a');
  assert.equal(thread.answerAvailable, true);
  assert.equal(thread.reply, undefined);
});

test('read results merge with concurrent event additions instead of replacing the list', () => {
  const index = merge(merge({}, [question({ messageId: 'q2' })]), [question()]);
  assert.equal(threads(index, 'a').length, 2);
  assert.deepEqual(merge(index, []), index);
});

test('actual ISO timestamps sort chronologically and compare with numeric get/event timestamps', () => {
  const old = '2026-10-03T09:00:00.000Z';
  const recent = '2026-10-03T09:00:01.000Z';
  const current = question({ createdAt: recent, updatedAt: recent, deliveryState: 'sent', textPreview: 'first words', textChars: 812 });
  const index = merge(merge({}, [current, question({ messageId: 'q2', createdAt: old, updatedAt: old })]), [question({ createdAt: old, updatedAt: Date.parse(old), deliveryState: 'queued' })]);
  assert.deepEqual(threads(index, 'a').map(t => t.question.messageId), ['q1', 'q2']);
  assert.equal(index.q1.deliveryState, 'sent');
  assert.equal(index.q1.updatedAt, recent);
  assert.equal(index.q1.textPreview, 'first words');
  assert.equal(index.q1.text, undefined);
});

test('same-millisecond ISO events cannot regress delivery or erase answer; get can still hydrate text', () => {
  const stamp = '2026-10-03T10:12:13.123Z';
  const queued = question({ updatedAt: stamp, deliveryState: 'queued' });
  const answered = question({ updatedAt: stamp, deliveryState: 'sent', replyMessageId: 'r1', answeredAt: stamp });
  for (const order of [[queued, answered], [answered, queued]]) {
    let index = merge({}, order);
    index = merge(index, [question({ updatedAt: Date.parse(stamp), deliveryState: 'pending', replyMessageId: null, answeredAt: null, text: 'exact body' })]);
    assert.equal(index.q1.deliveryState, 'sent');
    assert.equal(index.q1.replyMessageId, 'r1');
    assert.equal(index.q1.answeredAt, stamp);
    assert.equal(index.q1.text, 'exact body');
  }
  const retry = merge(merge({}, [question({ updatedAt: stamp, deliveryState: 'failed' })]), [question({ updatedAt: '2026-10-03T10:12:13.124Z', deliveryState: 'sending' })]);
  assert.equal(retry.q1.deliveryState, 'sending');
});
