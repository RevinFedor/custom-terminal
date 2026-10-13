import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { create } from 'zustand';
import '../../packages/claude-blocks/src/blocks.css';

// Real chip/tooltip/rows and hooks; only IPC, workspace/UI stores and run
// ownership/provider evidence are substituted. No product main process loads.
const owner = 'continuation-ui-owner';
const target = 'continuation-ui-target';
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const pending: Array<{ runId: string; resolve: (value: any) => void }> = [];
const pendingCancellation: Array<{ run: any; resolve: (value: any) => void }> = [];
let version = 0;
let revision = Date.now();
const fixture: any = (window as any).orchestrationContinuationUI = {
  ready: false, calls: [], events: [], violations: [], runs: [], caseId: 'initial',
  holdContinue: false, reply: 'unconfirmed', width: Number(new URLSearchParams(location.search).get('width')) || 500,
};
const deny = (operation: string): never => {
  fixture.violations.push(operation);
  throw new Error('Continuation UI fixture forbids ' + operation);
};
const emit = (channel: string, payload: unknown) => {
  for (const listener of listeners.get(channel) || []) listener({}, structuredClone(payload));
};
const clone = <T,>(value: T): T => structuredClone(value);
const settings = { codexCapacityRetryEnabled: false, codexCapacityRetryLimit: 2,
  failureGraceMs: 0, successAutoStopMs: 0, reactToManualInterrupt: true, autoStopCreatedTargets: false };

const baseRun = (caseId: string, patch: any = {}) => ({
  runId: 'continuation-ui-' + caseId, runKind: 'agent', status: 'waiting_recovery', outcome: 'interrupted',
  label: 'Continuation request ' + 'LongLabel'.repeat(24),
  sourceTabId: owner, sourceTabName: 'UI fixture owner', sourceProjectId: 'continuation-ui-project',
  sourceProjectPath: '/synthetic-continuation-ui', sourceProjectName: 'Synthetic workspace',
  targetTabId: target, targetTabName: 'Continuation target', targetProjectId: 'continuation-ui-project',
  targetProjectPath: '/synthetic-continuation-ui', targetProjectName: 'Synthetic workspace',
  sourceExecutionContext: { provider: 'codex', sessionId: 'synthetic-source', turnId: 'synthetic-source-turn' },
  targetExecutionContext: { provider: 'codex', sessionId: 'synthetic-target', turnId: 'synthetic-target-turn' },
  createdAt: Date.now() - 10000, updatedAt: ++revision,
  deliveryAcceptedAt: Date.now() - 9000, targetPromptProofAt: Date.now() - 8500,
  recoveryReason: 'process-exit', recoveryDeadlineAt: null, resultComplete: false, ...patch,
});

function continueResult(runId: string, mode: string) {
  const run = fixture.runs.find((item: any) => item.runId === runId);
  if (!run) return deny('unknown-run:' + runId);
  if (mode === 'history-changed') return { ok: false, code: 'continuation_history_changed',
    error: 'История исполнителя изменилась. Создайте новый запрос явно.', canCreateNewRequest: true, run: clone(run) };
  if (mode === 'unconfirmed') {
    const next = { ...run, updatedAt: ++revision, continuation: {
      operationId: 'synthetic-operation-' + runId, handoffId: 'synthetic-handoff-' + runId,
      state: 'unconfirmed', createdAt: Date.now(), error: 'Synthetic continuation delivery is unknown',
    } };
    fixture.runs = fixture.runs.map((item: any) => item.runId === runId ? next : item);
    return { ok: true, pending: true, run: clone(next) };
  }
  if (mode === 'bound') {
    const next = { ...run, status: 'running', outcome: null, updatedAt: ++revision,
      continuation: { ...run.continuation, state: 'bound', confirmedAt: Date.now() } };
    fixture.runs = fixture.runs.map((item: any) => item.runId === runId ? next : item);
    return { ok: true, resumed: true, run: clone(next) };
  }
  return deny('reply-mode:' + mode);
}

function respond(channel: string, payload: any) {
  if (channel === 'orchestration:get-settings') return clone(settings);
  if (channel === 'orchestration:list-for-tab') {
    if (payload !== owner) return deny('run-list-owner');
    return clone(fixture.runs);
  }
  if (channel === 'tab-messages:list') {
    if (payload?.tabId !== owner) return deny('message-list-owner');
    return [];
  }
  if (channel === 'orchestration:action') {
    const run = fixture.runs.find((item: any) => item.runId === payload.runId);
    if (!run || payload.tabId !== owner) return deny('action-owner');
    if (payload.action === 'continue') {
      if (fixture.holdContinue) return new Promise(resolve => pending.push({ runId: payload.runId, resolve }));
      return continueResult(payload.runId, fixture.reply);
    }
    if (payload.action === 'new-request') {
      // The UI intent is tested, not a real new run or provider submission.
      return { ok: true, replacementRunId: 'synthetic-replacement-' + run.runId,
        run: { ...clone(run), replacementRunId: 'synthetic-replacement-' + run.runId, updatedAt: ++revision } };
    }
    if (['dismiss', 'detach', 'report'].includes(payload.action)) {
      if (fixture.holdCancellation) return new Promise(resolve => pendingCancellation.push({ run: clone(run), resolve }));
      return { ok: true, run: clone(run) };
    }
    return deny('unexpected-action:' + payload.action);
  }
  if (channel === 'agent:cancel-send') {
    // A private cancellation receipt; never reaches real Send/FIFO/PTY.
    if (payload.tabId !== target || !pending.length) return deny('cancel-owner');
    return { cancelled: true };
  }
  return deny('ipc:' + channel);
}

