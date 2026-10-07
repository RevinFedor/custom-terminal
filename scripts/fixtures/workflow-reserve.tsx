import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowTabSidebar, { type WorkflowReserveState } from '../../src/renderer/components/Workspace/WorkflowTabSidebar';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { workflowReserveOutline, selectWorkflowReserve } from '../../src/renderer/utils/workflowReserve.mjs';
import { bindPaneTabPointerDrag } from '../../src/renderer/utils/paneTabPointerGesture';

const f = (window as any).reserveFixture, p = 'reserve-legacy', cwd = '/synthetic-reserve';
const order = ['r3', 'r1', 'r5', 'r0', 'r4', 'r2'];
const tab = (id: string, extra = {}) => ({ id, name: 'Task ' + id, cwd, tabType: 'terminal', commandType: 'generic',
  color: 'default', draft: 'Draft ' + id, groupId: id.startsWith('r') ? 'same-id' : undefined, ...extra });
const tabs = [...order.map(id => tab(id)), ...Array.from({ length: 6 }, (_, i) => tab('placed' + i)),
  tab('archived', { archived: true }), tab('no-member'), tab('child', { parentTabId: 'r1' }),
  tab('owner-file', { tabType: 'file', filePath: '/work.json', visualParentTabId: 'r1' }),
  tab('child-file', { tabType: 'file', filePath: '/child.md', visualParentTabId: 'child' })];
const membership = Object.fromEntries(tabs.filter(x => x.id !== 'no-member').map(x => [x.id,
  { workflowId: ['child', 'child-file', 'owner-file'].includes(x.id) ? 'inbox' : 'work', revision: 1 }]));
function initial(): WorkflowReserveState {
  return { openProjects: useWorkspaceStore.getState().openProjects as any,
    tabWorkflowMembership: structuredClone(membership), activeSpaceId: 'work',
    spaces: [{ id: 'work', name: 'Main', kind: 'user', layout: { splitPanes: [{ tabId: 'r0' }] } },
      { id: 'dormant', name: 'Dormant', kind: 'user', layout: { splitPanes: [{ tabId: 'placed2' }] } },
      { id: 'inbox', name: 'Inbox', kind: 'inbox', layout: {} }],
    splitPanes: [{ projectId: p, tabId: 'placed0', windowId: 'live', tabs: [{ projectId: p, tabId: 'placed0' }, { projectId: p, tabId: 'placed5' }] },
      { projectId: p, tabId: 'placed1', displayHidden: true, windowId: 'hidden' }],
    centerStrips: {}, activeSpaceTab: { projectId: p, tabId: 'placed4' },
    windowDisplayLayouts: { external: { splitPanes: [{ tabId: 'placed3' }] } } };
}
useWorkspaceStore.setState({ view: 'workspace', isRestoring: false, activeSpaceId: 'work', splitPanes: [],
  centerStrips: {}, spaces: [], openProjects: new Map([[p, { projectId: p, projectPath: cwd,
    tabs: new Map(tabs.map(x => [x.id, x])), activeTabId: 'placed0', currentView: 'terminal',
    tabGroups: [{ id: 'same-id', name: 'Responsibility', createdAt: 1 }], selectedTabIds: [], tabHistory: [] }],
    ['other-legacy', { projectId: 'other-legacy', projectPath: '/other', tabs: new Map([['other', tab('other', { groupId: 'same-id' })]]),
      tabGroups: [{ id: 'same-id', name: 'Other namespace', createdAt: 1 }], tabHistory: [] }]]) } as any);
useUIStore.setState({ tabsFontSize: 14, tabSidebarWidth: 300,
  tabGeometry: { paddingX: 6, paddingY: 5, paddingLeft: 16, borderRadius: 6, gap: 4 } } as any);

