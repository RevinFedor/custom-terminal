import test from 'node:test';
import {newerWorkflowGroups} from '../utils/workflowGroupClient.mjs';
import {adoptPaneStripColorGroups} from '../../shared/pane-strip-color-groups.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import * as placement from '../utils/tabRestorePlacement.mjs';
import * as panes from '../utils/splitPanesModel.mjs';
import * as spaces from '../utils/workspaceSpacesModel.mjs';
import { dropFromMru } from '../utils/tabSwitcherModel.mjs';
import * as persistence from '../utils/tabPersistenceTransactions.mjs';
import { stopAiBeforeTerminalKill } from '../utils/terminalCloseLifecycle.mjs';
import {isAiForegroundProcess} from '../utils/aiForegroundProcess.mjs';
import {beginTabCloseFeedback} from '../utils/tabCloseFeedback.mjs';
import { createProjectTabSaveQueue } from '../utils/projectTabSaveQueue.mjs';
import {createExecutionRevisionAcks} from '../utils/executionRevisionAcks.mjs';
import { collectTabLinkedFiles } from '../utils/tabLinkedFiles.mjs';
import { createWorkflowRelationReceipts } from '../utils/workflowRelationReceipts.mjs';
import { isExactGroupCloseGuard,organizationProjection,reconcileWorkflowOrder } from '../utils/workflowOrganizationClient.mjs';

