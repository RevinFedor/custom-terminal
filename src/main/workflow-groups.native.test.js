'use strict';
// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/main/workflow-groups.native.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { WorkflowOrganization } = require('./workflow-organization');
const { WorkflowGroups, legacyGroupId } = require('./workflow-groups');
const { ConversationOwners } = require('./conversation-owner');

function fixture(t, { fault = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-groups-native-'));
  const filename = path.join(root, 'test.db');
  let db = new Database(filename);
  db.pragma('foreign_keys=ON');
  const manager = new DatabaseManager({ existingConnection: db }); manager.initTables();
  for (const p of ['P', 'Q']) db.prepare('INSERT INTO projects(id,path,name,tab_groups) VALUES(?,?,?,?)')
    .run(p, root + '/' + p, p, JSON.stringify([{ id: 'same', name: 'Group ' + p, createdAt: 9, order: 7,
      color: 'purple', sessionStatus: 'busy', collapsed: true, notes: 'retain', future: { custom: [1, 2] } }]));
  for (const [id, p, type, parent] of [['T', 'P', 'terminal', null], ['U', 'Q', 'terminal', null], ['F', 'P', 'file', 'T']])
    db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,tab_group_id,tab_type,visual_parent_tab_id,
      command_type,codex_session_id,notes) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(p, id, id, root + '/' + p, 'same', type, parent, 'codex', 'sid-' + id, 'notes-' + id);
  db.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd,group_id) VALUES(?,?,?,?,?)')
    .run('P', 'A', 'Archived', root, 'same');
  db.prepare('INSERT INTO tab_history(project_id,name,cwd,group_id) VALUES(?,?,?,?)')
    .run('Q', 'Archive without tab ID', root, 'same');
  db.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd,group_id) VALUES(?,?,?,?,?)')
    .run('Q', 'T', 'Previous group', root, 'same');
  const workspace = { activeSpaceId: 'a', spaces: [{ id: 'a', projectIds: ['P', 'Q'], layout: {} }, { id: 'b', projectIds: [], layout: {} }] };
  manager.setAppState('workspace-session', workspace);
  let groups = new WorkflowGroups({ database: manager });
  let org = new WorkflowOrganization({ database: manager, activateArtifacts: (plan, generation) => {
    groups.seedLegacy(plan, { generation }); fault();
  } });
  const migrate = () => {
    const stage = org.prepareMigration({ migrationId: 'M', expectedRevision: 0 });
    return org.publishMigration({ migrationId: 'M', expectedRevision: 0, sourceFingerprint: stage.sourceFingerprint, mutationId: 'activate' });
  };
  const reopen = () => {
    db.close(); db = new Database(filename); db.pragma('foreign_keys=ON');
    groups = new WorkflowGroups({ database: db }); org = new WorkflowOrganization({ database: db });
  };
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  return { root, manager, get db() { return db; }, get groups() { return groups; }, get org() { return org; }, migrate, reopen };
}
let sequence = 0;
const request = (f, groupId, extra = {}) => ({ version: 1, expectedRevision: f.groups.read().revision,
  mutationId: 'mutation-' + ++sequence, ...(groupId ? { groupId, expectedGroupRevision: f.groups.group(groupId).revision } : {}), ...extra });
const error = (fn, code) => assert.throws(fn, e => e.code === code);
const legacyRows = db => Object.fromEntries(['projects', 'tabs', 'tab_history'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]));

