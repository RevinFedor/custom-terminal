'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http'), url = require('node:url'), zlib = require('node:zlib'), ts = require('typescript');
const { createHash } = require('node:crypto'), { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const { directoryFixture } = require('./fixtures/workflow-directory-sqlite.cjs');
const { mainCards } = require('./fixtures/directory-appearance-main.cjs');
const { readDirectoryAppearance } = require('./directory-appearance');
const { createWorkflowOrganizationHttp } = require('./workflow-organization-http');
const { createHttpReadDiagnostics } = require('./http-read-diagnostics');
const plain = value => JSON.parse(JSON.stringify(value));
const basis = value => ({ sourceEpoch: value.sourceEpoch, catalogClock: value.catalogClock });
const key = field => 'noted-terminal-' + field;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const customStatuses = [{ id: 'dev', label: 'Моя разработка🌱', color: '#123456', description: 'not transmitted' }];
const customBar = { colorA: '#112233', shimmerColor: '#445566', inheritedColor: '#778899',
  shimmerSpacingPct: 73, shimmerOpacityPct: 36, position: 'right' };
function settings(database) {
  database.setAppState(key('session-statuses'), customStatuses);
  database.setAppState(key('status-marker'), { shape: 'square', sizePx: 13 });
  database.setAppState(key('process-bar'), customBar);
}
async function setup(t, options = {}) {
  let h; const f = await directoryFixture(t, { readCards: entries => options.readCards
    ? options.readCards(h, entries) : h.capture(entries) });
  h = mainCards(f.database, { ...options, ...(process.env.DIRECTORY_APPEARANCE_MAIN_PREIMAGE
    ? { sourceText: fs.readFileSync(process.env.DIRECTORY_APPEARANCE_MAIN_PREIMAGE, 'utf8') } : {}) }); return { f, h };
}
async function server(t, f) {
  const records = [], diag = createHttpReadDiagnostics({ serviceId: 'appearance-service', detailPerMinute: 10000,
    log: line => records.push(JSON.parse(line.slice('[HttpRead] '.length))) });
  const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const start = web.indexOf('function sendJson('), end = web.indexOf('\nfunction sendTerminalBridgeError', start);
  const sendJson = vm.runInNewContext(web.slice(start, end) + '\nsendJson', { httpReadDiagnostics: diag,
    readPerformance: performance, zlib, Buffer, GZIP_THRESHOLD: 4096, console: { log() {} } });
  const handler = createWorkflowOrganizationHttp({ getProjectManager: () => ({ db: f.database, workflowOrganization: f.api }),
    checkAuth: req => req.headers.authorization === 'Bearer private-appearance', sendJson,
    readBody: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); } });
  let active = 0, peak = 0, count = 0;
  const listener = http.createServer((req, res) => {
    count++; active++; peak = Math.max(peak, active); assert.ok(peak <= 2); res.once('close', () => active--);
    diag.run(req, res, () => handler(req, res, url.parse(req.url, true)).then(handled => { if (!handled) sendJson(res, 404, { error: 'not_found' }); }));
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { listener.closeAllConnections(); listener.close(resolve); }));
  const call = (route, body, auth = true) => new Promise((resolve, reject) => {
    const bytes = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: listener.address().port, path: route, method: bytes ? 'POST' : 'GET',
      headers: { 'Accept-Encoding': 'gzip', 'X-Noted-Read-Attempt': 'appearance-attempt',
        ...(auth ? { authorization: 'Bearer private-appearance' } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const wire = Buffer.concat(chunks), decoded = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(wire) : wire;
        assert.equal(Number(res.headers['content-length']), wire.length);
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(decoded), wireBytes: wire.length,
          decodedBytes: decoded.length, wireSha256: hash(wire), decodedSha256: hash(decoded) }); });
    }); req.on('error', reject); req.end(bytes);
  });
  return { call, records, diag, peak: () => peak, count: () => count };
}
const route = '/api/workflow-organization/card-signals';

