import React from 'react';
import { TERMINAL_MESSAGE_LINK_PREFIX, readTerminalMessageLink } from '../../../shared/terminal-message-reference.mjs';
import { jumpToTerminalMessageTarget } from '../../utils/tabMessageSourceJump';
import { useUIStore } from '../../store/useUIStore';
import './HistoryIterationLink.css';

// A failed jump used to say one thing for every cause: "ссылка устарела или
// цель недоступна". On 02.11 that was shown for a link whose target was alive
// and four rows away — the address in it was simply truncated. Name the actual
// cause instead; the row being absent and the tab being gone are not the same
// problem, and neither is a link that was never addressable.
const JUMP_FAILURE_TEXT: Record<string, string> = {
  'identity-not-in-display': 'Это сообщение не показано в ленте вкладки',
  'source-session-changed': 'Вкладка сейчас показывает другую сессию',
  'target-address-timeout': 'Лента не успела найти сообщение',
  'source-scroll-timeout': 'Лента не успела найти сообщение',
  tab_message_source_tab_unavailable: 'Вкладка недоступна',
  tab_message_source_call_not_found: 'Сообщение не найдено в этой вкладке',
  tab_message_source_identity_changed: 'Адрес сообщения изменился',
  message_reference_invalid: 'Ссылка не содержит полного адреса сообщения',
};

export function renderHistoryIterationLink({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href?.startsWith(TERMINAL_MESSAGE_LINK_PREFIX)) return undefined;
  const target = readTerminalMessageLink(href);
  // Not clickable on purpose: a truncated or malformed address cannot resolve,
  // so offering the click would promise a jump that is guaranteed to fail.
  if (!target) return <span title="Неполный или некорректный адрес сообщения — переход невозможен">{children}</span>;
  return <a href={href} className="history-iteration-link" data-history-iteration-link={target.messageId}
    title="Показать сообщение в History"
    onMouseDown={event => event.stopPropagation()}
    onClick={event => {
      event.preventDefault(); event.stopPropagation();
      void jumpToTerminalMessageTarget(target, 'iteration:' + target.messageId.slice(0, 96)).catch(error => {
        const code = String(error?.code || error?.message || 'unknown').slice(0, 160);
        console.warn('[HistoryIterationLink] jump failed code=' + code);
        useUIStore.getState().showToast('Не удалось показать сообщение: '
          + (JUMP_FAILURE_TEXT[code] || 'цель недоступна'), 'warning');
      });
    }}>{children}</a>;
}