const ipc: any = {
  invoke(channel: string, ...args: any[]) {
    fixture.calls.push({ channel, args: clone(args), caseId: fixture.caseId });
    return Promise.resolve().then(() => respond(channel, args[0])).then(clone);
  },
  send(channel: string) { return deny('ipc-send:' + channel); },
  sendSync(channel: string) { return deny('ipc-sendSync:' + channel); },
  on(channel: string, callback: (...args: any[]) => void) {
    if (!['orchestration:changed', 'tab-messages:changed'].includes(channel)) return deny('ipc-listen:' + channel);
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(callback);
    return ipc;
  },
  removeListener(channel: string, callback: (...args: any[]) => void) { listeners.get(channel)?.delete(callback); return ipc; },
};
fixture.workspace = create(() => ({ openProjects: new Map(), openTabById: () => deny('workspace-navigation') }));
fixture.ui = create(() => ({ showToast: () => deny('ui-toast'), tabbarFontSize: 12 }));
(window as any).require = (name: string) => {
  if (name !== 'electron') return deny('require:' + name);
  return { ipcRenderer: ipc, clipboard: { readText: () => deny('clipboard-read'),
    writeText: () => deny('clipboard-write'), availableFormats: () => deny('clipboard-formats') },
    shell: { openExternal: () => deny('shell-open'), openPath: () => deny('shell-open') } };
};
window.fetch = (() => deny('fetch')) as any;
window.XMLHttpRequest = class { constructor() { deny('XMLHttpRequest'); } } as any;
window.WebSocket = class { constructor() { deny('WebSocket'); } } as any;
window.EventSource = class { constructor() { deny('EventSource'); } } as any;
window.open = (() => deny('window.open')) as any;

for (const type of ['pointerenter', 'pointerdown', 'click']) document.addEventListener(type, event => {
  const button = (event.target as Element)?.closest?.('[data-orchestration-action], [data-orchestration-dismiss]');
  if (button) fixture.events.push({ type, trusted: event.isTrusted, caseId: fixture.caseId,
    action: button.getAttribute('data-orchestration-action') || 'row-dismiss',
    runId: button.getAttribute('data-orchestration-run-id') || button.getAttribute('data-orchestration-dismiss') });
}, true);

async function mount() {
  const { OrchestrationStatusChip } = await import('../../src/renderer/components/Workspace/OrchestrationStatusChip');
  const root = createRoot(document.getElementById('root')!);
  const render = () => flushSync(() => root.render(
    <div data-continuation-pane data-split-pane-queue-host style={{ position: 'absolute', left: 20, top: 70,
      width: fixture.width, height: 650, border: '1px solid #444', background: '#202020', boxSizing: 'border-box' }}>
      <div data-prompt-queue-owner={owner} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {/* A measured, collapsed-rail host, not a mounted Run After executor. */}
        <div data-continuation-rail className="pq-collapsed-rail" style={{ position: 'absolute', right: 8, top: 8,
          width: 128, height: 28, padding: 0, display: 'flex', alignItems: 'center', gap: 4,
          border: '1px solid #303030', borderRadius: 8, background: '#151515', pointerEvents: 'auto' }}>
          <OrchestrationStatusChip key={version} tabId={owner} panelOpen={false} queueVisible={false} effectiveWidth={260} />
        </div>
      </div>
    </div>,
  ));
  fixture.reset = (caseId: string, patch: any = {}) => {
    if (pending.length || pendingCancellation.length) return deny('reset-with-held-ipc');
    fixture.caseId = caseId;
    fixture.holdContinue = false;
    fixture.holdCancellation = false;
    fixture.reply = 'unconfirmed';
    fixture.runs = [baseRun(caseId, patch)];
    version += 1;
    render();
  };
  fixture.publish = (patch: any) => {
    fixture.runs = fixture.runs.map((run: any) => ({ ...run, ...patch, updatedAt: ++revision }));
    emit('orchestration:changed', { run: fixture.runs[0] });
  };
  fixture.hold = () => { fixture.holdContinue = true; };
  fixture.release = (mode: string) => {
    fixture.holdContinue = false;
    for (const item of pending.splice(0)) item.resolve(continueResult(item.runId, mode));
  };
  fixture.releaseCancellation = () => {
    fixture.holdCancellation = false;
    for (const item of pendingCancellation.splice(0)) item.resolve({ ok: true, run: clone(item.run) });
  };
  fixture.state = () => clone({ caseId: fixture.caseId, calls: fixture.calls, events: fixture.events,
    violations: fixture.violations, runs: fixture.runs, pending: pending.length, pendingCancellation: pendingCancellation.length });
  fixture.reset('initial');
  fixture.ready = true;
}
void mount().catch(error => { fixture.error = String(error?.stack || error); });
