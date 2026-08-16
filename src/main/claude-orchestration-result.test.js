'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  materializeClaudeOrchestrationTurn,
} = require('./claude-orchestration-result');

function assistant(uuid, text, stopReason) {
  return [uuid, {
    type: 'assistant',
    message: {
      stop_reason: stopReason,
      content: text ? [{ type: 'text', text }] : [],
    },
  }];
}

test('a final answer after an internal agent continuation completes the full result', () => {
  const records = new Map([
    assistant('before', 'Started background review.', 'end_turn'),
    assistant('after', 'Consolidated final report.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationTurn({
    assistantUuids: ['before', 'after'],
    completionAssistantUuids: ['after'],
    internalContinuationCount: 1,
  }, records);

  assert.equal(result.complete, true);
  assert.equal(result.internalContinuationCount, 1);
  assert.match(result.assistantText, /Started background review/);
  assert.match(result.assistantText, /Consolidated final report/);
});

test('an older end_turn cannot complete a result after a newer service carrier', () => {
  const records = new Map([
    assistant('before', 'Started background review.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationTurn({
    assistantUuids: ['before'],
    completionAssistantUuids: [],
    internalContinuationCount: 1,
  }, records);

  assert.equal(result.complete, false);
  assert.equal(result.internalContinuationCount, 1);
});

test('legacy Claude turns keep their existing completion proof', () => {
  const records = new Map([
    assistant('final', 'Done.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationTurn({
    assistantUuids: ['final'],
  }, records);
  assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'Done.');
});
