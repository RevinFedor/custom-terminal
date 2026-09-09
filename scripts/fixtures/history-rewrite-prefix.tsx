// Private browser fixture for the real HistoryPanel. It exercises only the
// renderer owner handoff: the transcript transport and the binding CAS ACK are
// controlled here, while rows, Virtuoso and presentation ownership are real.
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
let installed = false;
let serial = 0;

const RETAINED_PREFIX = 18;
// Keep the long readable prefix row in the initial real viewport. The test
// still performs a trusted slow wheel over it; placing it at a cold virtual
// index would make the setup depend on Virtuoso's offscreen mount window.
const READER_LINE = 0;
const READER_MARKER = 'ПРЕФИКС-ЧИТАЕМЫЙ-РЯД';

function revision(sessionId: string, cwd: string, token: string, readerUuid: string) {
  return {
    token,
    sessionId,
    cwd,
    context: JSON.stringify({
      rowWindowRequest: { centerUuid: readerUuid, radius: 20, alwaysHydrateTail: 4 },
    }),
  };
}

function retainedContent(line: number) {
  if (line === READER_LINE) {
    return Array.from({ length: 120 }, (_, index) =>
      `${READER_MARKER}: абзац ${index}. Этот длинный неизменный текст должен остаться читаемым при смене владельца истории.`,
    ).join('\n\n');
  }
  return `Префикс истории ${line}. ` + 'Одинаковая строка префикса. '.repeat(38);
}

function makeEntries(
  fixtureId: string,
  sessionId: string,
  branch: string,
  targetOffsetBase: number,
  metadataVariant = false,
) {
  const entries = Array.from({ length: RETAINED_PREFIX }, (_, line) => ({
    uuid: `codex-assistant-${sessionId}-${line}`,
    role: 'assistant',
    content: retainedContent(line),
    timestamp: new Date(1_700_000_000_000 + line * 1000).toISOString(),
    sessionId,
    sourceIdentity: `codex-assistant-source-${sessionId}-${targetOffsetBase + line * 1000}`,
    ...(metadataVariant && line === READER_LINE ? {
      responseTiming: { intervalId: 42, startTs: 1_700_001_000_000, endTs: 1_700_001_123_000, durationMs: 123_000 },
    } : {}),
  }));
  const suffix = branch === 'source'
    ? Array.from({ length: 4 }, (_, index) => ({
        uuid: `codex-assistant-${sessionId}-old-suffix-${index}`,
        role: 'assistant',
        content: `Удаляемый хвост исходной ветки ${index}.`,
        timestamp: new Date(1_700_000_100_000 + index * 1000).toISOString(),
        sessionId,
        sourceIdentity: `codex-assistant-source-${sessionId}-old-suffix-${index}`,
      }))
    : [{
        uuid: `codex-assistant-${sessionId}-${branch}-suffix`,
        role: 'assistant',
        content: `Новый хвост ветки ${branch}; он не входит в доказанный префикс.`,
        timestamp: new Date(1_700_000_200_000).toISOString(),
        sessionId,
        sourceIdentity: `codex-assistant-source-${sessionId}-${branch}-suffix`,
      }];
  return [...entries, ...suffix].map((entry) => ({ ...entry, fixtureId }));
}

function makeReceipt(sourceSessionId: string, sessionId: string, sourceOffsetBase: number, targetOffsetBase: number) {
  return {
    schema: 'codex-rewrite-prefix-v1',
    sourceSessionId,
    sessionId,
    records: Array.from({ length: RETAINED_PREFIX }, (_, line) => ({
      source: { __line: line, __byteOffset: sourceOffsetBase + line * 1000 },
      target: { __line: line, __byteOffset: targetOffsetBase + line * 1000 },
    })),
  };
}

function fixtureFor(payload: any) {
  return fixtures.get(payload?.sessionId)
    || [...fixtures.values()].find((fixture) => fixture.tabId === payload?.tabId);
}

