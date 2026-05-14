import React, { useState, useRef, useLayoutEffect, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right' | 'auto';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: Side;
  // Optional delay in ms (default 0 = instant — the whole point of this component).
  delay?: number;
  // Allow disabling without removing call sites; falsy content also disables.
  disabled?: boolean;
  // When true, tooltip shows on hover regardless of Cmd state. Default false:
  // the tooltip only appears when Cmd is held — most UI is self-explanatory and
  // tooltip-spam is noise. Reserve `always` for genuinely opaque controls.
  always?: boolean;
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
  delay = 0,
  disabled = false,
  always = false,
}: TooltipProps) {
  const [hovering, setHovering] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; arrowSide: Side } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmd = useCmdHeld();

  const isInactive = disabled || !content;
  // Gate: by default tooltip only appears while Cmd is held. `always` opts out.
  const allowedToShow = always || cmd;

  // Auto show/hide based on (hovering AND allowed). Means: pressing Cmd while
  // already hovering pops the tip instantly; releasing Cmd hides it instantly.
  useEffect(() => {
    if (isInactive) { setVisible(false); return; }
    if (hovering && allowedToShow) {
      if (delay <= 0) setVisible(true);
      else {
        if (showTimerRef.current) clearTimeout(showTimerRef.current);
        showTimerRef.current = setTimeout(() => setVisible(true), delay);
      }
    } else {
      if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
      setVisible(false);
    }
  }, [hovering, allowedToShow, isInactive, delay]);

  const show = useCallback(() => {
    if (isInactive) return;
    setHovering(true);
  }, [isInactive]);

  const hide = useCallback(() => {
    setHovering(false);
  }, []);

  useLayoutEffect(() => () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
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
            top = t.top + t.height / 2 - p.height / 2;
            if (left < PADDING) ok = false;
            break;
          case 'right':
            left = t.right + GAP;
            top = t.top + t.height / 2 - p.height / 2;
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
  }, [visible, side, content]);

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
        <div
          ref={tipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            zIndex: 100000,
            pointerEvents: 'none',
            background: '#1a1a1a',
            color: '#e5e5e5',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            lineHeight: 1.35,
            fontFamily: 'inherit',
            maxWidth: 340,
            whiteSpace: 'pre-wrap',
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
            opacity: pos ? 1 : 0, // hide until measured to avoid 1-frame flash at (-9999, -9999)
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
