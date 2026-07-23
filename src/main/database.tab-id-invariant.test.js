const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tab-id-db-'));
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
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function openManagerOrSkip(t) {
  try {
    return new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
}

test('duplicate tab IDs migrate deterministically and project-scoped references follow the renamed row', (t) => {
  let manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => {
    try { manager?.close(); } catch {}
  });

  const projectA = manager.createEmptyProject('Canonical project');
  const projectB = manager.createEmptyProject('Renamed project');
  const collidedId = `${projectA.id}-tab-7`;
  manager.db.exec('DROP INDEX IF EXISTS idx_tabs_tab_id_unique');

  assert.deepEqual(manager.saveTabs(projectA.id, [{
    tabId: collidedId,
    name: 'Canonical',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'session-a',
  }], true), { success: true });
  assert.deepEqual(manager.saveTabs(projectB.id, [{
    tabId: collidedId,
    name: 'Must be renamed',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'session-b',
  }, {
    tabId: `${projectB.id}-tab-9`,
    name: 'Dependent',
    cwd: tempRoot,
    visualParentTabId: collidedId,
    restartAfterTabId: collidedId,
    restartAfterTabIds: [collidedId],
  }], true), { success: true });

  manager.updateProjectTabGroups(projectB.id, [{ id: 'group-b', name: 'B', anchorTabId: collidedId }]);
  manager.db.prepare(`
    INSERT INTO ai_prompt_call_logs (project_id, tab_id, status)
    VALUES (?, ?, 'success')
  `).run(projectB.id, collidedId);
  manager.db.prepare(`
    INSERT INTO agent_activity_intervals
      (tab_id, project_id, start_ts, end_ts, duration_ms)
    VALUES (?, ?, 1, 2, 1)
  `).run(collidedId, projectB.id);
  manager.db.prepare(`
    INSERT INTO timeline_notes (entry_uuid, session_id, tab_id, content)
    VALUES ('entry-b', 'session-b', ?, 'note')
  `).run(collidedId);
  manager.db.exec(`
    CREATE TABLE IF NOT EXISTS api_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      source_tab_id TEXT,
      target_tab_id TEXT
    )
  `);
  manager.db.prepare(`
    INSERT INTO api_call_log (project_id, source_tab_id, target_tab_id)
    VALUES (?, ?, ?)
  `).run(projectB.id, collidedId, collidedId);
  manager.setAppState('terminal:command-run-history', {
    [collidedId]: [
      { id: `10:${collidedId}`, tabId: collidedId, projectId: projectA.id, at: 10, command: 'echo a' },
      { id: `20:${collidedId}`, tabId: collidedId, projectId: projectB.id, at: 20, command: 'echo b' },
    ],
  });
  manager.setAppState('terminal:last-command-by-cwd', {
    '/canonical': { cwd: '/canonical', tabId: collidedId, projectId: projectA.id, at: 10, command: 'echo a' },
    '/renamed': { cwd: '/renamed', tabId: collidedId, projectId: projectB.id, at: 20, command: 'echo b' },
  });

  manager.close();
  manager = openManagerOrSkip(t);
  if (!manager) return;

  const rowsA = manager.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(projectA.id);
  const rowsB = manager.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(projectB.id);
  assert.equal(rowsA.find((row) => row.name === 'Canonical').tab_id, collidedId, 'ID owned by its project prefix stays canonical');
  const renamed = rowsB.find((row) => row.name === 'Must be renamed');
  assert.ok(renamed.tab_id.startsWith(`${projectB.id}-tab-`));
  assert.notEqual(renamed.tab_id, collidedId);

  const dependent = rowsB.find((row) => row.name === 'Dependent');
  assert.equal(dependent.visual_parent_tab_id, renamed.tab_id);
  assert.equal(dependent.restart_after_tab_id, renamed.tab_id);
  assert.deepEqual(JSON.parse(dependent.restart_after_tab_ids), [renamed.tab_id]);
  assert.equal(manager.getProjectById(projectB.id).tabGroups[0].anchorTabId, renamed.tab_id);
  assert.equal(manager.db.prepare('SELECT tab_id FROM ai_prompt_call_logs WHERE project_id = ?').get(projectB.id).tab_id, renamed.tab_id);
  assert.equal(manager.db.prepare('SELECT tab_id FROM agent_activity_intervals WHERE project_id = ?').get(projectB.id).tab_id, renamed.tab_id);
  assert.equal(manager.db.prepare("SELECT tab_id FROM timeline_notes WHERE session_id = 'session-b'").get().tab_id, renamed.tab_id);
  const apiRow = manager.db.prepare('SELECT source_tab_id, target_tab_id FROM api_call_log WHERE project_id = ?').get(projectB.id);
  assert.equal(apiRow.source_tab_id, renamed.tab_id);
  assert.equal(apiRow.target_tab_id, renamed.tab_id);

  const history = manager.getAppState('terminal:command-run-history');
  assert.equal(history[collidedId].length, 1);
  assert.equal(history[collidedId][0].projectId, projectA.id);
  assert.equal(history[renamed.tab_id].length, 1);
  assert.equal(history[renamed.tab_id][0].projectId, projectB.id);
  assert.equal(history[renamed.tab_id][0].tabId, renamed.tab_id);
  const lastByCwd = manager.getAppState('terminal:last-command-by-cwd');
  assert.equal(lastByCwd['/canonical'].tabId, collidedId);
  assert.equal(lastByCwd['/renamed'].tabId, renamed.tab_id);

  assert.throws(() => {
    manager.db.prepare(`
      INSERT INTO tabs (project_id, name, cwd, tab_id)
      VALUES (?, 'Duplicate rejected', ?, ?)
    `).run(projectB.id, tempRoot, collidedId);
  }, /UNIQUE constraint failed/);
});

