import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { createHistoryWheelTailIntent } from './historyWheelTailIntent.mjs';
import { isHistoryAtContentBottom } from './historyBottomGeometry.mjs';

const source = fs.readFileSync(process.env.NOTED_HISTORY_TAIL_SOURCE
  || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name) {
  let value;
  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) value = node.initializer.getText(tree);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  assert.ok(value, name);
  return transformSync(`globalThis.${name} = ${value};`, {loader: 'tsx', target: 'es2022'}).code;
}
function fixture() {
  let owner = 'visible:A:1', frameId = 0;
  const frames = new Map(), writes = [], resolved = [];
  const scroller = { scrollTop: 64976, scrollHeight: 65517, clientHeight: 541, hasAttribute: () => false };
  const ref = current => ({current});
  const noop = () => {};
  const scope = vm.createContext({
    useCallback: fn => fn, useMemo: fn => fn(),
    performance: { now: () => 1000 },
    isAtBottomRef: ref(true), historyFollowOutputEnabledRef: ref(true), historyTailIntentRevisionRef: ref(0),
    setHistoryFollowOutputEnabled: value => writes.push(value),
    historyWheelDiagnostics: { wrap: (_phase, fn) => fn },
    historyPresentationProofRef: ref({presented: true, visit: 1}), historyInnerOwnedWheelEvents: new WeakSet(),
    historyScrollSeekController: {setScroller: noop, armWheelGesture: noop, armWheelBurst: noop, beginDirectScroll: noop, armKeyScroll: noop},
    virtuosoScrollerRef: ref(scroller), historyScrollerOwnerToken: () => owner,
    historyForegroundPriority: {mark: noop}, HISTORY_FOREGROUND_PRIORITY_HOLD_MS: 100, tabId: 'tab',
    traceHistoryWheelInput: noop, historyUserGestureAtRef: ref(0), historyUserGestureGenerationRef: ref(0),
    hydrationBurstRef: ref({}), historyUserScrollDirectionRef: ref(null), historyFontSize: 16,
    historyTailPinScheduler: {cancel: () => writes.push('cancel'), schedule: task => writes.push(task.shouldPin)},
    scrollRestoreGenRef: ref(0), cancelHistoryScrollFromUser: () => false,
    lastProgrammaticHistoryScrollRef: ref(null), setHistorySeekGeometryMask: noop, historyDiag: noop,
    historyTouchYRef: ref(null), isHistoryAtContentBottom,
    staleOwnerCurtain: false, controlsHeightRef: ref(130), onControlsHeightChange: noop, mainSurface: true,
  });
  vm.runInContext(extract('setHistoryTailFollowIntent'), scope);
  scope.historyWheelTailIntent = createHistoryWheelTailIntent({
    getScroller: () => scope.virtuosoScrollerRef.current,
    getOwnerToken: () => owner,
    getIntentRevision: () => scope.historyTailIntentRevisionRef.current,
    setFollowIntent: value => scope.setHistoryTailFollowIntent(value),
    requestFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelFrame: id => frames.delete(id), onResolved: event => resolved.push(event),
  });
  for (const name of ['handleUserScrollIntent', 'handleHistoryTouchStart', 'handleHistoryScrollerKeyIntent', 'handleControlsHeightChange']) {
    vm.runInContext(extract(name), scope);
  }
  const tick = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn()); };
  const wheel = (deltaY = -2, more = {}) => scope.handleUserScrollIntent({type:'wheel', deltaY, deltaMode:0, timeStamp:1000, isTrusted:true, ...more});
  const drain = () => { for (let i=0; frames.size && i<5; i++) tick(); assert.equal(frames.size, 0); };
  return {scope, scroller, frames, writes, resolved, tick, wheel, drain, owner: value => {owner=value;}};
}

