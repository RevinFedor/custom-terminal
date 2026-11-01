'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { boundedJson } = require('./evaluate-mini-archived-repair.cjs');
const { nativeProof } = require('./evaluate-mini-cases.cjs');

test('archive evaluator imports inertly and refuses oversized evidence before parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-review-bounds-'));
  try {
    const file = path.join(dir, 'evidence.json');
    await fs.writeFile(file, JSON.stringify({ own: true }));
    assert.deepEqual(await boundedJson(file, 64), { own: true });
    await assert.rejects(boundedJson(file, 3), /evidence_file_invalid/);
    await assert.rejects(boundedJson(dir, 64), /evidence_file_invalid/);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('shared native proof requires matching own header, exact user/final and completion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-review-proof-'));
  try {
    const file = path.join(dir, 'own.jsonl'), c = { root: dir, sessionFile: file, sessionId: 'own', turnId: 'turn' };
    const rows = [
      { type: 'session_meta', payload: { id: 'own' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Exact request' } },
      { type: 'response_item', payload: { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Exact answer' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    ];
    const write = value => fs.writeFile(file, value.map(row => JSON.stringify(row)).join('\n') + '\n');
    await write(rows);
    const proof = await nativeProof(c, 'Exact request', 'Exact answer');
    assert.equal(proof.user.id, 'codex-user-own-2');
    assert.equal(proof.final.id, 'codex-assistant-own-3');
    await assert.rejects(nativeProof({ ...c, sessionId: 'foreign' }, 'Exact request', 'Exact answer'), /identity_mismatch/);
    await assert.rejects(nativeProof(c, 'Different request', 'Exact answer'), /completed_pair_not_verified/);
    await write(rows.slice(0, -1));
    await assert.rejects(nativeProof(c, 'Exact request', 'Exact answer'), /completed_pair_not_verified/);
  } finally { await fs.rm(dir, { recursive: true }); }
});
