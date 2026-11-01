'use strict';
// Native/provider autocompact must continue Run after, exactly like an
// explicit `/compact` already did.
//
// Reproduced incident (production.log, 2026-10-31, tab-fa70e14d / mini
// orchestrator, Codex session ad6a2307-23cc-4979-90fa-1e5e11dbc7f2):
//
//   05:50:55.181  provider-compaction phase begins, command = null
//   05:53:49.551  compacted  -> operation finishes: completed / compacted
//                              proof codex-compacted-source-…-63779023
//   05:53:49.577  task_complete (no assistant final; normal for a compact)
//   05:53:49.618  published outcome = codex-no-final-result
//   05:53:49.786  PromptQueueRunner -> DISARM, preserveLoop=0
//
// Two independent reasons made the old projection refuse the proof:
//   1. `command !== '/compact'` — an autocompact carries no user command;
//   2. the operation had already settled 26 ms earlier, so the active slot was
//      empty by the time `task_complete` was classified.
// Byte offsets below are the real ones from that rollout.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCompactOperationRegistry,
  projectCodexCompactTurnOutcome,
} = require('./compact-operation-state');
const { classifyCodexTurnEvent } = require('./codex-turn-outcome');

const TAB = 'L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvY3VzdG9tLXRlcm1pbmFs-tab-fa70e14d';
const SESSION = 'ad6a2307-23cc-4979-90fa-1e5e11dbc7f2';
const GENERATION = '78626a39-b627-4749-9f94-27a4021216b8:2';
const TURN = '01a19082-cfef-7c23-85b2-52726df6';
const SOURCE_OFFSET = 63_777_850;
const COMPACTED_OFFSET = 63_779_023;
const TASK_COMPLETE_OFFSET = 72_444_032;

function taskCompleteRecord(overrides = {}) {
  return {
    type: 'event_msg',
    __byteOffset: TASK_COMPLETE_OFFSET,
    payload: { type: 'task_complete', turn_id: TURN, last_agent_message: null, ...overrides },
  };
}

// The real registry, driven through its public API in rollout order, so the
// settled shape under test is the one Main actually produces.
function settledAutocompact({ reason = 'compacted', outcome = 'completed' } = {}) {
  const registry = createCompactOperationRegistry();
  const observed = registry.observeProviderCompaction({
    tabId: TAB, provider: 'codex', requestKind: 'compaction',
    generation: GENERATION, providerSourceId: 'codex-provider:codex-1793425634668-15',
    providerRequestId: 'codex-2548',
    sessionId: SESSION, sourceByteOffset: SOURCE_OFFSET,
  });
  assert.ok(observed, 'provider compaction phase must register');
  assert.equal(observed.command, null, 'autocompact carries no user command');
  assert.equal(observed.source, 'provider-compaction');

  // Exactly what Main does on the rollout `compacted` record: this is the call
  // that records codexCompactedOffset and, for a provider phase, settles it.
  const finished = reason === 'compacted' && outcome === 'completed'
    ? registry.observeCodexEvidence({
      tabId: TAB, provider: 'codex', operationId: observed.operationId,
      sessionId: SESSION, generation: GENERATION,
      kind: 'compacted',
      rolloutOffset: COMPACTED_OFFSET, eventSequence: 34,
      proof: 'codex-compacted-source-' + SESSION + '-' + COMPACTED_OFFSET,
    })
    : registry.finish({
      tabId: TAB, provider: 'codex', operationId: observed.operationId,
      sessionId: SESSION, generation: GENERATION,
      outcome, reason,
      completionProof: 'codex-compacted-source-' + SESSION + '-' + COMPACTED_OFFSET,
      completionByteOffset: COMPACTED_OFFSET,
    });
  assert.ok(finished, 'compacted record must settle the phase');
  assert.equal(finished.active, false, 'phase is settled before task_complete arrives');
  assert.equal(finished.codexCompactedOffset, COMPACTED_OFFSET,
    'the settled operation must retain its compacted byte boundary');

  // Main reads it back from the registry ledger, as the repaired call site does.
  const settled = registry.snapshot(TAB, 'codex').settled;
  const latest = [...settled].reverse()
    .find(item => item.outcome === 'completed' && item.reason === 'compacted') || null;
  return { registry, operation: latest, observed, finished };
}

