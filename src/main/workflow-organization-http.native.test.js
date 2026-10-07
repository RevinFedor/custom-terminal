'use strict';

// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/main/workflow-organization-http.native.test.js
// Real HTTP + imported complete adapter + actual DatabaseManager/API on owned
// SQLite files. Only the renderer bridge is a recorded, provider-free seam.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const { createWorkflowOrganizationHttp, WORKFLOW_HTTP_CAPABILITY, listExecutionNamespaces,
  legacyCreationContext, freezeWorkflowCreationContext, executionNamespaceForRow } = require('./workflow-organization-http');
const { GLOBAL_EXECUTION_NAMESPACE: NS, INBOX_WORKFLOW_ID } = require('../shared/workflow-organization.cjs');
const { resolveRestorableAgentTab } = require('./agent-tab-restore');

async function fixture(t, { legacy = false, bootstrap = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-http-native-'));
  const db = new Database(path.join(root, 'owned.db')); db.pragma('foreign_keys=ON');
  const database = new DatabaseManager({ existingConnection: db }); database.initTables();
  if (legacy) {
    db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('legacy=', root, 'Legacy');
    db.prepare("INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id) VALUES('legacy=','source','Source',?,'codex','saved-writer')").run(root);
  }
  const api = createWorkflowOrganizationApi({ database });
  if (bootstrap) api.bootstrap({ migrationId: 'fixture-migrate', mutationId: 'fixture-activate',
    workspace: { activeSpaceId: 'work', spaces: [{ id: 'work', name: 'Work', projectIds: legacy ? ['legacy='] : [], layout: {} }] } });
  const projectManager = { db: database, workflowOrganization: api };
  const calls = [];
  const create = kind => async body => {
    calls.push({ kind, body });
    // Exercise the real durable allocation from the API foundation without
    // starting a PTY. Production supplies the existing renderer scenario.
    return api.createTab({ mutationId: 'fixture-create:' + calls.length, cwd: body.cwd, workflowId: body.workflowId,
      executionNamespace: body.executionNamespace, sourceTabId: body.sourceTabId,
      record: { name: body.name || kind, commandType: kind === 'agent' ? 'codex' : null } });
  };
  const handler = createWorkflowOrganizationHttp({ getProjectManager: () => projectManager,
    checkAuth: req => req.headers.authorization === 'Bearer private-fixture',
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); },
    sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
    createAgentTab: create('agent'), createTerminalTab: create('terminal') });
  const server = http.createServer((req, res) => {
    handler(req, res, url.parse(req.url, true)).then(handled => {
      if (!handled) { res.writeHead(404); res.end('{}'); }
    }).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  });
  const call = (route, method = 'GET', body, authenticated = true) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { ...(authenticated ? { Authorization: 'Bearer private-fixture' } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}) } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(bytes);
  });
  return { root, db, database, api, projectManager, calls, call };
}

test('authenticated canonical reads include legacy and v2 addresses without Project creation or runtime work', async t => {
  const f = await fixture(t, { legacy: true });
  const created = f.api.createTab({ mutationId: 'independent', tabId: 'independent', cwd: f.root, workflowId: 'work', record: { future: 'keep' } });
  for (const route of ['/api/workflow-organization', '/api/workflows', '/api/tab-catalog', '/api/directory-roots']) {
    assert.equal((await f.call(route, 'GET', undefined, false)).status, 401);
    assert.equal((await f.call(route)).status, 200);
  }
  const snapshot = (await f.call('/api/tab-catalog')).body;
  assert.equal(snapshot.tabs.length, 2);
  const independent = snapshot.tabs.find(tab => tab.tabId === 'independent');
  assert.deepEqual(independent.executionSubject, created.executionSubject);
  assert.equal(independent.nativeRow.project_id, null);
  assert.equal(independent.record.future, 'keep');
  assert.equal(independent.membership.workflowId, 'work');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 1);
  assert.deepEqual(listExecutionNamespaces(f.projectManager).map(bucket => bucket.id).sort(), [NS, '__noted_inbox__', 'legacy='].sort());
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM projects WHERE id='__noted_inbox__'").get().n,0);
  assert.equal(f.calls.length, 0);
  assert.equal(WORKFLOW_HTTP_CAPABILITY.independentCwd, true);
});

