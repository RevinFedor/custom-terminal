'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const begin = source.indexOf('async function reconcileCodexWriterFromProcess(tabId, options = {})');
const end = source.indexOf('\n}\n\n/**', begin) + 2;
assert.ok(begin >= 0 && end > begin);

test('native Rewind does not inherit a public read that skipped its scoped process-timeout recovery', async () => {
  const called = [];
  let releasePublic;
  const publicWait = new Promise(resolve => { releasePublic = resolve; });
  const inflight = new Map();
  const runKeyedSingleFlight = (map, key, run) => {
    if (map.has(key)) return map.get(key);
    const promise = Promise.resolve().then(run).finally(() => map.delete(key));
    map.set(key, promise);
    return promise;
  };
  const reconcile = vm.runInNewContext(source.slice(begin, end) + '\nreconcileCodexWriterFromProcess', {
    codexWriterReconcileInflight: inflight, runKeyedSingleFlight,
    getCodexExitObserverGeneration: () => 7,
    getCodexWriterObservationGeneration: () => 12,
    reconcileCodexWriterFromProcessInner: async (_tabId, options) => {
      called.push(options.reason);
      if (options.reason === 'status-read') await publicWait;
      return { reason: options.reason };
    },
  });
  const publicRead = reconcile('T', { reason: 'status-read' });
  const rewind = reconcile('T', { reason: 'codex-rewind-locked-before-first-write' });
  assert.equal((await rewind).reason, 'codex-rewind-locked-before-first-write');
  releasePublic();
  assert.equal((await publicRead).reason, 'status-read');
  assert.deepEqual(called.sort(), ['codex-rewind-locked-before-first-write', 'status-read']);
});
