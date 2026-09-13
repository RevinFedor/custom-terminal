import test from 'node:test';
import assert from 'node:assert/strict';
import { requestQueuedRewindTarget, pendingQueuedRewindTarget,
  consumeQueuedRewindTarget, cancelQueuedRewindTarget } from './queuedRewindTarget.mjs';

test('Rewind selection requested before Timeline mount is delivered once, and old cleanup cannot erase a newer request', (t) => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  requestQueuedRewindTarget('A', 'first');
  assert.equal(pendingQueuedRewindTarget('A').requestId, 'first');
  requestQueuedRewindTarget('A', 'second');
  consumeQueuedRewindTarget('A', 'first');
  assert.equal(pendingQueuedRewindTarget('A').requestId, 'second');
  consumeQueuedRewindTarget('A', 'second');
  assert.equal(pendingQueuedRewindTarget('A'), null);
  cancelQueuedRewindTarget('A', 'second');
  assert.equal(events.at(-1).type, 'prompt-queue:rewind-target-cancelled');
  assert.equal(events.at(-1).detail.requestId, 'second');
});