const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');
const DatabaseManager = require('../../main/database');
const {createWorkflowOrganizationApi}=require('../../main/workflow-organization-api');
const ack = require('../../main/save-tabs-ack');
const { validateForceCleanupTabIds } = require('../../main/save-tabs-precondition');
const { isAgentStatusBusyForClose } = require('../../main/orchestration-request-plan');
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const storeTree = ts.createSourceFile('store.ts', read('./useWorkspaceStore.ts'), ts.ScriptTarget.Latest, true);
const mainTree = ts.createSourceFile('main.js', read('../../main/main.js'), ts.ScriptTarget.Latest, true);
const appTree = ts.createSourceFile('App.tsx', read('../App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const webSource = read('../../main/web-server.js');
const mcpSource = read('../../../mcp/terminal-server.mjs');
const mcpTree = ts.createSourceFile('terminal-server.mjs', mcpSource, ts.ScriptTarget.Latest, true);
const pmTree=ts.createSourceFile('project-manager.js',read('../../main/project-manager.js'),ts.ScriptTarget.Latest,true);
// Execute the actual class method with the fixture DB, without initializing
// its production singleton. This is a store/IPC/persistence boundary test.
const pmClass=pmTree.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='ProjectManager');
const ActualProjectManager=vm.runInNewContext(pmClass.getText(pmTree)+';\nProjectManager;');
const walk = (tree, predicate) => {
  let found;
  const visit = node => { if (predicate(node)) found = node; ts.forEachChild(node, visit); };
  visit(tree); return found;
};
const variable = name => walk(storeTree, node => ts.isVariableDeclaration(node) && node.name.getText(storeTree) === name);
const closeNode = walk(storeTree, node => ts.isPropertyAssignment(node) && node.name.getText(storeTree) === 'closeTab');
const refreshNode=walk(storeTree,node=>ts.isPropertyAssignment(node)&&node.name.getText(storeTree)==='refreshOrganizationCatalog');
const cwdNode=walk(storeTree,node=>ts.isPropertyAssignment(node)&&node.name.getText(storeTree)==='updateTabCwd');
assert.ok(closeNode);
const sidebarTree=ts.createSourceFile('sidebar.tsx',read('../components/Workspace/ConnectedWorkflowSidebar.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const closeMembersNode=walk(sidebarTree,node=>ts.isJsxAttribute(node)&&node.name.text==='onCloseMembers');
assert.ok(closeMembersNode?.initializer?.expression);
const closeMembersExpression=ts.isIdentifier(closeMembersNode.initializer.expression)
  ? walk(sidebarTree,node=>ts.isVariableDeclaration(node)&&node.name.getText(sidebarTree)===closeMembersNode.initializer.expression.text)?.initializer
  : closeMembersNode.initializer.expression;
assert.ok(closeMembersExpression);
const persistenceCode = ['executionRevisionAcks','workflowRelationReceipts','serializeTabs', 'saveTabs', 'notifyProjectLayoutChanged',
  'saveTabsThenNotifyProjectLayoutChanged', 'saveTabsBatchThenNotifyProjectLayoutChanged']
  .map(name => variable(name)).filter(Boolean).map(node => 'const ' + node.getText(storeTree) + ';').join('\n');
const mainSave = walk(mainTree, node => ts.isCallExpression(node) && node.expression.getText(mainTree) === 'ipcMain.handle'
  && node.arguments[0]?.text === 'project:save-tabs');
const mainArchive = walk(mainTree,node=>ts.isCallExpression(node)&&node.expression.getText(mainTree)==='ipcMain.handle'
  && node.arguments[0]?.text==='project:archive-tab');
const archiveCommitNode=walk(mainTree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='commitTabArchive');
const closeRuntimeNodes=['captureArchivedCloseRuntimeOwner','workflowCloseGuardOwner','recoverArchivedCloseRuntime'].map(name=>
  walk(mainTree,node=>ts.isFunctionDeclaration(node)&&node.name?.text===name));
const bridgeClose = walk(appTree, node => ts.isIfStatement(node) && node.expression.getText(appTree) === "action === 'closeTab'");
assert.ok(mainSave && bridgeClose);
const compile = code => transformSync(code, { loader: 'ts', format: 'cjs' }).code;
const tab = (id, parent, type = 'terminal') => ({ id, name: id, cwd: '/fixture', commandType: 'generic',
  tabType: type, visualParentTabId: parent, ...(type === 'file' ? { filePath: '/same.md' } : {}) });

function fixture(t, { foreign = false, count = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-close-links-'));
  const dbFile = path.join(root, 'private.db'), diskFile = path.join(root, 'document.md');
  fs.writeFileSync(diskFile, '# Original document\n');
  let manager = new DatabaseManager({ existingConnection: new SQLite(dbFile) }); manager.initTables();
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const p = manager.createEmptyProject('Private close owner').id;
  const q = manager.createEmptyProject('Private foreign catalog').id;
  const files = Array.from({ length: count }, (_, i) => ({ ...tab('file-' + i, 'owner', 'file'), filePath: diskFile }));
  const project = (id, tabs) => ({ projectId: id, projectPath: root, tabs: new Map(tabs.map(row => [row.id, row])),
    activeTabId: 'owner', tabHistory: ['owner', 'file-0', 'child', 'other-file'], tabGroups: [] });
  const ws = project(p, [tab('owner'), ...(!foreign ? files : []), tab('child', 'owner'),
    tab('child-file', 'child', 'file'), tab('other'), tab('other-file', 'other', 'file'), tab('standalone', undefined, 'file')]);
  const other = project(q, foreign ? files : [tab('foreign-survivor')]);
  const chip = (id, projectId = p) => ({ projectId, tabId: id });
  const layout = { splitPanes: [{ ...chip('file-0', foreign ? q : p), windowId: 'files',
    tabs: [chip('owner'), ...files.map(row => chip(row.id, foreign ? q : p)), chip('other')],
    history: ['owner', 'file-0', 'other'].map(id => chip(id)),
    detachedTabs: [{ ...chip('file-1', foreign ? q : p), closedOrder: 1 }] }],
    centerStrips: { strip: [chip('owner'), chip('file-0', foreign ? q : p), chip('other')] },
    activeSpaceTab: chip('file-0', foreign ? q : p) };
  const calls = [], buffers = [], cleanedQueues = [], toasts = [], notifications = [];
  const state = { ...layout, splitFocusedIndex: 0, activeSpaceId: 'live', activeProjectId: p,
    openProjects: new Map([[p, ws], [q, other]]), globalTabMru: [...ws.tabs.keys(), ...other.tabs.keys()].map(id => chip(id)),
    spaces: [{ id: 'live', layout: {} }, { id: 'hidden', layout: structuredClone(layout) }],
    clearTerminalBuffer: id => buffers.push(id), centerStripKey: () => p,
    activateCenterTab: (_p, id) => calls.push('activate:' + id) };
  const ui = { filePreview: { source: 'tab', sourceTabId: 'file-0', ownerTabId: 'owner', path: diskFile },
    closeFilePreview() { ui.filePreview = null; }, showToast: (...args) => toasts.push(args) };
  const saveInitial = () => { for (const [id, w] of state.openProjects) manager.saveTabs(id,
    [...w.tabs.values()].map(row => ({ ...row, tabId: row.id })), true); };
  saveInitial();
  let api=createWorkflowOrganizationApi({database:manager});
  const terminals=new Map(),commandStates=new Map(),sdkSessions=new Map();
  let runtimeGeneration=0;
  const addRuntime=id=>{const term={pid:100+terminals.size,epoch:'pty:'+id+':'+(++runtimeGeneration),runSeq:1,inputRevision:0,stopRevision:0,
    kill(){calls.push(['pty.kill',id]);}};terminals.set(id,term);commandStates.set(id,{runSeq:1});return term;};
  api.bootstrap({workspace:{activeSpaceId:'live',spaces:[{id:'live',projectIds:[p,q],layout:{}}]},migrationId:'close-fixture',mutationId:'close-fixture'});
  const mainContext = vm.createContext({ ...ack, validateForceCleanupTabIds,
    workflowSelectionRuntime:null,
    get workflowOrganization(){return api;},
    projectManager: { get db() { return manager; }, saveProjectTabs: (id, rows, force, interrupted) => {
      if (state.failSave && (!foreign || id === q)) return { success: false, error: 'fixture-save-refusal' };
      return ActualProjectManager.prototype.saveProjectTabs.call({db:manager},id,rows,force,interrupted);
    } }, _gracefulShutdownInProgress: false, Date,
    noteProjectCardSignalsChanged() {if(state.failPublication)throw Error('controlled-publication-failure');}, tabWorkContext: { syncLinks: async () => {} },
    scheduleArchiveSideEffects() {},resolveAiToolTypeForTab:()=>null,
    crypto,terminals,sdkSessions,terminalCommandState:commandStates,conversationOwners:{instanceId:'fixture-main'},
    captureAgentLaunchFence:id=>({terminalInstanceId:terminals.get(id)?.epoch}),
    getTerminalLifecycleGeneration:id=>terminals.has(id)?terminals.get(id).epoch+':'+terminals.get(id).runSeq:null,
    getTerminalInputRevision:id=>terminals.get(id)?.inputRevision || 0,
    getTerminalStopRevision:id=>terminals.get(id)?.stopRevision || 0,
    terminalShellReadiness:{snapshot:()=>({pendingAgentLaunch:state.pendingRuntimeLaunch?{writeId:'pending-launch'}:null})},
    historyMutationInput:{run:(_input,action)=>action()},
    readAiLifecycleIdentityForTab:async id=>{
      if(state.beforeProcessProof)await state.beforeProcessProof(id);
      if(state.missingProcessProof)return null;
      return {processStatus:state.processStatus || (state.stopResult?.success===false?'unknown':'absent')};
    },
    stopAgentProcessScenarioInMain:async(request,guard)=>{calls.push('terminal:stop-ai-process');
      if(state.beforeProcessStop)await state.beforeProcessStop();
      const result=state.stopResult || {success:true};
      if(result.success || state.advanceOwnStopFence) {
        if(guard?.preSignalGuard && !guard.preSignalGuard().allowed)return {success:false,error:'guard-refused'};
        guard?.onStopAdmitted?.();
        if(terminals.has(request.tabId))terminals.get(request.tabId).stopRevision++;
        if(state.recheckStopGuardAfterFence)state.stopGuardAfterFence=guard.preSignalGuard().allowed;
      }
      if(result.success && !state.keepProcessAfterStop)state.processStatus='absent';
      return result;},
    stopSdkSession:async(request,options)=>{
      calls.push('claude-sdk:stop');
      if(sdkSessions.get(request.tabId)!==options.expectedSession || !options.guard().allowed)
        return {success:false,error:'sdk-owner-changed'};
      options.onStopAdmitted();
      if(state.sdkStopResult?.success===false)return state.sdkStopResult;
      sdkSessions.delete(request.tabId);return {success:true,hard:true};
    },
    terminateCapturedTerminalRuntime:require('../../main/terminal-runtime-identity.cjs').terminateCapturedTerminalRuntime,
    ipcMain:{emit:(channel,_event,id)=>{calls.push([channel,id]);}},
    console: { log() {}, warn() {} } });
  const saveHandler = vm.runInContext('(' + mainSave.arguments[1].getText(mainTree) + ')', mainContext);
  vm.runInContext(archiveCommitNode.getText(mainTree),mainContext);
  for(const node of closeRuntimeNodes)vm.runInContext(node.getText(mainTree),mainContext);
  const archiveHandler=vm.runInContext('('+mainArchive.arguments[1].getText(mainTree)+')',mainContext);
  const ipc = { send: (channel, id) => calls.push([channel, id]), invoke: async (channel, args) => {
    calls.push(channel);
    if (channel === 'terminal:getCommandState') {
      if (state.commandStateGate) await state.commandStateGate;
      return {isRunning:state.commandRunning===true};
    }
    if(channel==='terminal:hasRunningProcess')return {hasProcess:true,processName:'codex',command:'codex'};
    if(channel==='terminal:stop-ai-process')return state.stopResult || {success:true};
    if (channel === 'project:validate-tab-snapshot') return { success: !state.failPreflight };
    if (channel === 'project:archive-tab') {
      if(args.closeRequest)state.intentSeenBeforeArchive=ws.tabs.get(args.tab.tabId)?.__archiveClosePending?.archiveRequest
        ?.closeRequest?.mutationId===args.closeRequest.mutationId;
      if(state.archiveTransportBeforeCommit)throw Error('controlled-archive-delivery-unknown');
      const result=state.failArchive?{success:false,error:'fixture-archive-refusal'}:state.realArchive
        ? (state.lastArchiveRequest=structuredClone(args),await archiveHandler({},args)):{success:true,historyId:1};
      if(state.loseArchiveAck){state.loseArchiveAck=false;throw Error('controlled-archive-ACK-loss-after-commit');}
      return result;
    }
    if(channel==='workflow:group-close-guard'){api.groupActions.assertCloseGuard(args);return {success:true};}
    if(channel==='workflow:catalog')return state.catalogOverride || {...api.read(),namespaces:api.listNamespaces()};
    if (channel === 'project:delete-tab-history-entry') return { success:state.realArchive?manager.deleteTabHistoryEntry(args.id):true };
    if (channel === 'project:save-tabs') {
      const familySave=!args.closeFinalization?.recover && !args.closeFinalization?.runtimeAction;
      if (familySave && state.beforeSave) await state.beforeSave(args);
      if (state.missingSaveAck) return undefined;
      if(args.closeFinalization && familySave) {
        state.lastFinalizeRequest=structuredClone(args.closeFinalization);
        if(state.failFinalize)return {success:false,error:'controlled-finalize-refusal'};
      }
      const result=await saveHandler({}, args);
      if(!familySave){
        if(args.closeFinalization?.runtimeAction==='stop' && state.loseStopAck){state.loseStopAck=false;throw Error('controlled-stop-ACK-loss');}
        if(args.closeFinalization?.runtimeAction==='kill' && state.loseKillAck){state.loseKillAck=false;throw Error('controlled-kill-ACK-loss');}
        return result;
      }
      state.lastSaveResult=result;
      if(args.closeFinalization && state.loseFinalizeAck){state.loseFinalizeAck=false;return undefined;}
      if(args.closeFinalization && state.wrongFinalizeAck){state.wrongFinalizeAck=false;
        return {...state.lastSaveResult,closeReceipt:{...state.lastSaveResult.closeReceipt,mutationId:'foreign-ack'}};}
      return state.lastSaveResult;
    }
    if (channel === 'project:layout-changed') { notifications.push(args.projectId); return { success: true }; }
    if (channel === 'orchestration:tab-closed') return { success: true };
    throw Error('unexpected IPC: ' + channel);
  } };
  const context = vm.createContext({ ...placement, ...panes, ...spaces, ...persistence, collectTabLinkedFiles,isExactGroupCloseGuard,newerWorkflowGroups,adoptPaneStripColorGroups,
    dropFromMru, stopAiBeforeTerminalKill, beginTabCloseFeedback, createProjectTabSaveQueue,createExecutionRevisionAcks,createWorkflowRelationReceipts,
    projectTabSaveQueue: createProjectTabSaveQueue(), projectTabSaveRevisions: new Map(),
    get: () => state, set: patch => Object.assign(state, patch), startTransition: fn => fn(),
    useWorkspaceStore:{getState:()=>state},organizationProjection,reconcileWorkflowOrder,INBOX_WORKFLOW_ID:'__noted_workflow_inbox__',
    ipcRenderer: ipc, Date, crypto, console: { log() {}, warn() {} },
    resolvePtyAgentOwner: () => null, isAiRuntimeTab: () => state.aiRuntime===true, isAiBusyTab: () => false,isAiForegroundProcess,
    clearPendingAutoTabTitle() {}, autoTabTitleIntents: new Map(),
    usePromptQueueStore: { getState: () => ({ cleanupClosedTab: id => cleanedQueues.push(id) }) },
    useUIStore: { getState: () => ui }, module: { exports: {} } });
  vm.runInContext(compile(persistenceCode + '\nmodule.exports = {closeTab:'+closeNode.initializer.getText(storeTree)
    +',saveTabs,refresh:'+refreshNode.initializer.getText(storeTree)+',updateCwd:'+cwdNode.initializer.getText(storeTree)+'};'), context);
  const actual=context.module.exports;state.closeTab=actual.closeTab;
  const closeMembers=vm.runInNewContext(compile('module.exports = '+closeMembersExpression.getText(sidebarTree)),{
    module:{exports:{}},isExactGroupCloseGuard,useWorkspaceStore:{getState:()=>state},
    ipcRenderer:{invoke:async(channel,args)=>{
      if(channel==='workflow:group-action')return api.groupActions.begin(args);
      if(channel==='workflow:group-close-step')return api.groupActions.step(args);
      if(channel==='workflow:group-close-ack')return api.groupActions.ack(args);
      throw Error('unexpected group IPC: '+channel);
    }},
  });
  const bridge = vm.runInNewContext(compile('(async (payload) => { const action="closeTab";'
    + bridgeClose.getText(appTree) + '})'), { state, reply: (ok, data, error) => ({ ok, data, error }) });
  return { state, ws, other, p, q, ui, calls, buffers, cleanedQueues, notifications, toasts, diskFile,
    get api(){return api;},get manager(){return manager;},
    addNative:(id,record={})=>{const result=api.createTab({mutationId:'create:'+id,tabId:id,cwd:root,executionNamespace:p,
      workflowId:'live',record:{name:id,tabType:'file',filePath:diskFile,...record}});
      const tab=manager.getExecutionTabV2({executionNamespace:p,tabId:id}).tab;ws.tabs.set(id,{...tab,id});
      if(record.tabType==='terminal')addRuntime(id);return result;},
    keepOwnerOnly:()=>{ws.tabs=new Map([['owner',ws.tabs.get('owner')]]);saveInitial();},
    bridge,closeMembers,persist:()=>actual.saveTabs(p,ws.tabs),refresh:()=>actual.refresh(),updateCwd:(id,cwd,commit)=>actual.updateCwd(p,id,cwd,commit),
    catalog:()=>({...api.read(),namespaces:api.listNamespaces()}),dbIds: id => manager.getProjectTabIds(id),
    finalize:request=>saveHandler({}, {closeFinalization:request,groupFileCloseGuard:request.groupCloseGuard}),
    archive:request=>archiveHandler({},request),
    runtimes:terminals,addRuntime,sdkSessions,mainContext,ipc,commandStates,
    addFile: (id, parent, projectId) => { state.openProjects.get(projectId).tabs.set(id,
      { ...tab(id, parent, 'file'), filePath: diskFile });
      manager.saveTabs(projectId,[...state.openProjects.get(projectId).tabs.values()].map(row=>({...row,tabId:row.id})),true); },
    reopenDb: () => { manager.close(); manager = new DatabaseManager({ existingConnection: new SQLite(dbFile) });api=createWorkflowOrganizationApi({database:manager}); },
    fileBytes: () => fs.readFileSync(diskFile, 'utf8') };
}

test('actual close publishes feedback before its first awaited runtime read and clears preflight refusal', async t => {
  const f=fixture(t);let release;f.state.commandStateGate=new Promise(resolve=>{release=resolve;});f.state.failPreflight=true;
  const owner=f.ws.tabs.get('owner'),closing=f.state.closeTab(f.p,'owner');assert.equal(owner.aiClosing,true,'visible intent before any async runtime result');
  const neighbour={projectId:'parallel',tabs:new Map()};f.state.openProjects=new Map([...f.state.openProjects,['parallel',neighbour]]);
  release();assert.equal(await closing,false);assert.equal(owner.aiClosing,false);assert.strictEqual(f.state.openProjects.get('parallel'),neighbour);assert.strictEqual(f.ws.tabs.get('owner'),owner);assert.equal(f.calls.includes('project:archive-tab'),false);
});

test('actual close clears feedback when the first runtime read rejects', async t => {
  const f=fixture(t);let reject;f.state.commandStateGate=new Promise((_,r)=>{reject=r;});const owner=f.ws.tabs.get('owner'),closing=f.state.closeTab(f.p,'owner');assert.equal(owner.aiClosing,true);reject(Error('controlled runtime read failure'));await assert.rejects(closing,/controlled runtime read failure/);assert.equal(owner.aiClosing,false);assert.strictEqual(f.ws.tabs.get('owner'),owner);assert.equal(f.calls.includes('project:archive-tab'),false);
});

test('actual common close removes direct file links, preserves AI children/their files and disk bytes', async t => {
  const f = fixture(t);
  assert.equal(await f.state.closeTab(f.p, 'owner'), true);
  assert.equal(f.ws.tabs.has('owner'), false);
  assert.equal(f.ws.tabs.has('file-0'), false);
  assert.equal(f.ws.tabs.has('file-1'), false);
  assert.equal(f.ws.tabs.get('child').visualParentTabId, undefined);
  assert.equal(f.ws.tabs.get('child-file').visualParentTabId, 'child');
  assert.equal(f.ws.tabs.get('other-file').visualParentTabId, 'other');
  assert.ok(f.ws.tabs.has('standalone'));
  assert.equal(f.ui.filePreview, null);
  assert.equal(f.fileBytes(), '# Original document\n');
  f.reopenDb();
  assert.deepEqual(f.dbIds(f.p).sort(), [...f.ws.tabs.keys()].sort());
});

test('actual bridge close removes linked files from every placement and history without removing windows', async t => {
  const f = fixture(t);
  const result = await f.bridge({ tabId: 'owner' });
  assert.equal(result.data.closed, true);
  for (const id of ['owner', 'file-0', 'file-1']) {
    assert.equal(f.ws.tabs.has(id), false);
    assert.equal(f.ws.tabHistory.includes(id), false);
    assert.ok(!f.state.globalTabMru.some(row => row.tabId === id));
    assert.ok(f.buffers.includes(id));
    assert.ok(f.cleanedQueues.includes(id));
    assert.ok(!JSON.stringify(f.state.splitPanes).includes('"tabId":"' + id + '"'));
    assert.ok(!JSON.stringify(f.state.spaces.find(s => s.id === 'hidden').layout).includes('"tabId":"' + id + '"'));
    assert.ok(!JSON.stringify(f.state.centerStrips).includes('"tabId":"' + id + '"'));
  }
  assert.equal(f.state.splitPanes.length, 1);
  assert.equal(f.state.splitPanes[0].windowId, 'files');
  assert.equal(f.state.splitPanes[0].tabId, '');
  assert.equal(f.state.splitFocusedIndex, 0);
  assert.ok(!f.calls.some(row => typeof row === 'string' && row.startsWith('activate:')));
});

test('three or more owned file previews close as one intentional durable reduction', async t => {
  const f = fixture(t, { count: 4 });
  assert.equal(await f.state.closeTab(f.p, 'owner'), true);
  assert.equal([...f.ws.tabs.keys()].filter(id => id.startsWith('file-')).length, 0);
  assert.equal(f.dbIds(f.p).filter(id => id.startsWith('file-')).length, 0);
});

test('global direct links in another catalog close atomically with their owner', async t => {
  const f = fixture(t, { foreign: true });
  assert.equal(await f.state.closeTab(f.p, 'owner'), true);
  assert.equal(f.other.tabs.size, 0);
  f.reopenDb(); assert.equal(f.dbIds(f.q).length, 0);
  assert.ok(!f.dbIds(f.p).includes('owner'));
  assert.equal(f.notifications.length, 2);
});

for (const failure of ['failPreflight', 'failArchive', 'failSave']) test('refused close keeps owner/file maps, preview and placement: ' + failure, async t => {
  const f = fixture(t); f.state[failure] = true;
  const before = f.ws.tabs, preview = f.ui.filePreview, layout = JSON.stringify(f.state.splitPanes);
  assert.equal(await f.state.closeTab(f.p, 'owner'), false);
  assert.equal(f.ws.tabs, before);
  assert.equal(f.ui.filePreview, preview);
  assert.equal(JSON.stringify(f.state.splitPanes), layout);
  assert.ok(f.dbIds(f.p).includes('owner'));
  assert.ok(f.dbIds(f.p).includes('file-0'));
  assert.equal(f.buffers.length, 0);
});

test('a foreign-catalog save failure rolls back the already-written owner snapshot', async t => {
  const f = fixture(t, { foreign: true }); f.state.failSave = true;
  assert.equal(await f.state.closeTab(f.p, 'owner'), false);
  assert.ok(f.ws.tabs.has('owner') && f.other.tabs.has('file-0'));
  f.reopenDb(); assert.ok(f.dbIds(f.p).includes('owner') && f.dbIds(f.q).includes('file-0'));
});

test('a late link changes the foreign catalog precondition and rejects the whole close', async t => {
  const f = fixture(t, { foreign: true });
  f.state.beforeSave = () => { f.state.beforeSave = null; f.addFile('late-file', 'owner', f.q); };
  assert.equal(await f.state.closeTab(f.p, 'owner'), false);
  assert.ok(f.ws.tabs.has('owner') && f.other.tabs.has('file-0') && f.other.tabs.has('late-file'));
  f.reopenDb(); assert.ok(f.dbIds(f.p).includes('owner') && f.dbIds(f.q).includes('late-file'));
  assert.notEqual(f.ui.filePreview, null);
});

test('bridge does not report successful closure when the common executor refuses it', async t => {
  const f = fixture(t); f.state.failArchive = true;
  const result = await f.bridge({ tabId: 'owner' });
  assert.equal(result.data?.closed, false);
  assert.equal(result.ok, false);
  assert.ok(f.ws.tabs.has('owner') && f.ws.tabs.has('file-0'));
});

test('closing one linked file does not close its owner, sibling or another same-path preview', async t => {
  const f = fixture(t);
  f.ui.filePreview = { source: 'tab', sourceTabId: 'other-file', ownerTabId: 'other', path: f.diskFile };
  const preview = f.ui.filePreview;
  assert.equal(await f.state.closeTab(f.p, 'file-0'), true);
  assert.ok(f.ws.tabs.has('owner') && f.ws.tabs.has('file-1') && f.ws.tabs.has('other-file'));
  assert.equal(f.ui.filePreview, preview);
  assert.equal(f.fileBytes(), '# Original document\n');
});

test('R2: actual single native file close is durable while ordinary metadata omission remains non-destructive',async t=>{
  const f=fixture(t);f.addNative('native-file');const owner=f.ws.tabs.get('owner');
  assert.equal(await f.state.closeTab(f.p,'native-file'),true);
  f.reopenDb();assert.ok(!f.dbIds(f.p).includes('native-file'));assert.ok(f.dbIds(f.p).includes('owner'));
  assert.equal(f.ws.tabs.get('owner'),owner);assert.equal(f.fileBytes(),'# Original document\n');
  f.addNative('metadata-omitted');f.manager.saveTabs(f.p,[],false);
  assert.ok(f.dbIds(f.p).includes('metadata-omitted'),'plain metadata save cannot close omitted rows');
});

test('R2: actual close of the last legacy owner in a native mixed namespace cannot resurrect it',async t=>{
  const f=fixture(t);f.keepOwnerOnly();f.addNative('native-neighbour');
  const before=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'native-neighbour'});
  assert.equal(await f.state.closeTab(f.p,'owner'),true);f.reopenDb();
  assert.ok(!f.dbIds(f.p).includes('owner'));const after=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'native-neighbour'});
  assert.equal(after.row.id,before.row.id);assert.equal(after.executionSubject.subjectId,before.executionSubject.subjectId);
});

