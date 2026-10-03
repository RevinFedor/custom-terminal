import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@noted/claude-blocks';
import { ArrowDownLeft, ArrowUpRight, Check, CircleAlert, LoaderCircle, MessageSquare, RotateCcw, Timer, X } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { AttachmentPreviewToolbar } from './AIConversation/PastedContentPreview';
import { TabMessageSourceChip } from './TabMessageSourceChip';
import { mergeTabMessages, tabMessageDelivery, tabMessageQuestionLabel, tabMessageThreads } from '../../utils/tabMessageProjection';
import type { MessagePresentation, TabMessage, TabMessageIndex } from '../../utils/tabMessageProjection';

const { ipcRenderer } = window.require('electron');
const iconButton: CSSProperties = { width: 24, height: 24, display: 'grid', placeItems: 'center', flexShrink: 0, padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: '#aaa', cursor: 'pointer' };
const exactText: CSSProperties = { margin: 0, fontFamily: 'inherit', fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' };

function DeliveryIcon({ presentation }: { presentation: MessagePresentation }) {
  const Icon = presentation.icon === 'error' ? CircleAlert : presentation.icon === 'delivered' ? Check : presentation.icon === 'sending' ? LoaderCircle : Timer;
  return <Icon size={12} style={{ flexShrink: 0, color: presentation.color }} className={presentation.spinning ? 'animate-spin' : undefined} />;
}

function MessageBody({ message, label, onNavigate }: { message: TabMessage; label: string; onNavigate: () => void }) {
  const delivery = tabMessageDelivery(message);
  return (
    <section data-tab-message-body={message.messageId} style={{ minWidth: 0, padding: '8px 10px', borderTop: '1px solid #303030' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
        <strong style={{ flex: 1, fontSize: 11 }}>{label}</strong>
        {typeof message.text === 'string' && <AttachmentPreviewToolbar text={message.text} />}
      </div>
      <TabMessageSourceChip source={message} onNavigate={onNavigate} />
      <div style={{ fontSize: 10, color: '#999', overflowWrap: 'anywhere', marginBottom: 6 }}>Кому: {message.targetTabName || message.targetTabId}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: delivery.color, fontSize: 10, marginBottom: 7 }}><DeliveryIcon presentation={delivery} />{delivery.label}</div>
      {(message.error || message.code) && <div role="status" style={{ ...exactText, color: '#fca5a5', marginBottom: 7 }}>{[message.code, message.error].filter(Boolean).join(': ')}</div>}
      {typeof message.text === 'string' ? <div data-tab-message-text={message.messageId} style={{ fontSize: 11, overflowWrap: 'anywhere', userSelect: 'text' }}><Markdown text={message.text} /></div> : <div style={{ color: '#999', fontSize: 11 }}>Текст ещё не загружен</div>}
      <details style={{ marginTop: 8, fontSize: 9, color: '#999', overflowWrap: 'anywhere' }}>
        <summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <dl style={{ display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr)', gap: '4px 6px', margin: '6px 0 0' }}>
          {Object.entries({ messageId: message.messageId, replyTo: message.replyTo, sourceTabId: message.sourceTabId, sourceProjectId: message.sourceProjectId, sourceSessionId: message.sourceSessionId, targetTabId: message.targetTabId, targetProjectId: message.targetProjectId, targetSessionId: message.targetSessionId, createdAt: message.createdAt, updatedAt: message.updatedAt, replyMessageId: message.replyMessageId, answeredAt: message.answeredAt }).map(([key, value]) => (
            <div key={key} style={{ display: 'contents' }}><dt>{key}</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{value == null ? '-' : String(value)}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );
}

type Props = { tabId: string };

// Remount on ownership changes so late reads from a previous tab cannot leak.
export function TabMessageTracker({ tabId }: Props) {
  return <TabMessages key={tabId} tabId={tabId} />;
}

function TabMessages({ tabId }: Props) {
  const [messages, setMessages] = useState<TabMessageIndex>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listError, setListError] = useState('');
  const [readError, setReadError] = useState('');
  const [reading, setReading] = useState(false);
  const [retry, setRetry] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const merge = useCallback((items: TabMessage[]) => setMessages(current => mergeTabMessages(current, items)), []);

  useEffect(() => {
    let alive = true;
    const changed = (_event: unknown, payload: { message?: TabMessage; reason?: string }) => {
      const message = payload?.message;
      if (alive && message && (message.sourceTabId === tabId || message.targetTabId === tabId)) merge([message]);
    };
    ipcRenderer.on('tab-messages:changed', changed);
    void ipcRenderer.invoke('tab-messages:list', { tabId }).then((items: TabMessage[]) => {
      if (!Array.isArray(items)) throw new Error('Некорректный список сообщений');
      if (alive) { merge(items); setListError(''); }
    }).catch((error: unknown) => {
      if (alive) setListError(error instanceof Error ? error.message : String(error));
    });
    return () => { alive = false; ipcRenderer.removeListener('tab-messages:changed', changed); };
  }, [tabId, merge, retry]);

  const threads = useMemo(() => tabMessageThreads(messages, tabId), [messages, tabId]);
  const selected = threads.find(thread => thread.question.messageId === selectedId);
  const replyId = selected?.question.replyMessageId || selected?.reply?.messageId || '';
  const answeredAt = selected?.question.answeredAt;
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    setReading(true);
    setReadError('');
    void ipcRenderer.invoke('tab-messages:get', { messageId: selectedId }).then((result: { message: TabMessage; reply?: TabMessage | null }) => {
      if (result?.message?.messageId !== selectedId || result.message.kind !== 'question') throw new Error('Вопрос не найден');
      if (result.reply && (result.reply.kind !== 'reply' || result.reply.replyTo !== selectedId)) throw new Error('Ответ относится к другому вопросу');
      if (typeof result.message.text !== 'string' || (result.reply && typeof result.reply.text !== 'string')) throw new Error('Полный текст сообщения недоступен');
      if (alive) merge([result.message, ...(result.reply ? [result.reply] : [])]);
    }).catch((error: unknown) => {
      if (alive) setReadError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (alive) setReading(false); });
    return () => { alive = false; };
  }, [selectedId, replyId, answeredAt, retry, merge]);

  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selectedId]);
  useLayoutEffect(() => {
    if (!selectedId) return;
    const reposition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const preview = previewRef.current?.getBoundingClientRect();
      if (!anchor || !preview) return;
      const left = anchor.left >= preview.width + 14 ? anchor.left - preview.width - 6 : anchor.right + 6;
      setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - preview.width - 8)), top: Math.max(8, Math.min(anchor.top, window.innerHeight - preview.height - 8)) });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (previewRef.current) observer.observe(previewRef.current);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedId(null); };
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !previewRef.current?.contains(event.target as Node)) setSelectedId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('mousedown', onMouseDown); };
  }, [selectedId]);

  if (!threads.length && !listError) return null;
  return (
    <div ref={rootRef} data-tab-message-tracker style={{ width: 178, maxWidth: 'calc(100vw - 32px)', flexShrink: 0, maxHeight: 'min(208px, calc(100vh - 110px))', overflowY: 'auto', overflowX: 'hidden', border: '1px solid #444', borderRadius: 5, background: '#171717', color: '#d4d4d4' }}>
      {listError && <div role="alert" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: 5, fontSize: 10, color: '#fbbf24' }}>
        <Tooltip content={listError} always><span style={{ flex: 1 }}>Сообщения недоступны</span></Tooltip>
        <button type="button" aria-label="Обновить сообщения" title="Обновить сообщения" onClick={() => setRetry(n => n + 1)} style={iconButton}><RotateCcw size={12} /></button>
      </div>}
      {threads.map(({ question, reply, incoming, answerAvailable }) => {
        const delivery = tabMessageDelivery(question);
        const peer = incoming ? question.sourceTabName || question.sourceTabId : question.targetTabName || question.targetTabId;
        return <button key={question.messageId} type="button" data-tab-message-row={question.messageId} aria-expanded={selectedId === question.messageId}
          aria-label={`${incoming ? 'Входящий вопрос' : 'Исходящий вопрос'}: ${peer}`}
          onClick={() => setSelectedId(id => id === question.messageId ? null : question.messageId)}
          style={{ width: '100%', display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr)', gap: '3px 5px', padding: '5px 6px', border: 0, borderBottom: '1px solid #303030', background: selectedId === question.messageId ? '#292929' : 'transparent', color: '#d4d4d4', textAlign: 'left', cursor: 'pointer' }}>
          {incoming ? <ArrowDownLeft size={12} color="#93c5fd" /> : <ArrowUpRight size={12} color="#a3a3a3" />}
          <span title={peer} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>{peer}</span>
          {question.textPreview && <span title={question.textPreview} style={{ gridColumn: '1 / 3', fontSize: 9, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{question.textPreview}</span>}
          <DeliveryIcon presentation={delivery} />
          <span data-tab-question-delivery={question.deliveryState} style={{ fontSize: 9, color: delivery.color, overflowWrap: 'anywhere' }}>{tabMessageQuestionLabel(question, answerAvailable)}</span>
          {answerAvailable && <><MessageSquare size={12} color="#4ade80" /><span style={{ color: '#4ade80', fontSize: 9 }}>Ответ доступен</span></>}
          {reply && <><DeliveryIcon presentation={tabMessageDelivery(reply)} /><span data-tab-reply-delivery={reply.deliveryState} style={{ fontSize: 9, color: tabMessageDelivery(reply).color, overflowWrap: 'anywhere' }}>Ответ: {tabMessageDelivery(reply).label.toLowerCase()}</span></>}
        </button>;
      })}
      {selected && createPortal(
        <aside ref={previewRef} data-tab-message-preview={selectedId} role="dialog" aria-label="Вопрос и ответ" onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          style={{ position: 'fixed', ...position, zIndex: 110, width: 310, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(420px, calc(100vh - 16px))', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#151515', color: '#d4d4d4', border: '1px solid #444', borderRadius: 6, boxShadow: '0 10px 28px rgba(0,0,0,0.44)', pointerEvents: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 6px 4px 10px', gap: 6, flexShrink: 0 }}>
            <MessageSquare size={13} color="#93c5fd" /><strong style={{ flex: 1, fontSize: 11 }}>Вопрос и ответ</strong>
            <button type="button" aria-label="Закрыть вопрос и ответ" title="Закрыть" onClick={() => setSelectedId(null)} style={iconButton}><X size={14} /></button>
          </div>
          <div ref={bodyRef} style={{ overflowY: 'auto', minHeight: 0 }}>
            {reading && <div role="status" style={{ padding: '4px 10px', fontSize: 10, color: '#999' }}>Загрузка текста...</div>}
            {readError && <div role="alert" style={{ ...exactText, display: 'flex', alignItems: 'center', padding: '4px 10px', gap: 5, color: '#fca5a5' }}><span style={{ flex: 1 }}>{readError}</span><button type="button" aria-label="Повторить загрузку текста" title="Повторить загрузку текста" onClick={() => setRetry(n => n + 1)} style={iconButton}><RotateCcw size={12} /></button></div>}
            <MessageBody key={selected.question.messageId} message={selected.question} label="Вопрос" onNavigate={() => setSelectedId(null)} />
            {selected.reply ? <MessageBody key={selected.reply.messageId} message={selected.reply} label="Ответ" onNavigate={() => setSelectedId(null)} /> : <div style={{ padding: '8px 10px', fontSize: 11, color: '#999', borderTop: '1px solid #303030' }}>{selected.answerAvailable ? 'Ответ доступен · текст ещё не загружен' : 'Ответа пока нет'}</div>}
          </div>
        </aside>, document.body,
      )}
    </div>
  );
}
