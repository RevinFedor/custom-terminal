'use strict';

// Private, bounded native SQLite witness. No app bootstrap, BrowserWindow, PTY,
// provider, network or production storage. Run one process with:
// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//   --max-old-space-size=512 --test src/main/database.execution-bulk-prepare.native.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const { GLOBAL_EXECUTION_NAMESPACE: namespace } = require('../shared/workflow-organization.cjs');

const SQL = {
  schema: 'SELECT version FROM workflow_execution_schema',
  row: 'SELECT * FROM tabs WHERE tab_id=? AND execution_namespace=? AND execution_subject_version=2',
  columns: 'PRAGMA table_xinfo(tabs)',
};
const kind = sql => Object.keys(SQL).find(key => SQL[key] === sql)
  || (sql.startsWith('UPDATE tabs SET ') ? 'update' : 'other');
const evidence = (name, value) => {
  if (process.env.NOTED_DB_SAVE_EVIDENCE) fs.appendFileSync(process.env.NOTED_DB_SAVE_EVIDENCE,
    JSON.stringify({ name, value }) + '\n');
};
let totalFixtureBytes = 0;

function fixture(t, ids = ['A', 'B', 'C', 'D']) {
  assert.match(process.versions.electron || '', /^28\./, 'use Electron 28 as Node, never skip the native ABI');
  assert.ok(process.execArgv.includes('--max-old-space-size=512'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  t.after(() => {
    try {
      totalFixtureBytes += db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
      assert.ok(totalFixtureBytes <= 16 * 1024 * 1024, 'all private SQLite fixtures together stay below 16 MiB');
    } finally { db.close(); }
  });
  const manager = new DatabaseManager({ existingConnection: db });
  manager.initTables();
  db.exec(`ALTER TABLE tabs ADD COLUMN fixture_opaque TEXT DEFAULT 'opaque';
    ALTER TABLE tabs ADD COLUMN fixture_blob BLOB;
    ALTER TABLE tabs ADD COLUMN fixture_derived TEXT GENERATED ALWAYS AS (name || ':derived') VIRTUAL;`);
  const api = createWorkflowOrganizationApi({ database: manager });
  api.bootstrap({ migrationId: 'private-prepare', mutationId: 'private-prepare:commit',
    workspace: { activeSpaceId: 'w', spaces: [{ id: 'w', name: 'Private', projectIds: [], layout: {} }] } });
  for (const tabId of ids) api.createTab({ mutationId: 'create:' + tabId, workflowId: 'w', tabId,
    subjectId: 'subject:' + tabId, executionNamespace: namespace, cwd: fs.realpathSync(os.tmpdir()),
    record: { name: tabId, notes: 'notes:' + tabId, createdAt: 1700000000, tabType: 'terminal',
      commandType: 'codex', codexSessionId: 'session:' + tabId, providerState: { private: tabId },
      parentTabId: tabId === ids[0] ? null : ids[0], restartAfterTabIds: ['private-target'],
      futureRecord: { keep: tabId }, nameSetManually: true } });
  db.exec(`UPDATE tabs SET fixture_blob=x'0001ff',overlay_dismissed=1,context_pct=7.5;
    CREATE TABLE fixture_audit(tab_id TEXT,old_revision INTEGER,new_revision INTEGER);
    CREATE TRIGGER fixture_audit_update AFTER UPDATE ON tabs BEGIN
      INSERT INTO fixture_audit VALUES(NEW.tab_id,OLD.execution_storage_revision,NEW.execution_storage_revision);
    END;`);
  const read = tabId => manager.getExecutionTabV2({ executionNamespace: namespace, tabId });
  const state = () => ({ tabs: ids.map(read),
    receipts: db.prepare('SELECT * FROM workflow_execution_main_field_receipts ORDER BY tab_storage_id').all(),
    audit: db.prepare('SELECT * FROM fixture_audit ORDER BY rowid').all() });
  return { db, manager, ids, read, state, snapshots: () => ids.map(tabId => read(tabId).tab) };
}

// Count actual db.prepare calls separately from executions. Every wrapper calls
// the real better-sqlite3 method; SQLite's internal trigger work is not counted
// as a JS PREPARE. These counters are not a latency benchmark.
function measure(db, action, afterRead = () => {}) {
  const original = db.prepare, prepared = [], executed = [];
  db.prepare = function(sql) {
    const statement = original.call(this, sql);
    prepared.push({ sql, statement });
    for (const method of ['get', 'all', 'run']) {
      const native = statement[method];
      statement[method] = function(...args) {
        executed.push({ kind: kind(sql), method });
        const result = native.apply(this, args);
        if (method === 'get') afterRead(sql, args, result);
        return result;
      };
    }
    return statement;
  };
  try {
    const result = action(prepared);
    const counts = { prepares: {}, executions: {} };
    for (const { sql } of prepared) counts.prepares[kind(sql)] = (counts.prepares[kind(sql)] || 0) + 1;
    for (const { kind: query, method } of executed) {
      const key = query + '.' + method;
      counts.executions[key] = (counts.executions[key] || 0) + 1;
    }
    return { result, counts };
  } finally { db.prepare = original; }
}

const request = (f, tabId, extra = {}) => {
  const current = f.read(tabId);
  return { executionNamespace: namespace, tabId, subjectId: current.executionSubject.subjectId,
    expectedRevision: current.revision, ...extra };
};
const refuses = (action, code) => assert.throws(action, error => error.code === code);

test('bulk saves keep complete DTOs, native/opaque fields, identity and writes while reducing PREPARE', t => {
  const f = fixture(t, ['A', 'B', 'C', 'D', 'E', 'F', 'omitted']);
  const before = f.state(), inputs = f.snapshots().slice(0, -1).map(tab => ({ ...tab,
    name: 'saved:' + tab.tabId, notes: 'saved notes:' + tab.tabId, isCollapsed: true,
    codexSessionId: 'stale-renderer-session', providerState: { stale: true },
    futureAdded: { keep: ['small', tab.tabId] } }));
  const inputJson = JSON.stringify(inputs);
  const { result, counts } = measure(f.db, () => f.manager.saveExecutionTabs(namespace, inputs));
  assert.deepEqual(result, { success: true });
  assert.equal(JSON.stringify(inputs), inputJson, 'save does not mutate the supplied snapshot');
  const after = f.state();
  for (let i = 0; i < inputs.length; i++) {
    const old = before.tabs[i], saved = after.tabs[i];
    assert.equal(saved.row.id, old.row.id);
    assert.equal(saved.row.project_id, null);
    assert.deepEqual(saved.executionSubject, old.executionSubject);
    assert.equal(saved.revision, old.revision + 1);
    assert.equal(saved.tab.executionStorageRevision, saved.revision);
    for (const field of ['codex_session_id', 'provider_state', 'context_pct', 'parent_tab_id',
      'fixture_opaque', 'fixture_blob', 'overlay_dismissed']) assert.deepEqual(saved.row[field], old.row[field], field);
    assert.equal(saved.tab.codexSessionId, old.tab.codexSessionId);
    assert.deepEqual(saved.tab.providerState, old.tab.providerState);
    assert.equal(saved.tab.overlayDismissed, true);
    assert.equal(saved.tab.isCollapsed, true);
    assert.equal(saved.tab.fixtureDerived, inputs[i].name + ':derived');
    assert.deepEqual(saved.tab.futureRecord, old.tab.futureRecord);
    assert.deepEqual(saved.tab.futureAdded, inputs[i].futureAdded);
    assert.equal(JSON.parse(saved.row.execution_record_json).codexSessionId, inputs[i].codexSessionId);
  }
  assert.deepEqual(after.tabs.at(-1), before.tabs.at(-1), 'omission is never deletion');
  assert.equal(after.audit.length, inputs.length, 'every requested UPDATE still runs');
  assert.deepEqual(counts.executions, { 'schema.get': 7, 'row.get': 12, 'columns.all': 6, 'update.run': 6 });
  evidence('bulk-dto', { result, before, after });
  evidence('bulk-counts', counts);
  t.diagnostic('Actual PREPARE calls: ' + JSON.stringify(counts.prepares) + '; executions: ' + JSON.stringify(counts.executions));
  // RED on the captured source: 31 prepares. GREEN: five, including the outer
  // pre-transaction schema check. All 31 native executions above remain.
  assert.deepEqual(counts.prepares, { schema: 2, row: 1, columns: 1, update: 1 });
});

test('main-field reconciliation retains its exact proof and direct singleton CAS stays strict', t => {
  const f = fixture(t), inputs = f.snapshots().slice(0, 2);
  f.db.prepare('UPDATE tabs SET context_pct=?,provider_state=? WHERE tab_id=?').run(23.5, '{"newMain":true}', 'A');
  f.db.prepare('UPDATE tabs SET codex_model=? WHERE tab_id=?').run('private-model', 'B');
  const before = f.state();
  refuses(() => f.manager.saveExecutionTabV2(request(f, 'A', {
    expectedRevision: inputs[0].executionStorageRevision, record: inputs[0] })), 'execution_storage_revision_changed');
  const result = f.manager.saveTabs(namespace, inputs);
  assert.equal(result.success, true);
  assert.equal(result.executionReconciliations.length, 2);
  assert.deepEqual(result.executionReconciliations.map(proof => proof.fields), [['provider_state', 'context_pct'], ['codex_model']]);
  for (let i = 0; i < inputs.length; i++) {
    const proof = result.executionReconciliations[i], saved = f.read(inputs[i].tabId);
    assert.deepEqual(proof, { version: 1, kind: 'main-owned-fields', namespace,
      tabId: inputs[i].tabId, subjectId: inputs[i].executionSubject.subjectId,
      fromRevision: inputs[i].executionStorageRevision, toRevision: before.tabs[i].revision,
      proofFromRevision: inputs[i].executionStorageRevision, fields: proof.fields });
    assert.equal(saved.revision, proof.toRevision + 1);
    assert.equal(saved.tab.notes, inputs[i].notes);
  }
  assert.equal(f.read('A').tab.contextPct, 23.5);
  assert.deepEqual(f.read('A').tab.providerState, { newMain: true });
  assert.equal(f.read('B').tab.codexModel, 'private-model');
  evidence('reconciliation', { result, before, after: f.state() });
});

test('stale revision, wrong subject and unproved metadata gaps roll back earlier writes and receipts', t => {
  const f = fixture(t), inputs = f.snapshots().slice(0, 2);
  f.db.prepare('UPDATE tabs SET context_pct=20 WHERE tab_id=?').run('A');
  const before = f.state();
  for (const [code, invalid] of [
    ['execution_storage_revision_changed', { ...inputs[1], executionStorageRevision: 0 }],
    ['execution_subject_changed', { ...inputs[1], executionSubject: { ...inputs[1].executionSubject, subjectId: 'wrong' } }],
  ]) {
    refuses(() => f.manager.saveExecutionTabs(namespace, [{ ...inputs[0], name: 'must roll back' }, invalid]), code);
    assert.deepEqual(f.state(), before, 'row, revision, opaque fields, receipts and trigger effects all roll back');
    assert.equal(f.db.inTransaction, false);
  }
  f.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('newer metadata', 'B');
  const changed = f.state();
  refuses(() => f.manager.saveExecutionTabs(namespace, inputs), 'execution_storage_revision_changed');
  assert.deepEqual(f.state(), changed, 'reconciliation cannot bridge a metadata write');
  evidence('rollback', { before, changed });
});

test('every singleton and next bulk call sees fresh rows, schema, bindings and writable-column guards', t => {
  const f = fixture(t), first = f.snapshots().slice(0, 2);
  f.manager.saveExecutionTabs(namespace, first);
  f.db.exec(`ALTER TABLE tabs ADD COLUMN fixture_later TEXT DEFAULT 'new column';
    UPDATE tabs SET fixture_later='new value',notes='fresh notes' WHERE tab_id='A';`);
  const current = f.read('A');
  const readCounts = measure(f.db, () => [f.read('A'), f.read('A')]);
  assert.deepEqual(readCounts.counts, { prepares: { row: 2 }, executions: { 'row.get': 2 } });
  const singleton = measure(f.db, () => f.manager.saveExecutionTabV2(request(f, 'A', { columns: { fixture_later: 'direct' } })));
  assert.deepEqual(singleton.counts.prepares, { row: 3, schema: 1, columns: 1, update: 1 });
  assert.equal(singleton.result.tab.fixtureLater, 'direct');
  for (const field of ['id', 'execution_subject_id', 'fixture_derived', 'does_not_exist']) {
    refuses(() => f.manager.saveExecutionTabV2(request(f, 'A', { columns: { [field]: 'invalid' } })), 'execution_column_not_writable');
  }
  refuses(() => f.manager.saveExecutionTabV2(request(f, 'A', { columns: { cwd: 'relative' } })), 'execution_cwd_required');
  refuses(() => f.manager.saveExecutionTabs(namespace, first), 'execution_storage_revision_changed');
  const fresh = f.snapshots().slice(0, 2);
  const second = measure(f.db, () => f.manager.saveExecutionTabs(namespace, fresh));
  assert.equal(second.result.success, true);
  assert.equal(f.read('A').tab.notes, 'fresh notes');
  assert.equal(f.read('A').tab.fixtureLater, 'direct');
  assert.equal(f.read('A').revision, current.revision + 2);
  evidence('fresh-next-call', { singleton: singleton.result, second: second.result, after: f.state() });
});

test('fresh reads observe AFTER triggers; peer revisions and schema guards abort the complete batch', t => {
  const f = fixture(t), save = f.manager.saveExecutionTabV2, returned = [];
  f.manager.saveExecutionTabV2 = function(...args) { const saved = save.apply(this, args); returned.push(saved); return saved; };
  f.db.exec(`CREATE TRIGGER fixture_self AFTER UPDATE OF name ON tabs WHEN NEW.tab_id='A' BEGIN
    UPDATE tabs SET notes='from trigger' WHERE id=NEW.id;
  END;`);
  const before = f.read('A');
  f.manager.saveExecutionTabs(namespace, [{ ...before.tab, name: 'self trigger' }]);
  assert.deepEqual(returned[0], f.read('A'), 'post-write DTO includes native trigger effects');
  assert.equal(returned[0].tab.notes, 'from trigger');
  assert.equal(returned[0].revision, before.revision + 2);
  f.db.exec(`DROP TRIGGER fixture_self;
    CREATE TRIGGER fixture_peer AFTER UPDATE OF name ON tabs WHEN NEW.tab_id='A' BEGIN
      UPDATE tabs SET notes='peer changed' WHERE tab_id='B';
    END;`);
  const peerBefore = f.state();
  refuses(() => f.manager.saveExecutionTabs(namespace, f.snapshots().slice(0, 2)), 'execution_storage_revision_changed');
  assert.deepEqual(f.state(), peerBefore);
  f.db.exec(`DROP TRIGGER fixture_peer;
    CREATE TRIGGER fixture_schema AFTER UPDATE OF name ON tabs WHEN NEW.tab_id='A' BEGIN
      UPDATE workflow_execution_schema SET version=2;
    END;`);
  refuses(() => f.manager.saveExecutionTabs(namespace, f.snapshots().slice(0, 2)), 'execution_schema_forward_version');
  assert.deepEqual(f.state(), peerBefore);
  assert.equal(f.db.prepare(SQL.schema).get().version, 1);
  evidence('triggers', { self: returned[0], after: f.state() });
});

test('schema and trigger DDL between rows is visible to reused statements in the same transaction', t => {
  const f = fixture(t), save = f.manager.saveExecutionTabV2, returned = [];
  f.manager.saveExecutionTabV2 = function(...args) {
    if (args[0].tabId === 'B') args[0] = { ...args[0], columns: { fixture_mid_batch: 'explicit write' } };
    const saved = save.apply(this, args); returned.push(saved);
    if (args[0].tabId === 'A') f.db.exec(`ALTER TABLE tabs ADD COLUMN fixture_mid_batch TEXT DEFAULT 'added';
      CREATE TRIGGER fixture_mid_batch_trigger AFTER UPDATE OF name ON tabs WHEN NEW.tab_id IN ('B','C') BEGIN
        UPDATE tabs SET fixture_mid_batch='trigger ran' WHERE id=NEW.id;
      END;`);
    return saved;
  };
  const result = f.manager.saveExecutionTabs(namespace, f.snapshots().slice(0, 3));
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(returned[0].row, 'fixture_mid_batch'), false);
  assert.equal(returned[1].row.fixture_mid_batch, 'trigger ran');
  assert.equal(returned[1].tab.fixtureMidBatch, 'trigger ran');
  assert.deepEqual(returned[1], f.read('B'));
  assert.equal(returned[2].row.fixture_mid_batch, 'trigger ran', 'the original UPDATE shape also picks up the new trigger');
  assert.deepEqual(returned[2], f.read('C'));
  evidence('mid-batch-ddl', { result, returned, after: f.state() });
});

test('nested bulk and direct saves keep separate preparation scopes and the outer atomic boundary', t => {
  const f = fixture(t), save = f.manager.saveExecutionTabV2;
  let nested;
  f.manager.saveExecutionTabV2 = function(...args) {
    const saved = save.apply(this, args);
    if (args[0].tabId === 'A') {
      nested = f.manager.saveExecutionTabs(namespace, [{ ...f.read('C').tab, name: 'nested' }]);
      f.manager.saveExecutionTabV2(request(f, 'D', { columns: { notes: 'direct nested' } }));
    }
    return saved;
  };
  const before = f.state(), inputs = f.snapshots().slice(0, 2);
  refuses(() => f.manager.saveExecutionTabs(namespace, [inputs[0], { ...inputs[1], executionStorageRevision: 0 }]),
    'execution_storage_revision_changed');
  assert.deepEqual(f.state(), before, 'successful inner calls do not commit ahead of their outer transaction');
  const measured = measure(f.db, () => f.manager.saveExecutionTabs(namespace, inputs));
  assert.deepEqual(nested, { success: true });
  assert.deepEqual(measured.result, { success: true });
  const after = f.state();
  assert.deepEqual(after.tabs.map(row => row.revision), before.tabs.map(row => row.revision + 1));
  assert.equal(f.read('C').tab.name, 'nested');
  assert.equal(f.read('D').tab.notes, 'direct nested');
  evidence('nested', { before, after });
  t.diagnostic('Nested actual PREPARE calls: ' + JSON.stringify(measured.counts.prepares));
  // Two explicit caller reads (C/D), one reader per bulk, two direct-save reads.
  assert.deepEqual(measured.counts.prepares, { schema: 5, row: 6, columns: 3, update: 3 });
});

test('a busy native reader falls back to a fresh statement without refusing the next row', t => {
  const f = fixture(t), save = f.manager.saveExecutionTabV2;
  let iterator, held;
  t.after(() => iterator?.return());
  const measured = measure(f.db, prepared => {
    f.manager.saveExecutionTabV2 = function(...args) {
      const saved = save.apply(this, args);
      if (args[0].tabId === 'A') {
        held = prepared.filter(entry => entry.sql === SQL.row).at(-1).statement;
        iterator = held.iterate('A', namespace);
        assert.equal(iterator.next().value.tab_id, 'A');
        assert.equal(held.busy, true);
      }
      return saved;
    };
    return f.manager.saveExecutionTabs(namespace, f.snapshots().slice(0, 2));
  }, (sql, args) => {
    if (iterator && sql === SQL.row && args[0] === 'B') { iterator.return(); iterator = null; }
  });
  assert.deepEqual(measured.result, { success: true });
  assert.equal(held.busy, false);
  evidence('busy-fallback', { result: measured.result, after: f.state() });
});

test.after(() => {
  evidence('fixture-budget', { totalFixtureBytes });
  assert.ok(totalFixtureBytes <= 16 * 1024 * 1024);
});
