import React from 'react';
import { TERMINAL_MESSAGE_LINK_PREFIX, readTerminalMessageLink } from '../../../shared/terminal-message-reference.mjs';
import { jumpToTerminalMessageTarget } from '../../utils/tabMessageSourceJump';
import { useUIStore } from '../../store/useUIStore';
import './HistoryIterationLink.css';

export function renderHistoryIterationLink({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href?.startsWith(TERMINAL_MESSAGE_LINK_PREFIX)) return undefined;
  const target = readTerminalMessageLink(href);
  if (!target) return <span title="Некорректная ссылка на сообщение">{children}</span>;
  return <a href={href} className="history-iteration-link" data-history-iteration-link={target.messageId}
    title="Показать сообщение в History"
    onMouseDown={event => event.stopPropagation()}
    onClick={event => {
      event.preventDefault(); event.stopPropagation();
      void jumpToTerminalMessageTarget(target, 'iteration:' + target.messageId.slice(0, 96)).catch(error => {
        console.warn('[HistoryIterationLink] jump failed code=' + String(error?.code || error?.message || 'unknown').slice(0, 160));
        useUIStore.getState().showToast('Не удалось показать сообщение: ссылка устарела или цель недоступна', 'warning');
      });
    }}>{children}</a>;
}
