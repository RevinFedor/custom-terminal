import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mainFixture, deferred, turns, load, read, strip, storeFixture as fixture } from './agentLaunchRecovery.actual.fixture.mjs';

function pendingResume(f, changes = {}) {
  const env = f.mainEnv || f.env;
  Object.assign(env.terminalCommandState.get(f.tabId), { isRunning: true });
  env.codexLastRunCommandPayload.set(f.tabId, { command: 'codex-c', sessionId: 'S',
    tabId: f.tabId, cwd: '/fixture', launchId: 'L', terminalToken: f.term, runSeq: 1,
    lifecycleGeneration: env.getTerminalLifecycleGeneration(f.tabId), commandWrittenAt: 1000,
    ...changes });
  env.codexLaunchAcceptancePending.set(f.tabId, 'L');
}

for (const ownLaunch of [true, false]) test('actual Store interruption clear joins exact pending Resume without a writer: own=' + ownLaunch, async () => {
  const f = await fixture('S'), controller = new AbortController(), scope = f.scope({ signal: controller.signal });
  await scope.ready();
  const writerScope = ownLaunch ? scope : f.scope();
  const launch = await f.run(writerScope);
  assert.equal(launch.success, true);
  pendingResume(f);
  assert.equal(f.mainEnv.getCodexWriterProofSnapshot(f.tabId), null);
  const restore = read('src/renderer/utils/continueInterruptedSession.ts');
  const start = restore.indexOf('    checkSource = () => {');
  const end = restore.indexOf('    unsubscribeSource =', start);
  assert.ok(start >= 0 && end > start);
  const predicate = read('src/renderer/store/useWorkspaceStore.ts').match(/export const isTabInterrupted = [\s\S]*?\n};/)?.[0];
  assert.ok(predicate);
  Object.assign(f.env, { projectId: 'P', tabId: f.tabId, engine: 'codex', cwd: '/fixture',
    controller, sourceSessionId: 'S', sessionReconciliation: null,
    launchAdmission: scope });
  vm.runInContext(strip(predicate.replace(/^export /, '') + '\nlet checkSource;\n'
    + restore.slice(start, end) + '\nglobalThis.check = checkSource;'), f.env);
  f.store.clearInterruptedState(f.tabId);
  assert.equal(f.tab.wasInterrupted, false);
  f.env.check();
  if (f.env.sessionReconciliation) await f.env.sessionReconciliation.promise;
  assert.equal(f.env.controller.signal.aborted, false,
    'presentation changed; the already-written exact launch is still being joined');
  assert.equal(f.env.sessionReconciliation, null, 'a label change does not request writer proof');
  assert.equal(f.calls.filter(c => c.channel === 'agent:inspect-launch-intent').length, 0);
  assert.equal(f.mainEnv.getCodexWriterProofSnapshot(f.tabId), null, 'joining is not writer adoption');
  assert.equal(f.writes.length, 1);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, 1);
  f.adopt('C');
  await f.store.setCodexSessionId(f.tabId, 'C', 'detected');
  f.env.check();
  await f.env.sessionReconciliation.promise;
  assert.equal(f.env.controller.signal.aborted, false, 'the later real child still joins exactly once');
  assert.equal(f.env.sourceSessionId, 'C');
  assert.equal(f.calls.filter(c => c.channel === 'agent:inspect-launch-intent').length, 1);
  assert.equal(f.writes.length, 1);
  await scope.finish(); if (!ownLaunch) await writerScope.finish();
});

for (const change of ['not-written', 'foreign-session', 'foreign-launch', 'fresh', 'cwd', 'run',
  'lifecycle', 'terminal', 'acceptance', 'stopping', 'stop-revision', 'foreign-row']) {
  test('pending Resume join keeps exact original authority: ' + change, async () => {
    const f = await mainFixture(), scope = f.scope();
    await f.run(scope); pendingResume(f);
    const pending = f.env.codexLastRunCommandPayload.get(f.tabId);
    if (change === 'not-written') delete pending.commandWrittenAt;
    if (change === 'foreign-session') pending.sessionId = 'FOREIGN';
    if (change === 'foreign-launch') { pending.launchId = 'L2'; f.env.codexLaunchAcceptancePending.set(f.tabId, 'L2'); }
    if (change === 'fresh') pending.materializedFresh = true;
    if (change === 'cwd') pending.cwd = '/other';
    if (change === 'run') pending.runSeq = 2;
    if (change === 'lifecycle') pending.lifecycleGeneration = 'old';
    if (change === 'terminal') pending.terminalToken = {};
    if (change === 'acceptance') f.env.codexLaunchAcceptancePending.set(f.tabId, 'other');
    if (change === 'stopping') f.env.aiStoppingTabs.set(f.tabId, {});
    if (change === 'stop-revision') f.stop();
    if (change === 'foreign-row') f.row.codex_session_id = 'FOREIGN';
    assert.equal(await scope.reconcileSession('S'), false);
    assert.equal(f.writes.length, 1, 'no recovery write');
    await scope.finish();
  });
}

