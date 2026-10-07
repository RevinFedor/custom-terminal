import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import * as placement from '../utils/tabRestorePlacement.mjs';
import * as panes from '../utils/splitPanesModel.mjs';
import * as spaces from '../utils/workspaceSpacesModel.mjs';
import { dropFromMru } from '../utils/tabSwitcherModel.mjs';
import { commitArchiveWithStopRetry, isDurableSaveTabsAck } from '../utils/tabPersistenceTransactions.mjs';
import { stopAiBeforeTerminalKill } from '../utils/terminalCloseLifecycle.mjs';
import { collectTabLinkedFiles } from '../utils/tabLinkedFiles.mjs';
import ts from 'typescript';

const appSource=fs.readFileSync(process.env.NOTED_REOPEN_BASELINE_APP || new URL('../App.tsx',import.meta.url),'utf8');
const appAst=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let hotkeySource;
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(appAst)==='handleReopenLastClosedCapture')hotkeySource=node.initializer.getText(appAst);
  ts.forEachChild(node,visit);
}
visit(appAst);assert.ok(hotkeySource);

const source = process.env.NOTED_RESTORE_CONTROL === 'before'
  ? execFileSync('git', ['show', 'HEAD:src/renderer/store/useWorkspaceStore.ts'], { encoding: 'utf8' })
  : fs.readFileSync(new URL('./useWorkspaceStore.ts', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start, source.indexOf('export const useWorkspaceStore')), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from); return source.slice(from, to);
};
const code = transformSync('module.exports = {'
  + section('  closeTab: async', '\n  switchTab:')
  + section('  clearTabFromSplitPane:', '\n  detachTabFromWindow:')
  + section('  restoreLastDetachedTabToSplitPane:', '\n  centerStrips:')
  + section('  removeTabFromCenterStrip:', '\n  arrangeSplitPanes:')
  + section('  setTabVisualParent:', '\n  applyTabLayout:')
  + '};', { loader: 'ts', format: 'cjs' }).code;
const clone = value => JSON.parse(JSON.stringify(value));
const chip = tabId => ({ projectId: 'p', tabId });
const tab = (id, parent) => ({ id, name: id, cwd: '/fixture', groupId: 'g', visualParentTabId: parent, tabType: 'terminal' });

