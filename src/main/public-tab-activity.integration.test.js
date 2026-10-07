'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createPublicTabActivity } = require('./public-tab-activity');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { createAgentSendActivity } = require('./agent-send-activity');
let fixtureRoot;
const electronPath = require.resolve('electron'), savedElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => fixtureRoot } } };
const DatabaseManager = require('./database');
if (savedElectron) require.cache[electronPath] = savedElectron; else delete require.cache[electronPath];
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = text => ts.createSourceFile('fixture.js', text, ts.ScriptTarget.Latest, true);
const mainTree = tree(main), webTree = tree(web);
function declaration(source, name) {
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(source);
}
const quiet = { log() {}, warn() {}, error() {} };
const style = { colorA: '#099E38', shimmerColor: '#FFFFFF', inheritedColor: '#A855F7',
  shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: 'right' };

async function harness(t) {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-activity-private-'));
  const root = fixtureRoot, db = new DatabaseManager();
  const p = db.createEmptyProject('Private activity'), other = db.createEmptyProject('Other');
  db.saveTabs(p.id, ['T', 'U', 'stopped'].map(tabId => ({ tabId, commandType: 'codex', tabType: 'terminal', name: tabId, cwd: root })), true);
  db.saveTabs(other.id, [{ tabId: 'foreign', commandType: 'claude', tabType: 'terminal', name: 'Other', cwd: root }], true);
  const owners = new Map(['T','U','stopped','foreign'].map(tabId => [tabId,
    { ownerToken: tabId + '-A', ownerOrder: { epoch: 'owners-A', revision: 1 }, currentBinding: { state: 'bound', sessionId: tabId + '-sid' } }]));
  const commands = new Map([['T', { runSeq: 1, isRunning: true }], ['U', { runSeq: 1, isRunning: true }]]);
  const launches = new Map([['T', { launchId: 'launch-A' }], ['U', { launchId: 'launch-U' }]]);
  const runtime = { projects: [{ projectId: p.id, count: 2, streaming: true, tabs: [
    { tabId: 'T', status: 'active', turnBusy: false }, { tabId: 'U', status: 'busy', turnBusy: true },
  ] }] };
  const timers = [], frames = [], effects = []; let reads = 0, bridgeHook = null;
  const own = createAgentSendActivity();
  const context = vm.createContext({ require, path, Date, JSON, Map, Set, console: quiet,
    srcMainDir: __dirname, projectManager: { db }, agentSendActivity: own,
    computeProjectActivity: () => runtime,
    conversationOwners: { current: id => owners.get(id) },
    terminals: new Map([['T', {}], ['U', {}]]),
    terminalCommandState: commands, codexLastRunCommandPayload: launches, claudeLaunchGenerationByTab: new Map(),
    getTerminalLifecycleGeneration: id => launches.has(id) ? id + '-generation' : null,
    projectActivityBroadcastTimer: null, projectLayoutChangedIds: new Set(), projectOrderChanged: false,
    projectCardSignals: null, setTimeout: fn => { timers.push(fn); return fn; },
  });
  for (const name of ['readPublicTabActivityState','scheduleProjectActivityBroadcast']) {
    vm.runInContext(declaration(mainTree, name), context);
  }
  const registryPath = path.join(root, 'runs.json');
  let registry = new OrchestrationRunStore(registryPath, { onActivityChanged: () => context.scheduleProjectActivityBroadcast('registry') });
  let metadata;
  context.require = name => name === path.join(__dirname, 'web-server')
    ? { invalidateTabActivity: reason => metadata?.invalidate(reason, false),
        observeTabActivityStyle: (...args) => webContext.observeTabActivityStyle(...args),
        broadcastProjectActivity: reason => webContext.broadcastProjectActivity(reason) } : require(name);
  metadata = createPublicTabActivity({ epoch: 'private-epoch-A',
    readState: () => { reads++; return context.readPublicTabActivityState(); },
    readInherited: () => registry.readInheritedActivity(),
    onChanged: reason => context.scheduleProjectActivityBroadcast(reason) });
  const subscribers = new Map([['__project_activity__', new Set([{}])], ['T', new Set([{}])], ['stopped', new Set([{}])]]);
  const webContext = vm.createContext({ console: quiet, Map, Set, Date, JSON,
    workspaceSwitcherWake: () => ({ version: 1, epoch: 'private-switcher', revision: 0, available: false }),
    runAfterWake: () => ({ version: 1, epoch: null, sequence: 0, revalidate: true }),
    publicTabActivity: metadata, activityStyleOwner: null, projectCardSignals: null,
    projectManager: { db }, sdkSessions: new Map(), computeProjectActivity: () => runtime,
    PROJECT_ACTIVITY_TOPIC: '__project_activity__', subscribers,
    webBroadcast: (id, payload) => frames.push({ id, payload: JSON.parse(JSON.stringify(payload)) }),
    publishTabTiming: () => {}, stampPublicRuntimeSnapshot: (_id, value) => value,
    bridgeRequest: async action => {
      effects.push(action); if (bridgeHook) return await bridgeHook(action);
      if (action === 'getProjectCompletionNotifications') return { tabs: {} };
      if (action === 'getStatusMarkerConfig') return { processBar: style, statuses: [] };
      throw new Error('unexpected bridge action: ' + action);
    },
    partitionProjectRuntimeTabs: tabs => ({ mainCodexTabs: tabs, rendererTabIds: [] }),
    resolveCurrentPtyAgentOwner: row => row.commandType === 'codex' ? 'codex' : 'claude',
    resolveCodexRuntimeProjectionBatch: rows => Object.fromEntries(rows.map(row => [row.tabId,
      { sessionStatus: row.tabId === 'stopped' ? 'inactive' : 'active', sessionId: row.tabId + '-sid', writerConfirmed: true }])),
    normalizePublicRuntimeStatus: value => value, decId: decodeURIComponent,
    claudeMaterializationFor: () => { throw new Error('History is forbidden'); },
    checkAuth: () => true, startRoutePendingLog: () => () => {}, shortId: value => value,
    resolveAgentSessionInfo: async () => ({ status: 'inactive', turnBusy: false, inputReady: false }),
    coherentPublicRuntimeSnapshot: async (_id, base) => base,
    sendJson: (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
  });
  for (const name of ['tabActivityProjection','observeTabActivityStyle','projectCardsSnapshot',
    'projectActivitySnapshot','sendProjectActivitySnapshot','broadcastProjectActivity']) {
    vm.runInContext(declaration(webTree, name), webContext);
  }
  const ipc = new Map();
  context.ipcMain = { on: (name,fn) => ipc.set(name,fn) };
  context.BrowserWindow = { fromWebContents: sender => sender.trusted === true ? {} : null };
  const ipcNode = mainTree.statements.find(n => n.getText(mainTree).startsWith("ipcMain.on('tab-activity:process-bar'"));
  assert.ok(ipcNode); vm.runInContext(ipcNode.getText(mainTree), context);
  const tabsAt = web.indexOf('  // Tabs of a project.'), tabsEnd = web.indexOf('  // Create tab group', tabsAt);
  const activityAt = web.indexOf("  if (parsed.pathname === '/api/project-activity'"), activityEnd = web.indexOf('  // ───────── SSE', activityAt);
  const statusAt = web.indexOf('  // Status snapshot for a PTY+Claude tab:'), statusEnd = web.indexOf('  // Truncate history', statusAt);
  assert.ok(tabsAt > 0 && activityAt > 0 && statusAt > 0);
  vm.runInContext('async function route(req,res,parsed) { let m;\n' + web.slice(tabsAt,tabsEnd)
    + web.slice(activityAt,activityEnd) + web.slice(statusAt,statusEnd) + '\n}', webContext);
  const server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://private');
    webContext.route(req,res,{pathname:url.pathname,query:Object.fromEntries(url.searchParams)})
      .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.stack })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await registry.initialize();
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await registry.persistChain; db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async route => {
    const start = performance.now();
    const response = await fetch('http://127.0.0.1:' + server.address().port + route);
    const text = await response.text();
    return { code: response.status, data: JSON.parse(text), bytes: Buffer.byteLength(text), ms: performance.now() - start };
  };
  return { db, p, other, runtime, owners, commands, launches, own, context, webContext, registry, metadata, ipc,
    get, frames, timers, effects, reads: () => reads,
    getProject: () => get('/api/projects/' + encodeURIComponent(p.id) + '/tabs'),
    setBridge: value => { bridgeHook = value; },
    flush: () => { for (const fn of timers.splice(0)) fn(); },
    restart: async () => {
      await registry.persistChain; registry = new OrchestrationRunStore(registryPath);
      await registry.initialize(); return registry;
    },
    create: async (runId, sourceTabId = 'T') => registry.create({ runId, sourceTabId, sourceProjectId: p.id,
      targetTabId: 'foreign', targetProjectId: other.id, prompt: 'PRIVATE BODY NOT FOR METADATA' }),
  };
}