test('lost Stop publication: old scope cannot launch; refusal must unstick a later new explicit cached scope', async () => {
  const f = await mainFixture();
  const pending = f.scope(); f.stop();
  const rejected = await f.run(pending);
  assert.equal(rejected.success, false);
  assert.deepEqual(rejected.launchFence, structuredClone(f.original), 'observation never replaces the original scope fence');
  assert.equal(f.cached().stopRevision, 1, 'Main refusal is a future-only observation');
  await pending.finish();
  assert.equal(f.writes.length, 0);
  const next = f.scope();
  const result = await f.run(next); await next.finish();
  assert.equal(result.success, true, 'new explicit scope must be usable after the old one observes Main refusal');
  assert.equal(f.writes.length, 1);
  assert.equal(f.calls.filter(c => c.channel === 'agent:begin-launch-intent').length, 2, 'one begin per explicit scope');
});

for (const engine of ['codex', 'claude']) for (const sid of ['C', 'S']) {
  test(engine + ' ' + sid + ': own writer adoption while original begin ACK waits can join without renewing or writing', async () => {
    const f = await mainFixture(engine), ack = deferred(), entered = deferred();
    f.hooks.beginAck = () => { entered.resolve(); return ack.promise; };
    const scope = f.scope(); await entered.promise; f.adopt(sid);
    const joined = scope.reconcileSession(sid); ack.resolve();
    assert.equal(await joined, true, 'same Main-accepted original scope must reach exact inspect after delayed ACK');
    const result = await f.run(scope);
    assert.equal(result.joined, true); assert.equal(result.sessionId, sid);
    assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, 0);
    assert.equal(f.writes.length, 0); await scope.finish();
  });
}

for (const engine of ['codex', 'claude']) test(engine + ': foreign lineage during held begin never joins or writes', async () => {
  const f = await mainFixture(engine), ack = deferred(), entered = deferred();
  f.hooks.beginAck = () => { entered.resolve(); return ack.promise; };
  const scope = f.scope(); await entered.promise; f.adopt('C', 'FOREIGN');
  const joined = scope.reconcileSession('C'); ack.resolve();
  assert.equal(await joined, false); assert.equal((await f.run(scope)).success, false);
  assert.equal(f.writes.length, 0); await scope.finish();
});

test('cancel during held begin prevents join and late acquire never writes', async () => {
  const f = await mainFixture(), ack = deferred(), entered = deferred(), controller = new AbortController();
  f.hooks.beginAck = () => { entered.resolve(); return ack.promise; };
  const scope = f.scope({ signal: controller.signal }); await entered.promise; f.adopt();
  const joined = scope.reconcileSession('C'); controller.abort('dismissed'); ack.resolve();
  assert.equal(await joined, false); await turns(); assert.equal((await f.run(scope)).success, false);
  assert.equal(f.writes.length, 0); await scope.finish();
});

test('definite Main duplicate-begin cancellation stays known and preserves its exact no-write proof', async () => {
  const f = await mainFixture();
  f.hooks.beforeBegin = input => {
    assert.equal(f.env.beginAgentLaunchIntent({ sender: f.sender }, input).success, true);
    f.stop(); // Main knows this exact id and its unstarted write, with event LOST.
  };
  const scope = f.scope();
  const result = await f.run(scope);
  assert.equal(result.success, false); assert.equal(result.code, 'agent_launch_intent_fence_changed');
  assert.equal(result.launchOutcomeUnknown, false);
  assert.equal(result.launchWritten, false); assert.equal(result.accepted, false);
  assert.equal(result.launchStage, 'intent-begin');
  assert.deepEqual(result.launchFence, structuredClone(f.original));
  assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, 0);
  const materialized = await scope.materialize({ projectId: 'P', tabId: f.tabId, cwd: '/fixture' });
  assert.equal(materialized.launchOutcomeUnknown, false); assert.equal(materialized.launchWritten, false);
  await scope.finish();
});

