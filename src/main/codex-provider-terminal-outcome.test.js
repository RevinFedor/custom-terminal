'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const predicates = require('./codex-provider-preview');
const { projectCodexPublicRuntimeProjection } = require('./codex-runtime-contract');
const { shouldCreateHistoryResponseTiming } = require('./history-response-timings');
const { createProviderSemanticShadow } = require('./provider-semantic-shadow');
const { TaskCompletionIntentRegistry, taskCompletionOutcomeMeta } = require('./task-completion-intent');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const part = name => {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert(start > 0 && end > start, name);
  return source.slice(start, end);
};

// Dev R1: B task_complete 2026-09-05T01:12:26.837Z, yet main projection
// 01:13:18 still busy and C refused. No tab-bound History raw consumer closed
// the provider flag. The canonical turn watcher must work without that UI.
function harness({ suppressed = false } = {}) {
  const terminalToken = {};
  const owner = { sourceId: 'source-current', launchId: 'launch-current', terminalToken,
    runSeq: 1, lifecycleGeneration: 'terminal:1', turnId: 'B', turnActive: true, phase: 'provider-response' };
  const watcher = { tabId: 'T', processGeneration: 'terminal:1',
    sourceObservationLaunchId: 'launch-current', busy: true,
    currentTurnId: 'B', lastEventType: 'task_started',
    publicTurnStateSuppressed: suppressed, catchUpPublicationsSuppressed: suppressed };
  const current = { terminalToken, runSeq: 1, lifecycleGeneration: 'terminal:1', launchId: null };
  const projections = [];
  const events = [];
  const timings = [];
  const previews = [];
  const prompts = new Map();
  const context = {
    ...predicates,
    codexProviderSemanticSources: new Map([['T', owner]]),
    codexTurnWatchers: new Map([['T', watcher]]),
    codexPromptInFlight: prompts,
    CODEX_PROMPT_IN_FLIGHT_TTL_MS: 60000,
    clearCodexPromptInFlight: tab => prompts.delete(tab),
    compactOperations: { getPending: () => null },
    isCodexStartupLifecycleFresh: () => false,
    getCodexWriterProofSnapshot: () => null,
    terminalHistoryPreviewController: { observeSemanticEvent: detail => previews.push(detail), finish() {} },
    currentCodexProviderSemanticOwnerContext: () => current,
    codexOutcomeTimestampMs: value => Date.parse(value),
    applyCodexWatcherAbnormalOutcome() {},
    shouldCreateHistoryResponseTiming,
    recordActivity: (...args) => timings.push(args),
    codexTurnStateSnapshot: state => ({ busy: state.busy }),
    publishCodexRuntimeProjection: () => projections.push(projectCodexPublicRuntimeProjection({
      liveLifecycle: true, turnBusy: watcher.busy || owner.turnActive, tuiInputReady: true,
    })),
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
    taskCompletionIntents: new TaskCompletionIntentRegistry(), taskCompletionOutcomeMeta,
    codexRuntimePolicies: null, getTerminalLifecycleGeneration: () => 'terminal:1',
    replayDeferredCodexPromptAuditExecutionContext() {}, discardDeferredCodexPromptAuditExecutionContexts() {},
    clearCodexMcpStartupWatchdog() {}, emitAgentReadinessChanged() {},
    getCodexPublicRuntimeProjection: () => ({ sessionStatus: 'active', inputReady: true }),
    getCodexRuntimeSessionId: () => 'S', getCombinedTabBackgroundWorkCount: () => 0,
    getCodexPublicWriterFields: () => ({}), _webBroadcast() {},
    console: { log() {}, warn() {} },
  };
  const names = ['publishCodexProviderTurnActivity', 'settleCodexProviderActivityFromWatcherOutcome', 'applyCodexWatcherOutcome', 'emitCodexBusy', 'observeCodexProviderPreviewRawRecord', 'codexProviderRequestCausalTurnSnapshot', 'authorizeCodexProviderMainRequest', 'handleCodexProviderSemanticEvent'];
  const functions = vm.runInNewContext(names.map(part).join('\n') + '\n({' + names.join(',') + '})', context);
  return { ...functions, owner, watcher, current, projections, events, timings, previews, prompts };
}

