import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { patchNodePtyWriteTrace, PTY_WRITE_TRACE_SHA, prepareNodePtyWriteTrace } from './node-pty-write-trace.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createCodexSlashInputDiagnostic } = require('../src/main/codex-slash-input-diagnostics');
const original = await fs.readFile(new URL('../node_modules/node-pty/lib/unixTerminal.js', import.meta.url), 'utf8');
const patched = patchNodePtyWriteTrace(original);
const symbol = Symbol.for('noted.pty.writeTrace.v1');

// The actual pinned upstream class, not a parallel writer. Only fd callbacks,
// setImmediate and clock are controlled. No native binary/GUI/provider starts.
function writer(source = patched) {
  const pending = [], calls = [], immediates = new Set(), errors = [];
  let time = 100;
  const context = vm.createContext({ Buffer, Symbol, console: { error: (...args) => errors.push(args) },
    fs: { write(fd, buffer, offset, callback) { calls.push({ fd, bytes: [...buffer], offset }); pending.push(callback); } },
    setImmediate(fn) { immediates.add(fn); return fn; }, clearImmediate(fn) { immediates.delete(fn); },
  });
  const begin = source.includes('function notedPtyWriteTrace(') ? source.indexOf('function notedPtyWriteTrace(')
    : source.indexOf('var CustomWriteStream =');
  vm.runInContext(source.slice(begin, source.indexOf('//# sourceMappingURL', begin)) + '\nthis.Stream=CustomWriteStream;', context);
  const stream = new context.Stream(77, 'utf8'), term = { _writeStream: stream, write: data => stream.write(data) };
  const publications = [];
  const diagnostic = createCodexSlashInputDiagnostic({ command: '/compact', now: () => time,
    log: row => publications.push(row), readState: () => ({ outboundAvailable: stream.notedWriteTraceVersion === 1 }) });
  return { stream, term, diagnostic, calls, pending, immediates, errors, publications,
    at: value => { time = value; },
    send: (kind, data, ordinal = 1) => diagnostic.withWrite(term, kind, ordinal, () => term.write(data)),
    ack: (written, code) => { assert.ok(pending.length); pending.shift()(code ? { code, message: 'PRIVATE' } : null, written); },
    immediate: () => { assert.equal(immediates.size, 1); const fn = [...immediates][0]; immediates.delete(fn); fn(); },
  };
}

test('exact patch is pinned/idempotent; arbitrary upstream or patched drift refuses', () => {
  assert.equal(createHash('sha256').update(patched).digest('hex'), PTY_WRITE_TRACE_SHA);
  assert.equal(patchNodePtyWriteTrace(patched), patched);
  assert.throws(() => patchNodePtyWriteTrace(original + '\n'), /source drift/);
  assert.throws(() => patchNodePtyWriteTrace(patched + '\n'), /source drift/);
});

test('enqueue vs predecessor wait vs own fd callback distinguish the missing 14s boundary', () => {
  const h = writer(); h.term.write('PREDECESSOR');
  h.at(200); h.send('paste', '/compact');
  let task = h.diagnostic.snapshot().outboundTasks[0];
  assert.equal(task.stages['outbound-enqueue'].firstAt, 200);
  assert.equal(task.stages['outbound-enqueue'].last.aheadCount, 1);
  assert.equal(task.stages['outbound-enqueue'].last.aheadBytes, 11);
  assert.equal(task.stages['outbound-fd-call'], undefined);
  h.at(10000); h.ack(11);
  h.at(14000); h.ack(8);
  task = h.diagnostic.snapshot().outboundTasks[0];
  assert.equal(task.stages['outbound-fd-call'].firstAt, 10000);
  assert.equal(task.stages['outbound-fd-callback'].firstAt, 14000);
  assert.equal(h.publications.at(-1).outcome, 'outbound-result');
  assert.equal(h.diagnostic.snapshot().stages['raw-output'], undefined, 'fd callback is not CLI consumption/output');
  assert.equal(h.calls.length, 2);
});

test('partial and EAGAIN callbacks keep one exact task, offsets and existing retry order', () => {
  const h = writer(); h.send('paste', 'é/compact');
  h.at(300); h.ack(2); h.at(400); h.ack(undefined, 'EAGAIN');
  assert.equal(h.pending.length, 0); h.at(500); h.immediate(); h.at(600); h.ack(8);
  assert.deepEqual(h.calls.map(c => c.offset), [0, 2, 2]);
  const row = h.diagnostic.snapshot(), task = row.outboundTasks[0];
  assert.equal(task.stages['outbound-enqueue'].last.bytesTotal, 10, 'bytes, not UTF-16 chars');
  assert.equal(task.stages['outbound-fd-call'].count, 3);
  assert.equal(task.stages['outbound-fd-callback'].last.offsetAfter, 10);
  assert.deepEqual(row.stages['outbound-fd-callback'].errorCodeCounts, { EAGAIN: 1 });
  assert.equal(h.publications.length, 1);
});

test('unexpected fd error identifies abandoned follower without fabricating its fd call', () => {
  const h = writer(); h.term.write('BEFORE'); h.send('paste', '/compact'); h.ack(undefined, 'EIO');
  const task = h.diagnostic.snapshot().outboundTasks[0];
  assert.equal(task.stages['outbound-abandoned'].last.errorCode, 'EIO');
  assert.equal(task.stages['outbound-fd-call'], undefined);
  assert.equal(h.stream._writeQueue.length, 0);
  assert.equal(h.errors.length, 1, 'original upstream error behavior retained');
  assert.equal(JSON.stringify(h.diagnostic.snapshot()).includes('PRIVATE'), false);
});