test('actual /tabs, project-activity, /status: inherited without PTY; own priority and distinct count', async t => {
  const h = await harness(t); await h.create('R1'); await h.create('R2'); await h.create('R3','stopped');
  const result = await h.getProject(); assert.equal(result.code,200,JSON.stringify(result.data));
  const block = result.data.tabActivity;
  assert.equal(block.scope.projectId,h.p.id); assert.equal(block.loaderCount,3);
  assert.equal(block.tabs.find(t=>t.tabId==='T').kind,'inherited');
  assert.equal(block.tabs.find(t=>t.tabId==='U').kind,'own');
  assert.equal(block.tabs.find(t=>t.tabId==='stopped').inheritedBusy,true);
  assert.deepEqual(block.processBar.value, { position:'right', ...style });
  assert.equal(JSON.stringify(block).includes('PRIVATE BODY'),false);
  const activity = (await h.get('/api/project-activity')).data;
  assert.equal(activity.projects[0].count,2); assert.equal(activity.tabActivity.loaderCount,3);
  const status = (await h.get('/api/terminal-tabs/stopped/status')).data;
  assert.equal(status.turnBusy,false); assert.equal(status.inputReady,false);
  assert.equal(status.tabActivity.tabs[0].kind,'inherited');
  h.runtime.projects[0].tabs[0].turnBusy=true;
  const busy = (await h.getProject()).data.tabActivity.tabs.find(t=>t.tabId==='T');
  assert.equal(busy.inheritedBusy,true); assert.equal(busy.ownBusy,true); assert.equal(busy.kind,'own');
  console.log('[TabActivityTest] blockBytes='+Buffer.byteLength(JSON.stringify(block))+' tabsMs='+result.ms.toFixed(2));
  assert.deepEqual([...new Set(h.effects)].sort(),['getProjectCompletionNotifications','getStatusMarkerConfig']);
});

