import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '../../src/renderer/styles/globals.css';
import '../../packages/claude-blocks/src/styles.css';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import {
  beginHistoryPromptHandoff, settleHistoryPromptHandoff, getHistoryPromptHandoffsSnapshot,
} from '../../src/renderer/utils/historyPromptHandoffs';

const f = (window as any).__busyFixture;
const { ipcRenderer } = window.require('electron');
const tabId = 'busy-fixture-tab', sessionId = 'busy-fixture-session', projectId = 'busy-fixture-project';
const row = (uuid: string, role: string, content: string, offset: number) => ({
  uuid, role, content, sessionId, recordByteOffset: offset,
  timestamp: new Date(1_800_000_000_000 + offset).toISOString(),
  sourceIdentity: `codex-${role}-source-${sessionId}-${offset}`,
});
f.entries = [row('base', 'user', 'ORIGINAL REQUEST', 10)];
useUIStore.setState({ historyFontSize: 16, historyGroupActionsEnabled: false, terminalHistoryStreamingEnabled: true });
useWorkspaceStore.setState({ openProjects: new Map([[projectId, {
  projectId, projectPath: '/fixture', tabs: new Map([[tabId, { id: tabId, name: 'Busy History ordering',
    cwd: '/fixture', commandType: 'codex', tabType: 'file', aiBusy: true, codexSessionId: sessionId }]]),
  activeTabId: tabId, tabGroups: [], currentView: 'terminal', selectedTabIds: [],
} as any]]) });
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId}
  cwd="/fixture" width={900} notesPanelWidth={0} isOpen embedded embeddedFill toolType="codex" presented />));

const texts = { old: 'FAILED EARLIER SEND', accepted: 'ACCEPTED REQUEST', later: 'LATER NOTICE', future: 'FUTURE INPUT' };
const proof = (id: string, offset: number) => ({
  auditTimestamp: new Date(1_800_000_000_000 + offset).toISOString(), actualHash: `hash-${id}`,
  sessionId, entryUuid: `canonical-${id}`, sourceIdentity: `codex-user-source-${sessionId}-${offset}`, recordByteOffset: offset,
});
function begin(id: keyof typeof texts) {
  beginHistoryPromptHandoff({ tabId, handoffId: id, sendAttemptId: `attempt-${id}`,
    sendOperationKey: `operation-${id}`, toolType: 'codex', sessionIdHint: sessionId,
    text: texts[id], statusAtSend: 'busy' });
}
function accept(id: string, offset: number) {
  settleHistoryPromptHandoff(tabId, id, { queueStatus: 'sent', reason: 'exact-audit',
    sendAttemptId: `attempt-${id}`, sendOperationKey: `operation-${id}`, toolType: 'codex', proof: proof(id, offset) });
}
const answer = row('answer', 'assistant', 'LIVE ANSWER', 200);
Object.assign(f, {
  seed(status: 'failed' | 'cancelled') {
    begin('old'); settleHistoryPromptHandoff(tabId, 'old', { queueStatus: status, reason: 'local-failure' });
    begin('accepted'); accept('accepted', 100);
    begin('later'); accept('later', 300);
    begin('future'); settleHistoryPromptHandoff(tabId, 'future', { queueStatus: 'queued', reason: 'provider-queue' });
    ipcRenderer.emit('agent-transcript:live-message', {}, { tabId, toolType: 'codex', sessionId,
      recordByteOffset: 200, message: { type: 'assistant', uuid: answer.uuid, sourceIdentity: answer.sourceIdentity,
        sessionId, timestamp: answer.timestamp, message: { role: 'assistant', content: [{ type: 'text', text: answer.content }] } } });
    ipcRenderer.emit('agent-transcript:changed', {}, { sessionId, toolType: 'codex', reason: 'fixture-busy-append' });
  },
  promote() { accept('old', 50); },
  finish() {
    f.entries = [f.entries[0], row('canonical-old', 'user', texts.old, 50),
      row('canonical-accepted', 'user', texts.accepted, 100), answer, row('canonical-later', 'user', texts.later, 300)];
    useWorkspaceStore.setState(state => {
      const projects = new Map(state.openProjects), project = projects.get(projectId)!;
      const tabs = new Map(project.tabs); tabs.set(tabId, { ...tabs.get(tabId)!, aiBusy: false });
      projects.set(projectId, { ...project, tabs }); return { openProjects: projects };
    });
    ipcRenderer.emit('agent-transcript:changed', {}, { sessionId, toolType: 'codex', reason: 'fixture-durable' });
  },
  snapshot() {
    const panel = document.querySelector('[data-history-session]')!;
    return { session: panel.getAttribute('data-history-session'),
      texts: Array.from(panel.querySelectorAll('[data-history-row-real]')).map(el => el.textContent),
      handoffs: getHistoryPromptHandoffsSnapshot(tabId).map(h => ({ id: h.handoffId, status: h.queueStatus })),
      busy: useWorkspaceStore.getState().openProjects.get(projectId)!.tabs.get(tabId)!.aiBusy,
      calls: f.calls, violations: f.violations };
  },
});
