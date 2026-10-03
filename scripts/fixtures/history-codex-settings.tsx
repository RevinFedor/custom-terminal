// Private renderer fixture for the Codex settings History projection.
// It owns only synthetic transcript records; no provider process is started.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel, { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';

const { ipcRenderer } = window.require('electron');
const { env } = window.require('process');
const fixtures = new Map<string, any>();
const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
let serial = 0;
let installed = false;

function installTransport() {
  if (installed) return;
  // This module is bundled directly into the private runner's disposable
  // Electron window. `file:` is expected here (the full Vite app is not used).
  installed = true;
  ipcRenderer.invoke = async (channel: string, payload: any, ...args: any[]) => {
    if (channel === 'agent-session:get-availability-batch'
      && payload?.sessions?.every((entry: any) => fixtures.has(entry.sessionId))) {
      return { success: true, results: payload.sessions.map((entry: any) => ({
        ...entry, state: 'available', historyState: 'available', checkedAt: Date.now(),
      })) };
    }
    const fixture = fixtures.get(payload?.sessionId)
      || [...fixtures.values()].find((entry) => entry.tabId === payload?.tabId);
    if (fixture) {
      if (channel === 'agent-transcript:get-history' || channel === 'claude:get-full-history') {
        return { success: true, entries: fixture.entries, revision: { version: fixture.revision } };
      }
      if (channel === 'agent-transcript:subscribe') return { success: true, filePath: 'fixture-only' };
      if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    }
    if (channel === 'agent-transcript:unsubscribe' && String(payload?.consumerId).includes('codex-settings-e2e-')) {
      return { success: true };
    }
    return originalInvoke(channel, payload, ...args);
  };
}

const textRow = (uuid: string, sessionId: string, text: string, index: number) => ({
  uuid, role: 'assistant', content: text,
  timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  sessionId, sourceSessionId: sessionId, recordByteOffset: index,
});

const settingRow = (uuid: string, sessionId: string, kind: 'model' | 'effort', value: string,
  sourceIdentity: string, index: number, live = false) => ({
  uuid, role: 'slash', content: `/${kind} ${value}`,
  timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  sessionId, sourceIdentity, recordByteOffset: index,
  settingsFact: { version: 1, provider: 'codex', kind, value,
    source: 'thread_settings_applied', ...(live ? { live: true } : {}) },
});

function setTabBusy(tabId: string, busy: boolean) {
  useWorkspaceStore.setState((state: any) => {
    const projects = new Map(state.openProjects);
    for (const project of projects.values()) {
      if (!project.tabs?.has(tabId)) continue;
      const tabs = new Map(project.tabs);
      tabs.set(tabId, { ...tabs.get(tabId), aiBusy: busy });
      projects.set(project.projectId, { ...project, tabs });
    }
    return { openProjects: projects };
  });
}

