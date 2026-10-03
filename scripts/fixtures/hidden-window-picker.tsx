import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HiddenWindowPicker from '../../src/renderer/components/Workspace/HiddenWindowPicker';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import TerminalArea from '../../src/renderer/components/Workspace/TerminalArea';
import { RunAfterTabPicker } from '../../src/renderer/components/Workspace/RunAfterTabPicker';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { paneSlots } from '../../src/renderer/utils/splitPanesModel.mjs';
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
f.rename = () => useWorkspaceStore.getState().renameTab(p, 'c', 'Переименованная вкладка');
f.chooser = () => useWorkspaceStore.getState().openWindowTabChooser(1);
f.icon = (visible: boolean) => useProjectsStore.setState({ projects: { [p]: { id:p, name:'Synthetic project', path:cwd, icon:visible?icon:null } } });
f.busy = (busy:boolean) => f.ipc.emit('codex:busy-state', {}, {tabId:'c',busy});
f.geometry = (fontSize:number,gap:number) => useUIStore.setState({tabsFontSize:fontSize,tabGeometry:{...useUIStore.getState().tabGeometry,gap}});

function Fixture() {
  const panel = useRef<HTMLDivElement>(null);
  const [dependency, setDependency] = useState<string | null>('c');
  return <div style={{padding:30}}>
    <div style={{height:42,display:'flex',gap:12,alignItems:'center'}}>
      <span data-card-reference><PaneTabChip projectId={p} tabId="c" shown={false} paneFocused={false}
        paneIndex={1} inSplit inStrip index={1} /></span>
      <HiddenWindowPicker paneIndex={0} spaceId="picker-space" />
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