test('actual Main producer exposes category palette/marker and complete custom process style, not task IDs', async t => {
  const { f, h } = await setup(t); f.add('chat', { sessionStatus: 'dev' }); settings(f.database);
  f.db.prepare('UPDATE tabs SET session_status=? WHERE tab_id=?').run('dev','chat');
  const initial = await f.api.readCatalogV2(), cards = await f.api.readCardSignals({ ...basis(initial), tabIds: ['chat'] });
  const appearance = cards.directoryAppearance;
  assert.equal(appearance?.sessionStatuses?.known, true, 'actual Main must publish the known user category palette');
  assert.equal(appearance.version, 1); assert.deepEqual(plain(appearance.sessionStatuses.value), customStatuses.map(({ id,label,color }) => ({ id,label,color })));
  assert.deepEqual(plain(appearance.statusMarker.value), { shape: 'square', sizePx: 13 });
  assert.deepEqual(plain(appearance.processBar.value), customBar);
  for (const [name, source] of Object.entries({ sessionStatuses:'desktop-sessionStatuses', statusMarker:'desktop-statusMarker', processBar:'desktop-processBar' })) {
    assert.deepEqual([appearance[name].known,appearance[name].stale,appearance[name].source,appearance[name].settingsSource,appearance[name].reason], [true,false,source,'persisted',null]);
  }
  assert.equal(initial.index.chat.sessionStatus, 'dev'); assert.equal(cards.taskStatuses[0].id, 'task-dev');
  assert.equal(cards.directoryAppearance.sessionStatuses.value[0].id, 'dev');
  assert.equal(cards.producerEpoch, h.service().wake().epoch); assert.equal(cards.producerRevision, h.service().wake().revision);
  assert.equal(cards.tabs[0].fast.known, false); assert.doesNotMatch(JSON.stringify(appearance), /executionRef|inputReady|turnBusy|description|task-dev/);
});

test('missing exact SQL keys use real desktop defaults; explicit [] is known empty, not missing', async t => {
  const { f } = await setup(t); const missing = readDirectoryAppearance(f.database);
  assert.equal(missing.sessionStatuses.value[0].id, 'dev'); assert.equal(missing.processBar.value.inheritedColor, '#A855F7');
  for (const field of ['sessionStatuses','statusMarker','processBar']) assert.equal(missing[field].settingsSource, 'desktop-defaults');
  f.database.setAppState(key('session-statuses'), []);
  const empty = readDirectoryAppearance(f.database); assert.deepEqual(empty.sessionStatuses.value, []);
  assert.equal(empty.sessionStatuses.known, true); assert.equal(empty.sessionStatuses.settingsSource, 'persisted');
  f.database.setAppState(key('session-statuses'), 'null'); assert.equal(readDirectoryAppearance(f.database).sessionStatuses.known, false);
});

test('malformed and failed settings are independent unknown/null, never a healthy empty/default replacement', async t => {
  const { f } = await setup(t); settings(f.database);
  for (const bad of ['bad json', '{}', '[null]', '[{"id":"dev","label":"x","color":3}]',
    '[{"id":"a","label":"x","color":"red"},{"id":"a","label":"y","color":"blue"}]']) {
    f.database.setAppState(key('session-statuses'), bad); const appearance = readDirectoryAppearance(f.database);
    assert.deepEqual([appearance.sessionStatuses.known,appearance.sessionStatuses.value,appearance.sessionStatuses.reason], [false,null,'malformed-setting']);
    assert.equal(appearance.statusMarker.known, true); assert.equal(appearance.processBar.known, true);
  }
  settings(f.database);
  for (const [field, values] of [['status-marker',[[],null,{shape:'triangle'},{sizePx:'8'},{sizePx:Infinity}]],
    ['process-bar',[[],null,{position:'top'},{inheritedColor:null},{shimmerSpacingPct:'30'},{shimmerOpacityPct:NaN}]]]) {
    for (const value of values) { f.database.setAppState(key(field), value); const appearance = readDirectoryAppearance(f.database);
      const slot = appearance[field === 'process-bar' ? 'processBar' : 'statusMarker'];
      assert.equal(slot.known, false); assert.equal(slot.value, null); assert.equal(appearance.sessionStatuses.known, true); }
  }
  settings(f.database);
  f.db.onSql = sql => { if (sql === 'SELECT value FROM app_state WHERE key = ?') throw Error('private unavailable SQL'); };
  const failed = readDirectoryAppearance(f.database); f.db.onSql = null;
  for (const field of ['sessionStatuses','statusMarker','processBar']) {
    assert.equal(failed[field].known,false); assert.equal(failed[field].value,null); assert.equal(failed[field].reason,'settings-read-failed');
  }
});

