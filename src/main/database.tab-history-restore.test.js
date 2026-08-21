const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tab-history-db-'));
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

test('tab-history restore reads non-destructively, preserves migration provenance, and deletes only the committed row', (t) => {
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

  const firstProject = manager.createEmptyProject('History first');
  const secondProject = manager.createEmptyProject('History second');
  const olderId = Number(manager.archiveTab(firstProject.id, {
    tabId: 'history-tab-older',
    name: 'older',
    cwd: '/tmp',
    commandType: 'codex',
    codexSessionId: 'session-older',
  }));
  const latestId = Number(manager.archiveTab(firstProject.id, {
    tabId: 'history-tab-latest',
    name: 'latest',
    cwd: '/tmp',
    commandType: 'codex',
    codexSessionId: 'session-latest',
  }));
  const otherProjectId = Number(manager.archiveTab(secondProject.id, {
    name: 'other',
    cwd: '/tmp',
  }));
  const migrationHistoryId = Number(manager.archiveTab(firstProject.id, {
    name: 'pending migration',
    cwd: '/tmp',
    commandType: 'codex',
    codexModelMigrationPending: true,
    codexModelMigrationSourceModel: 'gpt-5.4-mini',
    codexModelMigrationTargetModel: 'gpt-5.6-luna',
    codexModelMigrationConfigAlreadyTarget: true,
  }));
  const migrationHistory = manager.getTabHistoryEntry(migrationHistoryId, firstProject.id);
  assert.equal(migrationHistory.codex_model_migration_config_already_target, 1);

  // Close -> History -> Restore: the history row uses SQLite's integer form,
  // while the in-memory tab uses a boolean. Preserve the provenance instead
  // of silently re-arming the migration as if the config had been untouched.
  assert.deepEqual(manager.saveTabs(firstProject.id, [{
    tabId: 'restored-pending-migration',
    name: migrationHistory.name,
    cwd: migrationHistory.cwd,
    commandType: migrationHistory.command_type,
    codexModelMigrationPending: migrationHistory.codex_model_migration_pending === 1,
    codexModelMigrationSourceModel: migrationHistory.codex_model_migration_source_model,
    codexModelMigrationTargetModel: migrationHistory.codex_model_migration_target_model,
    codexModelMigrationConfigAlreadyTarget:
      migrationHistory.codex_model_migration_config_already_target === 1,
  }], true), { success: true });
  const restoredMigration = manager.getProjectById(firstProject.id).tabs.find(
    (tab) => tab.tabId === 'restored-pending-migration',
  );
  assert.equal(restoredMigration.codexModelMigrationConfigAlreadyTarget, true);

  const windowScopedHistoryId = Number(manager.archiveTab(firstProject.id, {
    tabId: 'window-scoped-history',
    name: 'window only',
    cwd: '/tmp',
    windowScoped: true,
  }));
  const windowScopedHistory = manager.getTabHistoryEntry(windowScopedHistoryId, firstProject.id);
  assert.equal(windowScopedHistory.window_scoped, 1, 'close must preserve window-strip ownership');
  assert.equal(manager.deleteTabHistoryEntry(windowScopedHistoryId), true);

  assert.deepEqual(manager.saveTabs(firstProject.id, [{
    tabId: 'window-scoped-live',
    name: 'window only live',
    cwd: '/tmp',
    windowScoped: true,
  }], true), { success: true });
  const windowScopedLive = manager.getProjectById(firstProject.id).tabs.find(
    (tab) => tab.tabId === 'window-scoped-live',
  );
  assert.equal(windowScopedLive.windowScoped, true, 'restart must not duplicate the tab into the sidebar');

  assert.equal(manager.getLatestTabHistory(firstProject.id).id, migrationHistoryId);
  assert.equal(manager.getLatestTabHistory(firstProject.id).id, migrationHistoryId, 'read must not consume the row');
  assert.deepEqual(
    manager.getTabHistoryEntriesByTabId('history-tab-latest').map((entry) => entry.id),
    [latestId],
    'closed-tab lookup must preserve the exact original tab identity',
  );
  assert.deepEqual(manager.getTabHistoryEntriesByTabId('missing-tab'), []);
  assert.equal(manager.getTabHistoryEntry(latestId, secondProject.id), undefined, 'lookup must stay project-scoped');
  assert.equal(manager.getLatestTabHistory(secondProject.id).id, otherProjectId);

  assert.equal(manager.deleteTabHistoryEntry(migrationHistoryId), true);
  assert.equal(manager.getLatestTabHistory(firstProject.id).id, latestId);
  assert.equal(manager.deleteTabHistoryEntry(latestId), true);
  assert.equal(manager.getLatestTabHistory(firstProject.id).id, olderId);
  assert.equal(manager.deleteTabHistoryEntry(latestId), false);

  assert.deepEqual(manager.saveTabs(firstProject.id, [{
    tabId: 'cwd-proof-tab',
    name: 'cwd proof',
    cwd: '/before',
  }]), { success: true });
  assert.equal(manager.updateTabCwd('cwd-proof-tab', '/after'), true);
  const cwdTab = manager.getProjectById(firstProject.id).tabs.find(tab => tab.tabId === 'cwd-proof-tab');
  assert.equal(cwdTab.cwd, '/after', 'accepted CWD must be durable before renderer follow-up');
  assert.equal(manager.updateTabCwd('missing-tab', '/after'), false);

  assert.deepEqual(manager.saveTabs('missing-project', [{
    tabId: 'unsaved-restored-tab',
    name: 'must not acknowledge',
    cwd: '/tmp',
  }]), {
    success: false,
    error: 'project_not_found',
  });
  assert.equal(
    manager.getLatestTabHistory(firstProject.id).id,
    olderId,
    'a failed target-project save must not consume the recoverable history row',
  );
});
