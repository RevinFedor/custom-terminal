import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { TabProcessBar } from '../../src/renderer/components/Workspace/TabSignals';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';
import '../../src/renderer/styles/presentationAnimations.css';

const { ipcRenderer } = window.require('electron');
const tabId = 'r04-input-private', projectId = 'r04-project-private', sessionId = 'r04-session-private';
const cwd = '/synthetic-r04-input', startTs = Date.now() - 80000;
const fixture: any = (window as any).r04Input = { ready: false, calls: [], input: [], eventTiming: [], measureFrom: Infinity, supported: PerformanceObserver.supportedEntryTypes };
for (const type of ['pointerdown', 'click', 'keydown', 'keyup', 'input']) document.addEventListener(type, (event: any) => {
  if (!event.isTrusted) return;
  const received = performance.now();
  if (received < fixture.measureFrom) return;
  fixture.input.push({ type, key: event.key, trusted: true, timestamp: event.timeStamp, received,
    deliveryMs: received - event.timeStamp, editor: !!event.target?.closest?.('.cm-editor') });
}, { capture: true });
if (PerformanceObserver.supportedEntryTypes.includes('event')) {
  new PerformanceObserver(list => {
    for (const event of list.getEntries() as any) if (event.startTime >= fixture.measureFrom) fixture.eventTiming.push({
      name: event.name, startTime: event.startTime, duration: event.duration,
      processingStart: event.processingStart, processingEnd: event.processingEnd,
      interactionId: event.interactionId,
      inputDelayMs: event.processingStart - event.startTime,
      handlerMs: event.processingEnd - event.processingStart,
      presentationMs: event.startTime + event.duration - event.processingEnd,
    });
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as any);
}
const entries = Array.from({ length: 30 }, (_, i) => ({ uuid: 'r04-entry-' + i, role: i % 2 ? 'assistant' : 'user',
  sessionId, timestamp: new Date(startTs - (30 - i) * 1000).toISOString(),
  content: i % 2 ? 'A retained response with **formatting** and ordinary text.\n\nNo provider is running in this private fixture.' : 'Synthetic request ' + i }));
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, payload: any, ...rest: any[]) => {
  fixture.calls.push(channel);
  if (channel === 'agent-transcript:get-history') return { success: true, entries, revision: { sources: [{ sessionId, fileIdentity: 'r04', linkKind: 'end' }] } };
  if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe') return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-activity:get-tab-timing') return { success: true, timing: {
    state: 'running', intervalId: 1, toolType: 'codex', sessionId, startTs, endTs: null, durationMs: null } };
  if (channel === 'tab-work-context:get') return { success: true, context: { tabId, responsibility: '', revision: 1, files: [], updates: [], pendingCount: 0 } };
  if (channel === 'agent-session:get-availability-batch') return { success: true,
    results: (payload.sessions || []).map((session: any) => ({ ...session, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  return invoke(channel, payload, ...rest);
};
useUIStore.setState({ terminalHistoryStreamingEnabled: false, historyFontSize: 16, promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, focusedProjectId: projectId,
  openProjects: new Map([[projectId, { projectId, projectPath: cwd,
    tabs: new Map([[tabId, { id: tabId, name: 'R04 private input', cwd, color: 'codex', commandType: 'codex',
      tabType: 'terminal', codexSessionId: sessionId, sessionStatus: 'working', aiBusy: true }]]),
    activeTabId: tabId, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  }]]) } as any);
fixture.snapshot = () => ({ draft: useUIStore.getState().historyPromptDrafts[tabId],
  editor: document.querySelector('.cm-content[contenteditable="true"]')?.textContent,
  nodes: document.querySelectorAll('*').length,
  working: document.querySelector('.hp-history-response-tail')?.textContent,
  historyOwner: document.querySelector('[data-history-owner]')?.getAttribute('data-history-owner') });
fixture.clearMeasurements = () => { fixture.measureFrom = performance.now(); fixture.input = []; fixture.eventTiming = []; };

function App() {
  const [hidden, setHidden] = useState(false);
  return <>
    <div className="r04-title" style={{ WebkitAppRegion: 'drag' } as any}>
      <button id="r04-hide" onClick={() => setHidden(value => !value)} style={{ WebkitAppRegion: 'no-drag' } as any}>Hide/show</button>
      {Array.from({ length: 12 }, (_, i) => <span key={i} style={{ position: 'relative', padding: '3px 10px', background: '#24372d', borderRadius: 5 }}>
        task{i}<TabProcessBar busy hasProcess radius={5} />
      </span>)}
    </div>
    <div id="r04-history" data-terminal-pane-wrapper="input-owner" data-terminal-surface-presented={hidden ? '0' : '1'}
      style={{ position: 'absolute', top: 40, bottom: 0, left: 0, right: 0, opacity: hidden ? 0 : 1,
        willChange: 'opacity', pointerEvents: hidden ? 'none' : 'auto' }}>
      <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={1100} notesPanelWidth={0}
        isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented={!hidden} preservePresentationGeometry
        onInitialSourceSignal={data => { if (data.phase === 'load' && data.status === 'success') fixture.ready = true; }} />
    </div>
    <div id="r04-retained" aria-hidden data-terminal-surface-presented="0" data-terminal-pane-wrapper="retained-fixture"
      style={{ position: 'absolute', top: 40, width: 1000, height: 650, overflow: 'hidden', opacity: 0,
        willChange: 'opacity', pointerEvents: 'none' }}>
      {Array.from({ length: 12000 }, (_, i) => <div key={i}><p><b>Retained {i}</b><span> synthetic formatted row </span><code>ready</code></p></div>)}
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
