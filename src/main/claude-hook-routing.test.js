const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clearClaudeHookPidBindingsForTab,
  prebindClaudeHookPid,
  resolveClaudeHookTab,
} = require('./claude-hook-routing');

test('session identity remains the primary Claude hook route', () => {
  const result = resolveClaudeHookTab({
    sessionId: 'session-new',
    ppid: 202,
    sessionByTab: new Map([['tab-session', 'session-new']]),
    tabByPid: new Map([[202, 'tab-pid']]),
    hasTab: () => true,
  });

  assert.deepEqual(result, {
    tabId: 'tab-session',
    source: 'session',
    pid: null,
  });
});

test('a proven Claude PID routes hooks before the first session binding', () => {
  const result = resolveClaudeHookTab({
    sessionId: 'session-new',
    ppid: 202,
    sessionByTab: new Map(),
    tabByPid: new Map([[202, 'tab-pid']]),
    hasTab: (tabId) => tabId === 'tab-pid',
  });

  assert.deepEqual(result, {
    tabId: 'tab-pid',
    source: 'pid',
    pid: 202,
  });
});

test('unknown, stale, and malformed PIDs cannot claim a tab', () => {
  const common = {
    sessionId: 'session-new',
    sessionByTab: new Map(),
    tabByPid: new Map([[202, 'tab-pid']]),
  };

  assert.equal(resolveClaudeHookTab({ ...common, ppid: 'bad' }).tabId, null);
  assert.equal(resolveClaudeHookTab({ ...common, ppid: 303 }).tabId, null);
  assert.equal(resolveClaudeHookTab({
    ...common,
    ppid: 202,
    hasTab: () => false,
  }).tabId, null);
});

test('pre-submit process proof uses one exact fresh Claude match', () => {
  const tabByPid = new Map();
  const result = prebindClaudeHookPid({
    tabId: 'tab-source',
    matches: [{ pid: 48861, depth: 4, processName: 'claude' }],
    tabByPid,
    hasTab: (tabId) => tabId === 'tab-source',
  });

  assert.deepEqual(result, {
    bound: true,
    tabId: 'tab-source',
    pid: 48861,
    reason: 'process-tree-proof',
  });
  assert.equal(tabByPid.get(48861), 'tab-source');
});

test('multiple fresh Claude descendants require one tracked interactive owner', () => {
  const matches = [
    { pid: 48861, depth: 4, processName: 'claude' },
    { pid: 48860, depth: 3, processName: 'claude' },
  ];
  const ambiguousMap = new Map();
  const ambiguous = prebindClaudeHookPid({
    tabId: 'tab-source',
    matches,
    tabByPid: ambiguousMap,
    hasTab: () => true,
  });
  assert.equal(ambiguous.bound, false);
  assert.equal(ambiguous.reason, 'process-owner-ambiguous');
  assert.equal(ambiguousMap.size, 0);

  const trackedMap = new Map([[48860, 'tab-source']]);
  const tracked = prebindClaudeHookPid({
    tabId: 'tab-source',
    matches,
    preferredPids: [48860],
    tabByPid: trackedMap,
    hasTab: () => true,
  });
  assert.equal(tracked.bound, true);
  assert.equal(tracked.pid, 48860);
  assert.deepEqual(Array.from(trackedMap.entries()), [[48860, 'tab-source']]);
});

test('pre-submit process proof cannot bind a missing tab or malformed process', () => {
  const tabByPid = new Map();

  assert.equal(prebindClaudeHookPid({
    tabId: 'tab-stale',
    matches: [{ pid: 48861 }],
    tabByPid,
    hasTab: () => false,
  }).bound, false);
  assert.equal(prebindClaudeHookPid({
    tabId: 'tab-source',
    matches: [{ pid: 'not-a-pid' }],
    tabByPid,
    hasTab: () => true,
  }).bound, false);
  assert.equal(tabByPid.size, 0);
});

test('fresh process proof clears stale PID bindings for only the target tab', () => {
  const tabByPid = new Map([
    [101, 'tab-source'],
    [102, 'tab-source'],
    [201, 'tab-other'],
  ]);

  assert.deepEqual(clearClaudeHookPidBindingsForTab({
    tabId: 'tab-source',
    tabByPid,
  }), [101, 102]);
  assert.deepEqual(Array.from(tabByPid.entries()), [[201, 'tab-other']]);

  const result = prebindClaudeHookPid({
    tabId: 'tab-source',
    matches: [],
    tabByPid,
    hasTab: () => true,
  });
  assert.equal(result.bound, false, 'a live-looking cached PID cannot replace fresh process-tree proof');
  assert.equal(tabByPid.has(101), false);
});
