'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCodexModelMigrationRecovery,
  hashCodexConfigSnapshot,
} = require('./codex-model-migration-recovery');

test('restart rolls B back when shared config reaches target without B acknowledgement', () => {
  const before = [
    'model = "gpt-5.4-mini"',
    'model_reasoning_effort = "max"',
  ].join('\n');
  const after = [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.4-mini" = "gpt-5.6-luna"',
  ].join('\n');

  const result = classifyCodexModelMigrationRecovery(after, {
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configBaselineFingerprint: hashCodexConfigSnapshot(before),
  });
  assert.deepEqual(result, {
    action: 'rollback-source',
    model: 'gpt-5.4-mini',
    effort: 'max',
    currentFingerprint: hashCodexConfigSnapshot(after),
  });
});

test('restart normalizes the source model label before rollback', () => {
  const before = [
    'model = "gpt-5.4-mini"',
    'model_reasoning_effort = "max"',
  ].join('\n');
  const after = [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.4-mini" = "gpt-5.6-luna"',
  ].join('\n');

  const result = classifyCodexModelMigrationRecovery(after, {
    sourceModel: 'GPT-5.4 Mini',
    sourceEffort: 'max',
    targetModel: 'GPT-5.6 Luna',
    configBaselineFingerprint: hashCodexConfigSnapshot(before),
  });
  assert.equal(result.action, 'rollback-source');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.effort, 'max');
});

test('restart settles an already-target shared config instead of leaving a journal blocked', () => {
  const alreadyTarget = [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    '',
    '[notice.model_migrations]',
    '"gpt-5.4-mini" = "gpt-5.6-luna"',
  ].join('\n');
  const result = classifyCodexModelMigrationRecovery(alreadyTarget, {
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configBaselineFingerprint: hashCodexConfigSnapshot(alreadyTarget),
    configAlreadyTargetAtArm: true,
  });
  assert.equal(result.action, 'rollback-source');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.effort, 'max');
});

test('restart rolls the journal back when the exact baseline is unchanged', () => {
  const before = [
    'model = "gpt-5.4-mini"',
    'model_reasoning_effort = "max"',
  ].join('\n');
  const result = classifyCodexModelMigrationRecovery(before, {
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configBaselineFingerprint: hashCodexConfigSnapshot(before),
  });
  assert.deepEqual(result, {
    action: 'rollback-source',
    model: 'gpt-5.4-mini',
    effort: 'max',
    currentFingerprint: hashCodexConfigSnapshot(before),
  });
});

test('restart rolls back a changed config that has no tab-specific acknowledgement', () => {
  const before = 'model = "gpt-5.4-mini"\nmodel_reasoning_effort = "max"\n';
  const unrelated = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n';
  const result = classifyCodexModelMigrationRecovery(unrelated, {
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configBaselineFingerprint: hashCodexConfigSnapshot(before),
  });
  assert.deepEqual(result, {
    action: 'rollback-source',
    model: 'gpt-5.4-mini',
    effort: 'max',
    currentFingerprint: hashCodexConfigSnapshot(unrelated),
  });
});

test('restart rolls back from source even when obsolete config provenance is unavailable', () => {
  const result = classifyCodexModelMigrationRecovery('', {
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
  });
  assert.equal(result.action, 'rollback-source');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.effort, 'max');
});
