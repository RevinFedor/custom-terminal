'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { findDirectCodexPayloadSourceLeaf } = require('./codex-payload-source-leaf');
const { readSourceLeafPage } = require('./history-source-leaf');
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-source-leaf-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'own.jsonl'); fs.writeFileSync(filePath, text); return filePath;
}
const record = (id, output) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } }) + '\n';

test('DIRECT-MISS: exact backend call/hash binding, ordered scan, no canonical projection', async t => {
  const filePath = fixture(t, record('earlier', 'wrong') + record('call-1', 'full🤖\nresult') + record('later', 'other'));
  const metrics = {};
  const hit = await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call-1',
    expectedContentHash: hash('full🤖\nresult'), totalChars: 'full🤖\nresult'.length,
    selectedTokenBytes: 64, chunkBytes: 1024, metrics });
  assert.equal(hit.ref.recordLine, 1); assert.equal(metrics.maxCollectedRecords, 0);
  const page = await readSourceLeafPage({ filePath, ref: hit.ref, expectedSource: hit.sourceSnapshot, offset: 0, limit: 1024 });
  assert.equal(page.payload, 'full🤖\nresult');
});

test('NEGATIVE: wrong ID/hash, composite output and malformed record do not become a false direct hit', async t => {
  const filePath = fixture(t, record('call-1', [{ type: 'text', text: 'composed' }])
    + '{"type":"response_item","payload":{"type":"function_call_output","call_id":"bad","output":"text"},oops}\n'
    + record('call-2', 'text'));
  for (const [payloadId, expectedContentHash] of [['result:call-1', hash('composed')],
    ['result:bad', hash('text')], ['result:call-2', hash('wrong')], ['action:call-2', hash('text')]]) {
    assert.equal(await findDirectCodexPayloadSourceLeaf({ filePath, payloadId, expectedContentHash,
      selectedTokenBytes: 64, chunkBytes: 1024 }), null);
  }
});

test('TRUSTED-ORIGIN: exact server call/line; client-only suffix never guesses provider identity', async t => {
  const filePath = fixture(t, record('call-1', 'first') + record('call-1:canonical:0', 'second')
    + record('exact-legacy:canonical:0', 'legacy'));
  for (const [payloadId, sourceCallId, content, line] of [
    ['result:call-1:canonical:0', 'call-1', 'first', 0],
    ['result:call-1:canonical:0:canonical:0', 'call-1:canonical:0', 'second', 1],
    ['result:exact-legacy:canonical:0', 'exact-legacy:canonical:0', 'legacy', 2],
  ]) {
    const hit = await findDirectCodexPayloadSourceLeaf({ filePath, payloadId, expectedContentHash: hash(content),
      sourceCallId, sourceRecordLine: line, totalChars: content.length, selectedTokenBytes: 64, chunkBytes: 1024 });
    assert.equal(hit.ref.recordLine, line);
    assert.equal((await readSourceLeafPage({ filePath, ref: hit.ref, offset: 0, limit: 32 })).payload, content);
  }
  assert.equal(await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call-1:canonical:nope',
    expectedContentHash: hash('first') }), null);
  assert.equal(await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call-1:canonical:0',
    expectedContentHash: hash('first') }), null);
  assert.equal(await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call-1:canonical:0',
    sourceCallId: 'call-1', sourceRecordLine: 1, expectedContentHash: hash('first') }), null);
});

test('LARGE-DIRECT:256KiB result,64B token and1KiB frame, no whole field oracle', async t => {
  const filePath = fixture(t, ''); const fd = fs.openSync(filePath, 'w'), expected = createHash('sha256');
  fs.writeSync(fd, '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"');
  for (let index = 0; index < 256; index++) { const block = 'q'.repeat(1024); fs.writeSync(fd, block); expected.update(block); }
  fs.writeSync(fd, '"}}\n'); fs.closeSync(fd);
  const metrics = {};
  const hit = await findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call', expectedContentHash: expected.digest('hex'),
    totalChars: 256 * 1024, selectedTokenBytes: 64, chunkBytes: 1024, metrics });
  assert.ok(hit); assert.ok(metrics.maxTokenBytes <= 64); assert.ok(metrics.maxChunkBytes <= 1024);
  const page = await readSourceLeafPage({ filePath, ref: hit.ref, offset: 123, limit: 512, chunkBytes: 1024 });
  assert.equal(page.payload, 'q'.repeat(512)); assert.equal(page.nextOffset, 635);
});

test('FENCE: final source invalidation is distinct from a miss and cancellation is not reclassified', async t => {
  const filePath = fixture(t, record('call', 'text'));
  let validations = 0;
  await assert.rejects(findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call', expectedContentHash: hash('text'),
    validateSource: async () => ++validations < 2 }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  const cancelled = Object.assign(Error('cancelled'), { code: 'HISTORY_READ_CANCELLED' });
  await assert.rejects(findDirectCodexPayloadSourceLeaf({ filePath, payloadId: 'result:call', expectedContentHash: hash('text'),
    control: { assertCurrent() { throw cancelled; } } }), error => error === cancelled);
});
