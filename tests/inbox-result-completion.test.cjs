'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { _api: api } = require('../src/main/ipc/codex-data');
const { readInboxResult } = require('../src/main/inbox-result-reader');
const web = ts.createSourceFile('web-server.js', fs.readFileSync(path.join(__dirname, '../src/main/web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function harness({ ended = false, blocked = false } = {}) {
  const calls = [], envelopes = [], timers = [], warnings = [];
  const loadStarted = deferred(); const releaseLoad = deferred();
  const sid = 'completion-audit-session';
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-A' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'A question' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', turn_id: 'turn-A', content: [{ type: 'output_text', text: 'A answer' }] } },
  ].map((record, index) => ({ ...record, __line: index + 1, __byteOffset: index * 100, timestamp: '2026-09-07T00:00:00.000Z' }));
  const end = () => {
    if (records.at(-1).payload.type === 'task_complete') return;
    records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-A', last_agent_message: 'A answer' },
      __line: 4, __byteOffset: 300, timestamp: '2026-09-07T00:00:01.000Z' });
  };
  if (ended) end();
  const run = { runId: 'run-A', tabId: 'tab-A', provider: 'codex', conversationKey: 'chat-A', sessionId: sid,
    status: 'running', autoStopMs: 30_000, autoCloseMs: 60_000, stopTimer: null, closeTimer: null };
  const receipt = { runId: run.runId, tabId: run.tabId, provider: 'codex', surface: 'inbox', state: 'confirmed',
    attemptId: 'attempt-A', handoffId: 'handoff-A', auditIdentity: { provider: 'codex', attemptId: 'attempt-A',
      sessionId: sid, entryUuid: `codex-user-${sid}-2`, sourceIdentity: `codex-user-source-${sid}-100` } };
  const context = vm.createContext({
    Date, Map, Set, readInboxResult, DEFAULT_EXTERNAL_AUTO_CLOSE_MS: 60_000,
    externalRuns: new Map([[run.runId, run]]), externalRunByTabId: new Map([[run.tabId, run.runId]]),
    externalRunByConversationKey: new Map([[run.conversationKey, run.runId]]),
    agentSendReceiptStartupReady: Promise.resolve(),
    agentSendReceiptStore: { get(key) { calls.push(['receipt', key]); return receipt; } },
    findOrchestrationTabDescriptor: () => ({ cwd: '/test/project' }), findRestorableAgentTabDescriptor: () => null,
    loadCodexSessionRecords: async () => {
      calls.push(['load']); loadStarted.resolve(); if (blocked) await releaseLoad.promise;
      return { success: true, filePath: '/test/rollout', records };
    },
    codexDataApi: { ...api, projectCodexFullHistoryFromFile: async () => {
      calls.push(['project']); const projector = api.createCodexHistoryProjector(sid); records.forEach(projector.feed);
      return { success: true, filePath: '/test/rollout', entries: projector.finalize({ includeTurnCoordinates: true }) };
    } },
    transcriptService: null,
    bridgeRequest: async (action, payload) => { calls.push([action, plain(payload)]); return { ok: true }; },
    runAgentStopScenario: async (tabId) => { calls.push(['physical-stop', tabId]); return { success: true }; },
    setTimeout(callback, ms) { const ticket = { callback, ms, cancelled: false }; timers.push(ticket); return ticket; },
    clearTimeout(ticket) { ticket.cancelled = true; },
    console: { log() {}, warn(...args) { warnings.push(args); } },
    BCAST_LOG_TYPES: new Set(['busy', 'done']), withMessageProjection: (payload) => payload,
    stampPublicRuntimeSnapshot: (_tabId, payload) => payload,
    processOrchestrationLifecycle: async () => {}, shortId: (value) => value,
    summarizeBroadcastPayload: () => '', PROJECT_ACTIVITY_TOPIC: 'projects',
    subscribers: new Map([[run.tabId, new Set([{ isAlive: () => true, send: (message) => envelopes.push(JSON.parse(message)) }])]]),
  });
  for (const name of ['clampAutoStopMs', 'clampAutoCloseMs', 'setExternalRunMeta', 'clearExternalRunTimer', 'cleanupExternalRun',
    'scheduleExternalRunStop', 'scheduleExternalRunClose', 'scheduleExternalRunCompletionTimers',
    'getInboxResultResponse', 'refreshExternalRunCompletion', 'webBroadcast']) {
    const fn = web.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, `actual ${name} exists`); vm.runInContext(fn.getText(web), context);
  }
  return { context, run, calls, envelopes, timers, warnings, end, loadStarted, releaseLoad };
}
const notifications = (h) => h.envelopes.filter((event) => event.type === 'inbox-result');
const physicalCalls = (h) => h.calls.filter(([kind]) => kind === 'physical-stop' || kind === 'closeTab');