test('same desktop predicate over actual registry transitions and recovery exclusions', async t => {
  const h = await harness(t); await h.create('R');
  const desktop = await import('../renderer/utils/orchestrationRunProjection.mjs');
  const cases = [
    [{status:'queued',deliveryAcceptedAt:null,targetPromptProofAt:null},false],
    [{status:'queued',deliveryAcceptedAt:1},true], [{status:'running'},true],
    [{status:'waiting_descendants'},true], [{resumeAwaitingNewTurn:true},false],
    [{status:'waiting_recovery',resumeAwaitingNewTurn:false},false],
    [{status:'completed',resultComplete:false},true],
    [{status:'completed',resultComplete:true,notificationSuppressed:true},false],
    [{status:'failed',notificationStatus:'failed',notificationSuppressed:false,sourceFollowupPending:false},false],
  ];
  for(const [patch,expected] of cases) {
    const run=await h.registry.patch('R',patch);
    assert.equal(desktop.isOrchestrationInheritedActivity(run),expected,JSON.stringify(patch));
    assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].inheritedBusy,expected);
  }
  const run=await h.registry.patch('R',{status:'completed',resultComplete:true,sourceFollowupPending:true,
    sourceFollowupStartedAt:null,notificationSuppressed:false,notificationStatus:'audit-pending'});
  assert.equal(desktop.isOrchestrationInheritedActivity(run),true);
  assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].inheritedBusy,true);
  await h.registry.patch('R',{sourceFollowupStartedAt:123});
  assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].inheritedBusy,false);
});