function fixture() {
  const workspace = { projectId: 'p', projectPath: '/fixture', tabCounter: 20,
    tabs: new Map([tab('left'), tab('parent'), tab('child', 'parent'), tab('grandchild', 'child'), tab('right')].map(t => [t.id, t])),
    tabGroups: [{ id: 'g' }], tabHistory: [], activeTabId: 'child' };
  const archive = [], saves = [], calls = [], opts = [];let historySequence=0;
  const state = { openProjects: new Map([['p', workspace]]), activeProjectId: 'p', activeSpaceId: 'main',
    spaces: [{ id: 'main', layout: {} }], centerStrips: {}, globalTabMru: [],
    splitPanes: [{ ...chip('child'), windowId: 'original', tabs: [chip('left'), chip('child'), { slotId: 'new', projectId: 'p' }, chip('right')] }],
    splitFocusedIndex: 0, activeSpaceTab: chip('child'), clearTerminalBuffer() {},
    centerStripKey: () => 'p', getEffectiveTabId: () => workspace.activeTabId,
    getFocusedProjectId: () => 'p',
    saveSession: () => calls.push('save-layout'), setProjectView() {},
    switchTab: (p, id) => { state.openProjects.get(p).activeTabId = id; calls.push('switch:' + id); },
    activateCenterTab: (p, id) => { state.openProjects.get(p).activeTabId = id; calls.push('activate:' + id); },
    addTabToSplitPaneStrip: (index, p, id) => { calls.push('fallback'); state.splitPanes = panes.restoreTabAtPanePosition(state.splitPanes, index, chip(id)).panes; },
    createTab: async (_p, name, cwd, options) => {
      opts.push(options);
      if (state.createError) throw Error('fixture-create-failure');
      const targetWorkspace=state.openProjects.get(_p);
      const id = options.restoreId || (_p==='p'?'':_p+'-')+'new-' + targetWorkspace.tabCounter++;
      targetWorkspace.tabs.set(id, { id, name, cwd, groupId: options.groupId, tabType: options.tabType });
      return id;
    },
  };
  const persist = async (_p, tabs) => {
    saves.push(clone([...tabs])); calls.push('save-tabs');
    return { success: !state.saveError };
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, console: { log() {}, warn() {}, error() {} },
    ...placement, ...panes, ...spaces, dropFromMru, collectTabLinkedFiles, commitArchiveWithStopRetry, isDurableSaveTabsAck, stopAiBeforeTerminalKill,
    get: () => state, set: patch => Object.assign(state, patch), startTransition: fn => fn(),
    saveTabs: persist, saveTabsThenNotifyProjectLayoutChanged: persist, notifyProjectLayoutChanged() {},
    clearPendingAutoTabTitle() {}, autoTabTitleIntents: new Map(),
    resolvePtyAgentOwner: () => null, isAiRuntimeTab: () => false, isAiBusyTab: () => false,
    useUIStore: { getState: () => ({ showToast() {} }) }, usePromptQueueStore: { getState: () => ({ cleanupClosedTab() {} }) },
    reopenLastClosedQueues: new Map(), resolveExistingTabGroupId: (w, id) => w.tabGroups.some(g => g.id === id) ? id : undefined,
    resolveHistoryRestoreCwd: async e => ({ cwd: e.cwd }), buildHistoryPendingAction: () => undefined,
    parseHistoryTaskPlan: () => undefined, formatHistoryRestoreError: (_e, err) => err.message,
    ipcRenderer: { send() {}, invoke: async (channel, args) => {
      if (channel === 'terminal:getCommandState') return { isRunning: false };
      if (channel === 'project:validate-tab-snapshot' || channel === 'orchestration:tab-closed') return { success: true };
      if (channel === 'project:archive-tab') {
        if (state.archiveError) return { success: false, error: 'fixture-archive-failure' };
        const t = args.tab;
        const row = { id: ++historySequence, project_id: args.projectId, tab_id: t.tabId, name: t.name, cwd: t.cwd,
          position: t.position, group_id: t.groupId, restore_placement: t.restorePlacement ? JSON.stringify(t.restorePlacement) : null };
        archive.push(row); return { success: true, historyId: row.id };
      }
      if (channel === 'project:begin-tab-history-restore') {
        const row = args.id ? archive.find(e => e.id === args.id) : archive.at(-1);
        return row ? { ok: true, entry: row, token: 'lease' } : { ok: false, reason: 'not_found' };
      }
      if (channel === 'project:peek-window-tab-history') {
        if (state.peekError) throw Error('fixture-peek-failure');
        await state.peekWait?.();
        const rows=archive.filter(row=>{
          const p=placement.readTabRestorePlacement(row.restore_placement);
          return args.projectIds.includes(row.project_id) && (args.projectOnly
            || p?.window?.spaceId===args.spaceId && p?.window?.windowId===args.windowId);
        }).map(row=>({...row,closedOrder:JSON.parse(row.restore_placement)?.closedOrder || row.closedOrder || 1}))
          .filter(row=>row.closedOrder<=args.beforeOrder);
        rows.sort((a,b)=>b.closedOrder-a.closedOrder);
        return {success:true,entry:rows[0]||null};
      }
      if (channel === 'project:finish-tab-history-restore') {
        calls.push('finish:' + args.commit);
        if (args.commit) archive.splice(archive.findIndex(e => e.id === args.id), 1);
        return { ok: true, committed: args.commit };
      }
      if (channel === 'project:delete-tab-history-entry') { archive.splice(archive.findIndex(e => e.id === args.id), 1); return { success: true }; }
      throw Error('unexpected IPC: ' + channel);
    } },
  });
  Object.assign(state, module.exports);
  const pending=[];
  const pressUndo=vm.runInNewContext(transformSync('(' + hotkeySource + ')',{loader:'tsx'}).code,{
    view:'workspace',console,
    useWorkspaceStore:{getState:()=>({...state,reopenLastClosedTab:(...args)=>{const p=state.reopenLastClosedTab(...args);pending.push(p);return p;}})},
    useUIStore:{getState:()=>({triggerReopenPulse:()=>calls.push('pulse')})},showToast:message=>calls.push('toast:'+message),
  });
  return { state, workspace, archive, saves, calls, opts,
    pressUndo:()=>pressUndo({metaKey:true,shiftKey:true,altKey:false,ctrlKey:false,code:'KeyT',preventDefault(){},stopPropagation(){},stopImmediatePropagation(){}}),
    flushUndo:()=>Promise.all(pending.splice(0)),
  };
}

