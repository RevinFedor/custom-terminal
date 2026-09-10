'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const predicates = require('./codex-provider-preview');
const { projectCodexPublicRuntimeProjection } = require('./codex-runtime-contract');
const { shouldCreateHistoryResponseTiming } = require('./history-response-timings');

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
    publicTurnStateSuppressed: suppressed, catchUpPublicationsSuppressed: suppressed };
  const current = { terminalToken, runSeq: 1, lifecycleGeneration: 'terminal:1', launchId: null };
  const projections = [];
  const events = [];
  const timings = [];
  const context = {
    ...predicates,
    codexProviderSemanticSources: new Map([['T', owner]]),
    codexTurnWatchers: new Map([['T', watcher]]),
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
    console: { log() {}, warn() {} },
  };
  const names = ['publishCodexProviderTurnActivity', 'settleCodexProviderActivityFromWatcherOutcome', 'applyCodexWatcherOutcome', 'observeCodexProviderPreviewRawRecord'];
  const functions = vm.runInNewContext(names.map(part).join('\n') + '\n({' + names.join(',') + '})', context);
  return { ...functions, owner, watcher, current, projections, events, timings };
}

test('compact completion releases provider busy but cannot attach compact duration to an assistant answer', () => {
  const h = harness();
  h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false,
    reason: 'task_complete', hasFinalResult: false, completionKind: 'compact' },
  '2026-09-10T09:34:05.312Z', 'B', null);
  assert.equal(h.owner.turnActive, false);
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
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0][1].reason, 'task_complete');
    h.applyCodexWatcherOutcome(h.watcher, { event: 'task_complete', busy: false },
      '2026-09-05T01:12:26.837Z', 'B', null);
    assert.equal(h.events.length, 1, 'the same outcome does not settle the activity twice');
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
