'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryByteSender, HistoryByteReceiver } = require('./history-byte-stream');
const { encodeHistoryStream } = require('./history-stream-codec');
const { createReadControl, isHistoryReadCancelled } = require('./history-read-control');
const tick = () => new Promise(resolve => setImmediate(resolve));
const SHA = () => createHash('sha256');

function pair({ frameBytes = 1024, credits = 2, dropCredit = () => false, assertCurrent = () => {} } = {}) {
  const controller = new AbortController(), control = createReadControl({ signal: controller.signal });
  const senderStats = {}, receiverStats = {}; let settled = 0;
  let sender;
  const receiver = new HistoryByteReceiver({ id: 7, frameBytes, credits, stats: receiverStats, assertCurrent,
    onSettled: () => settled++, send: message => {
      if (message.event === 'cancel') controller.abort();
      else if (!dropCredit(message)) queueMicrotask(() => sender.credit(message));
    } });
  sender = new HistoryByteSender({ id: 7, control, assertCurrent, frameBytes, credits, stats: senderStats,
    send: message => {
      // Substitute for E28 utilityProcess copy, deliberately NOT ArrayBuffer
      // transfer. The finite copy has the exact frame limit.
      const copy = message.data ? { ...message, data: Uint8Array.from(message.data) } : message;
      queueMicrotask(() => receiver.accept(copy));
    } });
  return { sender, receiver, controller, control, senderStats, receiverStats, get settled() { return settled; } };
}

test('stream codec exactly matches JSON for Unicode boundaries, omission, dates and nested arrays', async () => {
  const value = { a: 'x'.repeat(100) + '\ud83d\ude00' + '\ud800' + '\udc00' + '\n"\\', missing: undefined,
    array: [undefined, NaN, Infinity, -0, { t: new Date('2026-01-01T00:00:00Z') }] };
  const expected = SHA().update(JSON.stringify(value)).digest('hex');
  const actual = SHA(); const stats = {};
  for await (const bytes of encodeHistoryStream(value, { frameBytes: 64, stats })) actual.update(bytes);
  assert.equal(actual.digest('hex'), expected);
  assert.ok(stats.maxFrameBytes <= 64); assert.ok(stats.maxCodecOwnedBytes <= 128);
});

test('large leaf resolver preserves a surrogate pair split between chunks and trailing lone code unit', async () => {
  const ref = { $historyLeaf: 'v1', leafId: 'owned' };
  const chunks = ['abc\ud83d', '', '\ude00x', '\ud800', 'y\udc00', '\ud800'];
  const leafResolver = { isReference: value => value === ref, readChunks: async function* () { yield* chunks; } };
  const actual = SHA(), expected = SHA().update(JSON.stringify({ content: chunks.join('') })).digest('hex');
  for await (const frame of encodeHistoryStream({ content: ref }, { frameBytes: 64, leafResolver })) actual.update(frame);
  assert.equal(actual.digest('hex'), expected);
  await assert.rejects(async () => { for await (const frame of encodeHistoryStream(ref)) void frame; }, /history_leaf_resolver_missing/);
});

test('source-bound LEAF without resolver is rejected instead of emitted as apparent History content', async () => {
  const ref = { $historySourceLeaf: 'json-string-v1', from: 0, to: 1024, totalChars: 1000,
    contentHash: 'a'.repeat(64) };
  await assert.rejects(async () => {
    for await (const frame of encodeHistoryStream({ content: ref }, { frameBytes: 64 })) void frame;
  }, /history_leaf_resolver_missing/);
});

test('actual source-leaf resolver streams complete UTF16 text through JSON framing and final source proof', async t => {
  const { isSourceLeaf, streamSourceLeaf } = require('./history-source-leaf');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-codec-leaf-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'own-leaf.json'), text = 'x'.repeat(100) + '🌏' + '\ud800' + '\n"\\';
  const token = JSON.stringify(text); await fs.writeFile(filePath, token);
  const ref = { $historySourceLeaf: 'json-string-v1', from: 0, to: Buffer.byteLength(token),
    totalChars: text.length, contentHash: SHA().update(text).digest('hex') };
  const metrics = {}, actual = SHA();
  const leafResolver = { isReference: isSourceLeaf,
    readChunks: (value, options) => streamSourceLeaf({ filePath, ref: value, ...options, metrics }) };
  for await (const frame of encodeHistoryStream({ content: ref }, { frameBytes: 64, leafResolver })) actual.update(frame);
  assert.equal(actual.digest('hex'), SHA().update(JSON.stringify({ content: text })).digest('hex'));
  assert.equal(metrics.verified, true); assert.ok(metrics.maxReadChunkBytes <= 64);
  assert.ok(metrics.maxDecodedChunkBytes <= 64);
});

