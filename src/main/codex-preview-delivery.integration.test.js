'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderSemanticShadow } = require('./provider-semantic-shadow');
const { createTerminalHistoryPreviewController } = require('./terminal-history-preview-controller');

const tabId = 'preview-delivery-fixture';
const turnId = 'incident-turn';
const sourceId = 'launch-current';
const heldText = '0.8.29 уже в проде: CI успешен, версия в API и контейнере совпадает, файлы опубликованного ZIP сверены с локальной сборкой. Аккаунт отправителя и личный чат Миши проверены. Отправляю ему одно сообщение с просьбой обновиться и повторить проверку.';

function harness() {
  const events = [], emitted = [], logs = [], timers = new Map();
  let timerSeq = 0;
  let context = { terminal: {}, mirror: { generation: 'mirror', generationOrdinal: 1 }, lifecycleGeneration: 'run:1' };
  const log = { log: s => logs.push(s), warn: s => logs.push(s) };
  const controller = createTerminalHistoryPreviewController({
    getContext: () => context, readFrame: () => ({ status: 'unknown' }),
    emit: detail => emitted.push(detail), log,
    setTimer: fn => { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
  });
  controller.activateSemanticSource({ tabId, instanceId: sourceId });
  const shadow = createProviderSemanticShadow({ log, onCodexSemanticEvent: detail => {
    events.push(detail.event);
    controller.observeSemanticEvent({ tabId, instanceId: detail.sourceId, event: detail.event });
  } });
  const connection = (options = {}) => shadow.createCodexConnection({ tabId, sourceId, ...options });
  const start = (conn, turn = turnId) => conn.beginRequest({ turn_id: turn, thread_id: 'provider-thread' });
  const frame = (conn, payload) => conn.observeServerFrame(JSON.stringify(payload));
  const done = (conn, itemId, text, responseId) => {
    frame(conn, { type: 'response.created', response: { id: responseId } });
    frame(conn, { type: 'response.output_text.done', response_id: responseId, item_id: itemId, text });
    frame(conn, { type: 'response.completed', response: { id: responseId, output: [] } });
  };
  const flush = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  let offset = 100;
  const canonical = (itemId, text) => controller.observeCanonical({
    tabId, provider: 'codex', sessionId: 'physical-rollout-owner',
    identity: 'codex-assistant-source-physical-rollout-owner-' + (offset += 100),
    sourceEndOffset: offset + 99, semanticItemId: itemId, canonicalText: text,
  });
  return { controller, events, emitted, logs, connection, start, frame, done, flush, canonical,
    replaceLifecycle: () => { context = { ...context, lifecycleGeneration: 'run:2' }; } };
}

test('completed response followed by close1006 reports delivery uncertainty exactly once', () => {
  const h = harness(), c = h.connection();
  const request = h.start(c);
  h.done(c, 'held-291', heldText, 'response-291');
  c.finishAll('client-close:1006');
  c.finishAll('upstream-close:1006');
  const unknown = h.events.filter(e => e.type === 'request_delivery_unknown');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].requestId, request.requestId);
  assert.deepEqual(unknown[0].itemIds, ['held-291']);
  assert.equal(h.events.some(e => e.type === 'request_failed'), false,
    'closed transport is not proof that the completed text was rejected');
  h.flush();
  assert.equal(h.controller.get(tabId).text, heldText);
  assert.equal(h.controller.get(tabId).responseSegments[0].deliveryState, 'unknown');
  assert.match(h.logs.join('\n'), /DELIVERY_UNKNOWN .*reason=client-close:1006/);
});

