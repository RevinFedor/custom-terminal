'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createBuildInstallContinuations } = require('./build-install-continuation');
function fixture() {
  let saved, remote = 0; const cancelled = [];
  const owner = createBuildInstallContinuations({ read: () => saved, write: value => { saved = value; }, receipts: () => ({ list: () => [] }),
    readSource: async () => ({ coherent: false }), readResult: async () => ({ found: false }) });
  owner.reserve({ requestId: 'same-request', jobId: 'same-job', source: { tabId: 'worker', projectId: 'P', sessionId: 'A', toolType: 'codex' } });
  const job = { id: 'same-job', requestId: 'same-request', running: false, callback: { status: 'confirming' }, returnTo: { tabId: 'worker' } };
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8'), start = web.indexOf('async function cancelBuildInstallFromDock(');
  const code = web.slice(start, web.indexOf('\nlet releaseBuildInstallReceipt', start));
  const context = vm.createContext({ getBuildInstallContinuations: () => owner,
    agentSendReceiptStore: { list: () => [] },
    getBuildInstallStatusClient: () => ({ snapshot: () => ({ jobs: [job] }), cancel: async request => { remote++; assert.equal(request.action, 'cancel-request'); return { ok: true }; } }),
    cancelBuildContinueInput: target => { cancelled.push(target); return true; },
    getBuildContinueOperations: () => ({ cancelInstall: async (...args) => { cancelled.push(args); } }) });
  vm.runInContext(code, context);
  return { owner, job, cancelled, remote: () => remote, cancel: body => context.cancelBuildInstallFromDock({ tabId: 'worker', id: 'same-job', requestId: 'same-request', ...body }) };
}
test('X cancels an unconfirmed callback wait and future callback; it never requires native success first', async () => {
  const h = fixture(); await h.cancel(); assert.equal(h.owner.blocked('worker'), false);
  assert.equal(h.owner.snapshot().entries[0].state, 'cancelled');
  assert.throws(() => h.owner.armCallback({ requestId: 'same-request', jobId: 'same-job', prompt: 'old callback' }), /already_settled/);
  assert.equal(h.remote(), 1); assert.equal(h.cancelled.length, 1);
  assert.equal(h.cancelled[0].handoffId, 'build-install-return:same-job');
});
test('X cancels only the exact Voice binding, never an unrelated CLI operation in the same tab', async () => {
  const h = fixture(); h.job.autoContinue = { binding: { operationId: 'voice-exact-operation', jobId: 'same-job', requestId: 'same-request', source: { tabId: 'worker' } } };
  await h.cancel(); assert.equal(h.cancelled.length, 2); assert.equal(h.cancelled[1][0], 'voice-exact-operation');
  assert.notEqual(h.cancelled[1][0], 'e9c43a7d-4ff3-4c1e-9dd2-66c6934cc7a2');
});
test('foreign job or binding cannot cancel any neighbouring operation', async () => {
  let h = fixture(); await assert.rejects(h.cancel({ id: 'foreign' }), /owner unproven/); assert.equal(h.cancelled.length, 0);
  h = fixture(); h.job.autoContinue = { binding: { operationId: 'foreign-op', jobId: 'other-job', requestId: 'same-request', source: { tabId: 'worker' } } };
  await assert.rejects(h.cancel(), /owner changed/); assert.equal(h.cancelled.length, 1, 'own callback only; foreign recovery untouched'); assert.equal(h.remote(), 0);
});

test('a stale X after natural completion cannot replace its real floor or rewrite completed work as cancelled', () => {
  const h = fixture(), saved = h.owner.snapshot(); saved.entries[0].state = 'continued'; saved.entries[0].outcomeFloorAt = 123;
  const owner = createBuildInstallContinuations({ read: () => saved, write() {}, receipts: () => ({ list: () => [] }) });
  const entry = owner.cancelRequest({ tabId: 'worker', id: 'same-job', requestId: 'same-request' });
  assert.equal(entry.state, 'continued'); assert.equal(entry.outcomeFloorAt, 123); assert(entry.cancelledAt);
  assert.throws(() => owner.armCallback({ requestId: 'same-request', jobId: 'same-job', prompt: 'late callback' }), /already_settled/);
});
