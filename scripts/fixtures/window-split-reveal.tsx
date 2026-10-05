// Actual Workspace, pane chrome, hidden-window picker and Zustand actions.
// Only initial layouts/file IPC are synthetic. No PTY/provider is started.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from '../../src/renderer/components/Workspace/Workspace';
import SpaceStrip from '../../src/renderer/components/Workspace/SpaceStrip';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { paneSlots, paneGridRects } from '../../src/renderer/utils/splitPanesModel.mjs';
import '../../packages/claude-blocks/src/blocks.css';

const f: any = (window as any).splitRevealFixture;
const projectId = 'split-reveal-project', cwd = '/synthetic-window-split';
const ref = (tabId: string) => ({ projectId, tabId });
const names: Record<string, string> = {
  a1: 'iOS Inbox provider chat', a2: 'диктовка и заметки',
  b1: 'sc-desk копирование instagram', b2: 'scripted deploy sash', b3: 'tab-1',
  c1: 'Other window document', other: 'Other workflow document',
};
const tabs = new Map(Object.entries(names).map(([id, name]) => [id, {
  id, name, cwd, tabType: 'file', filePath: cwd + '/' + id + '.md',
}]));
const big = { key: 'fixture-large', label: 'Large fixture', internal: false, width: 1600, height: 900, scaleFactor: 1 };
const small = { ...big, key: 'fixture-small', label: 'Other monitor', internal: true, width: 1200, height: 800 };
const A = { ...ref('a1'), windowId: 'A', column: 0, tabs: ['a1','a2'].map(ref), history: [ref('a2')] };
const B = { ...ref('b3'), windowId: 'B', column: 1, tabs: ['b1','b2','b3'].map(ref), history: [ref('b2'),ref('b1')],
  displayHidden: true, displayRect: { leftPct: 50, topPct: 0, widthPct: 50, heightPct: 100 } };
const bare = { projectId: '', tabId: '', windowId: 'C', column: 1 };
const profile = (ids: string[]) => ({ positions: ids.map((windowId, column) => ({ windowId, column, row: 0 })),
  sizes: null, focusedWindowId: ids[0] });
const layout = (panes: any[], focus = 0) => ({ ...emptySpaceLayout(), activeProjectId: projectId,
  focusedProjectId: projectId, activeSpaceTab: ref('a1'), splitPanes: panes, splitFocusedIndex: focus,
  splitSizes: null, windowDisplayKey: big.key, windowDisplayLayouts: {
    __initial__: profile(['A']), [big.key]: profile(panes.filter(p => !p.displayHidden).map(p => p.windowId)),
    [small.key]: profile(panes.some(p => p.windowId === 'B') ? ['B','A'] : ['A']),
  } });

function reset(kind = 'hidden') {
  const panes: any[] = [structuredClone(A)];
  if (kind === 'bad') panes.push({ ...bare });
  if (kind === 'filled') panes.push({ ...ref('c1'), windowId: 'C', column: 1, tabs: [ref('c1')], history: [] });
  if (kind === 'chooser') panes.push({ ...bare, tabs: [{ slotId: 'user-choice', projectId, cwd }], selectedSlotId: 'user-choice' });
  if (kind === 'history') panes.push({ ...bare, history: [ref('c1')] });
  if (kind !== 'no-hidden') panes.push(structuredClone(B));
  const main = layout(panes);
  const other = { ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
    activeSpaceTab: ref('other'), splitPanes: [{ ...ref('other'), windowId: 'D', tabs: [ref('other')] }],
    splitFocusedIndex: 0, splitSizes: null, windowDisplayKey: big.key, windowDisplayLayouts: {} };
  useWorkspaceStore.setState({ view: 'workspace', isRestoring: false, ...main,
    openProjects: new Map([[projectId, { projectId, projectPath: cwd, tabs: new Map([...tabs].map(([id,tab]) => [id,{...tab}])),
      activeTabId: 'a1', currentView: 'terminal', tabGroups: [], tabHistory: [], selectedTabIds: [],
      sidebarOpen: false, viewingSubAgentTabId: null, tabCounter: tabs.size }]]),
    activeSpaceId: 'main', spaces: [
      { id: 'main', name: 'Main workflow', projectIds: [projectId], layout: main },
      { id: 'other', name: 'Other workflow', projectIds: [projectId], layout: other },
    ], globalTabMru: [], workspaceDisplay: big,
  } as any);
  useUIStore.setState({ activeArea: 'workspace', tabsFontSize: 16, newTabPrimarySurface: 'history',
    tabGeometry: { paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 4 } } as any);
  f.caseName = kind;
}
useProjectsStore.setState({ projects: { [projectId]: { id: projectId, name: 'Split fixture', path: cwd } } });
reset();
f.state = () => {
  const s = useWorkspaceStore.getState();
  return { caseName: f.caseName, space: s.activeSpaceId, display: s.windowDisplayKey, focus: s.splitFocusedIndex,
    panes: s.splitPanes.map((p, index) => ({ id: p.windowId, hidden: !!p.displayHidden, shown: p.tabId,
      column: p.column, index, selectedSlotId: p.selectedSlotId || null,
      slots: paneSlots(p).map((slot: any) => slot.tabId || slot.slotId), history: p.history || [],
      rect: paneGridRects(s.splitPanes, s.splitSizes)[index] })),
    profiles: s.windowDisplayLayouts, spaces: s.spaces.map(space => ({ id: space.id, layout: space.layout })),
  };
};
f.geometry = () => [...document.querySelectorAll<HTMLElement>('[data-terminal-pane-chrome-host][data-split-pane-index]')]
  .filter(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden')
  .map(el => { const r = el.getBoundingClientRect(); return { paneIndex: Number(el.dataset.splitPaneIndex),
    x: r.x, y: r.y, width: r.width, height: r.height,
    chips: [...el.querySelectorAll('[data-strip-tab-id]')].map(c => c.getAttribute('data-strip-tab-id')),
    text: el.querySelector('[data-split-attach-row]')?.textContent }; });
let trace: any[] | null = null, frame: number | null = null;
f.startTrace = () => {
  trace = [];
  const tick = () => { trace?.push({ at: performance.now(), state: f.state(), geometry: f.geometry() }); frame = requestAnimationFrame(tick); };
  tick();
};
f.stopTrace = () => { if (frame !== null) cancelAnimationFrame(frame); const out = trace; trace = null; return out; };
const maps = { processStatus: new Map(), busyTabs: new Map(), pasteBusyTabs: new Map(),
  inheritedBusyTabIds: new Set<string>(), awaitingTabs: new Map() };
function App() {
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', gap: 12, minHeight: 28, padding: '2px 8px', background: '#29292b' }}>
      {['hidden','bad','filled','no-hidden','chooser','history'].map(name =>
        <button key={name} data-reset={name} onClick={() => reset(name)}>{name}</button>)}
      <button data-monitor="small" onClick={() => useWorkspaceStore.getState().setWorkspaceDisplay(small)}>Other monitor</button>
      <button data-monitor="large" onClick={() => useWorkspaceStore.getState().setWorkspaceDisplay(big)}>Large monitor</button>
      <span>Isolated file tabs · real Workspace/store · synthetic IPC</span>
    </div>
    <SpaceStrip {...maps} />
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}><Workspace {...maps} /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
