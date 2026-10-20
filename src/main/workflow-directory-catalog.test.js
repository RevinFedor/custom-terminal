'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const http = require('node:http'), url = require('node:url'), vm = require('node:vm'), zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { directoryFixture } = require('./fixtures/workflow-directory-sqlite.cjs');
const { projectWorkflowCatalog } = require('../shared/workflow-catalog-projection.cjs');
const priorProjector = require('./fixtures/workflow-catalog-v1.preimage.cjs').projectWorkflowCatalog;
const { createDirectoryCursorCodec, prepareDirectoryCatalog, executionRefForInput, directoryReadRoute,
  sameDirectoryScope } = require('../shared/workflow-directory-catalog.cjs');
const { createWorkflowOrganizationHttp, workflowOrganizationCapability } = require('./workflow-organization-http');
const { createHttpReadDiagnostics } = require('./http-read-diagnostics');
const { createPublicTabActivity } = require('./public-tab-activity');
const { projectDirectoryRuntime, createDirectoryRuntimeReader } = require('./workflow-directory-runtime');
const codec = () => createDirectoryCursorCodec({ secret: Buffer.alloc(32, 7), sourceEpoch: 'fixture-source-epoch' });
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const basis = c => ({ sourceEpoch: c.sourceEpoch, catalogClock: c.catalogClock });
const captured = f => ({ snapshot: f.api.read(), namespaceOrder: ['__tab_catalog_v2__'], legacyNamespaces: [],
  aliases: f.db.prepare('SELECT namespace,tab_id AS tabId,global_tab_id AS globalTabId FROM workflow_org_aliases ORDER BY rowid').all() });
function family(f, n = 49) {
  f.add('root');
  for (let i = 0; i < n; i++) f.add('file-' + i, { tabType: 'file', filePath: path.join(f.directory, 'file-' + i + '.md'),
    visualParentTabId: 'root', notes: 'PRIVATE_RECORD_BODY', codexSessionId: 'PRIVATE_SAVED_SID' });
}
async function transport(t, f) {
  const records = [], diag = createHttpReadDiagnostics({ serviceId: 'fixture-service', detailPerMinute: 10000,
    log: line => records.push(JSON.parse(line.slice('[HttpRead] '.length))) });
  const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const start = web.indexOf('function sendJson('), end = web.indexOf('\nfunction sendTerminalBridgeError', start);
  const send = vm.runInNewContext(web.slice(start, end) + '\nsendJson', { httpReadDiagnostics: diag, readPerformance: performance,
    GZIP_THRESHOLD: 4096, zlib, Buffer, console: { log() {} } });
  const manager = { db: f.database, workflowOrganization: f.api };
  const handle = createWorkflowOrganizationHttp({ getProjectManager: () => manager,
    checkAuth: req => req.headers.authorization === 'Bearer fixture',
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); }, sendJson: send });
  let active = 0, peak = 0;
  const server = http.createServer((req, res) => { active++; peak = Math.max(peak, active); assert.ok(peak <= 2);
    res.once('close', () => active--);
    diag.run(req, res, () => handle(req, res, url.parse(req.url, true)).then(handled => { if (!handled) send(res, 404, { error: 'not_found' }); })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (route, body, auth = true, method = body ? 'POST' : 'GET') => new Promise((resolve, reject) => {
    const bytes = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { ...(auth ? { Authorization: 'Bearer fixture' } : {}), 'Accept-Encoding': 'gzip',
        'X-Noted-Read-Id': 'directory-read', 'X-Noted-Read-Attempt': 'directory-attempt',
        ...(bytes ? { 'Content-Length': Buffer.byteLength(bytes), 'Content-Type': 'application/json' } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const wire = Buffer.concat(chunks), decoded = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(wire) : wire;
        resolve({ status: res.statusCode, body: JSON.parse(decoded), headers: res.headers, wireBytes: wire.length, decodedBytes: decoded.length }); });
    }); req.on('error', reject); req.end(bytes);
  });
  return { call, diag, records, manager, peak: () => peak };
}

