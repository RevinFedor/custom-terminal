import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(new URL('./missingFileTracker.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  let now = 10000;
  const calls = [], exports = {};
  const context = vm.createContext({ exports, Date: { now: () => now },
    window: { require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: { invoke: (name, paths) => {
        assert.equal(name, 'file:exists-batch');
        return new Promise((resolve, reject) => calls.push({ paths: Array.from(paths), resolve, reject }));
      } } };
    } } });
  vm.runInContext(compiled, context);
  return { ...exports, calls, advance: ms => now += ms };
}

test('same shared probe is awaitable, deduped and TTL-throttled; notifications only for verdict changes', async () => {
  const f = fixture(); let notices = 0;
  const release = f.subscribeMissingFiles(() => notices++);
  const one = f.probeFiles(['/one', '/one', '']);
  assert.deepEqual(f.calls[0].paths, ['/one']);
  assert.equal(f.fileExistsVerdict('/one'), undefined);
  assert.equal(f.probeFiles(['/one']), one);
  f.calls[0].resolve({ '/one': true }); await one;
  assert.equal(f.fileExistsVerdict('/one'), true); assert.equal(notices, 1);
  await f.probeFiles(['/one']); assert.equal(f.calls.length, 1);
  f.advance(5001); const next = f.probeFiles(['/one']);
  f.calls[1].resolve({ '/one': true }); await next; assert.equal(notices, 1);
  release(); const missing = f.probeFiles(['/one'], true);
  f.calls[2].resolve({ '/one': false }); await missing;
  assert.equal(f.isFileMissing('/one'), true); assert.equal(notices, 1);
});

test('late old forced probe cannot roll back a newer file verdict or inject an unsolicited path', async () => {
  const f = fixture(), first = f.probeFiles(['/one'], true), newer = f.probeFiles(['/one'], true);
  f.calls[1].resolve({ '/one': false, '/foreign': true }); await newer;
  f.calls[0].resolve({ '/one': true }); await first;
  assert.equal(f.fileExistsVerdict('/one'), false); assert.equal(f.fileExistsVerdict('/foreign'), undefined);
});

test('old completion cannot clear the newer in-flight batch; errors/nonboolean remain unknown', async () => {
  const f = fixture(), first = f.probeFiles(['/one'], true), newer = f.probeFiles(['/two'], true);
  f.calls[0].resolve({ '/one': true }); await first;
  assert.equal(f.probeFiles(['/two']), newer); assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ '/two': 'true' }); await newer;
  assert.equal(f.fileExistsVerdict('/two'), undefined);
  const failed = f.probeFiles(['/two'], true); f.calls[2].reject(Error('private failure')); await failed;
  assert.equal(f.fileExistsVerdict('/two'), undefined); assert.equal(f.isFileMissing('/two'), false);
});
