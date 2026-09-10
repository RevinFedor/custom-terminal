import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';
import {
  advanceHistoryPresentationProof,
  createHistoryPresentationProof,
  historyPresentationOwnsWrite,
} from './historyPresentationOwnership.mjs';

// Execute the real scheduler and presentation subscription with deterministic
// timers. This reproduces hidden rangeChanged / delayed visible work / stable
// show without requiring a copy of History's full transcript pipeline.
const source = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const from = source.indexOf('  const scheduleHistoryHydrationRangeCheck = useCallback(');
const to = source.indexOf('  const flushLiveHistoryToDurable = useCallback(', from);
assert.ok(from >= 0 && to > from);
const code = transformSync(source.slice(from, to), { loader: 'ts' }).code;

function harness(presented = true) {
  const timers = new Map();
  const cleanups = [];
  const requests = [];
  let timerId = 0;
  const presentation = { current: createHistoryPresentationProof(presented) };
  const generation = { current: 1 };
  const owner = { current: 'owner-a' };
  const pointer = { current: false };
  const window = new EventTarget();
  const env = {
    tabId: 'tab-a', historyOwnerKey: 'owner-a',
    useCallback: (fn) => fn,
    useEffect: (effect) => cleanups.push(effect()),
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    hydrationRangeIdleTimerRef: { current: null },
    historyPresentationProofRef: presentation,
    historyOwnerKeyRef: owner,
    historyOwnerGenerationRef: generation,
    historyPointerScrollActiveRef: pointer,
    historyScrollSeekController: { isActive: () => false },
    historyJumpHydrationActiveRef: { current: false },
    historyRestoreInFlightRef: { current: 0 },
    maybeRequestHistoryHydration: (reason) => requests.push(reason),
    historyPresentationOwnsWrite,
    historyOwnerDigest: (key) => 'digest:' + key,
    HISTORY_HYDRATION_RANGE_IDLE_MS: 180,
    window,
  };
  const schedule = new Function('env', `const {${Object.keys(env).join(',')}} = env;\n${code}\nreturn scheduleHistoryHydrationRangeCheck;`)(env);
  return {
    schedule, requests, timers, generation, owner, pointer,
    visibility: (shown) => { presentation.current = advanceHistoryPresentationProof(presentation.current, shown); },
    painted: (overrides = {}) => window.dispatchEvent(new CustomEvent('history-panel:surface-presented', {
      detail: { tabId: 'tab-a', owner: 'digest:' + owner.current, generation: generation.current,
        presentationVisit: presentation.current.visit, ...overrides },
    })),
    tick: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
    dispose: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

test('N retained hidden ranges admit no automatic hydration; one shown pane admits one', () => {
  const panes = Array.from({ length: 18 }, () => harness(false));
  panes.forEach((pane) => { pane.schedule(); pane.tick(); });
  assert.equal(panes.flatMap((pane) => pane.requests).length, 0);
  panes[7].visibility(true);
  panes[7].painted();
  panes[7].tick();
  assert.deepEqual(panes[7].requests, ['range-idle']);
  panes.forEach((pane) => pane.dispose());
});

test('a range queued before hide cannot run while hidden or in the next visit', () => {
  const pane = harness();
  pane.schedule(); pane.visibility(false); pane.tick();
  assert.equal(pane.requests.length, 0);
  pane.visibility(true); pane.schedule(); pane.visibility(false); pane.visibility(true); pane.tick();
  assert.equal(pane.requests.length, 0);
  pane.painted(); pane.tick();
  assert.deepEqual(pane.requests, ['range-idle']);
  pane.dispose();
});

test('stable show flushes once without rangeChanged; foreign paint proof cannot wake it', () => {
  const pane = harness(false);
  pane.schedule();
  pane.visibility(true);
  pane.painted({ tabId: 'foreign' });
  pane.painted({ generation: 0 });
  pane.painted({ presentationVisit: 0 });
  assert.equal(pane.timers.size, 0);
  pane.painted(); pane.painted();
  assert.equal(pane.timers.size, 1);
  pane.tick();
  assert.deepEqual(pane.requests, ['range-idle']);
  pane.dispose();
});

test('owner replacement, active pointer and unmount invalidate delayed work', () => {
  const pane = harness();
  pane.schedule(); pane.generation.current += 1; pane.tick();
  pane.schedule(); pane.owner.current = 'owner-b'; pane.tick();
  pane.schedule(); pane.pointer.current = true; pane.tick();
  assert.equal(pane.requests.length, 0);
  pane.pointer.current = false;
  pane.schedule(); pane.dispose(); pane.tick(); pane.painted();
  assert.equal(pane.requests.length, 0);
  assert.equal(pane.timers.size, 0);
});