function projection(operation) {
  const terminal = {};
  const record = taskCompleteRecord();
  return {
    terminal, record, lifecycleGeneration: GENERATION,
    state: { tabId: TAB, sessionId: SESSION, currentTurnId: TURN, processGeneration: GENERATION },
    operation: operation ? { ...operation, terminal } : operation,
    outcome: classifyCodexTurnEvent('task_complete', record.payload),
  };
}

test('settled provider autocompact keeps Run after armed instead of no-final-result', () => {
  const { operation } = settledAutocompact();
  assert.ok(operation, 'the settled compacted operation must be retrievable from the ledger');

  const input = projection(operation);
  assert.equal(input.outcome.reason, 'codex-no-final-result',
    'the raw Codex event is still an abnormal end before projection');

  const result = projectCodexCompactTurnOutcome(input);
  assert.equal(result.reason, 'task_complete', 'a proven compact is a natural turn end');
  assert.equal(result.hasFinalResult, false, 'no assistant final answer is invented');
  assert.equal(result.completionKind, 'compact');
  assert.equal(result.compactOperationId, operation.operationId);
});

test('an active explicit /compact and an active autocompact both still qualify', () => {
  for (const operation of [
    { active: true, command: '/compact', source: null },
    { active: true, command: null, source: 'provider-compaction' },
  ]) {
    const result = projectCodexCompactTurnOutcome(projection({
      ...operation, provider: 'codex', operationId: 'C',
      tabId: TAB, sessionId: SESSION, generation: GENERATION,
      sourceByteOffset: SOURCE_OFFSET, codexCompactedOffset: COMPACTED_OFFSET,
    }));
    assert.equal(result.reason, 'task_complete',
      'command=' + operation.command + ' source=' + operation.source);
  }
});

test('an unproven, foreign, failed or mis-ordered compact never becomes success', () => {
  const { operation } = settledAutocompact();
  const cases = {
    // A settled operation is only trusted with its exact successful result.
    'settled but aborted': p => { p.operation.outcome = 'aborted'; },
    'settled but failed': p => { p.operation.outcome = 'failed'; },
    'settled with unknown outcome': p => { p.operation.outcome = 'unknown'; },
    'settled for another reason': p => { p.operation.reason = 'turn_aborted'; },
    // Identity guards.
    'another tab': p => { p.operation.tabId = TAB + '-other'; },
    'another session': p => { p.operation.sessionId = 'ffffffff-0000-0000-0000-000000000000'; },
    'another process generation': p => { p.operation.generation = 'other:9'; },
    'lifecycle moved on': p => { p.lifecycleGeneration = 'other:9'; },
    'another terminal object': p => { p.operation.terminal = {}; },
    'another turn': p => { p.state.currentTurnId = 'other-turn'; },
    'turn pinned elsewhere': p => { p.operation.turnId = 'other-turn'; },
    'another provider': p => { p.operation.provider = 'claude'; },
    // Neither a plain command nor a provider phase: no compact proof at all.
    'unrelated operation': p => { p.operation.command = '/model'; p.operation.source = null; },
    // Byte ordering: compacted must sit strictly between phase start and task end.
    'compacted at phase start': p => { p.operation.codexCompactedOffset = SOURCE_OFFSET; },
    'compacted after task_complete': p => { p.operation.codexCompactedOffset = TASK_COMPLETE_OFFSET + 1; },
    'compacted offset missing': p => { p.operation.codexCompactedOffset = null; },
    // A provider error in the same record is a real failure.
    'provider error on the record': p => { p.record.payload.error = { message: 'failed after compact' }; },
    // Other abnormal reasons keep their own meaning.
    'capacity outcome': p => { p.outcome.reason = 'model_capacity'; },
    'aborted outcome': p => { p.outcome.reason = 'turn_aborted'; },
    'no operation at all': p => { p.operation = null; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const input = projection({ ...operation, codexCompactedOffset: COMPACTED_OFFSET });
    mutate(input);
    assert.equal(projectCodexCompactTurnOutcome(input), input.outcome,
      label + ' must keep the original abnormal outcome');
  }
});

test('a stale older compact of the same tab cannot settle a newer turn', () => {
  // Same owner, but its compacted record lies before this phase's start: that
  // is a previous compact, not proof for the turn being classified now.
  const { operation } = settledAutocompact();
  const input = projection({
    ...operation,
    sourceByteOffset: COMPACTED_OFFSET + 1,
    codexCompactedOffset: COMPACTED_OFFSET,
  });
  assert.equal(projectCodexCompactTurnOutcome(input), input.outcome);
});
