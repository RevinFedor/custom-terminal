'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLoopDependencies } = require('./loop-dependencies');
const { loopExternalWaitAdmission } = require('../shared/loop-dependencies.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-await-')), file = path.join(root, 'state.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 4, processId: null };
  const state = { known: true, busy: true, processStatus: 'found', toolType: 'codex', sessionId: 'S', cwd: root,
    loopTaskProtocol: { eligible: true, intentId: null },
    currentSubject: { kind: 'codex-execution', toolType: 'codex', sessionId: 'S', targetExecutionContext: context } };
  const queue = { loopPromptEnabled: true, loopPromptMode: 'own-turn', loopPromptEpoch: 'E', loopPromptArmedAt: 1 };
  const receipt = { operationKey: 'loop-op', attemptId: 'attempt-one', userUuid: 'user-one', sessionId: 'S',
    provider: 'codex', executionContext: context, reviewToken: 'this-review' };
  const result = { found: true, complete: false, sourceVerified: true, userUuid: 'user-one', executionContext: context };
  const callback = { ...receipt, operationKey: 'callback-op', attemptId: 'callback-attempt', userUuid: 'callback-user',
    executionContext: { ...context, turnId: 'callback-T', generation: 5 } };
  const callbackResult = { ...result, userUuid: callback.userUuid, executionContext: callback.executionContext };
  const facts = new Map([['R', { known: true, identity: 'run-source-S:R', actionable: false, delivery: 'callback', receipt: null }]]);
  const changes = [], hooks = { readState: null, readResult: null, write: null, readReceipt: null };
  const options = { read: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
    write: value => { hooks.write?.(value); fs.writeFileSync(file, JSON.stringify(value)); },
    readQueue: () => queue, readState: async () => { await hooks.readState?.(); return clone(state); },
    readInspection: () => ({ ...state, executionContext: state.currentSubject?.targetExecutionContext || null }),
    readDependency: async ref => clone(facts.get(ref.id) || { known: false }),
    readLoopReceipt: async () => { await hooks.readReceipt?.(); return clone(receipt); },
    readResult: async (_source, row) => { await hooks.readResult?.(); return clone(row.userUuid === receipt.userUuid ? result : callbackResult); },
    changed: (entry, revision) => changes.push({ entry, revision }), now: () => 1000 };
  let owner = createLoopDependencies(options);
  const request = extra => owner.request({ tabId: 'P', dependencies: [{ kind: 'run', id: 'R' }], reason: 'Need R', reviewToken: 'this-review', ...extra });
  return { state, queue, receipt, result, callback, callbackResult, facts, changes, hooks, request,
    get owner() { return owner; }, restore() { owner = createLoopDependencies(options); },
    row() { return owner.snapshot().entries.at(-1); }, async natural() {
      result.complete = true; state.busy = false; state.currentSubject = null; await owner.reconcile('P');
    } };
}

test('production policy allows external review separately from whole-work blockers', () => {
  assert.equal(loopExternalWaitAdmission([{ runId: 'R', sourceTabId: 'P', targetTabId: 'C', status: 'running' }], 'P'), true);
  for (const patch of [{ status: 'waiting_recovery' }, { externalResearchDeliveryUnknown: true },
    { status: 'completed', sourceFollowupPending: true, notificationStatus: 'pending' }]) {
    assert.equal(loopExternalWaitAdmission([{ runId: 'R', sourceTabId: 'P', targetTabId: 'C', status: 'running', ...patch }], 'P'), false);
  }
  assert.equal(loopExternalWaitAdmission([], 'P', false), false);
});

test('ordinary/legacy Loop cannot create a dependency wait; switching mode supersedes its old wait', async t => {
  const h = fixture(t);
  delete h.queue.loopPromptMode;
  await assert.rejects(h.request(), { code: 'completion_protocol_not_active' });
  h.queue.loopPromptMode = 'own-turn'; await h.request(); await h.natural();
  h.queue.loopPromptMode = 'all-work';
  assert.equal(h.owner.blocks('P'), false);
  await h.owner.reconcile('P');
  assert.equal(h.row().state, 'superseded');
  assert.equal(h.facts.get('R').identity, 'run-source-S:R', 'external work is retained');
  assert.equal(h.queue.loopPromptEnabled, true);
});

test('intent + natural final + exact callback final, ON and refs survive restart, duplicate wake releases once', async t => {
  const h = fixture(t); await h.request();
  assert.equal(h.row().state, 'intent'); assert.equal(h.owner.blocks('P'), true);
  await h.owner.reconcile('P'); assert.equal(h.row().state, 'intent');
  await h.natural(); assert.equal(h.row().state, 'waiting');
  h.restore(); assert.equal(h.queue.loopPromptEnabled, true); assert.equal(h.owner.blocks('P'), true);
  const fact = h.facts.get('R'); Object.assign(fact, { actionable: true, receipt: h.callback });
  await h.owner.reconcile('P'); assert.equal(h.row().state, 'waiting', 'receipt is not natural completion');
  h.callbackResult.complete = true;
  await Promise.all([h.owner.reconcile(), h.owner.reconcile('P')]);
  assert.equal(h.row().state, 'released');
  assert.equal(h.changes.filter(x => x.entry.state === 'released').length, 1);
  await h.owner.reconcile('P'); assert.equal(h.changes.filter(x => x.entry.state === 'released').length, 1);
  assert.equal(h.queue.loopPromptEnabled, true); assert.equal(h.facts.get('R').identity, 'run-source-S:R');
});

