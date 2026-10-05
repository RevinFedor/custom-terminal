import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../packages/claude-blocks/src/blocks.css';

// Only the transport and workspace navigation are substituted. The rail,
// tracker, queue, source chips, previews and history are production components.
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const saved = new Map<string, unknown>();
const owner = 'layout-owner';
const projectId = 'layout-project';
const peerProjectId = 'layout-peer-project';
const cwd = '/synthetic-tab-message-layout';
let clock = Date.now();
const stamp = () => new Date(++clock).toISOString();
const longName = 'Incoming peer with a deliberately long label ' + 'UnbrokenName'.repeat(18);
const fixture: any = (window as any).tabMessageLayout = {
  calls: [], unknown: [], violations: [], navigation: [], messages: [], runs: [], ready: false,
};
const deny = (operation: string): never => {
  fixture.violations.push(operation);
  throw new Error('Layout fixture forbids ' + operation);
};
const emit = (channel: string, payload: unknown) => {
  for (const callback of listeners.get(channel) || []) callback({}, structuredClone(payload));
};
const summaries = () => fixture.messages.map(({ text, ...message }: any) => message);
const settings = { codexCapacityRetryEnabled: false, codexCapacityRetryLimit: 2, failureGraceMs: 0,
  successAutoStopMs: 0, reactToManualInterrupt: true, autoStopCreatedTargets: false };

function response(channel: string, payload: any) {
  if (channel === 'app:getState') return saved.get(payload) ?? null;
  if (channel === 'app:setState' || channel === 'app:setStateSync') {
    saved.set(payload.key, payload.value); return { success: true };
  }
  if (channel === 'tab-messages:list') return payload.tabId === owner ? summaries() : [];
  if (channel === 'tab-messages:get') {
    const message = fixture.messages.find((item: any) => item.messageId === payload.messageId);
    if (!message) throw new Error('Unknown fixture message ' + payload.messageId);
    return { message, reply: fixture.messages.find((item: any) => item.replyTo === message.messageId) ?? null };
  }
  if (channel === 'tab-messages:dismiss') {
    if (payload.tabId !== owner) throw new Error('Dismiss addressed the wrong fixture tab');
    const message = fixture.messages.find((item: any) => item.messageId === payload.messageId);
    if (!message || message.kind !== 'question') throw new Error('Dismiss must address a question');
    const field = message.sourceTabId === owner ? 'sourceDismissedAt' : 'targetDismissedAt';
    Object.assign(message, { [field]: stamp(), updatedAt: stamp() });
    const { text, ...summary } = message;
    emit('tab-messages:changed', { message: summary, reason: 'dismissed' });
    return { message: summary };
  }
  if (channel === 'orchestration:list-for-tab') return payload === owner ? fixture.runs : [];
  if (channel === 'orchestration:get-settings') return settings;
  if (channel === 'provider:get-status') return { type: 'codex' };
  if (channel === 'tab:get-context-pct') return { pct: 25 };
  if (channel === 'tab-work-context:get') return { success: true,
    context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: 0 } };
  if (channel === 'agent-session:get-availability-batch') return { success: true,
    results: (payload.sessions || []).map((session: any) => ({ ...session, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  if (channel === 'terminal:getCommandState') return { isRunning: true, command: 'codex' };
  if (channel === 'terminal:getCommandStates') return Object.fromEntries([owner, 'layout-peer', 'layout-target']
    .map(id => [id, { isRunning: true, command: 'codex' }]));
  if (/^(orchestration:(action|update-settings)|terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:(run|append-input)|claude:(append-input|send-command)|agent:(send|stop|rewind|cancel-send)|shell:)/.test(channel)) return deny(channel);
  if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(resize|subscribe|unsubscribe))/.test(channel)) return { success: true };
  if (/^agent:.*send-receipts/.test(channel)) return { success: true, records: [] };
  if (/list|catalog|get-models|get-prompts|get-task-plan|prompts:get/.test(channel)) return [];
  if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
  if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
  fixture.unknown.push(channel);
  return null;
}
const ipc: any = {
  invoke(channel: string, ...args: any[]) {
    fixture.calls.push({ channel, args: structuredClone(args) });
    return Promise.resolve().then(() => structuredClone(response(channel, args[0])));
  },
  send(channel: string, ...args: any[]) {
    fixture.calls.push({ channel, args: structuredClone(args) });
    return response(channel, args[0]);
  },
  sendSync(channel: string, ...args: any[]) { return ipc.send(channel, ...args); },
  on(channel: string, callback: (...args: any[]) => void) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(callback); return ipc;
  },
  once(channel: string, callback: (...args: any[]) => void) {
    const once = (...args: any[]) => { ipc.off(channel, once); callback(...args); };
    return ipc.on(channel, once);
  },
  off(channel: string, callback: (...args: any[]) => void) { listeners.get(channel)?.delete(callback); return ipc; },
  removeListener(channel: string, callback: (...args: any[]) => void) { return ipc.off(channel, callback); },
  removeAllListeners(channel: string) { listeners.delete(channel); return ipc; },
};
const fakePath = { sep: '/', basename: (value: string) => value.split('/').pop(),
  dirname: (value: string) => value.slice(0, value.lastIndexOf('/')) || '/',
  join: (...values: string[]) => values.join('/').replace(/\/+/g, '/'),
  extname: (value: string) => value.includes('.') ? '.' + value.split('.').pop() : '',
  isAbsolute: (value: string) => value.startsWith('/'), resolve: (...values: string[]) => values.join('/'),
  relative: (from: string, to: string) => to.replace(from + '/', '') };
