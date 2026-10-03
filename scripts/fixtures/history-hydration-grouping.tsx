// Private actual History/Timeline. The runner supplies synthetic main row-window results.
import React from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import data from './history-hydration-grouping.data.json';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');
const tabId = 'hydration-grouping-tab', projectId = 'hydration-grouping-project';
const sessionId = 'hydration-grouping-session', cwd = '/synthetic';
let current = data.before;
const state = { reads: 0, ready: false, scrolls: [] as any[], promoted: false };
window.addEventListener('history-panel:scrolled-to', ((e: CustomEvent) => state.scrolls.push(e.detail)) as EventListener);
const original = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, payload: any) => {
  if (channel === 'agent-transcript:get-history') {
    state.reads++;
    return structuredClone({ success: true, entries: current, payloadGeneration: 'file:epoch',
      revision: { sources: [{ sessionId, fileIdentity: 'file', size: state.promoted ? 2 : 1, linkKind: 'end' }] } });
  }
  if (channel === 'agent-transcript:get-timeline') return { success: true,
    entries: data.after.filter(e => e.role === 'user').map(e => ({ ...e, type: 'user' })) };
  if (channel === 'agent-session:get-availability-batch') return { success: true,
    results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe') return { success: true };
  return original(channel, payload);
};
useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 14, promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ openProjects: new Map([[projectId, { projectId, projectPath: cwd,
  tabs: new Map([[tabId, { id: tabId, name: 'Private grouping proof', cwd, commandType: 'codex',
    tabType: 'file', aiBusy: false, codexSessionId: sessionId }]]), activeTabId: tabId, currentView: 'terminal',
  tabGroups: [], selectedTabIds: [], }]]), activeProjectId: projectId } as any);
(window as any).fixture = { state, promote: () => {
  current = data.after; state.promoted = true;
  ipcRenderer.emit('agent-transcript:changed', {}, { tabId, toolType: 'codex', sessionId,
    fileIdentity: 'file', reason: 'fixture-hydration-shift' });
} };
createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', position: 'relative', height: '100vh' }}>
  <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
    <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={980} notesPanelWidth={0}
      isOpen embedded embeddedFill mainSurface toolType="codex" presented preservePresentationGeometry
      onInitialSourceSignal={d => { if (d.phase === 'load' && d.status === 'success') state.ready = true; }} />
  </div>
  <Timeline tabId={tabId} sessionId={sessionId} cwd={cwd} toolType="codex" isActive={false} isTurnBusy={false}
    isVisible isOpen historySurfaceVisible readOnly backgroundPrewarmAdmitted />
</div>);