test('R3: one frozen group closes independent native file families through actual store/Main/ProjectManager, including retry',async t=>{
  const f=fixture(t),g=f.api.groups.mutate('create',{version:1,mutationId:'files-group',expectedRevision:f.api.groups.read().revision,metadata:{name:'Files'}});
  for(const id of ['F1','F2'])f.addNative(id,{globalGroupId:g.groupId});
  const intent={version:1,mutationId:'close-families',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision};
  const members=['F1','F2'].map(tabId=>({tabId,namespace:f.p}));
  assert.equal((await f.closeMembers(members,f.api.groups.group(g.groupId),intent)).success,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal((await f.closeMembers(members,f.api.groups.group(g.groupId),intent)).completed,true,'lost ACK replays exact completion');
  assert.ok(!f.dbIds(f.p).includes('F1')&&!f.dbIds(f.p).includes('F2'));assert.ok(f.dbIds(f.p).includes('owner'));
});

test('owned save ACK advances a replacement object before single file close, without overwriting its pending metadata',async t=>{
  const f=fixture(t);f.addNative('F1');f.addNative('F2');
  f.state.beforeSave=()=>{
    f.state.beforeSave=null;
    for(const id of ['F1','F2'])f.ws.tabs.set(id,{...f.ws.tabs.get(id),name:'Pending '+id});
  };
  assert.equal((await f.persist()).success,true);
  const kept=f.ws.tabs.get('F2');
  assert.equal(await f.state.closeTab(f.p,'F1'),true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F2'}).tab.name,'Pending F2');
  assert.equal(f.ws.tabs.get('F2'),kept);assert.ok(!f.dbIds(f.p).includes('F1'));
});

test('late cold catalog snapshot cannot roll back an owned save ACK or its metadata',async t=>{
  const f=fixture(t);f.addNative('cold',{tabType:'terminal'});const current=f.ws.tabs.get('cold');current.lazyRuntime=true;
  const old=f.catalog();current.name='New metadata';assert.equal((await f.persist()).success,true);
  const revision=current.executionStorageRevision;f.state.catalogOverride=old;
  await f.refresh();assert.equal(f.ws.tabs.get('cold'),current);assert.equal(current.name,'New metadata');
  assert.equal(current.executionStorageRevision,revision);
});

test('actual verified OSC cwd commits do not resave unrelated tabs or leave single file Close with stale metadata CAS',async t=>{
  const f=fixture(t);f.keepOwnerOnly();f.addNative('T',{tabType:'terminal'});f.addNative('F');
  assert.equal((await f.persist()).success,true);
  for(const directory of [f.ws.tabs.get('T').cwd,path.join(path.dirname(f.diskFile),'new-cwd')]) {
    const point=f.manager.updateProvenTabCwd('T',directory),count=f.calls.filter(call=>call==='project:save-tabs').length;
    assert.equal(await f.updateCwd('T',directory,{...point,accepted:true,cwd:directory}),true);
    assert.equal(f.calls.filter(call=>call==='project:save-tabs').length,count);
    assert.equal(f.ws.tabs.get('T').executionStorageRevision,point.executionReceipt.toRevision);
  }
  assert.equal(await f.state.closeTab(f.p,'F'),true,JSON.stringify(f.state.lastSaveResult));
  assert.ok(f.dbIds(f.p).includes('T'));assert.ok(!f.dbIds(f.p).includes('F'));
});

test('R3: own close receipts survive reload; a later foreign metadata revision cannot be promoted by another group step',async t=>{
  const f=fixture(t),g=f.api.groups.mutate('create',{version:1,mutationId:'revision-group',expectedRevision:f.api.groups.read().revision,metadata:{name:'Files'}});
  for(const id of ['F1','F2'])f.addNative(id,{globalGroupId:g.groupId});
  const intent={version:1,mutationId:'revision-close',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision};
  f.api.groupActions.begin({kind:'close',groupId:g.groupId,intent,members:['F1','F2'].map(tabId=>({tabId,namespace:f.p}))});
  const first=f.api.groupActions.step({mutationId:intent.mutationId,tabId:'F1'});
  assert.equal(await f.state.closeTab(f.p,'F1',{groupCloseGuard:first.closeGuard}),true);
  f.reopenDb();assert.equal(f.api.groupActions.step({mutationId:intent.mutationId,tabId:'F1'}).completed,true);
  const before=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F2'});
  f.manager.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('foreign metadata','F2');
  const current=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F2'});
  f.ws.tabs.get('F2').executionStorageRevision=current.revision;
  const second=f.api.groupActions.step({mutationId:intent.mutationId,tabId:'F2'});
  assert.equal(await f.state.closeTab(f.p,'F2',{groupCloseGuard:second.closeGuard}),false);
  assert.equal(f.state.lastSaveResult.error,'group_file_close_family_changed');
  assert.ok(f.dbIds(f.p).includes('F2'));assert.equal(current.row.id,before.row.id);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F2'}).tab.notes,'foreign metadata');
  assert.equal(f.manager.db.prepare('SELECT COUNT(*) n FROM workflow_group_close_revisions WHERE mutation_id=?').get(intent.mutationId).n,1);
});

test('R3: terminal-first group close advances only its own retained native file family receipts',async t=>{
  const f=fixture(t);f.keepOwnerOnly();f.state.realArchive=true;
  const g=f.api.groups.mutate('create',{version:1,mutationId:'mixed-group',expectedRevision:f.api.groups.read().revision,metadata:{name:'Mixed'}});
  f.addNative('T',{globalGroupId:g.groupId,tabType:'terminal',filePath:null,commandType:'generic'});
  f.addNative('F',{globalGroupId:g.groupId});
  const intent={version:1,mutationId:'mixed-close',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision};
  const members=[{tabId:'F',namespace:f.p,tab:{tabType:'file'}},{tabId:'T',namespace:f.p,tab:{tabType:'terminal'}}];
  assert.equal((await f.closeMembers(members,f.api.groups.group(g.groupId),intent)).success,true,JSON.stringify(f.state.lastSaveResult));
  assert.ok(!f.dbIds(f.p).includes('T')&&!f.dbIds(f.p).includes('F'));assert.ok(f.dbIds(f.p).includes('owner'));
});

test('R3 legacy: independent v1 file families close in one intent despite own snapshot PK replacement and a higher native neighbour',async t=>{
  const f=fixture(t),g=f.api.groups.mutate('create',{version:1,mutationId:'legacy-files',expectedRevision:f.api.groups.read().revision,metadata:{name:'Legacy files'}});
  const ids=['file-0','file-1'];
  f.api.groups.mutate('assign',{version:1,mutationId:'legacy-file-members',expectedRevision:f.api.groups.read().revision,
    groupId:g.groupId,tabIds:ids,expectedTabGroups:Object.fromEntries(ids.map(id=>[id,null]))});
  f.addNative('V',{tabType:'terminal'});const native=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'V'});
  const intent={version:1,mutationId:'legacy-files-close',expectedRevision:f.api.groups.read().revision,
    expectedGroupRevision:f.api.groups.group(g.groupId).revision};
  const members=ids.map(tabId=>({tabId,namespace:f.p}));
  assert.equal((await f.closeMembers(members,f.api.groups.group(g.groupId),intent)).success,true,JSON.stringify(f.state.lastSaveResult));
  assert.ok(!f.dbIds(f.p).includes(ids[0])&&!f.dbIds(f.p).includes(ids[1]));
  const kept=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'V'});
  assert.equal(kept.row.id,native.row.id);assert.equal(kept.executionSubject.subjectId,native.executionSubject.subjectId);
  assert.equal(kept.archived,false);assert.equal(f.fileBytes(),'# Original document\n');
  assert.equal((await f.closeMembers(members,f.api.groups.group(g.groupId),intent)).completed,true);
});

