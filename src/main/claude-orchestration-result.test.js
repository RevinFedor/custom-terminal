'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  materializeClaudeOrchestrationExecution,
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

test('queued user follow-ups remain inside one exact Claude execution result', () => {
  const records = new Map([
    assistant('initial', 'Started the requested work.', 'tool_use'),
    assistant('followup', 'Applied the added requirement.', 'end_turn'),
    assistant('final', 'Final verified report.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationExecution({
    turns: [
      {
        kind: 'user',
        userTimestamp: '2026-08-16T19:21:28.011Z',
        assistantUuids: ['initial'],
        completionAssistantUuids: ['initial'],
      },
      {
        kind: 'queued_command',
        userTimestamp: '2026-08-16T19:32:14.286Z',
        assistantUuids: ['followup'],
        completionAssistantUuids: ['followup'],
      },
      {
        kind: 'queued_command',
        userTimestamp: '2026-08-16T19:54:45.630Z',
        assistantUuids: ['final'],
        completionAssistantUuids: ['final'],
      },
    ],
    startTurnIndex: 0,
    recordMap: records,
    resultBeforeAt: Date.parse('2026-08-16T20:11:43.456Z'),
  });

  assert.equal(result.complete, true);
  assert.equal(result.queuedContinuationCount, 2);
  assert.equal(result.startTurnIndex, 0);
  assert.equal(result.endTurnIndex, 2);
  assert.match(result.assistantText, /Started the requested work/);
  assert.match(result.assistantText, /Applied the added requirement/);
  assert.match(result.assistantText, /Final verified report/);
});

test('an older completion cannot close a newer unfinished queued slice', () => {
  const records = new Map([
    assistant('old-final', 'Original slice ended.', 'end_turn'),
    assistant('new-partial', 'Working on the follow-up.', 'tool_use'),
  ]);
  const result = materializeClaudeOrchestrationExecution({
    turns: [
      {
        kind: 'user',
        userTimestamp: '2026-08-16T19:21:28.011Z',
        assistantUuids: ['old-final'],
        completionAssistantUuids: ['old-final'],
      },
      {
        kind: 'queued_command',
        userTimestamp: '2026-08-16T19:32:14.286Z',
        assistantUuids: ['new-partial'],
        completionAssistantUuids: ['new-partial'],
      },
    ],
    startTurnIndex: 0,
    recordMap: records,
  });

  assert.equal(result.complete, false);
  assert.equal(result.endTurnIndex, 1);
});

test('a new ordinary user turn is a hard boundary for the prior orchestration', () => {
  const records = new Map([
    assistant('partial', 'Still working.', 'tool_use'),
    assistant('unrelated', 'A later independent answer.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationExecution({
    turns: [
      {
        kind: 'user',
        userTimestamp: '2026-08-16T19:21:28.011Z',
        assistantUuids: ['partial'],
        completionAssistantUuids: ['partial'],
      },
      {
        kind: 'user',
        userTimestamp: '2026-08-16T20:20:00.000Z',
        assistantUuids: ['unrelated'],
        completionAssistantUuids: ['unrelated'],
      },
    ],
    startTurnIndex: 0,
    recordMap: records,
  });

  assert.equal(result.complete, false);
  assert.equal(result.endTurnIndex, 0);
  assert.equal(result.boundaryReason, 'new-logical-turn');
  assert.doesNotMatch(result.assistantText, /later independent answer/);
});

test('a queued row beyond the exact lifecycle completion is not adopted', () => {
  const records = new Map([
    assistant('partial', 'Still working.', 'tool_use'),
    assistant('late', 'Late unrelated queue row.', 'end_turn'),
  ]);
  const result = materializeClaudeOrchestrationExecution({
    turns: [
      {
        kind: 'user',
        userTimestamp: '2026-08-16T19:21:28.011Z',
        assistantUuids: ['partial'],
        completionAssistantUuids: ['partial'],
      },
      {
        kind: 'queued_command',
        userTimestamp: '2026-08-16T20:12:00.000Z',
        assistantUuids: ['late'],
        completionAssistantUuids: ['late'],
      },
    ],
    startTurnIndex: 0,
    recordMap: records,
    resultBeforeAt: Date.parse('2026-08-16T20:11:43.456Z'),
  });

  assert.equal(result.complete, false);
  assert.equal(result.endTurnIndex, 0);
  assert.equal(result.boundaryReason, 'completion-upper-bound');
  assert.doesNotMatch(result.assistantText, /Late unrelated queue row/);
});
