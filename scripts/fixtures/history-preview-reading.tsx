// Browser fixture for the real HistoryPanel. Only the transcript transport is
// controlled; row rendering, Virtuoso, preview adoption and scroll owners are
// the shipping implementation. Never imported by the application entrypoint.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
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
  if (env.NOTED_E2E_TEST !== 'true' || !env.NOTED_USER_DATA_DIR || location.protocol !== 'http:') {
    throw new Error('History fixture requires a private unpackaged E2E application');
  }
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
    if (channel === 'agent-transcript:unsubscribe' && String(payload?.consumerId).includes('preview-e2e-')) {
      return { success: true };
    }
    return originalInvoke(channel, payload, ...args);
  };
}

export function mountHistoryPreviewFixture({ provider = 'codex', left = 0 }: { provider?: 'claude' | 'codex'; left?: number } = {}) {
  installTransport();
  // Saved reading anchors survive a DEV restart. Each case needs a new owner,
  // otherwise an earlier test's mid-list position becomes its initial state.
  const id = `preview-e2e-${Date.now().toString(36)}-${++serial}`;
  const tabId = `${id}-tab`;
  const projectId = `${id}-project`;
  const sessionId = `${id}-session`;
  const previewId = `${id}-preview`;
  const canonicalIdentity = `${id}-source`;
  const canonicalUuid = `${id}-canonical`;
  const row = (uuid: string, content: string, index: number) => ({
    uuid, role: 'assistant', content, timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    sessionId, sourceSessionId: sessionId, sourceIdentity: `${id}:${uuid}`,
  });
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => row(`${id}-old-${i}`, `Сохранённый ответ ${i}.\n\n` + 'Строка истории. '.repeat(55), i)),
    row(`${id}-reader`, Array.from({ length: 70 }, (_, i) => `Читаемый абзац ${i}. Этот текст должен оставаться на месте.`).join('\n\n'), 21),
  ];
  const text = Array.from({ length: 55 }, (_, i) => `Новый ответ, абзац ${i}. Постепенно записываем результат.`).join('\n\n');
  const fixture = { tabId, sessionId, entries, revision: 1 };
  fixtures.set(sessionId, fixture);
  const previousStreaming = useUIStore.getState().terminalHistoryStreamingEnabled;
  useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 16 });
  useWorkspaceStore.setState((state) => {
    const projects = new Map(state.openProjects);
    projects.set(projectId, {
      projectId, projectPath: '/tmp', tabs: new Map([[tabId, {
        id: tabId, name: 'Проверка позиции при сохранении ответа', cwd: '/tmp',
        commandType: provider, tabType: 'file', aiBusy: true,
        ...(provider === 'codex' ? { codexSessionId: sessionId } : { claudeSessionId: sessionId }),
      }]]), activeTabId: tabId, tabGroups: [], currentView: 'terminal', selectedTabIds: [],
    } as any);
    return { openProjects: projects };
  });
  const host = document.createElement('div');
  host.dataset.historyPreviewFixture = id;
  Object.assign(host.style, { position: 'fixed', top: '70px', left: `${left}px`,
    width: '620px', height: '1007px', zIndex: '100000', background: '#1a1a1a' });
  document.body.appendChild(host);
  const root = createRoot(host);
  let visible = true;
  const render = () => flushSync(() => root.render(<HistoryPanel
    tabId={tabId} projectId={projectId} sessionId={sessionId} cwd="/tmp"
    width={620} notesPanelWidth={0} isOpen embedded embeddedFill
    toolType={provider} presented={visible} preservePresentationGeometry
  />));
  render();
  const preview = {
    tabId, sessionId, toolType: provider, previewId, phase: 'streaming', text,
    previewSeq: 1, startedAt: Date.now(), updatedAt: Date.now(),
    lifecycleGeneration: id, mirrorGeneration: id, mirrorGenerationOrdinal: 1,
    committedFrameGeneration: 1, writeSeq: 1, textHash: null, sourceMode: 'semantic',
  };
  const envelope = { tabId, sessionId, toolType: provider };
  const api = {
    id, tabId, sessionId, readerUuid: `${id}-reader`, canonicalUuid, canonicalIdentity,
    host,
    preview() {
      ipcRenderer.emit('agent-transcript:terminal-preview', {}, { ...envelope, action: 'update', preview });
    },
    clear() {
      ipcRenderer.emit('agent-transcript:terminal-preview', {}, {
        ...envelope, action: 'clear', previewId, reason: 'canonical-materialized', canonicalIdentity,
      });
    },
    canonical() {
      ipcRenderer.emit('agent-transcript:live-message', {}, {
        ...envelope, timestamp: new Date().toISOString(),
        message: { type: 'assistant', uuid: canonicalUuid, sourceIdentity: canonicalIdentity,
          message: { role: 'assistant', content: [{ type: 'text', text }] } },
      });
    },
    show(next: boolean) {
      visible = next;
      host.style.opacity = next ? '1' : '0';
      host.inert = !next;
      render();
    },
    destroy() {
      flushSync(() => root.unmount());
      host.remove();
      fixtures.delete(sessionId);
      useWorkspaceStore.setState((state) => {
        const projects = new Map(state.openProjects);
        projects.delete(projectId);
        return { openProjects: projects };
      });
      if (!fixtures.size) useUIStore.setState({ terminalHistoryStreamingEnabled: previousStreaming });
    },
  };
  return api;
}
