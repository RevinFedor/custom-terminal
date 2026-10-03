// Private renderer fixture for the captured native-image History row.
// The runner supplies one Main-projected entry and a private preview adapter;
// no provider, PTY, receipt, JSONL, or production state is involved.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import data from './history-native-images.data.json';

const { ipcRenderer } = window.require('electron');
const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
const tabId = 'history-native-images-tab';
const projectId = 'history-native-images-project';
const sessionId = String((data as any).sessionId);
const cwd = '/private/tmp/noted-native-images-ui-fixture';
const entryUuid = String((data as any).entry?.uuid || '');
let installed = false;

function installFixtureTransport() {
  if (installed) return;
  installed = true;
  ipcRenderer.invoke = async (channel: string, payload: any, ...args: any[]) => {
    if (channel === 'agent-session:get-availability-batch') {
      return {
        success: true,
        results: (payload?.sessions || []).map((item: any) => ({
          ...item, state: 'available', historyState: 'available', checkedAt: Date.now(),
        })),
      };
    }
    if (channel === 'agent-transcript:get-history' || channel === 'claude:get-full-history') {
      return {
        success: true,
        entries: (data as any).entries,
        revision: { version: 'captured-native-image-fixture-v1', sessionId },
        payloadGeneration: 'captured-native-image-fixture-v1',
      };
    }
    if (channel === 'agent-transcript:subscribe') return { success: true, filePath: 'fixture-only' };
    if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    if (channel === 'agent-transcript:unsubscribe') return { success: true };
    return originalInvoke(channel, payload, ...args);
  };
}

function installStores() {
  const tab = {
    id: tabId,
    name: 'Captured native images',
    cwd,
    commandType: 'codex',
    tabType: 'file',
    aiBusy: false,
    codexSessionId: sessionId,
  };
  useWorkspaceStore.setState({
    activeProjectId: projectId,
    openProjects: new Map([[projectId, {
      projectId,
      projectPath: cwd,
      tabs: new Map([[tabId, tab]]),
      activeTabId: tabId,
      currentView: 'terminal',
      selectedTabIds: [],
      tabGroups: [],
    }]]),
  } as any);
  useUIStore.setState({
    terminalHistoryStreamingEnabled: true,
    historyFontSize: 14,
    promptSummaryGlobalAuto: false,
  } as any);
}

export function mountNativeImagesFixture() {
  installFixtureTransport();
  installStores();
  const host = document.createElement('div');
  host.dataset.historyNativeImagesFixture = 'captured-native-images';
  Object.assign(host.style, {
    position: 'fixed', top: '0', left: '0', width: '980px', height: '900px',
    zIndex: '1', background: '#1a1a1a',
  });
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => flushSync(() => root.render(
    <HistoryPanel
      tabId={tabId}
      projectId={projectId}
      sessionId={sessionId}
      cwd={cwd}
      width={980}
      notesPanelWidth={0}
      isOpen
      embedded
      embeddedFill
      mainSurface
      enableClaudePtyControls
      toolType="codex"
      presented
      preservePresentationGeometry
      presentationExternallyManaged
      presentationChannel="history-native-images-fixture"
      onInitialSourceSignal={() => {}}
    />,
  ));
  render();
  const api = {
    host,
    tabId,
    sessionId,
    entryUuid,
    ready: true,
    destroy() {
      flushSync(() => root.unmount());
      host.remove();
      useWorkspaceStore.setState((state: any) => {
        const next = new Map(state.openProjects);
        next.delete(projectId);
        return { openProjects: next };
      });
    },
  };
  (window as any).__historyNativeImagesFixture = api;
  return api;
}

if (typeof window !== 'undefined' && !(window as any).__historyNativeImagesFixture) {
  mountNativeImagesFixture();
}