for (const records of [1, 10, 100]) for (const leafKiB of [1, 16, 256]) {
  test(`credit plateau and full ordered wire hash: ${records} rows x ${leafKiB} KiB leaf`, async () => {
    const leafBytes = leafKiB * 1024, scalar = 'x'.repeat(64), codecStats = {};
    let residentRows = 0, maxResidentRows = 0;
    async function* rows() {
      for (let i = 0; i < records; i++) {
        residentRows++; maxResidentRows = Math.max(maxResidentRows, residentRows);
        try { yield { uuid: 'row-' + i, content: { $historyLeaf: 'v1', leafId: String(i), totalChars: leafBytes } }; }
        finally { residentRows--; }
      }
    }
    const leafResolver = { isReference: value => value?.$historyLeaf === 'v1',
      readChunks: async function* (ref) { for (let n = 0; n < ref.totalChars; n += scalar.length) yield scalar; } };
    // Oracle is a rolling digest of known syntax and bounded literal chunks;
    // it never builds a second JSON string, row array or semantic graph.
    const expected = SHA().update('{"entries":['); let expectedBytes = Buffer.byteLength('{"entries":[');
    for (let i = 0; i < records; i++) {
      const head = (i ? ',' : '') + '{"uuid":"row-' + i + '","content":"';
      expected.update(head); expectedBytes += Buffer.byteLength(head);
      for (let n = 0; n < leafBytes; n += scalar.length) expected.update(scalar);
      expectedBytes += leafBytes; expected.update('"}'); expectedBytes += 2;
    }
    expected.update(']}'); expectedBytes += 2;
    const f = pair(), actual = SHA(); let actualBytes = 0;
    const pumping = f.sender.pump(encodeHistoryStream({ entries: rows() }, {
      frameBytes: 1024, stats: codecStats, leafResolver }), { success: true }, []);
    await f.receiver.ready;
    for await (const frame of f.receiver) { actual.update(frame); actualBytes += frame.byteLength; }
    await pumping;
    assert.equal(actual.digest('hex'), expected.digest('hex')); assert.equal(actualBytes, expectedBytes);
    assert.ok(f.senderStats.maxOutstandingBytes <= 2048); assert.ok(f.senderStats.maxBoundaryCount <= 2);
    assert.ok(f.receiverStats.maxOutstandingBytes <= 2048); assert.ok(f.receiverStats.maxQueuedFrames <= 2);
    assert.ok(codecStats.maxCodecOwnedBytes <= 2048); assert.ok(codecStats.maxFrameBytes <= 1024);
    assert.equal(maxResidentRows, 1); assert.equal(residentRows, 0); assert.equal(f.settled, 1);
  });
}

test('slow consumer with one held frame stops reader at two byte credits before next cursor advance', async () => {
  const f = pair(); let produced = 0, returned = false;
  async function* frames() { try { for (let n = 0; n < 100; n++) { produced++; yield Buffer.alloc(1024, n); } } finally { returned = true; } }
  const pumping = f.sender.pump(frames(), { success: true }, []);
  const rejected = assert.rejects(pumping, isHistoryReadCancelled);
  await f.receiver.ready; const first = await f.receiver.next(); assert.equal(first.value.byteLength, 1024);
  await tick(); await tick();
  assert.equal(produced, 2); assert.equal(f.senderStats.maxOutstandingBytes, 2048);
  f.receiver.close(); await rejected; assert.equal(returned, true); assert.equal(f.settled, 1);
});

test('owner finish while waiting for initial credit wakes sender and retires the stream without source advance', async () => {
  const f = pair(); let advanced = 0;
  const pumping = f.sender.pump((async function* () { advanced++; yield Buffer.alloc(1024); })(), {}, []);
  const rejected = assert.rejects(pumping, isHistoryReadCancelled);
  await f.receiver.ready;
  f.control.finish();
  await rejected;
  await assert.rejects(f.receiver.next(), isHistoryReadCancelled);
  assert.equal(advanced, 0); assert.equal(f.settled, 1);
});

test('lost ACK stalls bounded, duplicate ACK cannot enlarge credit, old boot token cannot release new stream', async () => {
  const f = pair({ dropCredit: message => message.consumedBytes > 0 }); let produced = 0;
  async function* frames() { for (let i = 0; i < 10; i++) { produced++; yield Buffer.alloc(1024); } }
  const pumping = f.sender.pump(frames(), {}, []), rejected = assert.rejects(pumping, isHistoryReadCancelled);
  await f.receiver.ready; await f.receiver.next(); await f.receiver.next();
  const waiting = f.receiver.next(); const cancelled = assert.rejects(waiting, isHistoryReadCancelled);
  await tick(); assert.equal(produced, 2);
  const duplicate = { streamToken: f.sender.token, consumedBytes: 0, windowBytes: 2048 };
  f.sender.credit(duplicate); f.sender.credit(duplicate);
  f.sender.credit({ ...duplicate, streamToken: 'previous-boot', consumedBytes: 2048 });
  await tick(); assert.equal(produced, 2); assert.equal(f.sender.consumedBytes, 0);
  f.receiver.close(); await cancelled; await rejected;
});