test('actual narrow SQL/capture preserves RAW/v1 JSON, full canonical order and provenance', async t => {
  const f = await directoryFixture(t); family(f, 8);
  f.add('ordinary', { parentTabId: 'root', isUtility: true, sessionStatus: 'stopped' });
  f.add('archived'); f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('archived');
  f.db.prepare("INSERT INTO workflow_org_tabs VALUES('unresolved',1,?, '{}',1)").run(JSON.stringify({ version: 1, projectId: 'missing', cwd: '/missing' }));
  const input = captured(f), prior = priorProjector(input), next = projectWorkflowCatalog(input);
  assert.equal(JSON.stringify(next), JSON.stringify(prior));
  const rawBefore = JSON.stringify(f.api.read()), v1Before = JSON.stringify(await f.api.readCatalog());
  const queries = []; f.db.onSql = sql => queries.push(sql);
  const [a, b] = await Promise.all([f.api.readCatalogV2(), f.api.readCatalogV2()]); f.db.onSql = null;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(queries.filter(sql => sql.includes('FROM workflow_org_workflows WHERE')).length, 1, 'one current directory capture');
  assert.ok(!queries.some(sql => /record_json|layout_json|workflow_org_aliases|workflow_group_contexts|SELECT \* FROM tabs/.test(sql)), queries.join('\n'));
  assert.deepEqual(a.workflows, next.workflows); assert.deepEqual(a.groups, next.groups);
  assert.deepEqual(Object.keys(a.index), Object.keys(next.rows));
  assert.equal(a.provenanceCounts.archived, 1); assert.equal(a.provenanceCounts.unresolved, 1);
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE_RECORD_BODY|PRIVATE_SAVED_SID|savedSessions|aliases/);
  assert.equal(JSON.stringify(f.api.read()), rawBefore); assert.equal(JSON.stringify(await f.api.readCatalog()), v1Before);
});

test('names/index phase never waits for runtime/cards; file rows do not enter the runtime producer', async t => {
  let runtimeCalls=0,cardsCalls=0,lastIds;
  const f=await directoryFixture(t,{readRuntime:entries=>{runtimeCalls++;lastIds=entries.map(e=>e.tabId);
    return {epoch:'unavailable-fixture',tabs:[],isCurrent:()=>false};},readCards:()=>{cardsCalls++;throw Error('cards unavailable');}});
  f.add('chat');f.add('file',{tabType:'file',filePath:'/missing-is-still-inventory'});
  const initial=await f.api.readCatalogV2();assert.deepEqual(Object.keys(initial.index).sort(),['chat','file']);
  assert.equal(runtimeCalls,0);assert.equal(cardsCalls,0);
  await f.api.readRuntimeSummary({...basis(initial),tabIds:['chat']});assert.deepEqual(lastIds,['chat']);
  await assert.rejects(f.api.readCardSignals({...basis(initial),tabIds:['chat']}),/cards unavailable/);
  assert.equal((await f.api.readCatalogV2()).catalogClock,initial.catalogClock);
});

test('first5/next20/final tail, repeated cursor and by-ID do not advance a server prefix', async t => {
  const f = await directoryFixture(t, { directoryOptions: { codec: codec() } }); family(f, 49);
  const initial = await f.api.readCatalogV2(), window = initial.fileWindows[0];
  assert.equal(Object.keys(initial.details).length, 6); assert.equal(window.total, 49); assert.equal(window.loaded, 5);
  const hidden = await f.api.readTabDetail('file-48', { ...basis(initial), workflowId: 'main' });
  assert.equal(hidden.detail.tabId, 'file-48'); assert.equal(hidden.executionTab, null);
  assert.equal((await f.api.readCatalogV2()).fileWindows[0].loaded, 5);
  let token = window.nextCursor, counts = [], nodes = [];
  while (token) { const page = await f.api.readFilePage({ cursor: token });
    assert.deepEqual(await f.api.readFilePage({ cursor: token }), page);
    assert.equal(page.requestCursor, token); assert.equal(page.start, 5 + nodes.length);
    counts.push(page.nodeIds.length); nodes.push(...page.nodeIds); token = page.nextCursor;
    assert.equal(page.remaining, 49 - page.loaded);
  }
  assert.deepEqual(counts, [20, 20, 4]); assert.deepEqual(nodes, window.nodeIds.slice(5));
  assert.equal(new Set(nodes).size, 44);
});

test('additive nativeDragExpected matches exact v1 pickup; unchanged Main capture has every hidden ref', async t => {
  const f = await directoryFixture(t); family(f, 30);
  const v2 = await f.api.readCatalogV2(), v1 = await f.api.readCatalog(), drag = f.api.nativeDrag;
  assert.deepEqual(v2.nativeDragExpected, { organizationRevision: v1.clocks.organization.revision,
    groupsRevision: v1.clocks.groups.revision, tree: v1.clocks.tree.value });
  assert.notEqual(v2.clocks.tree.value, v2.nativeDragExpected.tree);
  let calls = 0;
  drag.loadCompiler = () => ({ version: 1, captureNativeDrag(read, input) {
    calls++; assert.equal(Object.keys(read.dto.executionRefs).length, 31);
    assert.ok(read.dto.executionRefs['file-29']); assert.equal(Object.keys(v2.details).length, 6);
    return { admission: { sourceRootIds: [input.sourceId], familyIds: Object.keys(read.dto.executionRefs) } };
  } });
  const status = drag.status(), request = { version: 1, epoch: status.epoch, startedAt: status.serverTime,
    gestureId: 'fixture-pickup', workflowId: 'main', sourceId: 'reserve-tab:root', selectedTabIds: ['root'], expected: v2.nativeDragExpected };
  const pickup = await drag.capture(request); assert.equal(calls, 1); assert.equal(pickup.sourceFamilyIds.length, 31);
  assert.deepEqual(await drag.capture(request), pickup); assert.equal(calls, 1);
  await assert.rejects(drag.capture({ ...request, gestureId: 'wrong-v2-clock', expected: {
    ...request.expected, tree: v2.clocks.tree.value } }), /workflow_drag_pickup_changed/);
});

