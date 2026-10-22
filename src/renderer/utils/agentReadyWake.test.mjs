import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import sendTargetContract from '../../shared/agent-send-target-precondition.cjs';
import manualActionContract from '../../shared/agent-manual-action.cjs';
import agentSendReadTiming from '../../shared/agent-send-read-timing.cjs';
import codexPolicies from '../../main/codex-runtime-policies.js';
import { runAgentSendFlow } from './agentSendFlow.mjs';
import { createAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import { createLaunchFixture, assertOnlyFenceObservers } from './agentLaunchFixture.mjs';

const preparation = fs.readFileSync(new URL('./agentSendPreparation.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
// Drain the real admission helper as well as the readiness pass; a fixed
// microtask count races its acquire/run/finish continuations.
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(toolType = 'codex') {
  const { ipcRenderer, calls } = createLaunchFixture();
  const timers = new Map();
  let now = 0, serial = 0, resumes = 0, reads = 0, cancelled = false;
  const cancellationWaits = new Set();
  let state = { status: 'active', inputReady: false };
  const runtime = { toolType, label: toolType, readyEvent: toolType + ':tui-ready',
    getPresence: async () => { reads++; return { ...state }; },
    resume: async ({ launchAdmission }) => {
      resumes++;
      return launchAdmission.run(toolType + ':run-command', { tabId: 'T', command: toolType + '-c', sessionId: 'S' });
    },
  };
  const body = preparation.slice(preparation.indexOf('export function createAgentReadyWait('),
    preparation.indexOf('export async function proveAgentComposerForSend('));
  const api = vm.runInNewContext(stripTypeScriptTypes(body.replace(/\bexport /g, ''))
    + '\n({ createAgentReadyWait, prepareAgentRuntimeForSend })', {
    ...sendTargetContract, manualActionContract, agentSendReadTiming,
    ipcRenderer, AbortController, createAgentLaunchAdmission, Date: { now: () => now }, console: { log() {}, warn() {} },
    setTimeout: (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    terminalRegistry: { get: () => ({}) },
    isCoordinatedAgentSendCancellationRequested: () => cancelled,
    createCoordinatedAgentSendCancellationWait: () => {
      let wake;
      const promise = new Promise(resolve => { wake = resolve; cancellationWaits.add(wake); });
      return { promise, cancel: () => cancellationWaits.delete(wake) };
    },
  });
  const providerContract = {
    classifySubmitCapability: p => p?.status === 'busy' ? 'queue' : p?.inputReady ? 'direct' : 'blocked',
    startupGateOwnsComposer: () => false, waitForStartupGate: async () => {},
  };
  return { ipcRenderer, calls, timers, runtime,
    start: (extra = {}) => api.prepareAgentRuntimeForSend({ tabId: 'T', runtime, providerContract,
      sessionId: 'S', cwd: '/fixture', requestedStatusAtSend: 'active', coordinatedSendToken: 1, ...extra }),
    setState: value => { state = value; },
    advance: ms => { now += ms; },
    wakeAt: async time => { now = time; for (const timer of [...timers.values()]) timer.callback(); await tick(); },
    cancel: () => { cancelled = true; for (const wake of cancellationWaits) wake(); },
    expire: async () => { now = 30001; for (const timer of [...timers.values()]) timer.callback(); await tick(); },
    get reads() { return reads; }, get resumes() { return resumes; },
  };
}

test('common cold Send preserves structured Main no-launch refusal instead of dropping it into a bare Error', async () => {
  const h = harness(); h.setState({ status: 'inactive', inputReady: false });
  const refusal = { success: false, accepted: false, error: 'shell_not_idle',
    reason: 'process_lookup_unknown', lookupUnknown: true, launchWritten: false };
  h.runtime.resume = async () => refusal;
  await assert.rejects(h.start(), error => error.message === 'shell_not_idle'
    && error.reason === 'process_lookup_unknown' && error.lookupUnknown === true
    && error.launchWritten === false && error.submitted === undefined);
  assert.equal(h.timers.size, 0, 'this patch preserves the refusal; it does not add blind retry');
});

test('RunAfter admission revocation cancels common readiness wait without any provider Stop/Resume', async () => {
  const h = harness(), controller = new AbortController();
  const pending = h.start({ coordinatedSendToken: null, admissionSignal: controller.signal });
  await tick();
  assert.ok(h.timers.size > 0);
  controller.abort();
  await assert.rejects(pending, error => error.cancelled === true && error.submitted === false);
  assert.equal(h.resumes, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(call => call.channel === 'agent:cancel-launch-intent').length, 1,
    'pre-FIFO preparation revocation reaches Main through the real scope');
  assertOnlyFenceObservers(h.ipcRenderer);
});

const startupSnapshot = (launchId = 'L') => ({ launchId, lifecycleGeneration: 'G',
  sendTarget: { toolType: 'codex', sessionId: 'S', launchId },
  startupWait: { launchId, lifecycleGeneration: 'G', startedAt: 1000, deadlineAt: 61000 } });

for (const lateSnapshot of [false, true]) test('late join uses the absolute Main deadline, including a shorter deadline discovered after the first read: ' + lateSnapshot, async () => {
  const h = harness();
  h.advance(50000);
  h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: lateSnapshot ? null : startupSnapshot() });
  if (lateSnapshot) {
    const read = h.runtime.getPresence;
    let reads = 0;
    h.runtime.getPresence = async (...args) => {
      if (++reads === 2) h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: startupSnapshot() });
      return read(...args);
    };
  }
  const rejected = assert.rejects(h.start(), error => error.code === 'agent_send_readiness_timeout');
  await tick();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 11000, 'joining at50s does not allocate another30s');
  await h.wakeAt(61001);
  await rejected;
  assert.equal(h.timers.size, 0);
  assert.equal(h.resumes, 0);
});

