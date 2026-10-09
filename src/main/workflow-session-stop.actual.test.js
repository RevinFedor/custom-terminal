'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createWorkflowSessionStop, createSdkStopObservation, observeSdkStopMessage } = require('./workflow-session-stop');
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const member = (tabId, extra = {}) => ({ tabId, subjectVersion: 2,
  executionSubject: { version: 2, tabId, subjectId: 'S-' + tabId, executionNamespace: 'NS-' + tabId, cwd: '/fixture' },
  membership: { workflowId: 'work', revision: 1 }, executionResolved: true,
  nativeRow: { id: tabId, tab_type: 'terminal', execution_archived: 0 }, ...extra });

function fixture(rows = [member('A'), member('B')], ports = {}) {
  const records = new Map(rows.map(row => [row.tabId, row]));
  const owners = new Map(rows.map(row => [row.tabId, { token: {}, kind: 'ai', live: true, runSeq: 1 }]));
  const busy = new Set(), calls = [];
  const organization = { ready: () => true, service: {
    getWorkflow: id => id === 'work' ? { id } : null,
    listMembers: () => [...records.values()], getTab: id => records.get(id),
  } };
  const controller = createWorkflowSessionStop({ organization, captureOwner: row => ({ ...owners.get(row.tabId) }),
    sameOwner: (a, b) => b.live && a.token === b.token && a.runSeq === b.runSeq,
    readBusy: id => ({ known: true, busy: busy.has(id) }), observe: async () => ({ known: true }),
    stop: async (id, owner, proof, guard) => {
      const verdict = guard();
      if (!verdict.allowed) return { success: false, guardRejected: true, error: verdict.reason };
      calls.push([id, records.get(id).executionSubject.executionNamespace]); return { success: true };
    }, ...ports });
  return { controller, records, owners, busy, calls, organization };
}

test('idle excludes own/child/local/unknown busy while all includes all live exact workflow members', async () => {
  const rows = ['idle', 'own', 'child', 'preparing', 'unknown', 'reserve', 'hidden'].map(id => member(id));
  rows.push(member('foreign', { membership: { workflowId: 'other', revision: 1 } }));
  rows.push(member('file', { nativeRow: { id: 'file', tab_type: 'file' } }));
  rows.push(member('archive', { nativeRow: { id: 'archive', execution_archived: 1 } }));
  const f = fixture(rows, { readBusy: id => ({ known: id !== 'unknown', busy: ['own', 'child'].includes(id) }) });
  const idle = await f.controller({ workflowId: 'work', mode: 'idle', busyTabIds: ['preparing'] });
  assert.equal(idle.stoppedCount, 3); assert.equal(idle.skippedCount, 4);
  assert.deepEqual(f.calls.map(call => call[0]), ['idle', 'reserve', 'hidden']);
  f.calls.length = 0;
  const all = await f.controller({ workflowId: 'work', mode: 'all' });
  assert.equal(all.stoppedCount, 7); assert.equal(all.failedCount, 0);
  assert.ok(f.calls.every(([id, namespace]) => namespace === 'NS-' + id));
});

test('idle→busy at the process observation or final signal boundary never stops or admits', async () => {
  let f;
  f = fixture([member('A')], { observe: async () => { f.busy.add('A'); return { known: true }; } });
  assert.equal((await f.controller({ workflowId: 'work', mode: 'idle' })).skippedCount, 1);
  assert.equal(f.calls.length, 0);
  f = fixture([member('A')], { stop: async (id, owner, proof, guard) => {
    f.busy.add(id); const verdict = guard(); assert.equal(verdict.allowed, false);
    return { success: false, guardRejected: true, error: verdict.reason };
  } });
  assert.equal((await f.controller({ workflowId: 'work', mode: 'idle' })).skippedCount, 1);
});

