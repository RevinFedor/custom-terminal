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

async function fixture(t, { legacy = false, bootstrap = true, spaces = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-http-native-'));
  const db = new Database(path.join(root, 'owned.db')); db.pragma('foreign_keys=ON');
  const database = new DatabaseManager({ existingConnection: db }); database.initTables();
  if (legacy) {
    db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('legacy=', root, 'Legacy');
    db.prepare("INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id) VALUES('legacy=','source','Source',?,'codex','saved-writer')").run(root);
  }
  const api = createWorkflowOrganizationApi({ database });
  if (bootstrap) api.bootstrap({ migrationId: 'fixture-migrate', mutationId: 'fixture-activate',
    workspace: { activeSpaceId: spaces?.[0]?.id || 'work', spaces: spaces || [{ id: 'work', name: 'Work', projectIds: legacy ? ['legacy='] : [], layout: {} }] } });
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

test('F7: creation without order and publication reorder agree in Main, renderer and phone', async t => {
  const f=await fixture(t,{spaces:[{id:'a',name:'A',order:0,layout:{}},{id:'b',name:'B',order:1,layout:{}}]});
  const {organizationProjection,reconcileWorkflowOrder}=await import('../renderer/utils/workflowOrganizationClient.mjs');
  f.api.mutate('createWorkflow',{mutationId:'C',expectedRevision:f.api.read().publication.revision,workflow:{id:'c',name:'C'}});
  let snapshot=f.api.read();
  const current={activeSpaceId:'a'};
  assert.deepEqual(snapshot.workflows.map(w=>w.id),['a','b','c',INBOX_WORKFLOW_ID]);
  assert.deepEqual(organizationProjection(snapshot,current).spaces.map(w=>w.id),snapshot.workflows.map(w=>w.id));
  const initial=organizationProjection(snapshot,current);
  const originalA=initial.spaces[0];originalA.layout={ownedWindow:'untouched'};
  const space=id=>{const w=snapshot.workflows.find(w=>w.id===id);return {...w.metadata,id,layout:w.layout};};
  f.api.mutate('commitWorkspace',{mutationId:'order',expectedRevision:snapshot.publication.revision,
    spaces:['b','a',INBOX_WORKFLOW_ID,'c'].map(space),tabWorkflowMembership:{}});
  snapshot=f.api.read();
  const projection=organizationProjection(snapshot,current),phone=await f.api.readCatalog();
  assert.deepEqual(snapshot.workflows.map(w=>w.id),['b','a','c',INBOX_WORKFLOW_ID]);
  assert.deepEqual(projection.spaces.map(w=>w.id),snapshot.workflows.map(w=>w.id));
  assert.deepEqual(phone.workflows.map(w=>w.id),snapshot.workflows.map(w=>w.id));
  const followed=reconcileWorkflowOrder(projection.spaces,initial.spaces,initial.organizationWorkflowOrder,'a');
  assert.equal(followed[1],originalA);assert.deepEqual(originalA.layout,{ownedWindow:'untouched'});
  const local=[initial.spaces[2],...initial.spaces.slice(0,2),initial.spaces[3]];
  assert.equal(reconcileWorkflowOrder(projection.spaces,local,initial.organizationWorkflowOrder,'a'),local,'newer local drag owns its order');
});

test('catalog-v1: full active inventory and exact execution refs, coherent HTTP, no runtime bridge', async t => {
  const f=await fixture(t,{legacy:true});
  const add=(id,record={})=>f.api.createTab({mutationId:'new:'+id,tabId:id,cwd:f.root,workflowId:'work',record:{name:id,...record}});
  add('owner',{commandType:'codex',codexSessionId:'saved-session'});
  add('file',{tabType:'file',filePath:path.join(f.root,'synthetic.md'),visualParentTabId:'owner'});
  add('physical',{parentTabId:'owner'});add('hidden');add('profile');add('stopped');add('archived');
  f.db.prepare("UPDATE tabs SET execution_archived=1 WHERE tab_id='archived'").run();
  f.api.mutate('createWorkflow',{mutationId:'second',expectedRevision:f.api.read().publication.revision,workflow:{id:'other',name:'Other'}});
  f.api.createTab({mutationId:'other-member',tabId:'other-member',cwd:f.root,workflowId:'other',record:{name:'Other member'}});
  const group=f.api.groups.mutate('create',{version:1,mutationId:'group',expectedRevision:f.api.groups.read().revision,
    metadata:{name:'Spanning',reserveWorkflowId:'work'}}).groupId;
  const empty=f.api.groups.mutate('create',{version:1,mutationId:'empty',expectedRevision:f.api.groups.read().revision,
    metadata:{name:'Empty',reserveWorkflowId:'work'}}).groupId;
  // Synthetic fixture setup only: actual group reader/HTTP project these rows.
  for(const id of ['owner','file','other-member'])f.db.prepare('INSERT INTO workflow_group_memberships VALUES(?,?,1)').run(id,group);
  f.db.prepare('UPDATE workflow_group_meta SET revision=revision+1').run();
  const workflow=f.api.service.getWorkflow('work');
  const memberRoot='reserve-tab:stopped',groupRoot='reserve-group:'+JSON.stringify([NS,group]);
  const snapshot=f.api.read();
  f.api.mutate('commitWorkspace',{mutationId:'placements',expectedRevision:snapshot.publication.revision,
    spaces:snapshot.workflows.map(w=>({...w.metadata,id:w.id,
      ...(w.id==='work'?{reserveOrder:['stopped','file','owner'],reserveRootOrder:[memberRoot,groupRoot]}:{}),
      layout:w.id==='work'?{splitPanes:[{windowId:'shown',projectId:NS,tabId:'owner'},
        {windowId:'hidden',projectId:NS,tabId:'hidden',displayHidden:true}],windowDisplayLayouts:{old:{splitPanes:[{projectId:NS,tabId:'profile'}]}}}:w.layout})),
    tabWorkflowMembership:Object.fromEntries(snapshot.tabs.map(entry=>[entry.tabId,{...entry.membership,expectedMembershipRevision:entry.membership.revision}]))});
  const baseline=f.db.prepare('SELECT * FROM tabs ORDER BY id').all();
  const rawBefore=f.api.read();
  assert.equal((await f.call('/api/workflow-organization?projection=catalog-v1','GET',undefined,false)).status,401);
  assert.equal((await f.call('/api/workflow-organization?projection=unknown')).status,400);
  const response=await f.call(WORKFLOW_HTTP_CAPABILITY.catalogProjection.endpoint);
  assert.equal(response.status,200);
  const dto=response.body,work=dto.workflows.find(w=>w.id==='work'),other=dto.workflows.find(w=>w.id==='other');
  assert.deepEqual(new Set(work.memberTabIds),new Set(['source','owner','file','physical','hidden','profile','stopped']));
  assert.deepEqual(work.rootIds.slice(0,2),[memberRoot,groupRoot]);
  assert.ok(work.nodes.find(n=>n.tabId==='file').parentId.endsWith('owner'));
  assert.equal(work.nodes.find(n=>n.tabId==='physical').contextParent.tabId,'owner','cross-group parent is context, physical relation remains');
  assert.deepEqual(work.groups.find(g=>g.id===group).memberTabIds,['file','owner']);
  assert.deepEqual(other.groups.find(g=>g.id===group).memberTabIds,['other-member']);
  assert.deepEqual(work.groups.find(g=>g.id===empty).memberTabIds,[]);
  assert.equal(dto.executionRefs.source.namespace,'legacy=');assert.equal(dto.executionRefs.source.subjectVersion,1);
  assert.equal(dto.executionRefs.file.namespace,NS);assert.equal(dto.executionRefs.file.subjectVersion,2);
  assert.ok(dto.executionRefs.file.aliases.some(alias=>alias.namespace===NS && alias.tabId==='file'));
  assert.equal(dto.rows.file.filePath,path.join(f.root,'synthetic.md'));
  assert.equal(dto.rows.physical.parentTabId,'owner');assert.equal(dto.rows.physical.visualParentTabId,null);
  assert.equal(dto.rows.archived,undefined);assert.equal(dto.provenance.find(p=>p.tabId==='archived').reason,'archived');
  assert.deepEqual(dto.excludedSignals,['runtime','cardSignals','history']);assert.equal(dto.sourceBindings,'tab');
  assert.deepEqual(f.db.prepare('SELECT * FROM tabs ORDER BY id').all(),baseline);
  assert.deepEqual(f.api.read(),rawBefore);assert.equal(f.calls.length,0);
  if(process.env.NOTED_CATALOG_PROOF_DIR){
    fs.writeFileSync(path.join(process.env.NOTED_CATALOG_PROOF_DIR,'catalog-example.json'),JSON.stringify(dto,null,2));
    fs.writeFileSync(path.join(process.env.NOTED_CATALOG_PROOF_DIR,'catalog-example-source.json'),JSON.stringify(rawBefore,null,2));
  }
});

test('catalog reads coalesce before capture and never reuse stale descriptor or order clocks', async t => {
  const f=await fixture(t,{legacy:true});
  f.api.createTab({mutationId:'v2',tabId:'v2',cwd:f.root,workflowId:'work',record:{name:'V2'}});
  let reads=0;const original=f.api.service.readState.bind(f.api.service);
  f.api.service.readState=()=>{reads++;return original();};
  const first=f.api.readCatalog(),joined=f.api.readCatalog();assert.equal(first,joined);
  f.db.prepare("UPDATE tabs SET name='latest before capture' WHERE tab_id='source'").run();
  const a=await first;assert.equal(await joined,a);assert.equal(reads,1);assert.ok(Object.isFrozen(a.rows.source));
  assert.equal(a.rows.source.name,'latest before capture');
  f.db.prepare("UPDATE tabs SET cwd=?,name='new live name' WHERE tab_id='source'").run(f.root+'/new');
  const b=await f.api.readCatalog();assert.equal(reads,2);
  assert.equal(a.clocks.organization.revision,b.clocks.organization.revision);
  assert.notEqual(a.clocks.descriptors.value,b.clocks.descriptors.value);
  assert.equal(b.executionRefs.source.cwd,f.root+'/new');assert.equal(a.rows.source.name,'latest before capture');
  f.database.setAppState('workspace-session',{openProjects:[{projectId:NS},{projectId:'legacy='}]});
  const c=await f.api.readCatalog();assert.notEqual(c.clocks.tree.value,b.clocks.tree.value);
  const previous=reads;
  const concurrent=await Promise.all(Array.from({length:8},()=>f.call('/api/workflow-organization?projection=catalog-v1')));
  assert.ok(concurrent.every(r=>r.status===200));
  assert.ok(reads-previous<8,'overlapping HTTP requests share a scheduled capture');
  assert.deepEqual(new Set(concurrent.map(r=>r.body.clocks.descriptors.value)),new Set([c.clocks.descriptors.value]));
  f.db.prepare('UPDATE workflow_group_meta SET version=99').run();
  await assert.rejects(f.api.readCatalog(),/groups_version_unsupported/);
  f.db.prepare('UPDATE workflow_group_meta SET version=1').run();
  assert.equal((await f.api.readCatalog()).version,1,'rejected flight does not poison future reads');
});

test('catalog fallback matches actual cold namespace/tab hydration and survives a fresh reader', async t => {
  const f=await fixture(t,{legacy:true});
  for(const [id,namespace,position,isUtility] of [['legacy-main','legacy=',8,false],['legacy-utility','legacy=',-1,true],['v2-last',NS,9,false],['v2-first',NS,1,true]])
    f.api.createTab({mutationId:id,tabId:id,executionNamespace:namespace,cwd:f.root,workflowId:'work',record:{name:id,position,isUtility}});
  f.database.setAppState('workspace-session',{openProjects:[{projectId:NS},{projectId:'legacy='}]});
  const hydrated=f.api.listNamespaces(),ids=[NS,'legacy='].flatMap(ns=>hydrated.find(p=>p.id===ns).tabs.map(t=>t.tabId));
  const before=await f.api.readCatalog();assert.deepEqual(before.workflows.find(w=>w.id==='work').memberTabIds,ids);
  const nextConnection=new Database(path.join(f.root,'owned.db'));
  try {
    const nextManager=new DatabaseManager({existingConnection:nextConnection});
    const next=createWorkflowOrganizationApi({database:nextManager});
    assert.deepEqual(await next.readCatalog(),before);
  } finally {nextConnection.close();}
});

test('workflow default directory applies to new creation only; explicit/source cwd keep priority', async t => {
  const f=await fixture(t,{legacy:true});
  const defaults=path.join(f.root,'workflow-default');fs.mkdirSync(defaults);
  const s=f.api.read();
  f.api.mutate('commitWorkspace',{mutationId:'default-directory',expectedRevision:s.publication.revision,
    spaces:s.workflows.map(w=>({...w.metadata,id:w.id,...(w.id==='work'?{defaultCwd:defaults}:{})})),
    tabWorkflowMembership:Object.fromEntries(s.tabs.map(tab=>[tab.tabId,{...tab.membership,expectedMembershipRevision:tab.membership.revision}]))});
  assert.equal((await freezeWorkflowCreationContext(f.projectManager,{},'work')).cwd,defaults);
  assert.equal((await freezeWorkflowCreationContext(f.projectManager,{sourceTabId:'source'},'work')).cwd,f.root);
  assert.equal((await freezeWorkflowCreationContext(f.projectManager,{cwd:f.root},'work')).cwd,f.root);
  assert.equal(f.db.prepare("SELECT cwd FROM tabs WHERE tab_id='source'").get().cwd,f.root);
  assert.equal((await f.api.readCatalog()).workflows.find(w=>w.id==='work').defaultCwd,defaults);
});