test('cursor HMAC/parent/epoch/clock/offset/previousID reject without retargeting', async t => {
  const c = codec(), f = await directoryFixture(t, { directoryOptions: { codec: c } }); family(f, 30);
  const initial = await f.api.readCatalogV2(), token = initial.fileWindows[0].nextCursor, data = c.decode(token);
  const changed = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  await assert.rejects(f.api.readFilePage({ cursor: changed }));
  for (const patch of [{ parentNodeId: 'other' }, { workflowId: 'other' }, { catalogClock: 'old' },
    { offset: 6 }, { offset: 0 }, { offset: 100 }, { afterNodeId: 'other' }]) {
    await assert.rejects(f.api.readFilePage({ cursor: c.encode({ ...data, ...patch }) }), /file_cursor_invalid|directory_catalog_changed/);
  }
  const foreign = createDirectoryCursorCodec({ secret: Buffer.alloc(32, 7), sourceEpoch: 'new-epoch' });
  await assert.rejects(f.api.readFilePage({ cursor: foreign.encode(data) }), /directory_source_changed/);
  assert.equal((await f.api.readFilePage({ cursor: token })).start, 5);
});

test('descriptor/name/path/provider/subject/cwd/storage/tree changes invalidate clock without org revision', async t => {
  const f = await directoryFixture(t); family(f, 7); const revision = f.api.read().publication.revision;
  for (const [column, value] of [['name','renamed'], ['file_path','/new-path'], ['command_type','claude'], ['cwd','/new-cwd'],
    ['execution_storage_revision',15], ['visual_parent_tab_id',null]]) {
    const old = await f.api.readCatalogV2();
    f.db.prepare('UPDATE tabs SET ' + column + '=? WHERE tab_id=?').run(value, 'file-6');
    const current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, old.catalogClock, column);
    await assert.rejects(f.api.readTabDetail('root', { ...basis(old), workflowId: 'main' }), /directory_catalog_changed/);
    assert.equal(f.api.read().publication.revision, revision);
  }
  const old = await f.api.readCatalogV2(), previous = f.api.service.getTab('file-6');
  assert.throws(() => f.db.prepare('UPDATE tabs SET execution_subject_id=? WHERE tab_id=?').run('new-subject', 'file-6'), /execution_subject_immutable/);
  f.db.transaction(() => {
    f.db.prepare('DELETE FROM tabs WHERE tab_id=?').run('file-6');
    f.database.createExecutionTabV2({ tabId: 'file-6', subjectId: 'new-subject', cwd: f.directory, record: { name: 'Replacement' } });
    f.db.prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?')
      .run(JSON.stringify({ ...previous.executionSubject, subjectId: 'new-subject', cwd: f.directory }), 'file-6');
  })();
  const replaced = await f.api.readCatalogV2(); assert.notEqual(replaced.catalogClock, old.catalogClock);
  assert.equal(replaced.details['file-6'].executionRef.subject.subjectId, 'new-subject');
  assert.equal(f.api.read().publication.revision, revision);
});

test('21 direct group/root files and nonleaf file/chat descendants stay reachable; ordinary chats are not capped', async t => {
  const f = await directoryFixture(t); f.add('root');
  for (let i = 0; i < 21; i++) f.add('standalone-' + i, { tabType: 'file', filePath: '/standalone-' + i,
    ...(i < 10 ? { visualParentTabId: 'root' } : {}) });
  for (let i = 0; i < 121; i++) f.add('chat-' + i, { visualParentTabId: 'root', commandType: i % 2 ? null : 'codex' });
  f.add('nonleaf', { tabType: 'file', filePath: '/structural', visualParentTabId: 'root' });
  f.add('descendant-chat', { visualParentTabId: 'nonleaf' });
  f.db.prepare("INSERT INTO workflow_global_groups(group_id,revision,metadata_json) VALUES('g',1,?)").run(JSON.stringify({ name: 'G' }));
  for (let i = 0; i < 10; i++) f.db.prepare("INSERT INTO workflow_group_memberships VALUES(?,'g',1)").run('standalone-' + i);
  const value = await f.api.readCatalogV2();
  assert.equal(Object.keys(value.index).length, 145); assert.equal(Object.keys(value.details).length, 145);
  assert.equal(value.fileWindows.length, 0);
  const nodes = value.workflows.find(w => w.id === 'main').nodes;
  assert.equal(nodes.find(n => n.tabId === 'descendant-chat').parentId, 'reserve-tab:nonleaf');
  assert.ok(nodes.some(n => n.kind === 'group'));
  assert.equal(nodes.find(n => n.tabId === 'standalone-0').contextParent.tabId, 'root');
  assert.notEqual(nodes.find(n => n.tabId === 'standalone-0').parentId, 'reserve-tab:root');
});

