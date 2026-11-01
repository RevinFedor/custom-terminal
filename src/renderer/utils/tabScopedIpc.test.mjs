// Runs the REAL dispatcher (compiled from tabScopedIpc.ts) against a fake
// ipcRenderer, and pins both halves of the contract: delivery must be
// unchanged, and a chunk addressed to one tab must not touch the other 115.
//
// Why: main broadcasts PTY output to the window. Every mounted Terminal used
// to subscribe and reject foreign payloads on its first line, so with ~116
// live terminals each chunk cost 116 calls and 115 rejections. Measured on
// boot mvx7g97w (02:31 UTC): `terminal:data` appeared in 84 long-task
// attributions, 11 855ms of delivery time, single tasks up to 189ms — the
// stall felt right after switching workspaces.
//
// Run: node --experimental-strip-types --test \
//   src/renderer/utils/tabScopedIpc.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');

const sourcePath = process.env.NOTED_TEST_TABSCOPED_SOURCE || resolve(HERE, 'tabScopedIpc.ts');
const source = readFileSync(sourcePath, 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

function build() {
  const registered = new Map();
  const ipc = {
    on(channel, listener) {
      if (!registered.has(channel)) registered.set(channel, []);
      registered.get(channel).push(listener);
    },
    removeListener(channel, listener) {
      const list = registered.get(channel) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) registered.delete(channel);
    },
  };
  const errors = [];
  const sandbox = {
    window: { require: (name) => name === 'electron' ? { ipcRenderer: ipc } : null },
    console: { error: (...args) => errors.push(args.join(' ')) },
    module: { exports: {} }, exports: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = sandbox.module.exports;
  const emit = (channel, payload) => (registered.get(channel) || [])
    .slice().forEach((listener) => listener({ sender: 'main' }, payload));
  return { api, ipc, registered, emit, errors };
}

test('one real listener per channel, no matter how many tabs subscribe', () => {
  // The whole point: 116 terminals must not mean 116 EventEmitter listeners.
  const { api, registered } = build();
  for (let i = 0; i < 116; i++) {
    api.onTabScopedIpcMessage('terminal:data', 'tab-' + i, () => {});
  }
  assert.equal(registered.get('terminal:data').length, 1);
  // Spread: the object is built inside the vm context, so its prototype is a
  // different realm's Object and deepEqual would reject it on identity alone.
  assert.deepEqual({ ...api.tabScopedIpcStats() }, { channels: 1, tabs: 116, handlers: 116 });
});

test('a chunk reaches only the addressed tab', () => {
  const { api, emit } = build();
  const calls = [];
  for (let i = 0; i < 116; i++) {
    api.onTabScopedIpcMessage('terminal:data', 'tab-' + i, () => calls.push(i));
  }
  emit('terminal:data', { tabId: 'tab-42', data: 'x' });
  assert.deepEqual(calls, [42], 'exactly one handler runs; the other 115 are never called');
});

test('payload, event and return path are unchanged', () => {
  const { api, emit } = build();
  let seen = null;
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', (event, payload) => { seen = { event, payload }; });
  const payload = { tabId: 'tab-1', data: 'hello', headlessWriteSeq: 7, pid: 123 };
  emit('terminal:data', payload);
  assert.equal(seen.payload, payload, 'the exact payload object is passed through');
  assert.deepEqual(seen.event, { sender: 'main' }, 'the event argument is preserved');
});

test('delivery order within one tab follows subscription order', () => {
  // A retained pane and a visible one can both listen for the same tab; the
  // terminal relies on the earlier subscriber running first.
  const { api, emit } = build();
  const order = [];
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => order.push('first'));
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => order.push('second'));
  emit('terminal:data', { tabId: 'tab-1' });
  assert.deepEqual(order, ['first', 'second']);
});