test('cold Codex Send survives the old 30s limit and sends frozen context once on the same launch ready', async () => {
  const h = harness();
  h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: startupSnapshot() });
  let writes = 0, prepared = 0;
  const frozen = Object.freeze({ text: 'original text and context', handoffId: 'H' });
  const pending = runAgentSendFlow({ prepareContext: async () => { prepared++; return frozen; },
    ensureReady: () => h.start(), proveComposer: async () => {}, runProviderOperation: async value => {
      assert.strictEqual(value, frozen); writes++; return { success: true };
    } });
  await tick();
  await h.wakeAt(30001);
  assert.equal(writes, 0);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 30999);
  h.advance(2600);
  h.setState({ status: 'active', inputReady: true,
    runtimeSnapshot: { ...startupSnapshot(), startupWait: null } });
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
  await pending;
  assert.equal(writes, 1); assert.equal(prepared, 1); assert.equal(h.resumes, 0);
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
});

for (const status of ['stopping', 'inactive']) test('Stop during startup cancels without waiting for ready: ' + status, async () => {
  const h = harness();
  h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: startupSnapshot() });
  const rejected = assert.rejects(runAgentSendFlow({ prepareContext: async () => ({}), ensureReady: () => h.start(),
    proveComposer: async () => assert.fail('no paste after stop'), runProviderOperation: async () => assert.fail('no Enter') }),
  error => error.code === 'agent_send_cancelled' && error.sendReceipt.cancelled === true
    && error.sendReceipt.pasteWritten === false);
  await tick(); h.setState({ status, inputReady: false });
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
  await rejected;
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
});

test('main launch failure ends preparation immediately, while a missing ready edge remains finitely bounded', async () => {
  for (const failure of [true, false]) {
    const h = harness();
    h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: startupSnapshot() });
    const rejected = assert.rejects(h.start(), error => error.code === (failure
      ? 'agent_send_startup_failed' : 'agent_send_readiness_timeout'));
    await tick();
    if (failure) {
      h.setState({ status: 'starting', inputReady: false, startupFailed: true, startupError: 'launch failed' });
      h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
    } else await h.wakeAt(61001);
    await rejected;
    assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
  }
});

