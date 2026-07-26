const assert = require('node:assert/strict');
const test = require('node:test');
const {
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

test('pre-submit process proof binds the deepest Claude match to its exact tab', () => {
  const tabByPid = new Map();
  const result = prebindClaudeHookPid({
    tabId: 'tab-source',
    matches: [
      { pid: 48861, depth: 4, processName: 'claude' },
      { pid: 48860, depth: 3, processName: 'node' },
    ],
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
