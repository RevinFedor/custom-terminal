/* ============================================================
   @noted/claude-blocks — ToolCard + ColoredToolIcon
   ------------------------------------------------------------
   Общий каркас tool-call строки. Перенос из ClaudeSDKTab.tsx::ToolCard.
   Collapse-механизм внедряемый (controlled open/onToggle ИЛИ
   внутренний useState) — десктоп/мобайл подставляют свой персист.
   ============================================================ */
import React, { useState, useRef, useEffect } from 'react';
import { Loader2Icon, AlertTriangleIcon, ChevronRightIcon } from '../icons';
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
  const revealRef = useRef<HTMLDivElement>(null);
  // `mounted` trails `isOpen`: true immediately on open (so the grid exists
  // to animate), and stays true until the closing transition ends.
  const [mounted, setMounted] = useState(isOpen);
  // A transition only runs when a value CHANGES on an element the browser has
  // already laid out. The wrapper mounts in the same commit as the open
  // state, so painting it directly at 1fr produced no animation at all
  // (measured live: full height at t=40ms). `revealActive` is therefore
  // flipped one frame AFTER mount — first frame 0fr, next frame 1fr, which is
  // a real change and animates.
  const [revealActive, setRevealActive] = useState(false);
  useEffect(() => {
    if (!mounted) { setRevealActive(false); return; }
    if (!isOpen) { setRevealActive(false); return; }
    const raf = requestAnimationFrame(() => setRevealActive(true));
    return () => cancelAnimationFrame(raf);
  }, [mounted, isOpen]);
  useEffect(() => {
    if (isOpen) { setMounted(true); return; }
    if (!mounted) return;
    const node = revealRef.current;
    if (!node) { setMounted(false); return; }
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setMounted(false); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setMounted(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === 'grid-template-rows') finish();
    };
    node.addEventListener('transitionend', onEnd);
    // Safety net: a row scrolled out of view (or a browser that skips the
    // transition) must not leave the body mounted forever.
    const timer = window.setTimeout(finish, 400);
    return () => {
      node.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [isOpen, mounted]);

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
      </div>
      {subtitle && <div className="cb-tool-sub">{subtitle}</div>}
      {/* Height animation, both directions.
          The body is wrapped in a grid whose single row goes 0fr → 1fr, which
          the browser interpolates as a real height change — no JS measuring,
          no absolute clone, and it plays on CLOSE too (a plain conditional
          mount can only animate the opening half). `mounted` keeps the
          subtree alive for the closing frames and drops it after, so a
          collapsed card still costs nothing — the perf rule that heavy diff
          rows must not live in the feed while collapsed is preserved. */}
      {hasBody && mounted && (
        <div
          className="cb-tool-reveal"
          data-open={isOpen && revealActive ? 'true' : 'false'}
          ref={revealRef}
        >
          <div className="cb-tool-reveal-inner">
            <div className="cb-tool-body">
              <span className="cb-rail" />
              {body}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