test('real HTTP auth, v1/RAW compatibility, exact read-only POST observation and unavailable capability', async t => {
  const f = await directoryFixture(t); family(f, 7); const s = await transport(t, f);
  assert.ok(workflowOrganizationCapability(f.api).catalogV2);
  assert.equal(workflowOrganizationCapability(f.api).catalogV2.windowPresentation, false);
  const initial = (await s.call('/api/workflow-organization?projection=catalog-v2')).body;
  assert.equal((await s.call('/api/workflow-organization?projection=catalog-v1')).body.projection, 'catalog-v1');
  const detail = '/api/tab-catalog/file-6/detail', body = { ...basis(initial), workflowId: 'main' };
  assert.equal((await s.call(detail, body, false)).status, 401);
  assert.equal((await s.call(detail, body)).status, 200);
  assert.equal((await s.call('/api/workflow-organization/file-page', { cursor: initial.fileWindows[0].nextCursor })).status, 200);
  assert.equal((await s.call('/api/workflow-organization/runtime-summary', { ...basis(initial), tabIds: ['root'] })).status, 200);
  assert.equal((await s.call('/api/workflow-organization/card-signals', { ...basis(initial), tabIds: ['root'] })).status, 200);
  assert.ok(s.records.some(e => e.route === '/api/tab-catalog/:id/detail' && e.event === 'http-finish'));
  for (const route of ['/api/terminal-tabs/t/send','/api/terminal-tabs/t/stop','/api/log','/api/workflow-organization/drag/preview',
    '/api/workflow-organization/mutations','/api/tab-catalog/file-6/move','/api/tab-catalog/file-6/detail/extra']) {
    assert.equal(directoryReadRoute('POST', route), null); const count = s.records.length; await s.call(route, {});
    assert.equal(s.records.length, count, route);
  }
  assert.doesNotMatch(JSON.stringify(s.records), /PRIVATE_RECORD_BODY|PRIVATE_SAVED_SID/);
  assert.equal(workflowOrganizationCapability({}).catalogV2, undefined);
  assert.equal((await s.call('/api/tab-catalog/file-6/detail', { ...body, path: '/arbitrary' })).status, 400);
});

test('page has no unapproved64KiB hard limit and never truncates a legitimate name', async t => {
  const f = await directoryFixture(t); family(f, 6);
  f.db.prepare('UPDATE tabs SET name=?,file_path=? WHERE tab_id=?').run('Ж'.repeat(70000), '/oversized-stored-descriptor/' + 'p'.repeat(70000), 'file-5');
  const s = await transport(t, f), initial = (await s.call('/api/workflow-organization?projection=catalog-v2')).body;
  const page = await s.call('/api/workflow-organization/file-page', { cursor: initial.fileWindows[0].nextCursor });
  assert.equal(page.status, 200); assert.ok(page.decodedBytes > 65536);
  assert.equal(initial.index['file-5'].name.length, 70000); assert.ok(page.body.details['file-5'].filePath.endsWith('p'.repeat(70000)));
});

test('v2 failure does not perform legacy heavy read; replacing the API owner during preview rejects old output', async t => {
  const entered = gate(), release = gate();
  const f = await directoryFixture(t, { directoryOptions: { previewFs: { stat: fs.promises.stat,
    async readFile(...args) { const content = await fs.promises.readFile(...args); entered.resolve(); await release.promise; return content; } } } });
  const file = path.join(f.directory, 'file.md'); fs.writeFileSync(file, 'CURRENT_OWNER'); f.add('file', { tabType: 'file', filePath: file });
  const s = await transport(t, f), initial = (await s.call('/api/workflow-organization?projection=catalog-v2')).body;
  const pending = s.call('/api/tab-catalog/file/file-preview', { ...basis(initial), workflowId: 'main' }); await entered.promise;
  s.manager.workflowOrganization = { ...f.api }; release.resolve();
  const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.error, 'directory_source_changed');
  let legacy = 0;
  s.manager.workflowOrganization = { ...f.api, readCatalog: () => { legacy++; throw Error('legacy forbidden'); },
    readCatalogV2: async () => { throw Object.assign(Error('directory_unavailable'), { code: 'directory_unavailable', statusCode: 503 }); } };
  assert.equal((await s.call('/api/workflow-organization?projection=catalog-v2')).status, 503); assert.equal(legacy, 0);
});

