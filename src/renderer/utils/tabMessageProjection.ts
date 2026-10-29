import { isRequestSuccessPresentation } from './requestTrackerVisibility.mjs';

export type TabMessageDelivery = 'pending' | 'sending' | 'queued' | 'sent' | 'waiting-for-input' | 'unconfirmed' | 'failed';
export type TabMessageTimestamp = string | number;

export type TabMessage = {
  messageId: string;
  kind: 'question' | 'reply';
  replyTo?: string | null;
  replyToIds?: string[];
  sourceTabId: string;
  sourceTabName?: string | null;
  sourceProjectId?: string | null;
  sourceSessionId?: string | null;
  targetTabId: string;
  targetTabName?: string | null;
  targetProjectId?: string | null;
  targetSessionId?: string | null;
  text?: string;
  textPreview?: string;
  textChars?: number;
  createdAt: TabMessageTimestamp;
  updatedAt: TabMessageTimestamp;
  deliveryState: TabMessageDelivery;
  error?: string | null;
  code?: string | null;
  replyMessageId?: string | null;
  answeredAt?: TabMessageTimestamp | null;
  sourceDismissedAt?: TabMessageTimestamp | null;
  targetDismissedAt?: TabMessageTimestamp | null;
  cancelledAt?: TabMessageTimestamp | null;
  cancelledByTabId?: string | null;
  loopWait?: { revision: number; state: string; disposition?: string;
    contract?: string; settlement?: { kind: string; at: number; messageId?: string } | null;
    replyMessageId?: string | null; replyDeliveryState?: TabMessageDelivery | null;
    pendingReturn?: { kind: string; reason: string } | null;
    replyProcessed?: unknown; noticeProcessed?: unknown;
    notice?: { state: string; code?: string | null } } | null;
};

export type TabMessageIndex = Record<string, TabMessage>;
export type MessagePresentation = { label: string; color: string; icon: 'waiting' | 'sending' | 'delivered' | 'error'; spinning: boolean };
export type TabMessageThread = ReturnType<typeof tabMessageThreads>[number];

