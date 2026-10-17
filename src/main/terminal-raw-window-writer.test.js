'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { createTerminalRawWindowWriter } = require('./terminal-raw-window-writer');
const { createTerminalRawWindow } = require('./terminal-raw-window');
const { createTerminalRawArtifactStore, writeAll } = require('./terminal-raw-window-worker');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-raw-window-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
function entry(text, seq) {
  const buffer = Buffer.allocUnsafeSlow(text.length * 2); buffer.write(text, 0, buffer.length, 'utf16le');
  return { descriptor: { seq, originalCodeUnits: text.length, retainedCodeUnits: text.length, retainedStartOffset: 0 }, buffer };
}
function decode(bytes) {
  let offset = 0; const entries = [];
  while (offset < bytes.length) {
    const headerBytes = bytes.readUInt32LE(offset), payloadBytes = bytes.readUInt32LE(offset + 4); offset += 8;
    const header = JSON.parse(bytes.subarray(offset, offset + headerBytes).toString('utf8')); offset += headerBytes;
    const text = bytes.subarray(offset, offset + payloadBytes).toString('utf16le'); offset += payloadBytes;
    entries.push({ header, text });
  }
  return entries;
}

test('real worker persists the prefix before tail/seal and preserves split Unicode/control data', async t => {
  const dir = await fixture(t), writer = createTerminalRawWindowWriter({ directory: dir });
  t.after(() => writer.close());
  const id = randomUUID();
  assert.equal(writer.start(id, { summary: { pre: { completeWithinRetainedRange: true } }, entries: [entry('\ud83d', 1)] }), true);
  await writer.drain();
  const manifestPath = writer.reference(id), partial = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(partial.state, 'partial'); assert.equal(partial.finalized, false);
  assert.deepEqual(decode(await fs.readFile(path.join(path.dirname(manifestPath), 'stream.part'))).map(e => e.text), ['\ud83d']);
  assert.equal(writer.append(id, { entries: [entry('\ude00\x1b[?2026l\r\n', 2)] }), true);
  assert.equal(writer.seal(id, { summary: { pre: { completeWithinRetainedRange: true }, tail: { complete: true },
    persistenceComplete: true, end: { reason: 'committed-current-frame' } } }), true);
  await writer.drain();
  const final = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(final.state, 'sealed'); assert.equal(final.rawWindowCompleteWithinAdvertisedRange, true);
  const decoded = decode(await fs.readFile(path.join(path.dirname(manifestPath), 'stream.bin')));
  assert.equal(decoded.map(e => e.text).join(''), '😀\x1b[?2026l\r\n');
  assert.equal(decoded[0].text, '\ud83d'); assert.equal(decoded[1].header.seq, 2);
  assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
  assert.equal(writer.snapshot().queuedBytes, 0); assert.equal(writer.snapshot().failures, 0);
});

test('combined real collector/worker: short probe fails, 30s output follows, sealed package has every retained symbol', async t => {
  const dir = await fixture(t), writer = createTerminalRawWindowWriter({ directory: dir });
  t.after(() => writer.close());
  let time = 0;
  const raw = createTerminalRawWindow({ persist: writer, now: () => time });
  t.after(() => raw.dispose());
  const token = {}, identity = { tabId: 'fixture', mirrorGeneration: 'M', lifecycleGeneration: 'L', runSeq: 1, stopRevision: 0 };
  const first = '\x1b[?2026h' + 'pre\r\n'.repeat(10000), late = 'поздний\r\n'.repeat(20000) + '\x1b[?2026l';
  raw.output(token, first, identity); time = 2501;
  const pin = raw.pin(token, { incidentId: 'failed-at-2500', sendIdentity: { handoffId: 'H', attemptId: 'A', operationKey: 'O' }, identity, headlessSeq: 3334 });
  await writer.drain();
  time = 30000; raw.output(token, late, identity);
  raw.commit(token, { authoritativeFrameCommitted: true, synchronizedOutputOpen: false, writeSeq: 4000, flushedSeq: 4000 }, identity);
  await writer.drain();
  const m = JSON.parse(await fs.readFile(pin.manifestPath, 'utf8'));
  assert.equal(m.summary.send.attemptId, 'A'); assert.equal(m.summary.end.at, 30000);
  assert.equal(m.rawWindowCompleteWithinAdvertisedRange, true);
  assert.equal(decode(await fs.readFile(path.join(path.dirname(pin.manifestPath), m.stream))).map(e => e.text).join(''), first + late);
  assert.equal(raw.snapshot().activePins, 0);
});

