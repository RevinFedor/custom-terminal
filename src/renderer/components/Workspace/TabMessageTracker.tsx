import { useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@noted/claude-blocks';
import { Check, ChevronRight, CircleAlert, CircleCheck, LoaderCircle, MessageSquare, MessageSquareReply, RotateCcw, SendHorizontal, Timer, X } from 'lucide-react';
import { AttachmentPreviewToolbar } from './AIConversation/PastedContentPreview';
import { TabMessageSourceChip } from './TabMessageSourceChip';
import { tabMessageDelivery, tabMessageDismissed, tabMessagePeer, tabMessageReplyPresentation, tabMessagePresentation, tabMessageVisibleInTracker } from '../../utils/tabMessageProjection';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle } from './RequestTrackerRow';
import type { MessagePresentation, TabMessage, TabMessageThread } from '../../utils/tabMessageProjection';
import type { TabMessagesController } from '../../hooks/useTabMessages';

const { ipcRenderer } = window.require('electron');
const iconButton: CSSProperties = { width: 23, height: 23, display: 'grid', placeItems: 'center', flexShrink: 0, padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: '#aaa', cursor: 'pointer' };
const exactText: CSSProperties = { margin: 0, fontFamily: 'inherit', fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' };

function DeliveryIcon({ presentation, header = false }: { presentation: MessagePresentation; header?: boolean }) {
  const Icon = presentation.icon === 'error' ? CircleAlert : presentation.icon === 'delivered' ? header ? CircleCheck : Check : presentation.icon === 'sending' ? LoaderCircle : Timer;
  return <Icon size={header ? 14 : 11} strokeWidth={header ? 2.2 : 2} style={{ flexShrink: 0, color: presentation.color }} className={presentation.spinning ? 'animate-spin noted-infinite-animation' : undefined} />;
}

export type MessageSelection = { messageId: string; anchor: HTMLElement; rect: DOMRect };

export function TabMessageRow({ thread, tabId, onOpen, onDismiss, error, history = false, selected = false }: {
  thread: TabMessageThread; tabId: string; onOpen: (selection: MessageSelection) => void;
  onDismiss?: (messageId: string) => void; error?: string; history?: boolean; selected?: boolean;
}) {
  const { question } = thread;
  const presentation = tabMessagePresentation(thread);
  const stages = [
    { id: 'send', label: 'Send', Icon: SendHorizontal, state: tabMessageDelivery(question), hint: 'Вопрос', delivery: question.deliveryState },
    { id: 'reply', label: 'Reply', Icon: MessageSquareReply, state: tabMessageReplyPresentation(thread), hint: 'Ответ', delivery: thread.reply?.deliveryState || 'waiting' },
  ];
  return <div data-tab-message-row={question.messageId} data-tab-message-history-row={history ? question.messageId : undefined}
    style={{ minWidth: 0, height: 48, flexShrink: 0, borderBottom: '1px solid #303030', boxSizing: 'border-box' }}>
    <RequestTrackerRow actions={onDismiss && !tabMessageDismissed(question, tabId) && <button type="button" data-tab-message-dismiss={question.messageId}
      aria-label="Скрыть карточку переписки" title={error || 'Скрыть карточку; переписка останется в History'}
      onClick={() => onDismiss(question.messageId)} style={{ ...requestRowActionStyle, color: error ? '#f87171' : '#999' }}>
      {error ? <CircleAlert size={13} /> : <X size={13} />}
    </button>}>
      <TabMessageSourceChip source={tabMessagePeer(thread)} variant="row" incoming={thread.incoming} rowColor={presentation.color}
        leadingIcon={<RequestTrackerStatus data-tab-message-status-icon={presentation.icon} title={presentation.label}>
          <DeliveryIcon presentation={presentation} header />
        </RequestTrackerStatus>} />
      {history && <time style={{ color: '#777', fontSize: 9, flexShrink: 0, padding: '0 4px' }}>
        {new Date(question.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>}
    </RequestTrackerRow>
    <div data-request-child-row style={{ height: 20, marginLeft: 18, marginRight: 3, paddingLeft: 6, borderLeft: '1px solid #444', boxSizing: 'border-box' }}>
    <button type="button" data-tab-message-open={question.messageId}
      aria-label="Открыть переписку" aria-haspopup="dialog" aria-expanded={selected}
      aria-controls={selected ? 'tab-message-preview-' + question.messageId : undefined}
      title={stages.map(stage => stage.hint + ': ' + stage.state.label).join('. ')}
      onClick={event => {
        const anchor = event.currentTarget.closest('[data-tab-message-row]') as HTMLElement;
        onOpen({ messageId: question.messageId, anchor, rect: anchor.getBoundingClientRect() });
      }}
      onMouseEnter={event => { event.currentTarget.style.background = '#343434'; }}
      onMouseLeave={event => { event.currentTarget.style.background = selected ? '#303030' : '#242424'; }}
      style={{ width: '100%', minWidth: 0, height: 20, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'center', gap: 3,
        border: 0, borderRadius: 3, padding: '0 4px', fontSize: 9, lineHeight: 1, background: selected ? '#303030' : '#242424', color: '#aaa', cursor: 'pointer' }}>
      {stages.map(({ id, label, Icon, state, hint, delivery }) => <span key={id}
        data-tab-message-stage={id} data-tab-question-delivery={id === 'send' ? delivery : undefined} data-tab-reply-delivery={id === 'reply' ? delivery : undefined}
        aria-label={hint + ': ' + state.label}
        style={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: state.color }}>
        <Icon size={11} style={{ flexShrink: 0 }} /><span>{label}</span>
      </span>)}
    </button>
    </div>
  </div>;
}

function MessageBody({ message, label, onNavigate }: { message: TabMessage; label: string; onNavigate: () => void }) {
  const delivery = tabMessageDelivery(message);
  return <details data-tab-message-body={message.messageId} style={{ minWidth: 0, borderTop: '1px solid #303030' }}>
    <summary style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 34, padding: '4px 10px', cursor: 'pointer', listStyle: 'none' }}>
      <ChevronRight size={12} className="tab-message-disclosure" />
      <strong style={{ flex: 1, fontSize: 11 }}>{label}</strong>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: delivery.color, fontSize: 10 }}><DeliveryIcon presentation={delivery} />{delivery.label}</span>
    </summary>
    <div style={{ padding: '0 10px 10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <div style={{ flex: 1, minWidth: 0 }}><TabMessageSourceChip source={message} onNavigate={onNavigate} /></div>
        {typeof message.text === 'string' && <AttachmentPreviewToolbar text={message.text} />}
      </div>
      <div style={{ fontSize: 10, color: '#999', overflowWrap: 'anywhere', marginBottom: 6 }}>Кому: {message.targetTabName || message.targetTabId}</div>
      {(message.error || message.code) && <div role="status" style={{ ...exactText, color: '#fca5a5', marginBottom: 7 }}>{[message.code, message.error].filter(Boolean).join(': ')}</div>}
      {typeof message.text === 'string' ? <div data-tab-message-text={message.messageId} style={{ fontSize: 11, overflowWrap: 'anywhere', userSelect: 'text' }}><Markdown text={message.text} /></div> : <div style={{ color: '#999', fontSize: 11 }}>Текст ещё не загружен</div>}
      <details style={{ marginTop: 8, fontSize: 9, color: '#999', overflowWrap: 'anywhere' }}>
        <summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <dl style={{ display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr)', gap: '4px 6px', margin: '6px 0 0' }}>
          {Object.entries({ messageId: message.messageId, replyTo: message.replyTo, sourceTabId: message.sourceTabId, sourceSessionId: message.sourceSessionId, targetTabId: message.targetTabId, targetSessionId: message.targetSessionId, createdAt: message.createdAt }).map(([key, value]) => (
            <div key={key} style={{ display: 'contents' }}><dt>{key}</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{value == null ? '-' : String(value)}</dd></div>
          ))}
        </dl>
      </details>
    </div>
  </details>;
}

export function TabMessageTracker({ tabId, controller, onOpen, onDismiss, selectedMessageId, now = Date.now() }: {
  tabId: string; controller: TabMessagesController; onOpen: (selection: MessageSelection) => void;
  onDismiss: (messageId: string) => void; selectedMessageId?: string; now?: number;
}) {
  const visible = controller.threads.filter(thread => tabMessageVisibleInTracker(thread, tabId, now));
  if (!visible.length && !controller.listError) return null;
  return <div data-tab-message-tracker style={{ width: '100%', minWidth: 0, flexShrink: 0, color: '#d4d4d4' }}>
    {controller.listError && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 5, fontSize: 10, color: '#fbbf24' }}>
      <span title={controller.listError} style={{ flex: 1 }}>Сообщения недоступны</span>
      <button type="button" aria-label="Обновить сообщения" onClick={controller.reload} style={iconButton}><RotateCcw size={12} /></button>
    </div>}
    {visible.map(thread => <TabMessageRow key={thread.question.messageId} thread={thread} tabId={tabId} onOpen={onOpen}
      onDismiss={onDismiss} selected={selectedMessageId === thread.question.messageId} error={controller.actionErrors[thread.question.messageId]} />)}
  </div>;
}