test('actual hotkey restores newer Full before an older detached chip (919 -> 834 regression)', async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');await f.state.closeTab('p','child');
  f.pressUndo();await f.flushUndo();
  assert.equal(f.workspace.tabs.get(f.workspace.activeTabId)?.name,'child');
  assert.equal(f.archive.length,0);
  f.pressUndo();await f.flushUndo();assert.equal(f.workspace.activeTabId,'left');
  assert.equal(f.opts.length,1,'detached tab remains the same runtime');
});

test('actual hotkey restores newer removal before older Full, including rapid repeated presses', async()=>{
  const f=fixture();await f.state.closeTab('p','child');f.state.clearTabFromSplitPane('left');
  f.pressUndo();f.pressUndo();await f.flushUndo();
  assert.equal(f.calls.filter(c=>c.startsWith('activate:'))[0],'activate:left');
  assert.equal(f.workspace.tabs.get(f.workspace.activeTabId)?.name,'child');
  assert.equal(f.archive.length,0);assert.equal(f.opts.length,1);
});

test('archive candidate is window-scoped; a newer Full in another window does not displace local undo', async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');
  f.state.splitPanes.push({...chip('right'),windowId:'neighbour'});
  f.state.splitPanes[0]=panes.vacantPaneWithTabs(f.state.splitPanes[0],[chip('child')]);
  await f.state.closeTab('p','right');f.state.splitFocusedIndex=0;
  f.pressUndo();await f.flushUndo();assert.equal(f.workspace.activeTabId,'left');
  assert.equal(f.archive.length,1);assert.equal(f.opts.length,0);
});

test('a moved focus/pane while archive peek waits retains the requested window identity',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');let release;
  f.state.peekWait=()=>new Promise(resolve=>{release=resolve;});
  f.pressUndo();await new Promise(resolve=>setImmediate(resolve));
  f.state.splitPanes.unshift({...chip('right'),windowId:'other'});f.state.splitFocusedIndex=0;
  release();await f.flushUndo();
  assert.ok(panes.paneSlots(f.state.splitPanes[1]).some(t=>t.tabId==='left'));
  assert.equal(f.state.splitFocusedIndex,1);
});

test('archive read failure consumes neither undo source',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');await f.state.closeTab('p','child');
  f.state.peekError=true;f.pressUndo();await f.flushUndo();
  assert.equal(f.archive.length,1);assert.equal(f.opts.length,0);
  assert.ok(panes.paneDetachedTabs(f.state.splitPanes[0]).some(t=>t.tabId==='left'));
});

test('a later removal during archive read cannot replace the undo requested by the keypress',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');let release;
  f.state.peekWait=()=>new Promise(resolve=>{release=resolve;});
  f.pressUndo();await new Promise(resolve=>setImmediate(resolve));
  f.state.clearTabFromSplitPane('right');release();await f.flushUndo();
  assert.equal(f.workspace.activeTabId,'left');
  assert.ok(panes.paneDetachedTabs(f.state.splitPanes[0]).some(t=>t.tabId==='right'));
  f.state.peekWait=null;f.pressUndo();await f.flushUndo();
  assert.equal(f.workspace.activeTabId,'right');assert.equal(f.opts.length,0);
});

test('a later Full during archive read remains for the next keypress',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');let release;
  f.state.peekWait=()=>new Promise(resolve=>{release=resolve;});
  f.pressUndo();await new Promise(resolve=>setImmediate(resolve));
  await f.state.closeTab('p','child');release();await f.flushUndo();
  assert.equal(f.workspace.activeTabId,'left');assert.equal(f.archive.length,1);
  f.state.peekWait=null;f.pressUndo();await f.flushUndo();
  assert.equal(f.workspace.tabs.get(f.workspace.activeTabId)?.name,'child');assert.equal(f.archive.length,0);
});

