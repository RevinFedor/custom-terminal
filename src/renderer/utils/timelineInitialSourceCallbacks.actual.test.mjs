import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const timelinePath = path.resolve(import.meta.dirname, '../components/Workspace/Timeline.tsx');
const historyPath = path.resolve(import.meta.dirname, '../components/Workspace/HistoryPanel.tsx');
const timelineSource = fs.readFileSync(timelinePath, 'utf8');
const historySource = fs.readFileSync(historyPath, 'utf8');
const tree = ts.createSourceFile(timelinePath, timelineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initialLoadEffect = null;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
    && node.arguments[0]?.getText(tree).includes("void loadTimeline('effect').then")) {
    initialLoadEffect = node.arguments[0].getText(tree);
  }
  ts.forEachChild(node, walk);
}
walk(tree);
assert.ok(initialLoadEffect, 'actual Timeline initial-load effect found');
const compiled = transformSync('globalThis.effect = ' + initialLoadEffect + ';', {
  loader: 'tsx', format: 'cjs', target: 'es2022',
}).code;

function fixture() {
  let resolveLoad, rejectLoad;
  const signals = [];
  const scope = {
    historyPresentationGateOpen: true,
    hydratedTimelineOwnerKey: 'owner-a',
    timelineOwnerKey: 'owner-a',
    timelineOwnerKeyRef: { current: 'owner-a' },
    tabId: 'tab-a',
    sessionId: 'session-a',
    onInitialSourceSignalRef: { current: signal => signals.push(signal) },
    loadTimeline: () => new Promise((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    }),
  };
  vm.runInContext(compiled, vm.createContext(scope));
  return { scope, signals, resolveLoad: () => resolveLoad(), rejectLoad: () => rejectLoad(new Error('failed')) };
}

test('old A load observer cannot report success after A to B to A', async () => {
  const f = fixture();
  const cleanup = f.scope.effect();
  assert.equal(typeof cleanup, 'function');
  cleanup();
  f.scope.timelineOwnerKeyRef.current = 'owner-b';
  f.scope.timelineOwnerKeyRef.current = 'owner-a';
  f.resolveLoad();
  await new Promise(setImmediate);
  assert.deepEqual(f.signals, []);
});

test('a current initial load still reports its exact owner', async () => {
  const f = fixture();
  const cleanup = f.scope.effect();
  f.resolveLoad();
  await new Promise(setImmediate);
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0].tabId, 'tab-a');
  assert.equal(f.signals[0].sessionId, 'session-a');
  assert.equal(f.signals[0].ownerKey, 'owner-a');
  assert.equal(f.signals[0].phase, 'load');
  assert.equal(f.signals[0].status, 'success');
  cleanup();
});

test('only the live observer reports a legitimately joined current load', async () => {
  let resolveLoad;
  const shared = new Promise(resolve => { resolveLoad = resolve; });
  const signals = [];
  const scope = {
    historyPresentationGateOpen: true,
    hydratedTimelineOwnerKey: 'owner-a',
    timelineOwnerKey: 'owner-a',
    timelineOwnerKeyRef: { current: 'owner-a' },
    tabId: 'tab-a', sessionId: 'session-a',
    onInitialSourceSignalRef: { current: signal => signals.push(signal) },
    loadTimeline: () => shared,
  };
  vm.runInContext(compiled, vm.createContext(scope));
  const cleanupOld = scope.effect();
  cleanupOld();
  const cleanupCurrent = scope.effect();
  resolveLoad();
  await new Promise(setImmediate);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ownerKey, 'owner-a');
  cleanupCurrent();
});

test('renderer transcript consumers are bound to the complete source owner', () => {
  assert.match(timelineSource, /const consumerId = 'timeline:' \+ ownerKey/);
  assert.match(historySource, /const consumerId = 'history:' \+ ownerKey/);
  assert.match(timelineSource, /ownerKey: expectedHistoryOwnerKey/);
});
