import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { sendAgentPromptScenario } from '../../src/renderer/utils/agentScenarios';
import { getHistoryAgentRuntime } from '../../src/renderer/utils/historyAgentRuntimes';
import { hydrateHistoryPromptHandoffFromDurableReceipt } from '../../src/renderer/utils/historyPromptHandoffs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

// Actual History/composer/scenario; the private main below owns a real SQLite
// queue. Only provider presence, transcript and physical transport are controlled.
const { ipcRenderer } = window.require('electron');
const projectId = 'application-queue-project', cwd = '/synthetic-application-queue';
const providers = ['codex', 'claude'] as const;
const tabIdFor = (provider: string) => 'application-queue-' + provider;
const sessionFor = (provider: string) => 'application-queue-session-' + provider;
const fixture: any = (window as any).applicationQueueFixture = {
  ready: {}, trusted: [], receipts: [], dispatches: [], writes: [], errors: [], active: 'codex',
};
for (const type of ['keydown', 'click', 'input']) document.addEventListener(type, event => {
  fixture.trusted.push({ type, trusted: event.isTrusted, key: (event as KeyboardEvent).key || null,
    target: (event.target as HTMLElement)?.getAttribute?.('aria-label') || (event.target as HTMLElement)?.tagName });
}, true);

// This is the same App subscription, deliberately outside the mounted tab. A
// tab hide/remount must never become a second queue executor.
ipcRenderer.on('agent:send-queue-receipt', (_event: any, record: any) => {
  fixture.receipts.push({ operationKey: record.operationKey, state: record.state,
    queueState: record.applicationQueue?.state, attemptId: record.attemptId });
  hydrateHistoryPromptHandoffFromDurableReceipt(record);
});
ipcRenderer.on('fixture:provider-write', (_event: any, detail: any) => fixture.writes.push(detail));
ipcRenderer.on('fixture:dispatch', async (_event: any, request: any) => {
  fixture.dispatches.push({ operationKey: request.sendOperationKey, handoffId: request.handoffId });
  try {
    const result = await sendAgentPromptScenario({ ...request,
      runtime: getHistoryAgentRuntime(request.toolType), settingsIntent: { kind: 'none' } });
    ipcRenderer.send('fixture:dispatch-result', { operationKey: request.sendOperationKey, result });
  } catch (error: any) {
    fixture.errors.push(String(error?.stack || error));
    ipcRenderer.send('fixture:dispatch-result', { operationKey: request.sendOperationKey,
      result: { success: false, submitted: false, error: error?.message || String(error) } });
  }
});
void ipcRenderer.invoke('agent:send-queue-ready', true);

useUIStore.setState({ terminalHistoryStreamingEnabled: true, historyFontSize: 15,
  promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, openProjects: new Map([[projectId, {
  projectId, projectPath: cwd, tabs: new Map(providers.map(provider => [tabIdFor(provider), {
    id: tabIdFor(provider), name: provider + ' streaming queue', cwd, commandType: provider,
    tabType: 'file', aiBusy: true, [provider + 'SessionId']: sessionFor(provider),
}])), activeTabId: tabIdFor('codex'), currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  tabHistory: providers.map(tabIdFor), tabOrder: providers.map(tabIdFor),
}]]) } as any);
for (const provider of providers) useUIStore.getState().setHistoryPromptDraft(tabIdFor(provider), '', { chips: [], images: [] });

fixture.attach = async () => {
  const path = await ipcRenderer.invoke('fixture:image-path');
  const tabId = tabIdFor(fixture.active);
  useUIStore.getState().setHistoryPromptDraft(tabId, '[Image #1] ', {
    images: [{ id: 1, path, mediaType: 'image/png', availability: 'available' }],
    chips: [{ id: 'queue-context-' + fixture.active, kind: 'prompt', label: 'Queue context snapshot',
      text: 'IMMUTABLE QUEUE CONTEXT ' + fixture.active }],
  });
};

function Fixture() {
  const [provider, setProvider] = useState<'codex' | 'claude'>('codex');
  const [mounted, setMounted] = useState(true);
  const [generation, setGeneration] = useState(0);
  const select = (next: 'codex' | 'claude') => {
    fixture.active = next; setProvider(next); setMounted(true);
    useWorkspaceStore.getState().switchTab(projectId, tabIdFor(next));
  };
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#1a1a1a' }}>
    <header style={{ height: 38, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', flexShrink: 0 }}>
      <strong>Private application queue · {provider} · streaming</strong>
      {providers.map(item => <button key={item} data-fixture-provider={item} onClick={() => select(item)}>{item}</button>)}
      <button data-fixture-hide onClick={() => setMounted(value => !value)}>{mounted ? 'Hide History' : 'Show History'}</button>
      <button data-fixture-remount onClick={() => setGeneration(value => value + 1)}>Remount History</button>
      <button data-fixture-attach onClick={() => void fixture.attach()}>Attach fixture image + context</button>
    </header>
    <div style={{ position: 'relative', minHeight: 0, flex: 1 }}>
      {mounted && <HistoryPanel key={provider + generation} tabId={tabIdFor(provider)} projectId={projectId}
        sessionId={sessionFor(provider)} cwd={cwd} width={1000} notesPanelWidth={0}
        isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType={provider}
        presented preservePresentationGeometry onInitialSourceSignal={detail => {
          if (detail.phase === 'load' && detail.status === 'success') fixture.ready[provider] = true;
        }} />}
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