test('one coalesced global+subscribed-tab SSE sample, no per-tab reads or transport startup', async t => {
  const h = await harness(t); h.flush(); h.frames.length=0;
  await h.create('A'); await h.create('B','stopped');
  h.context.scheduleProjectActivityBroadcast('own'); h.context.scheduleProjectActivityBroadcast('style');
  assert.equal(h.timers.length,1);
  const before=h.reads(); h.flush(); assert.equal(h.reads()-before,1);
  const global=h.frames.find(f=>f.id==='__project_activity__').payload.tabActivity;
  const stopped=h.frames.find(f=>f.id==='stopped').payload;
  assert.equal(stopped.type,'tab-activity'); assert.equal(stopped.tabActivity.revision,global.revision);
  assert.equal(stopped.tabActivity.tabs[0].kind,'inherited');
  assert.equal(h.effects.length,0);
});

test('metadata clock follows run/own send/owner changes independently of runtime and rejects older results', async t => {
  const h=await harness(t); const old=h.metadata.capture({tabId:'T'});
  await h.create('A'); const inherited=h.metadata.capture({tabId:'T'});
  assert.ok(inherited.revision>old.revision);
  h.own.update({operationKey:'private',tabId:'T',handoffId:'H',attemptId:'A',state:'in-flight'});
  const sending=h.metadata.capture({tabId:'T'}); assert.equal(sending.tabs[0].kind,'own');
  h.own.update({operationKey:'private',tabId:'T',handoffId:'H',attemptId:'A',state:'audit-pending'});
  assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].kind,'inherited');
  h.owners.set('T',{ownerToken:'T-B',ownerOrder:{epoch:'owners-A',revision:2}});
  h.launches.set('T',{launchId:'launch-B'}); h.commands.set('T',{runSeq:2,isRunning:true});
  const current=h.metadata.capture({tabId:'T'});
  assert.ok(current.revision>sending.revision); assert.equal(current.tabs[0].owner.launchId,'launch-B');
  assert.equal(old.tabs[0].owner.launchId,'launch-A');
  // Client admission is equality of epoch followed by monotonic metadata order,
  // not the old runtimeRevision or a wall clock timestamp.
  assert.equal(old.epoch===current.epoch && old.revision>=current.revision,false);
  const restartedRegistry=await h.restart();
  const restarted=createPublicTabActivity({epoch:'private-epoch-B',readState:()=>h.context.readPublicTabActivityState(),
    readInherited:()=>restartedRegistry.readInheritedActivity()}).capture({tabId:'T'});
  assert.equal(restarted.tabs[0].inheritedBusy,true); assert.notEqual(restarted.epoch,current.epoch);
  h.commands.set('T',{runSeq:2,isRunning:false});
  const stopped=h.metadata.capture({tabId:'T'}).tabs[0];
  assert.equal(stopped.owner.launchId,null, 'saved launch is not a current process');
  assert.equal(stopped.inheritedBusy,true, 'the source still owns its delegated work');
});