test('link/delete/move/reorder and empty namespace hydration order update the same current capture', async t => {
  const f = await directoryFixture(t); family(f, 7);
  let old = await f.api.readCatalogV2(); f.add('linked', { tabType: 'file', visualParentTabId: 'root', filePath: '/linked' });
  let current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, old.catalogClock);
  old = current; f.db.prepare("UPDATE workflow_org_memberships SET workflow_id='other' WHERE tab_id='linked'").run();
  current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, old.catalogClock);
  assert.equal(current.index.linked.membership.workflowId, 'other');
  old = current; f.db.prepare("UPDATE tabs SET execution_archived=1 WHERE tab_id='linked'").run();
  current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, old.catalogClock); assert.equal(current.index.linked, undefined);
  old = current; const workflow = f.api.service.getWorkflow('main');
  f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=? WHERE workflow_id=?')
    .run(JSON.stringify({ ...workflow.metadata, reserveOrder: ['root','file-6','file-5','file-4','file-3','file-2','file-1','file-0'] }), 'main');
  current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, old.catalogClock);
  assert.equal(current.fileWindows[0].nodeIds[0], 'reserve-tab:file-6');
});

test('one by-ID execution result reuses mapper/project header without full namespace inventory', async t => {
  const f = await directoryFixture(t); f.add('root', { notes: 'FULL_EXPLICIT_DETAIL', codexSessionId: 'EXPLICIT_SAVED_SID' });
  const initial = await f.api.readCatalogV2(); const queries = []; f.db.onSql = sql => queries.push(sql);
  f.database.getProjectById = () => { throw Error('full namespace forbidden'); };
  f.database.getExecutionNamespace = () => { throw Error('full scope forbidden'); };
  const detail = await f.api.readTabDetail('root', { ...basis(initial), workflowId: 'main' }); f.db.onSql = null;
  assert.equal(detail.executionTab.notes, 'FULL_EXPLICIT_DETAIL'); assert.equal(detail.executionTab.codexSessionId, 'EXPLICIT_SAVED_SID');
  assert.equal(detail.project.id, '__tab_catalog_v2__');
  assert.equal(queries.filter(sql => /^SELECT \* FROM tabs/.test(sql)).length, 1);
  assert.deepEqual(detail.executionTab, f.database.getExecutionTabV2({ executionNamespace: '__tab_catalog_v2__', tabId: 'root' }).tab);
});

test('legacy descriptors and hydration order change without storage/org revision; exact old mapper remains usable', async t => {
  const f = await directoryFixture(t); f.add('native');
  f.db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('legacy-ns', f.directory, 'Legacy');
  f.db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,notes,claude_session_id,is_utility) VALUES(?,?,?,?,?,?,?,?)')
    .run('legacy-ns','legacy','Legacy tab',f.directory,'claude','OLD_COMPLETE_NOTES','saved-explicit-detail',1);
  f.db.prepare('INSERT INTO workflow_org_tabs VALUES(?,1,?,?,1)').run('legacy', JSON.stringify({ version: 1, tabId: 'legacy', projectId: 'legacy-ns', cwd: f.directory }), '{}');
  f.db.prepare("INSERT INTO workflow_org_memberships VALUES('legacy','main',1)").run();
  f.database.setAppState('workspace-session', { openProjects: [{ projectId: 'legacy-ns' }, { projectId: '__tab_catalog_v2__' }],
    ignoredHeavyBody: 'x'.repeat(10000) });
  const fullBefore = await f.api.readCatalog();
  const original = f.database.getAppState.bind(f.database);
  f.database.getAppState = key => { if (key === 'workspace-session') throw Error('full workspace parse forbidden'); return original(key); };
  const first = await f.api.readCatalogV2(); assert.deepEqual(Object.keys(first.index), Object.keys(fullBefore.rows));
  const revision = f.api.read().publication.revision, storage = f.db.prepare("SELECT execution_storage_revision AS r FROM tabs WHERE tab_id='legacy'").get().r;
  f.db.prepare("UPDATE tabs SET name='New legacy name' WHERE tab_id='legacy'").run();
  const current = await f.api.readCatalogV2(); assert.notEqual(current.catalogClock, first.catalogClock);
  assert.equal(current.index.legacy.name, 'New legacy name'); assert.equal(f.api.read().publication.revision, revision);
  assert.equal(f.db.prepare("SELECT execution_storage_revision AS r FROM tabs WHERE tab_id='legacy'").get().r, storage);
  const detail = await f.api.readTabDetail('legacy', { ...basis(current), workflowId: 'main' });
  assert.equal(detail.executionTab.notes, 'OLD_COMPLETE_NOTES'); assert.equal(detail.executionTab.claudeSessionId, 'saved-explicit-detail');
  assert.equal(detail.executionTab.isUtility, true); assert.equal(detail.project.name, 'Legacy');
});

