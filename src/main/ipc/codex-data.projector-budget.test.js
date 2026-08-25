'use strict';

// The projector cache is bounded by BYTES, not by session count.
//
// Prod scar 2026-08-07 17:45 (tab-3163): the bound was "2 sessions", chosen
// when a giant's projection cost ~150MB. Row-level hydration made a giant
// cost ~13MB, at which point counting sessions stopped describing memory at
// all — an 18-row session and a 16K-row session each took one slot. Opening
// eleven small tabs evicted the giant, and returning to it paid a full 5.5s
// re-parse of an 800MB rollout.

const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');
const {
  estimateProjectorBytes,
  estimateCodexProjectorCacheEntryBytes,
  setCodexHistoryProjectorBudgetMb,
  getCodexHistoryProjectorStats,
  invalidateCodexHistoryProjectors,
} = _api;

test('cost estimate scales with real content, not with row count alone', () => {
  const light = Array.from({ length: 1000 }, (_u, index) => ({
    uuid: 'l' + index, role: 'user', timestamp: 't', content: 'short',
  }));
  const heavy = Array.from({ length: 1000 }, (_u, index) => ({
    uuid: 'h' + index,
    role: 'assistant',
    timestamp: 't',
    content: 'x'.repeat(2000),
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: 'c' + index,
        toolName: 'Bash',
        args: { command: 'y'.repeat(1000) },
        result: 'z'.repeat(4000),
      },
    }],
  }));
  const lightBytes = estimateProjectorBytes(light);
  const heavyBytes = estimateProjectorBytes(heavy);
  assert.ok(lightBytes > 0);
  assert.ok(heavyBytes > lightBytes * 10, 'content dominates the estimate');
  // Same row count, wildly different cost — the exact property the old
  // count-based bound could not see.
  assert.equal(light.length, heavy.length);
  // A stub-only projection (row window applied) is cheap.
  const stubs = Array.from({ length: 1000 }, (_u, index) => ({
    uuid: 's' + index, role: 'user', timestamp: 't', rowStub: true,
  }));
  assert.ok(estimateProjectorBytes(stubs) < heavyBytes / 10);
  assert.equal(estimateProjectorBytes([]), 0);
});

test('byte accounting itself bounds empty and tiny projector sessions', () => {
  const empty = estimateCodexProjectorCacheEntryBytes([], []);
  const tiny = estimateCodexProjectorCacheEntryBytes(
    [{ uuid: 'h1', role: 'user', content: 'hello' }],
    [{ uuid: 't1', type: 'user', content: 'hello' }],
  );
  assert.equal(empty, 1024 * 1024);
  assert.equal(tiny, empty);
  assert.equal(getCodexHistoryProjectorStats().minimumSessionBytes, empty);
  assert.ok(
    Math.floor(getCodexHistoryProjectorStats().budgetBytes / empty) >= 1,
    'the configured byte budget always admits at least one projector',
  );
});

test('budget is clamped to a sane range and reported in stats', () => {
  const before = getCodexHistoryProjectorStats().budgetBytes;
  try {
    setCodexHistoryProjectorBudgetMb(700);
    assert.equal(getCodexHistoryProjectorStats().budgetBytes, 700 * 1024 * 1024);
    // A typo must not claim the whole main-process heap…
    setCodexHistoryProjectorBudgetMb(999999);
    assert.equal(getCodexHistoryProjectorStats().budgetBytes, 2048 * 1024 * 1024);
    // …nor shrink below one resident giant.
    setCodexHistoryProjectorBudgetMb(1);
    assert.equal(getCodexHistoryProjectorStats().budgetBytes, 64 * 1024 * 1024);
    // Garbage leaves the current value untouched.
    setCodexHistoryProjectorBudgetMb('not a number');
    assert.equal(getCodexHistoryProjectorStats().budgetBytes, 64 * 1024 * 1024);
  } finally {
    setCodexHistoryProjectorBudgetMb(Math.round(before / (1024 * 1024)));
    invalidateCodexHistoryProjectors();
  }
});

test('stats start empty and clear with invalidation', () => {
  invalidateCodexHistoryProjectors();
  const stats = getCodexHistoryProjectorStats();
  assert.equal(stats.sessions, 0);
  assert.equal(stats.approxBytes, 0);
  assert.ok(stats.budgetBytes > 0);
});
