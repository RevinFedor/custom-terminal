'use strict';
// Standalone Node22 fixture, never loaded by the application. The real Worker,
// client protocol, parser and source fences execute. Only private synthetic
// source I/O and explicit import/receive barriers are controlled; no SQL ABI is
// rebuilt. An intentionally unavailable disposable disk cache avoids SQLite.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'), Module = require('node:module');
const { Transform } = require('node:stream');
const fixture = workerData.hostFixture;
const originalPost = parentPort.postMessage.bind(parentPort);
let cold = false, held = false, release;
const barrier = new Promise(resolve => { release = resolve; });
parentPort.on('message', message => { if (message.event === 'fixture-release') release(); });
function announce(stage) { originalPost({ event: 'fixture-barrier', stage }); }
parentPort.postMessage = (message, transfer) => {
  if (message.event === 'diagnostic') {
    if (fixture.stage === 'invalidate-reply' && message.diagnostic.event === 'reply-ready') {
      const epochs = new Int32Array(workerData.sourceEpochBuffer);
      for (let i = 0; i < epochs.length; i++) Atomics.add(epochs, i, 1);
    }
    if (message.diagnostic.event === 'cold-admitted') cold = true;
    if (!held && ((fixture.stage === 'imports' && message.diagnostic.event === 'imports-begin')
      || (fixture.stage === 'database' && message.diagnostic.event === 'database-ready-begin'))) {
      held = true; originalPost(message, transfer); announce(fixture.stage);
      const latch = new Int32Array(fixture.latch);
      if (Atomics.wait(latch, 0, 0, 10000) === 'timed-out') throw Error('fixture barrier deadline');
      return;
    }
  }
  return originalPost(message, transfer);
};
const open = fs.promises.open;
fs.promises.open = async function(file, ...args) {
  const handle = await open.call(this, file, ...args), read = handle.read.bind(handle);
  handle.read = async (...readArgs) => {
    if (!held && cold && fixture.stage === 'cold' && String(file) === fixture.source) {
      held = true; announce('cold'); await barrier;
    }
    return read(...readArgs);
  };
  return handle;
};
const createReadStream = fs.createReadStream;
fs.createReadStream = function(file, ...args) {
  const stream = createReadStream.call(this, file, ...args);
  if (held || !cold || fixture.stage !== 'cold' || String(file) !== fixture.source) return stream;
  held = true; announce('cold');
  const delayed = new Transform({ transform(chunk, encoding, callback) {
    barrier.then(() => { this.push(chunk); callback(); }, callback);
  } });
  stream.on('error', error => delayed.destroy(error));
  return stream.pipe(delayed);
};
function load() {
  const module = new Module(fixture.entry, require.main);
  module.filename = fixture.entry;
  module.paths = Module._nodeModulePaths(require('node:path').dirname(fixture.entry));
  module._compile(fs.readFileSync(fixture.sourceCode || fixture.entry, 'utf8'), fixture.entry);
}
if (fixture.stage === 'receive') {
  const queued = [];
  const buffer = message => { if (message.id) queued.push(message); };
  parentPort.on('message', buffer); announce('receive');
  barrier.then(() => { parentPort.removeListener('message', buffer); load();
    for (const message of queued) parentPort.emit('message', message); });
} else load();