test('actual useUIStore defaults/legacy normalization agree; malformed divergence is intentionally unknown', async t => {
  const { f } = await setup(t), ui = fs.readFileSync(path.join(__dirname,'../renderer/store/useUIStore.ts'),'utf8');
  const ast = ts.createSourceFile('ui.ts',ui,ts.ScriptTarget.Latest,true);
  const names = ['DEFAULT_SESSION_STATUSES','DEFAULT_STATUS_MARKER','DEFAULT_PROCESS_BAR','loadSessionStatuses','loadStatusMarker','loadProcessBar'];
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? names.includes(node.name?.text)
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(ast))));
  assert.equal(selected.length,6);
  const raw = new Map(), ctx = vm.createContext({ localStorage: { getItem: k => raw.get(k) ?? null } });
  vm.runInContext(ts.transpileModule(selected.map(n=>n.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  for (const value of [null, {}, {colorA:'#abcdef',colorB:'#legacy'}, customBar,
    {shimmerSpacingPct:4.3,shimmerOpacityPct:101,position:'left'}]) {
    if (value === null) { raw.delete(key('process-bar')); f.database.deleteAppState(key('process-bar')); }
    else { raw.set(key('process-bar'),JSON.stringify(value)); f.database.setAppState(key('process-bar'),value); }
    assert.deepEqual(readDirectoryAppearance(f.database).processBar.value,plain(ctx.loadProcessBar()));
  }
  assert.deepEqual(readDirectoryAppearance(f.database).sessionStatuses.value,plain(ctx.loadSessionStatuses()).map(({id,label,color})=>({id,label,color})));
  for (const value of [{},{shape:'square',sizePx:40},{shape:'dot',sizePx:7.8}]) {
    raw.set(key('status-marker'),JSON.stringify(value));f.database.setAppState(key('status-marker'),value);
    assert.deepEqual(readDirectoryAppearance(f.database).statusMarker.value,plain(ctx.loadStatusMarker()));
  }
});

test('actual settings IPC writes and mirror delete wake existing cards clock/debounce, not a new queue', async t => {
  const { f, h } = await setup(t); h.service();
  for (const name of ['app:setState','app:setStateSync','app:mirrorLocalStorageSync']) {
    for (const field of ['session-statuses','status-marker','process-bar']) {
      const before = h.service().wake().revision, event = { sender: { id: 7 } };
      const value = field === 'session-statuses' ? [] : field === 'status-marker' ? {shape:'square',sizePx:9} : customBar;
      const reply = await h.handlers.get(name)(event,{ key:key(field), value:name === 'app:mirrorLocalStorageSync' ? JSON.stringify(value) : value });
      assert.equal((reply || event.returnValue).success,true); assert.equal(h.service().wake().revision,before+1);
      assert.equal(h.service().wake().allProjects,true); assert.equal(h.timers.length,1,'existing one coalesced wake');
    }
    assert.equal(h.timers[0].ms,80); h.flush(); assert.equal(h.frames.at(-1).reason,'card-signals');
  }
  const before = h.service().wake().revision;
  h.handlers.get('app:mirrorLocalStorageSync')({}, {key:key('session-statuses'),value:null});
  assert.equal(h.service().wake().revision,before+1); assert.equal(readDirectoryAppearance(f.database).sessionStatuses.settingsSource,'desktop-defaults');
  h.scope.noteCardSignalSettingsChanged('unrelated-setting'); assert.equal(h.service().wake().revision,before+1);
});

test('settings persistence failure never sends a healthy settings wake or changes prior SQL appearance', async t => {
  const { f, h } = await setup(t); settings(f.database); h.service(); const before = plain(readDirectoryAppearance(f.database));
  const revision = h.service().wake().revision, saved = f.database.setAppState;
  f.database.setAppState = () => { throw Error('write rejected'); };
  const event = {}; h.handlers.get('app:mirrorLocalStorageSync')(event,{key:key('process-bar'),value:'{}'});
  f.database.setAppState = saved;
  assert.equal(event.returnValue.success,false); assert.equal(h.service().wake().revision,revision);
  assert.deepEqual(readDirectoryAppearance(f.database),before);
});

test('global appearance fingerprint survives crossed subsets/[] and discovers offline SQL changes', async t => {
  const { f,h } = await setup(t); f.add('a'); f.add('b'); settings(f.database);
  const a = h.capture([f.api.service.getTab('a')]), base = h.service().wake().revision;
  h.capture([f.api.service.getTab('b')]); h.capture([]); assert.equal(h.service().wake().revision,base);
  f.database.setAppState(key('process-bar'),{...customBar,position:'left'});
  assert.equal(a.isCurrent(),false,'after-await read observes even a missed settings wake');
  const b = h.capture([f.api.service.getTab('b')]); assert.ok(b.revision>base);
  assert.equal(h.service().wake().allProjects,true); assert.equal(b.directoryAppearance.processBar.value.position,'left');
  const now = b.revision; h.capture([]); h.capture([f.api.service.getTab('a')]); assert.equal(h.service().wake().revision,now);
});

test('after-await settings and physical owner changes reject old cards; a fresh read uses current style', async t => {
  for (const change of ['settings-wake','offline-setting','physical-owner']) {
    const entered=gate(), release=gate();
    const { f,h } = await setup(t,{readCards:async (owner,entries)=>{const result=owner.capture(entries);entered.resolve();await release.promise;return result;}});
    f.add('chat');settings(f.database);const initial=await f.api.readCatalogV2();
    const pending=f.api.readCardSignals({...basis(initial),tabIds:['chat']});await entered.promise;
    if(change==='physical-owner')h.replaceOwner();else{
      f.database.setAppState(key('process-bar'),{...customBar,position:'left'});
      if(change==='settings-wake')h.scope.noteCardSignalSettingsChanged(key('process-bar'));
    }
    release.resolve();await assert.rejects(pending,/directory_card_owner_changed/);
    if(change!=='physical-owner'){
      const fresh=await f.api.readCardSignals({...basis(initial),tabIds:['chat']});assert.equal(fresh.directoryAppearance.processBar.value.position,'left');
    }
  }
});

test('settings changed during directory recapture cannot slip past final Main appearance check', async t => {
  const {f,h}=await setup(t);f.add('chat');settings(f.database);const initial=await f.api.readCatalogV2();
  let reads=0;f.db.onSql=sql=>{if(sql.includes('FROM workflow_org_workflows WHERE')&&++reads===2)
    f.database.setAppState(key('status-marker'),{shape:'dot',sizePx:5});};
  await assert.rejects(f.api.readCardSignals({...basis(initial),tabIds:['chat']}),/directory_card_owner_changed/);f.db.onSql=null;
});

test('normal/[]/malformed cards over real privateHTTP preserve names/v1/raw, auth and exact trace effect', async t => {
  const {f,h}=await setup(t);f.add('chat',{sessionStatus:'dev'});for(let i=0;i<7;i++)f.add('file'+i,{tabType:'file',filePath:'/private-fixture-'+i,visualParentTabId:'chat'});
  settings(f.database);const raw=JSON.stringify(f.api.read()),v1=JSON.stringify(await f.api.readCatalog());
  const s=await server(t,f),initial=await s.call('/api/workflow-organization?projection=catalog-v2');
  assert.equal(h.runtimeCalls(),0,'initial names do not invoke cards or runtime');
  const request={...basis(initial.body),tabIds:[]};
  assert.equal((await s.call(route,request,false)).status,401);
  const normal=await s.call(route,{...request,tabIds:['chat']}),zero=await s.call(route,request);
  assert.equal(normal.status,200);assert.equal(zero.status,200);assert.deepEqual(zero.body.tabs,[]);
  assert.deepEqual(normal.body.directoryAppearance,zero.body.directoryAppearance);assert.equal(zero.body.producerRevision,normal.body.producerRevision);
  f.database.setAppState(key('session-statuses'),[]);h.scope.noteCardSignalSettingsChanged(key('session-statuses'));
  const empty=await s.call(route,request);assert.deepEqual(empty.body.directoryAppearance.sessionStatuses.value,[]);
  assert.ok(empty.body.producerRevision>zero.body.producerRevision);assert.ok(empty.body.revision>zero.body.revision);
  f.database.setAppState(key('session-statuses'),'malformed');h.scope.noteCardSignalSettingsChanged(key('session-statuses'));
  const unknown=await s.call(route,request);assert.equal(unknown.status,200);assert.equal(unknown.body.directoryAppearance.sessionStatuses.known,false);
  assert.equal(unknown.body.directoryAppearance.sessionStatuses.value,null);assert.equal(unknown.body.directoryAppearance.processBar.known,true);
  assert.equal((await s.call('/api/workflow-organization?projection=catalog-v2')).body.catalogClock,initial.body.catalogClock);
  assert.equal(JSON.stringify(f.api.read()),raw);assert.equal(JSON.stringify(await f.api.readCatalog()),v1);
  assert.equal((await s.call(route,{...request,catalogClock:'old'})).status,409);
  for(const path of ['/api/terminal-tabs/chat/send','/api/terminal-tabs/chat/stop','/api/log','/api/workflow-organization/drag/preview']){
    const before=s.records.length;await s.call(path,{});assert.equal(s.records.length,before,'mutation still not observed');
  }
  assert.equal(s.diag.snapshot().active.length,0);assert.equal(s.records.filter(x=>x.terminal).length,s.records.filter(x=>x.event==='http-enter').length);
  assert.equal(Object.values(s.diag.snapshot().losses).reduce((a,b)=>a+b,0),0);assert.ok(s.peak()<=2);
  if(process.env.DIRECTORY_APPEARANCE_WIRE_OUTPUT)fs.writeFileSync(process.env.DIRECTORY_APPEARANCE_WIRE_OUTPUT,JSON.stringify({
    schema:1,synthetic:true,initial:initial.body,cards:normal.body,aggregateOnly:zero.body,explicitEmpty:empty.body,unknown:unknown.body,
    transport:{normal:{...normal,body:undefined},peakHTTP:s.peak(),httpCount:s.count(),losses:s.diag.snapshot().losses}},null,2)+'\n');
});

test('held realHTTP card read does not block names; settings change returns409 without retry or fallback', async t => {
  const entered=gate(),release=gate();let held=true;
  const {f,h}=await setup(t,{readCards:async(owner,entries)=>{const value=owner.capture(entries);if(held){entered.resolve();await release.promise;}return value;}});
  f.add('chat');settings(f.database);const s=await server(t,f),initial=(await s.call('/api/workflow-organization?projection=catalog-v2')).body;
  const body={...basis(initial),tabIds:[]},pending=s.call(route,body);await entered.promise;
  assert.equal((await s.call('/api/workflow-organization?projection=catalog-v2')).status,200);assert.equal(s.peak(),2);
  f.database.setAppState(key('process-bar'),{...customBar,position:'left'});h.scope.noteCardSignalSettingsChanged(key('process-bar'));release.resolve();
  const stale=await pending;assert.equal(stale.status,409);assert.equal(stale.body.error,'directory_card_owner_changed');
  held=false;const fresh=await s.call(route,body);assert.equal(fresh.status,200);assert.equal(fresh.body.directoryAppearance.processBar.value.position,'left');
  assert.equal(s.count(),4,'one failed POST and only the explicit next read, no automatic retry/fallback');
});

test('appearance reader uses only3 exact small SQL rows and legacy card snapshot remains unchanged', async t => {
  const {f,h}=await setup(t);f.add('chat');settings(f.database);const queries=[];f.db.onSql=sql=>queries.push(sql);
  readDirectoryAppearance(f.database);f.db.onSql=null;assert.equal(queries.length,3);
  assert.ok(queries.every(sql=>sql==='SELECT value FROM app_state WHERE key = ?'));
  const legacy=h.service().snapshot('__tab_catalog_v2__',['chat']);assert.equal(legacy.directoryAppearance,undefined);
  assert.equal(h.capture([]).directoryAppearance.processBar.value.position,'right');
});

test('legacy card projection remains byte-equal to exact prior producer across settings and plan changes', () => {
  // Frozen small module, not a replacement Main or old whole-file deployment.
  const oldSource=fs.readFileSync(path.join(__dirname,'fixtures/project-card-signals-appearance-preimage.cjs'),'utf8');
  const module={exports:{}};vm.runInNewContext(oldSource,{module,exports:module.exports,require:createRequire(path.join(__dirname,'project-card-signals.js'))});
  const {createProjectCardSignals}=require('./project-card-signals');let count=0,palette=[];
  const ports={epoch:'same-producer',readTabs:(_project,ids)=>ids.map(tabId=>({tabId,plan:{known:true,revision:count,items:[]}})),
    readPending:ids=>Object.fromEntries(ids.map(id=>[id,{known:true,revision:count,count}])),
    readFast:()=>({known:false,enabled:null}),readCatalog:()=>({taskStatuses:palette,taskStatusMarker:{shape:'square',sizePx:11}})};
  const old=module.exports.createProjectCardSignals(ports),current=createProjectCardSignals({...ports,readDirectoryAppearance:()=>{throw Error('legacy must not read appearance');}});
  for(const ids of [['a'],['b'],[],['b','a'],['a']]){
    assert.equal(JSON.stringify(current.snapshot('namespace',ids)),JSON.stringify(old.snapshot('namespace',ids)));
    count++;palette=[{id:'task-dev',label:'TASK ONLY',color:'#abcdef'}];
  }
});
