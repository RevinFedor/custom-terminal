import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHistoryPrimarySelectedAddress } from './historyPrimarySelectedAddress.mjs';
import { historyPrimaryAddressCut } from './historyPrimaryPresentationAddress.mjs';
import { pickHistoryGestureAnchorCandidate, chooseHistoryGestureReleaseAnchorMode } from './historyGestureAnchor.mjs';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const printer = ts.createPrinter();
function actual(name, env, property = false) {
  const matches = [];
  const visit = node => {
    if ((property ? ts.isPropertyAssignment(node) : ts.isVariableDeclaration(node))
      && node.name?.getText(tree) === name) matches.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.equal(matches.length, 1, name + ' must identify one actual callback');
  const expression = printer.printNode(ts.EmitHint.Expression, matches[0], tree);
  const js = ts.transpileModule('const callback = ' + expression + '; export default callback;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} }, bindings = { useCallback: fn => fn, ...env };
  new Function(...Object.keys(bindings), 'module', 'exports', js)(...Object.values(bindings), module, module.exports);
  return module.exports.default;
}
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const forbiddenMetadata = new Proxy([], { get() { assert.fail('primary callback consulted N legacy keys/index'); } });
function rig() {
  let current = true, serial = 1;
  const header = () => ({ leaseId: 'L' + serial, ownerKey: 'owner', revision: 'R' + serial,
    generation: 1, semanticIdentity: 'S' + serial, metadataIdentity: 'M' + serial,
    semanticRevisionToken: 'SR' + serial, viewRevisionToken: 'VR' + serial });
  const addresses = new Map(), root = { header: header(), closed: false, totalCount: 10000,
    addressAt: index => addresses.get(index) };
  const address = (key, index) => ({ physicalKey: key, index, header: root.header, cut: historyPrimaryAddressCut(root.header) });
  const requests = [], errors = [], selected = createHistoryPrimarySelectedAddress({
    onError: error => errors.push(error),
    read: (owner, kind, identity, options) => new Promise((resolve, reject) => {
      requests.push({ root: owner, kind, identity, header: owner.header, options, resolve, reject });
    }),
  });
  const env = { primaryRootRef: { current: root }, primaryInputsCurrent: () => current,
    primaryInputTransaction: { run: fn => fn() },
    primaryWheelAddress: selected, primaryResizeAddress: selected,
    displayUnitItemKeysRef: { current: forbiddenMetadata },
    displayEntryIndexByUuidRef: { current: forbiddenMetadata },
    findHistoryUnitIndexByKey: () => assert.fail('primary callback used N inverse'),
  };
  const read = actual('readHistoryWheelAddress', env);
  const keyAt = actual('historyPhysicalItemKeyAt', env);
  return { root, addresses, address, requests, errors, selected, env, read, keyAt,
    refresh() { serial++; root.header = header(); addresses.clear(); },
    setCurrent(value) { current = value; } };
}

test('actual mounted wheel capture seeds one exact key and unseen-header top reads await a point proof', async () => {
  const r = rig(), key = 'entry:\u0000\ud800😀' + 'q'.repeat(1200), initial = r.address(key, 70);
  r.addresses.set(70, initial);
  let index = 70;
  const row = { getAttribute: name => name === 'data-history-unit-key' ? key : null };
  const wrapper = { getAttribute: name => name === 'data-item-index' ? String(index) : null,
    querySelector: () => row, getBoundingClientRect: () => ({ top: 30, bottom: 70 }) };
  const scroller = { isConnected: true, scrollHeight: 1000, clientHeight: 100, scrollTop: 80,
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
    querySelectorAll: () => [wrapper], querySelector: selector => selector.includes('"' + index + '"') ? wrapper : null };
  const capture = actual('captureHistoryWheelGeometryAnchor', { ...r.env,
    historyPhysicalItemKeyAt: r.keyAt, pickHistoryGestureAnchorCandidate });
  const top = actual('readHistoryWheelGeometryAnchorTop', { readHistoryWheelAddress: r.read,
    primaryRootRef: r.env.primaryRootRef, CSS: { escape: String } });
  assert.deepEqual(capture(scroller, 'real'), { identity: key, top: 30, bottomGap: 820 });
  assert.equal(r.selected.peek(r.root, 'key', key).address, initial);
  r.addresses.clear();
  assert.equal(top(scroller, key, true), 30, 'selected anchor proof survives body-window eviction');
  assert.equal(r.requests.length, 0);
  r.refresh();
  assert.equal(top(scroller, key, true), null, 'old rank is not a new-cut identity proof');
  await tick(); assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].identity, key);
  index = 88;
  const fresh = r.address(key, index);
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: fresh }); await tick();
  assert.equal(top(scroller, key, true), 30);
  r.setCurrent(false);
  assert.equal(top(scroller, key, true), null);
  assert.equal(r.keyAt(index), '');
  r.selected.dispose();
});

