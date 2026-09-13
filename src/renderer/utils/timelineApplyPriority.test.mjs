import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { shouldBypassTimelineApplyPriority } from './timelineApplyPriority.mjs';
import { createHistoryForegroundPriority } from './historyForegroundPriority.mjs';

test('initial visible rail bypasses continuous input for all provider phases', () => {
  for (const phase of ['claude', 'codex', 'gemini', 'cache-hydrate']) {
    assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: true, presented: true,
      hasDurableEntries: false, phase, hasCachedSnapshot: true }), true);
  }
});

test('hidden data and visible populated refresh preserve input priority', () => {
  assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: true, presented: false,
    hasDurableEntries: false, phase: 'claude' }), false);
  assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: true, presented: true,
    hasDurableEntries: true, phase: 'codex' }), false);
  assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: true, presented: false,
    hasDurableEntries: false, phase: 'cache-hydrate', hasCachedSnapshot: true }), false);
});

test('no-cache hydration has no heavy payload even for a hidden owner; stale request can exit', () => {
  assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: true, presented: false,
    hasDurableEntries: false, phase: 'cache-hydrate', hasCachedSnapshot: false }), true);
  assert.equal(shouldBypassTimelineApplyPriority({ ownerCurrent: false, presented: false,
    hasDurableEntries: true, phase: 'claude' }), true);
});

test('actual Timeline callback checks live presentation/gate and stale generation', async () => {
  const source = readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const waitForTimelineApplySlot = async');
  const end = source.indexOf('\n    const loadStartedAt', start);
  assert.ok(start > 0 && end > start);
  const { transformSync } = await import('esbuild');
  const code = transformSync(source.slice(start, end), { loader: 'ts' }).code + '\nwaitForTimelineApplySlot';
  const visible = { current: false }, gate = { current: false }, entries = { current: false };
  let current = true, predicate;
  const wait = vm.runInNewContext(code, { isVisibleRef: visible, historyPresentationGateOpenRef: gate,
    hasDurableEntriesRef: entries, document: { visibilityState: 'visible' },
    shouldBypassTimelineApplyPriority, ownsLoad: () => current, tabId: 'test-209', console: { warn() {} },
    historyForegroundPriority: { waitForBackgroundSlot: async ({ shouldBypass }) => {
      predicate = shouldBypass; return { waitedMs: 0, reason: 'test' };
    } },
  });
  await wait('claude');
  assert.equal(predicate(), false);
  visible.current = true; assert.equal(predicate(), false, 'History paint gate remains required');
  gate.current = true; assert.equal(predicate(), true, 'in-flight hidden request promotes on show');
  entries.current = true; assert.equal(predicate(), false, 'populated refresh remains protected');
  current = false; assert.equal(predicate(), true, 'stale request can exit; ownsLoad rejects its commit');
});

test('pending background postTask cannot strand a Timeline promoted after enqueue', async () => {
  let time = 0, presented = false, waits = 0;
  let finishBackground;
  const priority = createHistoryForegroundPriority({ now: () => time, hasPendingInput: () => false,
    backgroundYield: () => new Promise(resolve => { finishBackground = resolve; }),
    delay: async () => { time += 16; waits++; presented = true; if (waits > 4) throw new Error('promotion starved'); },
  });
  try {
    const result = await priority.waitForBackgroundSlot({ shouldBypass: () => shouldBypassTimelineApplyPriority({
      ownerCurrent: true, presented, hasDurableEntries: false, phase: 'codex',
    }) });
    assert.equal(result.reason, 'bypass');
    assert.ok(waits <= 2);
  } finally { finishBackground?.(); }
});