test('a replacement launch cannot extend or submit the previous startup send', async () => {
  for (const ready of [false, true]) {
    const h = harness();
    h.setState({ status: 'starting', inputReady: false, runtimeSnapshot: startupSnapshot() });
    const rejected = assert.rejects(h.start(), error => error.code === 'agent_send_target_changed');
    await tick();
    h.setState({ status: ready ? 'active' : 'starting', inputReady: ready,
      runtimeSnapshot: { ...startupSnapshot('OTHER'), ...(ready ? { startupWait: null } : {}) } });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
    await rejected;
    assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
  }
});

for (const tool of ['codex', 'claude']) {
  test(tool + ': a live picker waits for current readiness, not another process-start event', async () => {
    const h = harness(tool);
    const result = h.start();
    await tick();
    const before = h.reads;
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'OTHER', toolType: tool });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool === 'codex' ? 'claude' : 'codex' });
    await tick();
    assert.equal(h.reads, before, 'unrelated tab/provider cannot wake this owner');
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool, status: 'ready' });
    await tick();
    assert.ok(h.reads > before, 'wake re-reads; its ready label is not authority');
    assert.equal(h.resumes, 0);
    h.setState({ status: 'active', inputReady: true });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool });
    assert.equal((await result).submitCapability, 'direct');
    assert.equal(h.resumes, 0);
    assertOnlyFenceObservers(h.ipcRenderer);
    assert.equal(h.timers.size, 0);
  });
}

// The picker may acquire the composer between the two authoritative reads.
// This is the production 4410 order: startup-ready -> /model -> ready again.
async function regressReadyDuringFinalRead(h) {
  await tick();
  const read = h.runtime.getPresence;
  let nextReads = 0;
  h.runtime.getPresence = async (...args) => {
    if (++nextReads === 2) h.setState({ status: 'active', inputReady: false });
    return read(...args);
  };
  h.setState({ status: 'active', inputReady: true });
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: h.runtime.toolType });
  await tick();
  assert.equal(nextReads, 2, 'final presence, not the wake label, revokes readiness');
  assert.equal(h.timers.size, 1, 'the original deadline must remain armed after readiness regresses');
  assert.equal(h.ipcRenderer.listenerCount('agent:readiness-changed'), 1);
}

for (const tool of ['codex', 'claude']) for (const cold of [false, true]) {
  test(tool + ': ready -> picker retains its wake and submits the frozen context once; cold=' + cold, async () => {
    const h = harness(tool);
    if (cold) {
      h.setState({ status: 'inactive', inputReady: false });
      const resume = h.runtime.resume;
      h.runtime.resume = async (...args) => {
        const result = await resume(...args);
        h.setState({ status: 'starting', inputReady: false });
        return result;
      };
    }
    const prompt = Array.from({ length: 11 }, (_, i) =>
      `<saved_prompt context-update-id="update-${i}">original context ${i}</saved_prompt>`).join('\n')
      + '\noriginal dictated text';
    const context = Object.freeze({ prompt, handoffId: 'same-original-handoff' });
    let writes = 0;
    let preparations = 0;
    const pending = runAgentSendFlow({ prepareContext: async () => { preparations++; return context; }, ensureReady: () => h.start(),
      proveComposer: async () => {}, runProviderOperation: async received => {
        assert.strictEqual(received, context);
        assert.equal(received.prompt, prompt);
        writes++; return { success: true };
      } });
    await regressReadyDuringFinalRead(h);
    assert.equal(writes, 0);
    h.setState({ status: 'active', inputReady: true });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool });
    await pending;
    assert.equal(writes, 1);
    assert.equal(preparations, 1, 'readiness cannot rebuild the context or add newer chips');
    assert.equal(h.resumes, cold ? 1 : 0);
    assert.equal(h.timers.size, 0);
    assertOnlyFenceObservers(h.ipcRenderer);
  });
}

test('ready -> picker still expires with a no-write receipt; no event or second launch is needed', async () => {
  const h = harness();
  let writes = 0;
  const pending = runAgentSendFlow({ prepareContext: async () => ({}), ensureReady: () => h.start(),
    proveComposer: async () => { writes++; }, runProviderOperation: async () => { writes++; } });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'agent_send_readiness_timeout');
    assert.equal(error.sendReceipt.status, 'not-submitted');
    assert.equal(error.sendReceipt.pasteWritten, false);
    return true;
  });
  const inspection = regressReadyDuringFinalRead(h);
  await inspection;
  await h.expire(); await rejected;
  assert.equal(writes, 0); assert.equal(h.resumes, 0);
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
});