export function TabMessagePreview({ selection, thread, controller, onClose, previewRef }: {
  selection: MessageSelection; thread: TabMessageThread; controller: TabMessagesController; onClose: () => void;
  previewRef: RefObject<HTMLElement | null>;
}) {
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const [retry, setRetry] = useState(0);
  const { messageId, anchor, rect } = selection;
  const { merge } = controller;
  const replyId = thread.question.replyMessageId || thread.reply?.messageId || '';
  useEffect(() => {
    let alive = true;
    setReading(true);
    setReadError('');
    void ipcRenderer.invoke('tab-messages:get', { messageId }).then((result: { message: TabMessage; reply?: TabMessage | null }) => {
      if (result?.message?.messageId !== messageId || result.message.kind !== 'question') throw new Error('Вопрос не найден');
      if (result.reply && (result.reply.kind !== 'reply' || result.reply.replyTo !== messageId)) throw new Error('Ответ относится к другому вопросу');
      if (typeof result.message.text !== 'string' || (result.reply && typeof result.reply.text !== 'string')) throw new Error('Полный текст сообщения недоступен');
      if (alive) merge([result.message, ...(result.reply ? [result.reply] : [])]);
    }).catch((error: unknown) => {
      if (alive) setReadError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (alive) setReading(false); });
    return () => { alive = false; };
  }, [messageId, replyId, thread.question.answeredAt, retry, merge]);

  useLayoutEffect(() => {
    const reposition = () => {
      const target = anchor.isConnected ? anchor.getBoundingClientRect() : rect;
      const parent = anchor.closest('[data-orchestration-history-panel]')?.getBoundingClientRect() || target;
      const preview = previewRef.current?.getBoundingClientRect();
      if (!preview) return;
      const left = parent.left >= preview.width + 14 ? parent.left - preview.width - 6 : parent.right + 6;
      setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - preview.width - 8)), top: Math.max(8, Math.min(target.top, window.innerHeight - preview.height - 8)) });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (previewRef.current) observer.observe(previewRef.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [anchor, rect, previewRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !previewRef.current?.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('mousedown', onMouseDown); };
  }, [anchor, onClose, previewRef]);

  return createPortal(<aside ref={previewRef} id={'tab-message-preview-' + messageId} data-tab-message-preview={messageId} role="dialog" aria-label="Вопрос и ответ"
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    style={{ position: 'fixed', ...position, zIndex: 220, width: 310, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(520px, calc(100vh - 16px))', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#151515', color: '#d4d4d4', border: '1px solid #444', borderRadius: 6, boxShadow: '0 10px 28px rgba(0,0,0,0.44)', pointerEvents: 'auto' }}>
    <style>{'[data-tab-message-body][open] > summary .tab-message-disclosure { transform: rotate(90deg); }'}</style>
    <div style={{ display: 'flex', alignItems: 'center', padding: '4px 6px 4px 10px', gap: 6, flexShrink: 0 }}>
      <MessageSquare size={13} color="#93c5fd" /><strong style={{ flex: 1, fontSize: 11 }}>Вопрос и ответ</strong>
      <button type="button" aria-label="Закрыть вопрос и ответ" title="Закрыть" onClick={onClose} style={iconButton}><X size={14} /></button>
    </div>
    <div className="scrollbar-thin" style={{ overflowY: 'auto', minHeight: 0 }}>
      {reading && <div role="status" style={{ padding: '4px 10px', fontSize: 10, color: '#999' }}>Загрузка текста...</div>}
      {readError && <div role="alert" style={{ ...exactText, display: 'flex', alignItems: 'center', padding: '4px 10px', gap: 5, color: '#fca5a5' }}><span style={{ flex: 1 }}>{readError}</span><button type="button" aria-label="Повторить загрузку текста" title="Повторить загрузку текста" onClick={() => setRetry(n => n + 1)} style={iconButton}><RotateCcw size={12} /></button></div>}
      <MessageBody key={thread.question.messageId} message={thread.question} label="Вопрос" onNavigate={onClose} />
      {thread.reply ? <MessageBody key={thread.reply.messageId} message={thread.reply} label="Ответ" onNavigate={onClose} /> : <div style={{ padding: '8px 10px', fontSize: 11, color: '#999', borderTop: '1px solid #303030' }}>{thread.answerAvailable ? 'Ответ сохранён; доставка уточняется' : 'Ответа пока нет'}</div>}
    </div>
  </aside>, document.body);
}