test('preview actual private file, old limits and binding replacement after held await', async t => {
  const released = gate(), entered = gate();
  const f = await directoryFixture(t, { directoryOptions: { previewFs: { stat: fs.promises.stat,
    async readFile(...args) { const content = await fs.promises.readFile(...args); entered.resolve(); await released.promise; return content; } } } });
  const file = path.join(f.directory, 'owned.md'); fs.writeFileSync(file, 'OWNED_FILE_CONTENT');
  f.add('file', { tabType: 'file', filePath: file }); f.add('missing-path', { tabType: 'file' });
  const initial = await f.api.readCatalogV2();
  await assert.rejects(f.api.readFilePreview('missing-path', { ...basis(initial), workflowId: 'main' }), /directory_file_binding_unavailable/);
  const pending = f.api.readFilePreview('file', { ...basis(initial), workflowId: 'main' }); await entered.promise;
  f.db.prepare('UPDATE tabs SET file_path=? WHERE tab_id=?').run('/replacement-owned-by-someone-else', 'file');
  released.resolve(); await assert.rejects(pending, /directory_catalog_changed/);
  f.db.prepare('UPDATE tabs SET file_path=? WHERE tab_id=?').run(file, 'file');
  const current = await f.api.readCatalogV2(), preview = await f.api.readFilePreview('file', { ...basis(current), workflowId: 'main' });
  assert.equal(preview.file.content, 'OWNED_FILE_CONTENT');
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(f.api.readFilePreview('file', { ...basis(current), workflowId: 'main' }), /directory_preview_too_large/);
  fs.writeFileSync(file, Buffer.alloc(400000, 255));
  const decoded=await f.api.readFilePreview('file',{...basis(current),workflowId:'main'});
  assert.equal(decoded.file.size,400000);assert.equal(decoded.file.content.length,400000,'limit is raw bytes, not replacement UTF8 size');
});

test('runtime aggregates full membership beyond selected rows; unknown is not false0 and stale address is not adopted', async t => {
  let changed = false;
  const f = await directoryFixture(t, { readRuntime: entries => ({ epoch: 'runtime-fixture',
    tabs: entries.map((entry, i) => ({ tabId: entry.tabId, executionScope: { ...executionRefForInput(entry).subject,
      ...(i === 2 ? { executionNamespace: 'foreign' } : {}) }, provider: 'codex',
      ownerToken: 'typed-owner', ownerOrder: { epoch: 'owner-epoch', revision: 1 },
      liveKnown: true, live: true, busyKnown: true, ownBusy: i === 0, inheritedBusy: i === 1,
      notificationKnown: true, notification: false })), isCurrent: () => !changed }) });
  for (let i = 0; i < 121; i++) f.add('chat-' + i);
  const initial = await f.api.readCatalogV2(), request = { ...basis(initial), tabIds: ['chat-0','chat-2'] };
  const runtime = await f.api.readRuntimeSummary(request), main = runtime.workflows.find(w => w.workflowId === 'main');
  assert.equal(main.nonFileCount, 121); assert.equal(main.liveKnown, false); assert.equal(main.liveCount, null);
  assert.equal(main.busyCount, null); assert.equal(runtime.tabs.length, 2); assert.equal(runtime.coverage.memberCount, 121);
  assert.equal(runtime.tabs.find(t => t.tabId === 'chat-2').liveKnown, false);
  assert.equal(runtime.workflows.find(w => w.workflowId === 'other').liveCount, 0);
  changed = true; const later = await f.api.readRuntimeSummary(request);
  assert.equal(later.tabs[0].liveKnown, false); assert.ok(later.revision > runtime.revision);
  await assert.rejects(f.api.readRuntimeSummary({ ...basis(initial), tabIds: Array(257).fill('chat-0') }), /directory_tab_scope_invalid/);
});

test('runtime/card await does not rebind a reply after membership/subject replacement', async t => {
  for (const method of ['readRuntimeSummary','readCardSignals']) {
    const entered=gate(),release=gate(); let f;
    const hold=async entries=>{const value=(method==='readRuntimeSummary'?f.runtime:f.cards)(entries);entered.resolve();await release.promise;return value;};
    f=await directoryFixture(t,method==='readRuntimeSummary'?{readRuntime:hold}:{readCards:hold});f.add('root');
    const initial=await f.api.readCatalogV2(),pending=f.api[method]({...basis(initial),tabIds:['root']});await entered.promise;
    f.db.prepare("UPDATE workflow_org_memberships SET workflow_id='other' WHERE tab_id='root'").run();release.resolve();
    await assert.rejects(pending,/directory_catalog_changed/);
  }
});

