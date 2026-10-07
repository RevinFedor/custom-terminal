'use strict';

// Native SQLite only (no ABI skip, electron/app mock, provider, PTY or Main
// bootstrap). DatabaseManager's actual initTables and methods are exercised on
// owned databases. Run with the repository Electron's ELECTRON_RUN_AS_NODE=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { ConversationOwners } = require('./conversation-owner');
const { WorkflowOrganization, fingerprint, INBOX_WORKFLOW_ID } = require('./workflow-organization');
const { clone, layoutReferences, planMigration, mergeLayout, executionScopeForRow, sameExecutionScope, GLOBAL_EXECUTION_NAMESPACE } = require('../shared/workflow-organization.cjs');

function fixture(t, { extensions = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-native-'));
  const filename = path.join(root, 'fixture.db');
  let connection = new Database(filename);
  t.after(() => { if (connection.open) connection.close(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  connection.pragma('foreign_keys=ON');
  connection.pragma('journal_mode=WAL');
  let manager = new DatabaseManager({ existingConnection: connection });
  manager.initTables();
  for (const namespace of ['P', 'Q', 'K']) connection.prepare('INSERT INTO projects(id,path,name,notes_global,tab_groups) VALUES(?,?,?,?,?)')
    .run(namespace, root, namespace, 'notes:' + namespace, JSON.stringify([{ id: 'group', name: namespace, future: { keep: true } }]));
  const insert = connection.prepare(`INSERT INTO tabs(project_id,name,cwd,tab_id,command_type,codex_session_id,
    tab_type,is_utility,parent_tab_id,tab_group_id,notes,provider_state,restart_after_workflow_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [tabId, namespace, type, utility, parent] of [
    ['T', 'P', 'terminal', 0, null], ['H', 'Q', 'file', 0, null], ['W', 'P', 'terminal', 1, 'T'],
    ['X', 'P', 'terminal', 0, null], ['N', 'K', 'terminal', 0, null], ['Y', 'Q', 'terminal', 0, null],
  ]) insert.run(namespace, tabId, root + '/' + namespace, tabId, 'codex', 'sid-' + tabId,
    type, utility, parent, 'group', 'note:' + tabId, '{"future":true}', '["__unplaced__"]');
  connection.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd,codex_session_id,notes) VALUES(?,?,?,?,?,?)')
    .run('P', 'archived', 'Archive', root, 'old-sid', 'closed note');
  connection.prepare('INSERT INTO tab_history(project_id,name,cwd) VALUES(?,?,?)').run('P', 'Pre-ID archive', root);
  connection.exec(`
    INSERT INTO favorites(project_id,name,notes) VALUES('P','Favorite','opaque archive');
    INSERT INTO gemini_history(project_id,selected_text,prompt,response) VALUES('Q','selected','prompt','response');
    INSERT INTO ai_sessions(project_id,tool_type,session_key,content_blob,original_cwd)
      VALUES('P','claude','S','{opaque:true}','/exact-old-address');
    INSERT INTO project_prompt_sources(project_id,root_path,position) VALUES('P','/same-root',2),('Q','/same-root',7);
    INSERT INTO quick_actions(project_id,name,command,position) VALUES('P','Action','literal-command',3);
  `);
  const workspace = {
    futureTop: { keep: 'unchanged' }, activeSpaceId: 'a', windowDisplayKey: 'laptop',
    splitPanes: [
      { windowId: 'live', projectId: 'P', tabId: 'T', futureWindow: { opaque: 4 },
        tabs: [{ projectId: 'P', tabId: 'T', futureSlot: 9 }, { slotId: 'chooser', cwd: '/choose' }],
        history: [{ tabId: 'historical-navigation', projectId: 'P' }], detachedTabs: [{ tabId: 'closed' }] },
      { windowId: 'hidden', displayHidden: true, projectId: 'Q', tabId: 'H' },
      { windowId: 'conflict', projectId: 'P', tabId: 'X' },
    ],
    windowDisplayLayouts: {
      modern: { positions: [{ windowId: 'hidden', column: 3, row: 0 }], futureGeometry: 'keep' },
      oldMirror: { splitPanes: [{ windowId: 'mirror', projectId: 'P', tabId: 'T' }, { tabId: 'reference-only', projectId: 'Q' }] },
    },
    spaces: [
      { id: 'a', name: 'Active', projectIds: ['P'], futureSpace: 9,
        layout: { splitPanes: [{ tabId: 'stale-saved-only', projectId: 'P' }], futureLayout: { keep: true } } },
      { id: 'b', name: 'Dormant', projectIds: ['Q'], layout: { splitPanes: [{ projectId: 'P', tabId: 'X', windowId: 'dormant' }],
        windowDisplayLayouts: { archivedDisplay: { splitPanes: [{ tabId: 'X', projectId: 'P' }] } } } },
    ],
  };
  manager.setAppState('workspace-session', workspace);
  manager.setAppState('frozen-receipt', { projectId: 'P', tabId: 'T', sid: 'sid-T', launch: 'L', epoch: 'E', aliases: ['literal'] });
  manager.setAppState('policy', { workflows: ['__unplaced__'], targets: ['T'], future: 6 });
  if (extensions) {
    connection.exec(`ALTER TABLE tabs ADD COLUMN future_blob BLOB;
      ALTER TABLE tabs ADD COLUMN future_column TEXT DEFAULT 'extension';
      ALTER TABLE tabs ADD COLUMN future_derived TEXT GENERATED ALWAYS AS (name||'!') VIRTUAL;
      CREATE INDEX future_column_index ON tabs(future_column);
      CREATE UNIQUE INDEX future_full_opaque_id ON tabs(tab_id);
      CREATE TABLE future_pk_dependency(tab_storage_id INTEGER REFERENCES tabs(id) ON DELETE RESTRICT, payload BLOB);
      CREATE TABLE future_opaque_dependency(tab_opaque_id TEXT REFERENCES tabs(tab_id) ON DELETE RESTRICT, payload TEXT);
      CREATE TABLE future_cascade_dependency(tab_storage_id INTEGER REFERENCES tabs(id) ON DELETE CASCADE,payload TEXT);
      CREATE VIEW future_tab_view AS SELECT id,tab_id,future_column FROM tabs;
      CREATE TABLE future_trigger_log(payload TEXT);
      CREATE TRIGGER future_tab_update AFTER UPDATE ON tabs BEGIN INSERT INTO future_trigger_log VALUES(new.tab_id); END;
      UPDATE tabs SET future_blob=x'0001ff',future_column='unknown:preserve' WHERE tab_id='T';
      INSERT INTO future_pk_dependency SELECT id,x'ff00a1' FROM tabs WHERE tab_id='T';
      INSERT INTO future_opaque_dependency VALUES('T','unknown-ref');
      INSERT INTO future_cascade_dependency SELECT id,'never-cascade' FROM tabs WHERE tab_id='T';
    `);
  }
  let sourceRevision = 17;
  const artifacts = { effectivePromptBindings: { P: ['root1'], Q: ['root2'] }, initialEligibility: { __unplaced__: ['N'] }, frozenQueueTargets: ['T'] };
  const captureSource = () => ({ sourceRevisions: { renderer: sourceRevision }, artifacts });
  const preSchema = legacyManifest(connection);
  let service = new WorkflowOrganization({ database: manager, captureSource });
  const reopen = () => {
    connection.close();
    connection = new Database(filename);
    connection.pragma('foreign_keys=ON');
    manager = new DatabaseManager({ existingConnection: connection });
    service = new WorkflowOrganization({ database: manager, captureSource });
  };
  return { root, filename, artifacts, workspace, preSchema, reopen, bumpSource: () => { sourceRevision++; },
    get db() { return connection; }, get manager() { return manager; }, get service() { return service; } };
}

function migrate(f, migrationId = 'migration') {
  const stage = f.service.prepareMigration({ migrationId, expectedRevision: 0 });
  const request = { mutationId: 'publish-' + migrationId, migrationId, expectedRevision: 0, sourceFingerprint: stage.sourceFingerprint };
  const result = f.service.publishMigration(request);
  return { stage, request, result };
}
function request(f, extra) { return { mutationId: cryptoId(), expectedRevision: f.service.getPublication().revision, ...extra }; }
function cryptoId() { return require('node:crypto').randomUUID(); }
function legacyManifest(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'workflow_org_%' ORDER BY type,name").all();
  const tables = {};
  for (const row of schema.filter(row => row.type === 'table')) tables[row.name] = db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all();
  return { schema, tables };
}
function child(code, f) {
  const result = spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKFLOW_FIXTURE: f.filename }, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

test('native runtime, real schema, FK-on and complete byte/PK/index/trigger preservation across migration/reopen', t => {
  const f = fixture(t);
  assert.equal(process.versions.modules, '119');
  assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(f.db.prepare('PRAGMA table_info(tabs)').all().find(row => row.name === 'project_id').notnull, 0);
  const afterSchema = legacyManifest(f.db);
  for (const [table, rows] of Object.entries(f.preSchema.tables)) {
    if (table === 'sqlite_sequence') continue;
    const originalFields = rows[0] ? Object.keys(rows[0]) : [];
    assert.deepEqual(afterSchema.tables[table].map(row => Object.fromEntries(originalFields.map(field => [field, row[field]]))), rows);
  }
  for (const object of f.preSchema.schema.filter(item => item.type !== 'table')) {
    assert.deepEqual(afterSchema.schema.find(item => item.name === object.name), object);
  }
  for (const row of f.preSchema.tables.sqlite_sequence) assert.deepEqual(afterSchema.tables.sqlite_sequence.find(item => item.name === row.name), row);
  const before = legacyManifest(f.db);
  const beforeHash = fingerprint(before);
  const { result } = migrate(f);
  assert.equal(result.generation, 1);
  assert.deepEqual(legacyManifest(f.db), before);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  f.reopen();
  assert.deepEqual(legacyManifest(f.db), before);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  console.log('PRESERVATION_MANIFEST ' + JSON.stringify({ abi: process.versions.modules, sqlite: f.db.prepare('select sqlite_version() version').get().version,
    legacyTables: Object.keys(before.tables), schemaObjects: before.schema.length, sha256: beforeHash,
    preserved: ['all legacy rows/columns including BLOB', 'integer PK and opaque tab IDs', 'FK dependencies', 'indexes/triggers', 'sqlite_sequence', 'raw receipts/policies/groups/roots/archive'] }));
});

test('backfill uses live active layout, hidden/dormant/profile inventory; mirrors normalize to ONE membership', t => {
  const f = fixture(t); const { stage } = migrate(f);
  for (const tabId of ['T', 'H', 'W', 'archived', 'reference-only']) assert.equal(f.service.getMembership(tabId).workflowId, 'a');
  assert.equal(f.service.getMembership('Y').workflowId, 'b');
  assert.equal(f.service.getMembership('N').workflowId, INBOX_WORKFLOW_ID);
  assert.equal(f.service.getMembership('stale-saved-only'), null);
  assert.equal(f.service.getMembership('historical-navigation'), null);
  assert.equal(f.service.getMembership('closed'), null);
  assert.equal(f.service.getTab('reference-only').executionResolved, false);
  assert.equal(f.service.getTab('H').legacyRow.tab_type, 'file');
  assert.equal(f.service.getTab('W').legacyRow.parent_tab_id, 'T');
  assert.equal(f.service.getTab('W').legacyRow.is_utility, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM workflow_org_memberships WHERE tab_id='T'").get().n, 1);
  assert.equal(layoutReferences(f.service.getWorkflow('a').layout).filter(ref => ref.tabId === 'T').length, 3);
  assert.equal(f.service.getWorkflow('a').layout.futureLayout.keep, true);
  assert.deepEqual(stage.source.workspace, f.workspace);
});

test('cross-workflow evidence goes to accessible Inbox with exact journal, no active-first winner', t => {
  const f = fixture(t); migrate(f);
  assert.equal(f.service.getMembership('X').workflowId, INBOX_WORKFLOW_ID);
  assert.equal(f.service.listMembers(INBOX_WORKFLOW_ID).some(tab => tab.tabId === 'X'), true);
  assert.equal(f.service.listWorkflows().some(workflow => layoutReferences(workflow.layout).some(ref => ref.tabId === 'X')), false);
  const conflict = f.service.getJournal().find(row => row.reason === 'cross-workflow-conflict');
  assert.deepEqual(conflict.candidates, ['a', 'b']);
  assert.equal(conflict.evidence.some(ref => ref.workflowId === 'b' && ref.path.includes('archivedDisplay')), true);
  assert.equal(conflict.winner, INBOX_WORKFLOW_ID);
});

test('only unique project associations apply to truly unplaced records; ambiguous namespaces/associations use Inbox', () => {
  const base = { legacy: { tables: { tabs: [{ tab_id: 'T', project_id: 'P', cwd: '/P' }] } },
    workspace: { spaces: [{ id: 'a', projectIds: ['P'], layout: {} }, { id: 'b', projectIds: ['P'], layout: {} }] } };
  assert.equal(planMigration(base).memberships[0].workflowId, INBOX_WORKFLOW_ID);
  base.workspace.spaces[1].projectIds = [];
  assert.equal(planMigration(base).memberships[0].workflowId, 'a');
  base.legacy.tables.tab_history = [{ tab_id: 'T', project_id: 'Q', cwd: '/Q' }];
  assert.equal(planMigration(base).memberships[0].workflowId, INBOX_WORKFLOW_ID);
});

test('restartable prepared generation, matching retry, changed source revisions and DB fingerprint reject without publication', t => {
  const f = fixture(t);
  const stage = f.service.prepareMigration({ migrationId: 'M', expectedRevision: 0 });
  assert.deepEqual(f.service.prepareMigration({ migrationId: 'M', expectedRevision: 0 }), stage);
  f.reopen();
  assert.deepEqual(f.service.getPreparedMigration('M'), stage);
  f.bumpSource();
  assert.throws(() => f.service.publishMigration({ mutationId: 'bad-source', expectedRevision: 0, migrationId: 'M', sourceFingerprint: stage.sourceFingerprint }), /source_changed/);
  assert.equal(f.service.getPublication().generation, 0);
  assert.throws(() => f.service.prepareMigration({ migrationId: 'M', expectedRevision: 0 }), /migration_id_conflict/);
  const next = f.service.prepareMigration({ migrationId: 'M2', expectedRevision: 0 });
  f.manager.updateTabCwd('T', f.root + '/new-cwd');
  assert.throws(() => f.service.publishMigration({ mutationId: 'bad-db', expectedRevision: 0, migrationId: 'M2', sourceFingerprint: next.sourceFingerprint }), /source_changed/);
  assert.equal(f.service.getPublication().generation, 0);
  assert.equal(f.service.listGlobalTabs().length, 0);
});

test('same mutation ID replays after reopen; changed payload and cross-operation reuse conflict', t => {
  const f = fixture(t); const { request: publication, result } = migrate(f);
  f.reopen();
  assert.deepEqual(f.service.publishMigration(publication), result);
  const move = request(f, { mutationId: 'same', tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 });
  const moved = f.service.moveTab(move);
  f.reopen();
  assert.deepEqual(f.service.moveTab(move), moved);
  assert.equal(f.service.getMembership('T').revision, 2);
  assert.throws(() => f.service.moveTab({ ...move, workflowId: 'a' }), /mutation_id_conflict/);
  assert.throws(() => f.service.detachTab(move), /mutation_id_conflict/);
  assert.equal(f.service.getPublication().generation, 2);
});

test('project-free v2 creation persists all metadata and explicit exact aliases; duplicate/alias-conflict rollback', t => {
  const f = fixture(t); migrate(f);
  const before = legacyManifest(f.db);
  const created = f.service.createTab(request(f, { tabId: 'global-file', workflowId: 'a', record: { type: 'file', unknown: { byte: 'keep' } },
    executionSubject: { version: 2, cwd: f.root, futureExecution: { keep: true } }, aliases: [{ namespace: 'exact-caller', tabId: 'exact-old-tab' }] }));
  assert.equal(created.executionSubject.version, 2);
  assert.equal(Object.hasOwn(created.executionSubject, 'projectId'), false);
  assert.equal(f.db.prepare("SELECT project_id FROM tabs WHERE tab_id='global-file'").get().project_id, null);
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'exact-caller', tabId: 'exact-old-tab' }).tabId, 'global-file');
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'wrong', tabId: 'exact-old-tab' }), null);
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'a', tabId: 'T' }), null);
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'P', tabId: 'T' }).executionSubject.projectId, 'P');
  f.reopen();
  assert.deepEqual(f.service.getTab('global-file').record.unknown, { byte: 'keep' });
  for (const namespace of ['P','Q','K']) assert.deepEqual(f.db.prepare('SELECT * FROM projects WHERE id=?').get(namespace), before.tables.projects.find(row => row.id === namespace));
  for (const row of before.tables.tabs) assert.deepEqual(f.db.prepare('SELECT * FROM tabs WHERE id=?').get(row.id), row);
  const revision = f.service.getPublication().revision;
  assert.throws(() => f.service.createTab(request(f, { tabId: 'other', workflowId: 'a', executionSubject: { version: 2, cwd: f.root },
    aliases: [{ namespace: 'exact-caller', tabId: 'exact-old-tab' }] })), /alias_conflict/);
  assert.equal(f.service.getTab('other'), null);
  assert.equal(f.service.getPublication().revision, revision);
  for (const executionSubject of [{ version: 1, cwd: f.root }, { version: 3, cwd: f.root }, { version: 2, cwd: f.root, projectId: 'P' }]) {
    assert.throws(() => f.service.createTab(request(f, { tabId: 'invalid', workflowId: 'a', executionSubject })), /subject_v2_required/);
  }
});

test('move/detach edit matching placements in every profile while preserving window/chooser/history metadata', t => {
  const f = fixture(t); migrate(f); const before = legacyManifest(f.db);
  f.service.moveTab(request(f, { tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1,
    expectedWorkflowRevision: f.service.getWorkflow('b').revision,
    layout: { splitPanes: [{ windowId: 'new', tabId: 'T', projectId: 'P' }], extension: 'keep' } }));
  const old = f.service.getWorkflow('a').layout;
  assert.equal(layoutReferences(old).some(ref => ref.tabId === 'T'), false);
  assert.equal(old.splitPanes[0].windowId, 'live');
  assert.deepEqual(old.splitPanes[0].tabs, [{ slotId: 'chooser', cwd: '/choose' }]);
  assert.deepEqual(old.splitPanes[0].futureWindow, { opaque: 4 });
  assert.deepEqual(old.splitPanes[0].history, [{ tabId: 'historical-navigation', projectId: 'P' }]);
  f.service.detachTab(request(f, { tabId: 'T', expectedMembershipRevision: 2 }));
  assert.equal(f.service.getMembership('T').workflowId, 'b');
  assert.equal(f.service.getMembership('T').revision, 2,'detach preserves workflow-scope revision');
  assert.equal(layoutReferences(f.service.getWorkflow('b').layout).some(ref => ref.tabId === 'T'), false);
  assert.equal(f.service.getWorkflow('b').layout.extension, 'keep');
  assert.deepEqual(legacyManifest(f.db), before);
});

test('workflow deletion atomically rehomes members, tombstones layout, retains archives/runtime, protects Inbox', t => {
  const f = fixture(t); migrate(f); const before = legacyManifest(f.db);
  const members = f.service.listMembers('a').map(tab => tab.tabId);
  const deleted = f.service.deleteWorkflow(request(f, { workflowId: 'a', expectedWorkflowRevision: f.service.getWorkflow('a').revision }));
  assert.deepEqual(deleted.rehomed, members);
  for (const tabId of members) assert.equal(f.service.getMembership(tabId).workflowId, INBOX_WORKFLOW_ID);
  assert.equal(f.service.getWorkflow('a'), null);
  assert.equal(f.service.getWorkflow('a', { includeDeleted: true }).deletedGeneration, deleted.generation);
  assert.deepEqual(legacyManifest(f.db), before);
  assert.equal(f.service.getMigrationArtifacts('migration').legacy.tables.tab_history.length, 2);
  assert.throws(() => f.service.deleteWorkflow(request(f, { workflowId: INBOX_WORKFLOW_ID, expectedWorkflowRevision: 1 })), /inbox_cannot_delete/);
  assert.throws(() => f.service.createWorkflow(request(f, { workflow: { id: 'a', name: 'Reuse deleted identity' } })), /id_exists/);
  f.reopen();
  assert.equal(f.service.getWorkflow(INBOX_WORKFLOW_ID).kind, 'inbox');
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('global/member/layout CAS refuses stale whole saves and cannot change membership through layout', t => {
  const f = fixture(t); migrate(f);
  const staleRevision = f.service.getPublication().revision;
  const oldLayout = clone(f.service.getWorkflow('a'));
  f.service.moveTab(request(f, { tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 }));
  assert.throws(() => f.service.saveLayout({ mutationId: 'late', expectedRevision: staleRevision,
    workflowId: 'a', expectedWorkflowRevision: oldLayout.revision, layout: oldLayout.layout }), /revision_changed/);
  assert.throws(() => f.service.saveLayout(request(f, { workflowId: 'a', expectedWorkflowRevision: f.service.getWorkflow('a').revision,
    layout: oldLayout.layout })), /membership_conflict/);
  assert.throws(() => f.service.detachTab(request(f, { tabId: 'T', expectedMembershipRevision: 1 })), /membership_revision_changed/);
  f.service.createWorkflow(request(f, { workflow: { id: 'new', name: 'New', future: { keep: true } } }));
  assert.equal(f.service.getWorkflow('new').metadata.future.keep, true);
});

test('future layout/schema versions refuse writes; omitted unknown metadata survives known-field saves', t => {
  const f = fixture(t); migrate(f);
  const initial = f.service.getWorkflow('a');
  const next = { splitPanes: initial.layout.splitPanes.map(pane => ({ windowId: pane.windowId, projectId: pane.projectId, tabId: pane.tabId,
    ...(pane.tabs ? { tabs: pane.tabs } : {}) })) };
  f.service.saveLayout(request(f, { workflowId: 'a', expectedWorkflowRevision: initial.revision, layout: next }));
  assert.deepEqual(f.service.getWorkflow('a').layout.splitPanes[0].futureWindow, { opaque: 4 });
  assert.equal(f.service.getWorkflow('a').layout.futureLayout.keep, true);
  assert.deepEqual(mergeLayout({ future: 9, splitPanes: [{ windowId: 'w', extension: 2 }] }, { splitPanes: [{ windowId: 'w' }] }),
    { future: 9, splitPanes: [{ windowId: 'w', extension: 2 }] });
  for (const layout of [{ version: 2 }, { windowDisplayLayouts: { future: { version: 2 } } }]) {
    assert.throws(() => f.service.saveLayout(request(f, { workflowId: 'a', expectedWorkflowRevision: f.service.getWorkflow('a').revision, layout })), /forward_version/);
  }
  const before = f.service.getPublication();
  f.db.prepare('UPDATE workflow_org_meta SET schema_version=9,metadata_json=?').run('{"future":true}');
  f.reopen();
  assert.equal(f.service.getPublication().version, 9);
  assert.deepEqual(f.service.getPublication().metadata, { future: true });
  assert.throws(() => f.service.detachTab({ mutationId: 'forward', expectedRevision: before.revision, tabId: 'T', expectedMembershipRevision: 1 }), /forward_version/);
  assert.equal(f.service.getPublication().revision, before.revision);
});

for (const provider of ['claude', 'codex']) test(provider + ': actual DB/ConversationOwners checkpoint scope/token/epoch survives move/detach/delete/reopen', t => {
  const f = fixture(t);
  if (provider === 'claude') f.db.prepare("UPDATE tabs SET command_type='claude',claude_session_id='sid-T' WHERE tab_id='T'").run();
  let launch = { instanceId: 'main-fixture', terminalId: 'terminal-fixture', launchId: 'launch-fixture', runSeq: 4 };
  const capture = tabId => {
    const row = f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(tabId);
    return { known: true, provider, sessionId: provider === 'claude' ? row.claude_session_id : row.codex_session_id,
      projectId: row.project_id, cwd: row.cwd, ...launch };
  };
  let owners = new ConversationOwners({ db: f.manager, capture, instanceId: 'main-fixture' });
  const operation = { operationId: 'O', revision: 11, toolType: provider, bindingCommitted: true };
  f.db.transaction(() => { operation.ownerCheckpoint = owners.checkpoint('T', operation, capture('T')); })();
  const ownerBytes = f.db.prepare("SELECT value FROM app_state WHERE key='conversation-owner.v1:T'").get().value;
  const receiptBytes = JSON.stringify(operation);
  migrate(f);
  f.service.moveTab(request(f, { tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 }));
  f.service.detachTab(request(f, { tabId: 'T', expectedMembershipRevision: 2 }));
  f.service.deleteWorkflow(request(f, { workflowId: 'b', expectedWorkflowRevision: f.service.getWorkflow('b').revision }));
  assert.equal(owners.applicability('T', operation).applicability.verdict, 'applicable');
  assert.equal(f.db.prepare("SELECT value FROM app_state WHERE key='conversation-owner.v1:T'").get().value, ownerBytes);
  assert.equal(JSON.stringify(operation), receiptBytes);
  f.reopen();
  owners = new ConversationOwners({ db: f.manager, capture, instanceId: 'main-fixture' });
  assert.equal(owners.applicability('T', operation).applicability.verdict, 'applicable');
  assert.equal(f.db.prepare("SELECT value FROM app_state WHERE key='conversation-owner.v1:T'").get().value, ownerBytes);
  // The pre-existing v1 identity guard is still active for a real cwd change.
  f.manager.updateTabCwd('T', f.root + '/changed');
  assert.equal(owners.applicability('T', operation).applicability.verdict, 'superseded');
  const operation2 = { operationId: 'O2', revision: 12, toolType: provider, bindingCommitted: true };
  operation2.ownerCheckpoint = owners.checkpoint('T', operation2, capture('T'));
  launch = { ...launch, launchId: 'foreign-launch' };
  assert.equal(owners.applicability('T', operation2).applicability.verdict, 'superseded');
});

test('actual legacy whole-state/tab writers on a second native connection cannot overwrite canonical organization', t => {
  const f = fixture(t, { extensions: false }); migrate(f);
  const oldLayout = clone(f.workspace);
  f.service.moveTab(request(f, { tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 }));
  const before = f.service.getPublication();
  const result = child(`
    const Database=require('better-sqlite3'), Manager=require('./src/main/database');
    const db=new Database(process.env.WORKFLOW_FIXTURE); db.pragma('foreign_keys=ON');
    const m=new Manager({existingConnection:db});
    const old=m.getAppState('workspace-session'); old.splitPanes=[{projectId:'P',tabId:'T'}];
    m.setAppState('workspace-session',old);
    const tabs=m.getProjectById('P').tabs; m.saveTabs('P',tabs,true);
    m.close();
  `, f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  f.reopen();
  assert.deepEqual(f.service.getPublication(), before);
  assert.equal(f.service.getMembership('T').workflowId, 'b');
  assert.equal(layoutReferences(f.service.getWorkflow('a').layout).some(ref => ref.tabId === 'T'), false);
  assert.notDeepEqual(f.manager.getAppState('workspace-session'), oldLayout);
});

for (const boundary of ['beforePublicationMarker', 'afterCommit']) test('native process exit at ' + boundary + ' proves atomic migration recovery/same-ID retry', t => {
  const f = fixture(t);
  const stage = f.service.prepareMigration({ migrationId: 'M', expectedRevision: 0 });
  const publication = { mutationId: 'P', expectedRevision: 0, migrationId: 'M', sourceFingerprint: stage.sourceFingerprint };
  const result = child(`
    const Database=require('better-sqlite3'), Manager=require('./src/main/database');
    const {WorkflowOrganization}=require('./src/main/workflow-organization');
    const db=new Database(process.env.WORKFLOW_FIXTURE); db.pragma('foreign_keys=ON');
    const manager=new Manager({existingConnection:db});
    let service; service=new WorkflowOrganization({database:manager,
      captureSource:()=>{const source=service.getPreparedMigration('M').source;
        return {sourceRevisions:source.sourceRevisions,artifacts:source.artifacts};},
      fault:point=>{if(point===${JSON.stringify(boundary)}) process.exit(73);}});
    service.publishMigration(${JSON.stringify(publication)});
  `, f);
  assert.equal(result.status, 73, result.stderr + result.stdout);
  f.reopen();
  if (boundary === 'beforePublicationMarker') {
    assert.equal(f.service.getPublication().generation, 0);
    assert.equal(f.service.listGlobalTabs().length, 0);
    assert.equal(f.service.getPreparedMigration('M').publishedGeneration, null);
  } else {
    assert.equal(f.service.getPublication().generation, 1);
    assert.equal(f.service.getMembership('T').workflowId, 'a');
  }
  const completed = f.service.publishMigration(publication);
  assert.equal(completed.generation, 1);
  assert.equal(f.service.getPublication().generation, 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('injected membership/layout/publication failure rolls back all tables and never publishes', t => {
  const f = fixture(t); migrate(f);
  const before = f.service.readState();
  let announcements = 0;
  f.service.publish = () => { announcements++; };
  f.service.fault = point => { if (point === 'beforePublicationMarker') throw Error('injected-crash'); };
  const move = request(f, { mutationId: 'failure-retry', tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 });
  assert.throws(() => f.service.moveTab(move), /injected-crash/);
  assert.deepEqual(f.service.readState(), before);
  assert.equal(announcements, 0);
  assert.equal(f.db.prepare("SELECT 1 FROM workflow_org_mutations WHERE mutation_id='failure-retry'").get(), undefined);
  f.service.fault = () => {};
  f.service.moveTab(move);
  assert.equal(announcements, 1);
  assert.equal(f.service.getMembership('T').workflowId, 'b');
});

test('address-scoped group/root/archive/policy artifacts remain exact; no unplaced-to-Inbox or root union', t => {
  const f = fixture(t); const { stage } = migrate(f);
  const artifacts = f.service.getMigrationArtifacts('migration');
  assert.deepEqual(artifacts.extra, f.artifacts);
  assert.deepEqual(artifacts.legacy, stage.source.legacy);
  assert.deepEqual(artifacts.extra.initialEligibility, { __unplaced__: ['N'] });
  assert.equal(artifacts.legacy.tables.project_prompt_sources.length, 2);
  assert.equal(artifacts.legacy.tables.projects.find(row => row.id === 'P').tab_groups,
    JSON.stringify([{ id: 'group', name: 'P', future: { keep: true } }]));
  assert.ok(artifacts.integrationRequired.length > 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n, 3, 'no Everything/Inbox project created');
  f.service.moveTab(request(f, { tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 }));
  const inputs = f.service.getOrganizationAdapterInputs('migration');
  const namespace = inputs.namespaces.find(item => item.namespace === 'P');
  assert.equal(namespace.members.find(member => member.tabId === 'T').membership.workflowId, 'b');
  assert.equal(namespace.members.find(member => member.tabId === 'W').membership.workflowId, 'a');
  assert.equal(namespace.groupsRaw, artifacts.legacy.tables.projects.find(row => row.id === 'P').tab_groups);
  assert.deepEqual(namespace.promptSources, artifacts.legacy.tables.project_prompt_sources.filter(row => row.project_id === 'P'));
  assert.deepEqual(namespace.archive, artifacts.legacy.tables.tab_history.filter(row => row.project_id === 'P'));
});

test('pre-spaces session keeps its actual single layout; invalid/forward workspace refuses migration', () => {
  const source = { legacy: { tables: { tabs: [{ tab_id: 'T', project_id: 'P', cwd: '/P' }] } },
    workspace: { splitPanes: [{ tabId: 'T', projectId: 'P', windowId: 'old' }], futureSession: 9 } };
  const migrated = planMigration(source);
  assert.equal(migrated.memberships[0].workflowId, 'space-1');
  assert.deepEqual(migrated.workflows[0].layout.splitPanes, source.workspace.splitPanes);
  assert.equal(migrated.artifacts.workspace.futureSession, 9);
  assert.throws(() => planMigration({ ...source, workspace: 'corrupt' }), /workspace_required/);
  assert.throws(() => planMigration({ ...source, workspace: { version: 9 } }), /forward_version/);
});

for (const action of ['moveTab', 'deleteWorkflow']) for (const boundary of ['beforePublicationMarker', 'afterCommit']) {
  test('native crash/retry for ' + action + ' at ' + boundary + ' keeps one coherent generation', t => {
    const f = fixture(t); migrate(f);
    const before = f.service.readState();
    const legacy = legacyManifest(f.db);
    const mutation = action === 'moveTab'
      ? { mutationId: 'crash-action', expectedRevision: 1, tabId: 'T', workflowId: 'b', expectedMembershipRevision: 1 }
      : { mutationId: 'crash-action', expectedRevision: 1, workflowId: 'a', expectedWorkflowRevision: 1 };
    const result = child(`
      const Database=require('better-sqlite3'), Manager=require('./src/main/database');
      const {WorkflowOrganization}=require('./src/main/workflow-organization');
      const db=new Database(process.env.WORKFLOW_FIXTURE); db.pragma('foreign_keys=ON');
      const service=new WorkflowOrganization({database:new Manager({existingConnection:db}),
        fault:point=>{if(point===${JSON.stringify(boundary)}) process.exit(74);}});
      service[${JSON.stringify(action)}](${JSON.stringify(mutation)});
    `, f);
    assert.equal(result.status, 74, result.stderr + result.stdout);
    f.reopen();
    if (boundary === 'beforePublicationMarker') assert.deepEqual(f.service.readState(), before);
    else assert.equal(f.service.getPublication().generation, 2);
    const completed = f.service[action](mutation);
    assert.equal(completed.generation, 2);
    assert.deepEqual(f.service[action](mutation), completed);
    assert.equal(f.service.getMembership('T').workflowId, action === 'moveTab' ? 'b' : INBOX_WORKFLOW_ID);
    assert.deepEqual(legacyManifest(f.db), legacy);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  });
}

test('two actual connections cannot apply competing moves from the same global revision', t => {
  const f = fixture(t); migrate(f);
  const stale = { mutationId: 'second-writer', expectedRevision: 1, tabId: 'T', workflowId: INBOX_WORKFLOW_ID, expectedMembershipRevision: 1 };
  const result = child(`
    const Database=require('better-sqlite3'), Manager=require('./src/main/database');
    const {WorkflowOrganization}=require('./src/main/workflow-organization');
    const db=new Database(process.env.WORKFLOW_FIXTURE); db.pragma('foreign_keys=ON');
    const service=new WorkflowOrganization({database:new Manager({existingConnection:db})});
    service.moveTab({mutationId:'first-writer',expectedRevision:1,tabId:'T',workflowId:'b',expectedMembershipRevision:1});
    db.close();
  `, f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.throws(() => f.service.moveTab(stale), /revision_changed/);
  assert.equal(f.service.getMembership('T').workflowId, 'b');
  assert.equal(f.service.getPublication().generation, 2);
});

test('private native Electron runs the actual DatabaseManager constructor without mocked app/globals', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-constructor-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const runner = path.join(root, 'runner.cjs');
  fs.writeFileSync(runner, `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const {app}=require('electron');
    const userData=path.join(${JSON.stringify(root)},'userdata'); fs.mkdirSync(userData);
    app.setPath('userData',userData); app.disableHardwareAcceleration();
    app.whenReady().then(()=>{
      const Manager=require(${JSON.stringify(path.join(__dirname, 'database.js'))});
      const {WorkflowOrganization,INBOX_WORKFLOW_ID}=require(${JSON.stringify(path.join(__dirname, 'workflow-organization.js'))});
      let manager=new Manager(); manager.db.pragma('foreign_keys=ON');
      const service=new WorkflowOrganization({database:manager});
      const legacyBefore=manager.db.prepare('SELECT * FROM projects').all();
      const stage=service.prepareMigration({migrationId:'private-constructor',expectedRevision:0});
      service.publishMigration({mutationId:'private-publication',migrationId:stage.migrationId,
        expectedRevision:0,sourceFingerprint:stage.sourceFingerprint});
      service.createTab({mutationId:'private-new-tab',expectedRevision:1,tabId:'independent',workflowId:INBOX_WORKFLOW_ID,
        executionSubject:{version:2,cwd:userData},record:{name:'Private'}});
      assert.deepEqual(manager.db.prepare('SELECT * FROM projects').all(),legacyBefore);
      assert.equal(manager.db.prepare("SELECT project_id FROM tabs WHERE tab_id='independent'").get().project_id,null);
      assert.deepEqual(manager.db.pragma('foreign_key_check'),[]);
      const physical=manager.db.prepare("SELECT * FROM tabs WHERE tab_id='independent'").get();
      manager.close(); manager=new Manager(); manager.db.pragma('foreign_keys=ON');
      assert.deepEqual(manager.db.prepare("SELECT * FROM tabs WHERE tab_id='independent'").get(),physical);
      const reopened=new WorkflowOrganization({database:manager});
      assert.equal(reopened.getPublication().generation,2);
      assert.equal(reopened.getTab('independent').executionSubject.subjectId,physical.execution_subject_id);
      assert.deepEqual(manager.db.pragma('foreign_key_check'),[]);
      manager.close(); console.log('PRIVATE_CONSTRUCTOR_OK'); app.quit();
    }).catch(error=>{console.error(error);app.exit(1);});
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.execPath, [runner], { env, cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PRIVATE_CONSTRUCTOR_OK/);
});

test('real v2 DB row/save/session/favorite/archive/restore/scopes reopen without a Project or execution rekey', t => {
  const f = fixture(t); migrate(f);
  const projectCount = f.db.prepare('SELECT count(*) n FROM projects').get().n;
  const created = f.service.createTab(request(f, { tabId: 'native-v2', workflowId: 'a',
    executionSubject: { version: 2, cwd: f.root }, record: { name: 'V2', notes: 'original note', groupId: 'partial-group',
      codexSessionId: 'native-writer', providerState: { future: 9 }, extra: { opaque: true } }, aliases: [{ namespace: 'P', tabId: 'native-v2' }] }));
  const address = { executionNamespace: created.executionSubject.executionNamespace, tabId: created.tabId, subjectId: created.executionSubject.subjectId };
  assert.equal(address.executionNamespace, GLOBAL_EXECUTION_NAMESPACE);
  let stored = f.manager.getExecutionTabV2(address);
  const storageId = stored.row.id;
  assert.equal(stored.row.project_id, null);
  assert.equal(stored.row.codex_session_id, 'native-writer');
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'P', tabId: 'native-v2' }).executionSubject.executionNamespace, GLOBAL_EXECUTION_NAMESPACE);
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'a', tabId: 'native-v2' }), null);
  stored = f.manager.saveExecutionTabV2({ ...address, expectedRevision: stored.revision,
    columns: { future_blob: Buffer.from([0,255,3]), future_column: 'v2 extension', external_run: '{"frozen":true}' } });
  const oldRevision = stored.revision;
  f.manager.saveExecutionTabs(address.executionNamespace, [{ ...stored.tab, name: 'Renamed', notes: 'durable note', codexSessionId: 'STALE SID', extra: { opaque: 7 } }]);
  stored = f.manager.getExecutionTabV2(address);
  assert.equal(stored.row.id, storageId);
  assert.equal(stored.row.codex_session_id, 'native-writer', 'renderer save never owns writer SID');
  assert.equal(stored.row.notes, 'durable note');
  assert.deepEqual(stored.row.future_blob, Buffer.from([0,255,3]));
  assert.equal(stored.tab.extra.opaque, 7);
  assert.equal(f.manager.getProjectById(address.executionNamespace).tabs[0].executionSubject.subjectId, address.subjectId);
  assert.equal(f.manager.getProjectById(address.executionNamespace).path, null);
  f.manager.saveTabs(address.executionNamespace,[stored.tab]);
  stored = f.manager.getExecutionTabV2(address);
  assert.throws(() => f.manager.saveExecutionTabV2({ ...address, expectedRevision: oldRevision, columns: { name: 'late' } }), /revision_changed/);
  assert.equal(f.manager.getExecutionTabV2({ ...address, executionNamespace: 'a' }), null);
  assert.throws(() => f.db.prepare('UPDATE tabs SET execution_namespace=? WHERE tab_id=?').run('a',address.tabId), /subject_immutable/);
  assert.throws(() => f.db.prepare('UPDATE tabs SET execution_subject_version=2 WHERE tab_id=?').run('T'), /subject_immutable/);
  let scope = f.manager.getExecutionNamespace(address.executionNamespace);
  scope = f.manager.saveExecutionNamespace({ executionNamespace: address.executionNamespace, expectedRevision: scope.revision,
    metadata: { unknown: 4 }, groups: [{ id: 'partial-group', members: ['native-v2','T'], order: 6, extra: 'keep' }],
    roots: [{ path: '/root-one', selected: false, future: 2 }, { path: '/root-two', selected: true }], notes: 'scope notes' });
  const favorite = f.manager.saveExecutionArtifactV2({ mutationId: 'favorite-v2', ...address, expectedRevision: stored.revision, kind: 'favorite', workflowContext: { workflowId: 'a', generation: 2 } });
  const session = f.manager.saveExecutionArtifactV2({ mutationId: 'session-v2', ...address, expectedRevision: stored.revision, kind: 'session',
    columns: { tool_type: 'claude', session_key: 'export-SID', content_blob: 'opaque-export', original_cwd: f.root } });
  assert.throws(() => f.manager.saveExecutionArtifactV2({ mutationId: 'favorite-v2', ...address, expectedRevision: stored.revision, kind: 'session', workflowContext: { workflowId: 'a', generation: 2 } }), /mutation_id_conflict/);
  const archiveRequest = { mutationId: 'archive-v2', ...address, expectedRevision: stored.revision, workflowContext: { workflowId: 'a', generation: 2, future: 3 } };
  const archived = f.manager.archiveExecutionTabV2(archiveRequest);
  assert.deepEqual(f.manager.archiveExecutionTabV2(archiveRequest), archived);
  assert.throws(() => f.manager.archiveExecutionTabV2({ ...archiveRequest, workflowContext: { workflowId: 'b' } }), /mutation_id_conflict/);
  assert.equal(f.manager.getExecutionNamespace(address.executionNamespace).tabs.length, 0);
  const archiveRow = f.manager.getExecutionArchive(address.executionNamespace)[0];
  assert.equal(archiveRow.execution_subject_id, address.subjectId);
  assert.equal(archiveRow.project_id, null);
  assert.deepEqual(JSON.parse(archiveRow.workflow_context_json), archiveRequest.workflowContext);
  f.service.moveTab(request(f, { tabId: address.tabId, workflowId: 'b', expectedMembershipRevision: 1 }));
  assert.deepEqual(JSON.parse(f.manager.getExecutionArchive(address.executionNamespace)[0].workflow_context_json), archiveRequest.workflowContext);
  f.reopen();
  assert.deepEqual(f.manager.getExecutionNamespace(address.executionNamespace).groups, scope.groups);
  assert.deepEqual(f.manager.getExecutionNamespace(address.executionNamespace).roots, scope.roots);
  assert.equal(f.manager.getExecutionNamespace(address.executionNamespace).notes, 'scope notes');
  assert.equal(f.manager.getExecutionArtifacts(address.executionNamespace,'favorite')[0].id, favorite.id);
  assert.equal(f.manager.getExecutionArtifacts(address.executionNamespace,'session')[0].id, session.id);
  assert.equal(f.manager.getExecutionArtifacts(address.executionNamespace,'session')[0].content_blob, 'opaque-export');
  stored = f.manager.getExecutionTabV2(address);
  const restored = f.manager.restoreExecutionTabV2({ mutationId: 'restore-v2', ...address, archiveId: archived.archiveId, expectedRevision: stored.revision });
  assert.equal(restored.storageId, storageId);
  assert.equal(f.manager.getExecutionTabV2(address).row.codex_session_id, 'native-writer');
  assert.equal(f.manager.getExecutionTabV2(address).row.notes, 'durable note');
  assert.deepEqual(f.manager.getExecutionTabV2(address).row.future_blob, Buffer.from([0,255,3]));
  assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n, projectCount);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('legacy namespace containing v1/v2 tabs returns and saves the exact mixed bucket without a v2 FK/reinsert', t => {
  const f = fixture(t,{extensions:false}); migrate(f);
  f.service.createTab(request(f,{tabId:'mixed-v2',workflowId:'b',executionSubject:{version:2,cwd:f.root,executionNamespace:'P'},record:{name:'Mixed',codexSessionId:'mixed-writer'}}));
  let bucket = f.manager.getProjectById('P');
  const independent = bucket.tabs.find(tab=>tab.tabId==='mixed-v2');
  assert.equal(independent.executionSubject.executionNamespace,'P');
  const storageId=f.db.prepare("SELECT id FROM tabs WHERE tab_id='mixed-v2'").get().id;
  assert.deepEqual(f.manager.saveTabs('P',bucket.tabs,true),{success:true});
  assert.equal(f.db.prepare("SELECT id FROM tabs WHERE tab_id='mixed-v2'").get().id,storageId);
  assert.equal(f.db.prepare("SELECT project_id FROM tabs WHERE tab_id='mixed-v2'").get().project_id,null);
  bucket=f.manager.getProjectById('P');
  assert.equal(bucket.tabs.find(tab=>tab.tabId==='mixed-v2').codexSessionId,'mixed-writer');
  assert.equal(f.service.getMembership('mixed-v2').workflowId,'b');
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});

