import React, { useState, useRef, useLayoutEffect, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right' | 'auto';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: Side;
  align?: 'center' | 'start';
  // Optional delay in ms (default 0 = instant — the whole point of this component).
  delay?: number;
  // Allow disabling without removing call sites; falsy content also disables.
  disabled?: boolean;
  // When true, tooltip shows on hover regardless of Cmd state. Default false:
  // the tooltip only appears when Cmd is held — most UI is self-explanatory and
  // tooltip-spam is noise. Reserve `always` for genuinely opaque controls.
  always?: boolean;
  // Simple labels should not expose the selectable body and Copy action bar.
  // Interactive mode remains the default for existing long-form tooltips.
  interactive?: boolean;
  // Replace the generic Close/Copy row for domain-specific interactive cards.
  // `false` removes the row entirely; `undefined` keeps the generic controls.
  actionBar?: React.ReactNode | false;
}

// ─── Global Cmd-key state ────────────────────────────────────
// All Tooltip instances share one keydown/keyup listener pair via a module-level
// subscription set. Per-tooltip hooks would mean 100+ listeners on the page.
let cmdHeld = false;
const cmdSubscribers = new Set<(v: boolean) => void>();

if (typeof window !== 'undefined') {
  const broadcast = () => cmdSubscribers.forEach((fn) => fn(cmdHeld));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Meta' && !cmdHeld) { cmdHeld = true; broadcast(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' && cmdHeld) { cmdHeld = false; broadcast(); }
  });
  window.addEventListener('blur', () => {
    if (cmdHeld) { cmdHeld = false; broadcast(); }
  });
}

function useCmdHeld(): boolean {
  const [v, setV] = useState(cmdHeld);
  useEffect(() => {
    cmdSubscribers.add(setV);
    setV(cmdHeld);
    return () => { cmdSubscribers.delete(setV); };
  }, []);
  return v;
}

const PADDING = 6; // viewport edge padding
const GAP = 6;     // gap between trigger and tooltip

/**
 * Instant, portal-based tooltip.
 *
 * Why this exists instead of native `title=""`:
 *   • Native OS tooltips have a hard-coded ~1500ms delay (HIG default, not configurable).
 *   • Native tooltips can't be styled — they break dark-theme consistency.
 *   • Portal escapes overflow:hidden / transform parents that hid native tooltips.
 *
 * Behaviour:
 *   • Appears 0ms after pointerenter (override with `delay`).
 *   • Auto-flips when there's no room on the requested side.
 *   • Pointer-events: none — never blocks clicks on the trigger.
 *   • Cloning the only child (no extra wrapper div) — handlers compose with existing ones.
 *
 * Usage:
 *   <Tooltip content="Copy session ID"><button>⎘</button></Tooltip>
 *   <Tooltip content="…" side="left"><span ref={ref}>…</span></Tooltip>
 */