for(const foreign of ['replacement','reparent'])test('legacy own PK receipt rejects later foreign '+foreign,async t=>{
  const f=fixture(t),g=f.api.groups.mutate('create',{version:1,mutationId:'legacy-foreign',expectedRevision:f.api.groups.read().revision,metadata:{name:'Legacy'}});
  const ids=['file-0','file-1'];f.api.groups.mutate('assign',{version:1,mutationId:'legacy-foreign-members',expectedRevision:f.api.groups.read().revision,
    groupId:g.groupId,tabIds:ids,expectedTabGroups:Object.fromEntries(ids.map(id=>[id,null]))});
  f.addNative('V',{tabType:'terminal'});
  const intent={version:1,mutationId:'legacy-foreign-close',expectedRevision:f.api.groups.read().revision,expectedGroupRevision:f.api.groups.group(g.groupId).revision};
  f.api.groupActions.begin({kind:'close',groupId:g.groupId,intent,members:ids.map(tabId=>({tabId,namespace:f.p}))});
  const first=f.api.groupActions.step({mutationId:intent.mutationId,tabId:ids[0]});
  assert.equal(await f.state.closeTab(f.p,ids[0],{groupCloseGuard:first.closeGuard}),true);
  f.reopenDb();assert.equal(f.api.groupActions.step({mutationId:intent.mutationId,tabId:ids[0]}).completed,true);
  const old=f.manager.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(ids[1]);
  if(foreign==='replacement') {
    f.manager.db.prepare('DELETE FROM tabs WHERE tab_id=?').run(ids[1]);const {id,...replacement}=old;
    f.manager._executionInsert('tabs',replacement);assert.notEqual(f.manager.db.prepare('SELECT id FROM tabs WHERE tab_id=?').get(ids[1]).id,id);
    const next=f.api.groupActions.step({mutationId:intent.mutationId,tabId:ids[1]});
    assert.equal(await f.state.closeTab(f.p,ids[1],{groupCloseGuard:next.closeGuard}),false);
    assert.equal(f.state.lastSaveResult.error,'group_file_close_family_changed');
  } else {
    f.manager.db.prepare("UPDATE tabs SET visual_parent_tab_id='other' WHERE tab_id=?").run(ids[1]);
    assert.throws(()=>f.api.groupActions.step({mutationId:intent.mutationId,tabId:ids[1]}),/execution_changed/);
  }
  assert.ok(f.dbIds(f.p).includes(ids[1]));assert.ok(f.dbIds(f.p).includes('V'));assert.equal(f.fileBytes(),'# Original document\n');
});

