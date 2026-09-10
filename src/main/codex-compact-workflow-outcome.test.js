'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { projectCodexCompactTurnOutcome } = require('./compact-operation-state');
const { classifyCodexTurnEvent } = require('./codex-turn-outcome');

function proof() {
  const terminal = {};
  const record = { type: 'event_msg', __byteOffset: 278209000,
    payload: { type: 'task_complete', turn_id: 'T', last_agent_message: null } };
  return { terminal, record, lifecycleGeneration: 'G',
    state: { tabId: 'tab754', sessionId: 'S', currentTurnId: 'T', processGeneration: 'G' },
    operation: { active: true, command: '/compact', provider: 'codex', operationId: 'C',
      tabId: 'tab754', sessionId: 'S', generation: 'G', terminal,
      sourceByteOffset: 272397939, codexCompactedOffset: 272399050 },
    outcome: classifyCodexTurnEvent('task_complete', record.payload),
  };
}
test('explicit compact uses its durable result, never fabricates final-answer proof', () => {
  const p = proof();
  assert.equal(p.outcome.reason, 'codex-no-final-result');
  const result = projectCodexCompactTurnOutcome(p);
  assert.equal(result.reason, 'task_complete');
  assert.equal(result.hasFinalResult, false);
  assert.equal(result.completionKind, 'compact');
  assert.equal(result.compactOperationId, 'C');
});
test('telemetry alone, older/later compact, wrong owner or provider failure never become success', () => {
  for (const mutate of [
    p => { p.operation.codexCompactedOffset = null; },
    p => { p.operation.codexCompactedOffset = p.operation.sourceByteOffset; },
    p => { p.operation.codexCompactedOffset = p.record.__byteOffset + 1; },
    p => { p.operation.active = false; },
    p => { p.operation.command = '/model'; },
    p => { p.terminal = {}; },
    p => { p.state.currentTurnId = 'other'; },
    p => { p.record.payload.error = { message: 'failed after compact' }; },
    p => { p.outcome.reason = 'model_capacity'; },
    p => { p.outcome.reason = 'turn_aborted'; },
  ]) {
    const p = proof(); mutate(p);
    assert.equal(projectCodexCompactTurnOutcome(p), p.outcome);
  }
});

test('a late historical tail read cannot turn the same proven compact into an abnormal event', () => {
  const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
  const part = name => { const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}\n', start) + 3); };
  const context = vm.createContext({ codexOutcomeTimestampMs: value => Date.parse(value),
    settleCodexProviderActivityFromWatcherOutcome() {} });
  vm.runInContext(part('applyCodexWatcherAbnormalOutcome') + '\n' + part('applyCodexWatcherOutcome'), context);
  const state = { processGeneration: 'G' };
  const timestamp = '2026-09-10T09:34:05.312Z';
  context.applyCodexWatcherOutcome(state, projectCodexCompactTurnOutcome(proof()), timestamp, 'T');
  assert.equal(state.lastOutcomeReason, 'task_complete');
  context.applyCodexWatcherAbnormalOutcome(state, { busy: false, reason: 'codex-no-final-result' }, timestamp, 'T');
  assert.equal(state.lastAbnormalOutcomeReason, undefined);
  context.applyCodexWatcherAbnormalOutcome(state, { busy: false, reason: 'codex-no-final-result' }, timestamp, 'other');
  assert.equal(state.lastAbnormalOutcomeReason, 'codex-no-final-result', 'another turn retains its failure');
});