function installTransport() {
  if (installed) return;
  if (env.NOTED_E2E_TEST !== 'true' || !env.NOTED_USER_DATA_DIR || location.protocol !== 'http:') {
    throw new Error('History rewrite fixture requires a private unpackaged E2E application');
  }
  installed = true;
  ipcRenderer.invoke = async (channel: string, payload: any, ...args: any[]) => {
    const fixture = fixtureFor(payload);
    if (channel === 'agent-session:get-availability-batch'
      && payload?.sessions?.every((entry: any) => fixtures.has(entry.sessionId))) {
      return {
        success: true,
        results: payload.sessions.map((entry: any) => ({
          ...entry, state: 'available', historyState: 'available', checkedAt: Date.now(),
        })),
      };
    }
    if (fixture && channel === 'agent-transcript:get-history') {
      const target = fixture.sessions[payload.sessionId];
      if (!target) return { success: false, entries: [], error: 'fixture_session_missing' };
      const activeTarget = target.inPlaceEntries && fixture.inPlaceTriggered
        ? {
            entries: target.inPlaceEntries,
            revision: target.inPlaceRevision,
            payloadGeneration: target.inPlacePayloadGeneration,
          }
        : target;
      const rewriteSourceSessionId = payload.rewriteFrom?.sessionId;
      const isRewritePrepare = !!rewriteSourceSessionId
        && rewriteSourceSessionId === target.rewriteSourceSessionId;
      const useRewriteDelta = isRewritePrepare && (fixture.mode === 'delta' || fixture.mode === 'deltaVisible');
      fixture.historyRequests.push({
        at: Date.now(),
        sessionId: payload.sessionId,
        hasRewriteFrom: !!payload.rewriteFrom,
        rewriteFrom: payload.rewriteFrom || null,
        hydrate: payload.hydrate || null,
        responseShape: useRewriteDelta ? 'rewriteDelta' : 'full-entries',
        payloadGeneration: activeTarget.payloadGeneration || '',
      });
      const response: any = {
        success: true,
        revision: activeTarget.revision,
        payloadGeneration: activeTarget.payloadGeneration || '',
      };
      if (useRewriteDelta) {
        const carriedEntries = activeTarget.entries.slice(0, RETAINED_PREFIX).map((entry: any, index: number) => ({
          sourceUuid: `codex-assistant-${rewriteSourceSessionId}-${index}`,
          uuid: entry.uuid,
        }));
        const changedEntries = activeTarget.entries.slice(RETAINED_PREFIX);
        response.rewriteDelta = true;
        response.rewriteReceipt = target.rewriteReceipt;
        response.order = activeTarget.entries.map((entry: any) => entry.uuid);
        response.carriedEntries = carriedEntries;
        response.changedEntries = changedEntries;
        fixture.deltaRequests.push({
          sessionId: payload.sessionId,
          hasEntries: false,
          carriedEntries: carriedEntries.length,
          changedEntries: changedEntries.length,
          order: response.order.length,
        });
      } else {
        response.entries = activeTarget.entries;
      }
      if (isRewritePrepare) {
        response.rewriteReceipt = target.rewriteReceipt;
        response.hydrationRequest = payload.hydrate || null;
      }
      return response;
    }
    if (fixture && channel === 'tab:set-codex-session-id') {
      const current = useWorkspaceStore.getState().getCodexSessionId(fixture.tabId);
      fixture.bindingAcks.push({ ...payload, observedCurrentSessionId: current, fixtureAck: 'binding-cas' });
      if (!['deleteRange', 'editRange'].includes(payload?.reason)) {
        return { success: false, error: 'fixture_requires_history_reason' };
      }
      if ((payload.expectedSessionId || null) !== (current || null)) {
        return { success: false, error: 'fixture_cas_conflict', currentSessionId: current };
      }
      return { success: true, updated: true, fixtureAck: 'binding-cas' };
    }
    if (fixture && channel === 'agent-transcript:subscribe') return { success: true, filePath: 'fixture-only' };
    if (fixture && channel === 'agent-transcript:refresh') return { success: true };
    if (fixture && channel === 'agent-transcript:get-terminal-preview') {
      return { success: true, preview: null };
    }
    if (channel === 'agent-transcript:unsubscribe' && String(payload?.consumerId || '').includes('rewrite-prefix-e2e-')) {
      return { success: true };
    }
    if (channel === 'project:save-tabs' || channel === 'project:layout-changed'
      || channel === 'project:order-changed') return { success: true };
    return originalInvoke(channel, payload, ...args);
  };
}

function HistoryOwner({ fixture, channel }: { fixture: any; channel: string }) {
  const sessionId = useWorkspaceStore((state) => (
    state.openProjects.get(fixture.projectId)?.tabs.get(fixture.tabId)?.codexSessionId || ''
  ));
  return <HistoryPanel
    tabId={fixture.tabId}
    projectId={fixture.projectId}
    sessionId={sessionId}
    cwd={fixture.cwd}
    width={620}
    notesPanelWidth={0}
    isOpen
    embedded
    embeddedFill
    toolType="codex"
    presented={fixture.presented}
    preservePresentationGeometry
    presentationExternallyManaged
    presentationChannel={channel}
  />;
}

