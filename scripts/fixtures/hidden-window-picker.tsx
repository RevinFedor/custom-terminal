import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HiddenWindowPicker from '../../src/renderer/components/Workspace/HiddenWindowPicker';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import TerminalArea from '../../src/renderer/components/Workspace/TerminalArea';
import { RunAfterTabPicker } from '../../src/renderer/components/Workspace/RunAfterTabPicker';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { paneSlots } from '../../src/renderer/utils/splitPanesModel.mjs';
import { getRestartAfterTriggerIds } from '../../src/renderer/utils/restartAfterCommand.mjs';
import '../../packages/claude-blocks/src/blocks.css';

const f = (window as any).pickerFixture;
const p = 'picker-project', cwd = '/synthetic-picker';
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4065b0"/><path d="M4 4h8v8H4z" fill="#8fd"/></svg>');
const tabs = [
  ['a', 'Текущее окно'], ['b', 'визуал History'], ['c', 'run after / run cmd'],
  ['d', 'streaming real-time'], ['e', 'terminal mcp timeline'],
].map(([id, name]) => ({ id, name, cwd, commandType: 'codex', tabType: 'terminal', color: 'codex',
  codexSessionId: 'session-' + id, sessionStatus: 'working', aiBusy: id === 'c',
  codexLiveSettingsSessionId: 'session-' + id, codexLiveServiceTierSessionId: 'session-' + id,
  codexLiveServiceTier: id === 'c' ? 'fast' : 'flex',
  taskPlan: { version: 1, revision: 0, updatedAt: null, updatedBy: null,
    items: [{ id: 'task-' + id, title: 'Одна задача', subtasks: [] }], archivedItems: [], history: { past: [], future: [] } } }));
const initialPanes = [
  { projectId: p, tabId: 'a', windowId: 'visible', column: 0, tabs: [{ projectId: p, tabId: 'a' }] },
  { projectId: p, tabId: 'c', windowId: 'hidden-many', column: 1, displayHidden: true,
    tabs: ['b','c','d'].map(tabId => ({ projectId: p, tabId })) },
  { projectId: p, tabId: 'e', windowId: 'hidden-single', column: 2, displayHidden: true,
    tabs: [{ projectId: p, tabId: 'e' }] },
];
const layout = { ...emptySpaceLayout(), activeProjectId: p, focusedProjectId: p,
  activeSpaceTab: { projectId: p, tabId: 'a' }, splitPanes: initialPanes, splitFocusedIndex: 0,
  splitSizes: { cols: [1], rows: [[1]] } };