for (const shape of ['missing-written', 'null-written', 'null-accepted', 'foreign-intent']) test('begin refusal is not no-write proof: ' + shape, async () => {
  const f = await mainFixture();
  f.hooks.beforeBegin = input => {
    assert.equal(f.env.beginAgentLaunchIntent({ sender: f.sender }, input).success, true);
    f.stop();
  };
  f.hooks.beginResult = result => {
    if (shape === 'missing-written') { const { launchWritten, ...other } = result; return other; }
    if (shape === 'null-written') return { ...result, launchWritten: null };
    if (shape === 'null-accepted') return { ...result, accepted: null };
    return { ...result, launchIntent: { ...result.launchIntent, intentId: 'launch:foreign:1' } };
  };
  const scope = f.scope(); const result = await f.run(scope);
  assert.equal(result.success, false); assert.equal(result.launchOutcomeUnknown, true);
  assert.equal(result.accepted, null); assert.equal(result.launchWritten, null);
  const materialized = await scope.materialize({ projectId: 'P', tabId: f.tabId, cwd: '/fixture' });
  assert.equal(materialized.launchOutcomeUnknown, true);
  assert.equal(materialized.accepted, null); assert.equal(materialized.launchWritten, null);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, 0);
  await scope.finish();
});

test('rejected begin Error cannot claim negative proof without a validated response', async () => {
  const f = await mainFixture();
  f.hooks.beforeBegin = () => { throw Object.assign(new Error('rejected'), { protocolVersion: 1,
    launchStage: 'intent-begin', accepted: false, launchWritten: false, launchOutcomeUnknown: false, launchFence: f.original }); };
  const scope = f.scope();
  for (const result of [await f.run(scope), await scope.materialize({ tabId: f.tabId })]) {
    assert.equal(result.launchOutcomeUnknown, true); assert.equal(result.accepted, null); assert.equal(result.launchWritten, null);
  }
  assert.equal(f.writes.length, 0); await scope.finish();
});

for (const loss of ['rejected', 'silent']) test('uncertain launch ' + loss + ' ACK still stays unknown without replay or negative Send receipt', async () => {
  const f = await mainFixture();
  const { runAgentSendFlow } = await load('src/renderer/utils/agentSendFlow.mjs');
  f.hooks.runAck = () => loss === 'rejected' ? Promise.reject(new Error('held ACK lost')) : new Promise(() => {});
  const scope = f.scope({ sendOperationKey: 'O', sendAttemptId: 'A' });
  const result = await scope.run('codex:run-command', { tabId: f.tabId, command: 'codex-c', sessionId: 'S', cwd: '/fixture',
    sendOperationKey: 'O', sendAttemptId: 'A' });
  assert.equal(result.success, false); assert.equal(result.launchOutcomeUnknown, true);
  assert.equal(result.launchWritten, null); assert.equal(result.accepted, null);
  await assert.rejects(runAgentSendFlow({ prepareContext: async () => ({}), ensureReady: async () => {
    throw Object.assign(new Error(result.error), result);
  }, proveComposer: () => assert.fail('uncertain launch is not ready'), runProviderOperation: () => assert.fail('no new input') }), error => {
    assert.equal(error.sendReceipt.deliveryUnknown, true); assert.equal(error.sendReceipt.submitted, null);
    assert.equal(error.sendReceipt.pasteWritten, undefined); assert.equal(error.sendReceipt.enterWritten, undefined); return true;
  });
  assert.equal(f.writes.length, 1); assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, 1);
  await scope.finish();
});

for (const boundary of ['begin', 'run']) test('missing ' + boundary + ' authority echo remains unknown', async () => {
  const f = await mainFixture();
  f.hooks[boundary + 'Result'] = result => ({ ...result, launchIntent: null });
  const scope = f.scope(); const result = await f.run(scope);
  assert.equal(result.success, false); assert.equal(result.launchOutcomeUnknown, true);
  assert.equal(result.accepted, null); assert.equal(result.launchWritten, null);
  assert.equal(f.writes.length, boundary === 'begin' ? 0 : 1);
  assert.equal(f.calls.filter(c => c.channel.endsWith(':run-command')).length, boundary === 'begin' ? 0 : 1);
  await scope.finish();
});