test('absent persistence ACK is not a successful close', async t => {
  const f = fixture(t); f.state.missingSaveAck = true;
  assert.equal(await f.state.closeTab(f.p, 'owner'), false);
  assert.ok(f.ws.tabs.has('owner') && f.ws.tabs.has('file-0'));
  assert.ok(f.dbIds(f.p).includes('owner'));
  assert.notEqual(f.ui.filePreview, null);
});

test('a sidebar preview of the same disk file is not an attachment-owned surface', async t => {
  const f = fixture(t); f.ui.filePreview = { source: 'sidebar', path: f.diskFile };
  const preview = f.ui.filePreview;
  assert.equal(await f.state.closeTab(f.p, 'owner'), true);
  assert.equal(f.ui.filePreview, preview);
});

test('a file-owned file across catalogs follows the cascade, without aggregating child-session files', async t => {
  const f = fixture(t, { foreign: true }); f.addFile('nested-file', 'file-0', f.p);
  assert.equal(await f.state.closeTab(f.p, 'owner'), true);
  assert.equal(f.ws.tabs.has('nested-file'), false);
  assert.ok(f.ws.tabs.has('child') && f.ws.tabs.has('child-file'));
  f.reopenDb(); assert.ok(!f.dbIds(f.p).includes('nested-file') && f.dbIds(f.q).length === 0);
});

