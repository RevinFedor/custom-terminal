'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { _api } = require('./codex-data');

test('stable-source Rewind proof scan stops after the exact post-action task boundary', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rewind-proof-'));
  const filePath = path.join(tempDir, 'rollout.jsonl');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const records = [
    { timestamp: '2026-07-29T00:00:00.000Z', type: 'session_meta', payload: { id: 'source' } },
    { timestamp: '2026-07-29T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'target' } },
    { timestamp: '2026-07-29T00:00:03.010Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: '2026-07-29T00:00:03.020Z', type: 'response_item', payload: { type: 'reasoning', text: 'metadata between proofs' } },
    { timestamp: '2026-07-29T00:00:03.030Z', type: 'event_msg', payload: { type: 'user_message', message: 'edited after rewind' } },
    { timestamp: '2026-07-29T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ];
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

  const result = await _api.scanCodexStableSourceRewindProof(filePath, {
    targetSourceLine: 1,
    actionStartedAtMs: Date.parse('2026-07-29T00:00:03.000Z'),
  });
  assert.equal(result.complete, true);
  assert.equal(result.stoppedAtProof, true);
  assert.equal(result.targetRecord.__line, 1);
  assert.equal(result.targetRecord.payload.message, 'target');
  assert.equal(result.taskStartedRecord.__line, 2);
  assert.equal(result.userMessageRecord.__line, 4);
  assert.ok(result.scannedBytes <= fs.statSync(filePath).size);
});
