import{StatusIcon,OldStatusIcon}from'./ActualStatusIcon';
// Actual workspace surfaces with synthetic transcripts and no provider/PTY.
import React,{useState} from 'react';
import{flushSync}from'react-dom';
import { createRoot } from 'react-dom/client';
import TerminalArea from '../../src/renderer/components/Workspace/TerminalArea';
import SpaceStrip from '../../src/renderer/components/Workspace/SpaceStrip';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { installPerfFreezeProbe } from '../../src/renderer/utils/perfFreezeProbe';
import '../../packages/claude-blocks/src/blocks.css';

const projectId = 'workflow-cost-project', cwd = '/synthetic-workflow';
const tabIds = Array.from({ length: (window as any).__fixtureOwnerCount || 6 }, (_, i) => 'workflow-cost-tab-' + i);
const tabs = new Map(tabIds.map(id => [id, {
  id, name: id, cwd, commandType: 'codex', tabType: 'terminal',
  codexSessionId: 'session-' + id, aiBusy: true, isCommandRunning: true,
}]));
const layoutFor = (ids: string[]) => ({
  ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
  activeSpaceTab: { projectId, tabId: ids[0] }, splitFocusedIndex: 0,
  splitPanes: ids.map((tabId, index) => ({ projectId, tabId, column: index,
    windowId: 'window-' + tabId, tabs: [{ projectId, tabId }] })),
  splitSizes: { cols: ids.map(() => 1 / ids.length), rows: ids.map(() => [1]) },
});
const main = layoutFor(tabIds.slice(0, 4));
const other = layoutFor(tabIds.slice(4,6));
const extras=Array.from({length:Math.ceil(Math.max(0,tabIds.length-6)/4)},(_,i)=>({id:"cost-extra-"+i,name:"Other "+i,projectIds:[projectId],layout:layoutFor(tabIds.slice(6+i*4,10+i*4))}));
useWorkspaceStore.setState({
  view: 'workspace', isRestoring: false, ...main, activeSpaceId: 'cost-main',
  openProjects: new Map([[projectId, { projectId, projectPath: cwd, tabs,
    activeTabId: tabIds[0], currentView: 'terminal', tabGroups: [], selectedTabIds: [],
    tabHistory: [], tabCounter: 6, sidebarOpen: false, viewingSubAgentTabId: null }]]),
  spaces: [{ id: 'cost-main', name: 'Main', projectIds: [projectId], layout: main },
    { id: 'cost-other', name: 'Other', projectIds: [projectId], layout: other }, ...extras],
  workspaceDisplay: null, windowDisplayKey: null, windowDisplayLayouts: {},
} as any);
useProjectsStore.setState({ projects: { [projectId]: { id: projectId, path: cwd, name: 'Synthetic' } } });
useUIStore.setState({ activeArea: 'workspace', newTabPrimarySurface: 'history',
  terminalHistoryStreamingEnabled: true, historyFontSize: 14, promptSummaryGlobalAuto: false } as any);
const maps = { processStatus: new Map(tabIds.map(id=>[id,true])), busyTabs: new Map(tabIds.map(id=>[id,true])), pasteBusyTabs: new Map(),
  inheritedBusyTabIds: new Set<string>(), awaitingTabs: new Map() };

// Match the retained document size observed in production without loading a
// user's transcript. The extra panes do not mutate on a measured switch.
const retained = document.createElement('div');
retained.id = 'workflow-retained-fixture';
retained.style.cssText = 'position:absolute;inset:0;opacity:0;pointer-events:none;z-index:-1;overflow:hidden';
let html = '';
for (let i = 0; i < 47; i++) {
  html += '<section><div class="cb-messages">';
  for (let j = 0; j < 160; j++) html += '<article class="cb-row cb-row-assistant cb-message"><p>Saved <b>formatted text</b> <span>word</span></p><pre><code>const synthetic = true;</code></pre><footer>Saved</footer></article>';
  html += '</div></section>';
}
retained.innerHTML = html;
document.body.appendChild(retained);
installPerfFreezeProbe();
const fixture: any = (window as any).workflowFixture;
fixture.projectId = projectId;
fixture.tabs = tabIds;
fixture.getState = () => ({ space: useWorkspaceStore.getState().activeSpaceId,
  focused: useWorkspaceStore.getState().splitPanes[useWorkspaceStore.getState().splitFocusedIndex]?.tabId });
fixture.emitAppend = (tabId: string) => {
  const sid = 'session-' + tabId;
  const entry = { uuid: 'background-new-' + tabId, sessionId: sid, role: 'assistant',
    content: 'Synthetic background completion', timestamp: new Date().toISOString() };
  fixture.rowsFor(sid).push(entry);
  fixture.ipc.emit('agent-transcript:live-message', {}, { tabId, sessionId: sid, toolType: 'codex',
    message: { type: 'assistant', uuid: entry.uuid, sessionId: sid, timestamp: entry.timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: entry.content }] } } });
  fixture.ipc.emit('agent-transcript:changed', {}, { tabId, sessionId: sid, toolType: 'codex', reason: 'fixture-append' });
};
function StatusProbe(){const[arm,setArm]=useState('old');(window as any).setSpinnerArm=(a:string)=>flushSync(()=>setArm(a));const Icon=arm==='old'?OldStatusIcon:StatusIcon;return <Icon presentation={{icon:'loading',spinning:true}}/>}
createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
  <SpaceStrip {...maps} />
  <div id="status-fixture" style={{position:"absolute",top:32,left:10,zIndex:100,pointerEvents:"none"}}><StatusProbe/></div>
  <div style={{ flex: 1, minHeight: 0, position: 'relative' }}><TerminalArea projectId={projectId} sharedActivity={maps} /></div>
</div>);
