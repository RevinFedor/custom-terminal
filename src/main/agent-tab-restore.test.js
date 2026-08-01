'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveRestorableAgentTab,
  runSingleFlight,
} = require('./agent-tab-restore');

const project = {
  id: 'project-a',
  name: 'Project A',
  path: '/tmp/project-a',
};

test('an exact archived Claude tab is restorable under the same tab identity', () => {
  assert.deepEqual(resolveRestorableAgentTab({
    tabId: 'project-a-tab-7',
    project,
    historyEntries: [{
      id: 17,
      project_id: 'project-a',
      tab_id: 'project-a-tab-7',
      name: 'Claude worker',
      cwd: '/tmp/project-a',
      command_type: 'claude',
      claude_session_id: 'claude-session',
    }],
  }), {
    ok: true,
    historyId: 17,
    tabId: 'project-a-tab-7',
    tabName: 'Claude worker',
    projectId: 'project-a',
    projectName: 'Project A',
    projectPath: '/tmp/project-a',
    cwd: '/tmp/project-a',
    toolType: 'claude',
    commandType: 'claude',
    sessionId: 'claude-session',
    claudeSessionId: 'claude-session',
    codexSessionId: null,
    requiresRestore: true,
  });
});

test('deleted, ambiguous, and non-agent history fail closed', () => {
  assert.equal(resolveRestorableAgentTab({
    tabId: 'missing',
    project,
    historyEntries: [],
  }).code, 'target_tab_not_restorable');

  assert.equal(resolveRestorableAgentTab({
    tabId: 'duplicate',
    project,
    historyEntries: [
      { id: 1, project_id: 'project-a', tab_id: 'duplicate', command_type: 'claude' },
      { id: 2, project_id: 'project-a', tab_id: 'duplicate', command_type: 'claude' },
    ],
  }).code, 'target_tab_restore_ambiguous');

  assert.equal(resolveRestorableAgentTab({
    tabId: 'shell',
    project,
    historyEntries: [{ id: 3, project_id: 'project-a', tab_id: 'shell', command_type: 'shell' }],
  }).code, 'target_tab_not_agent');
});

test('concurrent explicit sends share one exact restore operation', async () => {
  const inflight = new Map();
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const operation = () => runSingleFlight(inflight, 'tab-1', async () => {
    calls += 1;
    await barrier;
    return { tabId: 'tab-1' };
  });

  const first = operation();
  const second = operation();
  assert.equal(first, second);
  assert.equal(calls, 0, 'operation begins on the next microtask');
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { tabId: 'tab-1' });
  assert.equal(inflight.size, 0);
});
