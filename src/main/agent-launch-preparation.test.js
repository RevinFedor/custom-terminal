'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentLaunchPreparationRegistry } = require('./agent-launch-preparation');

test('launch preparation is re-queryable and reports phase changes', () => {
  let clock = 10;
  const changes = [];
  const registry = createAgentLaunchPreparationRegistry({
    now: () => clock,
    onChange: (state) => changes.push(state),
  });
  const started = registry.begin({
    tabId: 'tab-1',
    toolType: 'claude',
    sessionId: 'session-a',
    phase: 'repairing-history',
  });
  clock = 12;
  registry.update('tab-1', started.token, { phase: 'proving-shell' });

  assert.equal(registry.get('tab-1').phase, 'proving-shell');
  assert.equal(registry.get('tab-1').since, 10);
  assert.deepEqual(changes.map((state) => state.phase), [
    'repairing-history',
    'proving-shell',
  ]);
});

test('stale completion cannot clear a newer launch for the same tab', () => {
  const registry = createAgentLaunchPreparationRegistry();
  const oldLaunch = registry.begin({ tabId: 'tab-1', toolType: 'claude' });
  const newLaunch = registry.begin({ tabId: 'tab-1', toolType: 'claude' });

  assert.equal(registry.finish('tab-1', oldLaunch.token, { accepted: true }), false);
  assert.equal(registry.get('tab-1').token, newLaunch.token);
  assert.equal(registry.finish('tab-1', newLaunch.token, { accepted: true }), true);
  assert.equal(registry.get('tab-1'), null);
});

test('a rejected launch remains re-queryable but is excluded from active loaders', () => {
  const registry = createAgentLaunchPreparationRegistry();
  const claude = registry.begin({ tabId: 'tab-c', toolType: 'claude' });
  registry.begin({ tabId: 'tab-x', toolType: 'codex' });
  registry.finish('tab-c', claude.token, { accepted: false, error: 'blocked' });

  const rejected = registry.get('tab-c');
  assert.equal(rejected.token, claude.token);
  assert.equal(rejected.preparing, false);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'launch-rejected');
  assert.equal(rejected.error, 'blocked');
  assert.equal(typeof rejected.finishedAt, 'number');
  assert.deepEqual(registry.list().map((state) => state.tabId), ['tab-x']);
});

test('new begin supersedes a rejected snapshot and stale clear cannot erase it', () => {
  const registry = createAgentLaunchPreparationRegistry();
  const rejected = registry.begin({ tabId: 'tab-1', toolType: 'claude' });
  registry.finish('tab-1', rejected.token, { accepted: false, error: 'old failure' });

  const current = registry.begin({ tabId: 'tab-1', toolType: 'claude' });
  assert.equal(registry.clear('tab-1', rejected.token, { reason: 'stale-dismiss' }), false);
  assert.equal(registry.get('tab-1').token, current.token);
  assert.equal(registry.get('tab-1').preparing, true);
  assert.equal(registry.clear('tab-1', current.token, { reason: 'invalid-active-dismiss' }), false);
  assert.equal(registry.get('tab-1').preparing, true);
});

test('exact dismiss replaces a rejected snapshot with a re-queryable cleared snapshot', () => {
  const changes = [];
  const registry = createAgentLaunchPreparationRegistry({
    onChange: (state) => changes.push(state),
  });
  const launch = registry.begin({ tabId: 'tab-1', toolType: 'codex' });
  registry.finish('tab-1', launch.token, { accepted: false, error: 'shell is busy' });

  assert.equal(registry.clear('tab-1', launch.token, { reason: 'user-dismissed' }), true);
  const cleared = registry.get('tab-1');
  assert.equal(cleared.token, launch.token);
  assert.equal(cleared.preparing, false);
  assert.equal(cleared.accepted, false);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.reason, 'user-dismissed');
  assert.equal(cleared.error, 'shell is busy');
  assert.equal(typeof cleared.finishedAt, 'number');
  assert.equal(typeof cleared.clearedAt, 'number');
  assert.deepEqual(registry.list(), []);
  assert.equal(changes.at(-1).cleared, true);
});

test('exact TUI readiness clears only a rejected snapshot for the same engine', () => {
  const registry = createAgentLaunchPreparationRegistry();
  const launch = registry.begin({ tabId: 'tab-1', toolType: 'claude' });
  registry.finish('tab-1', launch.token, { accepted: false, error: 'failed early' });

  assert.equal(registry.clearRejected('tab-1', {
    toolType: 'codex',
    reason: 'codex-tui-ready',
  }), false);
  assert.equal(registry.get('tab-1').cleared, undefined);
  assert.equal(registry.clearRejected('tab-1', {
    toolType: 'claude',
    reason: 'claude-tui-ready',
  }), true);
  assert.equal(registry.get('tab-1').cleared, true);
  assert.equal(registry.get('tab-1').reason, 'claude-tui-ready');
});

test('three concurrent tabs keep independent preparation phases and tokens', () => {
  const registry = createAgentLaunchPreparationRegistry();
  const a = registry.begin({ tabId: 'tab-a', toolType: 'claude', phase: 'repairing-history' });
  const b = registry.begin({ tabId: 'tab-b', toolType: 'claude', phase: 'proving-shell' });
  const c = registry.begin({ tabId: 'tab-c', toolType: 'codex', phase: 'proving-shell' });

  registry.update('tab-a', a.token, { phase: 'proving-shell' });
  assert.equal(registry.finish('tab-b', b.token, { accepted: true }), true);

  assert.deepEqual(
    registry.list().map((state) => [state.tabId, state.phase, state.token]),
    [
      ['tab-a', 'proving-shell', a.token],
      ['tab-c', 'proving-shell', c.token],
    ],
  );
  assert.equal(registry.get('tab-b'), null);
  assert.equal(registry.get('tab-c').toolType, 'codex');
});