test('write helper handles partial file writes and refuses a non-progressing disk', async () => {
  const parts = [];
  await writeAll({ async write(bytes, offset, count) { const n = Math.min(count, 2); parts.push(bytes.subarray(offset, offset + n)); return { bytesWritten: n }; } }, Buffer.from('1234567'));
  assert.equal(Buffer.concat(parts).toString(), '1234567');
  await assert.rejects(writeAll({ async write() { return { bytesWritten: 0 }; } }, Buffer.from('x')), /zero-byte-write/);
});

test('dense late output uses the byte budget rather than exhausting one worker message per tiny chunk', async t => {
  const dir = await fixture(t), writer = createTerminalRawWindowWriter({ directory: dir }); t.after(() => writer.close());
  const raw = createTerminalRawWindow({ persist: writer }); t.after(() => raw.dispose());
  const token = {}, identity = { tabId: 'T', mirrorGeneration: 'M', lifecycleGeneration: 'L', runSeq: 1, stopRevision: 0 };
  raw.output(token, 'prefix', identity); const pin = raw.pin(token, { identity, headlessSeq: 1 });
  for (let i = 0; i < 600; i++) raw.output(token, 'x'.repeat(100), identity);
  raw.commit(token, { authoritativeFrameCommitted: true, writeSeq: 601, flushedSeq: 601 }, identity);
  await writer.drain();
  const manifest = JSON.parse(await fs.readFile(pin.manifestPath, 'utf8'));
  assert.equal(manifest.rawWindowCompleteWithinAdvertisedRange, true);
  assert.equal(decode(await fs.readFile(path.join(path.dirname(pin.manifestPath), manifest.stream))).map(x => x.text).join(''), 'prefix' + 'x'.repeat(60000));
});

test('slow worker queue has a hard byte/message bound and never blocks another parser call', () => {
  const worker = new EventEmitter(), messages = [];
  worker.postMessage = value => messages.push(value); worker.unref = () => {}; worker.ref = () => {};
  worker.terminate = async () => {};
  const writer = createTerminalRawWindowWriter({ directory: '/fixture', workerFactory: () => worker,
    maxQueuedBytes: 300000, maxQueuedMessages: 2 });
  const id = randomUUID();
  assert.equal(writer.start(id, { entries: [entry('a'.repeat(20000), 1)] }), false);
  assert.equal(writer.start(id, { entries: [entry('small', 1)] }), true);
  assert.equal(writer.append(id, { entries: Array.from({ length: 32 }, (_, i) => entry('small', 2 + i)) }), true);
  assert.equal(writer.append(id, { entries: Array.from({ length: 32 }, (_, i) => entry('small', 34 + i)) }), false);
  assert.ok(writer.snapshot().queuedBytes <= 300000); assert.equal(messages.length, 2);
  for (const message of messages) worker.emit('message', { requestId: message.requestId, state: 'partial' });
  assert.equal(writer.snapshot().queuedBytes, 0);
});