test('captured five-item sequence preserves245chars separately from newer live work and late exact adoption', () => {
  const h = harness(), first = h.connection();
  h.start(first);
  h.done(first, 'saved-279', 'a'.repeat(142), 'response-279');
  h.flush(); h.canonical('saved-279', 'a'.repeat(142));
  h.start(first);
  h.done(first, 'held-291', heldText, 'response-291');
  first.finishAll('client-close:1006');
  const next = h.connection(); h.start(next);
  h.frame(next, { type: 'response.created', response: { id: 'response-293' } });
  h.frame(next, { type: 'response.output_text.delta', response_id: 'response-293', item_id: 'saved-293', delta: 'b'.repeat(255) });
  h.flush();
  const segments = h.controller.get(tabId).responseSegments;
  assert.deepEqual(segments.map(s => [s.itemId, s.phase]), [
    ['held-291', 'settled'], ['saved-293', 'streaming'],
  ]);
  h.done(next, 'saved-293', 'b'.repeat(255), 'response-293');
  h.canonical('saved-293', 'b'.repeat(255));
  for (const [id, size] of [['saved-303', 215], ['saved-311', 381]]) {
    h.start(next); h.done(next, id, id[0].repeat(size), 'response-' + id);
    h.flush(); h.canonical(id, id[0].repeat(size));
  }
  h.controller.finish({ tabId, provider: 'codex', turnId, reason: 'task_complete' });
  h.flush();
  const held = h.controller.get(tabId);
  assert.equal(held.phase, 'settled');
  assert.equal(held.text.length, 245);
  assert.equal(held.text, heldText);
  assert.equal(h.emitted.some(e => e.action === 'clear' && e.reason === 'semantic-request-failed'), false);
  assert.equal(h.controller.getDiagnosticState(tabId).semanticItems.filter(i => i.materialized).length, 4);
  // The later255char answer, even with the same prose, cannot adopt another ID.
  assert.equal(h.canonical('foreign-item', heldText), false);
  assert.equal(h.controller.get(tabId).text, heldText);
  const clears = h.emitted.filter(e => e.action === 'clear').length;
  assert.equal(h.canonical('held-291', heldText), true);
  assert.equal(h.controller.get(tabId), null);
  assert.equal(h.emitted.filter(e => e.action === 'clear').length, clears + 1);
  assert.equal(h.canonical('held-291', heldText), false);
  assert.equal(h.emitted.filter(e => e.action === 'clear').length, clears + 1);
});

test('failed or cancelled segment preserves completed unconfirmed text but retracts its open partial', () => {
  for (const reason of ['response.failed', 'client-close:1000']) {
    const h = harness(), c = h.connection(); h.start(c);
    h.frame(c, { type: 'response.output_text.done', item_id: 'complete', text: heldText });
    h.frame(c, { type: 'response.output_text.delta', item_id: 'partial', delta: 'open partial' });
    c.finishAll(reason); h.flush();
    assert.equal(h.controller.get(tabId).text, heldText);
    assert.equal(h.controller.get(tabId).responseSegments[0].deliveryState, 'unknown');
    assert.equal(h.canonical('complete', heldText), true);
  }
});

test('late bytes and close from a previous turn or lifecycle cannot change a new preview', () => {
  const h = harness(), old = h.connection(); h.start(old);
  h.done(old, 'old-item', heldText, 'old-response');
  const next = h.connection(); h.start(next, 'new-turn');
  h.frame(next, { type: 'response.output_text.delta', item_id: 'new-item', delta: 'new text' });
  h.flush(); const before = h.controller.get(tabId);
  old.finishAll('client-close:1006');
  h.frame(old, { type: 'response.output_text.delta', response_id: 'old-response', item_id: 'old-item', delta: 'stale' });
  h.flush();
  assert.deepEqual(h.controller.get(tabId), before);
  h.replaceLifecycle();
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId,
    event: { type: 'request_delivery_unknown', turnId: 'new-turn', requestId: 'any', reason: 'old-owner' } }), false);
});

test('normal HTTP end after response.completed is not an uncertain transport failure', () => {
  const h = harness(), c = h.connection(); h.start(c);
  h.done(c, 'http-item', heldText, 'http-response'); c.finishAll('response-end');
  assert.equal(h.events.some(e => e.type === 'request_delivery_unknown'), false);
});

