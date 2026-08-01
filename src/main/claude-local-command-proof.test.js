'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyClaudeLocalCommandOwner,
  classifyClaudeCompactWatcherRecord,
  selectLatestClaudeManualCompactIntent,
} = require('./claude-local-command-proof');

function candidate(text, timestamp) {
  return { text, record: { timestamp } };
}

test('PTY compact proof accepts only the latest explicit compact in this launch generation', () => {
  const launchAt = Date.parse('2026-07-30T05:00:00.000Z');
  const proof = selectLatestClaudeManualCompactIntent([
    candidate('ordinary prompt', '2026-07-30T05:00:01.000Z'),
    candidate(
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      '2026-07-30T05:00:02.000Z',
    ),
  ], { notBeforeMs: launchAt });

  assert.equal(proof.proven, true);
  assert.equal(proof.reason, 'latest-prompt-is-explicit-compact');
});

test('automatic compaction after an ordinary prompt cannot inherit an older compact intent', () => {
  const proof = selectLatestClaudeManualCompactIntent([
    candidate('/compact', '2026-07-30T05:00:01.000Z'),
    candidate('ordinary prompt that caused auto compact', '2026-07-30T05:00:02.000Z'),
  ], { notBeforeMs: Date.parse('2026-07-30T05:00:00.000Z') });

  assert.equal(proof.proven, false);
  assert.equal(proof.reason, 'latest-prompt-is-not-compact');
});

test('local command output and compact summary do not hide their exact compact intent', () => {
  const launchAt = Date.parse('2026-07-30T05:00:00.000Z');
  const proof = selectLatestClaudeManualCompactIntent([
    candidate('ordinary prompt', '2026-07-30T05:00:01.000Z'),
    candidate(
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
      '2026-07-30T05:00:02.000Z',
    ),
    {
      text: 'compacted summary',
      promptCarrierKind: 'compact_summary',
      record: {
        timestamp: '2026-07-30T05:00:03.000Z',
        isCompactSummary: true,
      },
    },
    candidate(
      '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
      '2026-07-30T05:00:04.000Z',
    ),
  ], { notBeforeMs: launchAt });

  assert.equal(proof.proven, true);
  assert.equal(proof.reason, 'latest-prompt-is-explicit-compact');
});

test('ordinary prompt after local command output still invalidates an older compact intent', () => {
  const proof = selectLatestClaudeManualCompactIntent([
    candidate('/compact', '2026-07-30T05:00:01.000Z'),
    candidate(
      '<local-command-stdout>Compacted</local-command-stdout>',
      '2026-07-30T05:00:02.000Z',
    ),
    candidate('new ordinary prompt', '2026-07-30T05:00:03.000Z'),
  ], { notBeforeMs: Date.parse('2026-07-30T05:00:00.000Z') });

  assert.equal(proof.proven, false);
  assert.equal(proof.reason, 'latest-prompt-is-not-compact');
});

test('compact carrier copied from before Resume cannot authorize the new generation', () => {
  const proof = selectLatestClaudeManualCompactIntent([
    candidate('/compact', '2026-07-30T04:59:59.000Z'),
  ], { notBeforeMs: Date.parse('2026-07-30T05:00:00.000Z') });

  assert.equal(proof.proven, false);
  assert.equal(proof.reason, 'compact-before-launch-generation');
});

test('manual and automatic compact boundaries remain different owners', () => {
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual' },
    }),
    { terminal: true, success: true, reason: 'compact_boundary' },
  );
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto' },
    }),
    { terminal: false, success: false, reason: 'auto-compact-boundary' },
  );
});

test('explicit compaction cancellation is terminal but not successful', () => {
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>Compaction canceled.</local-command-stdout>',
    }),
    { terminal: true, success: false, reason: 'compact-cancelled' },
  );
});

test('provider rejection for too few messages is a terminal compact failure', () => {
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>',
    }),
    { terminal: true, success: false, reason: 'compact-not-enough-messages' },
  );
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'assistant',
      content: 'The phrase "Not enough messages to compact" was quoted by the user.',
    }),
    { terminal: false, success: false, reason: 'unrelated-record' },
  );
});

test('provider compact stderr is terminal only for the causal local-command record', () => {
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stderr>Error during compaction: summarization produced empty response</local-command-stderr>',
    }),
    { terminal: true, success: false, reason: 'compact-provider-error' },
  );
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'assistant',
      content: 'Error during compaction: summarization produced empty response',
    }),
    { terminal: false, success: false, reason: 'unrelated-record' },
  );
  assert.deepEqual(
    classifyClaudeCompactWatcherRecord({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stderr>Unrelated local command failed</local-command-stderr>',
    }),
    { terminal: false, success: false, reason: 'unrelated-local-command-output' },
  );
});

test('PTY completion belongs only to the unchanged physical submit owner', () => {
  const terminal = {};
  const owner = {
    terminal,
    sessionId: 'session-a',
    generation: 7,
    inputRevision: 12,
  };
  assert.deepEqual(
    classifyClaudeLocalCommandOwner(owner, { ...owner }),
    { matches: true, reason: 'exact-owner-current' },
  );
});

test('a later prompt invalidates PTY completion for the older compact', () => {
  const terminal = {};
  const owner = {
    terminal,
    sessionId: 'session-a',
    generation: 7,
    inputRevision: 12,
  };
  assert.deepEqual(
    classifyClaudeLocalCommandOwner(owner, { ...owner, inputRevision: 13 }),
    { matches: false, reason: 'input-generation-changed' },
  );
});