export default function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay = 0,
  disabled = false,
  always = false,
  interactive = true,
  actionBar,
}: TooltipProps) {
  const [hovering, setHovering] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; arrowSide: Side } | null>(null);
  // True while the cursor is inside the tooltip body itself. Drives the
  // interactive overlay (action-bar + selectable text). Kept separate from
  // `hovering` (which tracks the trigger) so we can keep the tip alive when
  // the cursor crosses the GAP from trigger → tooltip.
  const [inTip, setInTip] = useState(false);
  // Action-bar feedback for the Copy button (one Tooltip per call site has its
  // own copy state — short-lived enough that lifting into a store would be
  // overkill).
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tiny delay before hiding when leaving the trigger — lets the cursor cross
  // the GAP onto the tooltip without it disappearing under the pointer.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmd = useCmdHeld();

  const isInactive = disabled || !content;
  // Gate: by default tooltip only appears while Cmd is held. `always` opts out.
  const allowedToShow = always || cmd;

  // Auto show/hide based on ((hovering trigger) OR (inside tip)) AND allowed.
  // Keeping the tip alive while the cursor is inside it is what makes text
  // selection / Copy click possible — without it the leave-trigger event would
  // hide before pointer-enter on the tip can fire.
  useEffect(() => {
    if (isInactive) {
      setVisible(false);
      setHovering(false);
      setInTip(false);
      return;
    }
    const triggerIsHovered = interactive || triggerRef.current?.matches(':hover') === true;
    const wantOpen = ((hovering && triggerIsHovered) || (interactive && inTip)) && allowedToShow;
    if (wantOpen) {
      if (delay <= 0) setVisible(true);
      else {
        if (showTimerRef.current) clearTimeout(showTimerRef.current);
        showTimerRef.current = setTimeout(() => setVisible(true), delay);
      }
    } else {
      if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
      setVisible(false);
    }
  }, [hovering, inTip, allowedToShow, isInactive, delay, interactive]);

  // Reset Copy feedback whenever the tooltip closes — otherwise reopening on a
  // different element would briefly show the stale ✓ from the previous instance.
  useEffect(() => {
    if (!visible && copied) setCopied(false);
  }, [visible, copied]);

  const show = useCallback(() => {
    if (isInactive) return;
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    setHovering(true);
  }, [isInactive]);

  // Defer the hide by one frame's worth so the cursor can cross GAP onto the
  // tip without losing it. The tip's own onPointerEnter will cancel this timer.
  // 60ms — minimum that reliably covers the 6px gap at typical cursor speeds
  // while still feeling instant on leave. Higher values produced a "lingering"
  // tooltip after the cursor was already far from the trigger.
  const hide = useCallback(() => {
    if (!interactive) {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      setHovering(false);
      setInTip(false);
      return;
    }
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setHovering(false);
      hideTimerRef.current = null;
    }, 60);
  }, [interactive]);

  // Extract a plain-text representation of `content` for the Copy button.
  // String content is trivial; for ReactNode trees we read the rendered text
  // off the DOM (the tip is already mounted by the time the user clicks Copy).
  const handleCopy = useCallback(async () => {
    let text = '';
    if (typeof content === 'string') text = content;
    else if (typeof content === 'number') text = String(content);
    else if (tipRef.current) {
      // Strip the action-bar children's text before reading — they're inside
      // a separate child (data-tooltip-actions) we skip with cloneNode walking.
      const body = tipRef.current.querySelector('[data-tooltip-body]') as HTMLElement | null;
      text = (body?.innerText || tipRef.current.innerText || '').trim();
    }
    if (!text) return;
    try {
      // Electron renderer: prefer the system clipboard via require to avoid the
      // browser's permission-prompt path (which is unreliable in Electron).
      const w = window as any;
      if (w.require) {
        const { clipboard } = w.require('electron');
        clipboard.writeText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Silent — copy failures here are not actionable for the user.
    }
  }, [content]);

  useLayoutEffect(() => () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  // Measure & position once the tip mounts. Re-measure on scroll/resize while visible.
  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tipRef.current) { setPos(null); return; }

    const measure = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const p = tipRef.current?.getBoundingClientRect();
      if (!t || !p) return;
      const vw = window.innerWidth, vh = window.innerHeight;

      const trySide = (s: Side): { left: number; top: number; ok: boolean } => {
        let left = 0, top = 0, ok = true;
        switch (s) {
          case 'top':
            left = t.left + t.width / 2 - p.width / 2;
            top = t.top - p.height - GAP;
            if (top < PADDING) ok = false;
            break;
          case 'bottom':
            left = t.left + t.width / 2 - p.width / 2;
            top = t.bottom + GAP;
            if (top + p.height > vh - PADDING) ok = false;
            break;
          case 'left':
            left = t.left - p.width - GAP;
            top = align === 'start' ? t.top : t.top + t.height / 2 - p.height / 2;
            if (left < PADDING) ok = false;
            break;
          case 'right':
            left = t.right + GAP;
            top = align === 'start' ? t.top : t.top + t.height / 2 - p.height / 2;
            if (left + p.width > vw - PADDING) ok = false;
            break;
          default:
            break;
        }
        // Clamp horizontal/vertical bounds.
        left = Math.max(PADDING, Math.min(left, vw - p.width - PADDING));
        top = Math.max(PADDING, Math.min(top, vh - p.height - PADDING));
        return { left, top, ok };
      };

      const order: Side[] = side === 'auto'
        ? ['top', 'bottom', 'right', 'left']
        : [side, side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left', 'top', 'bottom'];

      let chosen: { left: number; top: number; arrowSide: Side } | null = null;
      for (const s of order) {
        const r = trySide(s);
        if (r.ok) { chosen = { left: r.left, top: r.top, arrowSide: s }; break; }
        if (!chosen) chosen = { left: r.left, top: r.top, arrowSide: s };
      }
      if (chosen) setPos(chosen);
    };

    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [visible, side, align, content]);

  // Compose handlers with the child's existing ones so we don't override them.
  const child = children as React.ReactElement<any>;
  const childProps: any = child.props || {};
  const mergedProps: any = {
    ref: (node: HTMLElement) => {
      triggerRef.current = node;
      const r = (child as any).ref;
      if (typeof r === 'function') r(node);
      else if (r && typeof r === 'object') r.current = node;
    },
    onPointerEnter: (e: React.PointerEvent) => {
      childProps.onPointerEnter?.(e);
      show();
    },
    onPointerLeave: (e: React.PointerEvent) => {
      childProps.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e: React.PointerEvent) => {
      childProps.onPointerDown?.(e);
      hide();
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
  };

  return (
    <>
      {React.cloneElement(child, mergedProps)}
      {visible && !isInactive && createPortal(
        // Interactive tooltip: `pointerEvents: 'auto'` lets the user select
        // text and click action-bar buttons. The old `none`-default broke text
        // selection (the click propagated to the trigger underneath, which
        // immediately hid the tip via the trigger's onPointerDown handler).
        // To preserve "tooltip never blocks clicks on the trigger" — we only
        // capture pointer events on the rendered tooltip box, not on the GAP
        // around it (the box is small, clicks outside it still reach the page).
        <div
          ref={tipRef}
          role="tooltip"
          onPointerEnter={interactive ? () => {
            if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
            setInTip(true);
          } : undefined}
          // When the cursor leaves the tooltip body, force-close. Previously
          // only `inTip` was reset — but `hovering` could still be `true` from
          // a trigger→tip transition that cancelled the hide-timer (the timer
          // never fired, so `setHovering(false)` never ran). With `hovering`
          // stuck true, the tip stayed visible even though pointer was outside
          // both elements. Resetting both here makes leave-from-tip terminal;
          // if the cursor lands back on the trigger, its onPointerEnter will
          // flip `hovering` back to true and reopen.
          onPointerLeave={interactive ? () => {
            if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
            setInTip(false);
            setHovering(false);
          } : undefined}
          // Prevent the trigger's onPointerDown from firing while clicks land
          // inside the tooltip body (e.g. clicking the Copy button shouldn't
          // submit the button under the tooltip).
          onPointerDown={interactive ? (e) => { e.stopPropagation(); } : undefined}
          style={{
            position: 'fixed',
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            zIndex: 100000,
            pointerEvents: interactive ? 'auto' : 'none',
            background: '#1a1a1a',
            color: '#e5e5e5',
            border: '1px solid #333',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.35,
            fontFamily: 'inherit',
            maxWidth: 340,
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
            opacity: pos ? 1 : 0, // hide until measured to avoid 1-frame flash at (-9999, -9999)
            display: 'flex',
            flexDirection: 'column',
            // Subtle outline when interactive (mouse is inside) to signal "you
            // can click in here now" — too loud and it competes with the
            // surrounding UI; too subtle and the user doesn't realise the
            // affordance changed.
            outline: interactive && inTip ? '1px solid rgba(255,255,255,0.08)' : 'none',
            outlineOffset: 0,
          }}
        >
          {interactive && actionBar !== false && <div
            data-tooltip-actions
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '3px 6px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              userSelect: 'none',
              fontSize: 10,
              color: '#888',
            }}
          >
            {actionBar === undefined ? <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setHovering(false); setInTip(false); setVisible(false); }}
                title="Закрыть"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontSize: 12,
                  lineHeight: 1,
                  borderRadius: 3,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#fff'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#888'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                ✕
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                title="Копировать содержимое"
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: copied ? '#4ade80' : '#aaa',
                  cursor: 'pointer',
                  padding: '1px 8px',
                  fontSize: 10,
                  lineHeight: 1.4,
                  borderRadius: 3,
                  fontFamily: 'inherit',
                  transition: 'color 120ms, background 120ms',
                }}
                onMouseEnter={(e) => { if (!copied) { (e.currentTarget as HTMLElement).style.color = '#fff'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; } }}
                onMouseLeave={(e) => { if (!copied) { (e.currentTarget as HTMLElement).style.color = '#aaa'; (e.currentTarget as HTMLElement).style.background = 'transparent'; } }}
              >
                {copied ? '✓ Скопировано' : 'Копировать'}
              </button>
            </> : actionBar}
          </div>}
          <div
            data-tooltip-body
            style={{
              padding: '6px 8px',
              whiteSpace: 'pre-wrap',
              userSelect: interactive ? 'text' : 'none',
              cursor: interactive ? 'text' : 'default',
            }}
          >
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