test('explicit foreign canonical item cannot adopt equal text before or after close1006', () => {
  for (const closeFirst of [false, true]) {
    const h = harness(), c = h.connection(); h.start(c);
    h.done(c, 'actual-item', heldText, 'actual-response'); h.flush();
    if (closeFirst) c.finishAll('client-close:1006');
    assert.equal(h.canonical('foreign-item', heldText), false);
    if (!closeFirst) c.finishAll('client-close:1006');
    h.flush();
    assert.equal(h.controller.get(tabId).text, heldText);
    assert.equal(h.controller.get(tabId).responseSegments[0].deliveryState, 'unknown');
    assert.equal(h.canonical('actual-item', heldText), true);
    assert.equal(h.controller.get(tabId), null);
  }
});

test('legacy canonical without an item ID can still adopt completed text before transport uncertainty', () => {
  const h = harness(), c = h.connection(); h.start(c);
  h.done(c, 'legacy-item', heldText, 'legacy-response'); h.flush();
  assert.equal(h.canonical(null, heldText), true);
  assert.equal(h.controller.get(tabId), null);
});

test('foreign responseId cannot become the current request and settled-turn bytes cannot revive it', () => {
  const h = harness(), c = h.connection(); h.start(c);
  h.done(c, 'held', heldText, 'completed-response'); h.flush();
  h.controller.finish({ tabId, provider: 'codex', turnId });
  const before = h.controller.get(tabId);
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId, event: {
    type: 'assistant_delta', turnId, threadId: 'provider-thread', itemId: 'held', delta: 'stale',
  } }), false);
  h.flush(); assert.deepEqual(h.controller.get(tabId), before);
  h.start(c, 'new-turn');
  h.frame(c, { type: 'response.created', response: { id: 'current-response' } });
  assert.equal(h.frame(c, { type: 'response.output_text.delta', response_id: 'unknown-response', item_id: 'foreign', delta: 'wrong' }), false);
  assert.deepEqual(h.controller.get(tabId), before, 'turn-start metadata alone is not new assistant output');
  h.frame(c, { type: 'response.output_text.delta', response_id: 'current-response', item_id: 'current', delta: 'correct' });
  h.flush(); assert.equal(h.controller.get(tabId).text, 'correct');
});

test('request_delivery_unknown for another thread cannot change exact current-turn items', () => {
  const h = harness(), c = h.connection(), request = h.start(c);
  h.done(c, 'held', heldText, 'response'); h.flush();
  const before = h.controller.get(tabId);
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId, event: {
    type: 'request_delivery_unknown', turnId, threadId: 'foreign-thread', requestId: request.requestId,
    reason: 'client-close:1006',
  } }), false);
  assert.deepEqual(h.controller.get(tabId), before);
});

test('closing an older completed request cannot repair a gap in the newer request', () => {
  const h = harness(), old = h.connection(); h.start(old);
  h.done(old, 'old-complete', heldText, 'old-response');
  const next = h.connection(), request = h.start(next);
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId, gap: true,
    event: { type: 'assistant_delta', turnId, threadId: 'provider-thread',
      requestId: request.requestId, itemId: 'new-gap', delta: 'partial-after-gap' } }), false);
  old.finishAll('client-close:1006');
  assert.equal(h.controller.getDiagnosticState(tabId).semanticGap, true);
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId,
    event: { type: 'assistant_delta', turnId, threadId: 'provider-thread',
      requestId: request.requestId, itemId: 'new-gap', delta: 'still-incomplete' } }), false);
  h.frame(next, { type: 'response.output_text.done', item_id: 'new-gap', text: 'exact completed replacement' });
  h.flush(); assert.equal(h.controller.getDiagnosticState(tabId).semanticGap, false);
  assert.equal(h.controller.get(tabId).responseSegments[1].text, 'exact completed replacement');
});

