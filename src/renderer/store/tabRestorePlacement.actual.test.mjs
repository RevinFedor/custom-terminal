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
  const archive = [], saves = [], calls = [], opts = [];
  const state = { openProjects: new Map([['p', workspace]]), activeProjectId: 'p', activeSpaceId: 'main',
    spaces: [{ id: 'main', layout: {} }], centerStrips: {}, globalTabMru: [],
    splitPanes: [{ ...chip('child'), windowId: 'original', tabs: [chip('left'), chip('child'), { slotId: 'new', projectId: 'p' }, chip('right')] }],
    splitFocusedIndex: 0, activeSpaceTab: chip('child'), clearTerminalBuffer() {},
    centerStripKey: () => 'p', getEffectiveTabId: () => workspace.activeTabId,
    saveSession: () => calls.push('save-layout'), setProjectView() {},
    switchTab: (p, id) => { workspace.activeTabId = id; calls.push('switch:' + id); },
    activateCenterTab: (p, id) => { workspace.activeTabId = id; calls.push('activate:' + id); },
    addTabToSplitPaneStrip: (index, p, id) => { calls.push('fallback'); state.splitPanes = panes.restoreTabAtPanePosition(state.splitPanes, index, chip(id)).panes; },
    createTab: async (_p, name, cwd, options) => {
      opts.push(options);
      if (state.createError) throw Error('fixture-create-failure');
      const id = options.restoreId || 'new-' + workspace.tabCounter++;
      workspace.tabs.set(id, { id, name, cwd, groupId: options.groupId, tabType: options.tabType });
      return id;
    },
  };
  const persist = async (_p, tabs) => {
    saves.push(clone([...tabs])); calls.push('save-tabs');
    return { success: !state.saveError };
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, console: { log() {}, warn() {}, error() {} },
    ...placement, ...panes, ...spaces, dropFromMru, commitArchiveWithStopRetry, isDurableSaveTabsAck, stopAiBeforeTerminalKill,
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
        const row = { id: archive.length + 1, project_id: 'p', tab_id: t.tabId, name: t.name, cwd: t.cwd,
          position: t.position, group_id: t.groupId, restore_placement: t.restorePlacement ? JSON.stringify(t.restorePlacement) : null };
        archive.push(row); return { success: true, historyId: row.id };
      }
      if (channel === 'project:begin-tab-history-restore') {
        const row = args.id ? archive.find(e => e.id === args.id) : archive.at(-1);
        return row ? { ok: true, entry: row, token: 'lease' } : { ok: false, reason: 'not_found' };
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
  return { state, workspace, archive, saves, calls, opts };
}

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
