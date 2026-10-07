// Actual Workspace/TerminalArea/xterm renderer. IPC and transcript data are
// synthetic; this fixture never starts a PTY, provider, or persistent tab.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from '../../src/renderer/components/Workspace/Workspace';
import Boundary from '../../src/renderer/components/Workspace/WorkspacePresentationBoundary';
import SpaceStrip from '../../src/renderer/components/Workspace/SpaceStrip';
import { terminalRegistry } from '../../src/renderer/utils/terminalRegistry';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import '../../packages/claude-blocks/src/blocks.css';

const projectId = 'full-view-project';
const cwd = '/synthetic-full-view';
const tabIds = ['full-view-narrow', 'full-view-neighbor', 'full-view-other'];
const tabs = new Map(tabIds.map((id) => [id, {
  id, name: id, cwd, commandType: 'codex', tabType: 'terminal',
  codexSessionId: 'session-' + id, aiBusy: false,
}]));
const layoutFor = (ids: string[], cols: number[]) => ({
  ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
  activeSpaceTab: { projectId, tabId: ids[0] }, splitFocusedIndex: 0,
  splitPanes: ids.map((tabId, index) => ({ projectId, tabId, column: index,
    windowId: 'window-' + tabId, tabs: [{ projectId, tabId }] })),
  splitSizes: { cols, rows: ids.map(() => [1]) },
});
const main = layoutFor(tabIds.slice(0, 2), [0.25, 0.75]);
if ((window as any).fullViewFixture.singleOverlay) {
  main.splitPanes = [];
  (main as any).centerTabStrips = { [projectId]: tabIds.slice(0, 2) };
}
const other = layoutFor(tabIds.slice(2), [1]);
useWorkspaceStore.setState({
  view: 'workspace', isRestoring: false, ...main, activeSpaceId: 'full-main',
  openProjects: new Map([[projectId, { projectId, projectPath: cwd, tabs,
    activeTabId: tabIds[0], currentView: 'terminal', tabGroups: [], selectedTabIds: [],
    tabHistory: [], tabCounter: tabIds.length, sidebarOpen: false, viewingSubAgentTabId: null }]]),
  spaces: [{ id: 'full-main', name: 'Main', projectIds: [projectId], layout: main },
    { id: 'full-other', name: 'Other', projectIds: [projectId], layout: other }],
  workspaceDisplay: null, windowDisplayKey: null, windowDisplayLayouts: {},
} as any);
useProjectsStore.setState({ projects: { [projectId]: { id: projectId, path: cwd, name: 'Synthetic full view' } } });
useUIStore.setState({ activeArea: 'workspace', newTabPrimarySurface: 'history',
  sideTerminalWidth: (window as any).fullViewFixture.sideWidth, historyPinned: false,
  terminalHistoryStreamingEnabled: true, historyFontSize: 14, promptSummaryGlobalAuto: false,
} as any);
const maps = { processStatus: new Map(), busyTabs: new Map(), pasteBusyTabs: new Map(),
  inheritedBusyTabIds: new Set<string>(), awaitingTabs: new Map() };