test('v2 shared execution comparator uses subjectId+real cwd, keeps v1 project guard and excludes organization/namespace', () => {
  const row = { tab_id: 'T', execution_subject_version: 2, execution_subject_id: 'S', execution_namespace: 'P', project_id: null, cwd: '/real' };
  const original = executionScopeForRow(row);
  assert.equal(sameExecutionScope(original, { ...original, workflowId: 'other', executionNamespace: 'different presentation hint' }), true);
  assert.equal(sameExecutionScope(original, { ...original, subjectId: 'foreign' }), false);
  assert.equal(sameExecutionScope(original, { ...original, cwd: '/other' }), false);
  const legacy = executionScopeForRow({ tab_id: 'old', project_id: 'P', cwd: '/real' });
  assert.equal(sameExecutionScope(legacy, { ...legacy, projectId: 'Q' }), false);
  assert.equal(sameExecutionScope(legacy, { ...legacy, workflowId: 'Q' }), true);
});

test('commitWorkspace publishes metadata/order/new spaces/member moves/profile pruning/deletes in one generation', t => {
  const f = fixture(t); migrate(f);
  const before = legacyManifest(f.db);
  const membership = Object.fromEntries(f.service.listGlobalTabs().map(tab => [tab.tabId, tab.membership.workflowId]));
  membership.T = 'new';
  const snapshot = request(f, { mutationId: 'workspace-snapshot', spaces: [
    { id: 'new', kind: 'user', name: 'New', icon: null, future: { keep: 3 }, layout: { splitPanes: [{ tabId: 'T', projectId: 'P', windowId: 'new-window' }] } },
    { id: 'a', kind: 'user', name: 'Renamed', layout: f.service.getWorkflow('a').layout },
  ], tabWorkflowMembership: membership });
  const result = f.service.commitWorkspace(snapshot);
  assert.equal(result.generation, 2);
  assert.deepEqual(result.workflowOrder, ['new','a',INBOX_WORKFLOW_ID]);
  assert.deepEqual(f.service.listWorkflows().map(workflow => workflow.id), result.workflowOrder);
  assert.equal(f.service.getMembership('T').workflowId, 'new');
  assert.equal(f.service.getMembership('Y').workflowId, INBOX_WORKFLOW_ID);
  assert.equal(f.service.getWorkflow('b'), null);
  assert.equal(f.service.getWorkflow('a').metadata.futureSpace, 9);
  assert.equal(Object.hasOwn(f.service.getWorkflow('a').metadata,'layout'),false,'there is one authoritative layout');
  assert.equal(f.service.getWorkflow('new').metadata.future.keep, 3);
  assert.equal(Object.hasOwn(f.service.getWorkflow('new').metadata,'layout'),false);
  assert.equal(layoutReferences(f.service.getWorkflow('a').layout).some(ref => ref.tabId === 'T'), false);
  assert.deepEqual(legacyManifest(f.db), before);
  f.reopen();
  assert.deepEqual(f.service.commitWorkspace(snapshot), result);
  assert.throws(() => f.service.commitWorkspace({ ...snapshot, spaces: [] }), /mutation_id_conflict/);
  assert.throws(() => f.service.commitWorkspace(request(f, { spaces: [], tabWorkflowMembership: {} })), /incomplete_membership_snapshot/);
  assert.equal(f.service.getWorkflow(INBOX_WORKFLOW_ID).kind, 'inbox');
});

