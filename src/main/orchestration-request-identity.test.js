const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeOrchestrationRequestIdentity,
  orchestrationRequestFingerprint,
  reservedOrchestrationTargetTabId,
} = require('./orchestration-request-identity');

const base = () => ({
  sourceTabId: 'source',
  targetProjectId: 'project',
  targetToolType: 'codex',
  name: 'Worker',
  placement: 'child',
  visualParentTabId: 'source',
  afterTabId: 'source',
  prompt: 'hello',
  model: 'gpt-5.6-sol',
  effort: 'max',
  queue: true,
  notifySource: true,
  waitForDescendants: true,
});

test('equivalent aliases and defaults produce one request identity', () => {
  const a = orchestrationRequestFingerprint(base());
  const b = orchestrationRequestFingerprint({
    ...base(),
    placement: '',
    queue: undefined,
    notifySource: undefined,
    waitForDescendants: undefined,
    prompt: ' hello\r\n',
  });
  assert.equal(a, b);
});

test('every execution-affecting field changes request identity', () => {
  const original = base();
  const fingerprint = orchestrationRequestFingerprint(original);
  const variants = [
    { prompt: 'different' },
    { targetProjectId: 'other-project' },
    { targetTabId: 'existing-tab' },
    { targetToolType: 'claude' },
    { model: 'other-model' },
    { effort: 'high' },
    { thinking: 'disabled' },
    { queue: false },
    { notifySource: false },
    { waitForDescendants: false },
    { parentRunId: 'parent' },
    { placement: 'root', visualParentTabId: '', afterTabId: '' },
    { forkFromTabId: 'source-history' },
    { failureGraceMs: 123 },
    { successAutoStopMs: 456 },
    { reactToManualInterrupt: true },
    { autoStopCreatedTargets: false },
    { compactBeforeTask: true },
  ];
  for (const patch of variants) {
    assert.notEqual(
      orchestrationRequestFingerprint({ ...original, ...patch }),
      fingerprint,
      JSON.stringify(patch),
    );
  }
});

test('fork mode changes identity only for a fork-backed new target', () => {
  const fresh = normalizeOrchestrationRequestIdentity(base());
  assert.equal(Object.hasOwn(fresh.target, 'fork'), false);

  const compactFork = orchestrationRequestFingerprint({
    ...base(),
    forkFromTabId: 'source-history',
  });
  const fullFork = orchestrationRequestFingerprint({
    ...base(),
    forkFromTabId: 'source-history',
    fullHistoryFork: true,
  });
  assert.notEqual(compactFork, fullFork);
});

test('full prompt is not retained in normalized identity', () => {
  const normalized = normalizeOrchestrationRequestIdentity({ ...base(), prompt: 'private body' });
  assert.equal(JSON.stringify(normalized).includes('private body'), false);
  assert.equal(normalized.prompt.chars, 12);
});

test('reserved target tab id is deterministic and run-scoped', () => {
  assert.equal(
    reservedOrchestrationTargetTabId('project', 'run-a'),
    'project-tab-orchestration-run-a',
  );
  assert.notEqual(
    reservedOrchestrationTargetTabId('project', 'run-a'),
    reservedOrchestrationTargetTabId('project', 'run-b'),
  );
});