test('pending result and a done event from another turn do not complete or arm cleanup', async () => {
  const h = harness();
  await h.context.refreshExternalRunCompletion(h.run);
  h.run.observedTerminal = { type: 'done', reason: 'interrupt', sessionId: 'completion-audit-session', turnId: 'other-turn' };
  await h.context.refreshExternalRunCompletion(h.run);
  assert.equal(h.run.completionStamp, undefined);
  assert.equal(h.timers.length, 0);
  assert.equal(notifications(h).length, 0);
  assert.equal(h.run.status, 'running');
  assert.deepEqual(h.warnings, []);
});

test('exact end stamps completion and publishes/arms once despite repeated reads and done events', async () => {
  const h = harness(); await h.context.refreshExternalRunCompletion(h.run);
  h.end(); await h.context.refreshExternalRunCompletion(h.run);
  assert.equal(h.run.completionStamp, 'attempt-A:turn-A');
  assert.equal(h.run.status, 'done');
  assert.equal(h.timers.length, 2);
  assert.equal(notifications(h).length, 1);
  const loads = h.calls.filter(([kind]) => kind === 'load').length;
  await h.context.refreshExternalRunCompletion(h.run);
  h.context.webBroadcast(h.run.tabId, { type: 'done', reason: 'task_complete', sessionId: h.run.sessionId, turnId: 'turn-A' });
  await h.context.getInboxResultResponse(h.run.runId, false);
  assert.equal(h.timers.length, 2);
  assert.equal(notifications(h).length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'load').length, loads + 1, 'explicit GET reads, duplicate completion wakes do not');
});

test('new run ownership during the awaited read discards a late completed result', async () => {
  for (const replaceSameRunId of [false, true]) {
    const h = harness({ ended: true, blocked: true });
    const finishing = h.context.refreshExternalRunCompletion(h.run);
    await h.loadStarted.promise;
    const next = { ...h.run, runId: replaceSameRunId ? h.run.runId : 'run-B' };
    h.context.externalRuns.set(next.runId, next);
    h.context.externalRunByTabId.set(h.run.tabId, next.runId);
    h.releaseLoad.resolve(); await finishing;
    assert.equal(h.run.completionStamp, undefined);
    assert.equal(h.timers.length, 0);
    assert.equal(notifications(h).length, 0);
  }
});

test('a delayed busy event for the same exact turn cannot suppress completion cleanup', async () => {
  const h = harness({ ended: true, blocked: true });
  const finishing = h.context.refreshExternalRunCompletion(h.run);
  await h.loadStarted.promise;
  h.context.webBroadcast(h.run.tabId, {
    type: 'busy', busy: true, sessionId: h.run.sessionId, turnId: 'turn-A',
  });
  h.releaseLoad.resolve();
  await finishing;
  assert.equal(h.run.completionStamp, 'attempt-A:turn-A');
  assert.equal(h.run.status, 'done');
  assert.equal(h.timers.length, 2);
  assert.equal(notifications(h).length, 1);
});

test('a tab explicitly opened in Terminal remains user-owned after later exact completion', async () => {
  const h = harness({ ended: true });
  h.run.openedInTerminalAt = 42;
  h.run.cleanupCancelled = true;
  await h.context.refreshExternalRunCompletion(h.run);
  assert.equal(h.run.completionStamp, 'attempt-A:turn-A');
  assert.equal(h.run.status, 'done');
  assert.equal(h.run.cleanupCancelled, true);
  assert.equal(h.timers.length, 0);
  assert.equal(notifications(h).length, 1);
});