function RewriteControls({ fixture }: { fixture: any }) {
  const sessionId = useWorkspaceStore((state) => (
    state.openProjects.get(fixture.projectId)?.tabs.get(fixture.tabId)?.codexSessionId || ''
  ));
  const [pending, setPending] = useState(false);
  const inPlace = fixture.mode === 'inPlace';
  const target = sessionId === fixture.sourceSessionId
    ? fixture.childSessionId
    : sessionId === fixture.childSessionId ? fixture.grandchildSessionId : null;
  const label = inPlace
    ? 'Rewrite same file'
    : target
    ? `Delete suffix → ${target === fixture.childSessionId ? 'child' : 'grandchild'}`
    : 'Rewrite complete';
  return <button
    type="button"
    data-rewrite-prefix-action
    disabled={pending || (!target && !inPlace)}
    style={{ display: 'block', width: 210, marginBottom: 8, padding: '8px 10px' }}
    onClick={async () => {
      if ((!target && !inPlace) || pending) return;
      setPending(true);
      try {
        if (inPlace) {
          fixture.triggerInPlace();
          fixture.buttonActions.push({ from: sessionId, to: sessionId, ok: true, inPlace: true });
          return;
        }
        const ok = await useWorkspaceStore.getState().setCodexSessionId(
          fixture.tabId, target, sessionId === fixture.sourceSessionId ? 'deleteRange' : 'editRange',
        );
        fixture.buttonActions.push({ from: sessionId, to: target, ok });
      } finally {
        setPending(false);
      }
    }}
  >{pending ? 'Rewriting…' : label}</button>;
}

