const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');

// Execute the actual installed console interception block, not a reimplemented
// model of it. Only the OS file sink/clock/process are substituted.
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = main.indexOf('// ========== PRODUCTION FILE LOGGER ==========');
const end = main.indexOf('// ========== END PRODUCTION FILE LOGGER ==========', start);
assert.ok(start >= 0 && end > start);
const loggerSource = main.slice(start, end);
const turn = () => new Promise((resolve) => setImmediate(resolve));

function harness({ env = {}, createStream, logDir = '/fixture/logs', fsOverrides = {} } = {}) {
  let clock = 10000;
  let error = null;
  const streams = [], written = [], warnings = [];
  const process = new EventEmitter();
  Object.assign(process, { env, pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const console = { log() {}, error() {}, warn(...args) { warnings.push(args.join(' ')); } };
  const mockFs = {
    mkdirSync() {}, existsSync: () => false,
    ...fsOverrides,
    createWriteStream(file, options) {
      const stream = createStream ? createStream(file, options) : new Writable({
        highWaterMark: options.highWaterMark,
        write(chunk, _encoding, callback) {
          const failure = error;
          queueMicrotask(() => {
            if (!failure) written.push(chunk.toString());
            callback(failure);
          });
        },
      });
      streams.push(stream);
      return stream;
    },
  };
  const context = { fs: mockFs, path, crypto, process, console, Buffer,
    isDev: false, __dirname, app: { getPath: () => logDir },
    nodePerformance: { timeOrigin: 1_700_000_000_000, now: () => clock } };
  vm.runInNewContext(loggerSource, context, { filename: 'main-file-logger.js' });
  return { console, process, streams, warnings, written,
    fail(code) { error = Object.assign(new Error(`${code}: simulated file failure`), { code, syscall: 'write' }); },
    recover() { error = null; },
    advance(ms) { clock += ms; },
    text: () => written.join(''),
  };
}

test('ENOSPC is reported and new log events recover the same file without restart', async () => {
  const h = harness();
  await turn();
  h.fail('ENOSPC');
  h.console.log('[HistoryHandoff] before-error');
  await turn();
  assert.ok(h.warnings.some((s) => s.includes('ENOSPC')), 'file error must not disappear silently');
  h.console.log('[HistoryHandoff] retained-while-offline');
  assert.equal(h.streams.length, 1, 'a log burst cannot hammer failed open/write');
  h.recover();
  h.advance(2000);
  h.console.log('[HistoryHandoff] after-recovery');
  await turn(); await turn();
  assert.equal(h.streams.length, 2);
  assert.match(h.text(), /\[LogStream\] RECOVERED.*firstCode=ENOSPC/);
  assert.match(h.text(), /retained-while-offline/);
  assert.match(h.text(), /after-recovery/);
  assert.doesNotMatch(h.text(), /before-error/, 'uncertain accepted bytes must not be blindly replayed');
});

test('a quiet disabled E2E logger never starts from a later console call', async () => {
  const h = harness({ env: { NOTED_E2E_TEST: 'true' } });
  h.console.log('[HistoryHandoff] do-not-create-file');
  h.advance(60000);
  h.console.error(new Error('also disabled'));
  await turn();
  assert.equal(h.streams.length, 0);
});

test('a repeated identical line can trigger recovery; old stream events cannot kill it', async () => {
  const h = harness(); await turn();
  h.fail('EIO'); h.console.log('[Repeated] same'); await turn();
  const old = h.streams[0];
  h.console.log('[Repeated] same');
  h.recover(); h.advance(2000); h.console.log('[Repeated] same');
  await turn(); await turn();
  assert.equal(h.streams.length, 2);
  old.emit('error', Object.assign(new Error('late'), { code: 'EIO' }));
  old.emit('drain'); old.emit('close');
  h.console.log('[Fresh] writer-still-works'); await turn();
  assert.equal(h.streams.length, 2);
  assert.match(h.text(), /writer-still-works/);
  assert.match(h.text(), /firstCode=EIO/);
});

test('a prolonged outage has bounded memory and reports dropped diagnostics', async () => {
  const h = harness(); await turn();
  h.fail('ENOSPC'); h.console.log('[Trigger] fail'); await turn();
  for (let i = 0; i < 1000; i++) h.console.log(`[DuringOutage] ${i}`);
  assert.equal(h.streams.length, 1, 'one thousand lines do not mean one thousand retries');
  h.recover(); h.advance(2000); h.console.log('[Recovered] new');
  await turn(); await turn();
  assert.ok((h.text().match(/\[DuringOutage\]/g) || []).length <= 256);
  assert.match(h.text(), /\[LogBackpressure\] droppedLines=[1-9]/);
  assert.match(h.text(), /queueLimitLines=256 queueLimitBytes=524288/);
});

test('outage is byte-bounded too, not merely bounded by number of lines', async () => {
  const h = harness(); await turn();
  h.fail('ENOSPC'); h.console.log('[Trigger] fail'); await turn();
  for (let i = 0; i < 100; i++) h.console.log(`[Large] ${i}:` + 'x'.repeat(32768));
  h.recover(); h.advance(2000); h.console.log('[Recovered] new');
  await turn(); await turn();
  assert.ok((h.text().match(/\[Large\]/g) || []).length < 16);
  assert.ok(h.text().length < 530000);
  assert.match(h.text(), /droppedBytes=[1-9]/);
});

test('retry backoff is event-driven, bounded and resets after a successful append', async () => {
  const h = harness(); await turn();
  h.fail('ENOSPC'); h.console.log('[Fail] first'); await turn();
  for (const [delay, count] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5], [16000, 6], [30000, 7], [30000, 8]]) {
    h.advance(delay - 1); h.console.log('[NotDue] ' + count);
    assert.equal(h.streams.length, count - 1);
    h.advance(1); h.console.log('[Due] ' + count); await turn();
    assert.equal(h.streams.length, count);
  }
  h.recover(); h.advance(30000); h.console.log('[Success] recovered'); await turn();
  h.fail('EIO'); h.console.log('[Fail] second-outage'); await turn();
  const count = h.streams.length;
  h.recover(); h.advance(1000); h.console.log('[Success] base-delay'); await turn();
  assert.equal(h.streams.length, count + 1);
  assert.match(h.text(), /firstCode=EIO/);
});

