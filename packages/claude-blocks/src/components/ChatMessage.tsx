/* ============================================================
   @noted/claude-blocks — ChatMessage (полный рендер одного сообщения)
   ------------------------------------------------------------
   Owns 100% ВИЗУАЛА строки чата: раскладка, выравнивание (user справа /
   assistant на всю ширину), бабблы, фон, бейджи (queued/stopped), слэш-
   чипы, pasted_content-чипы, compact-карточка, панель действий
   (copy/repeat/edit), thinking/tool карточки, отступы/цвета через --cb-*.

   НЕ owns: виртуализацию/скролл-контейнер (расходится Virtuoso vs virtua —
   остаётся у потребителя), composer, выбор модели, lifecycle процесса.

   Поведение внедряется через ChatRenderContext (collapse-контроллер +
   action-колбэки). Без контроллера — локальный useState (gt-editor goes
   here by default).
   ============================================================ */
import React, { useState, useRef } from 'react';
import { Markdown } from './Markdown';
import { ThinkBlock } from './ThinkBlock';
import { ToolCallPart } from './ToolCards';
import {
  ConversationMessage,
  MessageActionButton,
  MessageActionRail,
  MessageStatusBadge,
} from './ConversationMessage';
import { defaultOpenForTool } from '../helpers';
import { CopyIcon, RefreshCwIcon, PencilIcon, ScissorsIcon } from '../icons';
import type { ChatEntry, ChatRenderContext } from '../messageTypes';

const USER_TEXT_COLLAPSE_THRESHOLD = 600;
const USER_TEXT_COLLAPSED_CHARS = 400;
const COMPACT_COLLAPSED_CHARS = 600;

/** Elapsed-time label for the assistant "thought Xs" badge. <60s → "7s",
 *  otherwise "1m 07s". Sub-second rounds up to 1s so a real reply never shows 0s. */
function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + 'm ' + String(s).padStart(2, '0') + 's';
}

/* ---- collapse-резолвер: внедрённый контроллер или локальный useState ---- */
function useResolvedCollapse(
  id: string,
  defaultOpen: boolean,
  ctx?: ChatRenderContext,
): [boolean, () => void] {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  if (ctx?.collapse) {
    const open = ctx.collapse.isOpen(id, defaultOpen);
    return [open, () => ctx.collapse!.toggle(id, !open)];
  }
  return [localOpen, () => setLocalOpen(v => !v)];
}

/* ============================================================
   CollapsibleText — превью + тоггл, без ellipsis. Перенос из десктоп/мобила.
   ============================================================ */