test('duplicate wait request is idempotent, changed dependency/reason conflicts', async t => {
  const h = fixture(t); const a = await h.request(); const b = await h.request();
  assert.equal(a.id, b.id); assert.equal(h.owner.snapshot().entries.length, 1);
  await assert.rejects(h.request({ reason: 'changed' }), /loop_wait_intent_conflict/);
  await assert.rejects(h.request({ reviewToken: 'past-review' }), /loop_review_token_mismatch/);
});

for (const [name, mutate, code] of [
  ['ordinary turn', h => { h.state.loopTaskProtocol.eligible = false; }, 'completion_protocol_not_active'],
  ['completion intent already set', h => { h.state.loopTaskProtocol.intentId = 'complete'; }, 'completion_protocol_not_active'],
  ['unknown source', h => { h.state.known = false; }, 'completion_protocol_not_active'],
  ['Loop OFF', h => { h.queue.loopPromptEnabled = false; }, 'completion_protocol_not_active'],
  ['wrong receipt session', h => { h.receipt.sessionId = 'other'; }, 'loop_wait_loop_receipt_unproven'],
  ['wrong receipt turn', h => { h.receipt.executionContext = { ...h.receipt.executionContext, turnId: 'wrong' }; }, 'loop_wait_loop_receipt_unproven'],
  ['wrong receipt generation', h => { h.receipt.executionContext = { ...h.receipt.executionContext, generation: 8 }; }, 'loop_wait_loop_receipt_unproven'],
  ['foreign dependency', h => { h.facts.set('R', { known: false, code: 'loop_dependency_source_mismatch' }); }, 'loop_dependency_source_mismatch'],
]) test(name + ' refuses wait without side effects', async t => {
  const h = fixture(t); mutate(h); await assert.rejects(h.request(), new RegExp(code));
  assert.equal(h.owner.snapshot().entries.length, 0);
});

test('protocol/subject/arm changes during final read refuse registration', async t => {
  const h = fixture(t); h.hooks.readReceipt = () => { h.state.loopTaskProtocol.eligible = false; };
  await assert.rejects(h.request(), /loop_wait_source_changed/); assert.equal(h.owner.snapshot().entries.length, 0);
});

test('wrong/abnormal/incomplete natural result cannot park or release a different turn', async t => {
  const h = fixture(t); await h.request(); h.result.complete = true; h.result.userUuid = 'wrong';
  await h.owner.reconcile(); assert.equal(h.row().state, 'intent');
  h.result.userUuid = 'user-one'; h.result.executionContext = { ...h.result.executionContext, turnId: 'wrong' };
  await h.owner.reconcile(); assert.equal(h.row().state, 'intent');
  Object.assign(h.result, { complete: false, proofDefinitive: true, errorCode: 'turn_aborted' });
  await h.owner.reconcile(); assert.equal(h.row().state, 'cancelled');
  assert.equal(h.queue.loopPromptEnabled, true);
});

test('first chosen dependency can wake while others run, non-notifying wake is durable and single', async t => {
  const h = fixture(t); h.facts.set('R2', { known: true, identity: 'R2', actionable: false });
  await h.request({ dependencies: [{ kind: 'run', id: 'R2' }, { kind: 'run', id: 'R' }] }); await h.natural();
  Object.assign(h.facts.get('R'), { actionable: true, delivery: 'loop', disposition: 'cancelled' });
  await h.owner.reconcile(); assert.equal(h.row().state, 'ready');
  h.restore(); await h.owner.reconcile(); assert.equal(h.row().state, 'ready');
  assert.equal(h.facts.get('R2').actionable, false); assert.equal(h.owner.blocks('P'), false);
});

test('dependency replacement and duplicate/stale callback cannot release', async t => {
  const h = fixture(t); await h.request(); await h.natural();
  Object.assign(h.facts.get('R'), { identity: 'replacement', actionable: true, receipt: h.callback }); h.callbackResult.complete = true;
  await h.owner.reconcile(); assert.equal(h.row().state, 'waiting');
  h.facts.get('R').identity = 'run-source-S:R'; h.callbackResult.userUuid = 'old-callback';
  await h.owner.reconcile(); assert.equal(h.row().state, 'waiting');
});

test('explicit rearm revokes old wait without deleting job or receipt; newer real input can be reviewed', async t => {
  const h = fixture(t); await h.request(); await h.natural();
  assert.equal(h.owner.blocks('P', h.result.executionContext), true);
  assert.equal(h.owner.blocks('P', { ...h.result.executionContext, turnId: 'new-manual-input' }), false);
  h.queue.loopPromptEpoch = 'new-E'; await h.owner.reconcile(); assert.equal(h.row().state, 'superseded');
  assert.equal(h.facts.get('R').identity, 'run-source-S:R'); assert.equal(h.receipt.attemptId, 'attempt-one');
});

test('persistence failure never becomes accepted wait or an empty authoritative snapshot', async t => {
  const h = fixture(t); h.hooks.write = () => { throw Error('disk unavailable'); };
  await assert.rejects(h.request(), /disk unavailable/); assert.throws(() => h.owner.snapshot(), /persistence_unknown/);
});
test('source replacement during result read cannot commit a release for the new conversation', async t => {
  const h = fixture(t); await h.request(); await h.natural();
  Object.assign(h.facts.get('R'), { actionable: true, receipt: h.callback }); h.callbackResult.complete = true;
  h.hooks.readResult = () => { h.state.sessionId = 'replacement'; };
  await assert.rejects(h.owner.reconcile('P'), /loop_wait_source_changed/);
  assert.equal(h.row().state, 'waiting'); assert.equal(h.changes.filter(x => x.entry.state === 'released').length, 0);
});
