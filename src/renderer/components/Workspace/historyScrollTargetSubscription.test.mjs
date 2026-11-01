// Pins how HistoryPanel subscribes to the Timeline seek request, and proves
// the behaviour against a real Zustand v5 store with the real selectors
// sliced out of the panel.
//
// Why: every persistent History pane stays mounted — 67 of them in the 31.10
// session. The seek request lives in ONE process-global store field, so when
// all four fields were read raw, a Timeline click re-rendered all 67 panels
// inside the same task. That is the 452ms freeze at 13:37:48.8 UTC where the
// dot loader could not paint and the side panel would not scroll.
//
// The fix moves the `targetTabId === tabId` test INSIDE each selector, so a
// seek aimed at another tab returns the value the panel already had and
// Zustand skips it. This file fails if a selector goes back to reading the
// raw field, and — the part a source-text assertion could not catch — if the
// selector returns a fresh object per call, which would wake every panel
// again despite looking correct.
//
// Run: node --experimental-strip-types --test \
//   src/renderer/components/Workspace/historyScrollTargetSubscription.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');
const { createStore } = require('zustand/vanilla');

const sourcePath = process.env.NOTED_TEST_HISTORY_SOURCE || resolve(HERE, 'HistoryPanel.tsx');
const source = readFileSync(sourcePath, 'utf8');

// ---- slice the real subscriptions -----------------------------------------
// Anchored on surrounding landmarks rather than on the fixed code's own first
// line, so that pre-fix source is sliced and EXECUTED too. Anchoring on the
// fix would make this file abort with "block not found" on old source, which
// looks like detection but proves nothing about behaviour.
const to = source.indexOf('const setHistoryScrollToUuid = useUIStore(');
assert.ok(to > 0, 'the setter subscriptions must follow the seek block');
const blockStart = Math.min(...['const historyScrollToUuid = useUIStore(',
  'const requestedHistoryScrollUuid = useUIStore(']
  .map(anchor => source.indexOf(anchor))
  .filter(index => index > 0 && index < to));
assert.ok(Number.isFinite(blockStart) && blockStart > 0, 'the seek subscription block must exist');
const block = source.slice(blockStart, to);

// Compile the block with `useUIStore` replaced by a recorder that captures the
// selector functions instead of subscribing. This executes the REAL selector
// expressions; a mirror would keep passing if they were reverted.
const selectors = [];
const sandbox = {
  tabId: 'tab-target',
  useUIStore: (selector) => { selectors.push(selector); return selector({ ...state }); },
};
let state = {};
const compiled = transformSync(block, { loader: 'ts' }).code;

function collectSelectors(storeState) {
  selectors.length = 0;
  state = storeState;
  const context = { ...sandbox, state: storeState };
  context.useUIStore = (selector) => { selectors.push(selector); return selector(storeState); };
  vm.createContext(context);
  vm.runInContext(compiled, context);
  return selectors.slice();
}

const seekState = (overrides = {}) => ({
  historyScrollToUuid: null, historyScrollTargetTabId: null,
  historyScrollToolTarget: null, historyScrollRequestGeneration: 0, ...overrides,
});

test('source: the raw target id is never read as a subscription', () => {
  // Reading `s.historyScrollTargetTabId` as its own value (rather than inside
  // a comparison) is what made all 67 panels wake on every seek.
  assert.ok(!/useUIStore\(\(s\)\s*=>\s*s\.historyScrollTargetTabId\s*\)/.test(source),
    'the target id must not be subscribed to directly');
  for (const field of ['historyScrollToUuid', 'historyScrollToolTarget', 'historyScrollRequestGeneration']) {
    const raw = new RegExp(`useUIStore\\(\\(s\\)\\s*=>\\s*s\\.${field}\\s*\\)`);
    assert.ok(!raw.test(source), `${field} must be filtered by tabId inside its selector`);
  }
  assert.match(block, /historyScrollTargetTabId === tabId/, 'each selector applies the ownership test');
});

test('selectors return primitives, not fresh objects', () => {
  // The silent failure mode: a selector that returns `{...}` passes every
  // source check and still re-renders all 67 panels, because Zustand compares
  // with Object.is.
  const picked = collectSelectors(seekState());
  assert.ok(picked.length >= 3, 'the block must register the seek selectors');
  for (const selector of picked) {
    // `null` is a legitimate "not my request" value (and typeof null is
    // 'object' in JS, so the check must be on identity, not typeof): what
    // must never happen is a NEW object or array per call, which Object.is
    // treats as changed and which would wake all 67 panels again.
    const foreign = seekState({ historyScrollTargetTabId: 'tab-other' });
    const first = selector(foreign);
    const second = selector(foreign);
    assert.ok(Object.is(first, second),
      'a selector must return a stable value for unchanged state');
    assert.ok(first === null || typeof first !== 'object',
      'a selector returning a fresh object would defeat the fix');
  }
});

