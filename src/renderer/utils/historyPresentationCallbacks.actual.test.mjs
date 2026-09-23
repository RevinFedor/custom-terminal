import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { createHistoryViewportPaintProbe } from './historyViewportPaintProbe.ts';
import { historyPresentationOwnsWrite, resolveHistoryViewportPaintProof } from './historyPresentationOwnership.mjs';
import { saveHistoryMeasuredLayout, getHistoryMeasuredLayout, dropHistoryMeasuredLayout } from './historyMeasuredLayout.ts';

const file = path.resolve(import.meta.dirname, '../components/Workspace/HistoryPanel.tsx');
const source = fs.readFileSync(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let rangeBody, emptyEffect, convergenceBody, resizeFinishBody;
function walk(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'rangeChanged'
    && node.initializer?.expression?.getText(tree).includes('viewportPaintOwner')) rangeBody = node.initializer.expression.getText(tree);
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
    && node.arguments[0]?.getText(tree).includes('transcriptEntries.length !== 0')
    && node.arguments[0]?.getText(tree).includes('[data-history-empty-state]')) emptyEffect = node.arguments[0].getText(tree);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'runHistoryScrollConvergence') convergenceBody = node.getText(tree);
  if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'onFinish'
    && node.initializer.getText(tree).includes('saveHistoryMeasuredLayout')) resizeFinishBody = node.initializer.getText(tree);
  ts.forEachChild(node, walk);
}
walk(tree); assert.ok(rangeBody); assert.ok(emptyEffect); assert.ok(convergenceBody); assert.ok(resizeFinishBody);
const gates = source.slice(source.indexOf('  const armHistoryViewportPaintProof = useCallback('), source.indexOf('  // Virtuoso now renders display UNITS.'));
const warmStart = source.indexOf('      let refreshRaf2 = 0;', source.indexOf('// Warm return:'));
const warmEnd = source.indexOf('      deferredWarmRefreshCancelRef.current = cancelDeferredRefresh;', warmStart);
assert.ok(warmStart > 0 && warmEnd > warmStart);
const warmBody = source.slice(warmStart, warmEnd) + 'return cancelDeferredRefresh;';
const compile = code => transformSync(code, { loader: 'tsx', format: 'cjs' }).code;