test('large predecessor inventory is bounded and partial byte measurement is explicit', () => {
  const h = writer();
  for (let i = 0; i < 200; i++) h.term.write('x');
  h.send('paste', '/compact');
  const enqueue = h.diagnostic.snapshot().outboundTasks[0].stages['outbound-enqueue'].last;
  assert.equal(enqueue.aheadCount, 200); assert.equal(enqueue.aheadBytes, 128);
  assert.equal(enqueue.aheadBytesComplete, false);
});

test('dispose and late callback are separate observations, never new application writes', () => {
  const h = writer(); h.send('enter', '\r'); h.stream.dispose(); h.ack(1);
  const task = h.diagnostic.snapshot().outboundTasks[0];
  assert.equal(task.stages['outbound-dispose'].count, 1);
  assert.equal(task.stages['outbound-fd-callback'].last.complete, true);
  assert.equal(h.calls.length, 1); assert.equal(h.publications.length, 2);
});

test('task retains original observer after scope ends; later foreign write is not attributed', () => {
  const h = writer(); h.send('paste', '/compact');
  assert.equal(h.stream[symbol], undefined); h.term.write('FOREIGN'); h.ack(8); h.ack(7);
  assert.equal(h.diagnostic.snapshot().outboundTasks.length, 1);
  assert.equal(JSON.stringify(h.diagnostic.snapshot()).includes('FOREIGN'), false);
});

test('nested scopes restore their previous owner even when original write throws', () => {
  const h = writer(), seen = [];
  const previous = { observe: e => seen.push(e.phase) }; h.stream[symbol] = previous;
  const other = createCodexSlashInputDiagnostic({ command: '/model' });
  assert.throws(() => h.diagnostic.withWrite(h.term, 'paste', 1, () => {
    other.withWrite(h.term, 'enter', 1, () => h.term.write('\r'));
    h.term.write('/compact'); throw Error('WRITE_THROW');
  }), /WRITE_THROW/);
  assert.equal(h.stream[symbol], previous); h.ack(1); h.ack(8);
  assert.equal(other.snapshot().outboundTasks.length, 1);
  assert.equal(h.diagnostic.snapshot().outboundTasks.length, 1);
  assert.deepEqual(seen, []);
});

test('observer exceptions do not affect byte order, retry count or upstream error behavior', () => {
  const outcomes = [];
  for (const source of [original, patched]) {
    const h = writer(source); h.stream[symbol] = { observe() { throw Error('DIAGNOSTIC'); } };
    h.term.write('ABC'); h.term.write('DEF'); h.ack(1); h.ack(undefined, 'EAGAIN');
    h.immediate(); h.ack(2); h.ack(undefined, 'EIO');
    outcomes.push({ calls: h.calls, queue: h.stream._writeQueue.length,
      pending: h.pending.length, immediates: h.immediates.size, errors: h.errors.length });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('late fd callback survives ring eviction and release; aggregate budget/loss are explicit', () => {
  const h = writer(); h.send('paste', '/compact'); h.diagnostic.publish('observation-result');
  for (let i = 0; i < 1000; i++) h.diagnostic.record('raw-output', { chars: 1 });
  h.diagnostic.record('released'); h.diagnostic.publish('released'); h.at(14000); h.ack(8);
  const last = h.publications.at(-1);
  assert.equal(last.outcome, 'outbound-result'); assert.ok(last.droppedEvents > 0);
  assert.equal(last.outboundTasks[0].stages['outbound-enqueue'].firstAt, 100);
  assert.equal(last.outboundTasks[0].stages['outbound-fd-callback'].lastAt, 14000);
  for (let i = 0; i < 20; i++) { h.send('enter', '\r', i); h.ack(1); }
  const row = h.diagnostic.snapshot();
  assert.equal(row.outboundTasks.length, 8); assert.ok(row.droppedOutboundEvents > 0);
  assert.ok(row.suppressedPublications > 0); assert.equal(row.limits.maxPublications, 12);
});

test('dev preparation publishes atomically and refuses drift in a private dependency copy only', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noted-write-trace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'node_modules/node-pty/lib/unixTerminal.js');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, original);
  const old = await fs.open(target, 'r'); t.after(() => old.close());
  assert.equal(await prepareNodePtyWriteTrace(root), original !== patched);
  assert.equal(await old.readFile('utf8'), original);
  assert.equal(await fs.readFile(target, 'utf8'), patched);
  assert.equal(await prepareNodePtyWriteTrace(root), false);
  const cli = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./prepare-node-pty-write-trace.mjs', import.meta.url)), root], { timeout: 5000 });
  assert.match(cli.stdout, /already current/);
  await fs.writeFile(target, original);
  const firstCli = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./prepare-node-pty-write-trace.mjs', import.meta.url)), root], { timeout: 5000 });
  assert.match(firstCli.stdout, /prepared|already current/);
  assert.equal(await fs.readFile(target, 'utf8'), patched);
  await fs.appendFile(target, '\n');
  await assert.rejects(prepareNodePtyWriteTrace(root), /source drift/);
});