test('cancelling after ready -> picker retires the same attempt and every listener', async () => {
  const h = harness();
  const rejected = assert.rejects(h.start(), /cancelled/);
  await regressReadyDuringFinalRead(h);
  h.cancel(); await rejected;
  assert.equal(h.resumes, 0);
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
});

test('another blocked wake keeps the original absolute deadline, not a new 30s budget', async () => {
  const h = harness();
  const rejected = assert.rejects(h.start(), error => error.code === 'agent_send_readiness_timeout');
  await regressReadyDuringFinalRead(h);
  h.advance(12000);
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
  await tick();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 18000);
  await h.expire(); await rejected;
  assert.equal(h.timers.size, 0); assert.equal(h.resumes, 0);
});

test('readiness recovered by another conversation cannot submit the old handoff', async () => {
  const h = harness();
  const rejected = assert.rejects(h.start(), error => error.code === 'agent_send_target_changed');
  await regressReadyDuringFinalRead(h);
  h.setState({ status: 'active', inputReady: true, sessionId: 'OTHER' });
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
  await rejected;
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
  assert.equal(h.resumes, 0);
});

test('deadline re-reads ready state even if its edge was lost; it is not a false refusal', async () => {
  const h = harness();
  const result = h.start();
  await tick();
  h.setState({ status: 'active', inputReady: true });
  await h.expire();
  assert.equal((await result).status, 'active');
  assert.equal(h.timers.size, 0);
});

test('a still-open menu times out with no launch or input; cancellation cleans all wake listeners', async () => {
  const h = harness();
  const result = assert.rejects(h.start(), /not ready|did not become ready/);
  await tick(); await h.expire(); await result;
  assert.equal(h.resumes, 0);
  assert.equal(h.timers.size, 0);
  assertOnlyFenceObservers(h.ipcRenderer);
  const c = harness();
  const cancelled = assert.rejects(c.start(), /cancelled/);
  await tick(); c.cancel(); await cancelled;
  assertOnlyFenceObservers(c.ipcRenderer);
  assert.equal(c.timers.size, 0);
});

const manualGoal = { status: 'active', inputReady: false, manualActionRequired: true,
  manualActionType: 'resume-goal', runtimePolicy: { type: 'resume-goal', phase: 'manual' },
  lastNotReady: { reason: 'codex_resume_goal_action_required', blockers: ['resume-goal'], message: 'Завершите выбор для Goal в терминале.' } };

for (const cold of [false, true]) test('known Goal choice ends unwritten Send, not a timeout or late auto-send; cold=' + cold, async () => {
  const h = harness();
  if (cold) {
    h.setState({ status: 'inactive', inputReady: false });
    const resume = h.runtime.resume;
    h.runtime.resume = async (...args) => { const result = await resume(...args); h.setState(manualGoal); return result; };
  } else h.setState(manualGoal);
  let pasteCalls = 0;
  const pending = runAgentSendFlow({ prepareContext: async () => ({}), ensureReady: () => h.start(),
    proveComposer: async () => { pasteCalls++; }, runProviderOperation: async () => { pasteCalls++; } });
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'codex_resume_goal_action_required');
    assert.equal(error.sendReceipt.status, 'not-submitted');
    assert.equal(error.sendReceipt.manualActionRequired, true);
    assert.equal(manualActionContract.isAgentManualActionPreSubmit(error), true);
    return true;
  });
  assert.equal(h.resumes, cold ? 1 : 0);
  assert.equal(h.timers.size, 0);
  assertOnlyFenceObservers(h.ipcRenderer);
  h.setState({ status: 'active', inputReady: true });
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex' });
  await tick(); assert.equal(pasteCalls, 0, 'a later user choice cannot resume the cancelled send');
});

