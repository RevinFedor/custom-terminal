import React from 'react';
import { createRoot } from 'react-dom/client';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { mountHistoryPreviewFixture } from './history-preview-reading';
import '../../packages/claude-blocks/src/blocks.css';
const f = mountHistoryPreviewFixture();
const { ipcRenderer } = window.require('electron');
const rows: any[] = [
  { uuid: 'mcp-plain', content: 'Continue the existing source check', semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] },
  { uuid: 'ordinary-quote', content: '[Tab message: reply] This is an ordinary quoted example.' },
  { uuid: 'mcp-question', content: 'Question from another tab', semanticTags: [{ kind: 'tab-message', messageId: 'Q', phase: 'question', sourceTabId: 'source', sourceTabName: 'state terminal - fork / rewind with a long source name', targetTabId: f.tabId }] },
  { uuid: 'ordinary-separator', content: 'Normal user question' },
  { uuid: 'mcp-reply', content: 'Answer from another tab', semanticTags: [{ kind: 'tab-message', messageId: 'R', replyTo: 'Q', phase: 'reply', sourceTabId: 'source', sourceTabName: 'state terminal - fork / rewind with a long source name', targetTabId: f.tabId }] },
].map((row, index) => ({ ...row, role: 'user', type: 'user', sessionId: f.sessionId,
  timestamp: new Date(Date.now() + index).toISOString() }));
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = (channel: string, payload: any, ...args: any[]) => {
  if (channel === 'agent-transcript:get-timeline' && payload.sessionId === f.sessionId) return Promise.resolve({ success: true, entries: rows });
  if (channel === 'tab-work-context:get' && payload.tabId === f.tabId) return Promise.resolve({ success: true,
    context: { tabId: f.tabId, revision: 1, responsibility: '', files: [], updates: [], pendingCount: 0 } });
  return invoke(channel, payload, ...args);
};
const rail = document.createElement('div');
Object.assign(rail.style, { position: 'fixed', right: '0', top: '70px', bottom: '30px', width: '32px', zIndex: '100001' });
document.body.appendChild(rail);
const root = createRoot(rail);
root.render(<Timeline tabId={f.tabId} sessionId={f.sessionId} cwd="/tmp" toolType="codex"
  isOpen isVisible isActive={false} isTurnBusy={false} historySurfaceVisible readOnly backgroundPrewarmAdmitted />);
(window as any).fixture = { ...f, ready: false, rows,
  resize: (width: number) => { f.host.style.width = Math.min(620, width - 40) + 'px'; },
  destroy: () => { root.unmount(); rail.remove(); f.destroy(); } };
void f.appendDurable(rows).then(() => { (window as any).fixture.ready = true; });