test('an initially empty undo cannot pick a later Full through the project fallback',async()=>{
  const f=fixture();let release;
  f.state.peekWait=()=>new Promise(resolve=>{release=resolve;});
  f.pressUndo();await new Promise(resolve=>setImmediate(resolve));
  await f.state.closeTab('p','child');f.state.peekWait=null;release();await f.flushUndo();
  assert.equal(f.archive.length,1);assert.equal(f.opts.length,0);
  f.pressUndo();await f.flushUndo();
  assert.equal(f.workspace.tabs.get(f.workspace.activeTabId)?.name,'child');
});

test('Full from another project in this window is restored even when sidebar names the first project',async()=>{
  const f=fixture();const q={projectId:'q',projectPath:'/fixture',tabCounter:20,tabs:new Map([['remote',tab('remote')]]),tabGroups:[],tabHistory:[],activeTabId:'remote'};
  f.state.openProjects.set('q',q);
  f.state.splitPanes[0]={...f.state.splitPanes[0],projectId:'q',tabId:'remote',tabs:[chip('left'),{projectId:'q',tabId:'remote'}]};
  f.state.clearTabFromSplitPane('left');await f.state.closeTab('q','remote');
  f.pressUndo();await f.flushUndo();assert.equal(q.tabs.get(q.activeTabId)?.name,'remote');
  assert.ok(panes.paneSlots(f.state.splitPanes[0]).some(t=>t.projectId==='q'));
});

test('window removed during candidate read keeps access to the exact detached tab without a new runtime',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');let release;
  f.state.peekWait=()=>new Promise(resolve=>{release=resolve;});f.pressUndo();await new Promise(resolve=>setImmediate(resolve));
  f.state.splitPanes=[{...chip('right'),windowId:'replacement'}];release();await f.flushUndo();
  assert.equal(f.workspace.activeTabId,'left');assert.equal(f.opts.length,0);
  assert.equal(f.state.splitPanes[0].windowId,'replacement');
});

test('a legacy un-timed detached row does not override a dated Full in the same window',async()=>{
  const f=fixture();f.state.clearTabFromSplitPane('left');
  delete f.state.splitPanes[0].detachedTabs[0].closedOrder;
  await f.state.closeTab('p','child');f.pressUndo();await f.flushUndo();
  assert.equal(f.workspace.tabs.get(f.workspace.activeTabId)?.name,'child');
  f.pressUndo();await f.flushUndo();assert.equal(f.workspace.activeTabId,'left');
});

test('actual close → Cmd Shift T restores hierarchy and strip order with a fresh runtime identity', async () => {
  const f = fixture();
  assert.equal(await f.state.closeTab('p', 'child'), true);
  assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, undefined);
  const r = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.notEqual(r.tabId, 'child', 'old terminal kill/exit cannot affect the restored tab');
  assert.equal(f.opts[0].restoreId, undefined);
  assert.deepEqual([...f.workspace.tabs.keys()], ['left', 'parent', r.tabId, 'grandchild', 'right']);
  assert.equal(f.workspace.tabs.get(r.tabId).visualParentTabId, 'parent');
  assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, r.tabId);
  assert.deepEqual(panes.paneSlots(f.state.splitPanes[0]).map(s => s.tabId || s.slotId), ['left', r.tabId, 'new', 'right']);
  assert.equal(f.archive.length, 0);
  assert.equal(f.saves.at(-1).find(([id]) => id === 'grandchild')[1].visualParentTabId, r.tabId);
  assert.ok(f.calls.lastIndexOf('save-tabs') < f.calls.indexOf('finish:true'));
});

test('actual restore follows original window after focus moved, not the currently focused neighbour', async () => {
  const f = fixture(); await f.state.closeTab('p', 'child');
  f.state.splitPanes.unshift({ ...chip('other'), windowId: 'neighbour' });
  const r = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.ok(f.workspace.tabs.has(r.tabId));
  assert.ok(panes.paneSlots(f.state.splitPanes[1]).some(s => s.tabId === r.tabId));
  assert.equal(f.calls.includes('fallback'), false);
});