for (const change of ['session', 'settings']) test('late successful launch ACK does not overwrite a newer ' + change + ' owner', async () => {
  const f = await fixture(), scope = f.scope({ sessionId: null });
  f.hooks.runAck = async () => {
    if (change === 'session') { f.row.codex_session_id = 'FOREIGN'; await f.store.setCodexSessionId(f.tabId, 'FOREIGN', 'detected'); }
    f.store.updateCodexState(f.tabId, { codexModel: 'newer-model', codexEffort: 'low' });
  };
  const result = await f.env.actualStart({ tabId: f.tabId, cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.accepted, true, 'already-written launch receipt is not turned into a negative acknowledgement');
  assert.equal(f.tab.codexModel, 'newer-model'); assert.equal(f.tab.codexEffort, 'low');
  assert.equal(f.writes.length, 1); await scope.finish();
});

for (const change of ['foreign', 'same-S', 'own-child']) test('Resume late ACK retains interruption ownership: ' + change, async () => {
  const f = await fixture('S'), scope = f.scope();
  f.hooks.runAck = async () => {
    if (change !== 'same-S') {
      f.adopt(change === 'own-child' ? 'C' : 'FOREIGN', change === 'own-child' ? 'S' : 'FOREIGN');
      await f.store.setCodexSessionId(f.tabId, change === 'own-child' ? 'C' : 'FOREIGN', 'detected');
      if (change === 'foreign') f.tab.wasInterrupted = true;
    }
  };
  const result = await f.env.actualResume({ tabId: f.tabId, sessionId: 'S', cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.accepted, true); assert.equal(result.sessionId, 'S', 'return the accepted request source');
  assert.equal(f.tab.wasInterrupted, change === 'foreign'); assert.equal(f.writes.length, 1);
  await scope.finish();
});

for (const session of ['M', 'C']) test('fresh launch projects settings once for its exact ' + session + ' owner', async () => {
  const f = await fixture(), scope = f.scope({ sessionId: null });
  if (session === 'C') f.hooks.runAck = async () => {
    f.adopt('C', 'M'); f.mainEnv.codexLastRunCommandPayload.get(f.tabId).materializedFresh = true;
    await f.store.setCodexSessionId(f.tabId, 'C', 'detected');
  };
  const result = await f.env.actualStart({ tabId: f.tabId, cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.accepted, true); assert.equal(f.tab.codexSessionId, session);
  assert.equal(f.tab.codexModel, 'launch-model'); assert.equal(f.tab.codexEffort, 'high');
  assert.equal(f.tab.codexSettingsProofSessionId, session);
  assert.equal(f.writes.length, 1); await scope.finish();
});

for (const change of ['interruption', 'dismissal', 'tab-replacement']) test('late launch ACK cannot clear newer UI state: ' + change, async () => {
  const f = await fixture(), scope = f.scope({ sessionId: null }); let current = f.tab;
  f.hooks.runAck = async () => {
    if (change === 'tab-replacement') {
      current = { ...f.tab, wasInterrupted: true };
      f.store.openProjects.get('P').tabs.set(f.tabId, current);
    } else {
      current.wasInterrupted = true;
      if (change === 'dismissal') current.overlayDismissed = true;
    }
  };
  const result = await f.env.actualStart({ tabId: f.tabId, cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.accepted, true); assert.equal(current.wasInterrupted, true);
  assert.equal(current.overlayDismissed === true, change === 'dismissal');
  assert.equal(f.writes.length, 1); await scope.finish();
});

for (const change of ['foreign', 'new-flag', 'own-child', 'same-owner']) test('Claude fresh late ACK preserves UI owner: ' + change, async () => {
  const f = await fixture(null, 'claude'), scope = f.scope({ sessionId: null });
  if (change === 'same-owner' || change === 'foreign') f.tab.wasInterrupted = true;
  f.hooks.runAck = () => {
    if (change === 'foreign' || change === 'own-child') {
      const sid = '11111111-1111-4111-8111-111111111111';
      f.adopt(sid, change === 'foreign' ? 'FOREIGN' : null);
      if (change === 'own-child') f.mainEnv.claudeLaunchGenerationByTab.get(f.tabId).launchMode = 'fresh';
      f.store.setClaudeSessionId(f.tabId, sid, 'detected');
    }
    if (change === 'foreign' || change === 'new-flag') f.tab.wasInterrupted = true;
  };
  const result = await f.env.actualClaudeStart({ tabId: f.tabId, cwd: '/fixture', launchAdmission: scope });
  assert.equal(result.accepted, true); assert.equal(f.writes.length, 1);
  assert.equal(f.tab.wasInterrupted, change === 'foreign' || change === 'new-flag');
  if (change === 'own-child') assert.equal(f.calls.filter(c => c.channel === 'agent:inspect-launch-intent').length, 1);
  await scope.finish();
});
