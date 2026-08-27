'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codexData = require('./codex-data');
const { promptAuditFingerprint } = require('../prompt-audit-fingerprint');

const record = (timestamp, type, payload = {}) => JSON.stringify({
  timestamp,
  type,
  payload,
});

test('stable-source Rewind scan distinguishes rollback from a proven empty provider failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rewind-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = record('2026-08-24T06:42:32.195Z', 'event_msg', {
    type: 'user_message',
    message: 'queued target',
  });

  const rejectedPath = path.join(root, 'rejected.jsonl');
  fs.writeFileSync(rejectedPath, target + '\n');
  const rejected = await codexData._api.scanCodexStableSourceRewindProof(rejectedPath, {
    targetSourceLine: 0,
    actionStartedAtMs: Date.parse('2026-08-24T06:45:42.000Z'),
  });
  assert.equal(rejected.complete, true);
  assert.equal(rejected.targetRecord.payload.type, 'user_message');
  assert.equal(rejected.taskStartedRecord, null);
  assert.equal(rejected.userMessageRecord, null);
  assert.equal(rejected.threadRolledBackRecord, null);

  const appliedPath = path.join(root, 'applied.jsonl');
  fs.writeFileSync(appliedPath, [
    target,
    record('2026-08-24T06:45:42.500Z', 'event_msg', {
      type: 'thread_rolled_back',
      num_turns: 1,
    }),
  ].join('\n') + '\n');
  const applied = await codexData._api.scanCodexStableSourceRewindProof(appliedPath, {
    targetSourceLine: 0,
    actionStartedAtMs: Date.parse('2026-08-24T06:45:42.000Z'),
  });
  assert.equal(applied.complete, true);
  assert.equal(applied.threadRolledBackRecord.payload.type, 'thread_rolled_back');
});

test('stable-source Rewind scan skips unrelated turns and selects the exact written submit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rewind-submit-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = record('2026-08-24T06:42:32.195Z', 'event_msg', {
    type: 'user_message',
    message: 'rewound target',
  });
  const expectedText = '/compact';
  const rows = [
    target,
    record('2026-08-24T06:45:42.100Z', 'event_msg', { type: 'task_started' }),
    record('2026-08-24T06:45:42.200Z', 'event_msg', {
      type: 'user_message',
      message: 'different prompt',
    }),
    record('2026-08-24T06:45:42.300Z', 'event_msg', { type: 'task_started' }),
    record('2026-08-24T06:45:42.400Z', 'event_msg', {
      type: 'user_message',
      message: expectedText,
    }),
  ];
  const filePath = path.join(root, 'written-submit.jsonl');
  fs.writeFileSync(filePath, rows.join('\n') + '\n');
  const sourceFileSize = Buffer.byteLength(target + '\n');
  const expectedSubmit = {
    expectedLen: expectedText.length,
    expectedHash: promptAuditFingerprint(expectedText),
    sentAtMs: Date.parse('2026-08-24T06:45:42.000Z'),
    sourceFileSize,
  };

  const exact = await codexData._api.scanCodexStableSourceRewindProof(filePath, {
    targetSourceLine: 0,
    actionStartedAtMs: Date.parse('2026-08-24T06:45:41.000Z'),
    expectedSubmit,
  });
  assert.equal(exact.complete, true);
  assert.equal(exact.expectedSubmitMatched, true);
  assert.equal(exact.submitMismatchCount, 1);
  assert.equal(exact.taskStartedRecord.__line, 3);
  assert.equal(exact.userMessageRecord.__line, 4);
  assert.equal(exact.userMessageRecord.__auditTextLength, expectedText.length);
  assert.equal(exact.userMessageRecord.__auditHash, expectedSubmit.expectedHash);

  const mismatch = await codexData._api.scanCodexStableSourceRewindProof(filePath, {
    targetSourceLine: 0,
    actionStartedAtMs: Date.parse('2026-08-24T06:45:41.000Z'),
    expectedSubmit: {
      ...expectedSubmit,
      expectedHash: promptAuditFingerprint('not present'),
    },
  });
  assert.equal(mismatch.complete, true);
  assert.equal(mismatch.expectedSubmitMatched, false);
  assert.equal(mismatch.taskStartedRecord, null);
  assert.equal(mismatch.userMessageRecord, null);
});