const fixture: any = (window as any).fullViewFixture;
const held = new Map<string, any>();
const rect = (element: Element | null | undefined) => {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
};
fixture.resizeEvents = [];
fixture.projectId = projectId;
fixture.tabs = tabIds;
fixture.terminal = (id: string) => terminalRegistry.get(id);
fixture.state = () => {
  const state = useWorkspaceStore.getState();
  return { view: state.view, space: state.activeSpaceId,
    focused: state.splitPanes[state.splitFocusedIndex]?.tabId,
    inputSurfaces: useUIStore.getState().promptQueueInputSurfaceTabs };
};
fixture.hold = (id: string) => {
  const terminal = terminalRegistry.get(id);
  const layer = document.querySelector(`[data-terminal-layer-tab-id="${id}"]`);
  const frame = layer?.closest('[data-floating-terminal]');
  held.get(id)?.resizeListener?.dispose();
  held.set(id, { terminal, xterm: terminal?.element, layer,
    textarea: terminal?.textarea, frame, host: frame?.parentElement, buffer: terminal?.buffer.active,
    resizeListener: terminal?.onResize(size => fixture.resizeEvents.push({ id, ...size, at: performance.now() })) });
};
fixture.inspect = (id: string) => {
  const terminal = terminalRegistry.get(id);
  if (!terminal) return null;
  const buffer = terminal.buffer.active;
  const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-viewport');
  const saved = held.get(id);
  const diagnostic = terminalRegistry.getDraftDiagnosticSnapshot(id);
  const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '');
  const numbered = lines.map(line => line.match(/^([ABC]) (\d{4}) /)).filter(Boolean);
  const visible = lines.slice(buffer.viewportY, buffer.viewportY + terminal.rows);
  const layer = document.querySelector(`[data-terminal-layer-tab-id="${id}"]`);
  const frame = layer?.closest('[data-floating-terminal]');
  const body = frame?.querySelector('[data-floating-terminal-titlebar]')?.nextElementSibling;
  const content = frame?.querySelector('[data-terminal-view-content]');
  const dimensions = Object.fromEntries(Object.entries({ frame, body, content, layer,
    xterm: terminal.element, screen: terminal.element?.querySelector('.xterm-screen') }).map(([key, element]) => {
    const r = rect(element);
    return [key, r && { width: r.width, height: r.height }];
  }));
  return { rows: terminal.rows, cols: terminal.cols, length: buffer.length,
    viewportY: buffer.viewportY, baseY: buffer.baseY, first: visible[0], visible,
    viewportScrollTop: viewport?.scrollTop ?? null,
    allLines: lines, atBottom: buffer.viewportY === buffer.baseY,
    numberedRows: numbered.length,
    numberedSequenceIntact: numbered.every((match, index) => Number(match![2]) === index),
    generation: diagnostic.rendererGeneration, generationOrdinal: diagnostic.rendererGenerationOrdinal,
    writeSeq: diagnostic.rendererWriteSeq, instanceId: diagnostic.rendererInstanceId,
    focused: document.activeElement === terminal.textarea,
    dimensions, frameRect: rect(frame),
    resizeIPC: fixture.resizes.filter((entry: any) => entry.tabId === id).length,
    resizeEvents: fixture.resizeEvents.filter((entry: any) => entry.id === id).length,
    inputSurface: useUIStore.getState().promptQueueInputSurfaceTabs[id] ?? 'history',
    identity: saved ? {
      terminal: saved.terminal === terminal,
      xterm: saved.xterm === terminal.element && !!saved.xterm?.isConnected,
      textarea: saved.textarea === terminal.textarea && !!saved.textarea?.isConnected,
      layer: saved.layer === layer && !!saved.layer?.isConnected,
      frame: saved.frame === frame && !!saved.frame?.isConnected,
      host: saved.host === frame?.parentElement && !!saved.host?.isConnected,
      buffer: saved.buffer === buffer,
    } : null };
};
// Observe from BEFORE the trusted click through consecutive animation frames.
// onResize records even a resize-and-restore between sampled paint frames.
// No fit, scroll, reparent, or DOM style mutation is performed by the observer.
let trace: any = null;
let traceFrame: number | null = null;
const sample = () => {
  if (!trace) return;
  trace.samples.push({ at: performance.now(), terminals: trace.ids.map((id: string) => {
    const { allLines, visible, ...snapshot } = fixture.inspect(id);
    return { id, ...snapshot };
  }) });
};
fixture.beginTrace = (ids: string[]) => {
  if (trace) throw Error('An invariant trace is already running');
  trace = { ids, samples: [], statsBefore: fixture.stats() };
  sample();
  const tick = () => { sample(); traceFrame = requestAnimationFrame(tick); };
  traceFrame = requestAnimationFrame(tick);
};
fixture.endTrace = () => {
  if (traceFrame !== null) cancelAnimationFrame(traceFrame);
  sample();
  const complete = { ...trace, statsAfter: fixture.stats() };
  trace = null; traceFrame = null;
  return complete;
};
// Explicit external-draft stimulus: the real composer observes its store and
// measures its own new height. No DOM/CSS or terminal geometry is patched.
fixture.growComposer = (id: string, count: number) => {
  const draft = Array.from({ length: count }, (_, i) => `Unsent draft line ${i + 1}`).join('\n');
  useUIStore.getState().setHistoryPromptDraft(id, draft);
  return draft;
};
// Full view can cover navigation chrome. These exercise the real store action
// used by navigation as an external workflow/Home change, not a fake click.
fixture.navigate = (destination: string) => {
  const state = useWorkspaceStore.getState();
  if (destination === 'home') return state.showDashboard();
  if (destination === 'workspace') return state.showWorkspace(projectId);
  return state.switchWorkspaceSpace(destination);
};

function App() {
  const view = useWorkspaceStore((s) => s.view);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 30, flexShrink: 0, display: 'flex', gap: 12, alignItems: 'center', padding: '0 12px' }}>
      <button id="fixture-home" onClick={() => {
        const state = useWorkspaceStore.getState();
        if (state.view === 'workspace') void state.showDashboard(); else state.showWorkspace(projectId);
      }}>Home / Workspace</button>
      <span>Isolated renderer · synthetic IPC · no provider / PTY</span>
    </div>
    <SpaceStrip {...maps} />
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
      {view === 'dashboard' && <div data-fixture-home>Home fixture</div>}
      <Boundary view={view}><Workspace {...maps} /></Boundary>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