test('v2 restore from immutable archive reconstructs original PK/blob/future columns when physical row is absent', t => {
  const f=fixture(t);migrate(f);
  const created=f.service.createTab(request(f,{tabId:'restore-missing-v2',workflowId:'a',executionSubject:{version:2,cwd:f.root},record:{name:'Snapshot',notes:'Keep',codexSessionId:'SID'}}));
  const address={executionNamespace:created.executionSubject.executionNamespace,tabId:created.tabId,subjectId:created.executionSubject.subjectId};
  let stored=f.manager.getExecutionTabV2(address);
  stored=f.manager.saveExecutionTabV2({...address,expectedRevision:stored.revision,columns:{future_blob:Buffer.from([255,0,42]),future_column:'snapshot-extension'}});
  const archived=f.manager.archiveExecutionTabV2({mutationId:'archive-missing',...address,expectedRevision:stored.revision,workflowContext:{workflowId:'a'}});
  f.db.prepare('DELETE FROM tabs WHERE id=?').run(stored.row.id);
  f.reopen();
  f.manager.restoreExecutionTabV2({mutationId:'restore-missing',...address,archiveId:archived.archiveId,expectedRevision:archived.archivedRevision});
  const restored=f.manager.getExecutionTabV2(address);
  assert.equal(restored.row.id,stored.row.id);
  assert.equal(restored.row.codex_session_id,'SID');
  assert.equal(restored.row.future_column,'snapshot-extension');
  assert.equal(restored.row.future_derived,'Snapshot!');
  assert.deepEqual(restored.row.future_blob,Buffer.from([255,0,42]));
  assert.equal(f.service.getTab(address.tabId).executionResolved,true);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});

