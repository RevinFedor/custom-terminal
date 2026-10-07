'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCodexTurnAppend } = require('./codex-turn-append-reader');
const { consumeCodexUserMessageAuditChunk, selectCodexPreferredUserMessageAuditRecords } = require('./codex-prompt-audit');
const { createHarness } = require('../../scripts/lib/codex-turn-append-harness.cjs');
const { armCodexSuppressedCatchUpRelease, prepareCodexSourceProofReplay } = require('./codex-turn-outcome');
const event = (type, message = '') => ({ type: 'event_msg', payload: { type, message } });
const response = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const tool = n => ({ type: 'response_item', payload: { type: 'function_call_output', output: 'тест🧩'.repeat(n) } });
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
async function fixture(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-append-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl'); await fs.writeFile(file, content); return file;
}

test('actual scanner keeps complete-append carrier preference, exact physical offsets and record bytes across I/O boundaries', async t => {
  const content = lines([response('один 🧩'), event('task_started'), tool(60000), event('user_message', 'один 🧩'),
    event('task_complete'), response('один 🧩'), event('task_started'), tool(40000), event('user_message', 'один 🧩'),
    event('task_complete'), response('response only'), event('task_started'), event('task_complete')]);
  const file = await fixture(t, content);
  const expected = selectCodexPreferredUserMessageAuditRecords(consumeCodexUserMessageAuditChunk({ chunk: content }).records)
    .map(c => c.byteOffset);
  const h = createHarness(file, { keepOffsets: true }); await h.scan();
  assert.deepEqual(h.result.warnings, []);
  assert.deepEqual(h.result.selected, expected);
  assert.equal(h.state.offset, Buffer.byteLength(content));
  let offset = 0; const offsets = content.trimEnd().split('\n').map(line => { const old = offset; offset += Buffer.byteLength(line) + 1; return old; });
  assert.deepEqual(h.result.offsets, offsets);
  assert.ok(h.result.maxInputBytes < Buffer.byteLength(content));
  assert.ok(h.result.read.stats.candidateTextBytes < 100);
  assert.equal(h.result.records, 13);
});

test('a UTF-8 character split between separate physical appends is retained as bytes, not replacement characters', async t => {
  const full = Buffer.from(lines([event('user_message', 'аб🧩в')]));
  const split = full.indexOf(Buffer.from('🧩')) + 2;
  const file = await fixture(t, full.subarray(0, split));
  const h = createHarness(file); await h.scan();
  assert.equal(h.result.records, 0); assert.ok(Buffer.isBuffer(h.state.partial));
  await fs.appendFile(file, full.subarray(split)); await h.scan();
  const reference = createHarness(await fixture(t, full)); await reference.scan();
  assert.equal(h.digest(), reference.digest());
  assert.deepEqual(h.result.selected, [0]); assert.equal(h.state.offset, full.length);
});

test('compact task_complete does not finalize before a compacted record in a later batch', async t => {
  const file = await fixture(t, lines([event('task_complete'), tool(90000), { type: 'compacted', payload: { message: 'done' } }]));
  const h = createHarness(file, { compact: true }); await h.scan();
  assert.equal(h.result.finalized, 0); assert.equal(h.result.records, 3);
  const noCompact = createHarness(await fixture(t, lines([event('task_complete'), tool(90000)])), { compact: true });
  await noCompact.scan(); assert.equal(noCompact.result.finalized, 1);
});

test('provisional source still audits both carriers without public events and retains exact replay boundary', async t => {
  const content = lines([response('same'), tool(70000), event('user_message', 'same'), response('image-only')]);
  const file = await fixture(t, content);
  const h = createHarness(file, { state: { sourceObservationLaunchId: 'launch-a' } }); await h.scan();
  const expected = selectCodexPreferredUserMessageAuditRecords(consumeCodexUserMessageAuditChunk({ chunk: content }).records).map(c => c.byteOffset);
  assert.deepEqual(h.result.warnings, []);
  assert.deepEqual(h.result.sourceAudits, expected); assert.equal(h.result.records, 0);
  assert.equal(h.state.sourceWriterReplayOffset, 0); assert.equal(h.state.offset, Buffer.byteLength(content));
  assert.deepEqual(h.result.published, []);
});

