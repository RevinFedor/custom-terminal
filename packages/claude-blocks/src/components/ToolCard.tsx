/* ============================================================
   @noted/claude-blocks — ToolCard + ColoredToolIcon
   ------------------------------------------------------------
   Общий каркас tool-call строки. Перенос из ClaudeSDKTab.tsx::ToolCard.
   Collapse-механизм внедряемый (controlled open/onToggle ИЛИ
   внутренний useState) — десктоп/мобайл подставляют свой персист.
   ============================================================ */
import React, { useState, useRef } from 'react';
import { Loader2Icon, AlertTriangleIcon, ChevronRightIcon } from '../icons';
import { RowCopyButton } from './RowCopyButton';
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
  /**
   * Full row payload for the hover copy button (original form: command +
   * output, file content, diff). Omitted → no button, because there is
   * nothing this row could honestly hand over.
   */
  getCopyText?: () => string;
  onCopy?: (text: string) => void;
}

export const ToolCard: React.FC<ToolCardProps> = ({
  status, icon, label, description, preview, badges, subtitle, body,
  collapsible = true, defaultOpen = false, open, onToggle, anchorRef,
  getCopyText, onCopy,
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
        aria-expanded={clickable ? isOpen : undefined}
      >
        {/* Two boxes on purpose: the OUTER row is a block-level flex (stable,
            integral height — an inline-level box would take fractional
            line-box metrics and make a virtualized feed jitter while
            scrolling), the INNER one shrinks to its content and owns the
            hover/click surface, so the empty space right of a short row is
            not interactive. */}
        <div className="cb-tool-head-inner" onClick={clickable ? toggle : undefined}>
          <ColoredToolIcon icon={icon} status={status} />
          {/* ONE flowing line, not columns: the icon hangs in the gutter and
              everything after it — label, badges, subject, qualifier, chevron
              — is ordinary inline text that wraps like a paragraph, so a long
              subject's second line starts exactly under the LABEL (user:
              «план — начало строки, перенос как обычный перенос строки», not
              a label column beside a text column). */}
          <span className="cb-tool-line">
            <span className="cb-tool-label">{label}</span>
            {badges && <span className="cb-tool-badges">{badges}</span>}
            {description && <span className="cb-tool-desc">({description})</span>}
            {preview && <span className="cb-tool-preview">{preview}</span>}
            {/* Second-level expand affordance: appears on hover only (groups —
                first level — keep an always-visible chevron; the difference IS
                the hierarchy). */}
            {clickable && <ChevronRightIcon size={11} className="cb-tool-chevron" />}
          </span>
        </div>
        {/* Copy sits OUTSIDE the shrink-to-fit inner box, pinned to the row's
            right edge — the same place and the same hover rule as a prompt
            row's copy. Inside the inner box it would ride at the end of the
            text and move with every label. */}
        {getCopyText && onCopy && (
          <RowCopyButton getText={getCopyText} onCopy={onCopy} />
        )}
      </div>
      {subtitle && <div className="cb-tool-sub">{subtitle}</div>}
      {/* No height animation, by decision (16.08): every animated variant
          either fought the virtualized list (height remeasure jitter) or the
          stationary-click rule below. The body mounts open and unmounts
          closed — a collapsed card costs nothing, and the row's height
          changes in ONE frame, which is exactly what the caller's scroll
          compensation is written against. */}
      {hasBody && isOpen && (
        <div className="cb-tool-body">
          <span className="cb-rail" />
          {body}
        </div>
      )}
    </div>
  );
};