test('recovery waits for a successful write, not merely an open event', async () => {
  const records = []; let created = 0; let acceptProbe;
  const h = harness({ createStream(_file, options) {
    const number = ++created;
    return new Writable({ highWaterMark: options.highWaterMark, write(chunk, _enc, done) {
      const text = chunk.toString();
      if (number === 2 && text.includes('[LogStream] RECOVERED')) {
        acceptProbe = () => { records.push(text); done(); };
      } else { records.push(text); queueMicrotask(done); }
    } });
  } });
  await turn();
  h.streams[0].destroy(Object.assign(new Error('lost'), { code: 'EIO' })); await turn();
  h.advance(2000); h.console.log('[Waiting] must-stay-queued');
  h.streams[1].emit('open'); await turn();
  assert.doesNotMatch(records.join(''), /must-stay-queued/);
  acceptProbe(); await turn();
  assert.match(records.join(''), /must-stay-queued/);
});

test('write(false) is accepted once, waits for drain, and cannot make an unlimited queue', async () => {
  const records = [], callbacks = [];
  const h = harness({ createStream() {
    return new Writable({ highWaterMark: 1, write(chunk, _enc, done) {
      records.push(chunk.toString()); callbacks.push(done);
    } });
  } });
  for (let i = 0; i < 400; i++) h.console.log(`[Backpressure] id=${i}`);
  assert.equal(records.length, 1, 'only the accepted session header is in the stream');
  for (let i = 0; callbacks.length && i < 500; i++) { callbacks.shift()(); await turn(); }
  const ids = [...records.join('').matchAll(/\[Backpressure\] id=(\d+)/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 256);
  assert.match(records.join(''), /droppedLines=144/);
});

test('startup open failure recovers, with no second rotation or boot header', async () => {
  const records = []; let calls = 0, rotations = 0;
  const h = harness({
    fsOverrides: { existsSync: () => true, statSync: () => ({ size: 100000000, mtimeMs: Date.now() }),
      rmSync() {}, renameSync() { rotations++; } },
    createStream() {
      if (++calls === 1) throw Object.assign(new Error('file descriptors'), { code: 'EMFILE' });
      return new Writable({ write(chunk, _enc, done) { records.push(chunk.toString()); queueMicrotask(done); } });
    },
  });
  h.advance(2000); h.console.log('[Fresh] after-open-error'); await turn(); await turn();
  assert.equal(rotations, 1);
  assert.equal(calls, 2);
  assert.match(records.join(''), /firstCode=EMFILE/);
  assert.equal((records.join('').match(/--- Session /g) || []).length, 1);
});

test('unexpected close recovers; intentional shutdown never reopens or flushes a stale callback', async () => {
  const h = harness(); await turn();
  h.streams[0].destroy(); await turn();
  h.advance(2000); h.console.log('[Fresh] after-close'); await turn();
  assert.match(h.text(), /firstCode=ERR_STREAM_CLOSED/);
  h.process.emit('exit'); await turn();
  h.advance(60000); h.console.log('[AfterExit] ignore'); await turn();
  assert.equal(h.streams.length, 2);
  assert.doesNotMatch(h.text(), /AfterExit/);
});

test('real filesystem open error recovers in the same process and keeps an append-only log', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-file-logger-'));
  const file = path.join(runDir, 'production.log');
  fs.mkdirSync(file); // A directory at the exact file path makes open fail with EISDIR.
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  let resolveRecovery;
  const recovered = new Promise((resolve) => { resolveRecovery = resolve; });
  const h = harness({ logDir: runDir, fsOverrides: fs, createStream(file, options) {
    const stream = fs.createWriteStream(file, options);
    const write = stream.write;
    stream.write = function(record, callback) {
      if (typeof callback === 'function' && String(record).includes('[LogStream] RECOVERED')) {
        return write.call(this, record, (error) => {
          callback(error);
          if (!error) resolveRecovery();
        });
      }
      return write.call(this, record, callback);
    };
    return stream;
  } });
  const [error] = await once(h.streams[0], 'error');
  assert.equal(error.code, 'EISDIR');
  h.console.log('[HistoryHandoff] retained-during-real-failure');
  fs.rmdirSync(file);
  fs.writeFileSync(file, 'PREEXISTING-DIAGNOSTICS\n');
  h.advance(2000); h.console.log('[HistoryHandoff] resumed-without-restart');
  await recovered;
  const finish = once(h.streams[1], 'finish');
  h.process.emit('exit');
  await finish;
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.startsWith('PREEXISTING-DIAGNOSTICS\n'));
  assert.match(content, /firstCode=EISDIR/);
  assert.match(content, /retained-during-real-failure/);
  assert.match(content, /resumed-without-restart/);
  assert.equal(fs.existsSync(file + '.old'), false, 'recovery must not rotate the active incident log');
});