test('lost Rewind writer cannot lend old provider busy to a recap on another turn', () => {
  const h = harness();
  h.owner.threadId = 'child-thread';
  h.watcher.lastEventType = 'turn_aborted';
  h.watcher.currentTurnId = 'source-turn';
  // Production: provider activity wrote watcher.busy=true while the old
  // source watcher could no longer observe the child task_complete.
  const shadow = createProviderSemanticShadow({
    log: { log() {}, warn() {} },
    authorizeCodexMainRequest: h.authorizeCodexProviderMainRequest,
    onCodexSemanticEvent: h.handleCodexProviderSemanticEvent,
  });
  const connection = shadow.createCodexConnection({ tabId: 'T', sourceId: h.owner.sourceId });
  connection.observeClientFrame(JSON.stringify({ type: 'response.create',
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
      session_id: 'recap-thread', thread_id: 'recap-thread', turn_id: 'recap-turn', request_kind: 'turn',
    }) },
  }));
  connection.observeServerFrame(JSON.stringify({ type: 'response.output_text.delta', item_id: 'recap-item', delta: '{"recap":"summary"}' }));
  connection.observeServerFrame(JSON.stringify({ type: 'response.completed', response: { output: [] } }));
  assert.equal(shadow.snapshot('T')[0].providers.codex.mainRequests, 0);
  assert.deepEqual(h.previews, []);
  assert.equal(h.owner.turnId, 'B', 'side traffic cannot replace the unresolved real turn');
  assert.equal(h.owner.turnActive, true, 'no fabricated idle without canonical completion');
});

test('provider continuation needs the same turn/thread, fresh submit can admit the next turn once', () => {
  const h = harness();
  h.owner.threadId = 'child';
  h.watcher.lastEventType = 'turn_aborted';
  h.watcher.currentTurnId = 'source-turn';
  const allowed = (turnId, threadId = 'child') => h.authorizeCodexProviderMainRequest({ tabId: 'T', identity: { turnId, threadId, sessionId: threadId } }).allowed;
  assert.equal(allowed('B'), true, 'tool/retry segments of B survive pending writer adoption');
  assert.equal(allowed('B', 'foreign'), false);
  h.watcher.lastEventType = 'task_started';
  h.watcher.currentTurnId = 'B';
  assert.equal(allowed('B', 'foreign'), false, 'rollout busy cannot override a conflicting transport thread');
  h.watcher.lastEventType = 'turn_aborted';
  h.watcher.currentTurnId = 'source-turn';
  assert.equal(allowed('next'), false, 'generic busy is not authority for another turn');
  h.prompts.set('T', { startedAt: Date.now(), submitted: true });
  assert.equal(allowed('next'), true, 'new explicit submit remains supported before writer proof');
  h.handleCodexProviderSemanticEvent({ tabId: 'T', sourceId: h.owner.sourceId,
    event: { type: 'turn_started', turnId: 'next', threadId: 'child' } });
  assert.equal(allowed('next'), true);
  assert.equal(allowed('recap', 'side'), false, 'claimed submit cannot bootstrap a second unrelated request');
  h.watcher.lastEventType = 'task_complete';
  h.watcher.currentTurnId = 'next';
  h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', reason: 'task_complete', busy: false, hasFinalResult: true },
    '2026-09-23T23:22:51.111Z', 'next');
  assert.equal(h.owner.turnActive, false);
  assert.equal(h.watcher.busy, false);
  assert.equal(allowed('recap', 'side'), false);
});

test('compact completion releases provider busy but cannot attach compact duration to an assistant answer', () => {
  const h = harness();
  h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false,
    reason: 'task_complete', hasFinalResult: false, completionKind: 'compact' },
  '2026-09-10T09:34:05.312Z', 'B', null);
  assert.equal(h.owner.turnActive, false);
  assert.equal(h.events.length, 0, 'activity settlement leaves the complete terminal event to its owner');
  h.emitCodexBusy('T', false, 'task_complete', { turnId: 'B', timestamp: '2026-09-10T09:34:05.312Z',
    outcome: { event: 'task_complete', reason: 'task_complete', busy: false, hasFinalResult: false, completionKind: 'compact' } });
  assert.equal(h.events[0][1].reason, 'task_complete');
  assert.equal(h.watcher.lastOutcomeHasFinalResult, false);
  assert.equal(h.timings.at(-1)[3].responseTimingEligible, false);
});

