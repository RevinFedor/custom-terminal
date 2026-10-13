import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { beginHistoryPromptHandoff, settleHistoryPromptHandoff } from '../../src/renderer/utils/historyPromptHandoffs';
import { restoreComposerDraftFromHistoryPresentation, serializeComposerDraft } from '../../src/renderer/utils/composerChips.mjs';
import { installUIActionDiagnostics, captureUIAction, createUIClipboardOutcomeQueue } from '../../src/renderer/utils/uiPerformanceDiagnostics.mjs';
import { armComposerClipboardOracle } from '../../src/renderer/utils/composerClipboardDiagnostics.mjs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer, clipboard } = window.require('electron');
const tabId = 'copy-replay-private-tab', projectId = 'copy-replay-private-project';
const sessionId = 'copy-replay-private-session', cwd = '/synthetic-copy-replay';
const updates = [
  { id: 'update-a', title: 'Deferred context A', text: 'First exact context version', kind: 'message', status: 'pending', createdAt: 1 },
  { id: 'update-b', title: 'Deferred context B', text: 'Second exact context version', kind: 'message', status: 'pending', createdAt: 2 },
];
const attached = { id: 'attached-prompt', kind: 'prompt', sourceKey: 'prompt:fixture', label: 'Attached prompt', text: 'Attached instructions' };
const message = 'updated API';
const promptChips = updates.map(update => ({ id: update.id, kind: 'prompt', label: update.title, text: update.text, contextUpdateId: update.id }));
const transport = serializeComposerDraft({ text: message, chips: [...promptChips, attached] });
let context: any = { tabId, responsibility: '', revision: 1, files: [], updates, pendingCount: updates.length };
const fixture: any = (window as any).copyReplayFixture = { ready: false, mode: '', message, transport, trusted: [], calls: [] };
installUIActionDiagnostics({ emit() {}, notify() {} });
fixture.actions = [];
fixture.outcomes=[];
const outcomes=createUIClipboardOutcomeQueue({emit:line=>fixture.outcomes.push(JSON.parse(line.slice(line.indexOf('{'))))});
window.addEventListener('beforeunload',()=>outcomes.dispose(),{once:true});
for (const type of ['click', 'keydown', 'keyup', 'copy', 'cut', 'paste']) document.addEventListener(type, (event: any) => {
  fixture.trusted.push({ type, trusted: event.isTrusted, key: event.key });
  const action=captureUIAction(event);fixture.actions.push(action);
  if(action?.clipboardState)outcomes.enqueue(action,event);
}, true);
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, payload: any, ...rest: any[]) => {
  fixture.calls.push(channel);
  if (channel === 'prompt-queue:save-clipboard-image') return new Promise(resolve => {
    fixture.imageRequestPending = true;
    fixture.finishImage = () => { fixture.imageRequestPending = false; resolve({success:false,error:'fixture-image-import-cancelled'}); };
  });
  if (channel === 'tab-work-context:get') return { success: true, context };
  if (channel === 'agent-transcript:get-history') return { success: true, entries: [
    { uuid: 'previous-answer', role: 'assistant', sessionId, timestamp: new Date(Date.now() - 60000).toISOString(), content: 'Previous response. abc 111.' },
  ], revision: { sources: [{ sessionId, fileIdentity: 'fixture', linkKind: 'end' }] } };
  if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe') return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-activity:get-tab-timing') return { success: true, timing: null };
  if (channel === 'agent-session:get-availability-batch') return { success: true,
    results: (payload.sessions || []).map((s: any) => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  return invoke(channel, payload, ...rest);
};
useUIStore.setState({ terminalHistoryStreamingEnabled: false, historyFontSize: 16, promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, focusedProjectId: projectId,
  openProjects: new Map([[projectId, { projectId, projectPath: cwd,
    tabs: new Map([[tabId, { id: tabId, name: 'Copy replay fixture', cwd, color: 'codex', commandType: 'codex',
      tabType: 'terminal', codexSessionId: sessionId, sessionStatus: 'working', aiBusy: false }]]),
    activeTabId: tabId, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  }]]) } as any);
beginHistoryPromptHandoff({ tabId, handoffId: 'failed-copy', toolType: 'codex', sessionIdHint: sessionId,
  text: transport, promptChips: [attached] as any, authoringText: message, authoringChips: [attached],
  source: 'history-panel', statusAtSend: 'active', submittedAt: Date.now() });
settleHistoryPromptHandoff(tabId, 'failed-copy', { queueStatus: 'failed', reason: 'private-fixture-send-rejected' });
fixture.reset = (mode = 'failed') => flushSync(() => {
  fixture.mode = mode;
  context = { ...context, revision: context.revision + 1,
    updates: mode === 'empty' || mode === 'rewind' ? []
      : updates.map((update, index) => mode === 'revised' && index === 0 ? { ...update, text: 'New context revision' } : update) };
  context.pendingCount = context.updates.length;
  ipcRenderer.emit('tab-work-context:changed', {}, context);
  const restored = mode === 'rewind' ? restoreComposerDraftFromHistoryPresentation({ text: transport, chips: [attached] }) : null;
  useUIStore.getState().setHistoryPromptDraft(tabId, restored?.text || (mode === 'empty' ? '' : 'draft to replace'), {
    chips: restored?.chips || (mode === 'empty' ? [] : [attached]), images: [],
  });
});
fixture.snapshot = () => ({ text: useUIStore.getState().historyPromptDrafts[tabId],
  chips: useUIStore.getState().historyPromptDraftChips[tabId] || [], updates: context.updates });
fixture.plainClipboard = () => clipboard.writeText('ordinary paste');
fixture.armOracle = (step:number)=>armComposerClipboardOracle({runId:'clipboard-canary-private',step});
fixture.bitmapPaste = () => {
  clipboard.writeText('');
  const data = new DataTransfer();
  data.items.add(new File(['private image fixture'], 'fixture.png', {type:'image/png'}));
  document.querySelector('.cm-content[contenteditable="true"]')?.dispatchEvent(new ClipboardEvent('paste',
    { bubbles:true, cancelable:true, clipboardData:data }));
};
fixture.reset();
createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
  <div style={{ height: 40, padding: 8, fontSize: 14 }}>Isolated History Copy replay fixture</div>
  <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
    <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={1000} notesPanelWidth={0}
      isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented preservePresentationGeometry
      onInitialSourceSignal={data => { if (data.phase === 'load' && data.status === 'success') fixture.ready = true; }} />
  </div>
</div>);