const CollapsibleText: React.FC<{ id: string; text: string; ctx?: ChatRenderContext }> = ({ id, text, ctx }) => {
  const [open, toggle] = useResolvedCollapse('ct:' + id, false, ctx);
  const anchorRef = ctx?.anchorRefFor?.('ct:' + id);
  if (text.length <= USER_TEXT_COLLAPSE_THRESHOLD) {
    return <p className="cb-msg-text">{text}</p>;
  }
  const preview = text.slice(0, USER_TEXT_COLLAPSED_CHARS).trimEnd();
  const ToggleBtn = (
    <button type="button" onClick={toggle} onMouseDown={(e) => e.preventDefault()} className="cb-collapse-btn">
      {open ? 'Свернуть' : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
    </button>
  );
  return (
    <div ref={anchorRef as any}>
      {open && <div className="cb-collapse-top">{ToggleBtn}</div>}
      <p className="cb-msg-text">{open ? text : preview + '…'}</p>
      <div className="cb-collapse-bottom">{ToggleBtn}</div>
    </div>
  );
};

/* ============================================================
   UserText — парсит <pasted_content> в чипы. Перенос из десктоп/мобила.
   ============================================================ */
const UserText: React.FC<{ id: string; text: string; ctx?: ChatRenderContext }> = ({ id, text, ctx }) => {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  if (!text.includes('<pasted_content>')) {
    return <CollapsibleText id={id} text={text} ctx={ctx} />;
  }
  const parts: Array<{ type: 'text' | 'paste'; content: string }> = [];
  let remaining = text;
  while (remaining.includes('<pasted_content>')) {
    const start = remaining.indexOf('<pasted_content>');
    const end = remaining.indexOf('</pasted_content>');
    if (end === -1) break;
    if (start > 0) parts.push({ type: 'text', content: remaining.slice(0, start).trim() });
    parts.push({ type: 'paste', content: remaining.slice(start + 16, end).trim() });
    remaining = remaining.slice(end + 17).trim();
  }
  if (remaining) parts.push({ type: 'text', content: remaining });
  return (
    <div className="cb-user-parts">
      {parts.map((p, i) => {
        if (p.type === 'text' && p.content) {
          return <CollapsibleText key={i} id={id + ':' + i} text={p.content} ctx={ctx} />;
        }
        if (p.type === 'paste') {
          const preview = p.content.slice(0, 60).replace(/\n/g, ' ') + (p.content.length > 60 ? '...' : '');
          const isOpen = expandedIdx === i;
          return (
            <div key={i}>
              <span className="cb-paste-chip" onClick={() => setExpandedIdx(isOpen ? null : i)}>
                <span className="cb-paste-chip-preview">{preview}</span>
                <span className="cb-paste-chip-len">{p.content.length.toLocaleString()}</span>
              </span>
              {isOpen && <pre className="cb-paste-chip-body">{p.content}</pre>}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};

/* ============================================================
   Панель действий над сообщением (hover). Кнопки рендерятся только если
   соответствующий колбэк передан.
   ============================================================ */
const UserActionsBar: React.FC<{ entry: ChatEntry; actions?: ChatRenderContext['actions'] }> = ({ entry, actions }) => {
  if (!actions || (!actions.onCopy && !actions.onRepeat && !actions.onEdit && !actions.onRewind)) return null;
  return (
    <MessageActionRail placement="outside-start">
      {actions.onCopy && (
        <MessageActionButton title="Copy message"
          onClick={() => actions.onCopy!(entry)}>
          <CopyIcon size={11} />
        </MessageActionButton>
      )}
      {actions.onRepeat && (
        <MessageActionButton title="Repeat — drop replies, resend this message"
          onClick={() => actions.onRepeat!(entry)}>
          <RefreshCwIcon size={11} />
        </MessageActionButton>
      )}
      {actions.onEdit && (
        <MessageActionButton title="Edit — send a new version of this message"
          onClick={() => actions.onEdit!(entry)}>
          <PencilIcon size={11} />
        </MessageActionButton>
      )}
      {actions.onRewind && (
        <MessageActionButton tone="accent" title="Rewind to this message"
          onClick={() => actions.onRewind!(entry)}>
          <ScissorsIcon size={11} />
        </MessageActionButton>
      )}
    </MessageActionRail>
  );
};

const AssistantCopyButton: React.FC<{ entry: ChatEntry; onCopy: (e: ChatEntry) => void }> = ({ entry, onCopy }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className={'cb-copy-btn' + (copied ? ' cb-copy-btn-done' : '')}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => { onCopy(entry); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
      Copy
    </button>
  );
};

/* ============================================================
   ChatMessage — диспетчер по kind. Рисует ОДНО сообщение целиком.
   ============================================================ */
export interface ChatMessageProps {
  entry: ChatEntry;
  ctx?: ChatRenderContext;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ entry, ctx }) => {
  switch (entry.kind) {
    case 'user': {
      const isSlashCmd = /^\/\w[\w-]*(?:\s|$)/.test(entry.text.trim()) && !entry.text.includes('\n');
      if (isSlashCmd) {
        return (
          <ConversationMessage layout="end" entryUuid={entry.entryUuid}>
            <div className="cb-slash-chip">{entry.text.trim()}</div>
          </ConversationMessage>
        );
      }
      return (
        <ConversationMessage
          layout="user"
          entryUuid={entry.entryUuid}
          status={entry.wasQueued ? (
            <MessageStatusBadge
              label="QUEUED"
              tone="accent"
              className="cb-queued-badge"
              title="Поставлено в очередь во время стриминга и отправлено автоматически"
              icon={<span className="cb-queued-arrow">↑</span>}
            />
          ) : undefined}
          actions={<UserActionsBar entry={entry} actions={ctx?.actions} />}
        >
          <UserText id={entry.id} text={entry.text} ctx={ctx} />
        </ConversationMessage>
      );
    }

    case 'assistant': {
      const hasDuration = typeof entry.durationMs === 'number' && entry.durationMs > 0;
      const hasMeta = !!ctx?.actions?.onCopy || hasDuration || !!entry.stopped;
      return (
        <ConversationMessage
          layout="assistant"
          entryUuid={entry.entryUuid}
          footer={hasMeta ? (
            <div className="cb-assistant-meta-row">
              {ctx?.actions?.onCopy && <AssistantCopyButton entry={entry} onCopy={ctx.actions.onCopy} />}
              {hasDuration && (
                <div className="cb-duration-badge" title="Время ответа">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
                  </svg>
                  {formatDuration(entry.durationMs!)}
                </div>
              )}
              {entry.stopped && (
                <div className="cb-stopped-badge" title="Этот ответ был остановлен пользователем">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="12" cy="12" r="9" /><line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
                  </svg>
                  stopped
                </div>
              )}
            </div>
          ) : undefined}
        >
          {entry.text ? <Markdown text={entry.text} /> : <span className="cb-empty-dot">…</span>}
        </ConversationMessage>
      );
    }

    case 'thinking': {
      const [open, toggle] = useResolvedCollapse(entry.id, false, ctx);
      const anchorRef = ctx?.anchorRefFor?.(entry.id);
      return (
        <ConversationMessage layout="block" entryUuid={entry.entryUuid} className="cb-service-row">
          <ThinkBlock text={entry.text || 'thinking…'} label={entry.label || 'thinking'}
            open={open} onToggle={toggle} anchorRef={anchorRef} />
        </ConversationMessage>
      );
    }

    case 'tool': {
      const isPending = entry.result === undefined;
      // Waiting (gated, paused for approval) also defaults open — the user must
      // see the command/diff they're approving.
      const [open, toggle] = useResolvedCollapse(entry.id, entry.isError || isPending || entry.awaitingApproval || defaultOpenForTool(entry.tool), ctx);
      const anchorRef = ctx?.anchorRefFor?.(entry.id);
      return (
        <ConversationMessage layout="block" entryUuid={entry.entryUuid} className="cb-service-row">
          <ToolCallPart toolName={entry.tool} args={entry.input || {}} result={entry.result} isError={entry.isError}
            startLine={entry.startLine} diffHunks={entry.diffHunks} awaitingApproval={entry.awaitingApproval}
            family={entry.family} headline={entry.headline} mcpServer={entry.mcpServer} mcpMethod={entry.mcpMethod}
            collapse={{ open, onToggle: toggle, anchorRef }} />
        </ConversationMessage>
      );
    }

    case 'slash':
      return (
        <ConversationMessage layout="end" entryUuid={entry.entryUuid}>
          <div className="cb-slash-chip">{entry.text}</div>
        </ConversationMessage>
      );

    case 'compact-summary': {
      const text = entry.text || '';
      const m = entry.metrics;
      const needsCollapse = text.length > COMPACT_COLLAPSED_CHARS;
      const [open, toggle] = useResolvedCollapse(entry.id, false, ctx);
      const anchorRef = ctx?.anchorRefFor?.(entry.id);
      const preview = text.slice(0, COMPACT_COLLAPSED_CHARS).trimEnd();
      const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
      const secs = m ? Math.round(m.durationMs / 1000) : 0;
      const Toggle = needsCollapse ? (
        <button type="button" onClick={toggle} onMouseDown={(e) => e.preventDefault()} className="cb-compact-toggle">
          {open ? 'Свернуть' : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
        </button>
      ) : null;
      return (
        <ConversationMessage layout="block" entryUuid={entry.entryUuid}>
          <div ref={anchorRef as any} className="cb-compact-card">
            <div className="cb-compact-head">
              <span className="cb-compact-label">Compact summary</span>
              {m && m.postTokens > 0 && <span className="cb-compact-metrics">{k(m.postTokens)} tokens · {secs}s</span>}
            </div>
            {needsCollapse && open && <div className="cb-compact-toggle-top">{Toggle}</div>}
            <div className="cb-compact-body">{needsCollapse && !open ? preview + '…' : text}</div>
            {needsCollapse && <div className="cb-compact-toggle-bottom">{Toggle}</div>}
          </div>
        </ConversationMessage>
      );
    }

    case 'system':
      return (
        <ConversationMessage layout="system" entryUuid={entry.entryUuid}>
          <div className="cb-system-text">{entry.text}</div>
        </ConversationMessage>
      );

    case 'error':
      return (
        <ConversationMessage layout="block" entryUuid={entry.entryUuid}>
          <div className="cb-error-box">{entry.text}</div>
        </ConversationMessage>
      );

    default:
      return null;
  }
};