test('a seek aimed at ANOTHER tab leaves this panel\'s values untouched', () => {
  const store = createStore(() => seekState());
  const picked = collectSelectors(store.getState());
  const read = () => picked.map(selector => selector(store.getState()));
  const before = read();

  let wakeups = 0;
  const unsubscribe = picked.map((selector, index) => store.subscribe((next, prev) => {
    if (!Object.is(selector(next), selector(prev))) wakeups++;
  }));

  store.setState({ historyScrollToUuid: 'uuid-abc', historyScrollTargetTabId: 'tab-other',
    historyScrollToolTarget: 'claude', historyScrollRequestGeneration: 1 });

  assert.equal(wakeups, 0, 'a seek for another tab must not wake this panel');
  assert.deepEqual(read(), before, 'values stay exactly as they were');
  unsubscribe.forEach(fn => fn());
});

test('a seek aimed at THIS tab delivers uuid, tool and generation', () => {
  const store = createStore(() => seekState());
  const picked = collectSelectors(store.getState());
  let wakeups = 0;
  const unsubscribe = picked.map((selector) => store.subscribe((next, prev) => {
    if (!Object.is(selector(next), selector(prev))) wakeups++;
  }));

  store.setState({ historyScrollToUuid: 'uuid-abc', historyScrollTargetTabId: 'tab-target',
    historyScrollToolTarget: 'claude', historyScrollRequestGeneration: 7 });

  assert.ok(wakeups >= 3, 'the addressed panel must receive the request');
  const values = picked.map(selector => selector(store.getState()));
  assert.ok(values.includes('uuid-abc'), 'the target uuid reaches the panel');
  assert.ok(values.includes('claude'), 'the tool target reaches the panel');
  assert.ok(values.includes(7), 'the generation reaches the panel');
  unsubscribe.forEach(fn => fn());
});

test('a repeated seek to the same uuid still advances via generation', () => {
  // Clicking the same Timeline dot twice must scroll again. The uuid does not
  // change, so only the generation can carry the second request.
  const store = createStore(() => seekState({
    historyScrollToUuid: 'uuid-abc', historyScrollTargetTabId: 'tab-target',
    historyScrollToolTarget: 'claude', historyScrollRequestGeneration: 1,
  }));
  const picked = collectSelectors(store.getState());
  let wakeups = 0;
  const unsubscribe = picked.map((selector) => store.subscribe((next, prev) => {
    if (!Object.is(selector(next), selector(prev))) wakeups++;
  }));
  store.setState({ historyScrollRequestGeneration: 2 });
  assert.equal(wakeups, 1, 'the generation bump reaches the addressed panel');
  unsubscribe.forEach(fn => fn());
});

test('handing the request from one foreign tab to another stays silent', () => {
  // 65 of the 67 panels own neither side of the handover and must not care.
  const store = createStore(() => seekState({
    historyScrollToUuid: 'uuid-one', historyScrollTargetTabId: 'tab-a',
    historyScrollToolTarget: 'claude', historyScrollRequestGeneration: 1,
  }));
  const picked = collectSelectors(store.getState());
  let wakeups = 0;
  const unsubscribe = picked.map((selector) => store.subscribe((next, prev) => {
    if (!Object.is(selector(next), selector(prev))) wakeups++;
  }));
  store.setState({ historyScrollToUuid: 'uuid-two', historyScrollTargetTabId: 'tab-b',
    historyScrollRequestGeneration: 2 });
  assert.equal(wakeups, 0, 'a foreign-to-foreign handover must not wake this panel');
  unsubscribe.forEach(fn => fn());
});

test('clearing a seek that belonged to THIS tab is delivered', () => {
  const store = createStore(() => seekState({
    historyScrollToUuid: 'uuid-abc', historyScrollTargetTabId: 'tab-target',
    historyScrollToolTarget: 'claude', historyScrollRequestGeneration: 3,
  }));
  const picked = collectSelectors(store.getState());
  let wakeups = 0;
  const unsubscribe = picked.map((selector) => store.subscribe((next, prev) => {
    if (!Object.is(selector(next), selector(prev))) wakeups++;
  }));
  store.setState({ historyScrollToUuid: null, historyScrollTargetTabId: null,
    historyScrollToolTarget: null, historyScrollRequestGeneration: 0 });
  assert.ok(wakeups >= 2, 'the owner must observe its own request being cleared');
  unsubscribe.forEach(fn => fn());
});
