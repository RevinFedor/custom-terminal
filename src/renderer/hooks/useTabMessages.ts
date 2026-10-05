import { useCallback, useEffect, useMemo, useState } from 'react';
import { mergeTabMessages, tabMessageThreads } from '../utils/tabMessageProjection';
import type { TabMessage, TabMessageIndex } from '../utils/tabMessageProjection';

const { ipcRenderer } = window.require('electron');

export function useTabMessages(tabId: string) {
  const [messages, setMessages] = useState<TabMessageIndex>({});
  const [listError, setListError] = useState('');
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const merge = useCallback((items: TabMessage[]) => setMessages(current => mergeTabMessages(current, items)), []);
  useEffect(() => {
    let alive = true;
    setMessages({});
    setActionErrors({});
    setListError('');
    const changed = (_event: unknown, payload: { message?: TabMessage }) => {
      const message = payload?.message;
      if (alive && message && (message.sourceTabId === tabId || message.targetTabId === tabId)) merge([message]);
    };
    ipcRenderer.on('tab-messages:changed', changed);
    void ipcRenderer.invoke('tab-messages:list', { tabId }).then((items: TabMessage[]) => {
      if (!Array.isArray(items)) throw new Error('Некорректный список сообщений');
      if (alive) merge(items);
    }).catch((error: unknown) => {
      if (alive) setListError(error instanceof Error ? error.message : String(error));
    });
    return () => { alive = false; ipcRenderer.removeListener('tab-messages:changed', changed); };
  }, [tabId, merge, retry]);

  const dismiss = useCallback(async (messageId: string) => {
    try {
      const result = await ipcRenderer.invoke('tab-messages:dismiss', { tabId, messageId });
      if (result?.message?.messageId !== messageId) throw new Error('Не удалось скрыть карточку');
      merge([result.message]);
      setActionErrors(current => ({ ...current, [messageId]: '' }));
      return true;
    } catch (error) {
      setActionErrors(current => ({ ...current, [messageId]: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }, [tabId, merge]);
  return { threads: useMemo(() => tabMessageThreads(messages, tabId), [messages, tabId]),
    listError, actionErrors, merge, dismiss, reload: () => setRetry(value => value + 1) };
}

export type TabMessagesController = ReturnType<typeof useTabMessages>;