test('delayed final credit cannot publish stream-end or settle consumer before the child observes it', async () => {
  const f = pair({ dropCredit: message => message.consumedBytes > 0 });
  let ends = 0; const send = f.sender.send;
  f.sender.send = message => { if (message.event === 'stream-end') ends++; send(message); };
  const pumping = f.sender.pump((async function* () { yield Buffer.alloc(1024); })(), {}, []);
  await f.receiver.ready; await f.receiver.next();
  const completed = f.receiver.next();
  await tick(); await tick();
  assert.equal(ends, 0); assert.equal(f.settled, 0); assert.equal(f.sender.closed, false);
  assert.equal(f.sender.sentBytes - f.sender.consumedBytes, 1024);
  f.sender.credit({ streamToken: f.sender.token, consumedBytes: 1024, windowBytes: 2048 });
  assert.equal((await completed).done, true); await pumping;
  assert.equal(ends, 1); assert.equal(f.settled, 1);
});

test('lost final credit leaves live cancellable demand; abort retires owner without false terminal success', async () => {
  const f = pair({ dropCredit: message => message.consumedBytes > 0 });
  let ends = 0; const send = f.sender.send;
  f.sender.send = message => { if (message.event === 'stream-end') ends++; send(message); };
  const pumping = f.sender.pump((async function* () { yield Buffer.alloc(1024); })(), {}, []);
  const cancelled = assert.rejects(pumping, isHistoryReadCancelled);
  await f.receiver.ready; await f.receiver.next();
  const finalNext = f.receiver.next(), rejected = assert.rejects(finalNext, isHistoryReadCancelled);
  await tick(); await tick();
  assert.equal(ends, 0); assert.equal(f.settled, 0);
  f.receiver.close(); await cancelled; await rejected;
  assert.equal(ends, 0); assert.equal(f.settled, 1); assert.equal(f.sender.closed, true);
});

test('invalid cumulative future ACK is a protocol failure, not additional reader demand', async () => {
  const f = pair();
  const pumping = f.sender.pump((async function* () { yield Buffer.alloc(1024); yield Buffer.alloc(1024); })(), {}, []);
  const failed = assert.rejects(pumping, { code: 'HISTORY_STREAM_PROTOCOL_INVALID' });
  await f.receiver.ready; await f.receiver.next();
  f.sender.credit({ streamToken: f.sender.token, consumedBytes: 999999, windowBytes: 2048 });
  await failed;
  await assert.rejects(f.receiver.next(), { code: 'HISTORY_STREAM_PROTOCOL_INVALID' });
});

test('source revocation after first delivered frame cannot yield queued stale bytes or terminal success', async () => {
  let current = true;
  const assertCurrent = () => { if (!current) throw Object.assign(new Error('source changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); };
  const f = pair({ assertCurrent });
  const pumping = f.sender.pump((async function* () { for (let i = 0; i < 10; i++) yield Buffer.alloc(1024); })(), {}, []);
  const failed = assert.rejects(pumping, error => ['CODEX_SOURCE_READ_INVALIDATED','HISTORY_READ_CONSUMER_REVOKED'].includes(error.code));
  await f.receiver.ready; await f.receiver.next(); current = false;
  await assert.rejects(f.receiver.next(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  await failed; assert.equal(f.receiver.queue.length, 0); assert.equal(f.settled, 1);
});

test('no consumer pull means no encoder/source advancement; close before first credit cleans borrower', async () => {
  const f = pair(); let read = 0, returned = 0;
  const iterable = { [Symbol.asyncIterator]() { return { async next() { read++; return { value: Buffer.alloc(1024), done: false }; },
    async return() { returned++; return { done: true }; } }; } };
  const pumping = f.sender.pump(iterable, {}, []), failed = assert.rejects(pumping, isHistoryReadCancelled);
  await f.receiver.ready; await tick(); assert.equal(read, 0);
  f.receiver.close(); await failed; assert.equal(returned, 1); assert.equal(f.settled, 1);
});

test('NDJSON codec consumes async rows without collecting them', async () => {
  const actual = SHA();
  for await (const frame of encodeHistoryStream((async function* () { yield { id: 1 }; yield { id: 2 }; })(), { format: 'ndjson', frameBytes: 64 })) actual.update(frame);
  assert.equal(actual.digest('hex'), SHA().update('{"id":1}\n{"id":2}\n').digest('hex'));
});
