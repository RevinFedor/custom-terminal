'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPromptQueueSource,
  isPromptQueueAutomationSource,
  isPromptLoopAutomationSource,
} = require('./prompt-queue-source');

test('Run After and Prompt Loop share the automatic queue admission contract', () => {
  assert.equal(isPromptQueueAutomationSource('prompt-queue'), true);
  assert.equal(isPromptQueueAutomationSource('prompt-loop'), true);
  assert.equal(isPromptQueueAutomationSource('codex-prompt-queue'), true);
  assert.equal(isPromptQueueAutomationSource('codex-prompt-loop'), true);
});

test('only the exact Loop source may authorize task completion', () => {
  assert.equal(isPromptLoopAutomationSource('prompt-loop'), true);
  assert.equal(isPromptLoopAutomationSource('codex-prompt-loop'), true);
  assert.equal(isPromptLoopAutomationSource('claude-prompt-loop'), true);
  assert.equal(isPromptLoopAutomationSource('prompt-queue'), false);
  assert.equal(isPromptLoopAutomationSource('history-panel'), false);
  assert.equal(isPromptLoopAutomationSource('other-prompt-loop-retry'), false);
});

test('manual and History sends do not become queue automation', () => {
  assert.equal(isPromptQueueAutomationSource('history-panel'), false);
  assert.equal(isPromptQueueAutomationSource('manual-terminal-enter'), false);
  assert.equal(isPromptQueueAutomationSource(null), false);
});

test('explicit Run After send-now keeps source ownership but follows ordinary Send instead of auto idle admission', () => {
  for (const source of ['prompt-queue', 'codex-prompt-queue', 'claude-prompt-queue']) {
    assert.equal(isPromptQueueSource(source), true);
    assert.equal(isPromptQueueAutomationSource(source, { promptQueueAction: 'send-now' }), false);
    assert.equal(isPromptQueueAutomationSource(source, { queue: true }), true);
    assert.equal(isPromptQueueAutomationSource(source, null), true);
    assert.equal(isPromptQueueAutomationSource(source, { promptQueueAction: 'unknown' }), true);
  }
  assert.equal(isPromptQueueAutomationSource('prompt-loop', { promptQueueAction: 'send-now' }), true);
  assert.equal(isPromptQueueAutomationSource('codex-prompt-loop', { promptQueueAction: 'send-now' }), true);
  assert.equal(isPromptQueueAutomationSource('prompt-queue-replay'), true);
});