test('replacement/run change/membership move/subject change after capture are not retargeted', async () => {
  for (const change of [f => { f.owners.get('A').token = {}; }, f => { f.owners.get('A').runSeq++; },
    f => { f.records.get('A').membership = { workflowId: 'other', revision: 2 }; },
    f => { f.records.get('A').membership.revision++; },
    f => { f.records.get('A').executionSubject.subjectId = 'replacement'; }]) {
    let f;
    f = fixture([member('A')], { observe: async () => { change(f); return { known: true }; } });
    const result = await f.controller({ workflowId: 'work', mode: 'all' });
    assert.equal(result.skippedCount, 1); assert.equal(f.calls.length, 0);
  }
});

test('same-mode double click joins one frozen flight; other mode cannot expand it and new members wait for a new action', async () => {
  const gate = deferred(); let f;
  f = fixture([member('A')], { observe: async () => { await gate.promise; return { known: true }; } });
  const first = f.controller({ workflowId: 'work', mode: 'idle' });
  assert.equal(f.controller({ workflowId: 'work', mode: 'idle' }), first);
  assert.equal((await f.controller({ workflowId: 'work', mode: 'all' })).error, 'workflow_stop_in_progress');
  f.records.set('late', member('late')); f.owners.set('late', { token: {}, kind: 'ai', live: true, runSeq: 1 });
  gate.resolve(); const result = await first;
  assert.equal(result.stoppedCount, 1); assert.deepEqual(f.calls.map(call => call[0]), ['A']);
});

test('process lookup unknown and partial errors are explicit; stop workers are bounded', async () => {
  let active = 0, max = 0;
  const f = fixture(Array.from({ length: 12 }, (_, index) => member(String(index))), {
    observe: async id => {
      active++; max = Math.max(max, active); await Promise.resolve(); active--;
      return { known: id !== '0' };
    }, stop: async id => {
      if (id === '1') throw new Error('private-port-failure');
      return { success: true };
    },
  });
  const result = await f.controller({ workflowId: 'work', mode: 'all' });
  assert.equal(result.success, false); assert.equal(result.failedCount, 2); assert.equal(result.stoppedCount, 10);
  assert.ok(max <= 4); assert.equal(result.results.length, 12);
});

test('SDK idle observation uses exact warm/channel/result/compact/background events', () => {
  const state = createSdkStopObservation(true);
  assert.equal(state.busy, false);
  observeSdkStopMessage(state, { type: 'assistant' }); assert.equal(state.busy, true);
  observeSdkStopMessage(state, { type: 'result' }); assert.equal(state.busy, false);
  observeSdkStopMessage(state, { type: 'system', subtype: 'task_started', task_id: 'bg' });
  assert.equal(state.tasks.size, 1);
  observeSdkStopMessage(state, { type: 'system', subtype: 'task_notification', task_id: 'bg', status: 'unknown' });
  assert.equal(state.tasks.size, 1);
  observeSdkStopMessage(state, { type: 'system', subtype: 'task_notification', task_id: 'bg', status: 'completed' });
  assert.equal(state.tasks.size, 0);
  observeSdkStopMessage(state, { type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(state.operational, true);
  observeSdkStopMessage(state, { type: 'system', subtype: 'compact_boundary' });
  assert.equal(state.operational, false);
});

function actualFunctions(names) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name); return node.getText(tree);
  }).join('\n');
}

function mainFixture() {
  const source = fs.readFileSync(path.join(__dirname, 'agent-process-stop-main.integration.test.js'), 'utf8');
  // Reuse the existing Main/HTTP fixture, including the actual extracted Stop
  // functions. Suppress its test registration, not any production statement.
  const context = vm.createContext({ __dirname, require, process, console: quiet, Buffer, Map, Set, setTimeout, clearTimeout });
  vm.runInContext(source.slice(0, source.indexOf("test('actual HTTP")) + '\nglobalThis.makeFixture=fixture;', context);
  return context.makeFixture();
}

test('actual low-level Main Stop refuses final idle guard without compact/queue/runtime/input side effects', async () => {
  const h = mainFixture(); h.release(); let compact = 0, admitted = 0;
  h.ctx.cancelCodexManualCompactPending = () => compact++;
  const result = await h.ctx.stopAiProcessInTabSerialized('T', { toolType: 'claude', reason: 'manual-workflow-stop',
    preSignalGuard: () => ({ allowed: false, reason: 'workflow_stop_became_busy' }), onStopAdmitted: () => admitted++ });
  assert.equal(result.guardRejected, true); assert.equal(compact, 0); assert.equal(admitted, 0);
  assert.equal(h.queueCancellations.length, 0); assert.equal(h.events.length, 0);
  assert.equal(h.writes.length, 0); assert.equal(h.signals.length, 0);
});

