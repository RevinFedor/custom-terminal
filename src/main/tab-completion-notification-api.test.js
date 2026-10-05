'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { completionNotificationCapability, completionNotificationRequest } = require('./tab-completion-notification-api');
const root = path.join(__dirname, '../renderer');
const storeSource = fs.readFileSync(path.join(root, 'store/useWorkspaceStore.ts'), 'utf8');
const storeAst = ts.createSourceFile('store.ts', storeSource, ts.ScriptTarget.Latest, true);
const appSource = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
const appAst = ts.createSourceFile('app.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const webAst = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
const pick = (tree, predicate) => { let value; const visit = n => { if (!value && predicate(n)) value = n; if (!value) ts.forEachChild(n, visit); }; visit(tree); assert.ok(value); return value.getText(tree); };
const method = name => pick(storeAst, n => ts.isPropertyAssignment(n) && n.name.getText(storeAst) === name);
const variable = name => pick(storeAst, n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(storeAst) === name));
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: () => resolve() }; };

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-api-'));
  const db = new DatabaseManager({ existingConnection: new SQLite(path.join(dir, 'app.db')) }); db.initTables();
  db.db.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run('P','private',dir);
  db.saveTabs('P', [{ tabId: 'T', name: 'T', cwd: dir, tabType: 'terminal' },
    { tabId: 'F', name: 'F', cwd: dir, tabType: 'file' }]);
  const tab = { id: 'T', tabId: 'T', tabType: 'terminal', name: 'private', cwd: dir };
  const fileTab = { id: 'F', tabId: 'F', tabType: 'file', name: 'file', cwd: dir };
  const workspace = { projectId: 'P', tabs: new Map([['T',tab],['F',fileTab]]) };
  const state = { openProjects: new Map([['P',workspace]]) };
  const { createProjectTabSaveQueue } = await import('../renderer/utils/projectTabSaveQueue.mjs');
  const { createTabCompletionNotificationBridge } = await import('../renderer/utils/tabCompletionNotificationBridge.mjs');
  const queue = createProjectTabSaveQueue();
  let saveGate = null, saveFailure = false, bridgeFailure = false, lastBridge = null;
  const events = [], saves = [];
  const ctx = vm.createContext({ get: () => state, set: value => Object.assign(state, value), Map, console: { warn() {} },
    projectTabSaveQueue: queue, projectTabSaveRevisions: new Map(), dndShortId: value => value,
    logRestartAfterState() {},
    emitTabCompletionNotificationCleared: detail => events.push(['cleared',detail]),
    emitTabCompletionNotificationStateChanged: detail => events.push(['state',detail]),
    ipcRenderer: { invoke: async (channel, payload) => {
      assert.equal(channel, 'project:save-tabs'); saves.push(payload);
      if (saveGate) await saveGate.promise;
      if (saveFailure) return { success: false, error: 'fixture-save-failed' };
      db.saveTabs(payload.projectId, payload.tabs, payload.forceCleanup);
      return { success: true };
    } },
  });
  vm.runInContext(transpile(variable('saveTabs') + '\nglobalThis.actions = ({'
    + ['setTabCompletionNotificationArmed','setTabCompletionNotificationPersistent','clearTabCompletionNotification'].map(method).join(',') + '});'), ctx);
  Object.assign(state, ctx.actions);
  const adapter = createTabCompletionNotificationBridge({ getState: () => state, persistencePending: id => queue.pending(id), epoch: 'renderer-1' });
  const branch = pick(appAst, n => ts.isIfStatement(n) && n.expression.getText(appAst).startsWith("action === 'getTabCompletionNotification'"));
  const renderer = vm.runInNewContext(transpile('(async (action,payload) => { const reply = (_ok,data) => data;' + branch + '})'),
    { completionNotificationBridge: adapter });
  const clearBranch = pick(appAst, n => ts.isIfStatement(n) && n.expression.getText(appAst) === "action === 'clearTabCompletionNotification'");
  const clearRenderer = vm.runInNewContext(transpile('(async (action,payload) => { const reply = (_ok,data) => data;' + clearBranch + '})'), { state });
  const bridge = async (action, payload) => {
    lastBridge = { action, payload };
    if (bridgeFailure) throw Object.assign(new Error('fixture timeout'), { code: 'bridge_timeout' });
    return action === 'clearTabCompletionNotification' ? clearRenderer(action, payload) : renderer(action, payload);
  };
  const start = web.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/completion-notification$/);');
  const end = web.indexOf('  // Legacy Claude-only alias.', start);
  assert.ok(start > 0 && end > start);
  const route = vm.runInNewContext('(async (req,res,parsed) => { let m;' + web.slice(start, end) + '\nres.writeHead(404);res.end("{}");})', {
    completionNotificationRequest, decId: decodeURIComponent, bridgeRequest: bridge,
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); },
    require: name => { assert.equal(name,'./project-manager'); return { db }; },
    sendJson: (res,status,data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    sendTerminalBridgeError: (res,error) => { res.writeHead(503); res.end(JSON.stringify({error:error.message})); },
  });
  const server = http.createServer((req,res) => route(req,res,new URL(req.url,'http://fixture')).catch(e => { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const request = async (method = 'GET', body, id = 'T', suffix = '', raw = false) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/terminal-tabs/${id}/completion-notification${suffix}`,
      { method, ...(body ? { body: raw ? body : JSON.stringify(body) } : {}) });
    const text = await r.text(); return { status: r.status, data: JSON.parse(text), bytes: Buffer.byteLength(text) };
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  return { db, tab, state, events, adapter, saves, request, queue, lastBridge: () => lastBridge,
    hold: () => { saveGate = deferred(); return saveGate; }, failSave: value => { saveFailure = value; },
    failBridge: value => { bridgeFailure = value; } };
}

test('actual HTTP → App bridge → workspace setters: both explicit modes and strict persistence', async t => {
  const h = await harness(t); const initial = await h.request();
  assert.equal(initial.status,200); assert.equal(initial.data.completionNotificationPersistent,false);
  for (const mode of ['oneshot','persistent']) for (const enabled of [true,true,false,false]) {
    const r = await h.request('POST',{mode,enabled});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.completionNotificationArmed,enabled);
    assert.equal(r.data.completionNotificationPersistent, mode === 'persistent' ? enabled : false);
    assert.equal(h.lastBridge().payload.projectId,'P');
    if (mode === 'persistent') {
      assert.equal(r.data.persistentCommitted,true); assert.equal(r.data.persistentDurable,true);
      assert.equal(h.db.getTabCompletionNotificationPreference('T').persistent, enabled ? 1 : 0);
    }
  }
  assert.ok(initial.bytes < 800);
});

test('oneshot off and legacy clear preserve persistent; persistent off clears armed/fired', async t => {
  const h = await harness(t); await h.request('POST',{mode:'persistent',enabled:true});
  let r = await h.request('POST',{mode:'oneshot',enabled:false});
  assert.equal(r.data.completionNotificationPersistent,true); assert.equal(r.data.completionNotificationArmed,false);
  h.tab.completionNotificationFired = true; h.tab.completionNotificationFiredAt = 42;
  r = await h.request(); assert.equal(r.data.completionNotificationFired,true);
  assert.equal(h.tab.completionNotificationFired,true,'GET does not acknowledge');
  assert.equal((await h.request('POST',{},'T','/clear')).status,200);
  assert.equal(h.tab.completionNotificationPersistent,true); assert.equal(h.tab.completionNotificationFired,undefined);
  h.tab.completionNotificationArmed = true; h.tab.completionNotificationFired = true;
  r = await h.request('POST',{mode:'persistent',enabled:false});
  assert.equal(r.data.completionNotificationArmed,false); assert.equal(r.data.completionNotificationFired,false);
  assert.equal(r.data.completionNotificationFiredAt,null);
});

test('POST waits for SQLite ACK; failure and unknown are reconciled by read, never automatic mutation retry', async t => {
  const h = await harness(t), gate = h.hold();
  const pending = h.request('POST',{mode:'persistent',enabled:true});
  while (!h.saves.length) await new Promise(resolve => setImmediate(resolve));
  const read = await h.request(); assert.equal(read.data.persistencePending,true); assert.equal(read.data.persistentDurable,false);
  assert.equal(read.data.storedPersistent,false); gate.resolve();
  const accepted = await pending; assert.equal(accepted.status,200); assert.equal(accepted.data.persistentCommitted,true);
  assert.ok(accepted.data.version.sequence > read.data.version.sequence);
  h.failSave(true); const failed = await h.request('POST',{mode:'persistent',enabled:false});
  assert.equal(failed.status,503); assert.equal(failed.data.success,false);
  assert.equal(failed.data.storedPersistent,true); assert.equal(failed.data.persistentDurable,false);
  h.failBridge(true); const unknown = await h.request('POST',{mode:'oneshot',enabled:true});
  assert.equal(unknown.status,503); assert.equal(unknown.data.mutationOutcome,'unknown');
  h.failBridge(false); const before = h.saves.length;
  assert.equal((await h.request()).status,200); assert.equal(h.saves.length,before);
});

test('desktop changes share exact flags; old GET capture cannot replace a newer write; closed/file targets rejected', async t => {
  const h = await harness(t); const old = h.adapter.read({projectId:'P',tabId:'T'});
  await h.state.setTabCompletionNotificationPersistent('P','T',true);
  const r = await h.request(); assert.equal(r.data.completionNotificationPersistent,true);
  assert.ok(r.data.version.sequence > old.version.sequence); assert.equal(r.data.version.epoch,old.version.epoch);
  assert.equal((await h.request('GET',null,'missing')).status,404);
  assert.equal((await h.request('POST',{mode:'oneshot',enabled:true},'F')).status,422);
  assert.equal((await h.request('POST',{mode:'toggle',enabled:true})).status,400);
  assert.equal((await h.request('POST',{mode:'oneshot',enabled:1})).status,400);
  const malformed = await h.request('POST','{','T','',true);
  assert.equal(malformed.status,400); assert.equal(malformed.data.mutationOutcome,'not-started');
  assert.equal((await h.request('POST',{mode:'oneshot',enabled:true,projectId:'foreign'})).status,400);
  h.state.openProjects.clear(); assert.equal((await h.request()).status,503);
});

test('lost bridge ACK after committed mutation is recovered by GET without another setter call', async t => {
  const h = await harness(t);
  const unknown = await completionNotificationRequest({method:'POST',tabId:'T',body:{mode:'persistent',enabled:true},db:h.db,
    bridge:async (_action,payload) => { await h.adapter.set(payload); throw Error('response lost after commit'); }});
  assert.equal(unknown.status,503); assert.equal(unknown.data.mutationOutcome,'unknown');
  assert.equal(h.saves.length,1);
  const recovered = await h.request();
  assert.equal(recovered.data.completionNotificationPersistent,true); assert.equal(recovered.data.persistentDurable,true);
  assert.equal(h.saves.length,1);
  const reopened = new DatabaseManager({existingConnection:new SQLite(h.db.db.name)});
  assert.equal(reopened.getTabCompletionNotificationPreference('T').persistent,1); reopened.close();
  assert.equal((await h.request('POST',{},'missing','/clear')).status,200,'legacy clear remains idempotent for missing targets');
});

test('newer desktop choice during save wins; project move while awaited rejects the old target', async t => {
  const h = await harness(t), gate = h.hold();
  const one = h.request('POST',{mode:'persistent',enabled:true});
  while (!h.saves.length) await new Promise(resolve => setImmediate(resolve));
  const two = h.state.setTabCompletionNotificationPersistent('P','T',false);
  gate.resolve(); const older = await one; await two;
  assert.equal(older.status,409); assert.equal(older.data.completionNotificationPersistent,false);
  assert.equal((await h.request()).data.persistentDurable,true);
  const moved = await completionNotificationRequest({method:'GET',tabId:'T',db:h.db,bridge:async (_action,payload) => {
    const read = h.adapter.read(payload);
    h.db.db.exec("INSERT INTO projects(id,name,path) VALUES('OTHER','other','/private/tmp')");
    h.db.db.exec("UPDATE tabs SET project_id='OTHER' WHERE tab_id='T'"); return read;
  }});
  assert.equal(moved.status,409); assert.equal(moved.data.code,'completion_notification_target_changed');
});

test('capability advertises the independent contract; Main forwards only a read wake, not delivery', () => {
  assert.equal(completionNotificationCapability.persistentCommit,'sqlite-ack');
  assert.match(web,/completionNotifications: completionNotificationCapability/);
  const main = fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
  const from = main.indexOf("ipcMain.on('tab-notification:state-changed'");
  const end = main.indexOf("ipcMain.on('tab-notification:cleared'",from);
  let listener; const events = [];
  vm.runInNewContext(main.slice(from,end), { ipcMain:{on:(_name,fn)=>{listener=fn;}},path,srcMainDir:__dirname,
    projectManager:{db:{getTabCompletionNotificationPreference: id => id === 'T' ? {projectId:'P'} : null}},
    require: () => ({publishCompletionNotificationChange:args=>events.push(args)}) });
  listener(null,{tabId:'T',projectId:'P'}); listener(null,{tabId:'T',projectId:'foreign'});
  assert.equal(events.length,1); assert.equal(events[0].tabId,'T');
  assert.doesNotMatch(main.slice(from,end), /sendTabCompletionPush|completed|NotificationOutbox/);
  const publish = pick(webAst,n => ts.isFunctionDeclaration(n) && n.name?.text === 'publishCompletionNotificationChange');
  const deliveries = [];
  const ctx = vm.createContext({webBroadcast:(...args)=>deliveries.push(args),PROJECT_ACTIVITY_TOPIC:'__project_activity__'});
  vm.runInContext(publish,ctx); ctx.publishCompletionNotificationChange(events[0]);
  assert.deepEqual(deliveries.map(([topic])=>topic),['T','__project_activity__']);
  assert.ok(deliveries.every(([,message])=>message.type === 'completion-notification-changed'));
});
