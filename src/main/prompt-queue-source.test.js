'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPromptQueueAutomationSource,
} = require('./prompt-queue-source');

test('Run After and Prompt Loop share the automatic queue admission contract', () => {
  assert.equal(isPromptQueueAutomationSource('prompt-queue'), true);
  assert.equal(isPromptQueueAutomationSource('prompt-loop'), true);
  assert.equal(isPromptQueueAutomationSource('codex-prompt-queue'), true);
  assert.equal(isPromptQueueAutomationSource('codex-prompt-loop'), true);
});

test('manual and History sends do not become queue automation', () => {
  assert.equal(isPromptQueueAutomationSource('history-panel'), false);
  assert.equal(isPromptQueueAutomationSource('manual-terminal-enter'), false);
  assert.equal(isPromptQueueAutomationSource(null), false);
});