test('coherent caller workspace overrides stale workspace-session during bootstrap without merging stale profiles', t => {
  const f=fixture(t);
  const coherent={spaces:[{id:'fresh',name:'Fresh',layout:{}}],activeSpaceId:'fresh',splitPanes:[{windowId:'fresh-window',tabId:'T',projectId:'P'}],windowDisplayLayouts:{},centerStrips:{}};
  f.service.captureSource=()=>({workspace:coherent,sourceRevisions:{renderer:99}});
  migrate(f);
  assert.equal(f.service.getMembership('T').workflowId,'fresh');
  assert.equal(f.service.getMembership('H').workflowId,INBOX_WORKFLOW_ID);
  assert.equal(f.service.getWorkflow('a'),null);
  assert.deepEqual(f.service.getWorkflow('fresh').layout.windowDisplayLayouts,{});
});

test('registerLegacyTab requires exact real source, preserves native row and aliases, never projects workflow identity', t => {
  const f = fixture(t); migrate(f);
  f.db.prepare('INSERT INTO tabs(project_id,name,cwd,tab_id) VALUES(?,?,?,?)').run('P','Created by old caller',f.root,'late-v1');
  const before = f.db.prepare("SELECT * FROM tabs WHERE tab_id='late-v1'").get();
  assert.throws(() => f.service.registerLegacyTab(request(f, { legacyNamespace: 'a', tabId: 'late-v1' })), /exact_legacy_tab_missing/);
  const registration = request(f, { mutationId: 'register-v1', legacyNamespace: 'P', tabId: 'late-v1', workflowId: 'b' });
  f.service.registerLegacyTab(registration);
  assert.equal(f.service.getMembership('late-v1').workflowId, 'b');
  assert.equal(f.service.resolveLegacyAlias({ namespace: 'P', tabId: 'late-v1' }).tabId, 'late-v1');
  assert.deepEqual(f.db.prepare("SELECT * FROM tabs WHERE tab_id='late-v1'").get(), before);
  f.reopen();
  assert.equal(f.service.registerLegacyTab(registration).registered, true);
});

