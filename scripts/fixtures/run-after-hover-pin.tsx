import React from 'react';
import { createRoot } from 'react-dom/client';
import { PromptQueueOverlay } from '../../src/renderer/components/Workspace/PromptQueueOverlay';
import { GlobalRunAfterControl } from '../../src/renderer/components/Workspace/GlobalRunAfterControl';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { usePromptQueueStore } from '../../src/renderer/store/usePromptQueueStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import SpaceStrip from '../../src/renderer/components/Workspace/SpaceStrip';
import TabNotificationControls from '../../src/renderer/components/Workspace/TabNotificationControls';
import SidebarToolsRow from '../../src/renderer/components/Workspace/SidebarToolsRow';
import { useAutoCompactStore } from '../../src/renderer/store/useAutoCompactStore';
import { normalizeAutoCompactPolicy } from '../../src/renderer/utils/autoCompactPolicy.mjs';
import { pendingQueuedRewindTarget, cancelQueuedRewindTarget } from '../../src/renderer/utils/queuedRewindTarget.mjs';
import '../../packages/claude-blocks/src/blocks.css';

const projectId = 'synthetic-hover-project', cwd = '/synthetic-run-after-hover';
const icon = (color: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${color}"/><path d="M4 4h8v8H4z" fill="#fff"/></svg>`);
const workflowIcon = icon('#8041f0'), legacyIcon = icon('#f04221'), projectIcon = icon('#27a675');
const tabs = ['owner', 'source', 'alternative'].map(id => ({ id, name: id === 'owner' ? 'Queue owner' : id,
  cwd, commandType: 'codex', tabType: 'terminal', color: 'codex', codexSessionId: 'synthetic-session-' + id,
  aiBusy: id !== 'owner', taskPlan: { items: [{ id: 'fixture-task', title: 'Task marker must stay outside Run After', statusId: 'todo' }] } }));
const layout = { ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
  activeSpaceTab: { projectId, tabId: 'owner' }, splitPanes: [{ projectId, tabId: 'owner', windowId: 'synthetic-window',
    column: 0, tabs: [{ projectId, tabId: 'owner' }] }], splitFocusedIndex: 0 };
useProjectsStore.setState({ projects: { [projectId]: { id: projectId, path: cwd, name: 'Hover fixture', icon: projectIcon },
  'legacy-project': { id: 'legacy-project', path: cwd, name: 'Legacy project', icon: legacyIcon },
  'cleared-project': { id: 'cleared-project', path: cwd, name: 'Cleared project', icon: projectIcon } } } as any);
useWorkspaceStore.setState({ ...layout, isRestoring: false, view: 'workspace',
  openProjects: new Map([[projectId, { projectId, projectPath: cwd, tabs: new Map(tabs.map(t => [t.id, t])),
    activeTabId: 'owner', currentView: 'terminal', tabGroups: [], selectedTabIds: [], tabHistory: [] }]]),
  activeSpaceId: 'hover-workflow', spaces: [{ id: 'hover-workflow', name: 'Hover workflow', icon: workflowIcon, projectIds: [projectId], layout },
    { id: 'legacy-workflow', name: 'Legacy workflow', projectIds: ['legacy-project'], layout: emptySpaceLayout() },
    { id: 'cleared-workflow', name: 'Cleared workflow', icon: null, projectIds: ['cleared-project'], layout: emptySpaceLayout() }],
} as any);
useUIStore.setState({ activeArea: 'workspace', promptQueueWidth: 360, promptQueueChipFontSize: 14, promptQueueEditorFontSize: 14,
  interfaceHintsEnabled: false } as any);
const queue = usePromptQueueStore.getState().getQueue('owner');
usePromptQueueStore.setState({ queues: new Map([['owner', { ...queue, panelCollapsed: true, autoRun: true,
  items: [{ id: 'synthetic-card', title: 'Check changes', titleManual: true, text: 'Check changes', images: 0, chips: [],
    imagePaths: [], trigger: { kind: 'onTab', tabId: 'source' }, condition: { kind: 'context-used', operator: 'gte', percent: 50 } }],
}]]) } as any);

const f = (window as any).hoverFixture;
f.state = () => usePromptQueueStore.getState().getQueue('owner');
f.scope = () => ({ policy: useAutoCompactStore.getState().policy, activeSpaceId: useWorkspaceStore.getState().activeSpaceId });
f.compactPolicy = (patch: object) => useAutoCompactStore.setState({ policy:
  normalizeAutoCompactPolicy({ ...useAutoCompactStore.getState().policy, ...patch }) });
f.navigation = [];
f.minor = () => {
  const current = usePromptQueueStore.getState();
  usePromptQueueStore.setState({ queues: new Map(['owner', 'source'].map(id => [id, {
    ...current.getQueue(id), autoRun: true, loopPromptEnabled: false, postPromptEnabled: false, runAfterTabId: null,
    items: [{ id: id + '-minor', title: id + ' action', text: id + ' action', images: 0, chips: [], imagePaths: [] }],
  }])) } as any);
  (document.querySelector('[data-global-fixture]') as HTMLElement).style.left = '400px';
};
f.rewindElsewhere = () => {
  const local = { ...layout, activeSpaceTab: { projectId, tabId: 'source' }, splitPanes: [{ ...layout.splitPanes[0],
    tabId: 'source', tabs: [{ projectId, tabId: 'source' }] }] };
  const remote = { ...layout, splitPanes: [{ ...layout.splitPanes[0], windowId: 'rewind-other-window' }] };
  useWorkspaceStore.setState({ ...local, activeSpaceId: 'hover-workflow', spaces: [
    { id: 'hover-workflow', name: 'Current workflow', icon: workflowIcon, projectIds: [projectId], layout: local },
    { id: 'rewind-workflow', name: 'Rewind workflow', projectIds: [], layout: remote },
  ] } as any);
};
f.placement = () => {
  const ws = useWorkspaceStore.getState();
  return { activeSpaceId: ws.activeSpaceId, panes: ws.splitPanes,
    spaces: ws.spaces.map(s => ({ id: s.id, panes: s.layout.splitPanes })), pending: pendingQueuedRewindTarget('owner') };
};
f.cancelRewind = () => { const r = pendingQueuedRewindTarget('owner'); if (r) cancelQueuedRewindTarget('owner', r.requestId); };
f.notification = (enabled: boolean) => {
  useUIStore.setState(s => ({ processBar: { ...s.processBar, position: 'right' } }));
  useWorkspaceStore.setState(s => {
    const openProjects = new Map(s.openProjects), workspace = openProjects.get(projectId)!;
    const nextTabs = new Map(workspace.tabs), tab = nextTabs.get('owner')!;
    nextTabs.set('owner', { ...tab, completionNotificationPersistent: enabled, completionNotificationArmed: enabled });
    openProjects.set(projectId, { ...workspace, tabs: nextTabs }); return { openProjects };
  });
};
f.stepDesign = () => {
  const state = usePromptQueueStore.getState();
  const base = { text: '', images: 0, chips: [], imagePaths: [] };
  usePromptQueueStore.setState({ queues: new Map([['owner', { ...state.getQueue('owner'), autoRun: true,
    runAfterTabId: null, items: [
      { ...base, id: 'design-compact', text: '/compact', title: '/compact', condition: { kind: 'context-used', operator: 'gte', percent: 50 } },
      { ...base, id: 'design-model', title: 'Model → GPT-6.1-Sol · medium', metaAction: { kind: 'model-effort', toolType: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, trigger: { kind: 'onTab', tabId: 'source' } },
      { ...base, id: 'design-followup', title: 'Проверить результат', text: 'Проверить результат' },
    ] }]]) } as any);
};
f.reorderDesign = () => {
  const state=usePromptQueueStore.getState(), queue=state.getQueue('owner');
  usePromptQueueStore.setState({ queues: new Map([['owner', { ...queue, items: [queue.items[1], queue.items[0], queue.items[2]] }]]) } as any);
};
f.addDisabled = () => {
  const state = usePromptQueueStore.getState();
  usePromptQueueStore.setState({ queues: new Map([...state.queues, ['source', { ...state.getQueue('source'), autoRun: false,
    items: [{ id: 'late-disabled', text: '/compact', title: '/compact', images: 0, chips: [], imagePaths: [] }] }]]) } as any);
};
const placeTab = useWorkspaceStore.getState().placeTab;
useWorkspaceStore.setState({ placeTab: (...args: Parameters<typeof placeTab>) => {
  f.navigation.push(args); return placeTab(...args);
} });
f.font = (size: number) => useUIStore.setState({ projectTabsFontSize: size });
f.icon = () => useProjectsStore.setState({ projects: { ...useProjectsStore.getState().projects,
  'legacy-project': { ...useProjectsStore.getState().projects['legacy-project'], icon: icon('#4477dd') } } });
f.graph = () => {
  const current = useWorkspaceStore.getState().openProjects.get(projectId)!;
  const extraIds = ['branch', 'deep-1', 'deep-2', 'deep-3', 'single', 'disabled'];
  const graphTabs = new Map(current.tabs);
  for (const id of extraIds) graphTabs.set(id, { ...tabs[0], id, name: 'Queue ' + id, codexSessionId: 'fixture-' + id } as any);
  useWorkspaceStore.setState({ openProjects: new Map([[projectId, { ...current, tabs: graphTabs }]]) });
  const step = (id: string, target?: string) => ({ id, text: target ? 'Check ' + target : '/compact',
    title: target ? 'Review ' + target : '/compact', titleManual: true, images: 0, chips: [], imagePaths: [],
    ...(target ? { trigger: { kind: 'onTab', tabId: target } } : { condition: { kind: 'context-used', operator: 'gte', percent: 50 } }) });
  const specs: Array<[string, any[]]> = [
    ['owner', [step('owner-first', 'source'), step('owner-second', 'source'), step('owner-third', 'alternative')]],
    ['source', [step('source-first', 'deep-1')]], ['branch', [step('branch-first', 'source')]],
    ['deep-1', [step('deep-1-first', 'deep-2')]], ['deep-2', [step('deep-2-first', 'deep-3')]],
    ['deep-3', [step('deep-3-first')]], ['single', [step('single-first')]], ['disabled', [step('disabled-first')]],
  ];
  const base = usePromptQueueStore.getState().getQueue('owner');
  usePromptQueueStore.setState({ queues: new Map(specs.map(([id, items]) => [id, { ...base, items, autoRun: id !== 'disabled',
    postPromptEnabled: false, loopPromptEnabled: false, runAfterTabId: null }])) } as any);
};
f.legacy = () => {
  const base = usePromptQueueStore.getState().getQueue('owner');
  usePromptQueueStore.setState({ queues: new Map([['owner', { ...base, items: [], runAfterTabId: 'source',
    autoRun: true, loopPromptEnabled: true, loopPromptText: 'Legacy Loop' }]]) } as any);
};
useAutoCompactStore.setState({ hydrated: true, policy: { ...useAutoCompactStore.getState().policy,
  enabled: true, scopeInitialized: true, workflowIds: ['hover-workflow'] } });
const activity = { processStatus: new Map(), busyTabs: new Map(), pasteBusyTabs: new Map(), inheritedBusyTabIds: new Set(), awaitingTabs: new Map() };
function GlobalFixture() {
  const [toolbar, setToolbar] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [width, setWidth] = React.useState(400);
  const [presentation, setPresentation] = React.useState<'workspace' | 'dashboard'>('workspace');
  f.header = (nextWidth: number, nextPresentation: 'workspace' | 'dashboard' = 'workspace') => {
    setWidth(nextWidth); setPresentation(nextPresentation);
  };
  f.routingExample = () => {
    localStorage.setItem('noted-terminal-global-run-after-size', JSON.stringify({ width: 780, height: 740, resizeEnabled: false }));
    const current = useWorkspaceStore.getState().openProjects.get(projectId)!;
    const names = { owner: 'uav: ai-дэшборд', source: 'субтитры в браузере', alternative: 'проблемы с телеграм' };
    useWorkspaceStore.setState({ openProjects: new Map([[projectId, { ...current,
      tabs: new Map(tabs.map(tab => [tab.id, { ...tab, name: names[tab.id] }])) }]]) } as any);
    const base = usePromptQueueStore.getState().getQueue('owner');
    const step = (id: string, title: string) => ({ id, title, titleManual: true, text: title, images: 0, chips: [], imagePaths: [],
      trigger: { kind: 'onTab', tabId: 'source' } });
    usePromptQueueStore.setState({ queues: new Map([
      ['owner', { ...base, autoRun: true, runAfterTabId: null, postPromptEnabled: false, loopPromptEnabled: false,
        items: [step('roles', 'завершение системы ролей и тестов')] }],
      ['alternative', { ...base, autoRun: true, runAfterTabId: null, postPromptEnabled: false, loopPromptEnabled: false,
        items: [step('browser', 'возобновление работы с браузером mcp')] }],
    ]) } as any);
    setToolbar(false); setRevision(value => value + 1);
  };
  f.layoutAndRewind = () => {
    localStorage.setItem('noted-terminal-global-run-after-size', JSON.stringify({ width: 1100, height: 740, heightFixed: true }));
    const base = usePromptQueueStore.getState().getQueue('owner');
    const action = (id: string, iteration?: number) => ({ id, text: '', images: 0, chips: [], imagePaths: [],
      title: 'Rewind: <saved_prompt name="Loop: huge unwanted title">' + 'x'.repeat(200), titleManual: true,
      metaAction: { kind: 'rewind', targetUuid: 'legacy-21', targetText: 'Original <saved_prompt> payload',
        targetIteration: iteration, sourceSessionId: 'legacy-label-session', toolType: 'codex' } });
    usePromptQueueStore.setState({ queues: new Map([['owner', { ...base, autoRun: true, panelCollapsed: true,
      runAfterTabId: null, loopPromptEnabled: false, postPromptEnabled: false,
      items: [action('rewind-known', 17), action('rewind-legacy')] }]]) } as any);
    (document.querySelector('[data-global-fixture]') as HTMLElement).style.left = '40px';
    setToolbar(true);
  };
  return toolbar ? <div data-global-toolbar-fixture style={{ width }}>
    <SidebarToolsRow projectId={projectId} presentation={presentation} trailingControls={<GlobalRunAfterControl key={revision} />} />
  </div> : <GlobalRunAfterControl key={revision} />;
}
function BellFixture() {
  const [open, setOpen] = React.useState(false);
  const [armed, setArmed] = React.useState(false), [persistent, setPersistent] = React.useState(false);
  return <div data-bell-fixture style={{ position: 'absolute', left: 1100, top: 650, zIndex: 16000 }}>
    <button data-open-bell-menu onContextMenu={e => { e.preventDefault(); setOpen(true); }}>ПКМ</button>
    {open && <div style={{ position: 'fixed', left: 710, top: 690, width: 380, background: '#292929', border: '1px solid #444', borderRadius: 6 }}>
      <TabNotificationControls armed={armed} fired={false} persistent={persistent} onOnce={setArmed} onPersistent={setPersistent} onAction={() => setOpen(false)} />
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<>
  <div data-global-fixture style={{ position: 'absolute', top: 20, left: 40 }}><GlobalFixture /></div>
  <div data-workflow-reference style={{ position: 'absolute', top: 70, left: 40, width: 1000 }}><SpaceStrip {...activity} /></div>
  <BellFixture />
  <div data-local-fixture style={{ position: 'absolute', top: 300, left: 80, width: 1000, height: 450,
    border: '1px solid #414141', background: '#202020' }}>
    <div style={{ padding: 14 }}>Synthetic History surface — hover / click ownership only</div>
    <PromptQueueOverlay tabId="owner" sessionType="codex" agentBusy={false} inputSurface="history" />
  </div>
</>);
