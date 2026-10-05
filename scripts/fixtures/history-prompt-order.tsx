// Private HistoryPanel/composer fixture. No production API, provider or PTY.
// Receipt inputs deliberately reproduce the observed busy -> unknown handoff;
// production handoff hydration and live/durable projection decide what is shown.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { CODEX_PRESENCE_SNAPSHOT_FIELDS } from '../../src/renderer/utils/codexPtyPresence.mjs';
import {
  beginHistoryPromptHandoff, settleHistoryPromptHandoff,
  advanceHistoryPromptHandoffTransportPhase,
  getHistoryPromptHandoffsSnapshot, hydrateHistoryPromptHandoffFromDurableReceipt,
} from '../../src/renderer/utils/historyPromptHandoffs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');
const projectId = 'prompt-order-private-project', cwd = '/synthetic-prompt-order';
const cases = [
  { name: 'codex-incident', provider: 'codex', busy: true },
  { name: 'codex-fifo', provider: 'codex', busy: true },
  { name: 'claude-incident', provider: 'claude', busy: true },
  { name: 'codex-own-answer', provider: 'codex', busy: false },
];
const stamp = (value: number) => new Date(value).toISOString();
const sessions = new Map<string, any>();
const state: any = { active: cases[0].name, ready: {}, requests: [], events: [], frames: [],
  trusted: [], errors: [], forbidden: [], unknown: [], calls: [], acknowledgements: [], observing: false };
const fixture: any = (window as any).promptOrderFixture = { state, cases };
const localId = (tabId: string, handoffId: string) => 'local-prompt-' + tabId + '-' + handoffId;
const source = (ctx: any, role: string, offset: number) => ctx.provider === 'codex'
  ? 'codex-' + role + '-source-' + ctx.sessionId + '-' + offset
  : 'fixture-claude-' + ctx.name + '-' + role + '-' + offset;
const entry = (ctx: any, role: string, id: string, offset: number, content: string) => ({
  uuid: id, role, content, sessionId: ctx.sessionId, timestamp: stamp(ctx.epoch + offset),
  sourceIdentity: source(ctx, role, offset), recordByteOffset: offset,
});

for (const config of cases) {
  const ctx: any = { ...config, tabId: 'prompt-order-' + config.name,
    sessionId: 'private-session-' + config.name, epoch: Date.now() - 60000,
    requests: [], history: [], seeded: false, canonical: false, phase: 'initial' };
  ctx.first = entry(ctx, 'user', config.name + '-first-canonical', 200, 'FIRST PROMPT — already sent.');
  ctx.answers = [
    entry(ctx, 'assistant', config.name + '-existing-answer-1', 300,
      'EXISTING ANSWER — this was visible before the new prompt. ' + 'Earlier explanation. '.repeat(10)),
    entry(ctx, 'assistant', config.name + '-existing-answer-2', 400,
      'EXISTING ANSWER END — the new prompt belongs below this. ' + 'Existing conclusion. '.repeat(10)),
  ];
  // A durable prior row proves successful initial History. The first prompt is
  // retained locally with exact sent proof, as in the reported incident.
  ctx.history = [entry(ctx, 'user', config.name + '-older', 100, 'Prior context.')];
  if (!config.busy) ctx.history.push(ctx.first, ...ctx.answers);
  sessions.set(ctx.tabId, ctx);
  beginHistoryPromptHandoff({ tabId: ctx.tabId, handoffId: 'first-sent', toolType: ctx.provider,
    sessionIdHint: ctx.sessionId, text: ctx.first.content, source: 'history-panel', statusAtSend: 'busy',
    submittedAt: ctx.epoch + 200, sendAttemptId: 'first-attempt', sendOperationKey: 'first-operation-' + ctx.name,
    requiresAuditIdentity: true });
  settleHistoryPromptHandoff(ctx.tabId, 'first-sent', { queueStatus: 'sent', reason: 'fixture-exact-first',
    proof: { auditTimestamp: ctx.first.timestamp, actualHash: 'first-hash', sessionId: ctx.sessionId,
      entryUuid: ctx.first.uuid, sourceIdentity: ctx.first.sourceIdentity, recordByteOffset: 200 } });
}

