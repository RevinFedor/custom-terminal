// Private actual-component fixture for the Codex Timeline note lifecycle.
// The provider/session is synthetic; Timeline, note identity resolution and
// the renderer's trusted UI path are real application components.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');

const tabId = 'note-live-tab';
const sessionId = 'S';
const projectId = 'note-live-project';
const cwd = '/synthetic-note-live';
const now = Date.now();
const stamp = (offset: number) => new Date(now + offset).toISOString();

const liveSource = 'codex-user-source-S-42';
const liveUuid = 'codex-live-S-42-user';
const canonicalUuid = 'codex-user-S-42';
const physicalUuid = 'physical-normal-S';
const failedLiveSource = 'codex-user-source-S-43';
const failedLiveUuid = 'codex-live-S-43-user';

const canonicalEntry = {
  uuid: canonicalUuid,
  role: 'user',
  type: 'user',
  sessionId,
  timestamp: stamp(42),
  sourceIdentity: liveSource,
  content: 'LIVE CODEX QUESTION',
};
const physicalEntry = {
  uuid: physicalUuid,
  role: 'user',
  type: 'user',
  sessionId,
  timestamp: stamp(900),
  sourceIdentity: 'codex-user-source-S-900',
  content: 'NORMAL PHYSICAL QUESTION',
};

const state: any = {
  ready: false,
  durableVisible: false,
  liveEmitted: [],
  lifecycle: [],
};

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);

useUIStore.setState({
  terminalHistoryStreamingEnabled: true,
  historyFontSize: 14,
  timelineTreeModeTabs: { [tabId]: true },
  timelineWidth: 360,
  promptSummaryGlobalAuto: false,
} as any);
useWorkspaceStore.setState({
  openProjects: new Map([[projectId, {
    projectId,
    projectPath: cwd,
    tabs: new Map([[tabId, {
      id: tabId,
      name: 'Private note timeline',
      cwd,
      commandType: 'codex',
      tabType: 'terminal',
      aiBusy: true,
      codexSessionId: sessionId,
    }]]),
    activeTabId: tabId,
    currentView: 'terminal',
    tabGroups: [],
    selectedTabIds: [],
  }]]),
  activeProjectId: projectId,
} as any);

function liveMessage(uuid: string, sourceIdentity: string, text: string, offset: number) {
  return {
    tabId,
    toolType: 'codex',
    sessionId,
    timestamp: stamp(offset),
    message: {
      type: 'user',
      uuid,
      sessionId,
      sourceIdentity,
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  };
}

function emitLive(message: any) {
  state.liveEmitted.push({ uuid: message.message.uuid, sourceIdentity: message.message.sourceIdentity });
  ipcRenderer.emit('agent-transcript:live-message', {}, message);
}

const originalSetState = useWorkspaceStore.setState;
const rootNode = document.getElementById('root')!;
const root = createRoot(rootNode);
let mountNonce = 0;

function setBusy(busy: boolean) {
  originalSetState((current: any) => {
    const projects = new Map(current.openProjects);
    const workspace = projects.get(projectId);
    const tabs = new Map(workspace.tabs);
    tabs.set(tabId, { ...tabs.get(tabId), aiBusy: busy });
    projects.set(projectId, { ...workspace, tabs });
    return { openProjects: projects };
  });
}

function Fixture() {
  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', justifyContent: 'flex-end', background: '#1a1a1a' }}>
      <Timeline
        tabId={tabId}
        sessionId={sessionId}
        cwd={cwd}
        toolType="codex"
        isActive
        isTurnBusy={useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.aiBusy === true)}
        isVisible
        isOpen
        readOnly={false}
        historySurfaceVisible={false}
        backgroundPrewarmAdmitted
        onInitialSourceSignal={signal => {
          if (signal.phase === 'load' && signal.status === 'success') state.ready = true;
        }}
      />
    </div>
  );
}

function mount() {
  root.render(<Fixture key={`mount-${mountNonce}`} />);
}

(window as any).fixture = {
  state,
  ids: { tabId, sessionId, liveUuid, liveSource, canonicalUuid, physicalUuid, failedLiveUuid, failedLiveSource },
  emitLive: (which: 'good' | 'failed') => emitLive(which === 'good'
    ? liveMessage(liveUuid, liveSource, 'LIVE CODEX QUESTION', 42)
    : liveMessage(failedLiveUuid, failedLiveSource, 'UNRESOLVED LIVE QUESTION', 43)),
  promote: async () => {
    const result = await originalInvoke('fixture:promote');
    setBusy(false);
    state.durableVisible = true;
    ipcRenderer.emit('agent-transcript:changed', {}, {
      tabId, toolType: 'codex', sessionId, reason: 'fixture-canonical-adoption',
    });
    return result;
  },
  remount: () => {
    mountNonce += 1;
    mount();
  },
  dbSnapshot: () => originalInvoke('fixture:rows'),
};

// Renderer-side invoke is kept only for narrow fixture inspection; all
// product IPC calls go through the real Electron invoke bridge.
ipcRenderer.invoke = async (channel: string, payload?: any) => originalInvoke(channel, payload);
mount();