test('actual wheel release pauses unknown identity and refuses a physical commit until current address exists', async () => {
  const r = rig(), key = 'entry:a';
  r.selected.seed(r.root, 'key', key, r.address(key, 17));
  let controls, position = 100, writes = 0;
  const scroller = { isConnected: true, scrollHeight: 1000, clientHeight: 100,
    removeAttribute() {}, style: { removeProperty() {} } };
  Object.defineProperty(scroller, 'scrollTop', { get: () => position, set: value => { writes++; position = value; } });
  const owner = { current: 'owner' }, generation = { current: 1 };
  const settle = actual('settleHistoryWheelGeometryRelease', {
    readHistoryWheelAddress: r.read, measureHistoryWheelGeometryRelease: () => ({ trailingHeightDelta: 0, measuredRows: 0 }),
    chooseHistoryGestureReleaseAnchorMode, restoreHistoryWheelGeometryRows() {}, setHistorySeekPresentationEpoch() {},
    setHistorySeekGeometryMask() {}, readHistoryWheelGeometryAnchorTop: () => 30,
    historyOwnerKeyRef: owner, historyOwnerGenerationRef: generation,
    historyPresentationProofRef: { current: { visit: 1, presented: true } },
    historyPresentationOwnsWrite: (proof, visit) => proof.presented && proof.visit === visit,
    settleHistoryVisualAnchor: opts => { controls = opts; return () => {}; },
    historyScrollSeekController: { isActive: () => false },
    historyRestoreInFlightRef: { current: 0 }, historyScrollInFlightRef: { current: null },
    hydrationRequestInFlightRef: { current: false }, historyPointerScrollActiveRef: { current: false },
    terminalPreviewAnchorSettleCancelRef: { current: null }, historyUserGestureGenerationRef: { current: 1 },
    historyWheelGeometryReleaseSettleCancelRef: { current: null }, historyTabIdRef: { current: 'tab' }, historyDiag() {},
  });
  settle({ scroller, identity: key, targetTop: 30, ownerKey: 'owner', ownerGeneration: 1,
    presentationVisit: 1, gestureGeneration: 1, source: 'hydration-apply', bottomGap: 100 });
  assert.equal(controls.isCurrent(), true); assert.equal(controls.isPaused(), false);
  r.refresh();
  assert.equal(controls.isCurrent(), true, 'pending preserves the selected anchor intent');
  assert.equal(controls.isPaused(), true);
  controls.commitVisualOffset(10, 'settled'); assert.equal(writes, 0);
  await tick(); assert.equal(r.requests.length, 1);
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: r.address(key, 24) }); await tick();
  assert.equal(controls.isPaused(), false);
  controls.commitVisualOffset(10, 'settled'); assert.equal(writes, 1); assert.equal(position, 90);
  owner.current = 'foreign';
  assert.equal(controls.isCurrent(), false);
  controls.commitVisualOffset(10, 'cancelled'); assert.equal(writes, 1);
  r.selected.dispose();
});

test('actual resize jump awaits exact address once, refuses stale await and never falls back through N indexes', async () => {
  const r = rig(), writes = [], gesture = { current: 1 }, owner = { current: 'owner:v1' }, restore = { current: 7 };
  const jump = actual('jumpToKey', { ...r.env, owner: () => owner.current,
    historyUserGestureGenerationRef: gesture, historyPresentationProofRef: { current: { presented: true } },
    resizeToken: 7, historyRestoreInFlightRef: restore,
    virtuosoRef: { current: { scrollToIndex: request => writes.push(request) } },
  }, true);
  const pending = jump('entry:a', 'a'); await tick();
  assert.equal(writes.length, 0); assert.equal(r.requests.length, 1);
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: r.address('entry:a', 912) });
  assert.equal(await pending, true); assert.deepEqual(writes[0], { index: 912, align: 'start', behavior: 'auto' });
  for (let i = 0; i < 20; i++) assert.equal(await jump('entry:a', 'a'), true);
  assert.equal(r.requests.length, 1, 'repeated convergence frames reuse one selected exact address');
  r.refresh();
  const stale = jump('entry:a', 'a'); await tick();
  assert.equal(r.requests.length, 2);
  const old = r.requests[1], oldAddress = r.address('entry:a', 18); r.refresh();
  old.resolve({ root: r.root, header: old.header, address: oldAddress });
  const before = writes.length; assert.equal(await stale, true);
  assert.equal(writes.length, before, 'late old header resumes controller without a stale position write');
  const cancelled = jump('entry:a', 'a'); await tick();
  restore.current = 0;
  r.requests.at(-1).resolve({ root: r.root, header: r.root.header, address: r.address('entry:a', 11) });
  assert.equal(await cancelled, true);
  assert.equal(writes.length, before, 'disposed/superseded resize token cannot write even under the same owner/header');
  restore.current = 7;
  r.setCurrent(false); assert.equal(await jump('entry:a', 'a'), true); assert.equal(writes.length, before);
  r.setCurrent(true);
  const failed = jump('entry:a', 'a'); await tick();
  const error = Object.assign(new Error('UNKNOWN'), { code: 'HISTORY_READ_QUOTA' });
  r.requests.at(-1).reject(error); await assert.rejects(failed, { code: 'HISTORY_READ_QUOTA' });
  assert.equal(writes.length, before);
  r.selected.dispose();
});

test('actual resize UUID fallback reuses one current subject after the old physical key is absent', async () => {
  const r = rig(), writes = [];
  const jump = actual('jumpToKey', { ...r.env, owner: () => 'owner:v1', resizeToken: 4,
    historyRestoreInFlightRef: { current: 4 }, historyUserGestureGenerationRef: { current: 1 },
    historyPresentationProofRef: { current: { presented: true } },
    virtuosoRef: { current: { scrollToIndex: request => writes.push(request) } },
  }, true);
  const first = jump('old-key', 'u'); await tick();
  assert.equal(r.requests[0].kind, 'key');
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: null }); await tick();
  assert.equal(r.requests.length, 2); assert.equal(r.requests[1].kind, 'entry');
  r.requests[1].resolve({ root: r.root, header: r.root.header, address: r.address('new-key', 23) });
  assert.equal(await first, true);
  for (let frame = 0; frame < 20; frame++) {
    const next = jump('old-key', 'u'); await tick();
    assert.equal(r.requests.length, 2, 'actual callback cannot restart key and UUID reads every frame');
    assert.equal(await next, true);
  }
  assert.equal(writes.length, 21);
  assert(writes.every(write => write.index === 23));
  r.selected.dispose();
});
