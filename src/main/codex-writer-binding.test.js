'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { persistCodexWriterBinding } = require('./codex-writer-binding');

test('writer binding becomes publishable only after scoped durable commit', () => {
  let durable = 'resume-source';
  const committed = persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => durable,
    writeBinding: (_projectId, _tabId, next) => {
      durable = next;
      return true;
    },
  });
  assert.deepEqual(committed, {
    success: true,
    updated: true,
    currentSessionId: 'resume-source',
  });
  assert.equal(durable, 'writer-child');
});

test('missing row and write failure remain retryable non-durable states', () => {
  assert.deepEqual(persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => undefined,
    writeBinding: () => true,
  }), {
    success: false,
    error: 'codex_tab_row_missing',
    retryable: true,
  });

  const failed = persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => 'resume-source',
    writeBinding: () => false,
  });
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'codex_writer_binding_not_committed');
  assert.equal(failed.retryable, true);
});
