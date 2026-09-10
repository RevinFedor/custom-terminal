'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { classifyCodexTurnRecord, isCodexInputReadyTurnEndEvent } = require('./codex-turn-outcome');
const { createTerminalIncidentReporter } = require('./terminal-incident-reporting');
const { createCompactOperationRegistry, classifyCodexCompactEvidence,
  projectCodexCompactTurnOutcome } = require('./compact-operation-state');
const { classifyManualCodexQueueInterruptOutcome } = require('./codex-manual-queue-interrupt');

const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const start = source.indexOf('function processCodexTurnLine(');
const end = source.indexOf('function inferCodexBusyFromText(', start);
assert.ok(start >= 0 && end > start);
const liveHandler = source.slice(start, end);
const noop = () => {};

function harness(overrides = {}) {
  const terminal = {};
  const state = {
    tabId: 'tab', sessionId: 'writer', filePath: '/fixture/rollout.jsonl',
    busy: false, currentTurnId: null, offset: 1000, eventSequence: 0,
    processGeneration: 'pty:3', processGenerationBoundaryOffset: 100,
    capacityRetryLiveAfterOffset: 100, sourceObservationTerminal: terminal,
    sourceObservationRunSeq: 3, catchUpGeneration: 1,
    ...overrides,
  };
  const packets = [];
  const notifications = [];
  const publications = [];
  const context = {
    classifyCodexTurnRecord, isCodexInputReadyTurnEndEvent, projectCodexCompactTurnOutcome,
    compactOperations: createCompactOperationRegistry(),
    console: { log() {}, warn() {}, error() {} },
    mainWindow: null,
    terminals: new Map([['tab', terminal]]),
    terminalCommandState: new Map([['tab', { runSeq: 3, isRunning: true }]]),
    codexTurnWatchers: new Map([['tab', state]]),
    codexLastRunCommandPayload: new Map([['tab', { launchId: 'launch-3' }]]),
    codexPromptGeneration: new Map(),
    codexManualQueueInterrupts: new Map(),
    classifyManualCodexQueueInterruptOutcome,
    getTerminalInputRevision: () => 0,
    codexOutcomeTimestampMs: value => Date.parse(value),
    codexModelCapacityWatches: new Map(),
    getTerminalLifecycleGeneration: () => 'pty:3',
    recordCodexLiveSubagentOwnership: noop,
    trackCodexTabSubagentActivity: noop,
    codexEventType: record => record.type === 'event_msg' ? record.payload?.type : null,
    observeCodexCapacityRetryRecord: noop,
    buildCodexLiveRawMessage: () => null,
    buildCodexHistoryLiveCompactEntry: () => null,
    emitCodexHistoryLiveTurnBoundary: noop,
    classifyCodexCompactEvidence,
    codexLiveSourceIdentity: (_state, record, label) => label + ':' + record.__byteOffset,
    reconcileCodexManualCompactPendingOwner: () => null,
    clearCodexLifecycleWarning: noop,
    armCodexModelCapacityWatch: noop,
    terminalHistoryPreviewController: { begin: noop, finish: noop },
    clearCodexPromptInFlight: noop,
    finishCodexStartupLifecycle: noop,
    markCodexTuiReadyFromTurnEnd: noop,
    applyCodexWatcherOutcome: (_state, outcome) => {
      state.lastOutcomeReason = outcome.reason;
      state.lastOutcomeTurnId = outcome.turnId;
    },
    emitCodexBusy: (_tabId, busy, reason, detail) => publications.push({ busy, reason, turnId: detail.turnId }),
    getPendingCodexPasteAudits: () => [],
  };
  context.reportTerminalIncident = createTerminalIncidentReporter({
    capture: payload => {
      packets.push({ payload, busyAtCapture: state.busy, currentTurnAtCapture: state.currentTurnId });
      return { artifactPath: '/fixture/incident.json' };
    },
    notify: detail => notifications.push(detail),
  });
  vm.createContext(context);
  vm.runInContext(liveHandler, context);
  const process = (event, turnId, offset = 200, extra = {}) => {
    context.processCodexTurnLine(state, JSON.stringify({
      type: 'event_msg', timestamp: '2026-09-09T12:00:00.000Z',
      payload: { type: event, turn_id: turnId, ...extra },
    }), offset);
  };
  return { context, state, terminal, packets, notifications, publications, process };
}

