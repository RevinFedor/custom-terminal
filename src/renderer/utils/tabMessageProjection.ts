import { REQUEST_SUCCESS_VISIBLE_MS } from './requestTrackerVisibility.mjs';

export type TabMessageDelivery = 'pending' | 'sending' | 'queued' | 'sent' | 'waiting-for-input' | 'unconfirmed' | 'failed';
export type TabMessageTimestamp = string | number;

export type TabMessage = {
  messageId: string;
  kind: 'question' | 'reply';
  replyTo?: string | null;
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
  const next = { ...current };
  for (const message of incoming) {
    if (!message?.messageId || !['question', 'reply'].includes(message.kind)) continue;
    const previous = next[message.messageId];
    const delta = tabMessageTimestamp(message.updatedAt) - tabMessageTimestamp(previous?.updatedAt);
    // Millisecond timestamps may tie. Only a stronger delivery fact can win
    // that tie; retries can move back to sending with a strictly newer stamp.
    const newer = !previous || delta > 0 || (delta === 0 && DELIVERY_ORDER[message.deliveryState] > DELIVERY_ORDER[previous.deliveryState]);
    next[message.messageId] = {
      ...previous,
      ...(newer ? message : {}),
      ...(previous?.replyMessageId ? { replyMessageId: previous.replyMessageId }
        : message.replyMessageId ? { replyMessageId: message.replyMessageId } : {}),
      ...(previous?.answeredAt ? { answeredAt: previous.answeredAt }
        : message.answeredAt ? { answeredAt: message.answeredAt } : {}),
      ...(previous?.sourceDismissedAt ? { sourceDismissedAt: previous.sourceDismissedAt } : {}),
      ...(previous?.targetDismissedAt ? { targetDismissedAt: previous.targetDismissedAt } : {}),
      ...(typeof previous?.text === 'string' ? { text: previous.text }
        : typeof message.text === 'string' ? { text: message.text } : {}),
    } as TabMessage;
  }
  return next;
}

export function tabMessageThreads(messages: TabMessageIndex, tabId: string) {
  const all = Object.values(messages);
  const replies = new Map(all.filter(m => m.kind === 'reply' && m.replyTo).map(m => [m.replyTo, m]));
  return all.filter(m => m.kind === 'question' && (m.sourceTabId === tabId || m.targetTabId === tabId))
    .sort((a, b) => tabMessageTimestamp(b.createdAt) - tabMessageTimestamp(a.createdAt) || a.messageId.localeCompare(b.messageId))
    .map(question => {
      const candidate = question.replyMessageId ? messages[question.replyMessageId] : replies.get(question.messageId);
      const reply = candidate?.kind === 'reply' && candidate.replyTo === question.messageId ? candidate : undefined;
      return {
        question, reply,
        incoming: question.targetTabId === tabId,
        answerAvailable: Boolean(reply || question.replyMessageId || question.answeredAt),
      };
    });
}

export function tabMessageDelivery(message: TabMessage): MessagePresentation {
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
  return answerAvailable ? 'Доставлено' : 'Доставлено · ждёт ответа';
}

export function tabMessageDismissed(question: TabMessage, tabId: string): boolean {
  return Boolean(question.sourceTabId === tabId ? question.sourceDismissedAt : question.targetDismissedAt);
}

export function tabMessagePeer(thread: TabMessageThread) {
  return thread.incoming ? thread.question : {
    sourceTabId: thread.question.targetTabId,
    sourceTabName: thread.question.targetTabName,
    sourceProjectId: thread.question.targetProjectId,
  };
}

export function tabMessageReplyPresentation(thread: TabMessageThread): MessagePresentation {
  if (thread.reply) return tabMessageDelivery(thread.reply);
  return { label: thread.answerAvailable ? 'Ответ сохранён; доставка уточняется' : 'Ожидает ответа',
    color: '#999', icon: 'waiting', spinning: false };
}

export function tabMessagePresentation(thread: TabMessageThread): MessagePresentation {
  return thread.question.deliveryState !== 'sent'
    ? tabMessageDelivery(thread.question)
    : tabMessageReplyPresentation(thread);
}

export function tabMessageSuccessAt(thread: TabMessageThread): number | null {
  if (thread.question.deliveryState !== 'sent' || thread.reply?.deliveryState !== 'sent') return null;
  // A reply's sent timestamp is frozen by the service. Question.updatedAt also
  // changes when either participant dismisses, so it must not renew visibility.
  return tabMessageTimestamp(thread.reply.updatedAt) || tabMessageTimestamp(thread.reply.createdAt) || null;
}

export function tabMessageVisibleInTracker(thread: TabMessageThread, tabId: string, now: number): boolean {
  if (tabMessageDismissed(thread.question, tabId)) return false;
  const completedAt = tabMessageSuccessAt(thread);
  return completedAt === null || completedAt + REQUEST_SUCCESS_VISIBLE_MS > now;
}