test('retained exact runtime proof distinguishes live/stopped/absent/unknown/rebound and old notification', () => {
  const entry = { tabId: 't', subjectVersion: 2, executionSubject: { version: 2, tabId: 't', subjectId: 's', executionNamespace: 'n', cwd: '/cwd' },
    nativeRow: { id: 1, cwd: '/cwd', command_type: 'codex' } };
  const state = { terminalPresent: true, sdkPresent: false, commandRunning: true, provider: 'codex', liveOwnerCount: 1,
    projectId: 'n', cwd: '/cwd',
    terminalId: 'pty', runSeq: 3, launchId: 'launch', lifecycleGeneration: 'g', ownBusy: true, pending: false,
    inheritedKnown: true, inheritedBusy: false, notification: null,
    stored: { token: 'owner', epoch: 'order', revision: 1, observationKnown: true,
      scope: { instanceId: 'main-epoch', provider: 'codex', executionScope: entry.executionSubject,
        projectId: 'n', cwd: '/cwd', terminalId: 'pty', runSeq: 3, launchId: 'launch' } } };
  assert.equal(projectDirectoryRuntime(entry, state, 'main-epoch').live, true);
  assert.equal(projectDirectoryRuntime(entry, { ...state, terminalId: 'replacement' }, 'main-epoch').liveKnown, false);
  assert.equal(projectDirectoryRuntime(entry, { ...state, cwd: '/physical-replacement' }, 'main-epoch').liveKnown, false);
  assert.equal(projectDirectoryRuntime({ ...entry, executionSubject: { ...entry.executionSubject, executionNamespace: 'new' } }, state, 'main-epoch').liveKnown, false);
  assert.equal(projectDirectoryRuntime(entry, { ...state, commandRunning: false, ownBusy: false }, 'main-epoch').live, false);
  assert.equal(projectDirectoryRuntime(entry, { ...state, commandRunning: false, lookupUnknown: true }, 'main-epoch').liveKnown, false);
  assert.equal(projectDirectoryRuntime(entry, { ...state, terminalPresent: false, liveOwnerCount: 0, commandRunning: null, ownBusy: false }, 'main-epoch').live, false);
  assert.equal(projectDirectoryRuntime(entry, { ...state, terminalPresent: false, lookupUnknown: true }, 'main-epoch').liveKnown, false);
  const notification = projectDirectoryRuntime(entry, { ...state, notification: { projectId: 'n', firedAt: 100 } }, 'main-epoch');
  assert.equal(notification.notificationKnown, false); assert.equal(notification.notification, null);
  let current = state; const reader = createDirectoryRuntimeReader({ epoch: 'main-epoch', capture: () => current });
  const sample = reader([entry]); current = { ...state, terminalId: 'new' }; assert.equal(sample.isCurrent(), false);
});

test('actual Main runtime/card declarations refuse stale retained subject despite a fresh SQL row/Fast proof', async t => {
  const f = await directoryFixture(t); f.add('root'); const entry = f.api.service.getTab('root');
  const ts = require('typescript'), source = fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
  const ast = ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true);
  const names = ['captureWorkflowDirectoryRuntime','captureWorkflowDirectoryCards','getProjectCardSignals','readMainCardFast'];
  const declarations = names.map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast)).join('\n');
  const term = {}, terminalId = new WeakMap([[term,'pty']]), commands = new Map([['root',{ isRunning:true,runSeq:3 }]]);
  const stored = { token:'owner',epoch:'order',revision:1,observationKnown:true,scope:{ instanceId:'conversation-instance',provider:'codex',
    executionScope:entry.executionSubject,projectId:entry.executionSubject.executionNamespace,cwd:f.directory,terminalId:'pty',runSeq:3,launchId:'launch' } };
  const scope = vm.createContext({ path,srcMainDir:__dirname,projectCardSignals:null,projectManager:{db:f.database},
    require: file => file === path.join(__dirname,'web-server') ? { readInheritedTabActivity:()=>({known:true,sourceTabIds:[]}) } : require(file),
    appRuntimeIdentity:{instanceId:'main'},computeProjectActivity:()=>({projects:[{tabs:[{tabId:'root',turnBusy:true}]}]}),
    agentSendActivity:{snapshot:()=>({pendingTabIds:[]})},conversationOwners:{instanceId:'conversation-instance',stored:()=>stored},
    terminals:new Map([['root',term]]),terminalCommandState:commands,terminalLifecycleEpochs:terminalId,
    terminalProjectIds:new Map([['root',entry.executionSubject.executionNamespace]]),terminalProjects:new Map([['root',f.directory]]),
    getLiveAiRuntimeOwners:()=>['codex'],getTerminalLifecycleGeneration:()=> 'generation',sdkSessions:new Map(),
    codexLastRunCommandPayload:new Map([['root',{launchId:'launch'}]]),claudeLaunchGenerationByTab:new Map(),tabCompletionNotifications:new Map(),
    tabWorkContext:{summaries:ids=>Object.fromEntries(ids.map(id=>[id,{known:true,revision:1,count:2}]))},
    getTaskStatusCatalog:()=>[],scheduleProjectActivityBroadcast:()=>{},resolveAiToolTypeForTab:()=> 'codex',
    getCurrentCodexServiceTierProofIdentity:()=>({success:true,ownerId:'writer',generationMode:'launch',generationId:'launch',
      launchId:'launch',terminalLifecycleGeneration:'generation',terminalRunSeq:3}),
    preserveCodexServiceTierProofForTurnEnd:()=>({preserved:true,proof:{serviceTier:'priority',source:'controlled-proof',proofAt:1}}),codexTuiReadyMeta:new Map() });
  vm.runInContext(declarations+'\nthis.runtime=captureWorkflowDirectoryRuntime;this.cards=captureWorkflowDirectoryCards;',scope);
  assert.equal(scope.runtime([entry]).tabs[0].live,true);
  assert.equal(scope.cards([entry]).tabs[0].fast.known,true);
  const captured = scope.runtime([entry]); stored.scope = {...stored.scope,executionScope:{...entry.executionSubject,executionNamespace:'foreign'}};
  assert.equal(captured.isCurrent(),false); assert.equal(scope.runtime([entry]).tabs[0].liveKnown,false);
  assert.equal(scope.cards([entry]).tabs[0].fast.known,false);
});

