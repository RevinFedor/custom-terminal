/* ============================================================
   @noted/claude-blocks — ToolCard + ColoredToolIcon
   ------------------------------------------------------------
   Общий каркас tool-call строки. Перенос из ClaudeSDKTab.tsx::ToolCard.
   Collapse-механизм внедряемый (controlled open/onToggle ИЛИ
   внутренний useState) — десктоп/мобайл подставляют свой персист.
   ============================================================ */
import React, { useState, useRef } from 'react';
import { Loader2Icon, AlertTriangleIcon } from '../icons';
import type { ToolStatus } from '../helpers';

const STATUS_CLASS: Record<ToolStatus, string> = {
  running: 'cb-c-running',
  done: 'cb-c-done',
  error: 'cb-c-error',
  waiting: 'cb-c-waiting',
};

// Status carrier — the tool icon itself is the status indicator (bold stroke,
// coloured by state). Running → spinner. Waiting (gated, paused for the user) →
// amber triangle (NOT a spinner — nothing is executing yet).
export function ColoredToolIcon({ icon, status }: { icon: React.ReactNode; status: ToolStatus }) {
  if (status === 'running') {
    return <Loader2Icon size={14} strokeWidth={2.75} className={`cb-spin cb-tool-ic ${STATUS_CLASS.running}`} />;
  }
  if (status === 'waiting') {
    return <AlertTriangleIcon size={14} strokeWidth={2.5} className={`cb-tool-ic ${STATUS_CLASS.waiting}`} />;
  }
  if (React.isValidElement(icon)) {
    const original = icon as React.ReactElement<any>;
    return React.cloneElement(original, {
      size: 14,
      strokeWidth: 2.75,
      className: ['cb-tool-ic', STATUS_CLASS[status], original.props?.className || ''].filter(Boolean).join(' '),
    });
  }
  return <span className={`cb-tool-ic ${STATUS_CLASS[status]}`}>{icon}</span>;
}

export interface ToolCardProps {
  status: ToolStatus;
  icon: React.ReactNode;
  label: React.ReactNode;             // small uppercase: "READ", "BASH"
  description?: React.ReactNode;      // dim parenthetical
  preview?: React.ReactNode;          // monospace command/path/query
  badges?: React.ReactNode;           // counts/diff stats after label
  subtitle?: React.ReactNode;         // dim sub-line below header
  body?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Управляемое раскрытие (опц.). Передавать вместе с onToggle. */
  open?: boolean;
  onToggle?: () => void;
  /** Якорь корня — для desktop scroll-compensation. */
  anchorRef?: React.RefObject<HTMLDivElement | null>;
}

export const ToolCard: React.FC<ToolCardProps> = ({
  status, icon, label, description, preview, badges, subtitle, body,
  collapsible = true, defaultOpen = false, open, onToggle, anchorRef,
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const localRef = useRef<HTMLDivElement>(null);
  const controlled = open !== undefined && onToggle !== undefined;
  const isOpen = controlled ? !!open : internalOpen;
  const toggle = controlled ? onToggle! : () => setInternalOpen(v => !v);
  const rootRef = anchorRef ?? localRef;

  const hasBody = body !== undefined && body !== null && body !== false;
  const clickable = hasBody && collapsible;

  return (
    <div ref={rootRef} className="cb-tool">
      <div
        className={`cb-tool-head${clickable ? ' cb-tool-head--clickable' : ''}`}
        onClick={clickable ? toggle : undefined}
      >
        <ColoredToolIcon icon={icon} status={status} />
        <span className="cb-tool-label">{label}</span>
        {badges && <span className="cb-tool-badges">{badges}</span>}
        {description && <span className="cb-tool-desc">({description})</span>}
        {preview && <span className="cb-tool-preview">{preview}</span>}
      </div>
      {subtitle && <div className="cb-tool-sub">{subtitle}</div>}
      {hasBody && isOpen && (
        <div className="cb-tool-body">
          <span className="cb-rail" />
          {body}
        </div>
      )}
    </div>
  );
};
