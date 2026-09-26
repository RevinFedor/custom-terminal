// Private E2E surface: actual HistoryPanel/Timeline and their stores. Transcript
// reads, disk cache, worker, source watcher and IPC are real; no provider runs.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel, { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../src/renderer/components/Workspace/HistoryPanel';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { historySnapshotCache } from '../../src/renderer/utils/historySnapshotCache';
import { readHistoryThroughIpc } from '../../src/renderer/utils/historyReadTransport.mjs';

const { ipcRenderer } = window.require('electron');
const config = await ipcRenderer.invoke('fixture:config');
useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 14, promptSummaryGlobalAuto: false } as any);
const tabs = new Map(config.sessions.map((sessionId: string, index: number) => ['fixture-' + index, {
  id: 'fixture-' + index, name: 'History ' + index, cwd: config.cwd, commandType: 'codex',
  tabType: 'file', aiBusy: false, codexSessionId: sessionId,
}]));
useWorkspaceStore.setState({ openProjects: new Map([['fixture-project', {
  projectId: 'fixture-project', projectPath: config.cwd, tabs, activeTabId: 'fixture-0',
  tabGroups: [], currentView: 'terminal', selectedTabIds: [],
}]]) } as any);

function Fixture() {
  const [selected, setSelected] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [notice, setNotice] = useState('');
  const tabId = 'fixture-' + selected;
  const channel = 'disk-cache-e2e:' + tabId;
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT, {
      detail: { channel, presented: true, geometryStable: true, focused: true },
    }));
  }, [channel, mounted]);
  return <>
    <nav style={{ height: 42, display: 'flex', gap: 12, padding: 4, color: '#ccc' }}>
      {[0, 1, 3].map(index => <button key={index} data-fixture-tab={index} onClick={() => setSelected(index)}>History {index}</button>)}
      <button data-release onClick={async () => {
        setMounted(false);
        await ipcRenderer.invoke('fixture:release');
        historySnapshotCache.clear();
        setNotice('memory released');
        setMounted(true);
      }}>Release RAM</button>
      <button data-append onClick={() => ipcRenderer.invoke('fixture:append', selected)}>Append record</button>
      <button data-cold onClick={async () => {
        await ipcRenderer.invoke('fixture:cold');
        try {
          const read = readHistoryThroughIpc(ipcRenderer.invoke.bind(ipcRenderer), 'agent-transcript:get-history', {
            toolType: 'codex', sessionId: config.sessions[2], cwd: config.cwd, tabId: 'cold',
            dehydrate: true, hydrate: { radius: 20, alwaysHydrateTail: 2 },
          });
          (window as any).fixture.coldFinished = read.then(() => true);
          await read;
        } finally { await ipcRenderer.invoke('fixture:cold-finished'); }
      }}>Cold preparation</button>
      <span data-notice>{notice}</span>
    </nav>
    <div style={{ position: 'relative', height: 'calc(100vh - 42px)', paddingRight: 34 }}>
      {mounted && <HistoryPanel key={tabId} tabId={tabId} projectId="fixture-project"
        sessionId={config.sessions[selected]} cwd={config.cwd} width={980} notesPanelWidth={0}
        isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented preservePresentationGeometry
        presentationExternallyManaged presentationChannel={channel} />}
      {mounted && <Timeline key={'timeline-' + tabId} tabId={tabId} sessionId={config.sessions[selected]} cwd={config.cwd}
        toolType="codex" isActive={false} isVisible isOpen historySurfaceVisible readOnly backgroundPrewarmAdmitted />}
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
(window as any).fixture = { config, ready: true, setBusy(index: number, busy: boolean) {
  useWorkspaceStore.setState(state => {
    const projects = new Map(state.openProjects);
    const project = projects.get('fixture-project')!;
    const tabs = new Map(project.tabs);
    const id = 'fixture-' + index;
    tabs.set(id, { ...tabs.get(id)!, aiBusy: busy });
    projects.set('fixture-project', { ...project, tabs });
    return { openProjects: projects };
  });
} };