const current = () => [...sessions.values()].find(ctx => ctx.name === state.active)!;
const handoff = (ctx: any, id: string) => getHistoryPromptHandoffsSnapshot(ctx.tabId).find(item => item.handoffId === id);
const recordEvent = (ctx: any, kind: string, request?: any, extra?: any) => {
  const owned = request ? handoff(ctx, request.handoffId) : null;
  state.events.push({ case: ctx.name, kind, at: performance.now(), handoffId: request?.handoffId,
    elapsed: request ? performance.now() - request.started : null,
    queueStatus: owned?.queueStatus, statusAtSend: owned?.statusAtSend, ...extra });
};
const emitEntry = (ctx: any, item: any) => ipcRenderer.emit('agent-transcript:live-message', {}, {
  tabId: ctx.tabId, toolType: ctx.provider, sessionId: ctx.sessionId,
  timestamp: item.timestamp, recordByteOffset: item.recordByteOffset,
  message: { type: item.role, uuid: item.uuid, sessionId: ctx.sessionId,
    sourceIdentity: item.sourceIdentity, timestamp: item.timestamp,
    message: { role: item.role, content: [{ type: 'text', text: item.content }] } },
});
const setBusy = (ctx: any, busy: boolean) => {
  ctx.busy = busy;
  useWorkspaceStore.setState(value => {
    const openProjects = new Map(value.openProjects), workspace = openProjects.get(projectId)!;
    const tabs = new Map(workspace.tabs); tabs.set(ctx.tabId, { ...tabs.get(ctx.tabId)!, aiBusy: busy });
    openProjects.set(projectId, { ...workspace, tabs }); return { openProjects };
  });
};
const durableReceipt = (ctx: any, request: any, phase: string) => {
  const confirmed = phase === 'confirmed', queued = phase === 'queued';
  const record: any = {
    tabId: ctx.tabId, handoffId: request.handoffId, operationKey: request.operationKey,
    attemptId: request.attemptId, provider: ctx.provider, sessionId: ctx.sessionId,
    surface: 'desktop-history', state: confirmed ? 'confirmed' : queued ? 'audit-pending' : 'preparing',
    createdAt: request.submittedAt, updatedAt: Date.now(),
    applicationQueue: { version: 1, id: request.index + 1, state: queued ? 'provider-queued' : 'dispatching' },
    receipt: { promptText: request.text, source: 'history-panel',
      ...(queued ? { providerQueue: { accepted: true, provider: ctx.provider,
        operationKey: request.operationKey, attemptId: request.attemptId,
        sourceIdentity: 'private-provider-queue-' + request.handoffId, sessionId: ctx.sessionId } } : {}),
      ...(confirmed ? { auditTimestamp: request.canonical.timestamp, actualHash: 'hash-' + request.handoffId,
        sessionId: ctx.sessionId, entryUuid: request.canonical.uuid,
        sourceIdentity: request.canonical.sourceIdentity, recordByteOffset: request.canonical.recordByteOffset } : {}),
    },
  };
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt(record);
  recordEvent(ctx, phase, request, { hydration: outcome.reason, hydrated: outcome.hydrated });
};

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, ...args: any[]) => {
  const payload = args[0]; state.calls.push(channel);
  const ctx = sessions.get(typeof payload === 'string' ? payload : payload?.tabId) || current();
  if (channel === 'agent:enqueue-prompt') {
    if (!sessions.has(payload?.tabId)) throw Error('Foreign fixture target');
    const index = ctx.requests.length;
    const request: any = { index, case: ctx.name, tabId: ctx.tabId, handoffId: payload.handoffId,
      operationKey: 'history:' + ctx.tabId + ':' + payload.handoffId,
      attemptId: 'private-attempt-' + index, text: payload.prompt, submittedAt: handoff(ctx, payload.handoffId)?.submittedAt || Date.now(),
      started: performance.now(), statusAtClick: payload.statusAtSend,
      localUuid: localId(ctx.tabId, payload.handoffId) };
    request.canonical = entry(ctx, 'user', ctx.name + '-canonical-' + index, 800 + index * 200, request.text);
    request.canonical.timestamp = stamp(request.submittedAt);
    ctx.requests.push(request); state.requests.push(request); ctx.phase = 'send';
    recordEvent(ctx, 'enqueue', request);
    if (ctx.name.endsWith('own-answer')) {
      setTimeout(() => {
        request.ownAnswer = entry(ctx, 'assistant', ctx.name + '-own-answer', 900, 'OWN ANSWER — stays after its new prompt. ' + 'New response. '.repeat(12));
        request.ownAnswer.timestamp = stamp(Date.now()); emitEntry(ctx, request.ownAnswer);
        recordEvent(ctx, 'own-answer', request);
      }, 650);
    }
    // Exact reported phase cadence: queued/busy -> sending/busy -> app queue,
    // then receipt introduces its real attempt identity with unknown status.
    setTimeout(() => { advanceHistoryPromptHandoffTransportPhase(ctx.tabId, request.handoffId, 'sending');
      recordEvent(ctx, 'sending-known', request); }, 199);
    setTimeout(() => durableReceipt(ctx, request, 'preparing'), 506);
    setTimeout(() => durableReceipt(ctx, request, ctx.name.endsWith('own-answer') ? 'confirmed' : 'queued'), 981);
    return new Promise(resolve => setTimeout(() => {
      recordEvent(ctx, 'application-admission', request);
      resolve({ success: true, accepted: true, submitted: false, applicationQueued: true,
        operationKey: request.operationKey, handoffId: request.handoffId,
        applicationQueue: { version: 1, id: index + 1, state: 'waiting' } });
    }, 260));
  }
  if (channel === 'codex:get-runtime-projection' || channel === 'codex:get-runtime-session') return {
    ...Object.fromEntries(CODEX_PRESENCE_SNAPSHOT_FIELDS.map((key: string) => [key, null])),
    success: true, projectId, sessionStatus: ctx.busy ? 'busy' : 'active', busy: ctx.busy, inputReady: true,
    liveLifecycle: true, sessionId: ctx.sessionId, readSessionId: ctx.sessionId, readIdentitySource: 'live-writer',
    savedSessionId: ctx.sessionId, conversationMaterialized: true, timelineCount: 2,
    canCopySessionId: true, hasTerm: true, hasWatcher: true, catchUpPending: false, outcomeKnown: false,
    writerConfirmed: true, writerStatus: 'adopted', writerUsableForMutation: true,
    provenWriterSessionId: ctx.sessionId, writerProof: 'private-fixture', launchId: 'fixture-launch', lifecycleGeneration: 1,
  };
  if (channel === 'claude:get-presence') return { status: ctx.busy ? 'busy' : 'active', hasBridge: true,
    isBusy: ctx.busy, hasTerm: true, inputReady: true, sessionId: ctx.sessionId,
    conversationMaterialized: true, canCopySessionId: true, timelineCount: 2,
    providerProcessAlive: true, startupDefaultsReady: true };
  if (channel === 'codex:get-draft-state' || channel === 'claude:get-draft-state') return {
    success: true, hasDraft: false, preview: '', source: 'fixture-main', proofOutcome: 'absent' };
  if (channel === 'tab-work-context:prepare') return { success: true, prompt: payload.prompt, prefix: '' };
  if (channel === 'tab-work-context:get') return { success: true, updates: [] };
  if (/^tab-work-context:(activate|settle|release)/.test(channel)) return { success: true };
  if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
  if (channel === 'agent:acknowledge-send-receipt-presentation') {
    state.acknowledgements.push({ ...payload, case: ctx.name, at: performance.now() }); return { success: true, applied: true };
  }
  if (channel === 'agent-transcript:get-history' || channel === 'claude:get-full-history') {
    recordEvent(ctx, 'read'); return structuredClone({ success: true, entries: ctx.history,
      payloadGeneration: ctx.name + ':epoch', revision: { sources: [{ sessionId: ctx.sessionId,
        fileIdentity: ctx.name, linkKind: 'end' }] } });
  }
  if (channel === 'agent-activity:get-tab-timing') return { success: true, timing: ctx.busy ? {
    state: 'running', intervalId: null, toolType: ctx.provider, sessionId: ctx.sessionId,
    startTs: ctx.epoch + 300, endTs: null, durationMs: null } : null };
  if (channel === 'agent-session:get-availability-batch') return { success: true, results: (payload.sessions || [])
    .map((item: any) => ({ ...item, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  if (/^agent-transcript:(subscribe|unsubscribe)$/.test(channel)) return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:(send-command|run)|agent:(stop|rewind))/.test(channel)) {
    state.forbidden.push(channel); throw Error('Fixture forbids transport: ' + channel);
  }
  if (channel === 'claude:get-pending-question') return null;
  return originalInvoke(channel, ...args);
};

for (const type of ['keydown', 'click', 'input']) document.addEventListener(type, event => {
  if ((event.target as HTMLElement)?.closest?.('[data-history-composer-tab-id]')) state.trusted.push({
    type, key: (event as KeyboardEvent).key, trusted: event.isTrusted, at: performance.now(), case: state.active });
}, true);
useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 14,
  promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, openProjects: new Map([[projectId, {
  projectId, projectPath: cwd, tabs: new Map([...sessions.values()].map(ctx => [ctx.tabId, {
    id: ctx.tabId, name: ctx.name, cwd, commandType: ctx.provider, tabType: 'file', aiBusy: ctx.busy,
    [ctx.provider + 'SessionId']: ctx.sessionId,
  }])), activeTabId: current().tabId, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  tabHistory: [...sessions.keys()], tabOrder: [...sessions.keys()],
}]]) } as any);
for (const ctx of sessions.values()) useUIStore.getState().setHistoryPromptDraft(ctx.tabId, '', { chips: [] });