test('Goal policy manual transition wakes the same pending Send and releases listeners immediately', async () => {
  const h = harness(); const pending = h.start();
  const rejected = assert.rejects(pending, error => error.code === 'codex_resume_goal_action_required');
  await tick(); h.setState(manualGoal);
  h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex', source: 'runtime-policy' });
  await rejected;
  assert.equal(h.timers.size, 0); assertOnlyFenceObservers(h.ipcRenderer);
});

const goalMenu = 'Resume paused goal?\nGoal: synthetic task\n> 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
function goalConfirmationHarness() {
  const h = harness(), owner = { terminal: {}, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1, live: true, turnId: 'old' };
  const policyTimers = new Map(), keys = []; let serial = 0, base = { status: 'starting', sessionStatus: 'starting', inputReady: false,
    runtimeSnapshot: startupSnapshot() }, frame = { valid: true, seq: 10, text: goalMenu };
  const update = () => {
    h.setState(codexPolicies.projectCodexPolicyRuntime(base, controller.read('T')));
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'codex', source: 'runtime-policy' });
  };
  const controller = codexPolicies.createCodexRuntimePolicyController({ capture: () => ({ ...owner }), readFrame: async () => frame,
    withWriteLock: async (_term, work) => work({ active: true }), sendKey: async (_tab, key) => { keys.push(key); return { written: true }; },
    readPolicy: () => ({ resumeGoal: true }), isComposer: value => value.text === 'proven-current-composer',
    stopAll: () => { throw Error('Goal must not Stop'); }, publish: update,
    setTimer: (callback, ms) => { const id = ++serial; policyTimers.set(id, { callback, ms }); return id; },
    clearTimer: id => policyTimers.delete(id) });
  controller.observe('T', frame); update();
  return { h, controller, keys, owner, policyTimers,
    async checkAfter3s(extra = {}) {
      frame = { ...frame, valid: false, ...extra }; h.advance(3500);
      const entry = [...policyTimers].find(([_id, timer]) => timer.ms === 3000); assert.ok(entry);
      policyTimers.delete(entry[0]); await entry[1].callback(); await tick();
    },
    operational() { base = { ...base, status: 'busy', sessionStatus: 'busy', inputReady: true };
      controller.observeOperationalTurn('T', 'new-owned-turn'); },
    paint(text) { frame = { valid: true, seq: frame.seq + 1, text }; if (text === 'proven-current-composer')
      base = { ...base, status: 'active', sessionStatus: 'active', inputReady: true };
      controller.observe('T', frame); },
  };
}

for (const result of ['operational', 'composer']) test('Goal open redraw after3s retains SAME Send until exact ' + result + ' proof', async () => {
  const g = goalConfirmationHarness(); await tick();
  let prepared = 0, submitted = 0, proved = 0, settled = false;
  const context = Object.freeze({ handoffId: 'H753', operationKey: 'history:T:H753', attemptId: 'A753', text: 'frozen authoring' });
  const pending = runAgentSendFlow({ prepareContext: async () => { prepared++; return context; }, ensureReady: () => g.h.start(),
    proveComposer: async () => { proved++; }, runProviderOperation: async value => {
      assert.strictEqual(value, context); submitted++; return { success: true }; } });
  pending.then(() => { settled = true; }, () => { settled = true; }); await tick();
  await g.checkAfter3s();
  assert.equal(g.controller.read('T').manualActionRequired, false, 'unobserved result is not a proven live Goal menu');
  assert.equal(g.controller.readGoalAction('T').status, 'unknown');
  assert.equal(settled, false); assert.equal(submitted, 0); assert.equal(proved, 0); assert.equal(prepared, 1);
  assert.equal(g.policyTimers.size, 0, 'no polling or replacement policy deadline');
  if (result === 'operational') g.operational(); else g.paint('proven-current-composer');
  await pending; assert.equal(submitted, 1); assert.equal(proved, 1); assert.equal(prepared, 1);
  assert.deepEqual(g.keys, ['\r']); assert.equal(g.h.resumes, 0); assert.equal(g.h.timers.size, 0);
});