test('rewinding before or during a completion read cannot arm cleanup timers', async () => {
  const before = harness({ ended: true }); before.run.status = 'rewinding';
  await before.context.refreshExternalRunCompletion(before.run);
  assert.equal(before.calls.some(([kind]) => kind === 'load'), false);
  const during = harness({ ended: true, blocked: true });
  const finishing = during.context.refreshExternalRunCompletion(during.run);
  await during.loadStarted.promise; during.run.status = 'rewinding'; during.releaseLoad.resolve(); await finishing;
  assert.equal(during.timers.length, 0);
  assert.equal(notifications(during).length, 0);
});

test('cancelled, rewinding or stale timer callbacks cannot stop or close the current agent', async () => {
  for (const state of ['cancelled', 'rewinding', 'new-run-id', 'replaced-same-id']) {
    const h = harness({ ended: true }); await h.context.refreshExternalRunCompletion(h.run);
    if (state === 'cancelled') {
      h.run.cleanupCancelled = true;
      h.context.clearExternalRunTimer(h.run, 'stopTimer'); h.context.clearExternalRunTimer(h.run, 'closeTimer');
    } else if (state === 'rewinding') h.run.status = 'rewinding';
    else if (state === 'new-run-id') h.context.externalRunByTabId.set(h.run.tabId, 'run-B');
    else h.context.externalRuns.set(h.run.runId, { ...h.run });
    // Invoke even a cancelled ticket to exercise the callback's own late guard.
    for (const ticket of h.timers) await ticket.callback();
    assert.deepEqual(physicalCalls(h), [], state);
  }
});

test('live owned timers still stop and close, while an already closed owner cannot stop again', async () => {
  const h = harness({ ended: true }); await h.context.refreshExternalRunCompletion(h.run);
  await h.timers[0].callback(); await h.timers[1].callback();
  assert.deepEqual(physicalCalls(h).map(([kind]) => kind), ['physical-stop', 'closeTab']);
  assert.equal(h.context.externalRuns.has(h.run.runId), false);
  await h.timers[0].callback();
  assert.equal(physicalCalls(h).length, 2);
});

test('busy after completion cancels cleanup without downgrading the finished run or rearming on manual stop', async () => {
  const h = harness({ ended: true }); await h.context.refreshExternalRunCompletion(h.run);
  h.context.webBroadcast(h.run.tabId, { type: 'busy', busy: true, sessionId: 'new-live-writer' });
  assert.equal(h.run.status, 'done');
  assert.equal(h.run.cleanupCancelled, true);
  assert.ok(h.timers.every((ticket) => ticket.cancelled));
  h.context.webBroadcast(h.run.tabId, { type: 'done', reason: 'manual-stop', sessionId: 'new-live-writer', turnId: 'another-turn' });
  await h.context.refreshExternalRunCompletion(h.run);
  assert.equal(h.run.completionStamp, 'attempt-A:turn-A');
  assert.equal(h.timers.length, 2);
  assert.equal(notifications(h).length, 1);
  for (const ticket of h.timers) await ticket.callback();
  assert.deepEqual(physicalCalls(h), []);
});

test('first exact manual stop after busy arms only close, and that close is not cancelled by the old busy flag', async () => {
  const h = harness();
  h.context.webBroadcast(h.run.tabId, { type: 'busy', busy: true, sessionId: h.run.sessionId });
  h.run.observedTerminal = { type: 'done', reason: 'manual-stop', sessionId: h.run.sessionId, turnId: 'turn-A' };
  await h.context.refreshExternalRunCompletion(h.run);
  assert.equal(h.run.status, 'stopped');
  assert.equal(h.timers.length, 1, 'manual stop needs a close timer, not another physical stop');
  assert.equal(notifications(h).length, 1);
  await h.timers[0].callback();
  assert.deepEqual(physicalCalls(h).map(([kind]) => kind), ['closeTab']);
});