test('parent and child survive repeated close/reopen with new runtime ids each time', async () => {
  const f = fixture();
  await f.state.closeTab('p', 'parent');
  await f.state.closeTab('p', 'child');
  const child = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  const parent = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.equal(f.workspace.tabs.get(child.tabId).visualParentTabId, parent.tabId);
  assert.equal(f.workspace.tabs.get('grandchild').visualParentTabId, child.tabId);
  assert.deepEqual([...f.workspace.tabs.values()].map(placement.tabPlacementId), ['left', 'parent', 'child', 'grandchild', 'right']);
  await f.state.closeTab('p', parent.tabId);
  const again = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.notEqual(again.tabId, parent.tabId);
  assert.equal(f.workspace.tabs.get(child.tabId).visualParentTabId, again.tabId);
  assert.equal(f.workspace.tabs.get(again.tabId).restorePlacementId, 'parent');
});

test('background Home restore inserts into the original bar without selecting it', async () => {
  const f = fixture(); await f.state.closeTab('p', 'child');
  f.state.splitPanes[0] = { ...f.state.splitPanes[0], ...chip('right') };
  f.calls.length = 0;
  const r = await f.state.restoreTabHistoryEntry('p', undefined, { background: true, restorePosition: true });
  assert.ok(f.workspace.tabs.has(r.tabId));
  assert.equal(f.state.splitPanes[0].tabId, 'right');
  assert.equal(f.calls.some(c => c.startsWith('activate:') || c.startsWith('switch:')), false);
});

test('deleted original window falls back to the requested surviving pane', async () => {
  const f = fixture(); await f.state.closeTab('p', 'child');
  f.state.splitPanes = [{ ...chip('right'), windowId: 'new-window' }];
  const r = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.ok(f.workspace.tabs.has(r.tabId));
  assert.equal(f.calls.includes('fallback'), true);
  assert.equal(f.state.splitPanes.length, 1);
});

test('an already live archived identity is not overwritten or removed from history', async () => {
  const f = fixture(); await f.state.closeTab('p', 'child');
  f.workspace.tabs.set('child', { ...tab('child'), name: 'live replacement' });
  const result = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.equal(result.reason, 'busy');
  assert.equal(f.archive.length, 1); assert.equal(f.opts.length, 0);
  assert.equal(f.workspace.tabs.get('child').name, 'live replacement');
});

test('actual close persistence failure does not orphan live children', async () => {
  const f = fixture(); f.state.saveError = true;
  assert.equal(await f.state.closeTab('p', 'parent'), false);
  assert.ok(f.workspace.tabs.has('parent'));
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, 'parent');
});

for (const failure of ['createError', 'saveError']) test('actual restore ' + failure + ' leaves the recoverable archive', async () => {
  const f = fixture(); await f.state.closeTab('p', 'child'); f.state[failure] = true;
  const result = await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.equal(f.archive.length, 1);
  assert.equal(f.calls.includes('finish:true'), false);
  if (failure === 'saveError') assert.equal(result.historyDeleteFailed, true);
});

test('explicit reparent cancels old parent undo', async () => {
  const f = fixture(); await f.state.closeTab('p', 'parent');
  f.state.setTabVisualParent('p', 'child', null);
  await f.state.reopenLastClosedTab('p', { targetPaneIndex: 0 });
  assert.equal(f.workspace.tabs.get('child').visualParentTabId, undefined);
});

test('actual local remove/undo changes no durable tabs or archive', () => {
  const f = fixture(), original = clone(panes.paneSlots(f.state.splitPanes[0]));
  f.state.clearTabFromSplitPane('child');
  assert.equal(f.state.restoreLastDetachedTabToSplitPane(0), true);
  assert.deepEqual(clone(panes.paneSlots(f.state.splitPanes[0])), original);
  assert.equal(f.workspace.tabs.size, 5); assert.equal(f.archive.length, 0); assert.equal(f.saves.length, 0);
});

for (const id of ['child', 'left']) test('single centre remove/undo ' + id + ' preserves order and live tabs', () => {
  const f = fixture(); f.state.splitPanes = [];
  f.state.centerStrips = { p: [chip('left'), chip('child'), chip('right')] };
  f.state.removeTabFromCenterStrip('p', id);
  assert.equal(f.state.restoreLastDetachedTabToSplitPane(0), true);
  assert.deepEqual(panes.paneSlots(f.state.splitPanes[0]).map(s => s.tabId), ['left', 'child', 'right']);
  assert.equal(f.workspace.tabs.size, 5); assert.equal(f.archive.length, 0);
});
