const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  const staleRendererTab = {
    tabId,
    name: 'Before rename',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'resume-source-session',
  };

  manager.saveTabs(project.id, [staleRendererTab], true);
  assert.equal(
    manager.getTabCodexSessionId(project.id, tabId),
    'resume-source-session',
    'point reads require and resolve the full project + tab identity',
  );
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
});