test('activateArtifacts receives exact plan/generation inside migration transaction and rolls back on failure', t => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE private_root_activation(generation INTEGER,payload TEXT)');
  const stage = f.service.prepareMigration({ migrationId: 'activation', expectedRevision: 0 });
  let calls = 0;
  f.service.activateArtifacts = (plan, generation) => {
    assert.equal(f.db.inTransaction,true); assert.equal(f.service.getPublication().generation,0);
    assert.deepEqual(plan.artifacts.extra, f.artifacts); calls++;
    f.db.prepare('INSERT INTO private_root_activation VALUES(?,?)').run(generation, JSON.stringify(plan.artifacts));
    if (calls === 1) throw Error('activation-failure');
  };
  const publication = { mutationId: 'activation-publication', expectedRevision: 0, migrationId: 'activation', sourceFingerprint: stage.sourceFingerprint };
  assert.throws(() => f.service.publishMigration(publication), /activation-failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM private_root_activation').get().n,0);
  assert.equal(f.service.getPublication().generation,0);
  f.service.publishMigration(publication);
  assert.equal(f.db.prepare('SELECT generation FROM private_root_activation').get().generation,1);
  f.service.publishMigration(publication);
  assert.equal(calls,2,'same committed ID does not activate twice');
});

for (const boundary of ['afterTableCopy', 'beforeExecutionSchemaCommit']) test('native crash during nullable execution DDL at ' + boundary + ' reopens intact and retries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'noted-workflow-schema-'));
  const filename = path.join(root,'fixture.db');
  let db = new Database(filename); db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
  let manager = new DatabaseManager({ existingConnection: db }); manager.initTables();
  db.exec("INSERT INTO projects(id,path,name) VALUES('P','/fixture','P'); INSERT INTO tabs(project_id,name,cwd,tab_id) VALUES('P','T','/fixture','T'); CREATE TABLE inbound(id INTEGER REFERENCES tabs(id) ON DELETE CASCADE,payload BLOB); INSERT INTO inbound SELECT id,x'00ff' FROM tabs;");
  const before = legacyManifest(db);
  t.after(() => { if(db.open)db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const result = child(`const Database=require('better-sqlite3'),Manager=require('./src/main/database');
    const db=new Database(process.env.WORKFLOW_FIXTURE);db.pragma('foreign_keys=ON');
    new Manager({existingConnection:db}).ensureWorkflowExecutionStorage({fault:point=>{if(point===${JSON.stringify(boundary)})process.exit(75);}});`, { filename });
  assert.equal(result.status,75,result.stderr+result.stdout);
  db.close(); db=new Database(filename);db.pragma('foreign_keys=ON'); manager=new DatabaseManager({existingConnection:db});
  assert.deepEqual(legacyManifest(db),before);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  manager.ensureWorkflowExecutionStorage();
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  assert.deepEqual(db.prepare('SELECT * FROM inbound').all(),before.tables.inbound);
  assert.equal(db.prepare("SELECT tab_id FROM tabs").get().tab_id,'T');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('actual parent API delivers committed membership/workflow snapshots and exact receipts over registered adapter handlers', async t => {
  // Actual API/root/policy modules against native SQLite. Handler collection is
  // an IPC adapter fixture, not a claim of complete Main/renderer startup.
  const { createWorkflowOrganizationApi, registerWorkflowOrganizationIpc } = require('./workflow-organization-api');
  const f = fixture(t, { extensions: false });
  f.manager.setAppState('globalAutoCompact', { enabled: true, allWorkflows: true, includeUnplaced: false,
    workflowIds: [], excludedTabIds: [], unknown: { preserved: true } });
  const legacy = Object.fromEntries(['projects','tabs','tab_history','favorites','project_prompt_sources','quick_actions']
    .map(table => [table,f.db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()]));
  const receipts = [];
  const api = createWorkflowOrganizationApi({ database: f.manager, publish: receipt => {
    assert.equal(f.db.inTransaction,false);
    receipts.push(clone(receipt));
  } });
  const handlers = new Map();
  registerWorkflowOrganizationIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, api);
  const invoke = async (channel, payload) => handlers.get(channel)({},payload);
  const boot = await invoke('workflow:bootstrap', { migrationId:'api-bootstrap',mutationId:'api-activate',
    workspace:f.workspace,sourceRevisions:{renderer:17} });
  assert.equal(boot.publication.generation,1);
  assert.equal(boot.publication.migrationVersion,1);
  assert.equal(f.manager.getAppState('globalAutoCompact').organizationVersion,1);
  assert.deepEqual(f.manager.getAppState('globalAutoCompact').unknown,{preserved:true});
  assert.equal(f.manager.getAppState('workflow-organization-migration-scopes.v1').generation,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM workflow_root_bindings WHERE scope='prompts:P'").get().n,1);
  for (const [table,rows] of Object.entries(legacy)) assert.deepEqual(f.db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all(),rows);
  const membership = Object.fromEntries(boot.tabs.map(tab => [tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]));
  membership.T = {...membership.T,workflowId:'b'};
  const mutation = { mutationId:'api-snapshot',expectedRevision:boot.publication.revision,
    spaces:boot.workflows.map(workflow => ({...workflow.metadata,id:workflow.id,kind:workflow.kind,layout:workflow.layout})),
    tabWorkflowMembership:membership };
  const committed = await invoke('workflow:mutate',{kind:'commitWorkspace',request:mutation});
  assert.equal(committed.generation,2);
  // The same receipt is the addressed recovery path after an unknown ACK;
  // membership revisions come from the queued canonical read, not from guesses.
  assert.deepEqual(await invoke('workflow:mutation',mutation.mutationId),committed);
  assert.deepEqual(await invoke('workflow:mutate',{kind:'commitWorkspace',request:mutation}),committed);
  assert.equal(receipts.length,2,'retry never publishes a second generation');
  const read = await invoke('workflow:read');
  assert.equal(read.publication.generation,committed.generation);
  assert.equal(read.publication.revision,committed.revision);
  assert.deepEqual(read.tabs.find(tab=>tab.tabId==='T').membership,{tabId:'T',workflowId:'b',revision:2});
  assert.equal(read.workflows.some(workflow=>workflow.id===INBOX_WORKFLOW_ID && workflow.kind==='inbox'),true);
  assert.equal(layoutReferences(read.workflows.find(workflow=>workflow.id==='a').layout).some(ref=>ref.tabId==='T'),false);
  assert.equal(read.tabs.find(tab=>tab.tabId==='T').executionSubject.projectId,'P');
  const create = { mutationId:'api-create',expectedRevision:read.publication.revision,tabId:'api-v2',subjectId:'api-subject',
    workflowId:'b',executionNamespace:GLOBAL_EXECUTION_NAMESPACE,cwd:f.root,record:{name:'API Native',notes:'Keep'} };
  const created = await invoke('workflow:create-tab',create);
  assert.deepEqual(await invoke('workflow:create-tab',create),created);
  assert.equal(api.execution('api-v2').scope.subjectId,'api-subject');
  assert.equal(api.namespace('api-v2'),GLOBAL_EXECUTION_NAMESPACE);
  const catalog = await invoke('workflow:catalog');
  assert.equal(catalog.publication.generation,3);
  assert.equal(catalog.tabs.find(tab=>tab.tabId==='api-v2').nativeRow.project_id,null);
  const bucket = catalog.namespaces.find(namespace=>namespace.id===GLOBAL_EXECUTION_NAMESPACE);
  assert.equal(bucket.path,null);
  assert.equal(bucket.tabs.some(tab=>tab.tabId==='api-v2' && tab.executionSubject.subjectId==='api-subject'),true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n,legacy.projects.length);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});

test('registerTabArtifacts atomically binds native/catalog/member records, rolls back on failure and never repeats committed IDs', t => {
  const f = fixture(t); migrate(f);
  f.db.exec(`CREATE TABLE private_tab_bindings(
    tab_id TEXT REFERENCES workflow_org_tabs(tab_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tab_id,kind))`);
  let failHook = true, calls = 0;
  const announcements = [];
  const creation = { mutationId:'create-with-artifacts',expectedRevision:1,tabId:'bound-v2',workflowId:'a',
    executionSubject:{version:2,subjectId:'bound-subject',cwd:f.root,executionNamespace:GLOBAL_EXECUTION_NAMESPACE},
    aliases:[{namespace:'P',tabId:'bound-v2'}],record:{name:'Bound',directGroupId:'global-group',promptBindings:['root-one','root-two']} };
  const service = new WorkflowOrganization({database:f.manager,
    registerTabArtifacts:(tabId,request,generation) => {
      calls++;
      assert.equal(f.db.inTransaction,true);
      assert.equal(tabId,creation.tabId);
      assert.deepEqual(request,creation);
      assert.equal(generation,2);
      assert.equal(service.getPublication().generation,1,'publication remains behind the uncommitted hook');
      assert.equal(service.getTab(tabId).executionResolved,true);
      assert.equal(service.getMembership(tabId).workflowId,'a');
      assert.equal(service.resolveLegacyAlias({namespace:'P',tabId}).tabId,tabId);
      const put=f.db.prepare('INSERT INTO private_tab_bindings VALUES(?,?,?,?)');
      put.run(tabId,'group',generation,JSON.stringify(request.record.directGroupId));
      put.run(tabId,'prompts',generation,JSON.stringify(request.record.promptBindings));
      if(failHook) throw Error('tab-artifacts-failure');
    },publish:receipt => {
      assert.equal(f.db.inTransaction,false);
      assert.equal(f.db.prepare('SELECT count(*) n FROM private_tab_bindings').get().n,2);
      announcements.push(receipt);
    }});
  const before=service.readState();
  assert.throws(()=>service.createTab(creation),/tab-artifacts-failure/);
  assert.deepEqual(service.readState(),before);
  assert.equal(f.db.prepare("SELECT 1 FROM tabs WHERE tab_id='bound-v2'").get(),undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM workflow_org_aliases WHERE global_tab_id='bound-v2'").get(),undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM private_tab_bindings').get().n,0);
  assert.equal(f.db.prepare("SELECT 1 FROM workflow_org_mutations WHERE mutation_id='create-with-artifacts'").get(),undefined);
  assert.equal(announcements.length,0);
  failHook=false;
  const committed=service.createTab(creation);
  assert.equal(committed.generation,2);
  assert.equal(announcements.length,1);
  assert.deepEqual(service.createTab(creation),committed);
  assert.equal(calls,2,'one failed attempt and one committed execution; receipt replay skips the hook');
  f.reopen();
  assert.deepEqual(f.service.createTab(creation),committed);
  assert.equal(f.db.prepare('SELECT count(*) n FROM private_tab_bindings').get().n,2);
  assert.equal(f.service.getPublication().generation,2);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});