async function httpFixture(t, f) {
  const start = webSource.indexOf('  // Close tab (delegates to renderer store');
  const end = webSource.indexOf('  // Fork a materialized', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ decId: decodeURIComponent, isAgentStatusBusyForClose,
    bridgeRequest: async (action, body) => {
      if (action === 'getClaudeTabStatus') return { status: 'active', busy: false };
      assert.equal(action, 'closeTab');
      const result = await f.bridge(body);
      if (!result.ok) throw Error(result.error);
      return result.data;
    },
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); },
    sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } });
  const handler = vm.runInContext('(async(req,res)=>{let m;const parsed={pathname:req.url};'
    + webSource.slice(start, end) + '})', context);
  const server = http.createServer((req, res) => handler(req, res).catch(error => {
    res.writeHead(500); res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const clause = walk(mcpTree, node => ts.isCaseClause(node) && node.expression.text === 'close_tab');
  assert.ok(clause);
  const tool = vm.runInNewContext('(async(args)=>{' + clause.statements.map(s => s.getText(mcpTree)).join('\n') + '})', {
    projectHint: () => ({ privateFixture: true }),
    httpApiPost: async (_target, route, body) => {
      const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw Error('HTTP ' + response.status + ': ' + result.error);
      return result;
    } });
  return { tool };
}

test('actual MCP close_tab → real private HTTP → actual App/common executor → private SQLite closes all links', async t => {
  const f = fixture(t, { foreign: true }), { tool } = await httpFixture(t, f);
  const result = JSON.parse(await tool({ tabId: 'owner', force: true }));
  assert.equal(result.ok, true); assert.equal(result.closed, true);
  assert.equal(f.ws.tabs.has('owner'), false); assert.equal(f.other.tabs.size, 0);
  f.reopenDb(); assert.ok(!f.dbIds(f.p).includes('owner')); assert.equal(f.dbIds(f.q).length, 0);
  assert.equal(f.fileBytes(), '# Original document\n');
});

test('HTTP/MCP propagates archive refusal, with file relations and private SQL unchanged', async t => {
  const f = fixture(t), { tool } = await httpFixture(t, f); f.state.failArchive = true;
  await assert.rejects(tool({ tabId: 'owner' }), /HTTP 409: tab_close_not_committed/);
  assert.ok(f.ws.tabs.has('owner') && f.ws.tabs.has('file-0'));
  assert.ok(f.dbIds(f.p).includes('owner') && f.dbIds(f.p).includes('file-0'));
});

function nativeIncident(t,{foreign=false,linked=false}={}) {
  const f=fixture(t);f.keepOwnerOnly();f.state.realArchive=true;
  f.addNative('C',{tabType:'terminal',filePath:null,commandType:'generic'});
  f.addNative('A',{tabType:'terminal',filePath:null,commandType:'generic'});
  if(linked) {
    f.addNative('F',{visualParentTabId:'C'});
    if(foreign)f.addFile('foreign-file','F',f.q);
  }
  return f;
}
async function staleNeighbour(f) {
  assert.equal((await f.persist()).success,true);
  const cached=f.ws.tabs.get('A'),revision=cached.executionStorageRevision;
  f.manager.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('foreign-authoritative-A','A');
  const current=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'A'});
  assert.ok(current.revision>revision);
  return {cached,revision,current};
}

test('incident C: actual App/Main/SQL closes exactly C despite unrelated A metadata conflict',async t=>{
  const f=nativeIncident(t),a=await staleNeighbour(f);
  const result=await f.bridge({tabId:'C'});
  assert.equal(result.ok,true,JSON.stringify(f.state.lastSaveResult));assert.equal(result.data.closed,true);
  assert.ok(!f.ws.tabs.has('C'));assert.ok(!f.dbIds(f.p).includes('C'));
  assert.equal(f.manager._executionPendingArchiveIds.has('C'),false);
  assert.deepEqual(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'A'}).row,a.current.row);
  assert.equal(f.ws.tabs.get('A'),a.cached);assert.equal(a.cached.executionStorageRevision,a.revision);
  assert.notEqual(a.cached.notes,'foreign-authoritative-A','no blind hydration of foreign metadata');
});
test('incident C: native close retains authoritative History and exact archive mutation receipt',async t=>{
  const f=nativeIncident(t);await staleNeighbour(f);assert.equal((await f.bridge({tabId:'C'})).ok,true);
  const receipt=f.state.lastSaveResult.closeReceipt,entry=f.manager.getTabHistoryEntry(receipt.historyId,f.p);
  assert.equal(entry.tab_id,'C');assert.equal(entry.execution_subject_id,receipt.subjectId);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'C'}).archived,true);
  assert.ok(f.manager.db.prepare('SELECT 1 FROM workflow_execution_mutations WHERE mutation_id=?').get(receipt.mutationId));
  assert.equal(f.calls.filter(x=>x==='project:delete-tab-history-entry').length,0);
});
test('incident C: MCP → private HTTP → actual App/Store/Main/SQL returns truthful committed close with stale A',async t=>{
  const f=nativeIncident(t);await staleNeighbour(f);const {tool}=await httpFixture(t,f);
  const result=JSON.parse(await tool({tabId:'C'}));assert.equal(result.ok,true);assert.equal(result.closed,true);
  f.reopenDb();assert.ok(!f.dbIds(f.p).includes('C'));assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
});
test('lost finalize ACK recovers same original receipt without Archive/Stop/terminal-kill replay',async t=>{
  const f=nativeIncident(t);f.state.loseFinalizeAck=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.ok(f.ws.tabs.has('C'));
  const request=f.state.lastFinalizeRequest,counts={archive:f.calls.filter(x=>x==='project:archive-tab').length,
    kill:f.calls.filter(x=>Array.isArray(x)&&x[0]==='terminal:kill').length};
  assert.equal(f.manager._executionPendingArchiveIds.has('C'),false,'durable finalize already settled Main');
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.state.lastFinalizeRequest.receipt.mutationId,request.receipt.mutationId);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,counts.archive);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='terminal:kill').length,counts.kill);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,0);
  assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
});
test('refused finalization preserves History and recovers original receipt after DB reopen',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;assert.equal((await f.bridge({tabId:'C'})).ok,false);
  const request=f.state.lastFinalizeRequest;assert.ok(f.manager.getTabHistoryEntry(request.receipt.historyId,f.p));
  f.reopenDb();f.state.failFinalize=false;
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);assert.ok(!f.dbIds(f.p).includes('C'));
});
for(const field of ['mutationId','scopeId','historyId','namespace','subjectId','storageId','archivedRevision','manifestHash'])
  test('exact finalization refuses changed receipt '+field,async t=>{
    const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
    const original=f.state.lastFinalizeRequest,request=structuredClone(original);
    request.receipt[field]=typeof request.receipt[field]==='number'?request.receipt[field]+1:request.receipt[field]+'-foreign';
    assert.equal(f.finalize(request).success,false);
    assert.ok(f.ws.tabs.has('C'));assert.ok(f.manager.getTabHistoryEntry(original.receipt.historyId,f.p));
  });