function Fixture() {
  const buckets = useWorkspaceStore(s => s.openProjects);
  const [state, setState] = useState(initial), [selected, setSelected] = useState<string[]>([]);
  const [ordered, setOrdered] = useState(order), [draft, setDraft] = useState('Unsent retained draft');
  const [scrollTop, setScroll] = useState(0);
  const current = { ...state, openProjects: buckets };
  f.state = () => current;
  f.case = (name: string) => {
    setSelected([]); setOrdered(order); setState(old => {
      const next = initial();
      if (name === 'one' || name === 'zero' || name === 'partial') {
        const ids = name === 'one' ? order.slice(0, 5) : name === 'zero' ? order : order.slice(0, 4);
        next.splitPanes!.push({ projectId: p, tabId: ids[0], tabs: ids.map(tabId => ({ projectId: p, tabId })) });
      }
      if (name === 'namespaces') next.tabWorkflowMembership.other = { workflowId: 'work', revision: 1 };
      if (name === 'hierarchy' || name === 'context') {
        const bucket = buckets.get(p)!;
        bucket.tabs.get(name === 'context' ? 'r2' : 'r5')!.visualParentTabId = 'r3';
        if (name === 'context') next.splitPanes!.push({ projectId: p, tabId: 'r3' });
      }
      if (name === 'many') {
        const bucket = buckets.get(p)!;
        for (let i = 0; i < 35; i++) {
          const id = 'extra' + i;
          bucket.tabs.set(id, tab(id)); next.tabWorkflowMembership[id] = { workflowId: 'work', revision: 1 };
        }
      }
      return next;
    });
  };
  const detach = (request: any) => {
    f.actions.push({ type: 'detach', ...request });
    setState(old => {
      const next = structuredClone({ ...old, openProjects: undefined });
      const ids = new Set(request.entries.map((x: any) => x.tabId));
      const clear = (layout: any) => {
        for (const pane of layout.splitPanes || []) {
          pane.tabs = (pane.tabs || []).filter((x: any) => !ids.has(x.tabId));
          if (ids.has(pane.tabId)) pane.tabId = pane.tabs[0]?.tabId || '';
        }
        if (ids.has(layout.activeSpaceTab?.tabId)) layout.activeSpaceTab = null;
        for (const profile of Object.values(layout.windowDisplayLayouts || {})) clear(profile);
      };
      clear(next); for (const space of next.spaces) clear(space.layout);
      return { ...next, openProjects: old.openProjects };
    }); return true;
  };
  f.dropPaneSource = (element: HTMLElement) => bindPaneTabPointerDrag(element, () => ({
    owner: 'pane', rootTabId: 'placed0', entries: [{ projectId: p, tabId: 'placed0' }], sourcePaneKey: 'pane:0', sourceSpaceId: 'work',
  }));
  f.outline = () => workflowReserveOutline(selectWorkflowReserve(current, 'work', ordered));
  f.actions ||= [];
  return <><div style={{ display: 'flex', height: '100vh' }}>
    <WorkflowTabSidebar state={current} orderedTabIds={ordered} selectedTabIds={selected} onSelectionChange={setSelected}
      sourceTabId="r1" fallbackCwd="/fallback" scrollTop={scrollTop} onScrollOffsetChange={(_, top) => setScroll(top)}
      sharedActivity={{ processStatus: new Map(), busyTabs: new Map() }}
      onOpenTab={(projectId, tabId) => { f.actions.push({ type: 'open', projectId, tabId });
        setState(old => ({ ...old, splitPanes: [...old.splitPanes!, { projectId, tabId }] })); return true; }}
      onOpenFile={(ownerProjectId, file) => { f.actions.push({ type: 'file', ownerProjectId, file }); }}
      onCreateTab={async request => { f.actions.push({ type: 'create', request });
        if (f.delayCreate) await new Promise(resolve => { f.releaseCreate = resolve; });
        if (f.failCreate) throw Error('Private rejected create'); }}
      onCreateGroup={workflowId => f.actions.push({ type: 'group-create', workflowId })}
      onGroupContextMenu={(projectId, groupId) => f.actions.push({ type: 'group-menu', projectId, groupId })}
      onDetachTabs={detach} onPlaceTabs={(entries, target) => { f.actions.push({ type: 'place', entries, target });
        setState(old => ({ ...old, splitPanes: [...old.splitPanes!, { projectId: entries[0].projectId,
          tabId: entries[0].tabId, tabs: entries }] })); return true; }}
      onCommitOutline={({ payload }) => {
        f.actions.push({ type: 'outline', sourceId: payload.sourceId });
        const ids: string[] = []; const walk = (nodes: any[]) => nodes.forEach(node => { if (node.tabId) ids.push(node.tabId); walk(node.children || []); });
        walk(payload.previewOutline); setOrdered(ids); return true;
      }} />
    <main style={{ padding: 24, flex: 1, minWidth: 0 }}>
      <h2>Workflow reserve — private fixture</h2>
      <textarea data-retained-draft value={draft} onChange={event => setDraft(event.target.value)} />
      <div data-private-pane-header data-pane-tab-drop-zone="strip" data-pane-key="pane:0" data-space-id="work"
        data-pane-tab-strip-scroller style={{ marginTop: 12, minHeight: 34, border: '1px solid #555' }}>Existing window header</div>
      <div data-pane-tab-drop-zone="body" data-pane-key="pane:0" data-space-id="work"
        style={{ marginTop: 30, height: 180, border: '1px solid #777', padding: 12 }}>Existing window drop target</div>
      <span ref={element => { if (element && !element.dataset.bound) { element.dataset.bound = '1'; f.dropPaneSource(element); } }}
        data-private-pane-source style={{ display: 'block', marginTop: 30, padding: 12, border: '1px solid #876', userSelect: 'none' }}>Placed pane chip</span>
    </main>
    </div><TabBar projectId={p} menuOnlyForProject sharedProcessStatus={new Map()} />
    <TabBar projectId="other-legacy" menuOnlyForProject sharedProcessStatus={new Map()} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
