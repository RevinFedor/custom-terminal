import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAutoCompactPolicy, selectedAutoCompactScope, toggleAutoCompactScope, isAutoCompactTurnEligible } from './autoCompactPolicy.mjs';

test('workflow clicks enable the first selection, retain another selection and disable the last', () => {
  let policy = normalizeAutoCompactPolicy({ percent: 65, excludedTabIds: ['keep-exclusion'] });
  const click = action => { policy = normalizeAutoCompactPolicy({ ...policy, ...toggleAutoCompactScope(policy, action), armedAt: 100 }); };
  click({ kind: 'workflow', id: 'main' }); assert.equal(policy.enabled, true); assert.deepEqual(policy.workflowIds, ['main']);
  click({ kind: 'workflow', id: 'other' }); click({ kind: 'workflow', id: 'main' });
  assert.equal(policy.enabled, true); assert.deepEqual(policy.workflowIds, ['other']);
  click({ kind: 'workflow', id: 'other' }); assert.equal(policy.enabled, false); assert.deepEqual(policy.workflowIds, []);
  assert.equal(policy.percent, 65); assert.deepEqual(policy.excludedTabIds, ['keep-exclusion']);
  assert.deepEqual(normalizeAutoCompactPolicy(JSON.parse(JSON.stringify(policy))), policy, 'the existing persisted shape is retained');
});

test('old disabled scope is remembered by persistence but is not selected and cannot be silently restored by a new click', () => {
  const old = normalizeAutoCompactPolicy({ enabled: false, scopeInitialized: false,
    workflowIds: ['old-main', 'old-other'], allWorkflows: true, includeUnplaced: true, excludedTabIds: ['A'] });
  const before = JSON.stringify(old);
  assert.deepEqual(selectedAutoCompactScope(old), { allWorkflows: false, workflowIds: [], includeUnplaced: false });
  const patch = toggleAutoCompactScope(old, { kind: 'workflow', id: 'new' });
  assert.deepEqual(patch, { enabled: true, scopeInitialized: true, allWorkflows: false, workflowIds: ['new'], includeUnplaced: false });
  assert.equal(JSON.stringify(old), before, 'reading the page does not migrate/enable saved settings');
  assert.deepEqual(normalizeAutoCompactPolicy({ ...old, ...patch }).excludedTabIds, ['A']);
});

test('All retains explicit active workflow choices, and unplaced remains a separate selectable scope', () => {
  let policy = normalizeAutoCompactPolicy();
  const click = action => { policy = normalizeAutoCompactPolicy({ ...policy, ...toggleAutoCompactScope(policy, action) }); };
  click({ kind: 'all' }); assert.equal(policy.enabled, true);
  click({ kind: 'all' }); assert.equal(policy.enabled, false);
  click({ kind: 'workflow', id: 'main' }); click({ kind: 'all' }); click({ kind: 'all' });
  assert.equal(policy.enabled, true); assert.deepEqual(policy.workflowIds, ['main'], 'existing All scope overlay restores the explicit selection');
  click({ kind: 'unplaced' }); click({ kind: 'workflow', id: 'main' });
  assert.equal(policy.enabled, true); assert.equal(policy.includeUnplaced, true);
  click({ kind: 'unplaced' }); assert.equal(policy.enabled, false);
});

test('selection-only enable still uses the existing new natural-turn gate', () => {
  const policy = normalizeAutoCompactPolicy({ ...toggleAutoCompactScope(normalizeAutoCompactPolicy(), { kind: 'workflow', id: 'main' }), armedAt: 100 });
  const target = { tabId: 'A', provider: 'codex', workflowId: 'main' };
  const outcome = { at: 200, live: true, natural: true, compact: false };
  assert.equal(isAutoCompactTurnEligible({ policy, target, outcome, startedAt: 100 }), true);
  for (const invalid of [{ ...outcome, at: 99 }, { ...outcome, live: false }, { ...outcome, natural: false }, { ...outcome, compact: true }]) {
    assert.equal(isAutoCompactTurnEligible({ policy, target, outcome: invalid, startedAt: 100 }), false);
  }
  assert.equal(isAutoCompactTurnEligible({ policy, target: { ...target, workflowId: 'elsewhere' }, outcome, startedAt: 100 }), false);
});