function reset() {
  useWorkspaceStore.setState({ view: 'workspace', isRestoring: false, ...layout,
    openProjects: new Map([[p, { projectId: p, projectPath: cwd, tabs: new Map(tabs.map(t => [t.id, { ...t }])),
      activeTabId: 'a', currentView: 'terminal', tabGroups: [], tabHistory: [], selectedTabIds: [], sidebarOpen: false }]]),
    activeSpaceId: 'picker-space', spaces: [{ id: 'picker-space', name: 'Picker workflow', projectIds: [p], layout }],
    globalTabMru: [], windowDisplayKey: 'fixture-display', workspaceDisplay: null, windowDisplayLayouts: {},
  } as any);
  useUIStore.setState({ activeArea: 'workspace', tabsFontSize: 14,
    processBar: { ...useUIStore.getState().processBar, position: 'right' },
    tabGeometry: { paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 4 },
    sessionStatuses: [{ id: 'working', label: 'В работе', color: '#e5a743' }],
    statusMarker: { ...useUIStore.getState().statusMarker, shape: 'square', sizePx: 5 },
  } as any);
  f.selected = null;
}
useProjectsStore.setState({ projects: { [p]: { id: p, name: 'Synthetic project', path: cwd, icon } } });
reset();
f.reset = reset;
f.state = () => {
  const s = useWorkspaceStore.getState();
  return { panes: s.splitPanes.map(pane => ({ id: pane.windowId, shown: pane.tabId, slot: pane.selectedSlotId,
    hidden: !!pane.displayHidden, tabs: paneSlots(pane).map((x:any)=>x.tabId || x.slotId) })),
    mru: s.globalTabMru.map(x=>x.tabId), focus: s.splitFocusedIndex, selected: f.selected };
};
f.sidebarSelection = () => useWorkspaceStore.setState(s => {
  const openProjects = new Map(s.openProjects), workspace = openProjects.get(p)!;
  openProjects.set(p, { ...workspace, selectedTabIds: ['b','c'] });
  return { openProjects };
});
f.shellCard = () => useWorkspaceStore.setState(s => {
  const openProjects = new Map(s.openProjects), workspace = openProjects.get(p)!;
  const nextTabs = new Map(workspace.tabs);
  nextTabs.set('b', { ...nextTabs.get('b')!, commandType: 'generic', codexSessionId: undefined,
    sessionStatus: undefined, aiBusy: false });
  openProjects.set(p, { ...workspace, tabs: nextTabs });
  return { openProjects };
});
f.restartSelection = () => {
  const state = useWorkspaceStore.getState(), tab = state.openProjects.get(p)!.tabs.get('b')!;
  return { ids: getRestartAfterTriggerIds(tab, state), workflows: tab.restartAfterWorkflowIds || [],
    explicit: tab.restartAfterTabIds || [], paused: !!tab.restartAfterPaused };
};
f.restartFuture = (id: string, projectId = p) => useWorkspaceStore.setState(s => {
  const openProjects = new Map(s.openProjects), workspace = openProjects.get(projectId)!;
  const nextTabs = new Map(workspace.tabs); nextTabs.set(id, { ...tabs[0], id, name: 'New AI tab', aiBusy: false });
  openProjects.set(projectId, { ...workspace, tabs: nextTabs }); return { openProjects };
});
f.restartOtherScope = (enabled: boolean) => useWorkspaceStore.setState(s => {
  const projectId = 'restart-other-project', workflowId = 'restart-other-workflow';
  const openProjects = new Map(s.openProjects);
  const spaces = s.spaces.filter(space => space.id !== workflowId);
  if (enabled) {
    openProjects.set(projectId, { ...s.openProjects.get(p)!, projectId, activeTabId: 'other-ai',
      tabs: new Map([['other-ai', { ...tabs[0], id: 'other-ai', name: 'Other AI', aiBusy: false }]]) } as any);
    spaces.push({ id: workflowId, name: 'Other workflow', projectIds: [projectId], layout: emptySpaceLayout() });
  } else openProjects.delete(projectId);
  return { openProjects, spaces };
});
f.restartRemoveFuture = () => useWorkspaceStore.setState(s => {
  const openProjects = new Map(s.openProjects), workspace = openProjects.get(p)!;
  const nextTabs = new Map(workspace.tabs); nextTabs.delete('all-future');
  openProjects.set(p, { ...workspace, tabs: nextTabs }); return { openProjects };
});
f.rename = () => useWorkspaceStore.getState().renameTab(p, 'c', 'Переименованная вкладка');
f.chooser = () => useWorkspaceStore.getState().openWindowTabChooser(1);
f.icon = (visible: boolean) => useProjectsStore.setState({ projects: { [p]: { id:p, name:'Synthetic project', path:cwd, icon:visible?icon:null } } });
f.busy = (busy:boolean) => f.ipc.emit('codex:busy-state', {}, {tabId:'c',busy});
f.geometry = (fontSize:number,gap:number) => useUIStore.setState({tabsFontSize:fontSize,tabGeometry:{...useUIStore.getState().tabGeometry,gap}});
f.cardLabelCase = ({fontSize=14,paddingX=6,position='right',notification='off'}={}) => {
  useUIStore.setState(s=>({tabsFontSize:fontSize,tabGeometry:{...s.tabGeometry,paddingX},
    processBar:{...s.processBar,position}}) as any);
  useWorkspaceStore.setState(s=>{
    const openProjects=new Map(s.openProjects),workspace=openProjects.get(p)!;
    const nextTabs=new Map(workspace.tabs);
    for(const [id,name] of [['a','Текущее окно'],['b','система docs'],['c','бронирование отеля'],['d','система docs->uav']]) {
      nextTabs.set(id,{...nextTabs.get(id)!,name,completionNotificationArmed:notification==='armed'||notification==='persistent',
        completionNotificationPersistent:notification.startsWith('persistent'),completionNotificationFired:notification.endsWith('fired'),
        sessionStatus:id==='d'?undefined:nextTabs.get(id)!.sessionStatus});
    }
    openProjects.set(p,{...workspace,tabs:nextTabs});return{openProjects};
  });
};

function Fixture() {
  const panel = useRef<HTMLDivElement>(null);
  const [dependency, setDependency] = useState<string | null>('c');
  const [menuSnapshot, setMenuSnapshot] = useState(true);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  f.coldMenus = () => setMenuSnapshot(false);
  f.sidebar = setSidebarVisible;
  return <div style={{padding:30}}>
    <div data-split-attach-row style={{height:42,display:'flex',gap:12,alignItems:'center'}}>
      <span data-card-reference><PaneTabChip projectId={p} tabId="c" shown={false} paneFocused={false}
        paneIndex={1} inSplit inStrip index={1} /></span>
      <HiddenWindowPicker paneIndex={0} spaceId="picker-space" />
    </div>
    <div data-card-sidebar style={{position:'absolute',left:540,top:340,width:430,height:200}}>
      <TabBar projectId={p} layout="vertical" menuOnlyForProject={!sidebarVisible}
        sharedProcessStatus={menuSnapshot ? new Map(tabs.map(tab => [tab.id, true])) : undefined}
        sharedBusyTabs={new Map()} sharedPasteBusyTabs={new Map()} />
    </div>
    <div ref={panel} data-run-after-host style={{position:'absolute',left:540,top:200,width:270}}>
      <RunAfterTabPicker tabId="a" ownerProjectId={p} autoRun={false} runAfterTabId={dependency}
        panelRef={panel} showAllTabsOnOpen menuWidth={350}
        setRunAfterTab={(_source,target)=>{f.selected=target;setDependency(target);}} />
    </div>
    <div data-actual-workspace style={{position:'absolute',left:30,top:190,width:470,height:320}}>
      <TerminalArea projectId={p} />
    </div>
    <button data-reset onClick={reset} style={{position:'absolute',top:550}}>Reset</button>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