fixture.seedLive = () => {
  const ctx = current(); if (ctx.seeded) return;
  ctx.seeded = true;
  if (!ctx.name.endsWith('own-answer')) for (const item of ctx.answers) emitEntry(ctx, item);
  recordEvent(ctx, 'seed-live');
};
fixture.confirm = () => {
  const ctx = current(); ctx.phase = 'sent';
  for (const request of ctx.requests) durableReceipt(ctx, request, 'confirmed');
};
fixture.materialize = () => {
  const ctx = current(); ctx.phase = 'canonical'; ctx.canonical = true;
  ctx.history = [ctx.history[0], ctx.first, ...ctx.answers,
    ...ctx.requests.flatMap((request: any) => [request.canonical, ...(request.ownAnswer ? [request.ownAnswer] : [])])];
  setBusy(ctx, false);
  ipcRenderer.emit('agent-transcript:changed', {}, { tabId: ctx.tabId, toolType: ctx.provider,
    sessionId: ctx.sessionId, fileIdentity: ctx.name, reason: 'fixture-canonical-append' });
  recordEvent(ctx, 'materialize');
};
fixture.snapshot = () => {
  const ctx = current();
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-uuid]')];
  return { case: ctx.name, at: performance.now(), phase: ctx.phase,
    rows: nodes.map(node => ({ uuid: node.dataset.uuid, top: node.getBoundingClientRect().top,
      height: node.getBoundingClientRect().height })),
    handoffs: getHistoryPromptHandoffsSnapshot(ctx.tabId).map(item => ({ handoffId: item.handoffId,
      queueStatus: item.queueStatus, statusAtSend: item.statusAtSend })),
    ids: { first: [localId(ctx.tabId, 'first-sent'), ctx.first.uuid], answers: ctx.answers.map((item: any) => item.uuid),
      prompts: ctx.requests.map((request: any) => ({ handoffId: request.handoffId,
        local: request.localUuid, canonical: request.canonical.uuid, ownAnswer: request.ownAnswer?.uuid })) },
  };
};
fixture.observe = (enabled: boolean) => {
  state.observing = enabled;
  if (!enabled) return;
  const frame = () => {
    if (!state.observing) return;
    state.frames.push(fixture.snapshot()); requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
fixture.summary = () => ({ ...state, contexts: [...sessions.values()].map(ctx => ({
  name: ctx.name, provider: ctx.provider, tabId: ctx.tabId, sessionId: ctx.sessionId,
  first: ctx.first, answers: ctx.answers, requests: ctx.requests, canonical: ctx.canonical,
})) });

function Fixture() {
  const [selected, select] = useState(cases[0].name), ctx = [...sessions.values()].find(item => item.name === selected)!;
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#1a1a1a' }}>
    <header style={{ display: 'flex', flexShrink: 0, gap: 10, height: 34, alignItems: 'center' }}>
      <strong>Private prompt order</strong>
      {cases.map(item => <button key={item.name} data-order-case={item.name} onClick={() => {
        state.active = item.name; useWorkspaceStore.getState().switchTab(projectId, 'prompt-order-' + item.name); select(item.name);
      }}>{item.name}</button>)}
    </header>
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <HistoryPanel key={ctx.name} tabId={ctx.tabId} projectId={projectId} sessionId={ctx.sessionId} cwd={cwd}
        width={1100} notesPanelWidth={0} isOpen embedded embeddedFill mainSurface enableClaudePtyControls
        toolType={ctx.provider} presented preservePresentationGeometry
        onInitialSourceSignal={detail => { if (detail.phase === 'load' && detail.status === 'success') state.ready[ctx.name] = true; }} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
