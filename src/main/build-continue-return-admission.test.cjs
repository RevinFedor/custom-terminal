'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBuildContinueReturnAdmission } = require('./build-continue-return-admission');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = { kind: 'message', id: 'same-reply', tabId: 'worker', handoffId: 'reply-H', operationKey: 'reply-O', source: 'tab-message:same-reply' };
function fixture() {
  let state = { known: true, returns: [] }, release;
  const queued = new Map(), receipts = new Map(), calls = [], order = [];
  const admit = () => { const request = { tabId: ref.tabId, handoffId: ref.handoffId, source: ref.source };
    queued.set(ref.operationKey, { operation_key: ref.operationKey, tab_id: ref.tabId,
      request_hash: fingerprintAgentSendRequest(request), request_json: JSON.stringify(request) }); order.push('reply-reservation'); };
  const service = createBuildContinueReturnAdmission({ snapshot: () => JSON.parse(JSON.stringify(state)),
    readQueued: key => queued.get(key), readReceipt: key => receipts.get(key),
    reserve: async value => { calls.push(value); await new Promise(resolve => release = resolve); admit(); }, wake() {} });
  return { service, calls, order, queued, receipts, ready: () => state.returns = [ref], unknown: () => state.known = false,
    release: () => release(), admit };
}
test('ready reply reserves its exact prior H/O before continuation; overlapping wakes do not duplicate its producer', async () => {
  const h = fixture(); h.ready(); assert.equal((await h.service.prepare({}, {})).ready, false); await tick();
  assert.equal((await h.service.prepare({}, {})).ready, false); assert.equal(h.calls.length, 1);
  h.release(); await tick(); const gate = await h.service.prepare({}, {}); assert.equal(gate.ready, true); assert.equal(gate.isCurrent(), true);
  h.order.push('continue-reservation'); assert.deepEqual(h.order, ['reply-reservation', 'continue-reservation']);
});
test('a reply becoming ready across context preparation invalidates the old synchronous enqueue gate', async () => {
  const h = fixture(), before = await h.service.prepare({}, {});
  assert.equal(before.ready, true); h.ready(); assert.equal(before.isCurrent(), false);
  assert.equal((await h.service.prepare({}, {})).ready, false); await tick(); h.release(); await tick();
  assert.equal((await h.service.prepare({}, {})).isCurrent(), true);
});
test('UNKNOWN or missing authority never invokes a replacement return sender or permits Continue', async () => {
  const h = fixture(); h.ready(); h.receipts.set(ref.operationKey, { state: 'delivery-unknown', attemptId: 'old-attempt' });
  assert.equal((await h.service.prepare({}, {})).ready, false); await tick(); assert.equal(h.calls.length, 0);
  h.unknown(); assert.equal((await h.service.prepare({}, {})).ready, false); assert.equal(h.calls.length, 0);
});

test('unchanged unavailable return is attempted once per authority revision, without a self-waking retry loop', async () => {
  let calls = 0, wakes = 0, revision = 1;
  const service = createBuildContinueReturnAdmission({ snapshot: () => ({ known: true, returns: [ref], revision }),
    readQueued: () => null, readReceipt: () => null, reserve: async () => { calls++; }, wake: () => wakes++ });
  for (let i = 0; i < 12; i++) { assert.equal((await service.prepare({ id: 'same-operation' }, {})).ready, false); await tick(); }
  assert.equal(calls, 1); assert.equal(wakes, 1);
  revision++; await service.prepare({ id: 'same-operation' }, {}); await tick(); assert.equal(calls, 2);
  service.forget('same-operation');
});