test('directory card subsets do not impersonate namespace coverage or invalidate each other on a read', () => {
  const {createProjectCardSignals}=require('./project-card-signals');
  const service=createProjectCardSignals({epoch:'cards',readTabs:(_ns,ids)=>ids.map(tabId=>({tabId,plan:{known:true,revision:0,items:[]}})),
    readPending:ids=>Object.fromEntries(ids.map(id=>[id,{known:true,revision:0,count:0}])),readCatalog:()=>({taskStatuses:[],taskStatusMarker:{shape:'dot',sizePx:8}}),
    readFast:()=>({known:false,enabled:null})});
  service.snapshot('namespace',['a'],{scope:'directory-v2'});service.snapshot('namespace',['b'],{scope:'directory-v2'});
  const revision=service.wake().revision;service.snapshot('namespace',['a'],{scope:'directory-v2'});
  assert.equal(service.wake().revision,revision);
  service.snapshot('namespace',['a','b'],{scope:'directory-v2'});const both=service.wake().revision;
  assert.deepEqual(service.snapshot('namespace',['b','a'],{scope:'directory-v2'}).tabs.map(t=>t.tabId),['b','a']);
  assert.equal(service.wake().revision,both);
});

test('bounded tab activity batch includes idle; old global remains the complete active set', () => {
  const service = createPublicTabActivity({ readState: () => ({ known: true, tabs: [
    { tabId: 'busy', projectId: 'n', ownBusy: true }, { tabId: 'idle', projectId: 'n', ownBusy: false }] }),
  readInherited: () => ({ known: true, sourceTabIds: [] }) });
  assert.deepEqual(service.capture().tabs.map(t => t.tabId), ['busy']);
  const batch = service.capture({ tabIds: ['busy','idle'] }); assert.equal(batch.activeSet, false); assert.equal(batch.tabs.length, 2);
  assert.equal(service.capture({ tabIds: ['missing'] }).known, false);
  for (const tabIds of [[], ['busy','busy'], Array(257).fill('busy'), 'busy']) assert.throws(() => service.capture({ tabIds }), /tab_activity_scope_invalid/);
});

test('synthetic complete wire examples are real current API/HTTP outputs, including final tail and unknown', async t => {
  let known=true;
  let f;
  f = await directoryFixture(t,{readRuntime:entries=>{const sample=f.runtime(entries);return {...sample,isCurrent:()=>known&&sample.isCurrent()};}});
  family(f, 38); fs.writeFileSync(path.join(f.directory,'file-0.md'),'# Synthetic preview\n'); const s = await transport(t, f);
  const initial = (await s.call('/api/workflow-organization?projection=catalog-v2')).body;
  const page = (await s.call('/api/workflow-organization/file-page', { cursor: initial.fileWindows[0].nextCursor })).body;
  const detail = (await s.call('/api/tab-catalog/root/detail', { ...basis(initial), workflowId: 'main' })).body;
  const runtime = (await s.call('/api/workflow-organization/runtime-summary', { ...basis(initial), tabIds: ['root'] })).body;
  const cards = (await s.call('/api/workflow-organization/card-signals', { ...basis(initial), tabIds: ['root'] })).body;
  const filePreview=(await s.call('/api/tab-catalog/file-0/file-preview',{...basis(initial),workflowId:'main'})).body;
  assert.equal(filePreview.file.content,'# Synthetic preview\n');
  const tail = (await s.call('/api/workflow-organization/file-page', { cursor: page.nextCursor })).body;
  known=false;const unknown=(await s.call('/api/workflow-organization/runtime-summary',{...basis(initial),tabIds:['root']})).body;
  assert.equal(unknown.tabs[0].liveKnown,false);assert.equal(unknown.workflows.find(w=>w.workflowId==='main').liveCount,null);
  assert.equal(page.nodeIds.length, 20); assert.equal(tail.nodeIds.length, 13); assert.equal(tail.nextCursor, null);
  if (process.env.CATALOG_FIXTURE_OUTPUT) {
    fs.mkdirSync(process.env.CATALOG_FIXTURE_OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.CATALOG_FIXTURE_OUTPUT, 'initial-page-detail-runtime-cards.json'), JSON.stringify({ initial, page, detail, runtime, cards, filePreview }, null, 2));
    fs.writeFileSync(path.join(process.env.CATALOG_FIXTURE_OUTPUT, 'tail-page-detail-runtime-cards.json'), JSON.stringify({ initial, page: tail, detail, runtime:unknown, cards, filePreview }, null, 2));
  }
});