for (const stop of ['cancel','expiry','live-menu']) test('Goal unobserved result preserves original Send ' + stop + ' fence', async () => {
  const g = goalConfirmationHarness(); await tick(); let submitted = 0;
  const pending = runAgentSendFlow({ prepareContext: async () => Object.freeze({ handoffId:'H753',attemptId:'A753' }), ensureReady: () => g.h.start(),
    proveComposer: async () => {}, runProviderOperation: async () => { submitted++; } });
  const rejected = assert.rejects(pending, error => stop === 'cancel' ? error.cancelled === true
    : stop === 'expiry' ? error.code === 'agent_send_readiness_timeout' : error.code === 'codex_resume_goal_action_required');
  await tick(); await g.checkAfter3s(); assert.equal(submitted,0);
  if (stop === 'cancel') g.h.cancel(); else if (stop === 'expiry') await g.h.wakeAt(61001); else g.paint(goalMenu);
  await rejected; g.operational(); g.paint('proven-current-composer'); await tick();
  assert.equal(submitted,0,'late success must not revive a cancelled/expired/rejected Send');
  assert.deepEqual(g.keys,['\r']); assert.equal(g.h.timers.size,0); assertOnlyFenceObservers(g.h.ipcRenderer);
});

test('normal History Send leaves draft proof after readiness in the common scenario', () => {
  const history = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const match = history.match(/if \(([^\n]+)\) \{\s*const terminalDraft = await readTerminalDraft\('send-preflight'\)/);
  assert.ok(match, 'known early draft-read boundary');
  const shouldReadEarly = new Function('statusAtSend', 'recordWithoutReply', 'return ' + match[1]);
  assert.equal(shouldReadEarly('active', false), false, 'normal send must not read a picker as a composer');
  assert.equal(shouldReadEarly('active', true), true, 'record-context still protects the draft before its Stop');
  assert.match(history, /returnDraftOnConflict: true/);
  assert.match(history, /recoverAgentDraftTransferToHistory\(e\?\.draftTransfer \? e : sendFailureResult/);
});

test('main readiness changes wake both main and renderer waiters without synthesizing startup', () => {
  const begin = main.indexOf('function emitAgentReadinessChanged(');
  const end = main.indexOf('\nfunction publishClaudeStartupDefaultsGate(', begin);
  const calls = [];
  const emit = vm.runInNewContext(main.slice(begin, end) + '\nemitAgentReadinessChanged', {
    ipcMain: { emit: (...args) => calls.push(args) },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(args) } },
  });
  emit('T', { toolType: 'codex', source: 'codex-input-control-frame', status: 'ready' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'agent:readiness-changed-internal');
  assert.equal(calls[1][0], 'agent:readiness-changed');
  assert.equal(calls[1][1].tabId, 'T');
  assert.equal(calls[1][1].toolType, 'codex');
});

for (const cancel of [false, true]) test('actual /fast completion wakes the same cold Send after a stale blocked reply; cancelled=' + cancel, async () => {
  const h = harness();
  let resolveOldPresence, reads = 0, result, error, ready, preparations = 0, proofs = 0, submits = 0;
  h.runtime.getPresence = async () => {
    reads++;
    if (reads === 2) return new Promise(resolve => { resolveOldPresence = resolve; });
    return reads < 2
      ? { status: 'active', inputReady: false, runtimeSnapshot: startupSnapshot() }
      : { status: 'active', inputReady: true, runtimeSnapshot: { ...startupSnapshot(), startupWait: null } };
  };
  const frozen = Object.freeze({ text: 'exact original text', handoffId: 'same-H', operationKey: 'same-O', attemptId: 'same-A' });
  const pending = runAgentSendFlow({
    prepareContext: async () => { preparations++; return frozen; },
    ensureReady: async () => { ready = await h.start(); return ready; },
    proveComposer: async context => { assert.strictEqual(context, frozen); proofs++; },
    runProviderOperation: async context => { assert.strictEqual(context, frozen); submits++; return { success: true }; },
  }).then(value => { result = value; }, value => { error = value; });
  await tick();
  assert.equal(typeof resolveOldPresence, 'function', 'readiness listener is armed before the pending Main presence reply');
  const declaration = name => {
    const at = main.indexOf('function ' + name + '(');
    const end = main.indexOf('\n}\n', at) + 3;
    assert.ok(at >= 0 && end > at, name);
    return main.slice(main.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at, end);
  };
  const writes = [], notifications = [];
  const fn = vm.runInNewContext(declaration('emitAgentReadinessChanged') + '\n'
    + declaration('sendCodexLiveSlashCommand') + '\nsendCodexLiveSlashCommand', {
    console: { log() {}, warn() {} }, codexTurnWatchers: new Map(),
    ipcMain: { emit: (...args) => notifications.push(args) },
    mainWindow: { isDestroyed: () => false, webContents: {
      send: (name, detail) => { notifications.push([name, detail]); h.ipcRenderer.emit(name, {}, detail); },
    } },
    // Only physical slash transport is controlled; Main's completion and the
    // renderer's admission/readiness loop/listeners are actual product code.
    sendCodexSlashCommand: async (_term, text) => { writes.push(text); return { success: true, submitted: true }; },
  });
  try {
    h.advance(43000); // launch + delayed /fast still fit the original HEAD budget
    if (cancel) h.cancel();
    const control = await fn({}, { tabId: 'T', command: '/fast', hasDraft: false });
    assert.equal(control.success, true);
    // This was sampled while /fast owned input, but arrives after it settled.
    resolveOldPresence({ status: 'active', inputReady: false, runtimeSnapshot: startupSnapshot() });
    await tick();
    if (cancel) {
      assert.equal(error?.cancelled, true); assert.equal(result, undefined);
      assert.equal(proofs, 0); assert.equal(submits, 0, 'a completion wake cannot revive the cancelled Send');
    } else {
      assert.equal(result?.success, true, 'completed /fast must wake a fresh read, not park Send until its deadline');
      assert.equal(ready?.status, 'active'); assert.equal(error, undefined);
      assert.equal(proofs, 1); assert.equal(submits, 1, 'one controlled provider adapter call, no replay');
    }
    assert.equal(preparations, 1, 'no context rebuild or new H/O/A');
    assert.deepEqual(writes, ['/fast']); assert.equal(h.resumes, 0);
    assert.equal(notifications.filter(x => x[0] === 'agent:readiness-changed').length, 1);
    assert.equal(h.timers.size, 0);
  } finally { h.cancel(); await pending; }
  assertOnlyFenceObservers(h.ipcRenderer);
});

test('actual fast wake is not a readiness grant; refusals/other controls emit nothing and observer failure cannot undo the result', async () => {
  const begin = main.indexOf('async function sendCodexLiveSlashCommand(');
  const end = main.indexOf('\n}\n', begin) + 3;
  assert.ok(begin >= 0 && end > begin);
  for (const [command, transport, throws, count] of [
    ['/fast', { success: false, submitted: true }, false, 0],
    ['/fast', { success: true, submitted: false }, false, 0],
    ['/compact', { success: true, submitted: true }, false, 0],
    ['/fast', { success: true, submitted: true }, false, 1],
    ['/fast', { success: true, submitted: true }, true, 1],
  ]) {
    const events = [], warnings = [];
    const fn = vm.runInNewContext(main.slice(begin, end) + '\nsendCodexLiveSlashCommand', {
      codexTurnWatchers: new Map(), console: { log() {}, warn: line => warnings.push(line) },
      sendCodexSlashCommand: async () => transport,
      emitAgentReadinessChanged: (tabId, detail) => { events.push({ tabId, ...detail }); if (throws) throw Error('fixture IPC gone'); },
    });
    const outcome = await fn({}, { tabId: 'T', command, hasDraft: false });
    assert.strictEqual(outcome, transport); assert.equal(events.length, count);
    if (events.length) {
      assert.equal(events[0].status, 'changed'); assert.equal(events[0].toolType, 'codex');
      assert.equal(events[0].reason, 'fast-command-settled'); assert.equal(events[0].inputReady, undefined);
    }
    assert.equal(warnings.length, throws ? 1 : 0);
  }
});