test('cross-project row transfer is atomic and preserves Codex binding', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => {
    try { manager.close(); } catch {}
  });

  const source = manager.createEmptyProject('Transfer source');
  const target = manager.createEmptyProject('Transfer target');
  assert.deepEqual(manager.saveTabs(target.id, [{
    tabId: '   ',
    name: 'Invalid identity',
    cwd: tempRoot,
  }], true), { success: false, error: 'tab_id_required' });
  const tabA = `${source.id}-tab-0`;
  const tabB = `${source.id}-tab-1`;
  manager.saveTabs(source.id, [{
    tabId: tabA,
    name: 'Codex A',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'writer-a',
    groupId: 'source-group',
  }, {
    tabId: tabB,
    name: 'Terminal B',
    cwd: tempRoot,
    groupId: 'source-group',
    visualParentTabId: tabA,
  }], true);
  manager.updateProjectTabGroups(source.id, [{ id: 'source-group', name: 'Source', anchorTabId: tabA }]);
  const handoffKey = `codex.pending-writer-handoff.v1:${tabA}`;
  manager.setAppState(handoffKey, {
    version: 1,
    projectId: source.id,
    tabId: tabA,
    cwd: tempRoot,
    sourceSessionId: 'writer-a',
    actionGeneration: 'move-generation',
    actionStartedAtMs: Date.now(),
  });

  const rejected = manager.transferTabsToProject(source.id, target.id, [tabA, 'missing-tab']);
  assert.equal(rejected.success, false);
  assert.equal(manager.db.prepare('SELECT project_id FROM tabs WHERE tab_id = ?').get(tabA).project_id, source.id, 'partial batch never moves');
  assert.equal(manager.inspectPendingCodexWriterHandoff(handoffKey).journal.projectId, source.id);

  const committed = manager.transferTabsToProject(source.id, target.id, [tabA, tabB]);
  assert.deepEqual(committed, { success: true, transferred: [tabA, tabB] });
  assert.equal(manager.db.prepare('SELECT COUNT(*) AS count FROM tabs WHERE project_id = ?').get(source.id).count, 0);
  const moved = manager.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(target.id);
  assert.deepEqual(moved.map((row) => row.tab_id), [tabA, tabB]);
  assert.equal(moved.find((row) => row.tab_id === tabA).codex_session_id, 'writer-a');
  assert.equal(moved.find((row) => row.tab_id === tabA).tab_group_id, null);
  assert.equal(moved.find((row) => row.tab_id === tabB).visual_parent_tab_id, tabA);
  assert.equal(manager.getProjectById(source.id).tabGroups[0].anchorTabId, undefined);
  const migratedHandoff = manager.inspectPendingCodexWriterHandoff(handoffKey);
  assert.equal(migratedHandoff.status, 'present');
  assert.equal(migratedHandoff.journal.projectId, target.id);
  assert.equal(migratedHandoff.journal.sourceSessionId, 'writer-a');
  assert.equal(migratedHandoff.journal.actionGeneration, 'move-generation');

  const rendererFollowUp = manager.getProjectById(target.id).tabs.map((tab) => (
    tab.tabId === tabA ? { ...tab, codexSessionId: 'stale-renderer-source' } : tab
  ));
  assert.deepEqual(manager.saveTabs(source.id, [], true), { success: true });
  assert.deepEqual(manager.saveTabs(target.id, rendererFollowUp), { success: true });
  assert.equal(
    manager.getTabCodexSessionId(target.id, tabA),
    'writer-a',
    'the normal renderer follow-up save cannot roll the transferred main-owned binding back',
  );
});