test('worker errors release transport charges and retain explicit failure state', async () => {
  const worker = new EventEmitter(); worker.postMessage = () => {}; worker.unref = () => {}; worker.ref = () => {}; worker.terminate = async () => {};
  const writer = createTerminalRawWindowWriter({ directory: '/fixture', workerFactory: () => worker });
  writer.start(randomUUID(), { entries: [entry('x', 1)] }); worker.emit('error', Error('disk unavailable'));
  await writer.drain(); assert.equal(writer.snapshot().queuedBytes, 0); assert.equal(writer.snapshot().failures, 1);
  await writer.close();
});

test('worker refusal and diagnostic logger failures remain bounded and never throw', async () => {
  const worker = new EventEmitter(); worker.postMessage = () => {}; worker.unref = () => {}; worker.ref = () => {}; worker.terminate = async () => {};
  let reports=0;
  const writer=createTerminalRawWindowWriter({ directory:'/fixture', workerFactory:()=>worker,
    maxQueuedMessages:1, log(){reports++;throw Error('diagnostic sink');} });
  assert.equal(writer.start(randomUUID(),{entries:[entry('first',1)]}),true);
  for(let i=0;i<100;i++)assert.equal(writer.start(randomUUID(),{entries:[entry('overflow',i)]}),false);
  assert.equal(reports,8);assert.equal(writer.snapshot().suppressedPublications,92);
  worker.emit('error',Error('worker'));await writer.close();
});

test('disk budgets and retention count actual stream files while active prefix stays protected', async t => {
  const dir = await fixture(t), store = createTerminalRawArtifactStore({ directory: dir, maxBytes: 128000, maxArtifacts: 2 });
  t.after(() => store.close());
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  await store.process({ kind: 'start', id: a, summary: {}, entries: [entry('protected', 1)] });
  await store.process({ kind: 'start', id: b, summary: {}, entries: [entry('old', 1)] });
  await store.process({ kind: 'seal', id: b, summary: {} });
  await store.process({ kind: 'start', id: c, summary: {}, entries: [entry('new', 1)] });
  await assert.rejects(fs.stat(path.join(dir, 'raw-' + b)), { code: 'ENOENT' });
  assert.ok(await fs.stat(path.join(dir, 'raw-' + a, 'stream.part')));
  await store.process({ kind: 'append', id: a, entries: [entry('x'.repeat(90000), 2)] });
  await store.process({ kind: 'seal', id: a, summary: { pre: { completeWithinRetainedRange: true }, tail: { complete: true }, persistenceComplete: true } });
  const m = JSON.parse(await fs.readFile(path.join(dir, 'raw-' + a, 'manifest.json'), 'utf8'));
  assert.equal(m.persistenceLost.reason, 'disk-budget'); assert.equal(m.rawWindowCompleteWithinAdvertisedRange, false);
  assert.ok((await store.stats()).bytes <= 128000);
});

test('unfinished prefix is readable after store closes; a new store cannot overwrite it', async t => {
  const dir = await fixture(t), id = randomUUID(), one = createTerminalRawArtifactStore({ directory: dir });
  await one.process({ kind: 'start', id, summary: { incidentId: 'original' }, entries: [entry('saved-prefix', 1)] }); await one.close();
  const two = createTerminalRawArtifactStore({ directory: dir }); t.after(() => two.close());
  const p = path.join(dir, 'raw-' + id, 'manifest.json'), m = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(m.finalized, false); assert.equal(m.state, 'partial');
  await assert.rejects(two.process({ kind: 'start', id, summary: { incidentId: 'replacement' }, entries: [] }), /EEXIST/);
  assert.equal(JSON.parse(await fs.readFile(p, 'utf8')).summary.incidentId, 'original');
});

test('diagnostic directory symlinks are refused without writing their target', async t => {
  const dir = await fixture(t), outside = await fixture(t), link = path.join(dir, 'link'); await fs.symlink(outside, link);
  const store = createTerminalRawArtifactStore({ directory: link });
  await assert.rejects(store.process({ kind: 'start', id: randomUUID(), summary: {}, entries: [] }), /raw-directory-not-regular/);
  assert.deepEqual(await fs.readdir(outside), []);
});