test('actual admitted Main Stop preserves graceful/escalation/audit and cancels once after final proof', async () => {
  const h = mainFixture(); h.release(); let compact = 0, admitted = 0;
  h.ctx.cancelCodexManualCompactPending = () => compact++;
  const result = await h.ctx.stopAiProcessInTabSerialized('T', { toolType: 'claude', reason: 'manual-workflow-stop',
    preSignalGuard: () => ({ allowed: true }), onStopAdmitted: () => { admitted++; h.queueCancellations.push('owned-stop'); } });
  assert.equal(result.success, true); assert.equal(compact, 1); assert.equal(admitted, 1);
  assert.deepEqual(Array.from(h.writes), ['\x03']); assert.deepEqual(Array.from(h.signals), ['SIGTERM', 'SIGKILL']);
  assert.ok(h.events.includes('final-audit')); assert.equal(h.queueCancellations.length, 1);
});

test('actual SDK hard Stop protects replacement during interrupt, while warm idle still hard-closes', async () => {
  const code = actualFunctions(['stopSdkSession']);
  for (const replacement of [false, true]) {
    const effects = []; const session = { query: { interrupt: async () => {
      effects.push('interrupt'); if (replacement) context.sdkSessions.set('T', {});
    }, close: () => effects.push('close') }, stopObservation: createSdkStopObservation(true),
      channel: { end: () => effects.push('end') }, abortController: { abort: () => effects.push('abort') } };
    const context = vm.createContext({ console: quiet, sdkSessions: new Map([['T', session]]), jsonlWatchers: new Map(),
      setTimeout: resolve => { resolve(); }, _webBroadcast() {}, BrowserWindow: { getAllWindows: () => [] },
      stopJsonlWatcher: () => effects.push('watcher-stop') });
    vm.runInContext(code, context);
    const result = await context.stopSdkSession({ tabId: 'T', hard: true }, { expectedSession: session,
      guard: () => ({ allowed: true }), onStopAdmitted: () => effects.push('admit') });
    assert.equal(result.success, !replacement);
    assert.equal(effects.includes('close'), !replacement); assert.equal(effects.includes('watcher-stop'), !replacement);
    assert.equal(context.sdkSessions.has('T'), replacement);
  }
});

test('actual script Stop rechecks after lookup before any command cancellation/input/signal', async () => {
  const effects = [], token = { pid: 10, write: () => effects.push('input') }; let valid = true;
  const context = vm.createContext({ console: quiet, terminals: new Map([['T', token]]), terminalProjects: new Map(),
    terminalCommandAdmission: { cancel: () => effects.push('command-cancel') }, terminalCommandStops: new Map(),
    useUIStore_freePortsToggle: () => false, mainWindow: null,
    findDescendantPids: async () => { valid = false; return [11]; } });
  vm.runInContext(actualFunctions(['deterministicStopTerminal', 'performDeterministicStopTerminal']), context);
  const result = await context.deterministicStopTerminal('T', false, {
    preSignalGuard: () => ({ allowed: valid, reason: 'owner-changed' }), onStopAdmitted: () => effects.push('admit') });
  assert.equal(result.guardRejected, true); assert.deepEqual(effects, []); assert.equal(context.terminalCommandStops.size, 0);
});

