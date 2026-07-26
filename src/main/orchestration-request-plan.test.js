const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildDelegationResultTarget,
  isAgentStatusBusyForClose,
  resolveNewAgentTabPlacement,
  resolveOrchestrationSendOptions,
} = require('./orchestration-request-plan');

test('new related session defaults to a visual child in the same project', () => {
  assert.deepEqual(resolveNewAgentTabPlacement({
    sourceTabId: 'source-tab',
    sourceProjectId: 'project-a',
    targetProjectId: 'project-a',
  }), {
    placement: 'child',
    visualParentTabId: 'source-tab',
    afterTabId: 'source-tab',
  });
});

test('cross-project session defaults to root without an explicit target parent', () => {
  assert.deepEqual(resolveNewAgentTabPlacement({
    sourceTabId: 'source-tab',
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
  }), {
    placement: 'root',
    visualParentTabId: null,
    afterTabId: null,
  });
});

test('explicit root placement overrides the same-project default', () => {
  assert.equal(resolveNewAgentTabPlacement({
    placement: 'root',
    sourceTabId: 'source-tab',
    sourceProjectId: 'project-a',
    targetProjectId: 'project-a',
  }).visualParentTabId, null);
});

test('invalid placement is a client error', () => {
  assert.throws(
    () => resolveNewAgentTabPlacement({ placement: 'sideways' }),
    (error) => error?.code === 'invalid_tab_placement' && error?.statusCode === 400,
  );
});

test('new Codex target applies model and effort only at launch', () => {
  assert.deepEqual(resolveOrchestrationSendOptions({
    targetCreated: true,
    targetToolType: 'codex',
    baselineStatus: 'active',
    queueRequested: true,
    model: 'gpt-5.6-luna',
    effort: 'low',
  }), {
    model: undefined,
    effort: undefined,
    thinking: undefined,
    queue: false,
    settingsAppliedAtLaunch: true,
  });
});

test('existing idle target can apply settings immediately without queue mode', () => {
  assert.deepEqual(resolveOrchestrationSendOptions({
    targetCreated: false,
    targetToolType: 'codex',
    baselineStatus: 'active',
    queueRequested: true,
    model: 'gpt-5.6-luna',
    effort: 'low',
  }), {
    model: 'gpt-5.6-luna',
    effort: 'low',
    thinking: undefined,
    queue: false,
    settingsAppliedAtLaunch: false,
  });
});

test('busy target preserves explicit queue capability', () => {
  assert.equal(resolveOrchestrationSendOptions({
    targetCreated: false,
    targetToolType: 'claude',
    baselineStatus: 'busy',
    queueRequested: true,
  }).queue, true);
});

test('close guard treats active as idle and lifecycle transitions as busy', () => {
  assert.equal(isAgentStatusBusyForClose({ status: 'active', busy: false }), false);
  assert.equal(isAgentStatusBusyForClose({ status: 'busy' }), true);
  assert.equal(isAgentStatusBusyForClose({ sessionStatus: 'starting' }), true);
  assert.equal(isAgentStatusBusyForClose({ status: 'active', turnBusy: true }), true);
});

test('delegation result carries the exact target needed for one-off cleanup', () => {
  assert.deepEqual(buildDelegationResultTarget({
    targetTabId: 'target-tab',
    targetProjectId: 'project-a',
    targetProjectPath: '/project/a',
    targetCreated: true,
  }), {
    targetTabId: 'target-tab',
    targetProjectId: 'project-a',
    targetProjectPath: '/project/a',
    targetCreated: true,
  });
});