test('workflow CRUD/move/detach use durable same-ID receipts, CAS and immutable execution address', async t => {
  const f = await fixture(t);
  const request = { mutationId: 'new-workflow', expectedRevision: f.api.read().publication.revision,
    workflow: { id: 'Докс =', name: 'Докс', future: { field: true } } };
  const route = '/api/workflows/' + encodeURIComponent('Докс =');
  const created = await f.call('/api/workflows', 'POST', request); assert.equal(created.status, 200);
  assert.deepEqual(await f.call('/api/workflows', 'POST', request), created);
  assert.equal((await f.call('/api/workflow-organization/mutations/new-workflow')).body.workflowId, 'Докс =');
  assert.equal((await f.call('/api/workflows', 'POST', { ...request, workflow: { id: 'other' } })).status, 409);
  assert.equal((await f.call('/api/workflows', 'POST', { ...request, mutationId: 'stale', workflow: { id: 'stale' } })).status, 409);
  f.api.createTab({ mutationId: 'tab', tabId: 'tab =', cwd: f.root, workflowId: 'work', record: { codexSessionId: 'writer' } });
  const rowBefore = f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('tab =');
  const move = { mutationId: 'move', expectedRevision: f.api.read().publication.revision,
    workflowId: 'Докс =', expectedMembershipRevision: 1 };
  const moved = await f.call('/api/tab-catalog/tab%20%3D/move', 'POST', move); assert.equal(moved.status, 200);
  assert.deepEqual(await f.call('/api/tab-catalog/tab%20%3D/move', 'POST', move), moved);
  assert.equal((await f.call(route)).body.tabs[0].tabId, 'tab =');
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('tab ='), rowBefore);
  const layout = { mutationId: 'layout', expectedRevision: f.api.read().publication.revision,
    expectedWorkflowRevision: (await f.call(route)).body.workflow.revision,
    layout: { splitPanes: [{ projectId: NS, tabId: 'tab =', windowId: 'window' }] } };
  const saved = await f.call(route + '/layout', 'PUT', layout); assert.equal(saved.status, 200);
  assert.deepEqual(await f.call(route + '/layout', 'PUT', layout), saved);
  assert.equal((await f.call(route + '/layout', 'PUT', { ...layout, mutationId: 'wrong', workflowId: 'work' })).status, 400);
  const deletion = { mutationId: 'delete', expectedRevision: f.api.read().publication.revision,
    expectedWorkflowRevision: (await f.call(route)).body.workflow.revision };
  const removed = await f.call(route, 'DELETE', deletion); assert.equal(removed.status, 200);
  assert.deepEqual(await f.call(route, 'DELETE', deletion), removed);
  assert.equal(f.api.service.getMembership('tab =').workflowId, INBOX_WORKFLOW_ID);
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('tab ='), rowBefore);
  const detached = await f.call('/api/tab-catalog/tab%20%3D/detach', 'POST', {
    mutationId: 'detach', expectedRevision: f.api.read().publication.revision,
    expectedMembershipRevision: f.api.service.getMembership('tab =').revision });
  assert.equal(detached.status, 200);
  assert.equal((await f.call('/api/workflows/' + encodeURIComponent(INBOX_WORKFLOW_ID), 'DELETE', {
    mutationId: 'delete-system', expectedRevision: f.api.read().publication.revision, expectedWorkflowRevision: 1 })).status, 409);
});