function setup() {
  const owner = 'callback-fixture'; dropHistoryMeasuredLayout(owner);
  let serial = 0; const frames = new Map(); const events = [], logs = [], states = [], loads = [];
  const requestFrame = fn => { const id = ++serial; frames.set(id, fn); return id; };
  const cancelFrame = id => frames.delete(id);
  const realRow = { getBoundingClientRect: () => ({ height: 20 }), getAttribute: name => name === 'data-history-row-owner' ? 'dom-owner' : null };
  const scroller = { isConnected: true, querySelector: () => realRow,
    querySelectorAll: selector => selector === '.cb-diff-defer' ? [] : [realRow] };
  const scope = {
    useCallback: fn => fn, tabId: 'tab-fixture', sessionId: 's', toolType: 'claude', cwd: '/fixture',
    historyOwnerKey: owner, historyOwnerKeyRef: { current: owner }, historyOwnerGenerationRef: { current: 1 }, generation: 1,
    historyOwnerDomId: 'dom-owner', historyPresentationProofRef: { current: { presented: true, visit: 1 } },
    viewportReadyOwnerKeyRef: { current: '' }, surfacePresentedOwnerRef: { current: '' },
    displayEntriesRef: { current: [{}] }, setViewportReadyOwnerKey() {}, setViewportProofRequired() {},
    historyResizeRef: { current: { active: () => scope.resizing, refresh() {} } }, resizing: false,
    historyPresentationOwnsWrite, resolveHistoryViewportPaintProof, historyOwnerDigest: key => key,
    historyDiag: line => logs.push(line), recordHistorySurfacePresented() {},
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    visibleRangeRef: { current: null }, scheduleTerminalPreviewHandoffWake() {}, scheduleHistoryHydrationRangeCheck() {},
    mountWaveActiveRef: { current: false }, mountWaveLaneRef: { current: null }, requestHistoryMountWaveStep() {},
    viewportPaintProbeRef: { current: createHistoryViewportPaintProbe({ requestFrame, cancelFrame }) },
    surfacePresentedProbeRef: { current: createHistoryViewportPaintProbe({ requestFrame, cancelFrame }) },
    virtuosoScrollerRef: { current: scroller }, virtuosoRef: { current: { getState: callback => states.push(callback) } },
    historySnapshotCache: { peek: () => ({}) }, historySnapshotOwner: {},
    CSS: { escape: x => x }, visibleSurfaceLoading: true, visibleSurfaceLoadingRef: { current: true },
    loaderHiddenAtRef: { current: null }, performance, displayUnitLayoutKeysRef: { current: ['unit'] },
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    historyRestoreInFlightRef: { current: 0 }, saveHistoryMeasuredLayout, recomputeVisibleUuids() {},
    historyRestoreTokenRef: { current: 0 }, historyUserGestureGenerationRef: { current: 0 },
    historyRevisionRef: { current: {} }, reportInitialLoadSettled() {}, Date,
    surfaceLoading: false, transcriptEntries: [], presentedOwnerKey: owner,
    panelRef: { current: scroller },
    createHistoryViewportPaintProbe: () => createHistoryViewportPaintProbe({ requestFrame, cancelFrame }),
    loadHistory: () => { loads.push(true); return Promise.resolve(true); },
    resizeToken: 1, owner: () => owner + ':' + scope.historyOwnerGenerationRef.current + ':v' + scope.historyPresentationProofRef.current.visit,
    historyScrollSeekController: { stampMachineScrollCooldown() {} }, initialLoadDoneRef: { current: false },
    setHistoryTailFollowIntent() {}, captureHistoryAnchorFromDom: () => ({ uuid: 'row', offsetPx: 0 }),
    setHistoryReadingAnchor() {}, scrollPositionKeyRef: { current: 'position' },
  };
  const context = vm.createContext(scope);
  vm.runInContext(compile(gates + '\nglobalThis.range = ' + rangeBody + ';\nglobalThis.warm = () => {' + warmBody + '};\nglobalThis.emptyEffect = ' + emptyEffect + ';\n' + convergenceBody + '\nglobalThis.converge = runHistoryScrollConvergence;\nglobalThis.resizeFinish = ' + resizeFinishBody + ';'), context);
  const flush = (count = 12) => {
    for (let i = 0; i < count && frames.size; i++) {
      const [id, fn] = frames.entries().next().value; frames.delete(id); fn(0);
    }
  };
  return { scope, context, events, logs, states, loads, flush, frames, owner };
}

test('range proof rejected during resize never latches completion and retries after release', () => {
  const f = setup(); f.scope.resizing = true; f.scope.range({ startIndex: 0, endIndex: 0 }); f.flush(6);
  assert.equal(f.events.length, 0);
  assert.equal(f.scope.surfacePresentedOwnerRef.current, '', 'rejected is not published');
  assert.equal(f.logs.filter(x => x.startsWith('SURFACE_PRESENTED')).length, 0);
  f.scope.resizing = false; f.flush(12);
  assert.equal(f.events.length, 1); assert.equal(f.scope.viewportReadyOwnerKeyRef.current, f.owner);
});

test('empty-state proof waits out resize without a second event or a false completion latch', () => {
  const f = setup(); f.scope.resizing = true; const cleanup = f.scope.emptyEffect(); f.flush(6);
  assert.equal(f.events.length, 0); assert.equal(f.scope.surfacePresentedOwnerRef.current, '');
  f.scope.resizing = false; f.flush(); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].detail.proof, 'painted-empty-state'); cleanup();
});

test('actual convergence rejects a queued jump after the captured resize owner changes', () => {
  const f = setup(); let writes = 0, aborted;
  const captured = f.scope.historyOwnerKeyRef.current + ':' + f.scope.historyOwnerGenerationRef.current;
  f.scope.converge({
    cancelled: () => captured !== f.scope.historyOwnerKeyRef.current + ':' + f.scope.historyOwnerGenerationRef.current ? 'owner-change' : null,
    measureDrift: () => 20, jump: () => { writes++; return true; }, onSettled() {}, onAborted: outcome => { aborted = outcome; },
  });
  f.scope.historyOwnerGenerationRef.current = 2; f.flush();
  assert.equal(writes, 0); assert.equal(aborted.reason, 'owner-change');
});

