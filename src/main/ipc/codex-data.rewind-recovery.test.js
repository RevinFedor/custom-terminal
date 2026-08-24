'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codexData = require('./codex-data');

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