test('directory CRUD removes only registration; tabs, cwd, session and bytes survive with exact replay/CAS', async t => {
  const f = await fixture(t);
  f.api.createTab({ mutationId: 'tab', tabId: 'owned', cwd: f.root, workflowId: 'work', record: { codexSessionId: 'writer' } });
  fs.writeFileSync(path.join(f.root, 'keep.bin'), Buffer.from([0, 255, 3]));
  const before = f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('owned');
  const add = { mutationId: 'root', expectedRevision: 0, path: f.root, name: 'Files', enabled: true };
  const created = await f.call('/api/directory-roots', 'POST', add); assert.equal(created.status, 200);
  assert.deepEqual(await f.call('/api/directory-roots', 'POST', add), created);
  const id = created.body.id;
  const update = { mutationId: 'root-update', expectedRevision: created.body.revision, id, name: 'Renamed' };
  assert.equal((await f.call('/api/directory-roots', 'POST', update)).status, 200);
  const snapshot = (await f.call('/api/directory-roots')).body;
  assert.equal(snapshot.roots[0].name, 'Renamed');
  const remove = { mutationId: 'root-remove', expectedRevision: snapshot.revision, expectedRootRevision: snapshot.roots[0].revision };
  const route = '/api/directory-roots/' + encodeURIComponent(id);
  assert.equal((await f.call(route, 'DELETE', { ...remove, expectedRootRevision: 0 })).status, 409);
  const deleted = await f.call(route, 'DELETE', remove); assert.equal(deleted.status, 200);
  assert.deepEqual(await f.call(route, 'DELETE', remove), deleted);
  assert.deepEqual((await f.call('/api/directory-roots')).body.roots, []);
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('owned'), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'keep.bin')), Buffer.from([0, 255, 3]));
});

test('generic mutation endpoint updates canonical metadata through complete snapshot with exact replay', async t => {
  const f = await fixture(t);
  const snapshot = f.api.read();
  const request = { mutationId: 'metadata', expectedRevision: snapshot.publication.revision,
    spaces: snapshot.workflows.map(workflow => ({ ...workflow.metadata, layout: workflow.layout,
      ...(workflow.id === 'work' ? { name: 'Renamed', future: { retain: true } } : {}) })),
    tabWorkflowMembership: {} };
  const body = { kind: 'commitWorkspace', request };
  const changed = await f.call('/api/workflow-organization/mutations', 'POST', body);
  assert.equal(changed.status, 200);
  assert.deepEqual(await f.call('/api/workflow-organization/mutations', 'POST', body), changed);
  const state = (await f.call('/api/workflows/work')).body;
  assert.equal(state.workflow.metadata.name, 'Renamed');
  assert.deepEqual(state.workflow.metadata.future, { retain: true });
  assert.equal((await f.call('/api/workflow-organization/mutations', 'POST', { ...body, kind: 'deleteWorkflow' })).status, 409);
  assert.equal((await f.call('/api/workflow-organization/mutations', 'POST', body, false)).status, 401);
  assert.equal((await f.call('/api/workflow-organization/mutations/missing')).status, 404);
  assert.equal((await f.call('/api/workflow-organization/mutations', 'POST', { kind: 'unknown', request })).status, 400);
});

test('workflow create uses an explicit independent cwd and background bridge with zero Projects', async t => {
  const f = await fixture(t);
  for (const kind of ['agent-tabs', 'terminal-tabs']) {
    const result = await f.call('/api/workflows/work/' + kind, 'POST', { cwd: f.root, name: kind, background: true });
    assert.equal(result.status, 200);
    const call = f.calls.at(-1);
    assert.equal(call.body.projectId, NS); assert.equal(call.body.executionNamespace, NS);
    assert.equal(call.body.workflowId, 'work'); assert.equal(call.body.cwd, f.root); assert.equal(call.body.background, true);
    const row = f.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(result.body.tabId);
    assert.equal(row.project_id, null); assert.equal(row.execution_subject_version, 2);
    assert.equal(row.execution_namespace, NS);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 0);
  const count = f.calls.length;
  for (const body of [{}, { cwd: 'relative' }, { cwd: f.root, workflowId: 'foreign' },
    { cwd: path.join(f.root, 'missing') }, { cwd: f.root, executionNamespace: 'work' }]) {
    assert.ok((await f.call('/api/workflows/work/agent-tabs', 'POST', body)).status >= 400);
  }
  assert.equal((await f.call('/api/workflows/work/agent-tabs', 'POST', { cwd: f.root }, false)).status, 401);
  assert.equal(f.calls.length, count);
});