test('a throwing handler does not starve its siblings', () => {
  // This is the 01.11 production failure in miniature: on a plain EventEmitter
  // one throwing listener stopped every later subscriber, and History silently
  // stopped receiving messages.
  const { api, emit, errors } = build();
  const reached = [];
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => { throw new Error('boom'); });
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => reached.push('sibling'));
  emit('terminal:data', { tabId: 'tab-1' });
  assert.deepEqual(reached, ['sibling'], 'the second handler still runs');
  assert.ok(errors.some(line => line.includes('[TabScopedIpc]') && line.includes('boom')),
    'the failure is reported, not swallowed');
});

test('unsubscribe detaches exactly one handler', () => {
  const { api, emit } = build();
  const calls = [];
  const off = api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => calls.push('a'));
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => calls.push('b'));
  off();
  emit('terminal:data', { tabId: 'tab-1' });
  assert.deepEqual(calls, ['b'], 'only the unsubscribed handler is gone');
  assert.equal(api.tabScopedIpcStats().handlers, 1);
});

test('unsubscribing twice is harmless', () => {
  const { api } = build();
  const off = api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => {});
  off(); off();
  assert.equal(api.tabScopedIpcStats().handlers, 0);
});

test('the real listener is removed only when the last tab leaves', () => {
  const { api, registered } = build();
  const offA = api.onTabScopedIpcMessage('terminal:data', 'tab-a', () => {});
  const offB = api.onTabScopedIpcMessage('terminal:data', 'tab-b', () => {});
  offA();
  assert.equal(registered.get('terminal:data').length, 1, 'still registered for tab-b');
  offB();
  assert.equal(registered.has('terminal:data'), false, 'detached after the last tab');
});

test('unmounting during delivery does not skip a sibling', () => {
  // A handler may unmount its neighbour mid-chunk (pane teardown on switch).
  // Mutating the live set while iterating would silently drop the sibling.
  const { api, emit } = build();
  const reached = [];
  let offSecond = () => {};
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => { reached.push('first'); offSecond(); });
  offSecond = api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => reached.push('second'));
  emit('terminal:data', { tabId: 'tab-1' });
  assert.deepEqual(reached, ['first', 'second'], 'the already-notified wave completes');
  emit('terminal:data', { tabId: 'tab-1' });
  assert.deepEqual(reached, ['first', 'second', 'first'], 'the next chunk respects the removal');
});

test('a payload without a usable tabId is dropped, not broadcast', () => {
  // `terminal:exit` sends a bare string and deliberately stays on the raw
  // listener; if such a payload ever reached this dispatcher it must not be
  // delivered to everyone.
  const { api, emit } = build();
  const calls = [];
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => calls.push('called'));
  emit('terminal:data', 'tab-1');
  emit('terminal:data', { tabId: null });
  emit('terminal:data', undefined);
  assert.deepEqual(calls, [], 'nothing is delivered without an addressed tabId');
});

test('channels stay isolated from each other', () => {
  const { api, emit } = build();
  const hits = [];
  api.onTabScopedIpcMessage('terminal:data', 'tab-1', () => hits.push('data'));
  api.onTabScopedIpcMessage('claude:tui-ready', 'tab-1', () => hits.push('ready'));
  emit('claude:tui-ready', { tabId: 'tab-1' });
  assert.deepEqual(hits, ['ready']);
});

test('source: Terminal.tsx routes the addressed channels and keeps terminal:exit raw', () => {
  const terminal = readFileSync(resolve(HERE, '../components/Workspace/Terminal.tsx'), 'utf8');
  for (const channel of ['terminal:data', 'claude:session-detected', 'claude:tui-ready',
    'codex:session-detected', 'gemini:session-detected']) {
    assert.ok(terminal.includes(`onTabScopedIpcMessage('${channel}'`),
      `${channel} must go through the dispatcher`);
    assert.ok(!terminal.includes(`ipcRenderer.on('${channel}'`),
      `${channel} must not also register a raw broadcast listener`);
  }
  assert.ok(terminal.includes("ipcRenderer.on('terminal:exit'"),
    'terminal:exit carries a bare tabId string and stays on the raw listener');
});