test('actual History input: non-moving upward wheel must not poison composer growth and the next send', () => {
  const f = fixture();
  f.wheel();
  assert.equal(f.scope.isAtBottomRef.current, false, 'suspend immediately, before native scroll');
  assert.ok(f.writes.includes('cancel'), 'the pending tail writer yields immediately');
  f.tick(); assert.equal(f.scope.isAtBottomRef.current, false);
  f.tick(); assert.equal(f.scope.isAtBottomRef.current, true, 'unchanged physical bottom restores only previous follow');
  assert.equal(f.resolved.at(-1).reason, 'no-movement');
  f.scroller.clientHeight -= 29;
  f.writes.length=0;
  f.scope.handleControlsHeightChange(159);
  assert.deepEqual(f.writes, [true], 'composer growth keeps the physical tail instead of turning it into a reader');
});

test('even one pixel of real upward movement keeps reader ownership during later growth', () => {
  for (const distance of [1, 2, 487]) {
    const f = fixture(); f.wheel(-distance); f.scroller.scrollTop -= distance; f.drain();
    assert.equal(f.scope.isAtBottomRef.current, false, `${distance}px must not be rounded into the ordinary bottom threshold`);
    f.writes.length=0; f.scroller.clientHeight -= 29; f.scope.handleControlsHeightChange(159);
    assert.deepEqual(f.writes, [false]);
  }
});

test('consecutive zero-motion packets preserve the same provisional follow owner', () => {
  const f=fixture(); f.wheel(); f.tick(); f.wheel(-1); f.tick(); f.wheel(-2); f.drain();
  assert.equal(f.scope.isAtBottomRef.current, true);
  assert.equal(f.resolved.length, 1);
});

test('native motion between the two callbacks prevents provisional restoration', () => {
  const f=fixture(); f.wheel(); f.tick(); f.scroller.scrollTop-=2; f.drain();
  assert.equal(f.scope.isAtBottomRef.current, false);
});

test('an already-unpinned reader cannot be rearmed by a non-moving upward wheel', () => {
  for (const gap of [0, 2, 300]) {
    const f=fixture(); f.scope.setHistoryTailFollowIntent(false); f.scroller.scrollTop-=gap;
    f.wheel(); f.drain(); assert.equal(f.scope.isAtBottomRef.current, false);
  }
});

test('explicit same-value unpin, owner/visit change, remount, resize and cancellation supersede wheel recovery', () => {
  for (const mutation of [
    f=>f.scope.setHistoryTailFollowIntent(false), // reveal/search may set false again
    f=>f.owner('hidden:A:2'), f=>f.owner('visible:B:1'),
    f=>{f.scope.virtuosoScrollerRef.current={...f.scroller};},
    f=>{f.scroller.scrollHeight+=28;}, f=>{f.scroller.clientHeight-=29;},
    f=>f.scope.historyWheelTailIntent.cancel(),
    f=>f.scope.handleHistoryTouchStart({isTrusted:true,touches:[{clientY:20}]}),
    f=>f.scope.handleHistoryScrollerKeyIntent({isTrusted:true,defaultPrevented:false,key:'PageUp',target:null}),
  ]) {
    const f=fixture(); f.wheel(); mutation(f); f.drain(); assert.equal(f.scope.isAtBottomRef.current, false);
  }
});

test('new downward wheel at a motionless bottom explicitly rearms follow; a reader above it stays put', () => {
  for (const gap of [0, 2, 200]) {
    const f=fixture(); f.scope.setHistoryTailFollowIntent(false); f.scroller.scrollTop-=gap;
    f.wheel(2); f.drain(); assert.equal(f.scope.isAtBottomRef.current, gap===0);
  }
});

test('synthetic, hidden and inner-owned input cannot change History follow', () => {
  const synthetic=fixture(); synthetic.wheel(-2,{isTrusted:false}); assert.deepEqual(synthetic.writes,[]);
  const hidden=fixture(); hidden.scope.historyPresentationProofRef.current.presented=false; hidden.wheel(); assert.deepEqual(hidden.writes,[]);
  const nested=fixture(); const e={isTrusted:true,type:'wheel',deltaY:-2}; nested.scope.historyInnerOwnedWheelEvents.add(e);
  nested.scope.handleUserScrollIntent(e); assert.deepEqual(nested.writes,[]);
});
