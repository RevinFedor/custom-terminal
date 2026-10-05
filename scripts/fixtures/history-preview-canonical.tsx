import { ipcRenderer } from 'electron';
import '@noted/claude-blocks/styles.css';
import { mountHistoryPreviewFixture } from './history-preview-reading';

const text = 'Это наш баг, а не реальная смена чата. Нашёл две причины:\n\n- При холодном запуске desktop терял ID процесса и ошибочно отклонял Send.\n- `/compact` через API отклонялся ещё до проверки Main, когда Codex уже готов, но writer ID пока не подтверждён.\n\nИсправил оба пути и зависание квитанции в `preparing`. Прошли 166 Main + 59 renderer проверок и сборка. Защита от чужой сессии и Stop сохранена.\n\nПредпросмотр картинки 4944 тоже исправлен и проверен; результат получил владелец iOS.\n\nИзменения пока **в исходниках — нужен Build Install**. Сам приложение не переустанавливал, сообщения и `/compact` повторно не отправлял.';
const f = mountHistoryPreviewFixture({ provider: 'codex', payloadGeneration: 'fixture-source-before-refresh' });
const envelope = { tabId: f.tabId, sessionId: f.sessionId, toolType: 'codex' };
const previewId = `${f.id}-preview`;
const canonicalIdentity = `codex-assistant-source-${f.sessionId}-829539335`;
const canonicalUuid = `codex-assistant-${f.sessionId}-77315`;
const { createHash } = window.require('node:crypto');
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const startedAt = Date.now();
const trace: string[] = [];
let canonicalText = text;
let payloadGeneration = 'fixture-source-before-refresh';
let seq = 239;
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, payload: any, ...args: any[]) => {
  const result = await invoke(channel, payload, ...args);
  if (payload?.sessionId === f.sessionId
    && ['agent-transcript:get-history', 'claude:get-full-history'].includes(channel)) {
    return { ...result, payloadGeneration };
  }
  return result;
};
const preview = (segments = [{ itemId: 'item-617', requestId: 'codex-713', text,
  phase: 'streaming', deliveryState: 'pending' }]) => {
  trace.push('preview');
  ipcRenderer.emit('agent-transcript:terminal-preview', {}, { ...envelope, action: 'update',
    preview: { ...envelope, previewId, turnId: 'fixture-canonical-turn', phase: 'streaming',
      responseSegments: segments, text: segments.map(s => s.text).join('\n\n'),
      textHash: hash(segments.map(s => s.text).join('\n\n')), previewSeq: ++seq,
      lifecycleGeneration: f.id, mirrorGeneration: f.id, mirrorGenerationOrdinal: 1,
      committedFrameGeneration: 1786, writeSeq: 3136, sourceMode: 'semantic',
      startedAt, updatedAt: Date.now() } });
};
(window as any).fixture = { ...f, text, canonicalIdentity, canonicalUuid, previewId, trace,
  preview,
  receipt() {
    trace.push('canonical-receipt');
    ipcRenderer.emit('agent-transcript:terminal-preview', {}, { ...envelope,
      action: 'clear', previewId, reason: 'canonical-materialized', canonicalIdentity,
      canonicalTextHash: hash(text), canonicalSourceEndOffset: 829541057 });
  },
  canonical() {
    trace.push('canonical-live-row');
    ipcRenderer.emit('agent-transcript:live-message', {}, { ...envelope, recordByteOffset: 829539335,
      timestamp: new Date().toISOString(), message: { type: 'assistant', uuid: `${f.id}-live-617`,
        sourceIdentity: canonicalIdentity, semanticItemId: 'item-617',
        message: { role: 'assistant', content: [{ type: 'text', text: canonicalText }] } } });
  },
  responseEnd() { trace.push('response-end'); },
  taskComplete() { trace.push('task-complete'); f.setBusy(false); },
  async durable() {
    trace.push('durable-refresh');
    payloadGeneration = 'fixture-source-generation';
    await f.appendDurable([{ uuid: canonicalUuid, role: 'assistant', content: canonicalText,
      sourceIdentity: canonicalIdentity, sourceSessionId: f.sessionId,
      recordByteOffset: 829539335, timestamp: new Date().toISOString() }], { replaceSameUuid: true });
  },
  wrongCanonicalBody() { canonicalText = 'Different response reusing this positional offset'; },
  correctCanonicalBody() { canonicalText = text; },
  unrelatedItems() { preview([
    { itemId: 'unconfirmed-245', requestId: 'other-request', text: 'Unconfirmed prior response remains available.', phase: 'settled', deliveryState: 'unknown' },
    { itemId: 'new-live', requestId: 'new-request', text: 'A new response is really streaming.', phase: 'streaming', deliveryState: 'pending' },
  ]); },
  destroy() { f.destroy(); ipcRenderer.invoke = invoke; },
  ready: true,
};