test('actual Main adapter routes SDK/PTY/script to their existing owners and guards exact process identity', async () => {
  const effects = [], identity = { terminalLifecycleGeneration: 'G', terminalRunSeq: 1, inputRevision: 2,
    processStatus: 'found', processPid: 11, processName: 'codex', sessionId: 'S' };
  const context = vm.createContext({ console: quiet, path, srcMainDir: __dirname,
    require: () => ({ cancelQueuedAgentSends: () => effects.push('cancel-owned') }),
    compareAiLifecycleIdentity: require('./ai-lifecycle-authority').compareAiLifecycleIdentity,
    stopSdkSession: async request => { effects.push(['sdk', request.hard]); return { success: true }; },
    deterministicStopTerminal: async (_id, restart, options) => {
      assert.equal(restart, false); assert.equal(options.preSignalGuard().allowed, true);
      options.onStopAdmitted(); effects.push('script'); return { success: true };
    }, stopAiProcessInTabSerialized: async (_id, options) => {
      assert.equal(options.reason, 'manual-stop', 'Prompt Queue/Restart after retain the existing explicit Manual Stop meaning');
      assert.equal(options.preSignalGuard({ ...identity, processPid: 999 }).allowed, false);
      assert.equal(options.preSignalGuard(identity).allowed, true);
      options.onStopAdmitted(); effects.push(['ai', options.toolType]); return { success: true };
    } });
  vm.runInContext(actualFunctions(['stopWorkflowSessionTarget']), context);
  for (const owner of [{ kind: 'ai', toolType: 'codex' }, { kind: 'terminal' },
    { kind: 'sdk', token: { stopObservation: createSdkStopObservation(true) } }]) {
    assert.equal((await context.stopWorkflowSessionTarget('T', owner, { identity }, () => ({ allowed: true }))).success, true);
  }
  assert.deepEqual(effects, ['cancel-owned', ['ai', 'codex'], 'cancel-owned', 'script', ['sdk', true]]);
});

test('actual Main idle/owner capture distinguishes SDK warm idle, pending channel, child/own work and replacement', () => {
  let inherited = [], own = false, pending = [], revision = 2;
  const context = vm.createContext({ console: quiet, path, srcMainDir: __dirname,
    sdkSessions: new Map(), terminals: new Map([['T', {}]]), terminalCommandState: new Map([['T', { isRunning: true }]]),
    resolveAiToolTypeForTab: () => 'codex', getLiveAiRuntimeOwners: () => ['codex'],
    currentAiLifecycleIdentity: () => ({ terminalLifecycleGeneration: 'G', terminalRunSeq: 1, inputRevision: revision }),
    codexLastRunCommandPayload: new Map([['T', { launchId: 'launch' }]]), claudeLaunchGenerationByTab: new Map(),
    require: () => ({ readInheritedTabActivity: () => ({ known: true, sourceTabIds: inherited }) }),
    agentSendActivity: { snapshot: () => ({ pendingTabIds: pending }) }, aiStoppingTabs: new Map(),
    computeProjectActivity: () => ({ projects: [{ tabs: [{ tabId: 'T', turnBusy: own, status: 'active' }] }] }),
  });
  vm.runInContext(actualFunctions(['captureWorkflowSessionOwner', 'sameWorkflowSessionOwner', 'readWorkflowSessionBusy']), context);
  const capture = () => context.captureWorkflowSessionOwner({ tabId: 'T' });
  const first = capture(); assert.equal(context.readWorkflowSessionBusy('T', first).busy, false);
  own = true; assert.equal(context.readWorkflowSessionBusy('T', first).busy, true); own = false;
  inherited = ['T']; assert.equal(context.readWorkflowSessionBusy('T', first).busy, true); inherited = [];
  pending = ['T']; assert.equal(context.readWorkflowSessionBusy('T', first).busy, true); pending = [];
  revision++; assert.equal(context.sameWorkflowSessionOwner(first, capture()), false);
  let queued = 0;
  const sdk = { stopObservation: createSdkStopObservation(true), channel: { pendingCount: () => queued } };
  context.sdkSessions.set('T', sdk);
  const sdkOwner = capture(); assert.equal(context.readWorkflowSessionBusy('T', sdkOwner).busy, false);
  queued++; assert.equal(context.readWorkflowSessionBusy('T', sdkOwner).busy, true); queued = 0;
  observeSdkStopMessage(sdk.stopObservation, { type: 'system', subtype: 'task_started', task_id: 'bg' });
  assert.equal(context.readWorkflowSessionBusy('T', sdkOwner).busy, true);
  sdk.stopObservation.inputRevision++; assert.equal(context.sameWorkflowSessionOwner(sdkOwner, capture()), false);
});
