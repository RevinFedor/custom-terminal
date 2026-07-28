const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashCodexRewindTargetText } = require('./codex-rewind-target-proof');
const { hashCodexConfigSnapshot } = require('./codex-model-migration-recovery');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-session-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: () => tempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

test('stale full tab save cannot overwrite point-written Codex writer identity', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }

  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const project = manager.createEmptyProject('Codex persistence test');
  const tabId = 'codex-writer-tab';
  const migrationConfigPath = path.join(tempRoot, 'codex', 'config.toml');
  const migrationBaselineFingerprint = hashCodexConfigSnapshot('');
  manager.setAppState('defaultCodexModel', 'gpt-5.4-mini');
  assert.equal(
    manager.compareAndSetAppState('defaultCodexModel', 'gpt-5.6-sol', 'gpt-5.6-luna'),
    false,
    'a migration cannot overwrite a global default that was not its launch source',
  );
  assert.equal(manager.getAppState('defaultCodexModel'), 'gpt-5.4-mini');
  assert.equal(
    manager.compareAndSetAppState('defaultCodexModel', 'gpt-5.4-mini', 'gpt-5.6-luna'),
    true,
    'the unchanged inherited global default can migrate atomically',
  );
  assert.equal(manager.getAppState('defaultCodexModel'), 'gpt-5.6-luna');
  const staleRendererTab = {
    tabId,
    name: 'Before rename',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'resume-source-session',
    codexModel: 'gpt-5.6-sol',
    codexEffort: 'ultra',
    codexSettingsProofAt: 1784784000123,
    codexSettingsProofSessionId: 'resume-source-session',
  };

  manager.saveTabs(project.id, [staleRendererTab], true);
  assert.equal(
    manager.getTabCodexSessionId(project.id, tabId),
    'resume-source-session',
    'point reads require and resolve the full project + tab identity',
  );
  manager.setAppState('defaultCodexModel', 'gpt-5.4-mini');
  manager.setAppState('defaultCodexEffort', 'max');
  const missingBegin = manager.beginTabCodexModelMigration(project.id, 'missing-tab', {
    proofAt: 1784784000400,
    clearDefaultModel: true,
    expectedDefaultModel: 'gpt-5.4-mini',
    clearDefaultEffort: true,
    expectedDefaultEffort: 'max',
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  });
  assert.equal(missingBegin.success, false);
  assert.equal(manager.getAppState('defaultCodexModel'), 'gpt-5.4-mini', 'missing tab cannot mutate defaults');
  assert.equal(manager.getAppState('defaultCodexEffort'), 'max');

  const migrationPendingAt = 1784784000500;
  assert.deepEqual(manager.beginTabCodexModelMigration(project.id, tabId, {
    proofAt: migrationPendingAt,
    clearDefaultModel: true,
    expectedDefaultModel: 'gpt-5.4-mini',
    clearDefaultEffort: true,
    expectedDefaultEffort: 'max',
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  }), {
    success: true,
    defaultModelInvalidated: true,
    defaultEffortInvalidated: true,
  });
  manager.saveTabs(project.id, [staleRendererTab]);
  let pendingSettings = manager.getTabCodexSettingsState(project.id, tabId);
  assert.equal(pendingSettings.model, null, 'stale renderer save cannot resurrect the invalidated model');
  assert.equal(pendingSettings.effort, null);
  assert.equal(pendingSettings.proofAt, migrationPendingAt);
  assert.equal(pendingSettings.modelMigrationPending, true, 'restart can suppress every explicit fallback while ack is unknown');
  assert.equal(pendingSettings.restoreDefaultModel, true);
  assert.equal(pendingSettings.restoreDefaultEffort, true);
  assert.equal(pendingSettings.sourceModel, 'gpt-5.4-mini');
  assert.equal(pendingSettings.sourceEffort, 'max');
  assert.equal(pendingSettings.targetModel, 'gpt-5.6-luna');
  assert.equal(pendingSettings.configPath, migrationConfigPath);
  assert.equal(pendingSettings.configBaselineFingerprint, migrationBaselineFingerprint);
  assert.equal(manager.getAppState('defaultCodexModel'), 'none');
  assert.equal(manager.getAppState('defaultCodexEffort'), 'none');

  const migrationRearmedAt = 1784784000750;
  assert.deepEqual(manager.beginTabCodexModelMigration(project.id, tabId, {
    proofAt: migrationRearmedAt,
    clearDefaultModel: true,
    expectedDefaultModel: 'gpt-5.4-mini',
    clearDefaultEffort: true,
    expectedDefaultEffort: 'max',
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  }), {
    success: true,
    idempotent: true,
    pendingProofAt: migrationPendingAt,
    defaultModelInvalidated: true,
    defaultEffortInvalidated: true,
  }, 'an exact duplicate keeps the original pending generation and provenance');
  assert.equal(manager.getTabCodexSettingsState(project.id, tabId).restoreDefaultModel, true);
  assert.deepEqual(manager.commitTabCodexModelMigration(project.id, tabId, {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    proofAt: 1784784000800,
    proofSessionId: null,
    expectedPendingProofAt: migrationPendingAt,
  }), {
    success: true,
    defaultModelUpdated: true,
    defaultEffortUpdated: true,
  }, 'the original exact journal remains committable after an idempotent retry');

  assert.deepEqual(manager.beginTabCodexModelMigration(project.id, tabId, {
    proofAt: 1784784000850,
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-sol',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  }), {
    success: true,
    defaultModelInvalidated: false,
    defaultEffortInvalidated: false,
  });
  assert.deepEqual(manager.beginTabCodexModelMigration(project.id, tabId, {
    proofAt: 1784784000860,
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  }), {
    success: false,
    error: 'codex_model_migration_already_pending',
  }, 'an unrelated pending journal is never overwritten');

  const migrationProofAt = 1784784000999;
  assert.deepEqual(manager.commitTabCodexModelMigration(project.id, tabId, {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    proofAt: migrationProofAt,
    proofSessionId: null,
    expectedPendingProofAt: 1784784000850,
    restoreDefaultModel: true,
    restoreDefaultEffort: true,
  }), {
    success: true,
    defaultModelUpdated: false,
    defaultEffortUpdated: false,
  });
  assert.equal(manager.getAppState('defaultCodexModel'), 'gpt-5.6-luna');
  assert.equal(manager.getAppState('defaultCodexEffort'), 'medium');
  assert.equal(manager.getTabCodexSettingsState(project.id, tabId).modelMigrationPending, false);
  assert.equal(manager.updateTabCodexSessionId(project.id, tabId, 'proven-writer-session'), true);

  const carriedProofAt = 1784784001001;
  assert.equal(manager.updateTabCodexSessionAndSettings(project.id, tabId, {
    sessionId: 'resume-child-writer',
    model: 'gpt-5.6-sol',
    effort: 'high',
    proofAt: carriedProofAt,
  }), true, 'writer identity and its carried non-Ultra pair commit in one point-write');
  assert.equal(manager.getTabCodexSessionId(project.id, tabId), 'resume-child-writer');
  const carriedSettings = manager.getTabCodexSettingsState(project.id, tabId);
  assert.equal(carriedSettings.model, 'gpt-5.6-sol');
  assert.equal(carriedSettings.effort, 'high');
  assert.equal(carriedSettings.proofAt, carriedProofAt);
  assert.equal(carriedSettings.proofSessionId, 'resume-child-writer');
  assert.equal(manager.updateTabCodexSessionAndSettings(project.id, tabId, {
    sessionId: 'must-not-persist-ultra',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    proofAt: carriedProofAt + 1,
  }), false, 'conversation-only Ultra cannot become a durable future-launch pair');
  assert.equal(manager.getTabCodexSessionId(project.id, tabId), 'resume-child-writer');

  assert.equal(manager.updateTabCodexSettings(project.id, tabId, {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    proofAt: migrationProofAt,
    proofSessionId: null,
  }), true, 'restore the migration fixture before the remaining stale-save assertions');
  assert.equal(manager.updateTabCodexSessionId(project.id, tabId, 'proven-writer-session'), true);
  manager.saveTabs(project.id, [{
    ...staleRendererTab,
    name: 'After rename',
    codexSessionId: 'resume-source-session',
  }]);

  let tabs = manager.getProjectById(project.id).tabs;
  const existing = tabs.find((tab) => tab.tabId === tabId);
  assert.equal(existing.name, 'After rename', 'unrelated renderer fields still save');
  assert.equal(existing.codexSessionId, 'proven-writer-session', 'stale renderer ID must not replace the point-written writer');
  assert.equal(existing.codexModel, 'gpt-5.6-luna', 'stale renderer model cannot replace the newer point-written migration proof');
  assert.equal(existing.codexEffort, 'medium');
  assert.equal(existing.codexSettingsProofAt, migrationProofAt, 'newer model/effort proof survives a full tab save');
  assert.equal(existing.codexSettingsProofSessionId, undefined, 'pre-rollout migration proof is not assigned to the resume source');
  assert.equal(existing.codexModelMigrationPending, undefined);

  const archivedWriterId = manager.archiveTab(project.id, {
    ...staleRendererTab,
    name: 'Archived after writer handoff',
    processWasRunning: true,
    codexSessionId: 'resume-source-session',
  }, { sourceTabId: tabId });
  const archivedWriter = manager.getTabHistoryEntry(archivedWriterId, project.id);
  assert.equal(
    archivedWriter.codex_session_id,
    'proven-writer-session',
    'Close → History must read the main-owned tabs row, not the renderer cache',
  );
  assert.equal(archivedWriter.name, 'Archived after writer handoff');
  assert.equal(archivedWriter.process_was_running, 1, 'non-identity close metadata is preserved');
  assert.equal(archivedWriter.codex_model, 'gpt-5.6-luna');
  assert.equal(archivedWriter.codex_effort, 'medium');
  assert.equal(archivedWriter.codex_settings_proof_at, migrationProofAt, 'History restore preserves settings proof precedence');
  assert.equal(archivedWriter.codex_settings_proof_session_id, null);
  assert.equal(archivedWriter.codex_model_migration_pending, 0);
  assert.equal(archivedWriter.codex_model_migration_restore_default_model, 0);
  assert.equal(archivedWriter.codex_model_migration_restore_default_effort, 0);

  const archivedLiveWriterId = manager.archiveTab(project.id, {
    ...staleRendererTab,
    name: 'Archived while writer proof is live',
  }, {
    sourceTabId: tabId,
    codexWriterSessionId: 'newer-live-writer',
  });
  assert.equal(
    manager.getTabHistoryEntry(archivedLiveWriterId, project.id).codex_session_id,
    'newer-live-writer',
    'a current main-process writer proof wins over both SQLite and renderer cache',
  );

  const recoveryTabId = 'codex-migration-recovery-tab';
  manager.saveTabs(project.id, [
    ...tabs,
    {
      tabId: recoveryTabId,
      name: 'Migration recovery',
      cwd: tempRoot,
      commandType: 'codex',
      codexModel: 'gpt-5.4-mini',
      codexEffort: 'max',
      codexSettingsProofAt: 1784784001100,
    },
  ]);
  manager.setAppState('defaultCodexModel', 'gpt-5.4-mini');
  manager.setAppState('defaultCodexEffort', 'max');
  assert.equal(manager.beginTabCodexModelMigration(project.id, recoveryTabId, {
    proofAt: 1784784001200,
    clearDefaultModel: true,
    expectedDefaultModel: 'gpt-5.4-mini',
    clearDefaultEffort: true,
    expectedDefaultEffort: 'max',
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
    configAlreadyTargetAtArm: true,
  }).success, true);
  const archivedPendingId = manager.archiveTab(project.id, {
    tabId: recoveryTabId,
    name: 'Archived pending migration',
    cwd: tempRoot,
    commandType: 'codex',
    codexModel: 'gpt-5.4-mini',
    codexEffort: 'max',
    codexSettingsProofAt: 1784784001100,
  }, { sourceTabId: recoveryTabId });
  const archivedPending = manager.getTabHistoryEntry(archivedPendingId, project.id);
  assert.equal(archivedPending.codex_model_migration_pending, 1);
  assert.equal(archivedPending.codex_model_migration_restore_default_model, 1);
  assert.equal(archivedPending.codex_model_migration_restore_default_effort, 1);
  assert.equal(archivedPending.codex_model_migration_source_model, 'gpt-5.4-mini');
  assert.equal(archivedPending.codex_model_migration_source_effort, 'max');
  assert.equal(archivedPending.codex_model_migration_target_model, 'gpt-5.6-luna');
  assert.equal(archivedPending.codex_model_migration_config_path, migrationConfigPath);
  assert.equal(
    archivedPending.codex_model_migration_config_fingerprint,
    migrationBaselineFingerprint,
  );
  assert.equal(archivedPending.codex_model_migration_config_already_target, 1);

  const archiveSettlementProofAt = 1784784001250;
  const archivedSettledId = manager.archiveTab(project.id, {
    tabId: recoveryTabId,
    name: 'Archived after migration acknowledgement',
    cwd: tempRoot,
    commandType: 'codex',
    codexModel: 'gpt-5.6-luna',
    codexEffort: 'medium',
    codexSettingsProofAt: archiveSettlementProofAt,
    codexSettingsProofSessionId: 'archive-recovery-writer',
    codexModelMigrationPending: false,
    codexModelMigrationRestoreDefaultModel: false,
    codexModelMigrationRestoreDefaultEffort: false,
  }, { sourceTabId: recoveryTabId });
  const archivedSettled = manager.getTabHistoryEntry(archivedSettledId, project.id);
  assert.equal(archivedSettled.codex_model, null);
  assert.equal(archivedSettled.codex_effort, null);
  assert.equal(archivedSettled.codex_model_migration_pending, 1);
  assert.equal(archivedSettled.codex_model_migration_restore_default_model, 1);
  assert.equal(archivedSettled.codex_model_migration_restore_default_effort, 1);
  assert.equal(
    manager.getAppState('defaultCodexModel'),
    'none',
    'Close cannot treat a renderer snapshot as an exact migration acknowledgement',
  );
  assert.equal(manager.getAppState('defaultCodexEffort'), 'none');

  const recoveryTabs = manager.getProjectById(project.id).tabs.map((tab) => (
    tab.tabId === recoveryTabId
      ? {
        ...tab,
        codexModel: 'gpt-5.6-luna',
        codexEffort: 'medium',
        codexSettingsProofAt: 1784784001300,
        codexSettingsProofSessionId: 'recovery-writer',
        codexModelMigrationPending: false,
        codexModelMigrationRestoreDefaultModel: false,
        codexModelMigrationRestoreDefaultEffort: false,
      }
      : tab
  ));
  manager.saveTabs(project.id, recoveryTabs);
  const recoveredSettings = manager.getTabCodexSettingsState(project.id, recoveryTabId);
  assert.equal(recoveredSettings.modelMigrationPending, true);
  assert.equal(recoveredSettings.restoreDefaultModel, true);
  assert.equal(recoveredSettings.restoreDefaultEffort, true);
  assert.equal(manager.getAppState('defaultCodexModel'), 'none', 'full saves cannot settle the pending migration');
  assert.equal(manager.getAppState('defaultCodexEffort'), 'none');

  const rollbackTabId = 'codex-migration-baseline-rollback-tab';
  manager.saveTabs(project.id, [
    ...manager.getProjectById(project.id).tabs,
    {
      tabId: rollbackTabId,
      name: 'Migration baseline rollback',
      cwd: tempRoot,
      commandType: 'codex',
      codexModel: 'gpt-5.4-mini',
      codexEffort: 'max',
      codexSettingsProofAt: 1784784001400,
    },
  ]);
  manager.setAppState('defaultCodexModel', 'gpt-5.4-mini');
  manager.setAppState('defaultCodexEffort', 'max');
  const rollbackPendingAt = 1784784001500;
  assert.equal(manager.beginTabCodexModelMigration(project.id, rollbackTabId, {
    proofAt: rollbackPendingAt,
    clearDefaultModel: true,
    expectedDefaultModel: 'gpt-5.4-mini',
    clearDefaultEffort: true,
    expectedDefaultEffort: 'max',
    sourceModel: 'gpt-5.4-mini',
    sourceEffort: 'max',
    targetModel: 'gpt-5.6-luna',
    configPath: migrationConfigPath,
    configBaselineFingerprint: migrationBaselineFingerprint,
  }).success, true);
  assert.deepEqual(manager.rollbackTabCodexModelMigration(project.id, rollbackTabId, {
    proofAt: 1784784001600,
    expectedPendingProofAt: rollbackPendingAt,
  }), {
    success: true,
    model: 'gpt-5.4-mini',
    effort: 'max',
    defaultModelUpdated: true,
    defaultEffortUpdated: true,
  });
  const rolledBackSettings = manager.getTabCodexSettingsState(project.id, rollbackTabId);
  assert.equal(rolledBackSettings.modelMigrationPending, false);
  assert.equal(rolledBackSettings.model, 'gpt-5.4-mini');
  assert.equal(rolledBackSettings.effort, 'max');
  assert.equal(rolledBackSettings.sourceModel, null);
  assert.equal(rolledBackSettings.configBaselineFingerprint, null);
  assert.equal(manager.getAppState('defaultCodexModel'), 'gpt-5.4-mini');
  assert.equal(manager.getAppState('defaultCodexEffort'), 'max');

  const newTabId = 'new-codex-tab';
  manager.saveTabs(project.id, [
    { ...staleRendererTab, codexSessionId: 'still-stale' },
    {
      tabId: newTabId,
      name: 'New Codex tab',
      cwd: tempRoot,
      commandType: 'codex',
      codexSessionId: 'seeded-new-session',
    },
  ]);

  tabs = manager.getProjectById(project.id).tabs;
  assert.equal(tabs.find((tab) => tab.tabId === tabId).codexSessionId, 'proven-writer-session');
  assert.equal(tabs.find((tab) => tab.tabId === newTabId).codexSessionId, 'seeded-new-session', 'a new row may seed its incoming session ID');

  assert.equal(manager.updateTabCodexSessionId(project.id, tabId, null), true, 'authoritative discard clears the point-owned column');
  const archivedClearedId = manager.archiveTab(project.id, {
    ...staleRendererTab,
    name: 'Archived after authoritative clear',
    codexSessionId: 'resume-source-session',
  }, { sourceTabId: tabId });
  const archivedCleared = manager.getTabHistoryEntry(archivedClearedId, project.id);
  assert.equal(
    archivedCleared.codex_session_id,
    null,
    'authoritative NULL must not resurrect a stale renderer session in History',
  );
  const historyCountBeforeMissing = manager.getTabHistoryCount(project.id);
  const archivedMissingId = manager.archiveTab(project.id, {
    name: 'Archived without source row',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'renderer-only-session',
  }, { sourceTabId: 'missing-codex-tab' });
  assert.equal(archivedMissingId, null, 'a missing authoritative source row blocks the archive');
  assert.equal(manager.getTabHistoryCount(project.id), historyCountBeforeMissing, 'no NULL history row is fabricated');
  manager.saveTabs(project.id, [
    { ...staleRendererTab, codexSessionId: 'proven-writer-session' },
    {
      tabId: newTabId,
      name: 'New Codex tab',
      cwd: tempRoot,
      commandType: 'codex',
      codexSessionId: 'seeded-new-session',
    },
  ]);
  tabs = manager.getProjectById(project.id).tabs;
  assert.equal(
    tabs.find((tab) => tab.tabId === tabId).codexSessionId,
    undefined,
    'a stale renderer snapshot cannot resurrect an explicitly cleared unmaterialized binding',
  );

  const scopedProjectA = manager.createEmptyProject('Scoped tab A');
  const scopedProjectB = manager.createEmptyProject('Scoped tab B');
  const projectATabId = `${scopedProjectA.id}-tab-0`;
  const projectBTabId = `${scopedProjectB.id}-tab-0`;
  manager.saveTabs(scopedProjectA.id, [{
    tabId: projectATabId,
    name: 'Project A Codex',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'project-a-writer',
  }], true);
  manager.saveTabs(scopedProjectB.id, [{
    tabId: projectBTabId,
    name: 'Project B Codex',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'project-b-writer',
  }], true);

  assert.equal(manager.getTabCodexSessionId(scopedProjectA.id, projectATabId), 'project-a-writer');
  assert.equal(manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId), 'project-b-writer');
  assert.equal(
    manager.updateTabCodexSessionId(scopedProjectA.id, projectATabId, 'project-a-updated'),
    true,
  );
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectA.id, projectATabId),
    'project-a-updated',
    'the selected compound row is updated',
  );
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId),
    'project-b-writer',
    'another project row is untouched',
  );
  assert.equal(
    manager.compareAndSetTabCodexSessionId(
      scopedProjectA.id,
      projectATabId,
      'project-a-updated',
      'project-a-cas',
    ),
    true,
  );
  assert.equal(manager.getTabCodexSessionId(scopedProjectA.id, projectATabId), 'project-a-cas');
  assert.equal(
    manager.compareAndSetTabCodexSessionId(
      scopedProjectA.id,
      projectATabId,
      'stale-writer',
      'must-not-win',
    ),
    false,
  );
  assert.equal(manager.getTabCodexSessionId(scopedProjectA.id, projectATabId), 'project-a-cas');
  assert.equal(manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId), 'project-b-writer');

  const scopedArchiveId = manager.archiveTab(scopedProjectA.id, {
    tabId: projectATabId,
    name: 'Archived scoped row from A',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'stale-renderer-value',
  }, { sourceTabId: projectATabId });
  assert.equal(
    manager.getTabHistoryEntry(scopedArchiveId, scopedProjectA.id).codex_session_id,
    'project-a-cas',
    'archive point-read stays project scoped',
  );

  assert.equal(
    manager.updateTabCodexSessionId(projectATabId, 'legacy-unscoped-writer'),
    false,
    'the legacy two-argument write is rejected instead of falling back to tab ID only',
  );
  assert.equal(
    manager.getTabCodexSessionId(projectATabId),
    undefined,
    'the legacy one-argument read is rejected instead of returning an arbitrary project row',
  );
  assert.equal(manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId), 'project-b-writer');

  const handoffKey = `codex.pending-writer-handoff.v1:${projectATabId}`;
  const handoffJournal = {
    version: 1,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    cwd: tempRoot,
    sourceSessionId: 'project-a-cas',
    actionGeneration: 'rewind-generation-1',
    actionStartedAtMs: Date.now(),
  };
  manager.setAppState(handoffKey, handoffJournal);
  const handoffCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'project-a-cas',
    nextSessionId: 'project-a-child',
    actionGeneration: 'rewind-generation-1',
  });
  assert.equal(handoffCommit.success, true);
  assert.equal(handoffCommit.updated, true);
  assert.equal(manager.getTabCodexSessionId(scopedProjectA.id, projectATabId), 'project-a-child');
  assert.equal(manager.getAppState(handoffKey), null, 'binding and journal cleanup commit atomically');

  manager.setAppState(handoffKey, {
    ...handoffJournal,
    sourceSessionId: 'project-a-child',
    actionGeneration: 'rewind-generation-2',
  });
  manager.updateTabCodexSessionId(scopedProjectA.id, projectATabId, 'project-a-child-2');
  const idempotentCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'project-a-child',
    nextSessionId: 'project-a-child-2',
    actionGeneration: 'rewind-generation-2',
  });
  assert.equal(idempotentCommit.success, true);
  assert.equal(idempotentCommit.updated, false, 'restart after binding but before cleanup is idempotent');
  assert.equal(manager.getAppState(handoffKey), null);

  manager.setAppState(handoffKey, {
    ...handoffJournal,
    sourceSessionId: 'project-a-child-2',
    actionGeneration: 'rewind-generation-3',
  });
  manager.updateTabCodexSessionId(scopedProjectA.id, projectATabId, 'newer-unrelated-binding');
  const staleCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'project-a-child-2',
    nextSessionId: 'stale-child-must-not-win',
    actionGeneration: 'rewind-generation-3',
  });
  assert.equal(staleCommit.success, false);
  assert.equal(staleCommit.error, 'codex_handoff_binding_changed');
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectA.id, projectATabId),
    'newer-unrelated-binding',
  );
  assert.equal(
    manager.getAppState(handoffKey).actionGeneration,
    'rewind-generation-3',
    'an unresolved stale journal is retained for diagnosis instead of being guessed away',
  );

  const quarantinedActionGeneration = 'rewind-generation-quarantined-c1-c2';
  const quarantinedJournal = {
    version: 2,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    cwd: tempRoot,
    sourceSessionId: 'manual-runtime-c1',
    expectedBindingSessionId: 'saved-session-a',
    sourceBindingMode: 'quarantined-manual-writer',
    sourceLifecycleGeneration: 'terminal-epoch:9',
    sourceRunSeq: 9,
    actionGeneration: quarantinedActionGeneration,
    actionStartedAtMs: Date.now(),
    targetUuid: 'manual-c1-target',
    targetSourceLine: 9,
    targetTextHash: hashCodexRewindTargetText('manual C1 target'),
    rollbackTurns: 1,
    phase: 'confirm-enter-boundary',
  };
  manager.setAppState(handoffKey, {
    ...quarantinedJournal,
    version: 1,
  });
  assert.equal(
    manager.inspectPendingCodexWriterHandoff(handoffKey).status,
    'invalid',
    'a separated A/C1 binding requires the exact-target v2 journal contract',
  );
  manager.updateTabCodexSessionId(scopedProjectA.id, projectATabId, 'newer-binding-d');
  manager.setAppState(handoffKey, quarantinedJournal);
  const changedBindingCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'manual-runtime-c1',
    nextSessionId: 'rewind-child-c2',
    actionGeneration: quarantinedActionGeneration,
  });
  assert.equal(changedBindingCommit.success, false);
  assert.equal(changedBindingCommit.error, 'codex_handoff_binding_changed');
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectA.id, projectATabId),
    'newer-binding-d',
    'a stale quarantined Rewind never overwrites a newer durable binding',
  );
  assert.deepEqual(
    manager.getAppState(handoffKey),
    quarantinedJournal,
    'the unresolved exact journal remains available for deterministic recovery',
  );

  manager.updateTabCodexSessionId(scopedProjectA.id, projectATabId, 'saved-session-a');
  const recordedReplacement = manager.recordPendingCodexRewindReplacementCandidate({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'manual-runtime-c1',
    candidateSessionId: 'rewind-child-c2',
    actionGeneration: quarantinedActionGeneration,
    candidateCreatedAtMs: quarantinedJournal.actionStartedAtMs + 1,
    observedAtMs: quarantinedJournal.actionStartedAtMs + 2,
    retainedPrefixLength: 0,
    postActionMessageCount: 1,
  });
  assert.equal(recordedReplacement.success, true);
  assert.equal(
    manager.getAppState(handoffKey).replacementCandidateProof.sessionId,
    'rewind-child-c2',
    'the exact same-process root replacement is durable before the binding CAS',
  );
  assert.equal(manager.recordPendingCodexRewindReplacementCandidate({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'manual-runtime-c1',
    candidateSessionId: 'unrelated-root',
    actionGeneration: quarantinedActionGeneration,
    candidateCreatedAtMs: quarantinedJournal.actionStartedAtMs + 1,
    observedAtMs: quarantinedJournal.actionStartedAtMs + 3,
    retainedPrefixLength: 0,
    postActionMessageCount: 1,
  }).error, 'codex_rewind_replacement_candidate_ambiguous');
  assert.equal(manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'manual-runtime-c1',
    nextSessionId: 'unrelated-root',
    actionGeneration: quarantinedActionGeneration,
  }).error, 'codex_handoff_replacement_candidate_changed');
  const quarantinedCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: handoffKey,
    projectId: scopedProjectA.id,
    tabId: projectATabId,
    sourceSessionId: 'manual-runtime-c1',
    nextSessionId: 'rewind-child-c2',
    actionGeneration: quarantinedActionGeneration,
  });
  assert.equal(quarantinedCommit.success, true);
  assert.equal(quarantinedCommit.updated, true);
  assert.equal(quarantinedCommit.expectedBindingSessionId, 'saved-session-a');
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectA.id, projectATabId),
    'rewind-child-c2',
    'exact C1 -> C2 Rewind commits A -> C2 without ever publishing C1',
  );
  assert.equal(manager.getAppState(handoffKey), null);

  const v2HandoffKey = `codex.pending-writer-handoff.v1:${projectBTabId}`;
  const v2HandoffJournal = {
    version: 2,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    cwd: tempRoot,
    sourceSessionId: 'project-b-writer',
    actionGeneration: 'rewind-generation-v2',
    actionStartedAtMs: Date.now(),
    targetUuid: 'target-message-v2',
    targetSourceLine: 42,
    targetTextHash: hashCodexRewindTargetText('target prompt v2'),
    rollbackTurns: 2,
    phase: 'confirm-enter-boundary',
  };
  manager.setAppState(v2HandoffKey, v2HandoffJournal);
  const v2Inspection = manager.inspectPendingCodexWriterHandoff(v2HandoffKey);
  assert.equal(v2Inspection.status, 'present', 'the crash-recovery journal with exact target proof is valid');
  assert.deepEqual(v2Inspection.journal, v2HandoffJournal);
  const v2Commit = manager.commitPendingCodexWriterHandoff({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-writer',
    nextSessionId: 'project-b-child-v2',
    actionGeneration: 'rewind-generation-v2',
  });
  assert.equal(v2Commit.success, true);
  assert.equal(manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId), 'project-b-child-v2');
  assert.equal(manager.getAppState(v2HandoffKey), null);

  const stableActionGeneration = 'rewind-generation-v2-stable-source';
  const stableAppliedAtMs = Date.now();
  const stableJournal = {
    ...v2HandoffJournal,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    actionStartedAtMs: stableAppliedAtMs - 10,
    phase: 'rollback-applied',
    appliedAtMs: stableAppliedAtMs,
    restoredTextHash: v2HandoffJournal.targetTextHash,
  };
  manager.setAppState(v2HandoffKey, stableJournal);
  const stableSettlement = manager.settlePendingCodexStableSourceHandoff({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    settledAtMs: stableAppliedAtMs + 1,
  });
  assert.equal(stableSettlement.success, true);
  assert.equal(stableSettlement.journalRetained, true);
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId),
    'project-b-child-v2',
    'stable-source settlement does not rewrite the binding',
  );
  assert.equal(
    manager.getAppState(v2HandoffKey).phase,
    'stable-source-settled',
    'stable-source retains the exact Rewind journal for the first subsequent Enter',
  );
  assert.equal(
    manager.commitPendingCodexWriterHandoff({
      journalKey: v2HandoffKey,
      projectId: scopedProjectB.id,
      tabId: projectBTabId,
      sourceSessionId: 'project-b-child-v2',
      nextSessionId: 'project-b-child-v2',
      actionGeneration: stableActionGeneration,
    }).error,
    'codex_handoff_stable_source_requires_settlement',
    'the generic child commit cannot consume a source-to-source transaction',
  );

  const firstSubmit = manager.armPendingCodexStableSourceSubmit({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    submitId: 'submit-release-before-enter',
    expectedLen: 12,
    expectedHash: '0123456789abcdef',
    sentAtMs: stableAppliedAtMs + 2,
    sourceFilePath: path.join(tempRoot, 'source-v2.jsonl'),
    sourceFileSize: 123,
    runSeq: 7,
  });
  assert.equal(firstSubmit.success, true);
  assert.equal(manager.getAppState(v2HandoffKey).phase, 'stable-source-submit-armed');
  const releasedSubmit = manager.releasePendingCodexStableSourceSubmit({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    submitId: 'submit-release-before-enter',
  });
  assert.equal(releasedSubmit.success, true);
  assert.equal(manager.getAppState(v2HandoffKey).phase, 'stable-source-settled');

  const delayedSubmitId = 'submit-delayed-child';
  const delayedSubmit = manager.armPendingCodexStableSourceSubmit({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    submitId: delayedSubmitId,
    expectedLen: 17,
    expectedHash: 'fedcba9876543210',
    sentAtMs: stableAppliedAtMs + 3,
    sourceFilePath: path.join(tempRoot, 'source-v2.jsonl'),
    sourceFileSize: 123,
    runSeq: 7,
  });
  assert.equal(delayedSubmit.success, true);
  const writtenSubmit = manager.markPendingCodexStableSourceSubmitWritten({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    actionGeneration: stableActionGeneration,
    submitId: delayedSubmitId,
    submitWrittenAtMs: stableAppliedAtMs + 4,
  });
  assert.equal(writtenSubmit.success, true);
  assert.equal(manager.getAppState(v2HandoffKey).phase, 'stable-source-submit-written');
  assert.equal(
    manager.releasePendingCodexStableSourceSubmit({
      journalKey: v2HandoffKey,
      projectId: scopedProjectB.id,
      tabId: projectBTabId,
      sourceSessionId: 'project-b-child-v2',
      actionGeneration: stableActionGeneration,
      submitId: delayedSubmitId,
    }).error,
    'codex_stable_source_submit_may_have_been_written',
    'a possibly-sent command keeps its durable proof instead of reopening blind retry',
  );
  const delayedCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: v2HandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-child-v2',
    nextSessionId: 'project-b-delayed-child',
    actionGeneration: stableActionGeneration,
  });
  assert.equal(delayedCommit.success, true);
  assert.equal(
    manager.getTabCodexSessionId(scopedProjectB.id, projectBTabId),
    'project-b-delayed-child',
  );
  assert.equal(manager.getAppState(v2HandoffKey), null);

  manager.setAppState(v2HandoffKey, {
    ...v2HandoffJournal,
    sourceSessionId: 'project-b-delayed-child',
    actionGeneration: 'rewind-generation-v2-invalid',
    targetTextHash: null,
  });
  const invalidV2Inspection = manager.inspectPendingCodexWriterHandoff(v2HandoffKey);
  assert.equal(invalidV2Inspection.status, 'invalid', 'v2 must not lose its exact target proof');
  assert.equal(invalidV2Inspection.error, 'codex_handoff_journal_invalid');
  manager.setAppState(v2HandoffKey, {
    ...v2HandoffJournal,
    sourceSessionId: 'project-b-delayed-child',
    actionGeneration: 'rewind-generation-v2-missing-target',
    targetUuid: null,
  });
  assert.equal(
    manager.inspectPendingCodexWriterHandoff(v2HandoffKey).status,
    'invalid',
    'v2 must identify the exact user-message target, not only its line and hash',
  );
  manager.setAppState(v2HandoffKey, {
    ...v2HandoffJournal,
    sourceSessionId: 'project-b-delayed-child',
    actionGeneration: 'rewind-generation-v2-line-zero',
    targetSourceLine: 0,
  });
  assert.equal(
    manager.inspectPendingCodexWriterHandoff(v2HandoffKey).status,
    'invalid',
    'line zero is session metadata, never a Rewind user-message target',
  );
  manager.deleteAppState(v2HandoffKey);

  const corruptHandoffKey = `codex.pending-writer-handoff.v1:${projectBTabId}`;
  manager.db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(corruptHandoffKey, '{"version":1,"projectId":');
  const corruptInspection = manager.inspectPendingCodexWriterHandoff(corruptHandoffKey);
  assert.equal(corruptInspection.status, 'invalid');
  assert.equal(corruptInspection.error, 'codex_handoff_journal_corrupt');
  assert.equal(
    corruptInspection.rawValue,
    '{"version":1,"projectId":',
    'the unreadable journal remains available for diagnosis instead of becoming absent',
  );
  const corruptCommit = manager.commitPendingCodexWriterHandoff({
    journalKey: corruptHandoffKey,
    projectId: scopedProjectB.id,
    tabId: projectBTabId,
    sourceSessionId: 'project-b-writer',
    nextSessionId: 'must-not-bind',
    actionGeneration: 'rewind-generation-corrupt',
  });
  assert.equal(corruptCommit.success, false);
  assert.equal(corruptCommit.error, 'codex_handoff_journal_corrupt');
  assert.equal(corruptCommit.retryable, false);
  assert.equal(
    manager.db.prepare('SELECT value FROM app_state WHERE key = ?').get(corruptHandoffKey).value,
    '{"version":1,"projectId":',
    'a corrupt journal is retained rather than silently cleared',
  );
});