test('source context is frozen before async work and legacy alias gets real explicit cwd', async t => {
  const f = await fixture(t, { legacy: true });
  const legacy = legacyCreationContext(f.projectManager, 'legacy=', { background: true });
  assert.equal(legacy.cwd, f.root); assert.equal(legacy.projectId, 'legacy=');
  assert.throws(() => legacyCreationContext(f.projectManager, 'foreign', {}), /execution_namespace_unknown/);
  const original = { sourceTabId: 'source', windowTarget: { mode: 'new-window' }, background: true };
  const pending = freezeWorkflowCreationContext(f.projectManager, original);
  original.windowTarget.mode = 'changed-by-caller';
  f.api.mutate('moveTab', { mutationId: 'move-source', expectedRevision: f.api.read().publication.revision,
    tabId: 'source', workflowId: INBOX_WORKFLOW_ID, expectedMembershipRevision: 1 });
  const frozen = await pending;
  assert.equal(frozen.workflowId, 'work'); assert.equal(frozen.cwd, f.root); assert.equal(frozen.projectId, 'legacy=');
  assert.equal(frozen.windowTarget.mode, 'new-window');
  const fallback = await freezeWorkflowCreationContext(f.projectManager, { fallbackProjectId: 'legacy=' });
  assert.equal(fallback.projectId, 'legacy='); assert.equal(fallback.cwd, f.root);
  assert.equal(fallback.workflowId, INBOX_WORKFLOW_ID);
  const sourceBeforeFallback = await freezeWorkflowCreationContext(f.projectManager, { sourceTabId: 'source', fallbackProjectId: 'foreign' });
  assert.equal(sourceBeforeFallback.projectId, 'legacy=');
  const created = await f.call('/api/workflows/work/agent-tabs', 'POST', { sourceTabId: 'source', background: true });
  assert.equal(created.status, 200); assert.equal(created.body.executionSubject.executionNamespace, 'legacy=');
  assert.equal(f.api.service.getMembership(created.body.tabId).workflowId, 'work');
});

test('v2 archive address resolves through virtual namespace and preserves exact restored identity', async t => {
  const f = await fixture(t);
  f.api.createTab({ mutationId: 'tab', tabId: 'closed', cwd: f.root, workflowId: 'work',
    record: { name: 'Closed', commandType: 'codex', codexSessionId: 'saved-writer' } });
  const historyId = f.database.archiveTab(NS, { tabId: 'closed', name: 'Closed', cwd: f.root,
    commandType: 'codex', codexSessionId: 'saved-writer' }, { sourceTabId: 'closed' });
  const entries = f.database.getTabHistoryEntriesByTabId('closed', 2);
  assert.equal(entries[0].id, historyId);
  assert.equal(executionNamespaceForRow(entries[0]), NS);
  const descriptor = resolveRestorableAgentTab({ tabId: 'closed', historyEntries: entries, project: f.database.getProjectById(NS) });
  assert.equal(descriptor.ok, true); assert.equal(descriptor.projectId, NS); assert.equal(descriptor.sessionId, 'saved-writer');
  assert.equal(descriptor.tabId, 'closed'); assert.equal(descriptor.cwd, f.root);
  assert.equal(executionNamespaceForRow({ execution_subject_version: 2, project_id: 'wrong', execution_namespace: NS }), NS);
  assert.equal(executionNamespaceForRow({ execution_subject_version: 3, project_id: 'wrong', execution_namespace: NS }), null);
  assert.equal(executionNamespaceForRow({ execution_subject_version: 1, project_id: 'legacy=', execution_namespace: 'wrong' }), 'legacy=');
});

test('unpublished/future organization rejects HTTP writes before renderer or roots mutate', async t => {
  const f = await fixture(t, { bootstrap: false });
  assert.equal((await f.call('/api/tab-catalog')).body.error, 'workflow_migration_required');
  assert.equal((await f.call('/api/workflows/work/agent-tabs', 'POST', { cwd: f.root })).status, 409);
  assert.equal(f.calls.length, 0);
  f.api.bootstrap({ workspace: { spaces: [], activeSpaceId: null }, migrationId: 'later', mutationId: 'activate' });
  f.db.prepare('UPDATE workflow_org_meta SET schema_version=99 WHERE singleton=1').run();
  const result = await f.call('/api/workflows', 'POST', { mutationId: 'future', expectedRevision: 1, workflow: { id: 'future' } });
  assert.equal(result.status, 409); assert.match(result.body.error, /forward_version/);
  assert.equal(f.calls.length, 0);
});