test('actual live parser publishes successful owned compact without inventing a final answer or disarming Run after', async () => {
  const { isNaturalAgentTurnEndReason } = await import('../renderer/utils/agentCompletionOutcome.mjs');
  const h = harness();
  h.process('task_started', 'compact-turn', 150);
  h.context.compactOperations.begin({ tabId: 'tab', provider: 'codex', operationId: 'compact-op',
    sessionId: 'writer', generation: 'pty:3', terminal: h.terminal,
    command: '/compact', sourceByteOffset: 150, source: 'programmatic-live-slash' });
  h.context.processCodexTurnLine(h.state, JSON.stringify({ type: 'compacted',
    timestamp: '2026-09-10T09:34:05.300Z', payload: { message: 'compact capsule' } }), 200);
  assert.equal(h.context.compactOperations.getActive('tab').codexCompactedOffset, 200);
  h.process('task_complete', 'compact-turn', 300, { last_agent_message: null });
  const end = h.publications.at(-1);
  assert.equal(end.reason, 'task_complete', JSON.stringify({ state: h.state, op: h.context.compactOperations.getActive('tab') }));
  assert.equal(isNaturalAgentTurnEndReason(end.reason), true, 'the real Run after predicate permits continuation');
  assert.equal(h.state.lastOutcomeReason, 'task_complete');
  const settled = h.context.compactOperations.finalizeCodexTaskComplete({ tabId: 'tab', provider: 'codex',
    operationId: 'compact-op', sessionId: 'writer', generation: 'pty:3' });
  assert.equal(settled.outcome, 'completed');
});

for (const patch of [
  { name: 'no compact record', noRecord: true },
  { name: 'another generation', generation: 'other' },
  { name: 'another session', sessionId: 'other' },
  { name: 'another turn', turnId: 'other' },
]) {
  test(`owned compact exception cannot hide real missing result: ${patch.name}`, async () => {
    const h = harness();
    h.process('task_started', 'T', 150);
    h.context.compactOperations.begin({ tabId: 'tab', provider: 'codex', operationId: 'C',
      sessionId: patch.sessionId || 'writer', generation: patch.generation || 'pty:3',
      terminal: h.terminal, command: '/compact', sourceByteOffset: 150,
      turnId: patch.turnId || 'T' });
    if (!patch.noRecord) h.context.compactOperations.observeCodexEvidence({ tabId: 'tab', provider: 'codex',
      operationId: 'C', sessionId: patch.sessionId || 'writer', generation: patch.generation || 'pty:3',
      kind: 'compacted', rolloutOffset: 200 });
    h.process('task_complete', 'T', 300, { last_agent_message: null });
    assert.equal(h.publications.at(-1).reason, 'codex-no-final-result');
  });
}