test('style from existing renderer bridge, late failure cannot erase newer IPC, disconnect is stale not default', async t => {
  const h=await harness(t); await h.getProject();
  const source=new EventEmitter();
  const next={...style,inheritedColor:'#123456'};
  const old=h.metadata.styleRevision();
  h.webContext.observeTabActivityStyle(next,undefined,source);
  assert.equal(h.webContext.observeTabActivityStyle(null,old),false);
  assert.equal(h.metadata.capture().processBar.value.inheritedColor,'#123456');
  source.emit('destroyed');
  const stale=h.metadata.capture().processBar;
  assert.equal(stale.known,false); assert.equal(stale.stale,true); assert.equal(stale.value.inheritedColor,'#123456');
  h.setBridge(async action=>{if(action==='getProjectCompletionNotifications')return {tabs:{}};throw Error('bridge unavailable')});
  const response=(await h.getProject()).data;
  assert.equal(response.tabActivity.processBar.known,false);
  assert.equal(response.tabActivity.processBar.value.inheritedColor,'#123456');
});

test('slow catalogue response captures newest run state after await; foreign project stays isolated', async t => {
  const h=await harness(t); let release, entered;
  const waiting=new Promise(resolve=>{entered=resolve});
  h.setBridge(async action=>{if(action==='getProjectCompletionNotifications')return {tabs:{}};
    entered(); await new Promise(resolve=>{release=resolve});return {processBar:style,statuses:[]}});
  const read=h.getProject(); await waiting;
  await h.create('new'); release();
  const response=(await read).data.tabActivity;
  assert.equal(response.tabs.find(t=>t.tabId==='T').inheritedBusy,true);
  const foreign=h.metadata.capture({projectId:h.other.id}); assert.equal(foreign.loaderCount,0);
  assert.equal(foreign.tabs.some(t=>t.tabId==='T'),false);
});

test('uninitialized/failed registry and missing tab never claim a known zero', async t => {
  const h=await harness(t);
  const cold=new OrchestrationRunStore(path.join(fixtureRoot,'cold.json'));
  const view=createPublicTabActivity({readState:()=>h.context.readPublicTabActivityState(),readInherited:()=>cold.readInheritedActivity()});
  assert.equal(view.capture().known,false); assert.equal(view.capture().loaderCount,null);
  cold.initialized=true; cold.activityReadError='orchestration-load-failed';
  assert.equal(view.capture().reason,'orchestration-load-failed');
  assert.equal(h.metadata.capture({tabId:'not-here'}).known,false);
});

test('trusted existing App processBar IPC and destroyed owner, not a new preference authority', async t => {
  const h=await harness(t); const handler=h.ipc.get('tab-activity:process-bar');
  const sender=new EventEmitter(); sender.isDestroyed=()=>false;
  handler({sender},style); assert.equal(h.metadata.capture().processBar.known,false);
  sender.trusted=true; handler({sender},style);
  assert.equal(h.metadata.capture().processBar.value.inheritedColor,style.inheritedColor);
  sender.emit('destroyed'); assert.equal(h.metadata.capture().processBar.known,false);
  assert.match(fs.readFileSync(path.join(__dirname,'../renderer/App.tsx'),'utf8'),
    /ipcRenderer\.send\('tab-activity:process-bar', processBar\)/);
});

test('no-new-run observer: rejected reservation rollback, cancelled and same source/target stay exact', async t => {
  const h=await harness(t); await h.create('R');
  await h.registry.patch('R',{status:'cancelled',notificationSuppressed:true});
  assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].loader,false);
  await h.registry.create({runId:'self',sourceTabId:'T',targetTabId:'T',sourceProjectId:h.p.id,targetProjectId:h.p.id});
  assert.equal(h.metadata.capture({tabId:'T'}).tabs[0].inheritedBusy,false);
  const persist=h.registry.persistStrict;
  h.registry.persistStrict=async()=>{throw Error('private disk failure')};
  await assert.rejects(h.registry.create({runId:'refused',sourceTabId:'stopped',targetTabId:'foreign',
    sourceProjectId:h.p.id,targetProjectId:h.other.id},{persistStrict:true}),/private disk failure/);
  h.registry.persistStrict=persist;
  assert.equal(h.metadata.capture({tabId:'stopped'}).tabs[0].inheritedBusy,false);
});

