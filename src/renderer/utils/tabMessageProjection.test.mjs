import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { isRequestSuccessPresentation } from './requestTrackerVisibility.mjs';

const compiled = { exports: {} };
const output = buildSync({ entryPoints: [new URL('./tabMessageProjection.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
new Function('module', 'exports', output)(compiled, compiled.exports);
const { mergeTabMessages: merge, tabMessageThreads: threads, tabMessageDelivery: delivery, tabMessageQuestionLabel: label } = compiled.exports;
const question = (patch = {}) => ({ messageId: 'q1', kind: 'question', sourceTabId: 'a', sourceProjectId: 'pa', sourceSessionId: 'sa', targetTabId: 'b', targetProjectId: 'pb', targetSessionId: 'sb', deliveryState: 'sent', createdAt: 10, updatedAt: 20, ...patch });
const reply = (patch = {}) => question({ messageId: 'r1', kind: 'reply', replyTo: 'q1', sourceTabId: 'b', targetTabId: 'a', ...patch });

test('wait outcome revision is independent of delivery/body clocks and late hydration cannot erase it', () => {
  let index = merge({}, [question({ loopWait: { revision: 3, state: 'returning', disposition: 'reply_timeout', notice: { state: 'pending' } } })]);
  index = merge(index, [question({ updatedAt: 100, text: 'full body' })]);
  assert.equal(index.q1.loopWait.revision, 3);
  index = merge(index, [question({ updatedAt: 10, loopWait: { revision: 4, state: 'settled' } })]);
  assert.equal(index.q1.loopWait.state, 'settled'); assert.equal(index.q1.updatedAt, 100);
  assert.equal(index.q1.text, 'full body');
});
test('saved timeout is source-only attention; delivered return is complete regardless of the own turn', () => {
  const { tabMessageReplyPresentation, tabMessageVisibleInTracker } = compiled.exports;
  const q = question({ loopWait: { revision: 1, state: 'returning', disposition: 'reply_timeout', notice: { state: 'pending' } } });
  const [source] = threads(merge({}, [q]), 'a'), [target] = threads(merge({}, [q]), 'b');
  assert.equal(tabMessageReplyPresentation(source).icon, 'error'); assert.match(tabMessageReplyPresentation(source).label, /Срок ответа/);
  assert.equal(tabMessageReplyPresentation(target).icon, 'waiting');
  const [processing] = threads(merge({}, [question({ loopWait: { revision: 2, state: 'returning' } }), reply()]), 'a');
  assert.equal(tabMessageVisibleInTracker(processing, 'a'), false);
  assert.match(tabMessageReplyPresentation(processing).label, /Ответ доставлен/);
  const [handled] = threads(merge({}, [question({ loopWait: { revision: 3, state: 'settled' } }), reply()]), 'a');
  assert.equal(tabMessageVisibleInTracker(handled, 'a'), false);
});
test('a received reply with an obsolete processing wait stays delivered, including metadata-only hydration', () => {
  const { tabMessageReplyPresentation, tabMessageVisibleInTracker } = compiled.exports;
  const q = question({ replyMessageId: 'r1', loopWait: { revision: 2, state: 'returning',
    disposition: 'reply_processing_timeout', replyDeliveryState: 'sent', notice: { state: 'sent' },
    pendingReturn: { kind: 'reply', reason: 'return_source_changed' } } });
  for (const index of [merge({}, [q, reply()]), merge({}, [q])]) {
    const [thread] = threads(index, 'a'), presentation = tabMessageReplyPresentation(thread);
    assert.equal(presentation.icon, 'delivered'); assert.match(presentation.label, /Ответ доставлен/);
    assert.equal(tabMessageVisibleInTracker(thread, 'a'), false);
    assert.equal(presentation.color, '#4ade80');
  }
});
test('an obsolete processing timeout does not override the confirmed delivery of a Reply', () => {
  const { tabMessageReplyPresentation, tabMessageVisibleInTracker, tabMessageSuccessAt } = compiled.exports;
  const q = question({ loopWait: { revision: 5, state: 'settled', disposition: 'reply_processing_timeout',
    notice: { state: 'sent' }, noticeProcessed: { natural: true }, replyDeliveryState: 'sent' } });
  const [thread] = threads(merge({}, [q, reply()]), 'a');
  const presentation = tabMessageReplyPresentation(thread);
  assert.match(presentation.label, /Ответ доставлен/);
  assert.equal(presentation.icon, 'delivered'); assert.equal(tabMessageSuccessAt(thread), 20);
  assert.equal(tabMessageVisibleInTracker(thread, 'a'), false, 'old processing metadata cannot revive a completed exchange');
  const [handled] = threads(merge({}, [{ ...q, loopWait: { ...q.loopWait, replyProcessed: { natural: true } } }, reply()]), 'a');
  assert.equal(tabMessageReplyPresentation(handled).icon, 'delivered');
  assert.equal(tabMessageVisibleInTracker(handled, 'a'), false);
});

test('normal waiting is gray, transport blue, confirmed green, attention yellow and failure red', () => {
  const expected = { pending:'#a1a1aa',queued:'#a1a1aa',sending:'#60a5fa',sent:'#4ade80',
    'waiting-for-input':'#fbbf24',unconfirmed:'#fbbf24',failed:'#f87171' };
  for (const [deliveryState,color] of Object.entries(expected)) assert.equal(delivery(question({deliveryState})).color,color);
});

test('confirmed question and reply leave the live tracker immediately, not History', () => {
  const { tabMessageSuccessAt, tabMessageVisibleInTracker } = compiled.exports;
  const index = merge({}, [question(), reply({ updatedAt: 1000 })]);
  for (const tabId of ['a', 'b']) {
    const [thread] = threads(index, tabId);
    assert.equal(tabMessageSuccessAt(thread), 1000);
    assert.equal(tabMessageVisibleInTracker(thread, tabId), false);
    assert.equal(threads(index, tabId).length, 1);
    assert.equal(thread.question.sourceDismissedAt, undefined);
  }
});

test('pending, missing and failed reply never disappear as a success', () => {
  const { tabMessageSuccessAt, tabMessageVisibleInTracker, tabMessagePresentation } = compiled.exports;
  for (const deliveryState of ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed']) {
    const [thread] = threads(merge({}, [question(), reply({ deliveryState })]), 'a');
    assert.equal(tabMessageSuccessAt(thread), null);
    assert.equal(tabMessageVisibleInTracker(thread, 'a'), true);
    assert.equal(tabMessagePresentation(thread).icon, delivery(thread.reply).icon);
  }
  for (const input of [[question()], [question({ replyMessageId: 'r1', answeredAt: 30 })],
    [question({ deliveryState: 'unconfirmed' }), reply()]]) {
    const [thread] = threads(merge({}, input), 'a');
    assert.equal(tabMessageSuccessAt(thread), null);
    assert.equal(tabMessageVisibleInTracker(thread, 'a'), true);
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
  assert.equal(tabMessageVisibleInTracker(thread, 'a'), false);
  assert.equal(thread.reply.text, 'late full body');
});

test('compact visibility uses the current presentation, not a completion timestamp', () => {
  assert.equal(isRequestSuccessPresentation({ icon: 'success', color: '#4ade80' }), true);
  assert.equal(isRequestSuccessPresentation({ icon: 'delivered', color: '#4ade80' }), true);
  assert.equal(isRequestSuccessPresentation({ icon: 'loading', color: '#4ade80' }), true);
  for (const color of ['#a78bfa', '#a1a1aa', '#60a5fa', '#fbbf24', '#f87171']) {
    assert.equal(isRequestSuccessPresentation({ icon: 'waiting', color }), false);
  }
  const { tabMessageVisibleInTracker } = compiled.exports;
  const [thread] = threads(merge({}, [question(), reply({ updatedAt: 0, createdAt: 0 })]), 'a');
  assert.equal(tabMessageVisibleInTracker(thread, 'a'), false);
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
    assert.deepEqual(tabMessageReplyPresentation(thread), { ...delivery(thread.reply),
      ...(deliveryState === 'sent' ? { label: 'Ответ доставлен' } : {}) });
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
test('full-contract: one explicit shared Reply hydrates all included questions, not adjacent unlisted questions', () => {
  const shared = reply({ messageId: 'shared', replyTo: 'q2', replyToIds: ['q2', 'q3'], updatedAt: 100 });
  const q2 = question({ messageId: 'q2', replyMessageId: 'shared' });
  const q3 = question({ messageId: 'q3', replyMessageId: 'shared', sourceDismissedAt: 30 });
  const index = merge({}, [question(), q2, q3, shared]);
  const rows = threads(index, 'a'), byId = new Map(rows.map(row => [row.question.messageId, row]));
  assert.equal(byId.get('q1').reply, undefined);
  assert.equal(byId.get('q2').reply.messageId, 'shared'); assert.equal(byId.get('q3').reply.messageId, 'shared');
  assert.equal(compiled.exports.tabMessageVisibleInTracker(byId.get('q3'), 'a'), false);
  assert.equal(threads(index, 'a').length, 3, 'History keeps all exact Q links');
  const stale = merge(index, [{ ...q3, updatedAt: 1, sourceDismissedAt: null }]);
  assert.ok(stale.q3.sourceDismissedAt, 'late hydration cannot resurrect local X');
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

test('empty and invalid batches preserve the exact index', () => {
  const empty = {};
  assert.strictEqual(merge(empty, []), empty);
  const index = merge({}, [question()]);
  assert.strictEqual(merge(index, []), index);
  assert.strictEqual(merge(index, [null, undefined, question({ messageId: '' }), question({ kind: 'unknown' })]), index);
});

test('serialized duplicate events preserve index and message identities including loopWait', () => {
  const index = merge({}, [question({ text: 'immutable', replyMessageId: 'r1', answeredAt: 19,
    loopWait: { revision: 3, state: 'settled', replyProcessed: { natural: true } } }), reply()]);
  const duplicate = structuredClone(index.q1);
  assert.notStrictEqual(duplicate, index.q1);
  assert.notStrictEqual(duplicate.loopWait, index.q1.loopWait);
  const after = merge(index, [duplicate, structuredClone(index.r1)]);
  assert.strictEqual(after.q1, index.q1);
  assert.strictEqual(after.r1, index.r1);
  assert.strictEqual(after, index);
});

test('true stale events with different delivery, body and error contribute no new identity', () => {
  const index = merge({}, [question({ updatedAt: 50, deliveryState: 'failed', error: 'current error',
    code: 'CURRENT', text: 'exact body', replyMessageId: 'r1', answeredAt: 49 }), reply()]);
  const stale = question({ updatedAt: 10, deliveryState: 'sending', error: null, code: null,
    text: 'different stale body', replyMessageId: 'wrong', answeredAt: 9, textPreview: 'old', textChars: 3 });
  const after = merge(index, [stale]);
  assert.deepEqual(after, index);
  assert.strictEqual(after.q1, index.q1);
  assert.strictEqual(after, index);
});

test('repeated cancelled receipts do not allocate a new index or revive delivery', () => {
  let index = merge({}, [question({ updatedAt: 50, deliveryState: 'unconfirmed', cancelledAt: 45,
    cancelledByTabId: 'a', sourceDismissedAt: 43, targetDismissedAt: 44 })]);
  const original = index;
  for (let i = 0; i < 7; i++) {
    index = merge(index, [question({ updatedAt: 50, deliveryState: 'unconfirmed', cancelledAt: null,
      cancelledByTabId: null, sourceDismissedAt: null, targetDismissedAt: null })]);
    assert.strictEqual(index.q1, original.q1);
    assert.strictEqual(index, original);
  }
});

test('same timestamp delivery upgrades change identity; all weaker or equal states retain it', () => {
  const states = ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed', 'sent'];
  let index = merge({}, [question({ deliveryState: states[0] })]);
  for (const [position, deliveryState] of states.entries()) {
    if (position) {
      const previous = index;
      index = merge(index, [question({ deliveryState })]);
      assert.notStrictEqual(index, previous);
      assert.notStrictEqual(index.q1, previous.q1);
      assert.equal(index.q1.deliveryState, deliveryState);
    }
    for (const weaker of states.slice(0, position + 1)) {
      assert.strictEqual(merge(index, [question({ deliveryState: weaker, error: 'ignored tie' })]), index);
    }
  }
});

test('strictly newer delivery and metadata remain accepted even when delivery becomes weaker', () => {
  for (const deliveryState of ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed', 'sent']) {
    const index = merge({}, [question({ error: 'old error', code: 'OLD', text: 'body' }), reply()]);
    const event = question({ updatedAt: 21, deliveryState, error: null, code: null,
      textPreview: 'new preview', textChars: 400, targetTabName: 'new name' });
    const after = merge(index, [event]);
    assert.notStrictEqual(after, index);
    assert.notStrictEqual(after.q1, index.q1);
    assert.strictEqual(after.r1, index.r1);
    assert.deepEqual(after.q1, { ...event, text: 'body' });
    assert.equal(index.q1.updatedAt, 20);
    assert.equal(index.q1.error, 'old error');
    assert.strictEqual(merge(after, [structuredClone(event)]), after);
  }
});

test('late body hydration changes only its row, including empty bodies, and later text is immutable', () => {
  for (const text of ['', '  Exact\nbody  ']) {
    const index = merge({}, [question({ updatedAt: 50, deliveryState: 'failed', error: 'failure' }), reply()]);
    const hydrated = merge(index, [question({ updatedAt: 10, deliveryState: 'pending', text })]);
    assert.notStrictEqual(hydrated, index);
    assert.notStrictEqual(hydrated.q1, index.q1);
    assert.strictEqual(hydrated.r1, index.r1);
    assert.deepEqual(hydrated.q1, { ...index.q1, text });
    assert.equal(index.q1.text, undefined);
    assert.strictEqual(merge(hydrated, [question({ updatedAt: 5, text: 'replacement' })]), hydrated);
    const newer = merge(hydrated, [question({ updatedAt: 60, text: 'replacement', error: null })]);
    assert.equal(newer.q1.text, text);
    assert.equal(newer.q1.error, null);
  }
});

test('stale answer and cancellation facts still mutate, then survive newer attempted clearing', () => {
  const cases = [
    { replyMessageId: 'r1' },
    { answeredAt: 9 },
    { replyMessageId: 'r1', answeredAt: 9 },
    { cancelledAt: 9, cancelledByTabId: 'b' },
    { cancelledAt: 9 },
  ];
  for (const fact of cases) {
    const index = merge({}, [question({ updatedAt: 50 }), reply()]);
    const after = merge(index, [question({ updatedAt: 10, ...fact })]);
    const expected = { ...index.q1, ...fact,
      ...(fact.cancelledAt ? { cancelledByTabId: fact.cancelledByTabId } : {}) };
    assert.notStrictEqual(after, index);
    assert.notStrictEqual(after.q1, index.q1);
    assert.strictEqual(after.r1, index.r1);
    assert.deepEqual(after.q1, expected);
    assert.strictEqual(merge(after, [question({ updatedAt: 10, ...fact })]), after);
    const cleared = merge(after, [question({ updatedAt: 60, ...Object.fromEntries(Object.keys(fact).map(key => [key, null])) })]);
    assert.deepEqual(cleared.q1, { ...expected, updatedAt: 60 });
  }
});

test('participant dismissals require accepted metadata and remain monotone independently', () => {
  const index = merge({}, [question({ updatedAt: 50 }), reply()]);
  assert.strictEqual(merge(index, [question({ updatedAt: 10, sourceDismissedAt: 9, targetDismissedAt: 9 })]), index);
  const source = merge(index, [question({ updatedAt: 60, sourceDismissedAt: 59 })]);
  const both = merge(source, [question({ updatedAt: 70, sourceDismissedAt: null, targetDismissedAt: 69 })]);
  assert.notStrictEqual(source.q1, index.q1);
  assert.notStrictEqual(both.q1, source.q1);
  assert.strictEqual(both.r1, index.r1);
  assert.deepEqual(both.q1, { ...index.q1, updatedAt: 70, sourceDismissedAt: 59, targetDismissedAt: 69 });
  const cleared = merge(both, [question({ updatedAt: 80, sourceDismissedAt: null, targetDismissedAt: null })]);
  assert.deepEqual(cleared.q1, { ...both.q1, updatedAt: 80 });
});

test('newer conflicting answer, cancellation and dismissal facts preserve the original values', () => {
  const facts = { replyMessageId: 'r1', answeredAt: 19, sourceDismissedAt: 18,
    targetDismissedAt: 17, cancelledAt: 16, cancelledByTabId: 'a' };
  const index = merge({}, [question(facts)]);
  const after = merge(index, [question({ updatedAt: 30, replyMessageId: 'other', answeredAt: 29,
    sourceDismissedAt: 28, targetDismissedAt: 27, cancelledAt: 26, cancelledByTabId: 'b' })]);
  assert.notStrictEqual(after, index);
  assert.deepEqual(after.q1, { ...index.q1, updatedAt: 30 });
  assert.strictEqual(merge(after, [question({ updatedAt: 10, replyMessageId: 'other', answeredAt: 9,
    sourceDismissedAt: 8, targetDismissedAt: 7, cancelledAt: 6, cancelledByTabId: 'b' })]), after);
});

test('loopWait uses its own revision and duplicate or older serialized waits retain identity', () => {
  const index = merge({}, [question({ updatedAt: 50, text: 'body',
    loopWait: { revision: 3, state: 'returning', notice: { state: 'pending' } } }), reply()]);
  for (const loopWait of [null, undefined, { revision: 2, state: 'settled' },
    { revision: 3, state: 'settled' }, structuredClone(index.q1.loopWait)]) {
    assert.strictEqual(merge(index, [question({ updatedAt: 10, loopWait })]), index);
    const newerMetadata = merge(index, [question({ updatedAt: 60, loopWait })]);
    assert.deepEqual(newerMetadata.q1, { ...index.q1, updatedAt: 60 });
    assert.strictEqual(newerMetadata.q1.loopWait, index.q1.loopWait);
  }
  const loopWait = { revision: 4, state: 'settled', replyProcessed: { natural: true } };
  const after = merge(index, [question({ updatedAt: 10, deliveryState: 'pending', loopWait })]);
  assert.notStrictEqual(after, index);
  assert.notStrictEqual(after.q1, index.q1);
  assert.strictEqual(after.r1, index.r1);
  assert.deepEqual(after.q1, { ...index.q1, loopWait });
  assert.strictEqual(merge(after, [question({ updatedAt: 10, loopWait: structuredClone(loopWait) })]), after);
  const later = merge(after, [question({ updatedAt: 60, loopWait: null })]);
  assert.deepEqual(later.q1, { ...after.q1, updatedAt: 60 });
});

test('newer explicit null or undefined metadata keeps its own-property and error semantics', () => {
  const index = merge({}, [question({ error: 'failure', code: 'OLD', sourceTabName: 'name' })]);
  const after = merge(index, [question({ updatedAt: 30, error: null, code: undefined, sourceTabName: null, loopWait: null })]);
  assert.deepEqual(after.q1, { ...index.q1, updatedAt: 30, error: null, code: undefined, sourceTabName: null, loopWait: null });
  assert.equal(Object.hasOwn(after.q1, 'code'), true);
  assert.equal(Object.hasOwn(index.q1, 'loopWait'), false);
  assert.strictEqual(merge(after, [structuredClone(after.q1)]), after);
});

test('mixed list/event batches preserve untouched rows and see earlier mutations in the same batch', () => {
  const index = merge({}, [question({ updatedAt: 50, text: 'body' }), reply(), question({ messageId: 'q2' })]);
  for (const row of Object.values(index)) Object.freeze(row);
  Object.freeze(index);
  const newQuestion = question({ messageId: 'q3', deliveryState: 'pending', updatedAt: 10 });
  const after = merge(index, [structuredClone(index.q1), question({ updatedAt: 10, deliveryState: 'pending' }),
    newQuestion, reply({ updatedAt: 30, error: 'new error' }),
    question({ messageId: 'q3', updatedAt: 10, deliveryState: 'sent' }),
    question({ messageId: 'q3', updatedAt: 5, text: 'late full body' }), null]);
  assert.notStrictEqual(after, index);
  assert.strictEqual(after.q1, index.q1);
  assert.strictEqual(after.q2, index.q2);
  assert.notStrictEqual(after.r1, index.r1);
  assert.deepEqual(after.r1, { ...index.r1, updatedAt: 30, error: 'new error' });
  assert.deepEqual(after.q3, { ...newQuestion, deliveryState: 'sent', text: 'late full body' });
  assert.equal(Object.hasOwn(index, 'q3'), false);
  assert.strictEqual(merge(after, [newQuestion, structuredClone(after.r1), question({ messageId: 'q3', updatedAt: 5, text: 'ignored' })]), after);
  assert.deepEqual(Object.keys(after), ['q1', 'r1', 'q2', 'q3'], 'partial list does not remove concurrent rows');
});