test('O2 actual live handler captures the mismatch before changing busy and retains the existing outcome', async () => {
  const h = harness();
  h.process('task_started', 'T2', 150);
  h.process('task_complete', 'T1', 300, { last_agent_message: 'private final text', attachments: [{ data: 'private base64' }] });
  assert.equal(h.packets.length, 1);
  const packet = h.packets[0];
  assert.equal(packet.busyAtCapture, true);
  assert.equal(packet.currentTurnAtCapture, 'T2');
  assert.equal(packet.payload.incidentReason, 'codex-turn-identity-contradiction');
  assert.equal(packet.payload.context.launchId, 'launch-3');
  assert.equal(packet.payload.context.lifecycleGeneration, 'pty:3');
  assert.equal(packet.payload.context.sessionId, 'writer');
  assert.equal(packet.payload.context.record.turnId, 'T1');
  assert.equal(packet.payload.context.record.byteOffset, 300);
  assert.equal(packet.payload.context.record.eventSequence, 2);
  assert.equal(packet.payload.context.previous.currentTurnId, 'T2');
  assert.equal(packet.payload.context.previous.lastEventType, 'task_started');
  assert.doesNotMatch(JSON.stringify(packet.payload), /private final text|private base64/);
  assert.equal(h.state.busy, false);
  assert.deepEqual(h.publications.at(-1), { busy: false, reason: 'task_complete', turnId: 'T1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notifications.length, 1);
});

for (const [label, overrides, change, offset] of [
  ['public suppression', { publicTurnStateSuppressed: true }],
  ['catch-up suppression', { catchUpPublicationsSuppressed: true }],
  ['manual binding conflict', { manualBindingConflict: {} }],
  ['pending copied history catch-up', { catchUpPending: true, capacityRetryLiveAfterOffset: 400 }, null, 300],
  ['deferred copied history', { deferredUntilComposer: true }],
  ['unproven Resume source', { sourceObservationLaunchId: 'source-launch' }],
  ['older process generation', { processGeneration: 'pty:2' }],
  ['different terminal', { sourceObservationTerminal: {} }],
  ['replaced watcher', {}, h => h.context.codexTurnWatchers.set('tab', {})],
  ['before process boundary', { processGenerationBoundaryOffset: 400 }, null, 300],
  ['copied bytes before live EOF', { capacityRetryLiveAfterOffset: 400 }, null, 300],
  ['missing byte proof', {}, null, null],
  ['missing process boundary', { processGenerationBoundaryOffset: null }],
  ['missing live boundary', { capacityRetryLiveAfterOffset: null }],
]) {
  test(`O2 actual handler does not alert for ${label}`, () => {
    const h = harness({ busy: true, currentTurnId: 'T2', ...overrides });
    change?.(h);
    h.process('task_complete', 'T1', offset === undefined ? 300 : offset);
    assert.deepEqual(h.packets, []);
    assert.equal(h.state.busy, false); // The production outcome is intentionally unchanged.
  });
}

test('O2 matching and missing explicit turn ids do not emit incidents', () => {
  for (const turnId of ['T2', null, '']) {
    const h = harness({ busy: true, currentTurnId: 'T2' });
    h.process('turn_aborted', turnId, 300);
    assert.deepEqual(h.packets, []);
    assert.equal(h.state.busy, false);
  }
});

test('O2 fresh post-EOF live records remain observable while a separate historical tail read is pending', () => {
  const h = harness({ catchUpPending: true });
  h.process('task_started', 'T2', 150);
  h.process('turn_aborted', 'T1', 300);
  assert.equal(h.packets.length, 1);
  assert.equal(h.packets[0].payload.context.catchUpPending, true);
  assert.equal(h.packets[0].payload.context.record.byteOffset, 300);
  assert.equal(h.state.busy, false);
});

test('O2 exact watcher/turn/byte retry shares one packet regardless of rescan sequence', async () => {
  const h = harness({ busy: true, currentTurnId: 'T2' });
  h.process('turn_aborted', 'T1', 300);
  h.state.busy = true;
  h.process('turn_aborted', 'T1', 300);
  assert.equal(h.packets.length, 1);
  h.state.busy = true;
  h.process('turn_aborted', 'T1', 400);
  assert.equal(h.packets.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notifications.length, 2);
});

test('O2 a throwing real-handler reporter cannot strand or reclassify the turn', () => {
  const h = harness({ busy: true, currentTurnId: 'T2' });
  h.context.reportTerminalIncident = () => { throw Error('capture failed'); };
  assert.doesNotThrow(() => h.process('task_complete', 'T1', 300, { last_agent_message: 'retained final' }));
  assert.equal(h.state.busy, false);
  assert.deepEqual(h.publications.at(-1), { busy: false, reason: 'task_complete', turnId: 'T1' });
});