test('large all-project active set is compact, distinct, no bodies or reads per tab', async t => {
  const h=await harness(t);
  const synthetic=Array.from({length:120},(_,i)=>({tabId:'test-'+i,projectId:'P',ownBusy:i%2===0,owner:{conversation:null,lifecycleGeneration:'G',terminalRunSeq:1,launchId:'L'}}));
  let reads=0;
  const projection=createPublicTabActivity({readState:()=>{reads++;return {known:true,tabs:synthetic}},
    readInherited:()=>({known:true,sourceTabIds:synthetic.map(x=>x.tabId)})});
  const sample=projection.sample(); const all=sample();
  for(const tab of synthetic) sample({tabId:tab.tabId});
  assert.equal(reads,1); assert.equal(all.loaderCount,120);
  const bytes=Buffer.byteLength(JSON.stringify(all)); assert.ok(bytes<40000,bytes);
  assert.equal(projection.capability.epoch,all.epoch);
  console.log('[TabActivityTest] active120Bytes='+bytes);
});

test('actual HTTP → existing bridge reply verifies style sender, retains ownership through renderer loss', async t => {
  const h=await harness(t), callbacks=new Map(), sender=new EventEmitter();
  const diagnostics=[];
  h.webContext.console={log:(...args)=>diagnostics.push(args.join(' ')),warn:(...args)=>diagnostics.push(args.join(' '))};
  let destroyed=false, foreignRejected=false;
  sender.isDestroyed=()=>destroyed;
  h.webContext.ipcMain={on:(name,fn)=>callbacks.set(name,fn)};
  h.webContext.pendingBridge=new Map(); h.webContext.LATE_BRIDGE_REPLY_RETENTION_MS=100;
  h.webContext.e2eBoundaryTestGate=null;
  h.webContext.crypto=require('node:crypto'); h.webContext.bridgePayloadLabel=()=>'';
  h.webContext.setTimeout=setTimeout; h.webContext.clearTimeout=clearTimeout;
  h.webContext.BrowserWindow={getAllWindows:()=>[{isDestroyed:()=>false,webContents:sender}]};
  for(const name of ['bridgeRequest','registerBridgeReplyHandler']) vm.runInContext(declaration(webTree,name),h.webContext);
  h.webContext.registerBridgeReplyHandler();
  sender.send=(_channel,{action,requestId})=>queueMicrotask(()=>{
    assert.ok(['getProjectCompletionNotifications','getStatusMarkerConfig'].includes(action));
    const data=action==='getStatusMarkerConfig'?{processBar:style,statuses:[]}:{tabs:{}};
    const reply=callbacks.get('web:bridge-reply');
    if(action==='getStatusMarkerConfig') {
      reply({sender:{}},{requestId,ok:true,data:{processBar:{...style,inheritedColor:'#BADBAD'}}});
      foreignRejected=h.webContext.pendingBridge.has(requestId);
    }
    reply({sender},{requestId,ok:true,data});
  });
  const result=await h.getProject(); assert.equal(result.code,200,JSON.stringify(result.data));
  assert.equal(foreignRejected,true); assert.equal(h.webContext.activityStyleOwner,sender,JSON.stringify(diagnostics));
  assert.equal(result.data.tabActivity.processBar.value.inheritedColor,style.inheritedColor);
  destroyed=true; sender.emit('destroyed');
  const after=(await h.get('/api/project-activity')).data.tabActivity;
  assert.equal(after.processBar.known,false); assert.equal(after.processBar.stale,true);
});