(window as any).require = (name: string) => {
  if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [],
    readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard') },
    shell: { openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
  if (name === 'path') return fakePath;
  if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
  if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
  return deny('require:' + name);
};
(window as any).process = (window as any).require('process');
window.fetch = (() => deny('fetch')) as any;
window.XMLHttpRequest = class { constructor() { deny('XMLHttpRequest'); } } as any;
window.WebSocket = class { constructor() { deny('WebSocket'); } } as any;
window.EventSource = class { constructor() { deny('EventSource'); } } as any;
window.open = (() => deny('window.open')) as any;

async function mount() {
  const { PromptQueueOverlay } = await import('../../src/renderer/components/Workspace/PromptQueueOverlay');
  const { useWorkspaceStore } = await import('../../src/renderer/store/useWorkspaceStore');
  const { useProjectsStore } = await import('../../src/renderer/store/useProjectsStore');
  const { usePromptQueueStore } = await import('../../src/renderer/store/usePromptQueueStore');
  const { useUIStore } = await import('../../src/renderer/store/useUIStore');
  const { useAutoCompactStore } = await import('../../src/renderer/store/useAutoCompactStore');
  const { emptySpaceLayout } = await import('../../src/renderer/utils/workspaceSpacesModel.mjs');
  const tab = (id: string, name: string) => ({ id, name, cwd, commandType: 'codex', tabType: 'terminal',
    color: 'codex', codexSessionId: 'synthetic-session-' + id, aiBusy: true });
  const workspace = (id: string, tabs: any[]) => ({ projectId: id, projectPath: cwd,
    tabs: new Map(tabs.map(item => [item.id, item])), activeTabId: tabs[0].id,
    currentView: 'terminal', tabGroups: [], selectedTabIds: [], tabHistory: [] });
  const layout = { ...emptySpaceLayout(), activeProjectId: projectId, focusedProjectId: projectId,
    activeSpaceTab: { projectId, tabId: owner }, splitPanes: [{ projectId, tabId: owner,
      windowId: 'layout-window', column: 0, tabs: [{ projectId, tabId: owner }] }], splitFocusedIndex: 0 };
  useProjectsStore.setState({ projects: Object.fromEntries([projectId, peerProjectId].map(id => [id,
    { id, path: cwd, name: id }])) } as any);
  useWorkspaceStore.setState({ ...layout, isRestoring: false, view: 'workspace',
    openProjects: new Map([[projectId, workspace(projectId, [tab(owner, 'Layout owner')])],
      [peerProjectId, workspace(peerProjectId, [tab('layout-peer', longName), tab('layout-target', 'Native run target')])]]),
    activeSpaceId: 'layout-workflow', spaces: [{ id: 'layout-workflow', name: 'Layout fixture',
      projectIds: [projectId, peerProjectId], layout }],
    showWorkspace: () => {}, setProjectView: () => {},
    placeTab: (id: string, tabId: string) => fixture.navigation.push({ kind: 'placeTab', projectId: id, tabId }),
    activateCenterTab: (id: string, tabId: string) => fixture.navigation.push({ kind: 'activateCenterTab', projectId: id, tabId }),
  } as any);
  useUIStore.setState({ activeArea: 'workspace', promptQueueWidth: 260, promptQueueChipFontSize: 12,
    promptQueueEditorFontSize: 12, interfaceHintsEnabled: false } as any);
  useAutoCompactStore.setState({ hydrated: true, policy: { ...useAutoCompactStore.getState().policy,
    scopeInitialized: true, enabled: false, workflowIds: ['layout-workflow'] } });
  const baseQueue = usePromptQueueStore.getState().getQueue(owner);
  let version = 0;
  const root = createRoot(document.getElementById('root')!);
  const render = () => root.render(<div data-tab-layout-fixture style={{ position: 'absolute', left: 40, top: 70,
    width: fixture.width, height: 650, background: '#202020', border: '1px solid #444', boxSizing: 'border-box' }}>
    <div data-layout-transcript style={{ position: 'absolute', top: 110, left: 12, right: 12, color: '#aaa', fontSize: 12 }}>
      Synthetic transcript content
    </div>
    <div data-split-pane-queue-host style={{ position: 'absolute', inset: 0, zIndex: 140, pointerEvents: 'none' }}>
      <PromptQueueOverlay key={version} tabId={owner} sessionType="codex" agentBusy inputSurface="history" />
    </div>
  </div>);
  fixture.reset = (width: number) => {
    clock = Date.now() - 10000;
    fixture.width = width;
    fixture.messages = [];
    fixture.navigation = [];
    fixture.runs = [{ runId: 'layout-native-run', runKind: 'native', status: 'running',
      sourceTabId: owner, sourceTabName: 'Layout owner', sourceProjectId: projectId, sourceProjectPath: cwd,
      targetTabId: 'layout-target', targetTabName: 'Native run target', targetProjectId: peerProjectId,
      targetProjectPath: cwd, targetProjectName: 'Peer project', label: 'Independent native delegation',
      createdAt: Date.now() - 1000, deliveryAcceptedAt: Date.now() - 900, targetPromptProofAt: Date.now() - 850 }];
    usePromptQueueStore.setState({ queues: new Map([[owner, { ...baseQueue, panelCollapsed: true,
      autoRun: true, postPromptEnabled: false, loopPromptEnabled: false,
      items: [{ id: 'layout-queue-item', title: 'Queue remains armed', titleManual: true,
        text: 'Synthetic queued prompt; must never execute', images: 0, chips: [], imagePaths: [] }],
    }]]) } as any);
    version += 1;
    render();
  };
  fixture.arrive = () => {
    const question = { messageId: 'layout-question', kind: 'question', sourceTabId: 'layout-peer',
      sourceTabName: longName, sourceProjectId: peerProjectId, sourceSessionId: 'synthetic-peer',
      targetTabId: owner, targetTabName: 'Layout owner', targetProjectId: projectId,
      targetSessionId: 'synthetic-owner', deliveryState: 'sent', createdAt: stamp(), updatedAt: stamp(),
      textPreview: 'A deliberately long question preview ' + 'Preview'.repeat(50),
      text: 'Question body sentinel\n\n' + 'Detailed question body.\n'.repeat(60),
      replyMessageId: 'layout-reply', answeredAt: stamp() };
    const reply = { ...question, messageId: 'layout-reply', kind: 'reply', replyTo: question.messageId,
      sourceTabId: owner, sourceTabName: 'Layout owner', sourceProjectId: projectId,
      targetTabId: 'layout-peer', targetTabName: longName, targetProjectId: peerProjectId,
      sourceSessionId: 'synthetic-owner', targetSessionId: 'synthetic-peer',
      replyMessageId: null, answeredAt: null, deliveryState: 'failed', error: 'Synthetic reverse-delivery failure',
      createdAt: stamp(), updatedAt: stamp(), text: 'Answer body sentinel\n\n| Key | Value |\n| --- | --- |\n| Result | 42 |\n' };
    const outgoing = { ...question, messageId: 'layout-outgoing', sourceTabId: owner, sourceTabName: 'Layout owner',
      sourceProjectId: projectId, targetTabId: 'layout-peer', targetTabName: longName, targetProjectId: peerProjectId,
      sourceSessionId: 'synthetic-owner', targetSessionId: 'synthetic-peer',
      replyMessageId: null, answeredAt: null, deliveryState: 'queued', createdAt: stamp(), updatedAt: stamp(),
      text: 'Second question sentinel' };
    fixture.messages = [question, reply, outgoing];
    for (const message of summaries()) emit('tab-messages:changed', { message, reason: 'fixture-arrival' });
  };
  fixture.addHistory = () => {
    const createdAt = Date.parse(fixture.messages[0].createdAt);
    for (let index = 0; index < 16; index += 1) {
      const run = { ...fixture.runs[0], runId: 'layout-history-' + index, status: 'completed',
        label: 'Historical request ' + index, outcome: 'success',
        createdAt: createdAt + (index < 8 ? 1 : -1) * (index + 1) * 1000,
        completedAt: createdAt - 600000, notificationStatus: 'sent', notificationSentAt: createdAt - 600000 };
      fixture.runs.push(run);
      emit('orchestration:changed', { run });
    }
  };
  fixture.overflow = () => {
    for (let index = 0; index < 6; index++) {
      const question = { ...fixture.messages[0], messageId: 'layout-extra-' + index,
        replyMessageId: null, answeredAt: null, createdAt: stamp(), updatedAt: stamp() };
      fixture.messages.push(question);
      emit('tab-messages:changed', { message: question, reason: 'fixture-arrival' });
    }
    const run = { ...fixture.runs[0], runId: 'layout-error-run', status: 'failed',
      attentionRequiredAt: Date.now(), completedAt: Date.now(), error: 'Controlled failure' };
    fixture.runs.push(run);
    emit('orchestration:changed', { run });
  };
  fixture.completePair = () => {
    for (const [id, age] of [['layout-question', 3400], ['layout-outgoing', 0]] as const) {
      const question = fixture.messages.find((item: any) => item.messageId === id);
      const existing = fixture.messages.find((item: any) => item.kind === 'reply' && item.replyTo === id);
      Object.assign(question, { deliveryState: 'sent', replyMessageId: existing?.messageId || 'success-' + id, updatedAt: stamp() });
      const reply = { ...question, kind: 'reply', messageId: question.replyMessageId, replyTo: id,
        sourceTabId: question.targetTabId, targetTabId: question.sourceTabId, replyMessageId: null,
        createdAt: new Date(Date.now() - age).toISOString(), updatedAt: new Date(Date.now() - age).toISOString() };
      if (existing) Object.assign(existing, reply);
      else fixture.messages.push(reply);
      emit('tab-messages:changed', { message: question });
      emit('tab-messages:changed', { message: reply });
    }
    Object.assign(fixture.runs[0], { status: 'completed', resultComplete: true, completedAt: Date.now() - 1200,
      sourceFollowupPending: false, notificationStatus: 'sent' });
    emit('orchestration:changed', { run: fixture.runs[0] });
  };
  fixture.state = () => ({ queue: usePromptQueueStore.getState().getQueue(owner), runs: fixture.runs,
    messages: summaries(), navigation: fixture.navigation, calls: fixture.calls, unknown: fixture.unknown,
    violations: fixture.violations });
  fixture.remount = () => { version += 1; render(); };
  fixture.reset(Number(new URLSearchParams(window.location.search).get('width')) || 1000);
  fixture.ready = true;
}
void mount().catch(error => { fixture.error = String(error?.stack || error); console.error(error); });