test('source replacement or truncation after preflight never applies bytes or releases catch-up', async t => {
  for (const action of ['replace', 'truncate', 'rewrite']) {
    const content = lines([event('user_message', 'a'), event('task_complete')]);
    const file = await fixture(t, content);
    let applied = 0;
    await assert.rejects(readCodexTurnAppend({ filePath: file, start: 0, end: Buffer.byteLength(content),
      onPrepared: async () => {
        if (action === 'replace') { await fs.rename(file, file + '.old'); await fs.writeFile(file, content); }
        else if (action === 'truncate') await fs.truncate(file, 0);
        else await fs.writeFile(file, content.replace('"a"', '"b"'));
      }, onBatch: () => { applied += 1; } }), /source-changed/);
    assert.equal(applied, 0, action);
  }
});

test('new watcher identity during preflight does not consume or publish the old scan', async t => {
  const file = await fixture(t, lines([event('task_complete'), tool(50000)]));
  let h;
  h = createHarness(file, { reader: { onPrepared: () => h.watchers.set(h.state.tabId, { ...h.state }) } });
  armCodexSuppressedCatchUpRelease(h.state, { targetOffset: (await fs.stat(file)).size, kind: 'linked-live-catchup' });
  await h.scan(); assert.equal(h.state.offset, 0); assert.equal(h.result.records, 0);
  assert.deepEqual(h.result.published, []); assert.match(h.result.warnings[0], /owner-changed/);
});

test('growth during bounded replay queues another scan and never drops its final event', async t => {
  const content = lines([event('task_started'), tool(50000)]);
  const file = await fixture(t, content); let h, appended = false;
  h = createHarness(file, { reader: { onPrepared: async () => {
    if (appended) return; appended = true; await fs.appendFile(file, lines([event('task_complete')]));
    await h.scan('fs.watch');
  } } });
  await h.scan(); assert.equal(h.result.records, 3);
  assert.equal(h.state.offset, (await fs.stat(file)).size); assert.deepEqual(h.result.warnings, []);
});

test('read failure before a batch does not commit its bytes and can retry exactly', async t => {
  const file = await fixture(t, lines([event('user_message', 'safe')]));
  let fail = true;
  const h = createHarness(file, { reader: { onPrepared: () => { if (fail) throw new Error('injected-read-failure'); } } });
  await h.scan(); assert.equal(h.state.offset, 0); assert.equal(h.result.records, 0);
  fail = false; await h.scan(); assert.equal(h.result.records, 1); assert.deepEqual(h.result.selected, [0]);
});

test('source-to-writer replay retains a carried partial UTF-8 record byte for byte', () => {
  const partial = Buffer.from([0x7b, 0x22, 0xd0]);
  const state = { offset: 1000, sourceObservationLaunchId: 'launch',
    sourceWriterReplayOffset: 103, sourceWriterReplayPartial: partial, sourceWriterReplayPartialStartOffset: 100 };
  const result = prepareCodexSourceProofReplay(state, { kind: 'source-proof-replay' });
  assert.equal(result.prepared, true); assert.equal(state.offset, 103);
  assert.deepEqual(state.partial, partial); assert.equal(state.partialStartOffset, 100);
});

test('provider image response paired across batches keeps canonical event identity, while response-only input still works', async t => {
  const image = { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(600000) },
    { type: 'input_text', text: 'image question' },
  ] } };
  const content = lines([image, tool(50000), event('user_message', '[Image #1] image question'), event('task_complete'), image]);
  const expected = selectCodexPreferredUserMessageAuditRecords(consumeCodexUserMessageAuditChunk({ chunk: content }).records).map(c => c.byteOffset);
  const h = createHarness(await fixture(t, content)); await h.scan();
  assert.deepEqual(h.result.selected, expected); assert.equal(expected.length, 2);
  assert.ok(h.result.read.stats.candidateTextBytes < 100, 'image data must not survive in the carrier index');
});