export function mountCodexSettingsFixture() {
  installTransport();
  const id = `codex-settings-e2e-${Date.now().toString(36)}-${++serial}`;
  const projectId = `${id}-project`;
  const ownerA = { key: 'a', tabId: `${id}-tab-a`, sessionId: `${id}-session-a`, channel: `${id}:a` };
  const ownerB = { key: 'b', tabId: `${id}-tab-b`, sessionId: `${id}-session-b`, channel: `${id}:b` };
  const sourceModel = `${id}:physical:model:42`;
  const sourceEffort = `${id}:physical:effort:42`;
  const baseA = [
    textRow(`${id}-intro`, ownerA.sessionId, 'Codex settings fixture baseline.\n\n' + 'Readable baseline text. '.repeat(35), 1),
    settingRow(`${id}-base-model`, ownerA.sessionId, 'model', 'A', `${id}:base:model`, 2),
    settingRow(`${id}-base-effort`, ownerA.sessionId, 'effort', 'max', `${id}:base:effort`, 3),
    textRow(`${id}-reader`, ownerA.sessionId,
      Array.from({ length: 70 }, (_, index) => `Reading anchor ${index}. The text stays in place while settings arrive.`).join('\n\n'), 4),
  ];
  const baseB = [textRow(`${id}-other`, ownerB.sessionId, 'A different Codex session; it must not affect session A.', 1)];
  const fixtureA = { ...ownerA, entries: baseA, revision: 1 };
  const fixtureB = { ...ownerB, entries: baseB, revision: 1 };
  fixtures.set(ownerA.sessionId, fixtureA);
  fixtures.set(ownerB.sessionId, fixtureB);

  const projects = new Map(useWorkspaceStore.getState().openProjects);
  projects.set(projectId, {
    projectId, projectPath: '/private/tmp/noted-codex-settings-fixture',
    tabs: new Map([
      [ownerA.tabId, { id: ownerA.tabId, name: 'Codex settings A', cwd: '/private/tmp/noted-codex-settings-fixture',
        commandType: 'codex', tabType: 'file', aiBusy: false, codexSessionId: ownerA.sessionId }],
      [ownerB.tabId, { id: ownerB.tabId, name: 'Codex settings B', cwd: '/private/tmp/noted-codex-settings-fixture',
        commandType: 'codex', tabType: 'file', aiBusy: false, codexSessionId: ownerB.sessionId }],
    ]),
    activeTabId: ownerA.tabId, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  });
  useWorkspaceStore.setState({ activeProjectId: projectId, openProjects: projects });
  useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 16 });

  const host = document.createElement('div');
  host.dataset.codexSettingsFixture = id;
  Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '720px', height: '900px',
    zIndex: '100000', background: '#1a1a1a' });
  document.body.appendChild(host);
  const root = createRoot(host);
  let setOwner: ((key: 'a' | 'b') => void) | null = null;
  let currentKey: 'a' | 'b' = 'a';
  const present = (visible: boolean) => window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT, {
    detail: { channel: currentKey === 'a' ? ownerA.channel : ownerB.channel,
      presented: visible, geometryStable: true, focused: visible },
  }));
  function Surface() {
    const [ownerKey, updateOwner] = useState<'a' | 'b'>('a');
    setOwner = updateOwner;
    currentKey = ownerKey;
    const owner = ownerKey === 'a' ? ownerA : ownerB;
    const fixture = ownerKey === 'a' ? fixtureA : fixtureB;
    return <HistoryPanel tabId={owner.tabId} projectId={projectId} sessionId={owner.sessionId}
      cwd="/private/tmp/noted-codex-settings-fixture" width={720} notesPanelWidth={0}
      isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex"
      presented preservePresentationGeometry presentationExternallyManaged presentationChannel={owner.channel}
      onInitialSourceSignal={(data: any) => {
        if (ownerKey === 'a' && data.phase === 'load' && data.status === 'success') fixtureA.ready = true;
      }} />;
  }
  flushSync(() => root.render(<Surface />));
  present(true);

  const api: any = {
    id, host, ownerA, ownerB, sourceModel, sourceEffort, readerUuid: `${id}-reader`, ready: false,
    current: () => currentKey,
    fixture: (key: 'a' | 'b' = currentKey) => key === 'a' ? fixtureA : fixtureB,
    setBusy(busy: boolean, key: 'a' | 'b' = currentKey) {
      const owner = key === 'a' ? ownerA : ownerB;
      setTabBusy(owner.tabId, busy);
    },
    replaceDurable(rows: any[], key: 'a' | 'b' = currentKey) {
      const fixture = key === 'a' ? fixtureA : fixtureB;
      fixture.entries = rows.map((row) => ({ ...row, sessionId: row.sessionId || fixture.sessionId }));
      fixture.revision += 1;
      api.setBusy(false, key);
      ipcRenderer.emit('agent-transcript:changed', {}, {
        tabId: fixture.tabId, sessionId: fixture.sessionId, toolType: 'codex', reason: 'fixture-full-refresh',
      });
    },
    emitSetting(kind: 'model' | 'effort', value: string, sourceIdentity: string, uuid: string,
      key: 'a' | 'b' = currentKey, offset = 500) {
      const owner = key === 'a' ? ownerA : ownerB;
      ipcRenderer.emit('agent-transcript:live-message', {}, {
        type: 'history_entry', toolType: 'codex', tabId: owner.tabId, sessionId: owner.sessionId,
        recordByteOffset: offset, entry: settingRow(uuid, owner.sessionId, kind, value, sourceIdentity, offset, true),
      });
    },
    emitForeignSetting(kind: 'model' | 'effort', value: string, sourceIdentity: string, uuid: string) {
      api.emitSetting(kind, value, sourceIdentity, uuid, 'b', 900);
    },
    switchTo(key: 'a' | 'b') {
      if (!setOwner) throw new Error('owner switch control is not ready');
      flushSync(() => setOwner!(key));
      const owner = key === 'a' ? ownerA : ownerB;
      useWorkspaceStore.setState((state: any) => {
        const next = new Map(state.openProjects);
        const project = next.get(projectId);
        if (project) next.set(projectId, { ...project, activeTabId: owner.tabId });
        return { activeProjectId: projectId, openProjects: next };
      });
      currentKey = key;
      present(true);
    },
    show(visible: boolean) {
      host.style.opacity = visible ? '1' : '0';
      host.inert = !visible;
      present(visible);
    },
    destroy() {
      flushSync(() => root.unmount());
      host.remove();
      fixtures.delete(ownerA.sessionId); fixtures.delete(ownerB.sessionId);
      useWorkspaceStore.setState((state: any) => {
        const next = new Map(state.openProjects); next.delete(projectId); return { openProjects: next };
      });
    },
  };
  (window as any).__codexSettingsFixture = api;
  return api;
}

// The private runner bundles this module as the renderer entrypoint rather
// than serving a Vite module URL. Mount automatically so the page has the
// same exported fixture API without any dynamic file:// import.
if (typeof window !== 'undefined' && !(window as any).__codexSettingsFixture) {
  mountCodexSettingsFixture();
}