const partial4196 = 'Скачок после сворачивания исправлен в исходнике:';
const incomplete = (responseId, reason = 'interrupted') => ({
  type: 'response.incomplete', response: { id: responseId, status: 'incomplete',
    incomplete_details: { reason },
    output: [{ id: 'partial-3660', type: 'message', status: 'incomplete',
      content: [{ type: 'output_text', text: partial4196 }] }],
  },
});
const open4196 = (h, c, responseId = 'response-3660') => {
  const request = h.start(c);
  h.frame(c, { type: 'response.created', response: { id: responseId } });
  h.frame(c, { type: 'response.output_text.delta', response_id: responseId,
    item_id: 'partial-3660', delta: partial4196 });
  h.flush();
  return request;
};

test('native same-turn steering retracts incomplete48 only after the exact server boundary', () => {
  const h = harness(), c = h.connection(), request = open4196(h, c);
  assert.equal(partial4196.length, 48);
  assert.equal(c.observeClientFrame(JSON.stringify({ type: 'response.interrupt',
    response_id: 'response-3660', mode: 'discard_partial_items' })), true);
  h.flush();
  assert.equal(h.controller.get(tabId).text, partial4196, 'client intent is not server acceptance');
  assert.equal(h.frame(c, incomplete('response-3660')), true);
  h.flush();
  assert.equal(h.controller.get(tabId), null);
  assert.equal(h.events.find(e => e.type === 'request_failed').requestId, request.requestId);
  assert.match(h.logs.join('\n'), /INTERRUPT_REQUEST .*mode=discard_partial_items/);
  assert.match(h.logs.join('\n'), /RESPONSE_END .*reason=response-incomplete:interrupted/);
  assert.equal(h.events.some(e => e.type === 'turn_completed'), false,
    'interrupting a segment is not completing the whole turn');
  h.start(c); h.done(c, 'final-3670', 'f'.repeat(672), 'response-3670'); h.flush();
  assert.equal(h.controller.get(tabId).text.length, 672);
  assert.equal(h.canonical('final-3670', 'f'.repeat(672)), true);
  h.controller.finish({ tabId, provider: 'codex', turnId, reason: 'task_complete' }); h.flush();
  assert.equal(h.controller.get(tabId), null, 'no orphan48 after final exact adoption');
  assert.equal(h.events.filter(e => e.type === 'request_failed').length, 1);
  assert.equal(h.frame(c, incomplete('response-3660')), false, 'late duplicate has no authority');
});

test('an incomplete segment preserves completed unconfirmed245 but never recovers its partial output', () => {
  const h = harness(), c = h.connection(); h.start(c);
  h.frame(c, { type: 'response.created', response: { id: 'mixed-response' } });
  h.frame(c, { type: 'response.output_text.done', response_id: 'mixed-response',
    item_id: 'complete-245', text: heldText });
  h.frame(c, { type: 'response.output_text.delta', response_id: 'mixed-response',
    item_id: 'partial-3660', delta: partial4196 }); h.flush();
  assert.equal(h.frame(c, incomplete('mixed-response')), true); h.flush();
  const preview = h.controller.get(tabId);
  assert.equal(preview.text, heldText);
  assert.deepEqual(preview.responseSegments.map(s => [s.itemId, s.deliveryState]), [['complete-245', 'unknown']]);
  assert.equal(h.controller.getDiagnosticState(tabId).semanticItems.some(i => i.itemId === 'partial-3660'), false);
  assert.equal(h.canonical('foreign-item', heldText), false);
  assert.equal(h.canonical('complete-245', heldText), true);
  assert.equal(h.controller.get(tabId), null);
});

test('incomplete boundary is exact-response scoped while the next request is already streaming', () => {
  const h = harness(), c = h.connection(); open4196(h, c);
  h.start(c);
  h.frame(c, { type: 'response.created', response: { id: 'next-response' } });
  h.frame(c, { type: 'response.output_text.delta', response_id: 'next-response',
    item_id: 'next-item', delta: 'next live' }); h.flush();
  const before = h.controller.get(tabId);
  assert.equal(h.frame(c, incomplete('foreign-response')), false);
  const noId = incomplete(undefined);
  assert.equal(h.frame(c, noId), false);
  assert.equal(h.frame(c, { ...incomplete('response-3660'), response_id: 'next-response' }), false,
    'contradictory envelope/response IDs cannot retract the current segment');
  assert.deepEqual(h.controller.get(tabId), before);
  assert.equal(h.frame(c, incomplete('response-3660')), true); h.flush();
  assert.equal(h.controller.get(tabId).text, 'next live');
  assert.equal(h.controller.get(tabId).responseSegments[0].phase, 'streaming');
  assert.equal(h.frame(c, { type: 'response.output_text.delta', response_id: 'response-3660',
    item_id: 'partial-3660', delta: 'late' }), false);
  assert.match(h.logs.join('\n'), /BOUNDARY_IGNORED .*reason=missing-response-id/);
});