export function mountHistoryRewritePrefixFixture({ mode = 'full' }: { mode?: 'full' | 'delta' | 'deltaVisible' | 'visible' | 'metadata' | 'inPlace' } = {}) {
  installTransport();
  const id = `rewrite-prefix-e2e-${Date.now().toString(36)}-${++serial}`;
  const tabId = `${id}-tab`;
  const projectId = `${id}-project`;
  const cwd = `/private/tmp/${id}-cwd`;
  const sourceSessionId = `${id}-source`;
  const childSessionId = `${id}-child`;
  const grandchildSessionId = `${id}-grandchild`;
  const channel = `${id}:presentation`;
  const sourceEntries = makeEntries(id, sourceSessionId, 'source', 0);
  const inPlaceEntries = sourceEntries.map((entry: any, index: number) => index === READER_LINE
    ? { ...entry, content: `INPLACE-NEW ${READER_MARKER}: физический файл тот же владелец, но payload generation уже новый.` }
    : entry);
  const childEntries = makeEntries(id, childSessionId, 'child', 100_000);
  const grandchildEntries = makeEntries(id, grandchildSessionId, 'grandchild', 200_000, mode === 'metadata');
  const fixture: any = {
    id, tabId, projectId, cwd, channel,
    sourceSessionId, childSessionId, grandchildSessionId,
    mode,
    readerLine: READER_LINE,
    readerMarker: READER_MARKER,
    presented: true,
    bindingAcks: [],
    buttonActions: [],
    historyRequests: [],
    deltaRequests: [],
    inPlaceTriggered: false,
    inPlaceActions: [],
    sessions: {},
  };
  fixture.sessions[sourceSessionId] = {
    entries: sourceEntries,
    revision: revision(sourceSessionId, cwd, `${id}:source-revision`, `codex-assistant-${sourceSessionId}-${READER_LINE}`),
    payloadGeneration: 'file:ino-old',
    inPlaceEntries,
    inPlaceRevision: revision(sourceSessionId, cwd, `${id}:source-revision-inplace`, `codex-assistant-${sourceSessionId}-${READER_LINE}`),
    inPlacePayloadGeneration: 'file:ino-new',
  };
  fixture.sessions[childSessionId] = {
    entries: childEntries,
    revision: revision(childSessionId, cwd, `${id}:child-revision`, `codex-assistant-${childSessionId}-${READER_LINE}`),
    rewriteSourceSessionId: sourceSessionId,
    rewriteReceipt: makeReceipt(sourceSessionId, childSessionId, 0, 100_000),
  };
  fixture.sessions[grandchildSessionId] = {
    entries: grandchildEntries,
    revision: revision(grandchildSessionId, cwd, `${id}:grandchild-revision`, `codex-assistant-${grandchildSessionId}-${READER_LINE}`),
    rewriteSourceSessionId: childSessionId,
    rewriteReceipt: makeReceipt(childSessionId, grandchildSessionId, 100_000, 200_000),
  };
  fixtures.set(sourceSessionId, fixture);
  fixtures.set(childSessionId, fixture);
  fixtures.set(grandchildSessionId, fixture);
  fixture.triggerInPlace = () => {
    if (fixture.inPlaceTriggered) return;
    fixture.inPlaceTriggered = true;
    fixture.inPlaceActions.push({ from: 'file:ino-old', to: 'file:ino-new', at: Date.now() });
    ipcRenderer.emit('agent-transcript:changed', {}, {
      sessionId: sourceSessionId,
      toolType: 'codex',
      fileIdentity: 'file:ino-new',
      reason: 'fixture-in-place',
    });
  };
  const previousStreaming = useUIStore.getState().terminalHistoryStreamingEnabled;
  const previousFontSize = useUIStore.getState().historyFontSize;
  useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 16 });
  useWorkspaceStore.setState((state) => {
    const projects = new Map(state.openProjects);
    projects.set(projectId, {
      projectId,
      projectPath: cwd,
      tabs: new Map([[tabId, {
        id: tabId,
        name: 'JSONL Rewind prefix adoption fixture',
        cwd,
        commandType: 'codex',
        tabType: 'file',
        aiBusy: false,
        codexSessionId: sourceSessionId,
      }]]),
      activeTabId: tabId,
      tabGroups: [],
      currentView: 'terminal',
      selectedTabIds: [],
    } as any);
    return { openProjects: projects };
  });
  const host = document.createElement('div');
  host.dataset.rewritePrefixFixture = id;
  Object.assign(host.style, {
    position: 'fixed', top: '70px', left: '0', width: '620px', height: 'calc(100vh - 70px)',
    minHeight: '600px', zIndex: '100000', background: '#1a1a1a',
  });
  document.body.appendChild(host);
  const controls = document.createElement('div');
  controls.dataset.rewritePrefixControls = id;
  Object.assign(controls.style, {
    position: 'fixed', top: '86px', left: '636px', width: '225px', zIndex: '100001',
    color: '#ddd', fontFamily: 'sans-serif', fontSize: '12px',
  });
  document.body.appendChild(controls);
  const root = createRoot(host);
  const controlsRoot = createRoot(controls);
  const present = (visible: boolean) => {
    fixture.presented = visible;
    host.style.opacity = visible ? '1' : '0';
    host.inert = !visible;
    window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT, {
      detail: { channel, presented: visible, geometryStable: true, focused: visible },
    }));
  };
  const render = () => flushSync(() => root.render(<HistoryOwner fixture={fixture} channel={channel} />));
  const renderControls = () => flushSync(() => controlsRoot.render(<RewriteControls fixture={fixture} />));
  render();
  renderControls();
  present(true);
  return {
    id, tabId, projectId, cwd, channel, host, controls,
    sourceSessionId, childSessionId, grandchildSessionId, readerLine: READER_LINE, readerMarker: READER_MARKER,
    getCurrentSession: () => useWorkspaceStore.getState().getCodexSessionId(tabId),
    hasProject: () => useWorkspaceStore.getState().openProjects.has(projectId),
    readerUuid: (sessionId: string) => `codex-assistant-${sessionId}-${READER_LINE}`,
    state: () => ({
      currentSessionId: useWorkspaceStore.getState().getCodexSessionId(tabId),
      mode: fixture.mode,
      presented: fixture.presented,
      payloadGeneration: fixture.inPlaceTriggered ? 'file:ino-new' : 'file:ino-old',
      inPlaceTriggered: fixture.inPlaceTriggered,
      inPlaceActions: fixture.inPlaceActions,
      bindingAcks: fixture.bindingAcks,
      buttonActions: fixture.buttonActions,
      historyRequests: fixture.historyRequests,
      deltaRequests: fixture.deltaRequests,
      rowShape: { sourceSessionId: Object.hasOwn(fixture.sessions[sourceSessionId].entries[0], 'sourceSessionId') },
      sourceRevision: fixture.sessions[sourceSessionId].revision,
      childRevision: fixture.sessions[childSessionId].revision,
      grandchildRevision: fixture.sessions[grandchildSessionId].revision,
      childReceipt: fixture.sessions[childSessionId].rewriteReceipt,
      grandchildReceipt: fixture.sessions[grandchildSessionId].rewriteReceipt,
    }),
    get presented() { return fixture.presented; },
    show(next: boolean) { present(next); },
    destroy() {
      flushSync(() => root.unmount());
      flushSync(() => controlsRoot.unmount());
      host.remove();
      controls.remove();
      fixtures.delete(sourceSessionId);
      fixtures.delete(childSessionId);
      fixtures.delete(grandchildSessionId);
      useWorkspaceStore.setState((state) => {
        const projects = new Map(state.openProjects);
        projects.delete(projectId);
        return { openProjects: projects };
      });
      useUIStore.setState({
        terminalHistoryStreamingEnabled: previousStreaming,
        historyFontSize: previousFontSize,
      });
      ipcRenderer.invoke = originalInvoke;
      installed = false;
    },
  };
}
