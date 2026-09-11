import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { shouldBypassHistoryApplyPriority } from './historyForegroundPriority.mjs';

// Optional path permits a reproducible before/after run against the frozen
// pre-fix source without editing it or weakening the acceptance assertion.
const sourcePath = process.env.NOTED_TEST_HISTORY_SOURCE
  || fileURLToPath(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('const waitForHistoryApplySlot = async');
const end = source.indexOf('\n    if (!sessionId)', start);
assert.ok(start >= 0 && end > start);
const code = transformSync(source.slice(start, end), { loader: 'ts' }).code + '\nwaitForHistoryApplySlot';

function harness(presented) {
  const ref = { current: { presented } };
  let backgroundCalls = 0;
  let options;
  let release;
  const wait = vm.runInNewContext(code, {
    historyPresentationProofRef: ref,
    historyForegroundPriority: {
      active: () => true,
      waitForBackgroundSlot: (value) => {
        backgroundCalls++;
        options = value;
        return new Promise((resolve) => { release = resolve; });
      },
    },
    shouldBypassHistoryApplyPriority,
    isCurrentOwner: () => true,
    tabId: 'cold-new-tab', loadSequence: 1, historyDiag() {},
  });
  return { wait, ref, calls: () => backgroundCalls, bypass: () => options.shouldBypass(),
    release: () => release?.({ reason: 'bypass', waitedMs: 16 }) };
}

test('actual cold History apply cannot enter background lane while its owner is presented', async () => {
  const h = harness(true);
  const pending = h.wait('cold');
  try {
    assert.equal(h.calls(), 0, 'visible first paint is foreground even during continuous input');
  } finally {
    h.release();
    await pending;
  }
});

test('actual in-flight cold History wait rechecks promotion rather than only owner replacement', async () => {
  const h = harness(false);
  const pending = h.wait('cold');
  try {
    assert.equal(h.calls(), 1);
    assert.equal(h.bypass(), false);
    h.ref.current.presented = true;
    assert.equal(h.bypass(), true, 'opening this pane promotes the already pending read');
  } finally {
    h.release();
    await pending;
  }
});

test('actual visible lightweight service delta bypasses continuous input priority', async () => {
  const h = harness(true);
  await h.wait('refresh', {
    lightweightServiceDelta: true,
    changedCount: 2,
    changedBytes: 2048,
  });
  assert.equal(h.calls(), 0, 'confirmed small service rows must not wait behind typing');
});

test('hidden lightweight service delta waits but promotes as soon as its pane is shown', async () => {
  const h = harness(false);
  const pending = h.wait('refresh', {
    lightweightServiceDelta: true,
    changedCount: 2,
    changedBytes: 2048,
  });
  try {
    assert.equal(h.calls(), 1);
    assert.equal(h.bypass(), false);
    h.ref.current.presented = true;
    assert.equal(h.bypass(), true);
  } finally {
    h.release();
    await pending;
  }
});

test('actual mount-wave arbiter grants first visible paint under input pressure but keeps hidden upgrades deferred', () => {
  const start = source.indexOf('type HistoryMountWaveLane =');
  const end = source.indexOf('\nfunction HistoryPanel(', start);
  assert.ok(start >= 0 && end > start);
  const frames = [];
  const timers = [];
  let busy = true;
  const ran = [];
  const context = {
    historyForegroundPriority: { active: () => busy, remainingMs: () => 0 },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  };
  vm.runInNewContext(transformSync(source.slice(start, end), { loader: 'ts' }).code
    + '\nglobalThis.wave = { lanes: historyMountWaveLanes, request: requestHistoryMountWaveStep };', context);
  const hidden = { wants: false, visible: () => false, run: () => ran.push('hidden') };
  const visible = { wants: false, visible: () => true, run: () => ran.push('visible') };
  context.wave.lanes.add(hidden);
  context.wave.lanes.add(visible);
  context.wave.request(hidden);
  assert.equal(frames.length, 0);
  context.wave.request(visible);
  assert.equal(frames.length, 1, 'foreground first content cannot depend on release of isInputPending');
  frames.shift()();
  assert.deepEqual(ran, ['visible']);
  assert.equal(hidden.wants, true);
  assert.equal(frames.length, 0, 'do not upgrade the whole hidden list behind the first card');
  context.wave.request(visible);
  assert.equal(frames.length, 1, 'finish the visible viewport, not just one card before another indefinite pause');
  frames.shift()();
  busy = false;
  timers.shift()();
  frames.shift()();
  assert.deepEqual(ran, ['visible', 'visible', 'hidden']);
});
