'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), syncFs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), { spawnSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const sourceDir = process.env.ACTUAL_SOURCE_DIR || __dirname;
const { createTerminalRawWindowWriter } = require(path.join(sourceDir, 'terminal-raw-window-writer'));
const entry = (text, seq) => {
  const buffer = Buffer.allocUnsafeSlow(text.length * 2); buffer.write(text, 'utf16le');
  return { buffer, descriptor: { seq, retainedCodeUnits: text.length, originalCodeUnits: text.length } };
};
const summary = { pre: { completeWithinRetainedRange: true }, tail: { complete: true }, persistenceComplete: true };
async function dir(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-exception-proof-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
function faultStore(directory, options = {}) {
  let failInventory = false, streamWriteBudget = Infinity;
  const controlledFs = { ...fs,
    async readdir(...args) { if (failInventory && args[0] === directory) { failInventory = false; throw Object.assign(Error('controlled inventory EIO'), { code: 'EIO' }); }
      return fs.readdir(...args); },
    async open(...args) {
      const handle = await fs.open(...args);
      if (!String(args[0]).endsWith('stream.part')) return handle;
      return { sync: () => handle.sync(), close: () => handle.close(), async write(...values) {
        if (--streamWriteBudget < 0) throw Object.assign(Error('controlled stream EIO'), { code: 'EIO' });
        return handle.write(...values);
      } };
    },
  };
  const ctx = vm.createContext({ Buffer, module: { exports: {} }, exports: {},
    require: name => name === 'node:fs/promises' ? controlledFs : require(name) });
  vm.runInContext(syncFs.readFileSync(path.join(sourceDir, 'terminal-raw-window-worker.js'), 'utf8'), ctx);
  const store = ctx.module.exports.createTerminalRawArtifactStore({ directory, ...options });
  return { store, failInventory: () => { failInventory = true; }, failStreamAfter: count => { streamWriteBudget = count; } };
}

test('actual worker inventory EIO cannot become a complete artifact after a later successful seal', async t => {
  const directory = await dir(t), h = faultStore(directory), id = randomUUID(); t.after(() => h.store.close());
  await h.store.process({ kind: 'start', id, summary, entries: [entry('prefix', 1)] });
  h.failInventory();
  await assert.rejects(h.store.process({ kind: 'append', id, entries: [entry('lost-A', 2), entry('lost-B', 3)] }), /controlled inventory EIO/);
  await h.store.process({ kind: 'seal', id, summary });
  const m = JSON.parse(await fs.readFile(path.join(directory, 'raw-' + id, 'manifest.json'), 'utf8'));
  assert.equal(m.rawWindowCompleteWithinAdvertisedRange, false, JSON.stringify(m));
  assert.equal(m.persistenceLost.events, 2); assert.equal(m.persistenceLost.codeUnits, 12);
  assert.equal(m.persistenceLost.fromSeq, 2); assert.equal(m.persistenceLost.toSeq, 3);
  assert.equal(m.recordsWritten, 1);
});

test('actual worker mid-batch EIO accounts for both the damaged record and untouched remainder', async t => {
  const directory = await dir(t), h = faultStore(directory), id = randomUUID(); t.after(() => h.store.close());
  await h.store.process({ kind: 'start', id, summary, entries: [entry('prefix', 1)] });
  h.failStreamAfter(4); // Complete first record, then second prefix, then EIO; third was not attempted.
  await assert.rejects(h.store.process({ kind: 'append', id,
    entries: [entry('good', 2), entry('lost-A', 3), entry('lost-B', 4)] }), /controlled stream EIO/);
  await h.store.process({ kind: 'seal', id, summary });
  const m = JSON.parse(await fs.readFile(path.join(directory, 'raw-' + id, 'manifest.json'), 'utf8'));
  assert.equal(m.persistenceLost.events, 2); assert.equal(m.persistenceLost.codeUnits, 12);
  assert.equal(m.persistenceLost.partialRecordPossible, true); assert.equal(m.recordsWritten, 2);
  assert.equal(m.rawWindowCompleteWithinAdvertisedRange, false);
});

test('actual writer awaited close keeps its real worker alive until the final manifest is persisted', async t => {
  const directory = await dir(t), id = randomUUID(), done = path.join(directory, 'close-returned');
  const program = `const fs=require('node:fs');const {createTerminalRawWindowWriter}=require(${JSON.stringify(path.join(sourceDir,'terminal-raw-window-writer'))});
    const w=createTerminalRawWindowWriter({directory:${JSON.stringify(directory)}});
    const b=Buffer.allocUnsafeSlow(8);b.write('tail','utf16le');
    w.start(${JSON.stringify(id)},{entries:[{buffer:b,descriptor:{seq:1,originalCodeUnits:4}}],summary:{}});
    w.seal(${JSON.stringify(id)},{summary:${JSON.stringify(summary)}});
    w.close().then(()=>fs.writeFileSync(${JSON.stringify(done)},'drained'));`;
  const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(syncFs.existsSync(done), true, 'Node exited while the awaited close was still unresolved');
  const m = JSON.parse(await fs.readFile(path.join(directory, 'raw-' + id, 'manifest.json'), 'utf8'));
  assert.equal(m.state, 'sealed'); assert.equal(m.recordsWritten, 1);
});

test('actual writer close has a hard bound when a worker never acknowledges or terminates', async () => {
  const worker = new EventEmitter(); worker.postMessage = () => {}; worker.ref = worker.unref = () => {};
  worker.terminate = () => new Promise(() => {});
  const writer = createTerminalRawWindowWriter({ directory: '/controlled', workerFactory: () => worker });
  writer.start(randomUUID(), { entries: [entry('prefix', 1)], summary });
  let settled = false;
  const close = writer.close({ timeoutMs: 30 }).then(r => { settled = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(settled, true, 'close must not wait forever for an unresponsive worker');
  assert.equal((await close).timedOut, true); assert.equal(writer.snapshot().queuedBytes, 0);
});

test('actual writer late seal ACK cannot erase an earlier append failure', async () => {
  const worker = new EventEmitter(), sent = [];
  worker.postMessage = x => sent.push(x); worker.ref = worker.unref = () => {}; worker.terminate = async () => {};
  const writer = createTerminalRawWindowWriter({ directory: '/controlled', workerFactory: () => worker });
  const id = randomUUID(); writer.start(id, { summary, entries: [] });
  writer.append(id, { entries: [entry('lost', 1)] }); writer.seal(id, { summary });
  for (const message of sent) worker.emit('message', { requestId: message.requestId,
    ...(message.kind === 'append' ? { error: 'EIO' } : { state: message.kind === 'seal' ? 'sealed' : 'partial' }) });
  assert.equal(writer.snapshot().statuses.find(x => x.id === id).ok, false);
  assert.equal(writer.snapshot().statuses.find(x => x.id === id).error, 'EIO');
  await writer.close();
});
