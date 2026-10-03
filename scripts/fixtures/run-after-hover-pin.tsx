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
import { useAutoCompactStore } from '../../src/renderer/store/useAutoCompactStore';
import '../../packages/claude-blocks/src/blocks.css';

const projectId = 'synthetic-hover-project', cwd = '/synthetic-run-after-hover';
const icon = (color: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${color}"/><path d="M4 4h8v8H4z" fill="#fff"/></svg>`);
const workflowIcon = icon('#8041f0'), legacyIcon = icon('#f04221'), projectIcon = icon('#27a675');
const tabs = ['owner', 'source', 'alternative'].map(id => ({ id, name: id === 'owner' ? 'Queue owner' : id,
  cwd, commandType: 'codex', tabType: 'terminal', color: 'codex', codexSessionId: 'synthetic-session-' + id,
  aiBusy: id !== 'owner' }));
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
f.font = (size: number) => useUIStore.setState({ projectTabsFontSize: size });
f.icon = () => useProjectsStore.setState({ projects: { ...useProjectsStore.getState().projects,
  'legacy-project': { ...useProjectsStore.getState().projects['legacy-project'], icon: icon('#4477dd') } } });
useAutoCompactStore.setState({ hydrated: true, policy: { ...useAutoCompactStore.getState().policy,
  scopeInitialized: true, workflowIds: ['hover-workflow'] } });
const activity = { processStatus: new Map(), busyTabs: new Map(), pasteBusyTabs: new Map(), inheritedBusyTabIds: new Set(), awaitingTabs: new Map() };
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
  <div style={{ position: 'absolute', top: 20, left: 40 }}><GlobalRunAfterControl /></div>
  <div data-workflow-reference style={{ position: 'absolute', top: 70, left: 40, width: 1000 }}><SpaceStrip {...activity} /></div>
  <BellFixture />
  <div data-local-fixture style={{ position: 'absolute', top: 300, left: 80, width: 1000, height: 450,
    border: '1px solid #414141', background: '#202020' }}>
    <div style={{ padding: 14 }}>Synthetic History surface — hover / click ownership only</div>
    <PromptQueueOverlay tabId="owner" sessionType="codex" agentBusy={false} inputSurface="history" />
  </div>
</>);