test('cross-project row transfer is blocked atomically by an invalid pending Codex handoff', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => {
    try { manager.close(); } catch {}
  });

  const source = manager.createEmptyProject('Corrupt handoff source');
  const target = manager.createEmptyProject('Corrupt handoff target');
  const tabId = `${source.id}-tab-corrupt`;
  const validTabId = `${source.id}-tab-valid-before-corrupt`;
  manager.saveTabs(source.id, [{
    tabId: validTabId,
    name: 'Codex with valid handoff',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'writer-valid',
  }, {
    tabId,
    name: 'Codex with corrupt handoff',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'writer-corrupt',
  }], true);
  const validHandoffKey = `codex.pending-writer-handoff.v1:${validTabId}`;
  manager.setAppState(validHandoffKey, {
    version: 1,
    projectId: source.id,
    tabId: validTabId,
    cwd: tempRoot,
    sourceSessionId: 'writer-valid',
    actionGeneration: 'valid-before-corrupt',
    actionStartedAtMs: Date.now(),
  });
  const handoffKey = `codex.pending-writer-handoff.v1:${tabId}`;
  manager.db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
    .run(handoffKey, '{"projectId":');

  const result = manager.transferTabsToProject(source.id, target.id, [validTabId, tabId]);

  assert.equal(result.success, false);
  assert.equal(result.error, 'codex_handoff_journal_corrupt');
  assert.equal(
    manager.db.prepare('SELECT project_id FROM tabs WHERE tab_id = ?').get(tabId).project_id,
    source.id,
    'the tab row does not move when its crash-recovery journal cannot migrate',
  );
  assert.equal(
    manager.db.prepare('SELECT project_id FROM tabs WHERE tab_id = ?').get(validTabId).project_id,
    source.id,
    'the valid tab in the same batch does not move either',
  );
  assert.equal(
    manager.inspectPendingCodexWriterHandoff(validHandoffKey).journal.projectId,
    source.id,
    'preflight validates the entire batch before migrating any valid journal',
  );
  assert.equal(manager.inspectPendingCodexWriterHandoff(handoffKey).status, 'invalid');
});

test('cross-project group transfer moves group metadata and hierarchy in one transaction', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => {
    try { manager.close(); } catch {}
  });

  const source = manager.createEmptyProject('Group source');
  const target = manager.createEmptyProject('Group target');
  const sourceGroupId = `${source.id}-group-source`;
  const targetGroupId = `${target.id}-group-moved`;
  const rootId = `${source.id}-tab-root`;
  const childId = `${source.id}-tab-child`;
  manager.saveTabs(source.id, [{
    tabId: rootId,
    name: 'Root',
    cwd: tempRoot,
    groupId: sourceGroupId,
  }, {
    tabId: childId,
    name: 'Child',
    cwd: tempRoot,
    groupId: sourceGroupId,
    visualParentTabId: rootId,
  }], true);
  manager.updateProjectTabGroups(source.id, [{
    id: sourceGroupId,
    name: 'Moved group',
    createdAt: 123,
    collapsed: true,
    color: 'green',
    sessionStatus: 'active',
    anchorTabId: rootId,
  }]);
  manager.updateProjectTabGroups(target.id, [{
    id: `${target.id}-group-existing`,
    name: 'Existing',
    createdAt: 100,
  }]);
  const childHandoffKey = `codex.pending-writer-handoff.v1:${childId}`;
  manager.setAppState(childHandoffKey, {
    version: 1,
    projectId: source.id,
    tabId: childId,
    cwd: tempRoot,
    sourceSessionId: 'group-source-writer',
    actionGeneration: 'group-move-generation',
    actionStartedAtMs: Date.now(),
  });

  const rejected = manager.transferTabGroupToProject(
    source.id,
    target.id,
    sourceGroupId,
    targetGroupId,
    [rootId]
  );
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, 'tab_group_source_rows_changed');
  assert.equal(manager.db.prepare('SELECT project_id FROM tabs WHERE tab_id = ?').get(rootId).project_id, source.id);

  const committed = manager.transferTabGroupToProject(
    source.id,
    target.id,
    sourceGroupId,
    targetGroupId,
    [rootId, childId]
  );
  assert.deepEqual(committed, {
    success: true,
    transferred: [rootId, childId],
    sourceGroupId,
    targetGroupId,
  });

  assert.deepEqual(manager.getProjectById(source.id).tabGroups, []);
  const targetGroups = manager.getProjectById(target.id).tabGroups;
  assert.equal(targetGroups.length, 2);
  const movedGroup = targetGroups[1];
  assert.deepEqual(movedGroup, {
    id: targetGroupId,
    name: 'Moved group',
    createdAt: 123,
    collapsed: true,
    color: 'green',
    sessionStatus: 'active',
  });
  const movedRows = manager.db.prepare(
    'SELECT tab_id, tab_group_id, visual_parent_tab_id FROM tabs WHERE project_id = ? ORDER BY position'
  ).all(target.id);
  assert.deepEqual(movedRows, [{
    tab_id: rootId,
    tab_group_id: targetGroupId,
    visual_parent_tab_id: null,
  }, {
    tab_id: childId,
    tab_group_id: targetGroupId,
    visual_parent_tab_id: rootId,
  }]);
  assert.equal(
    manager.inspectPendingCodexWriterHandoff(childHandoffKey).journal.projectId,
    target.id,
    'group transfer migrates a pending writer handoff in the same transaction',
  );
});