test('actual activation transaction preserves namespace collisions, metadata, direct links and archive contexts', t => {
  const f = fixture(t), before = legacyRows(f.db); f.migrate();
  const state = f.groups.read();
  assert.equal(state.version, 1); assert.equal(state.revision, 1);
  assert.equal(state.groups.length, 2);
  const p = f.groups.resolveLegacy('P', 'same'), q = f.groups.resolveLegacy('Q', 'same');
  assert.notEqual(p, q); assert.equal(p, legacyGroupId('P', 'same'));
  assert.equal(state.tabGroups.T, p); assert.equal(state.tabGroups.U, q); assert.equal(state.tabGroups.F, p); assert.equal(state.tabGroups.A, p);
  assert.deepEqual(state.groups[0].future, { custom: [1, 2] }); assert.equal(state.groups[0].order, 7);
  assert.equal(state.groups[0].collapsed, true); assert.equal(state.groups[0].notes, 'retain');
  assert.equal(state.contexts.filter(x => x.tabId === 'T').length, 2);
  assert.equal(state.contexts.find(x => x.tabId === 'T' && x.archived).groupId, q);
  assert.equal(state.contexts.filter(x => x.tabId.startsWith('legacy-archive:')).length, 1);
  assert.deepEqual(legacyRows(f.db), before); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('seed requires caller transaction; failure rolls back SAME organization activation and is restartable', t => {
  let reject = true;
  const f = fixture(t, { fault: () => { if (reject) throw new Error('activation fault'); } });
  const stage = f.org.prepareMigration({ migrationId: 'M', expectedRevision: 0 });
  error(() => f.groups.seedLegacy(stage.plan, { generation: 1 }), 'workflow_group_activation_transaction_required');
  assert.throws(f.migrate, /activation fault/);
  assert.equal(f.groups.read().revision, 0); assert.equal(f.groups.read().groups.length, 0);
  assert.equal(f.org.getPublication().generation, 0);
  reject = false; f.migrate(); assert.equal(f.groups.read().groups.length, 2);
});

test('reopen and identical mutation retry preserve same ID/result; altered request is refused', t => {
  const f = fixture(t); f.migrate(); const p = f.groups.resolveLegacy('P', 'same');
  const r = request(f, p, { name: 'Renamed' }); const result = f.groups.mutate('rename', r);
  f.reopen(); assert.deepEqual(f.groups.mutate('rename', r), result);
  assert.equal(f.groups.resolveLegacy('P', 'same'), p);
  assert.equal(f.groups.read().revision, result.revision);
  error(() => f.groups.mutate('rename', { ...r, name: 'Different' }), 'workflow_group_mutation_id_conflict');
});

test('CAS, exact previous memberships, wrong alias and unknown tab reject whole multi-tab change', t => {
  const f = fixture(t); f.migrate(); const p = f.groups.resolveLegacy('P', 'same'), q = f.groups.resolveLegacy('Q', 'same');
  const before = f.groups.read();
  error(() => f.groups.mutate('rename', request(f, p, { expectedRevision: 0, name: 'wrong' })), 'workflow_group_revision_changed');
  error(() => f.groups.mutate('rename', request(f, p, { expectedGroupRevision: 0, name: 'wrong' })), 'workflow_group_definition_changed');
  error(() => f.groups.mutate('rename', request(f, p, { legacyNamespace: 'Q', legacyGroupId: 'same', name: 'wrong' })), 'workflow_group_alias_mismatch');
  error(() => f.groups.mutate('assign', request(f, p, { tabIds: ['T','U'], expectedTabGroups: { T: p, U: p } })), 'workflow_group_membership_changed');
  error(() => f.groups.mutate('assign', request(f, p, { tabIds: ['T','missing'], expectedTabGroups: { T: p, missing: null } })), 'workflow_group_tab_missing');
  error(() => f.groups.mutate('assign', request(f, p, { tabIds: ['T','U'], expectedTabGroups: { T: p } })), 'workflow_group_previous_membership_required');
  assert.deepEqual(f.groups.read(), before);
  f.groups.mutate('assign', request(f, p, { tabIds: ['U'], expectedTabGroups: { U: q } }));
  assert.equal(f.groups.read().tabGroups.U, p);
  assert.equal(f.db.prepare("SELECT project_id FROM tabs WHERE tab_id='U'").get().project_id, 'Q');
});

test('independent future tab crosses namespaces by tab ID; assignment has no legacy or execution writes', t => {
  const f = fixture(t); f.migrate(); const before = legacyRows(f.db);
  f.org.createTab({ mutationId: 'future-tab', expectedRevision: f.org.getPublication().revision, tabId: 'V2', workflowId: 'b',
    record: { name: 'Future', cwd: '/independent', tabType: 'terminal' }, executionSubject: { version:2,cwd:'/independent' } });
  const made = f.groups.mutate('create', request(f, null, { metadata: { name: 'Cross directory', future: { keep: 4 }, notes: 'new notes' } }));
  assert.match(made.groupId, /^wg2:/);
  f.groups.mutate('assign', request(f, made.groupId, { tabIds: ['T','U','V2'], expectedTabGroups: { T: f.groups.read().tabGroups.T,
    U: f.groups.read().tabGroups.U, V2: null } }));
  assert.equal(f.groups.read().tabGroups.V2, made.groupId);
  // createTab may add an independent execution row, but existing rows remain exact.
  for (const row of before.tabs) assert.deepEqual(f.db.prepare('SELECT * FROM tabs WHERE id=?').get(row.id), row);
  assert.deepEqual(f.db.prepare('SELECT * FROM projects ORDER BY id').all(), before.projects);
});

test('rename/color/status/collapse retain notes/unknown fields; delete unassigns without closing tabs or removing files', t => {
  const f = fixture(t); f.migrate(); const before = legacyRows(f.db), p = f.groups.resolveLegacy('P', 'same');
  const disk = path.join(f.root, 'owned.txt'); fs.writeFileSync(disk, 'unchanged');
  for (const [kind, payload] of [['rename',{name:'New'}], ['color',{color:'green'}], ['status',{status:'done'}], ['collapse',{collapsed:false}]])
    f.groups.mutate(kind, request(f, p, payload));
  const updated = f.groups.group(p); assert.equal(updated.name, 'New'); assert.equal(updated.color, 'green');
  assert.equal(updated.sessionStatus, 'done'); assert.equal(updated.collapsed, false); assert.equal(updated.notes, 'retain');
  assert.deepEqual(updated.future, { custom: [1, 2] }); assert.equal(updated.order, 7);
  const contexts = f.groups.read().contexts;
  f.groups.mutate('delete', request(f, p)); assert.equal(f.groups.resolveLegacy('P', 'same'), null);
  assert.equal(f.groups.read().tabGroups.T, undefined); assert.equal(f.groups.read().tabGroups.F, undefined);
  assert.deepEqual(f.groups.read().contexts, contexts); assert.deepEqual(legacyRows(f.db), before);
  assert.equal(fs.readFileSync(disk, 'utf8'), 'unchanged');
});

test('repeat seed never resets post-migration rename or deletion; foreign source refuses', t => {
  const f = fixture(t); f.migrate(); const p = f.groups.resolveLegacy('P', 'same');
  const plan = f.org.getPreparedMigration('M').plan;
  f.groups.mutate('delete', request(f, p)); const before = f.groups.read();
  f.db.transaction(() => f.groups.seedLegacy(plan, { generation: 1 }))(); assert.deepEqual(f.groups.read(), before);
  const changed = structuredClone(plan); changed.artifacts.legacy.tables.projects[0].name = 'foreign';
  error(() => f.db.transaction(() => f.groups.seedLegacy(changed, { generation: 1 }))(), 'workflow_group_seed_conflict');
});

test('future publication/group metadata refuse writes while unknown current metadata survives', t => {
  const f = fixture(t); f.migrate(); const p = f.groups.resolveLegacy('P', 'same');
  f.db.prepare('UPDATE workflow_global_groups SET metadata_json=? WHERE group_id=?').run(JSON.stringify({ name:'Future', version:2, future:9 }), p);
  error(() => f.groups.mutate('rename', request(f, p, { name:'new' })), 'workflow_group_metadata_version_unsupported');
  error(() => f.groups.mutate('assign', request(f, p, { tabIds:['U'],expectedTabGroups:{ U:f.groups.read().tabGroups.U } })), 'workflow_group_metadata_version_unsupported');
  const before = f.groups.read(); f.db.prepare('UPDATE workflow_group_meta SET version=2 WHERE singleton=1').run();
  f.reopen(); assert.equal(f.groups.read().version, 2); assert.deepEqual(f.groups.read().groups, before.groups);
  error(() => f.groups.mutate('delete', { version:1,mutationId:'future',expectedRevision:1,groupId:p,expectedGroupRevision:1 }), 'workflow_group_version_unsupported');
});
test('two native connections obey one CAS; post-commit publication failure preserves receipt', t => {
  const f = fixture(t); f.migrate(); const p = f.groups.resolveLegacy('P','same');
  const second = new Database(path.join(f.root,'test.db')); second.pragma('foreign_keys=ON');
  t.after(()=>second.close()); const other=new WorkflowGroups({ database:second });
  const stale=request(f,p,{name:'stale'}); f.groups.mutate('rename',request(f,p,{name:'winner'}));
  error(()=>other.mutate('rename',stale),'workflow_group_revision_changed');
  const publisher=new WorkflowGroups({ database:second,publish:()=>{throw Error('lost listener');} });
  const r=request(f,p,{name:'committed'}); const receipt=publisher.mutate('rename',r);
  assert.deepEqual(f.groups.mutate('rename',r),receipt);assert.equal(f.groups.group(p).name,'committed');
});

test('actual ConversationOwners checkpoint remains applicable through group mutations; real cwd/foreign launch still invalidate', t => {
  const f = fixture(t); let launch = { instanceId:'fixture',terminalId:'term',launchId:'launch',runSeq:1 };
  const capture = tabId => { const row = f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(tabId);
    return { known:true,provider:'codex',sessionId:row.codex_session_id,projectId:row.project_id,cwd:row.cwd,...launch }; };
  const owners = new ConversationOwners({ db:f.manager,capture,instanceId:'fixture' });
  const operation = { operationId:'O',revision:1,toolType:'codex',bindingCommitted:true };
  operation.ownerCheckpoint = owners.checkpoint('T',operation,capture('T'));
  const bytes = f.db.prepare("SELECT value FROM app_state WHERE key='conversation-owner.v1:T'").get().value;
  f.migrate(); const q = f.groups.resolveLegacy('Q','same');
  f.groups.mutate('assign',request(f,q,{tabIds:['T'],expectedTabGroups:{T:f.groups.read().tabGroups.T}}));
  f.groups.mutate('rename',request(f,q,{name:'Rename'})); f.groups.mutate('delete',request(f,q));
  assert.equal(owners.applicability('T',operation).applicability.verdict,'applicable');
  assert.equal(f.db.prepare("SELECT value FROM app_state WHERE key='conversation-owner.v1:T'").get().value,bytes);
  f.manager.updateTabCwd('T',f.root+'/actual-change');
  assert.equal(owners.applicability('T',operation).applicability.verdict,'superseded');
  operation.ownerCheckpoint = owners.checkpoint('T',operation,capture('T'));
  launch = {...launch,launchId:'foreign'}; assert.equal(owners.applicability('T',operation).applicability.verdict,'superseded');
});

test('missing legacy definition is retained, invalid JSON/duplicate definition does not activate', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE tabs SET tab_group_id='orphan' WHERE tab_id='U'").run(); f.migrate();
  const orphan = f.groups.group(f.groups.resolveLegacy('Q','orphan')); assert.equal(orphan.missingLegacyDefinition,true);
});
test('active ungrouped tab is not regrouped by old archive; ambiguous archived groups stay exact contexts', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE tabs SET tab_group_id=NULL WHERE tab_id='T'").run();
  f.db.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd,group_id) VALUES(?,?,?,?,?)').run('Q','A','Other archive',f.root,'same');
  f.migrate(); assert.equal(f.groups.read().tabGroups.T,undefined); assert.equal(f.groups.read().tabGroups.A,undefined);
  assert.equal(f.groups.read().contexts.filter(c=>c.tabId==='A').length,2);
});
for (const groups of ['invalid-json', [{ id:'same',name:'one' },{ id:'same',name:'two' }]]) test('invalid legacy groups abort all activation: '+JSON.stringify(groups), t => {
  const f = fixture(t); f.db.prepare("UPDATE projects SET tab_groups=? WHERE id='P'").run(typeof groups==='string'?groups:JSON.stringify(groups));
  error(f.migrate, typeof groups==='string'?'workflow_group_legacy_json_invalid':'workflow_group_duplicate_legacy_definition');
  assert.equal(f.groups.read().revision,0); assert.equal(f.org.getPublication().generation,0);
});
