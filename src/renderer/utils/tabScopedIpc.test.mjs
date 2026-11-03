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

test('a channel can be routed by a key other than tabId', () => {
  // `agent-transcript:changed` addresses a transcript, not a tab, and its
  // subscribers filter on sessionId. Routing it by tabId would deliver
  // nothing at all — a silent regression that no tabId-only test would see.
  const { api, emit } = build();
  const hits = [];
  api.onTabScopedIpcMessage('agent-transcript:changed', 'sess-1',
    (_event, payload) => hits.push(payload.reason), { key: 'sessionId' });
  emit('agent-transcript:changed', { sessionId: 'sess-1', reason: 'append' });
  emit('agent-transcript:changed', { sessionId: 'sess-2', reason: 'other' });
  assert.deepEqual(hits, ['append'], 'only the addressed session is delivered');
});

test('two routing keys on the same channel stay separate', () => {
  // A caller asking for a different key must not silently join the existing
  // route and start receiving payloads matched on the wrong field.
  const { api, emit, registered } = build();
  const byTab = [], bySession = [];
  api.onTabScopedIpcMessage('mixed', 'x', () => byTab.push('tab'));
  api.onTabScopedIpcMessage('mixed', 'x', () => bySession.push('session'), { key: 'sessionId' });
  assert.equal(registered.get('mixed').length, 2, 'one real listener per route');
  emit('mixed', { tabId: 'x' });
  assert.deepEqual([byTab, bySession], [['tab'], []]);
  emit('mixed', { sessionId: 'x' });
  assert.deepEqual([byTab, bySession], [['tab'], ['session']]);
});

test('source: HistoryPanel routes its broadcast channels', () => {
  const panel = readFileSync(resolve(HERE, '../components/Workspace/HistoryPanel.tsx'), 'utf8');
  assert.ok(panel.includes("onTabScopedIpcMessage(\n      'agent-transcript:terminal-preview', tabId"),
    'terminal-preview must be routed by tabId');
  assert.ok(panel.includes("'agent-transcript:changed', sessionId, onChanged, { key: 'sessionId' }"),
    'transcript changes must be routed by sessionId');
  for (const channel of ['agent-transcript:terminal-preview', 'agent-transcript:changed']) {
    assert.ok(!panel.includes(`ipcRenderer.on('${channel}'`),
      `${channel} must not also register a raw broadcast listener`);
  }
});

test('source: card and control bar route the context channels', () => {
  // These two are rendered per tab, so a broadcast reaches every card at once.
  // Measured 04:13 UTC (after the first round of fixes was installed):
  // codex:context-update delivery reached 1493ms and was the remaining
  // offender in the attribution of tab-switch stalls.
  const signals = readFileSync(resolve(HERE, '../components/Workspace/TabSignals.tsx'), 'utf8');
  const bar = readFileSync(resolve(HERE, '../components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  for (const channel of ['claude:bridge-update', 'codex:context-update']) {
    assert.ok(signals.includes(`onTabScopedIpcMessage('${channel}', tabId`),
      `TabSignals must route ${channel}`);
    assert.ok(!signals.includes(`ipcRenderer.on('${channel}'`),
      `TabSignals must not keep a raw listener for ${channel}`);
  }
  assert.ok(bar.includes("onTabScopedIpcMessage('codex:context-update', tabId"),
    'ClaudeControlBar must route codex:context-update');
  // Ownership checks must survive the move: routing by tab is not a licence
  // to accept a frame from a stale session (fix-bridge-stale-takeover.md).
  assert.ok(signals.includes('isStaleAgainstPending(tabId, frameSessionId)'),
    'the stale-session guard must remain');
  assert.ok(signals.includes('data?.tabId !== tabId'),
    'apply must still reject a foreign tab');
});

test('source: the control bar has no raw broadcast listeners left', () => {
  // 24 control bars were live in the 05:49-05:58 window. Every broadcast
  // channel they listened to ran 24 handlers per event, and the lifecycle
  // ones also wrote 24 diagnostic lines (23 of them `match=false`).
  const bar = readFileSync(resolve(HERE, '../components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const raw = [...bar.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(raw, [], 'every addressed channel must go through the dispatcher');
  const orphan = [...bar.matchAll(/ipcRenderer\.removeListener\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(orphan, [], 'no removeListener may survive without its on()');
  // The transcript channel addresses a session, not a tab.
  assert.ok(bar.includes("'agent-transcript:changed', claudeSessionId, onTranscriptChanged, { key: 'sessionId' }"),
    'transcript changes must be routed by sessionId');
  // Spot-check that busy/cache/lifecycle really went through.
  for (const channel of ['claude:cache-update', 'claude:busy-state', 'codex:busy-state',
    'terminal:command-finished', 'claude:process-started']) {
    assert.ok(bar.includes(`onTabScopedIpcMessage('${channel}', tabId`),
      `${channel} must be routed by tabId`);
  }
});