test('live and suppressed/catch-up typed outcomes settle provider activity without History consumers', () => {
  for (const suppressed of [false, true]) {
    const h = harness({ suppressed });
    h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false, reason: 'task_complete', hasFinalResult: true },
      '2026-09-05T01:12:26.837Z', 'B', null);
    assert.equal(h.owner.turnActive, false);
    assert.equal(h.owner.phase, 'idle');
    assert.equal(h.watcher.busy, false);
    assert.equal(h.watcher.outcomeKnown, true);
    assert.deepEqual(h.projections, [{ sessionStatus: 'active', busy: false, inputReady: true }]);
    assert.equal(h.events.length, 0, 'settle cannot publish an incomplete busy edge, including suppressed catch-up');
    if (!suppressed) {
      h.emitCodexBusy('T', false, 'task_complete', { turnId: 'B', timestamp: '2026-09-05T01:12:26.837Z',
        outcome: { event: 'task_complete', busy: false, reason: 'task_complete', hasFinalResult: true } });
      assert.equal(h.events[0][1].reason, 'task_complete');
    }
    h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false },
      '2026-09-05T01:12:26.837Z', 'B', null);
    assert.equal(h.events.length, suppressed ? 0 : 1, 'the same outcome does not settle the activity twice');
  }
});

test('Run After receives semantic watcher outcomes, not a producer label or generic task_complete', async () => {
  const { isNaturalAgentTurnEndReason, isRecoverableAgentTurnInterruption } = await import('../renderer/utils/agentCompletionOutcome.mjs');
  for (const [event, reason, natural, recoverable] of [
    ['task_complete', 'task_complete', true, false],
    ['task_complete', 'codex-no-final-result', false, false],
    ['task_complete', 'model-capacity', false, false],
    ['turn_aborted', 'turn_aborted', false, true],
  ]) {
    const h = harness();
    h.applyCodexWatcherOutcome(h.watcher, { event, reason, busy: false, hasFinalResult: natural },
      '2026-09-06T23:16:30.657Z', 'B', null);
    assert.equal(h.events.length, 0);
    h.emitCodexBusy('T', false, reason, { turnId: 'B', timestamp: '2026-09-06T23:16:30.657Z',
      outcome: { event, reason, busy: false, hasFinalResult: natural } });
    const delivered = h.events[0]?.[1];
    assert.equal(delivered.reason, reason);
    assert.equal(isNaturalAgentTurnEndReason(delivered.reason), natural);
    assert.equal(isRecoverableAgentTurnInterruption(delivered.reason), recoverable);
  }
});

test('delayed History lifecycle cannot reactivate B or clear a newer genuine C', () => {
  const h = harness();
  h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false }, '2026-09-05T01:12:26.837Z', 'B', null);
  const historyEvent = type => ({ tabId: 'T', toolType: 'codex', message: { type: 'event_msg', payload: { type, turn_id: 'B' } } });
  assert.equal(h.observeCodexProviderPreviewRawRecord(historyEvent('task_started')), false);
  assert.equal(h.owner.turnActive, false);
  assert.equal(h.publishCodexProviderTurnActivity({ tabId: 'T', sourceId: 'source-current', active: true, turnId: 'C' }), true);
  assert.equal(h.owner.turnActive, true, 'the source stays usable for a genuinely new provider request');
  h.observeCodexProviderPreviewRawRecord(historyEvent('task_complete'));
  h.settleCodexProviderActivityFromWatcherOutcome(h.watcher, { event: 'task_complete', busy: false }, 'B');
  assert.equal(h.owner.turnActive, true);
  assert.equal(h.owner.turnId, 'C');
});

test('typed settlement precedes live readiness projection and catch-up preserves its busy edge', () => {
  const live = part('processCodexTurnLine');
  const end = live.slice(live.indexOf('if (turnOutcome?.busy === false)'));
  assert(end.indexOf('applyCodexWatcherOutcome(') < end.indexOf('if (suppressPublications)'));
  assert(end.indexOf('applyCodexWatcherOutcome(') < end.indexOf('markCodexTuiReadyFromTurnEnd('));
  const catchStart = source.indexOf('async function catchUpCodexTurnState(');
  const catchEnd = source.indexOf('function processCodexTurnText(', catchStart);
  const catchUp = source.slice(catchStart, catchEnd);
  assert(catchUp.indexOf('const busyChanged = state.busy !== inferred.busy;') < catchUp.indexOf('applyCodexWatcherOutcome(state, inferred'));
  assert.doesNotMatch(part('observeCodexProviderPreviewRawRecord'), /publishCodexProviderTurnActivity/,
    'History consumers cannot be owners of any live activity transition');
});