export function tabMessageTimestamp(value: unknown): number {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

const DELIVERY_ORDER: Record<TabMessageDelivery, number> = { pending: 0, sending: 1, queued: 2, 'waiting-for-input': 3, unconfirmed: 4, failed: 5, sent: 6 };

// Bodies are immutable. A late list/event may fill a missing body, but must
// never roll delivery metadata back after a newer get/event has arrived.
export function mergeTabMessages(current: TabMessageIndex, incoming: TabMessage[]): TabMessageIndex {
  let next = current;
  for (const message of incoming) {
    if (!message?.messageId || (message.kind !== 'question' && message.kind !== 'reply')) continue;
    const previous = next[message.messageId];
    const delta = tabMessageTimestamp(message.updatedAt) - tabMessageTimestamp(previous?.updatedAt);
    // Millisecond timestamps may tie. Only a stronger delivery fact can win
    // that tie; retries can move back to sending with a strictly newer stamp.
    const newer = !previous || delta > 0 || (delta === 0 && DELIVERY_ORDER[message.deliveryState] > DELIVERY_ORDER[previous.deliveryState]);
    // Newer always changes the timestamp or delivery state (or adds a row).
    // Stale/duplicate input may still add independent facts: copy only when it does.
    let candidate = newer ? { ...previous, ...message } : previous;
    const set = <K extends keyof TabMessage>(key: K, value: TabMessage[K]) => {
      if (Object.prototype.hasOwnProperty.call(candidate, key) && Object.is(candidate[key], value)) return;
      if (candidate === previous) candidate = { ...previous };
      candidate[key] = value;
    };
    if (previous?.replyMessageId) set('replyMessageId', previous.replyMessageId);
    else if (message.replyMessageId) set('replyMessageId', message.replyMessageId);
    if (previous?.answeredAt) set('answeredAt', previous.answeredAt);
    else if (message.answeredAt) set('answeredAt', message.answeredAt);
    if (previous?.sourceDismissedAt) set('sourceDismissedAt', previous.sourceDismissedAt);
    if (previous?.targetDismissedAt) set('targetDismissedAt', previous.targetDismissedAt);
    const cancellation = previous?.cancelledAt ? previous : message.cancelledAt ? message : null;
    if (cancellation) {
      set('cancelledAt', cancellation.cancelledAt);
      set('cancelledByTabId', cancellation.cancelledByTabId);
    }
    if ((message.loopWait?.revision ?? -1) > (previous?.loopWait?.revision ?? -1)) set('loopWait', message.loopWait);
    else if (previous?.loopWait) set('loopWait', previous.loopWait);
    if (typeof previous?.text === 'string') set('text', previous.text);
    else if (typeof message.text === 'string') set('text', message.text);
    if (candidate !== previous) {
      if (next === current) next = { ...current };
      next[message.messageId] = candidate;
    }
  }
  return next;
}

export function tabMessageThreads(messages: TabMessageIndex, tabId: string) {
  const all = Object.values(messages);
  const replies = new Map(all.filter(m => m.kind === 'reply').flatMap(m => (m.replyToIds || [m.replyTo]).filter(Boolean).map(id => [id, m] as const)));
  return all.filter(m => m.kind === 'question' && (m.sourceTabId === tabId || m.targetTabId === tabId))
    .sort((a, b) => tabMessageTimestamp(b.createdAt) - tabMessageTimestamp(a.createdAt) || a.messageId.localeCompare(b.messageId))
    .map(question => {
      const candidate = question.replyMessageId ? messages[question.replyMessageId] : replies.get(question.messageId);
      const reply = candidate?.kind === 'reply' && (candidate.replyToIds || [candidate.replyTo]).includes(question.messageId) ? candidate : undefined;
      return {
        question, reply,
        incoming: question.targetTabId === tabId,
        answerAvailable: Boolean(reply || question.replyMessageId || question.answeredAt),
      };
    });
}

export function tabMessageDelivery(message: TabMessage): MessagePresentation {
  if (message.cancelledAt && message.deliveryState !== 'sent') return {
    label: message.deliveryState === 'queued' || message.deliveryState === 'unconfirmed' || message.deliveryState === 'sending'
      ? 'Отменено · прежняя доставка не подтверждена' : 'Отменено',
    color: '#a1a1aa', icon: 'waiting', spinning: false,
  };
  switch (message.deliveryState) {
    case 'sent': return { label: 'Доставлено', color: '#4ade80', icon: 'delivered', spinning: false };
    case 'sending': return { label: 'Отправка', color: '#60a5fa', icon: 'sending', spinning: true };
    case 'pending': return { label: 'Ожидает отправки', color: '#a1a1aa', icon: 'waiting', spinning: false };
    case 'queued': return { label: 'В очереди', color: '#a1a1aa', icon: 'waiting', spinning: false };
    case 'waiting-for-input': return { label: 'Доставка ждёт ввода', color: '#fbbf24', icon: 'error', spinning: false };
    case 'unconfirmed': return { label: 'Доставка не подтверждена', color: '#fbbf24', icon: 'error', spinning: false };
    case 'failed': return { label: 'Ошибка доставки', color: '#f87171', icon: 'error', spinning: false };
  }
}

export function tabMessageQuestionLabel(question: TabMessage, answerAvailable: boolean): string {
  if (question.deliveryState !== 'sent') return tabMessageDelivery(question).label;
  return answerAvailable || question.cancelledAt ? 'Доставлено' : 'Доставлено · ждёт ответа';
}

export function tabMessageDismissed(question: TabMessage, tabId: string): boolean {
  return Boolean(question.cancelledAt || (question.sourceTabId === tabId ? question.sourceDismissedAt : question.targetDismissedAt));
}

export function tabMessagePeer(thread: TabMessageThread) {
  return thread.incoming ? thread.question : {
    sourceTabId: thread.question.targetTabId,
    sourceTabName: thread.question.targetTabName,
    sourceProjectId: thread.question.targetProjectId,
  };
}

export function tabMessageReplyPresentation(thread: TabMessageThread): MessagePresentation {
  const wait = !thread.incoming ? thread.question.loopWait : null;
  const replyDelivery = thread.reply?.deliveryState || wait?.replyDeliveryState;
  if (replyDelivery === 'sent') return { label: 'Ответ доставлен', color: '#4ade80', icon: 'delivered', spinning: false };
  if (wait && !['cancelled', 'source-replaced'].includes(wait.state)) {
    if (wait.state === 'settled' && thread.answerAvailable) return {
      label: wait.disposition === 'reply_delivery_failed' ? 'Ошибка доставки ответа · исход сохранён'
        : 'Доставка ответа не подтверждена · исход сохранён', color: '#fbbf24', icon: 'error', spinning: false,
    };
    if (wait.notice && !thread.reply) return {
      label: wait.disposition === 'question_delivery_failed' ? 'Ошибка доставки · исход сохранён' : 'Срок ответа истёк · исход сохранён',
      color: '#fbbf24', icon: 'error', spinning: false,
    };
  }
  if (thread.reply) return tabMessageDelivery(thread.reply);
  if (thread.question.cancelledAt) return { label: 'Ожидание отменено', color: '#a1a1aa', icon: 'waiting', spinning: false };
  return { label: thread.answerAvailable ? 'Ответ сохранён; доставка уточняется' : 'Ожидает ответа',
    color: '#999', icon: 'waiting', spinning: false };
}

export function tabMessagePresentation(thread: TabMessageThread): MessagePresentation {
  return thread.question.deliveryState !== 'sent'
    ? tabMessageDelivery(thread.question)
    : tabMessageReplyPresentation(thread);
}

// Both header and Reply stage describe transport, never the source's own turn.
export function tabMessageReplyDelivery(thread: TabMessageThread): MessagePresentation {
  const state = thread.reply?.deliveryState || thread.question.loopWait?.replyDeliveryState;
  return state === 'sent'
    ? { label: 'Ответ доставлен', color: '#4ade80', icon: 'delivered', spinning: false }
    : tabMessageReplyPresentation(thread);
}

export function tabMessageSuccessAt(thread: TabMessageThread): number | null {
  if (thread.question.deliveryState !== 'sent'
    || (thread.reply?.deliveryState || thread.question.loopWait?.replyDeliveryState) !== 'sent') return null;
  // A reply's sent timestamp is frozen by the service. Question.updatedAt also
  // changes when either participant dismisses, so it is not the reply time.
  return tabMessageTimestamp(thread.reply?.updatedAt) || tabMessageTimestamp(thread.reply?.createdAt)
    || (thread.question.loopWait?.settlement?.kind === 'reply-delivered' ? thread.question.loopWait.settlement.at : null);
}

export function tabMessageVisibleInTracker(thread: TabMessageThread, tabId: string): boolean {
  if (tabMessageDismissed(thread.question, tabId)) return false;
  return !isRequestSuccessPresentation(tabMessagePresentation(thread));
}
