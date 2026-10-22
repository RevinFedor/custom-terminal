'use strict';

// The real registry under an explicit WebContents-shaped EventEmitter; no
// Electron process, preload bridge, renderer mount or native IPC acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHistoryIpcDemands } = require('./history-ipc-demand');
const { createReadControl, currentReadControl, withReadControl, isHistoryReadCancelled } = require('./history-read-control');
const tick = () => new Promise(resolve => setImmediate(resolve));
function barrier() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class WebContentsSubstitute extends EventEmitter { isDestroyed() { return this.destroyed === true; } }

test('I01 absent/non-WebContents sender cannot create or cancel an undefined-owner read', async () => {
  const registry = createHistoryIpcDemands(); let entered = 0;
  for (const sender of [undefined, null, {}, { id: 1 }]) {
    await assert.rejects(registry.run({ sender }, { readDemandId: 'same' }, () => { entered++; }),
      error => error.code === 'HISTORY_READ_DEMAND_OWNER_INVALID');
    assert.equal(registry.cancel({ sender }, { readDemandId: 'same' }), false);
  }
  assert.equal(entered, 0); assert.deepEqual(registry.stats(), { owners: 0, reads: 0 });
});

test('I02 same request id across senders cannot cross-cancel; cancellation id never reaches business DTO', async () => {
  const registry = createHistoryIpcDemands(), A = new WebContentsSubstitute(), B = new WebContentsSubstitute();
  const gate = barrier(); const controls = [];
  const operation = async payload => { controls.push(currentReadControl());
    assert.deepEqual(payload, { sessionId: 'shared-source', consumerId: 'stable-consumer' });
    await gate.promise; return { success: true }; };
  const payload = { readDemandId: 'same', sessionId: 'shared-source', consumerId: 'stable-consumer' };
  const a = registry.run({ sender: A }, payload, operation), b = registry.run({ sender: B }, payload, operation);
  await tick(); assert.equal(registry.cancel({ sender: A }, payload), true);
  assert.equal(controls[0].signal.aborted, true); assert.equal(controls[1].signal.aborted, false);
  assert.equal(registry.cancel({}, payload), false); gate.resolve();
  await assert.rejects(a, isHistoryReadCancelled); assert.deepEqual(await b, { success: true });
  assert.deepEqual(registry.stats(), { owners: 0, reads: 0 });
  for (const sender of [A, B]) for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    assert.equal(sender.listenerCount(event), 0);
  }
});

test('I03 exact duplicate is rejected; main-frame cross-document navigation revokes, same-document/subframe do not', async () => {
  const registry = createHistoryIpcDemands(), sender = new WebContentsSubstitute(), gate = barrier();
  let control;
  const pending = registry.run({ sender }, { readDemandId: 'one' }, async () => { control = currentReadControl(); await gate.promise; });
  await tick();
  await assert.rejects(registry.run({ sender }, { readDemandId: 'one' }, () => {}),
    error => error.code === 'HISTORY_READ_DEMAND_CONFLICT');
  sender.emit('did-start-navigation', {}, 'same-url', true, true);
  sender.emit('did-start-navigation', {}, 'subframe', false, false);
  assert.equal(control.signal.aborted, false);
  sender.emit('did-start-navigation', {}, 'new-document', false, true);
  assert.equal(control.signal.aborted, true); gate.resolve();
  await assert.rejects(pending, isHistoryReadCancelled);
  assert.deepEqual(registry.stats(), { owners: 0, reads: 0 });
});

test('I04 destroy/process-gone, parent abort and pre-destroyed owner stop response application without global source invalidation', async () => {
  for (const event of ['destroyed', 'render-process-gone', 'parent-abort']) {
    const registry = createHistoryIpcDemands(), sender = new WebContentsSubstitute(), gate = barrier();
    const abort = new AbortController(); let sourceChecks = 0;
    const parent = createReadControl({ signal: abort.signal, assertSourceCurrent() { sourceChecks++; } });
    let child;
    const pending = withReadControl(parent, () => registry.run({ sender }, { readDemandId: 'child' }, async () => {
      child = currentReadControl(); await gate.promise; return { success: true };
    }));
    await tick();
    if (event === 'parent-abort') abort.abort(); else sender.emit(event);
    assert.equal(child.signal.aborted, true); gate.resolve();
    await assert.rejects(pending, isHistoryReadCancelled);
    assert.ok(sourceChecks > 0); assert.deepEqual(registry.stats(), { owners: 0, reads: 0 });
    parent.finish();
  }
  const registry = createHistoryIpcDemands(), sender = new WebContentsSubstitute(); sender.destroyed = true;
  let calls = 0;
  await assert.rejects(registry.run({ sender }, {}, () => { calls++; }), isHistoryReadCancelled);
  assert.equal(calls, 0);
});