for(const change of ['restored','replaced','history-missing'])test('native finalize rejects '+change+' original owner',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});const request=f.state.lastFinalizeRequest;
  const row=f.manager.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('C');
  if(change==='restored')f.manager.db.prepare('UPDATE tabs SET execution_archived=0 WHERE tab_id=?').run('C');
  else if(change==='replaced'){
    f.manager.db.prepare('DELETE FROM tabs WHERE tab_id=?').run('C');const {id,...copy}=row;f.manager._executionInsert('tabs',copy);
    assert.notEqual(f.manager.db.prepare('SELECT id FROM tabs WHERE tab_id=?').get('C').id,id);
  }else f.manager.deleteTabHistoryEntry(request.receipt.historyId);
  assert.equal(f.finalize(request).success,false);assert.ok(f.ws.tabs.has('C'));
});
test('native file-family close is atomic across catalogs without touching stale A or document bytes',async t=>{
  const f=nativeIncident(t,{foreign:true,linked:true});const a=await staleNeighbour(f);
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  for(const id of ['C','F']){assert.ok(!f.ws.tabs.has(id));assert.ok(!f.dbIds(f.p).includes(id));}
  assert.ok(!f.other.tabs.has('foreign-file'));assert.ok(!f.dbIds(f.q).includes('foreign-file'));
  assert.deepEqual(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'A'}).row,a.current.row);
  assert.equal(f.fileBytes(),'# Original document\n');
});
for(const change of ['late-link','file-revision','file-namespace'])test('native finalization preserves linked family on '+change,async t=>{
  const f=nativeIncident(t,{linked:true});f.state.beforeSave=()=>{
    f.state.beforeSave=null;
    if(change==='late-link')f.addFile('late','C',f.q);
    else if(change==='file-revision')f.manager.db.prepare('UPDATE tabs SET notes=? WHERE tab_id=?').run('changed file','F');
    else {const row=f.manager.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get('F');
      f.manager.db.prepare('DELETE FROM tabs WHERE tab_id=?').run('F');f.manager._executionInsert('tabs',{...row,execution_namespace:f.q});}
  };
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.ok(f.ws.tabs.has('C')&&f.ws.tabs.has('F'));
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:change==='file-namespace'?f.q:f.p,tabId:'F'}).archived,false);
  assert.ok(f.manager.getTabHistoryEntry(f.state.lastFinalizeRequest.receipt.historyId,f.p));
});
test('SQL failure mid-family rolls back every file while retaining root archive and pending receipt',async t=>{
  const f=nativeIncident(t,{foreign:true,linked:true});
  f.manager.db.exec("CREATE TEMP TRIGGER close_fail BEFORE DELETE ON tabs WHEN OLD.tab_id='foreign-file' BEGIN SELECT RAISE(ABORT,'controlled-family-write-failure'); END");
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F'}).archived,false);
  assert.ok(f.dbIds(f.q).includes('foreign-file'));assert.ok(f.manager._executionPendingArchiveIds.has('C'));
  const request=f.state.lastFinalizeRequest;assert.ok(f.manager.getTabHistoryEntry(request.receipt.historyId,f.p));
  f.manager.db.exec('DROP TRIGGER close_fail');assert.equal((await f.bridge({tabId:'C'})).ok,true);
});
test('duplicate receipt is idempotent and later restored file invalidates that same completion',async t=>{
  const f=nativeIncident(t,{linked:true});assert.equal((await f.bridge({tabId:'C'})).ok,true);
  const request=f.state.lastFinalizeRequest,before=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F'}).revision;
  assert.equal(f.finalize(request).success,true);assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'F'}).revision,before);
  f.manager.db.prepare('UPDATE tabs SET execution_archived=0 WHERE tab_id=?').run('F');
  assert.equal(f.finalize(request).success,false);
});
test('native close advances only its own child relation and keeps child session/files usable',async t=>{
  const f=nativeIncident(t);f.addNative('child-C',{tabType:'terminal',filePath:null,visualParentTabId:'C'});
  f.addNative('child-C-file',{visualParentTabId:'child-C'});const child=f.ws.tabs.get('child-C');
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.ok(f.ws.tabs.has('child-C')&&f.ws.tabs.has('child-C-file'));assert.equal(f.ws.tabs.get('child-C').visualParentTabId,undefined);
  const current=f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'child-C'});
  assert.equal(current.tab.visualParentTabId,null);assert.equal(current.tab.closedVisualParentTabId,'C');
  assert.equal(f.ws.tabs.get('child-C').executionStorageRevision,current.revision);
});
test('unknown Stop cannot finalize or delete native History and cannot replay Archive/Stop on recovery',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;
  f.state.stopResult={success:false,error:'process_lookup_unknown'};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  const entry=f.manager.getTabHistory(f.p).find(row=>row.tab_id==='C');assert.ok(entry);
  assert.ok(!f.calls.some(x=>Array.isArray(x)&&x[0]==='terminal:kill'));
  assert.equal(f.state.lastFinalizeRequest,undefined);
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.ok(f.ws.tabs.has('C'));assert.ok(f.manager.getTabHistoryEntry(entry.id,f.p));
});
test('renderer replacement is kept even when the exact original SQL close committed',async t=>{
  const f=nativeIncident(t);let replacement;
  f.state.beforeSave=()=>{f.state.beforeSave=null;replacement={...f.ws.tabs.get('C'),name:'replacement renderer owner'};f.ws.tabs.set('C',replacement);};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.equal(f.ws.tabs.get('C'),replacement);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'C'}).archived,true);
  assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
});
test('same original archive request returns its receipt; changed body or a new archive operation cannot adopt archived1',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
  const original=f.state.lastArchiveRequest,first=await f.archive(original);
  assert.deepEqual(first.closeReceipt,f.state.lastFinalizeRequest.receipt);
  await assert.rejects(f.archive({...original,tab:{...original.tab,name:'changed under old key'}}),/archive_close_operation_changed/);
  await assert.rejects(f.archive({...original,closeRequest:{...original.closeRequest,mutationId:crypto.randomUUID()}}),/archive_close_operation_changed/);
  assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
});
for(const change of ['late-unrelated','missing-unrelated','omitted-survivor'])test('exact namespace precondition rejects '+change,async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
  const request=structuredClone(f.state.lastFinalizeRequest);
  if(change==='late-unrelated')f.addNative('late-unrelated',{tabType:'terminal',filePath:null});
  if(change==='missing-unrelated')f.manager.db.prepare('DELETE FROM tabs WHERE tab_id=?').run('A');
  if(change==='omitted-survivor')request.snapshots[0].tabs=request.snapshots[0].tabs.filter(row=>row.tabId!=='A');
  assert.equal(f.finalize(request).success,false);assert.ok(f.ws.tabs.has('C'));
  assert.ok(f.manager.getTabHistoryEntry(request.receipt.historyId,f.p));
});
test('unknown authority read cannot publish a close ACK or discard its existing History',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
  const request=f.state.lastFinalizeRequest;
  f.manager.db.exec('ALTER TABLE workflow_execution_mutations RENAME TO unavailable_mutations');
  assert.equal(f.finalize(request).success,false);assert.ok(f.ws.tabs.has('C'));
  assert.ok(f.manager.getTabHistoryEntry(request.receipt.historyId,f.p));
});
test('finalization cannot clear RAM pending inside an uncommitted outer transaction',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
  const request=f.state.lastFinalizeRequest;
  assert.throws(()=>f.manager.db.transaction(()=>f.manager.finalizeArchivedClose(request))(),/archive_close_outer_transaction_not_supported/);
  assert.ok(f.manager._executionPendingArchiveIds.has('C'));
  assert.ok(f.manager.getTabHistoryEntry(request.receipt.historyId,f.p));
});
test('post-commit publication failure preserves truthful close ACK and its durable History',async t=>{
  const f=nativeIncident(t);f.state.failPublication=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,true);assert.ok(!f.ws.tabs.has('C'));
  assert.ok(f.manager.getTabHistoryEntry(f.state.lastSaveResult.closeReceipt.historyId,f.p));
});
test('native close preserves concurrent unrelated renderer metadata and another workspace',async t=>{
  const f=nativeIncident(t);let pending;const neighbour={projectId:'parallel',tabs:new Map()};
  f.state.beforeSave=()=>{f.state.beforeSave=null;
    f.state.openProjects=new Map([...f.state.openProjects,['parallel',neighbour]]);
    pending={...f.ws.tabs.get('A'),name:'Pending renderer authoring'};f.ws.tabs.set('A',pending);
  };
  assert.equal((await f.bridge({tabId:'C'})).ok,true);
  assert.equal(f.state.openProjects.get('parallel'),neighbour);assert.equal(f.ws.tabs.get('A'),pending);
  assert.equal(pending.name,'Pending renderer authoring');assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'A'}).tab.name,'A');
});
test('finalization cannot change snapshot namespace or drop an original group guard',async t=>{
  const f=nativeIncident(t);f.state.failFinalize=true;await f.bridge({tabId:'C'});
  const original=f.state.lastFinalizeRequest,request=structuredClone(original);request.snapshots[0].projectId=f.q;
  assert.equal(f.finalize(request).success,false);
  const forged=structuredClone(original);forged.groupCloseGuard={mutationId:'foreign',tabId:'C',guardToken:'foreign'};
  assert.equal(f.finalize(forged).success,false);assert.ok(f.ws.tabs.has('C'));
});
test('wrong successful finalize ACK cannot remove renderer owner; exact original receipt still recovers without replay',async t=>{
  const f=nativeIncident(t);f.state.wrongFinalizeAck=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.ok(f.ws.tabs.has('C'));
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'C'}).archived,true);
  assert.equal((await f.bridge({tabId:'C'})).ok,true);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='terminal:kill').length,1);
});
test('review R1: committed archive ACK loss retains immutable intent before invoke and recovers without another archive',async t=>{
  const f=nativeIncident(t);f.state.loseArchiveAck=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.manager.getExecutionTabV2({executionNamespace:f.p,tabId:'C'}).archived,true);
  assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
  const pending=f.ws.tabs.get('C').__archiveClosePending;
  assert.ok(pending?.archiveRequest,'original immutable request exists despite missing ACK');
  assert.equal(f.state.intentSeenBeforeArchive,true);assert.equal(Object.isFrozen(pending.archiveRequest),true);
  assert.equal(Object.isFrozen(pending.archiveRequest.tab),true);
  assert.equal(pending.archiveRequest.closeRequest.mutationId,f.state.lastArchiveRequest.closeRequest.mutationId);
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.manager.getTabHistory(f.p).filter(row=>row.tab_id==='C').length,1);
});
test('review R2: UNKNOWN original Stop stays held then same-owner fresh absence completes without repeating Stop',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;
  f.state.stopResult={success:false,error:'process_lookup_unknown'};f.state.processStatus='unknown';
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal((await f.bridge({tabId:'C'})).ok,false,'unknown remains held');
  f.state.processStatus='absent';
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='terminal:kill').length,1,'only the original owned shell teardown');
});
for(const change of ['replacement','runSeq','inputRevision','stopRevision'])test('review R2: later absent proof refuses '+change,async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state.stopResult={success:false,error:'unknown'};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  if(change==='replacement')f.addRuntime('C');else f.runtimes.get('C')[change]++;
  f.state.processStatus='absent';assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='terminal:kill').length,0);
  assert.ok(f.ws.tabs.has('C'));
});
test('review R2: original admitted Stop fence advances once; later absence recovers that owned fence, not latest revision',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state.advanceOwnStopFence=true;
  f.state.stopResult={success:false,error:'exit-observation-unknown'};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.equal(f.runtimes.get('C').stopRevision,1);
  f.state.processStatus='absent';assert.equal((await f.bridge({tabId:'C'})).ok,true);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,1);
});
test('review R2: owner replacement during fresh process observation never kills either owner',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state.stopResult={success:false,error:'unknown'};
  await f.bridge({tabId:'C'});f.state.processStatus='absent';
  f.state.beforeProcessProof=()=>{f.state.beforeProcessProof=null;f.addRuntime('C');};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
});
for(const phase of ['Stop','Kill'])test('review: lost '+phase+' ACK recovers exact original runtime step without another signal',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state['lose'+phase+'Ack']=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.ok(f.ws.tabs.has('C'));
  assert.equal((await f.bridge({tabId:'C'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,1);
});
test('review R1: archive outcome with no authoritative journal remains held without new Archive/Stop/kill',async t=>{
  const f=nativeIncident(t);f.state.archiveTransportBeforeCommit=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);assert.ok(f.ws.tabs.get('C').__archiveClosePending);
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,0);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
});
test('review R1: original frozen archive body survives renderer authoring changes; altered recovery request refuses',async t=>{
  const f=nativeIncident(t);f.state.loseArchiveAck=true;await f.bridge({tabId:'C'});
  const pending=f.ws.tabs.get('C').__archiveClosePending,original=pending.archiveRequest;
  const wrong=structuredClone(original);wrong.tab.name='foreign recovery body';
  const before=f.manager.db.prepare('SELECT COUNT(*) n FROM workflow_execution_mutations').get().n;
  assert.equal((await f.finalize({recover:true,archiveRequest:wrong})).success,false);
  assert.equal(f.manager.db.prepare('SELECT COUNT(*) n FROM workflow_execution_mutations').get().n,before,'recovery read does not mutate journal');
  assert.equal(pending.archiveRequest,original);assert.equal((await f.bridge({tabId:'C'})).ok,true);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
});
test('review R1: archive ACK loss while original AI still exists admits its first guarded Stop exactly once',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state.processStatus='found';
  f.state.loseArchiveAck=true;f.state.recheckStopGuardAfterFence=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,0);
  assert.equal((await f.bridge({tabId:'C'})).ok,true);
  assert.equal(f.state.stopGuardAfterFence,true,'same operation may continue after its own single markAiStopping fence');
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,1);
});
test('review R2: success receipt without fresh absence cannot kill a still-present process',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;
  f.state.processStatus='found';f.state.keepProcessAfterStop=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
});
test('actual shared Stop scenario forwards private close guards, while ordinary Stop has unchanged options',async()=>{
  const node=walk(mainTree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='stopAgentProcessScenarioInMain');
  const guard={preSignalGuard:()=>({allowed:true}),onStopAdmitted:()=>{}};let options;
  const run=vm.runInNewContext('('+node.getText(mainTree)+')',{
    require:()=>({sendIntentCancellationAvailable:()=>true}),path,srcMainDir:'/private-source',
    prepareStopPendingSends:()=>({ok:true,inputs:[]}),console:{log(){}},
    stopAiProcessInTabSerialized:async(_id,value)=>{options=value;return {success:true};},
  });
  assert.equal((await run({tabId:'C',reason:'close-tab'},guard)).success,true);
  assert.equal(options.preSignalGuard,guard.preSignalGuard);assert.equal(options.onStopAdmitted,guard.onStopAdmitted);
  assert.equal((await run({tabId:'C',reason:'close-tab'})).success,true);
  assert.equal(options.preSignalGuard,undefined);assert.equal(options.onStopAdmitted,undefined);
});
for(const lost of ['Archive','Stop'])test('review: native SDK '+lost+' ACK loss recovers its original guarded hard-stop, without PTY kill',async t=>{
  const f=fixture(t);f.keepOwnerOnly();f.state.realArchive=true;
  f.addNative('S',{tabType:'claude-sdk',filePath:null,commandType:'generic'});
  f.sdkSessions.set('S',{stopObservation:{inputRevision:0,tasks:new Set()}});
  f.state['lose'+lost+'Ack']=true;
  assert.equal((await f.bridge({tabId:'S'})).ok,false);assert.ok(f.ws.tabs.has('S'));
  assert.equal((await f.bridge({tabId:'S'})).ok,true,JSON.stringify(f.state.lastSaveResult));
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>x==='claude-sdk:stop').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
});
test('review: missing typed process proof never becomes absence or permission to continue',async t=>{
  const f=nativeIncident(t);f.state.missingProcessProof=true;
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='project:archive-tab').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
  assert.ok(f.ws.tabs.has('C'));
});
test('review: new pending launch fences late absence and never repeats the original Stop',async t=>{
  const f=nativeIncident(t);f.state.aiRuntime=true;f.state.commandRunning=true;f.state.stopResult={success:false,error:'unknown'};
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  f.state.pendingRuntimeLaunch=true;f.state.processStatus='absent';
  assert.equal((await f.bridge({tabId:'C'})).ok,false);
  assert.equal(f.calls.filter(x=>x==='terminal:stop-ai-process').length,1);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pty.kill').length,0);
});
