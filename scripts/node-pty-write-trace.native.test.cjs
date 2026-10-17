'use strict';
// Run with ELECTRON_RUN_AS_NODE=1 and the repository Electron executable.
// One disposable shell PTY, no app, GUI, model, profile, clipboard or live data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { createCodexSlashInputDiagnostic } = require('../src/main/codex-slash-input-diagnostics');

test('patched full UnixTerminal records real own fd callback and shell receipt without dependency writes', async t => {
  assert.equal(process.versions.modules, '119', 'use Electron-as-Node; never rebuild shared native dependencies for a test');
  const { patchNodePtyWriteTrace, PTY_WRITE_TRACE_SHA } = await import('./node-pty-write-trace.mjs');
  const file = require.resolve('node-pty/lib/unixTerminal');
  const before = fs.readFileSync(file), patched = patchNodePtyWriteTrace(before.toString());
  const privateModule = new Module(file, module);
  privateModule.filename = file; privateModule.paths = Module._nodeModulePaths(path.dirname(file));
  // Private module instance, same exact relative dependency resolution. Neither
  // require.cache nor installed dependency bytes are replaced.
  privateModule._compile(patched, file);
  let exited = false, sent = false, output = '', exitCode;
  const terminal = new privateModule.exports.UnixTerminal('/bin/sh', ['-c',
    'stty -echo; printf "TRACE_READY\\n"; IFS= read -r line; printf "TRACE_RECEIVED:%s\\n" "$line"'],
    { cwd: '/private/tmp', env: { PATH: '/usr/bin:/bin', TERM: 'xterm' }, cols: 80, rows: 24 });
  const publications = [];
  const diagnostic = createCodexSlashInputDiagnostic({ tabId: 'private-pty-control', command: '/compact',
    log: row => publications.push(row),
    readState: () => ({ outboundAvailable: terminal._writeStream.notedWriteTraceVersion === 1 }) });
  t.after(() => { if (!exited) terminal.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('bounded private PTY control did not exit')), 5000);
    terminal.onExit(event => { exited = true; exitCode = event.exitCode; clearTimeout(deadline); resolve(); });
    terminal.onData(data => {
      output += data;
      if (!sent && output.includes('TRACE_READY')) {
        sent = true;
        diagnostic.withWrite(terminal, 'paste', 1, () => terminal.write('SCALAR_NONCE\r'));
      }
    });
  });
  assert.equal(exitCode, 0); assert.equal(sent, true);
  assert.equal(output.split('TRACE_RECEIVED:SCALAR_NONCE').length - 1, 1);
  const row = diagnostic.snapshot(), task = row.outboundTasks[0];
  assert.equal(row.outboundTasks.length, 1);
  assert.equal(task.stages['outbound-fd-callback'].last.complete, true);
  assert.equal(task.stages['outbound-fd-callback'].last.offsetAfter, 13);
  assert.ok(task.stages['outbound-fd-call'].firstAt >= task.stages['outbound-enqueue'].firstAt);
  assert.ok(task.stages['outbound-fd-callback'].lastAt >= task.stages['outbound-fd-call'].firstAt);
  assert.ok(publications.some(row => row.outcome === 'outbound-result'));
  assert.equal(row.diagnosticErrors, 0);
  assert.equal(JSON.stringify(row).includes('SCALAR_NONCE'), false);
  assert.deepEqual(fs.readFileSync(file), before, 'shared dependency bytes untouched');
  assert.equal(createHash('sha256').update(patched).digest('hex'), PTY_WRITE_TRACE_SHA);
  t.diagnostic(JSON.stringify({ pid: terminal.pid, exited, exitCode, patchedSHA: PTY_WRITE_TRACE_SHA,
    sourceUnchanged: true, outbound: row.outboundTasks, diagnosticErrors: row.diagnosticErrors }));
});

