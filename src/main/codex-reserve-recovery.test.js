'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { codexReserveReturnChoice, captureCodexReserveReturnPreference,
  sameCodexReserveReturnChoice, planCodexReserveReturn, createCodexReserveAvailabilityProbe,
} = require('./codex-reserve-recovery');

const intent = { model: 'gpt-6-sol', effort: 'max', revision: 3,
  appliedRevision: 3, appliedOwnerId: 'S', actionSequence: 4 };
const model = { model: 'gpt-6-sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'max' }] };
function fixture({ allowed = true, models = [model], beforeUsage, fail, missing = false, responseAccount } = {}) {
  let auth = { accountId: 'A', userId: 'U', tokenFingerprint: 'T' }, time = 1000;
  let clients = 0, closed = 0;
  const requests = [];
  const probe = createCodexReserveAvailabilityProbe({ readAuth: () => auth, now: () => time,
    clientFactory: () => {
      clients++;
      if (fail === 'factory') throw Error('factory unavailable');
      return { start: async () => {}, close: () => closed++, request: async (method, params) => {
        requests.push({ method, params });
        if (fail === method) throw Error('network refused');
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'account/rateLimits/read') {
          await beforeUsage?.();
          return { accountId: responseAccount || 'A', ...(missing ? {} : { ordinaryUsageAllowed: allowed }) };
        }
        return { data: models, nextCursor: null };
      } };
    } });
  return { probe, requests, setAuth: value => { auth = value; }, setTime: value => { time = value; },
    get clients() { return clients; }, get closed() { return closed; } };
}

test('original user choice survives automatic Reserve; explicit Reserve and another source do not restore', () => {
  const chosen = codexReserveReturnChoice({ sessionId: 'S', intent });
  assert.equal(chosen.model, 'gpt-6-sol');
  assert.equal(codexReserveReturnChoice({ sessionId: 'other', intent }), null);
  assert.equal(codexReserveReturnChoice({ sessionId: 'S', intent: { ...intent, model: 'gpt-reserve' } }), null);
  assert.equal(codexReserveReturnChoice({ sessionId: 'S', intent: { ...intent, appliedRevision: 2 } }), null);
  assert.equal(sameCodexReserveReturnChoice(chosen, { ...chosen, actionSequence: 5 }), false);
});

test('fallback captures the previous per-session pair even without an explicit picker choice', () => {
  const preference = captureCodexReserveReturnPreference({ sessionId: 'S', observed: { model: 'gpt-6-astra', effort: 'high' } });
  assert.equal(codexReserveReturnChoice({ sessionId: 'S', preference }).model, 'gpt-6-astra');
  assert.equal(codexReserveReturnChoice({ sessionId: 'other', preference }), null);
  assert.equal(codexReserveReturnChoice({ sessionId: 'S', preference, intent }).model, 'gpt-6-sol', 'new click supersedes snapshot');
  assert.equal(captureCodexReserveReturnPreference({ sessionId: 'S', observed: { model: 'gpt-reserve', effort: 'max' } }), null);
  assert.equal(captureCodexReserveReturnPreference({ sessionId: 'S', intent: { ...intent, model: 'gpt-reserve' }, observed: model }), null);
  assert.equal(captureCodexReserveReturnPreference({ sessionId: 'new-source', intent,
    observed: { model: 'gpt-6-astra', effort: 'high' } }).model, 'gpt-6-astra',
  'a stale choice from another conversation cannot relabel the new source snapshot');
});

for (const allowed of [true, false]) test('live account allowance ' + allowed + ' controls automatic return; one restart burst uses one probe', async () => {
  const h = fixture({ allowed });
  const results = await Promise.all(Array.from({ length: 6 }, () => h.probe.read('home')));
  assert.equal(h.clients, 1); assert.equal(h.closed, 1);
  const choice = codexReserveReturnChoice({ sessionId: 'S', intent });
  assert.equal(planCodexReserveReturn(choice, results[0]).restore, allowed);
  assert.equal(h.requests.filter(r => r.method === 'model/list').length, allowed ? 1 : 0);
  await h.probe.read('home'); assert.equal(h.clients, 1);
  h.setTime(17000); assert.equal(h.probe.current('home', results[0]), false);
  await h.probe.read('home'); assert.equal(h.clients, 2);
});

for (const options of [{ missing: true }, { fail: 'factory' }, { fail: 'account/rateLimits/read' },
  { responseAccount: 'other' }, { models: [] }, { models: [{ ...model, hidden: true }] },
  { models: [{ ...model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }]) {
  test('unknown/refused pair keeps Reserve without a failed Resume: ' + JSON.stringify(options), async () => {
    const h = fixture(options);
    const result = await h.probe.read('home');
    assert.equal(planCodexReserveReturn(codexReserveReturnChoice({ sessionId: 'S', intent }), result).restore, false);
    await h.probe.read('home'); assert.equal(h.clients, 1, 'failed probes are also bounded per burst');
  });
}

test('switching account during a request or before launch cannot borrow the old allowance', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = fixture({ beforeUsage: () => gate });
  const reading = h.probe.read('home');
  await new Promise(r => setImmediate(r));
  h.setAuth({ accountId: 'B', userId: 'U2', tokenFingerprint: 'T2' });
  release();
  assert.equal((await reading).ordinaryUsageAllowed, null);
  const stable = fixture(); const proof = await stable.probe.read('home');
  assert.equal(stable.probe.current('home', proof), true);
  stable.setAuth({ accountId: 'B', userId: 'U2', tokenFingerprint: 'T2' });
  assert.equal(stable.probe.current('home', proof), false);
  await stable.probe.read('home'); assert.equal(stable.clients, 2);
});
