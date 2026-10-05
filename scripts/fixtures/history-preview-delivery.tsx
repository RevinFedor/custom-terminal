import { ipcRenderer } from 'electron';
import '@noted/claude-blocks/styles.css';
import { mountHistoryPreviewFixture } from './history-preview-reading';

const f = mountHistoryPreviewFixture({ provider: 'codex' });
const startedAt = Date.now();
let previewSeq = 0;
const envelope = { tabId: f.tabId, sessionId: f.sessionId, toolType: 'codex' };
const previewId = `${f.id}-preview`;
const text = 'Completed fragment245: ' + 'Unconfirmed response. '.repeat(10);
const activeText = 'Current response from the next same-turn request.';
const held = { itemId: 'held-291', requestId: 'request-291', text,
  phase: 'settled', deliveryState: 'unknown' };
const emit = (segments: any[], phase = 'streaming') => ipcRenderer.emit('agent-transcript:terminal-preview', {}, {
  ...envelope, action: phase === 'settled' ? 'settle' : 'update',
  preview: { ...envelope, previewId, phase, responseSegments: segments,
    text: segments.map(s => s.text).join('\n\n'), previewSeq: ++previewSeq, startedAt,
    updatedAt: Date.now(), lifecycleGeneration: f.id, mirrorGeneration: f.id,
    mirrorGenerationOrdinal: 1, committedFrameGeneration: 1, writeSeq: previewSeq,
    textHash: null, sourceMode: 'semantic', reason: 'controlled-delivery-fixture' },
});
const canonicalIdentity = `codex-assistant-source-${f.sessionId}-245`;
const canonicalUuid = `${f.id}-canonical245`;
(window as any).fixture = {
  ...f, text, activeText, canonicalIdentity, canonicalUuid,
  held() { emit([held], 'settled'); },
  continued() { emit([held, { itemId: 'active-293', requestId: 'request-293', text: activeText,
    phase: 'streaming', deliveryState: 'pending' }]); },
  completed() { emit([held, { itemId: 'active-293', requestId: 'request-293', text: activeText,
    phase: 'settled', deliveryState: 'pending' }]); },
  async adopt() {
    ipcRenderer.emit('agent-transcript:live-message', {}, { ...envelope,
      timestamp: new Date().toISOString(), message: { type: 'assistant', uuid: canonicalUuid,
        sourceIdentity: canonicalIdentity, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
    ipcRenderer.emit('agent-transcript:terminal-preview', {}, {
      ...envelope, action: 'clear', previewId, reason: 'canonical-materialized', canonicalIdentity,
    });
    await f.appendDurable([{ uuid: canonicalUuid, role: 'assistant', content: text,
      sourceIdentity: canonicalIdentity, timestamp: new Date().toISOString() }]);
  },
  ready: true,
};