for (const change of ['generation', 'scroller', 'layout-keys', 'resize-token', 'gesture']) {
  test('late presented getState cannot overwrite geometry after ' + change, () => {
    const f = setup(); f.scope.range({ startIndex: 0, endIndex: 0 }); f.flush();
    assert.equal(f.states.length, 1);
    saveHistoryMeasuredLayout(f.owner, { ranges: [{ startIndex: 0, endIndex: 0, size: 80 }], scrollTop: 400 }, ['unit']);
    if (change === 'generation') f.scope.historyOwnerGenerationRef.current = 3; // A→B→A, same key/visit.
    if (change === 'scroller') f.scope.virtuosoScrollerRef.current = { ...f.scope.virtuosoScrollerRef.current };
    if (change === 'layout-keys') f.scope.displayUnitLayoutKeysRef.current = ['changed-unit'];
    if (change === 'resize-token') f.scope.historyRestoreTokenRef.current++;
    if (change === 'gesture') f.scope.historyUserGestureGenerationRef.current++;
    f.states[0]({ ranges: [{ startIndex: 0, endIndex: 0, size: 40 }], scrollTop: 100 });
    assert.equal(getHistoryMeasuredLayout(f.owner, ['unit'])?.scrollTop, 400);
    dropHistoryMeasuredLayout(f.owner);
  });
}

for (const reject of [false, true]) {
  test('late warm validation ' + (reject ? 'failure' : 'response') + ' cannot start a new read after ABA', async () => {
    const f = setup(); let resolve, fail;
    f.scope.ipcRenderer = { invoke: () => new Promise((yes, no) => { resolve = yes; fail = no; }) };
    f.scope.warm(); f.flush(); assert.equal(typeof resolve, 'function');
    f.scope.historyOwnerGenerationRef.current = 3;
    if (reject) fail(new Error('old validation failed')); else resolve({ success: true, unchanged: false });
    await new Promise(setImmediate);
    assert.equal(f.loads.length, 0);
  });
}

test('current generation still refreshes changed source and saves valid measured geometry', async () => {
  const f = setup(); f.scope.ipcRenderer = { invoke: async () => ({ success: true, unchanged: false }) };
  f.scope.warm(); f.flush(); await new Promise(setImmediate); assert.equal(f.loads.length, 1);
  f.scope.range({ startIndex: 0, endIndex: 0 }); f.flush();
  assert.equal(f.states.length, 1);
  f.states[0]({ ranges: [{ startIndex: 0, endIndex: 0, size: 40 }], scrollTop: 100 });
  assert.equal(getHistoryMeasuredLayout(f.owner, ['unit'])?.scrollTop, 100); dropHistoryMeasuredLayout(f.owner);
});

for (const change of ['scroller', 'layout-keys', 'resize-token', 'gesture']) {
  test('late resize-finish getState cannot overwrite newer geometry after ' + change, () => {
    const f = setup();
    f.scope.historyRestoreInFlightRef.current = 1;
    f.scope.resizeFinish({
      anchor: { kind: 'row' }, owner: f.scope.owner(), scroller: f.scope.virtuosoScrollerRef.current,
      reason: 'restored',
    });
    assert.equal(f.states.length, 1);
    saveHistoryMeasuredLayout(f.owner, { ranges: [{ startIndex: 0, endIndex: 0, size: 80 }], scrollTop: 400 }, ['unit']);
    if (change === 'scroller') f.scope.virtuosoScrollerRef.current = { ...f.scope.virtuosoScrollerRef.current };
    if (change === 'layout-keys') f.scope.displayUnitLayoutKeysRef.current = ['changed-unit'];
    if (change === 'resize-token') f.scope.historyRestoreTokenRef.current++;
    if (change === 'gesture') f.scope.historyUserGestureGenerationRef.current++;
    f.states[0]({ ranges: [{ startIndex: 0, endIndex: 0, size: 40 }], scrollTop: 900 });
    assert.equal(getHistoryMeasuredLayout(f.owner, ['unit'])?.scrollTop, 400);
    dropHistoryMeasuredLayout(f.owner);
  });
}

test('current resize-finish snapshot still persists measured geometry', () => {
  const f = setup();
  f.scope.historyRestoreInFlightRef.current = 1;
  f.scope.resizeFinish({
    anchor: { kind: 'row' }, owner: f.scope.owner(), scroller: f.scope.virtuosoScrollerRef.current,
    reason: 'restored',
  });
  assert.equal(f.states.length, 1);
  f.states[0]({ ranges: [{ startIndex: 0, endIndex: 0, size: 40 }], scrollTop: 900 });
  assert.equal(getHistoryMeasuredLayout(f.owner, ['unit'])?.scrollTop, 900);
  dropHistoryMeasuredLayout(f.owner);
});