test('failed recovery retains the original cause even when the next error is different', async () => {
  const h = harness(); await turn();
  h.fail('ENOSPC'); h.console.log('[Failure] disk'); await turn();
  h.fail('EACCES'); h.advance(1000); h.console.log('[Failure] permissions'); await turn();
  assert.doesNotMatch(h.text(), /\[LogStream\] RECOVERED/);
  h.recover(); h.advance(2000); h.console.log('[OK] data'); await turn();
  assert.match(h.text(), /firstCode=ENOSPC lastCode=EACCES/);
  assert.match(h.text(), /failures=2/);
});

test('stdout and stderr broken pipes must not turn a file failure into a crash', async () => {
  const h = harness(); await turn();
  for (const code of ['EIO', 'EPIPE']) {
    assert.doesNotThrow(() => h.process.stdout.emit('error', { code }));
    assert.doesNotThrow(() => h.process.stderr.emit('error', { code }));
  }
  h.console.log('[StillAlive] file-writing'); await turn();
  assert.match(h.text(), /file-writing/);
});

test('synchronous write rejection is counted and does not prevent the next writer', async () => {
  const records = [];
  const h = harness({ createStream() {
    const stream = new Writable({ write(chunk, _enc, done) { records.push(chunk.toString()); queueMicrotask(done); } });
    const write = stream.write;
    stream.write = function(record, callback) {
      if (String(record).includes('[Throw]')) throw Object.assign(new Error('sync rejection'), { code: 'EIO' });
      return write.call(this, record, callback);
    };
    return stream;
  } });
  await turn();
  h.console.log('[Throw] one-rejected-record');
  h.advance(2000); h.console.log('[Fresh] still-readable'); await turn();
  assert.equal(h.streams.length, 2);
  assert.match(records.join(''), /firstCode=EIO/);
  assert.match(records.join(''), /droppedLines=1/);
  assert.match(records.join(''), /still-readable/);
});

test('explicit E2E file logging remains available', async () => {
  const h = harness({ env: { NOTED_E2E_TEST: 'true', NOTED_E2E_FILE_LOG: '1' } });
  h.console.log('[E2E] enabled'); await turn();
  assert.equal(h.streams.length, 1);
  assert.match(h.text(), /\[E2E\] enabled/);
});