test('HTTP SSE incomplete uses the same request boundary for interrupted and limit outcomes', () => {
  for (const reason of ['interrupted', 'max_output_tokens', 'content_filter']) {
    const h = harness(), c = h.connection({ transport: 'http' });
    const request = c.observeHttpRequest(JSON.stringify({ turn_id: turnId, thread_id: 'provider-thread' }));
    c.observeHttpEvent(request, { event: 'response.created', data: JSON.stringify({ response: { id: 'http-response' } }) });
    c.observeHttpEvent(request, { event: 'response.output_text.delta', data: JSON.stringify({
      response_id: 'http-response', item_id: 'partial-3660', delta: partial4196,
    }) }); h.flush();
    const payload = incomplete('http-response', reason); delete payload.type;
    assert.equal(c.observeHttpEvent(request, { event: 'response.incomplete', data: JSON.stringify(payload) }), true);
    h.flush(); assert.equal(h.controller.get(tabId), null);
    assert.equal(h.events.filter(e => e.type === 'request_failed').length, 1);
    assert.match(h.logs.join('\n'), new RegExp('reason=response-incomplete:' + reason));
    assert.equal(c.finishAll('response-end'), 0);
  }
});

test('a new request alone cannot retract open text or invent an incomplete boundary', () => {
  const h = harness(), c = h.connection(); open4196(h, c);
  h.start(c); h.flush();
  assert.equal(h.controller.get(tabId).text, partial4196);
  assert.equal(h.events.some(e => e.type === 'request_failed'), false);
  assert.match(h.logs.join('\n'), /OPEN_REQUEST_ON_NEXT/);
});

test('late incomplete of an older open segment cannot repair the newer segment gap', () => {
  const h = harness(), c = h.connection(); open4196(h, c);
  const next = h.start(c);
  h.frame(c, { type: 'response.created', response: { id: 'new-gap-response' } });
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId, gap: true,
    event: { type: 'assistant_delta', turnId, threadId: 'provider-thread',
      requestId: next.requestId, itemId: 'new-gap-item', delta: 'incomplete-after-gap' } }), false);
  assert.equal(h.frame(c, incomplete('response-3660')), true);
  assert.equal(h.controller.getDiagnosticState(tabId).semanticGap, true);
  assert.equal(h.controller.observeSemanticEvent({ tabId, instanceId: sourceId,
    event: { type: 'assistant_delta', turnId, threadId: 'provider-thread',
      requestId: next.requestId, itemId: 'new-gap-item', delta: 'still-not-complete' } }), false);
  h.frame(c, { type: 'response.output_text.done', response_id: 'new-gap-response',
    item_id: 'new-gap-item', text: 'Full exact new item after gap' }); h.flush();
  assert.equal(h.controller.getDiagnosticState(tabId).semanticGap, false);
  assert.equal(h.controller.get(tabId).text, 'Full exact new item after gap');
});

test('client interrupt is exact-response intent, not an implicit current-request clear', () => {
  const h = harness(), c = h.connection(); open4196(h, c);
  const before = h.controller.get(tabId);
  for (const response_id of [undefined, 'foreign-response']) {
    assert.equal(c.observeClientFrame(JSON.stringify({ type: 'response.interrupt',
      response_id, mode: 'discard_partial_items' })), false);
  }
  assert.deepEqual(h.controller.get(tabId), before);
  assert.equal(h.events.some(e => e.type === 'request_failed'), false);
});
