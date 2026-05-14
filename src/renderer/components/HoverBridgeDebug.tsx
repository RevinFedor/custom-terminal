import React, { useEffect, useState } from 'react';
import { useUIStore } from '../store/useUIStore';

// Visualises the implicit hover-bridge between a trigger element and its popup.
// Used to debug "popup disappears when I move toward it" cases.
//
// `containerRef` — the trigger / anchor (e.g. Timeline strip or a button).
// `menuRef`      — the floating popup root.
//
// The bridge rectangle covers the horizontal gap between the popup and the
// trigger at the popup's vertical extent (plus a few px padding). Logic mirrors
// the bridge hit-test in Timeline.tsx and CopySessionButton.tsx — keep in sync.
//
// Rendered ONLY when `debugHoverBridges` is on in the status bar.
// Pointer-events disabled so it never interferes with real input.
export default function HoverBridgeDebug({
  containerRef,
  menuRef,
  // direction: 'left' = popup is to the LEFT of the trigger (bridge between popup.right and trigger.left)
  //            'right' = popup is to the RIGHT
  //            'above' = popup is ABOVE (bridge between popup.bottom and trigger.top)
  //            'below' = popup is BELOW (bridge between popup.top and trigger.bottom)  ← default
  direction = 'left',
  padding = 8,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  menuRef: React.RefObject<HTMLElement | null>;
  direction?: 'left' | 'right' | 'above' | 'below';
  padding?: number;
}) {
  const enabled = useUIStore((s) => s.debugHoverBridges);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!enabled) { setRect(null); return; }
    let raf = 0;
    const measure = () => {
      const tlEl = containerRef.current;
      const menuEl = menuRef.current;
      if (!tlEl || !menuEl) { setRect(null); return; }
      const tl = tlEl.getBoundingClientRect();
      const m = menuEl.getBoundingClientRect();
      let r: { left: number; top: number; width: number; height: number } | null = null;
      if (direction === 'left') {
        r = {
          left: m.right,
          top: Math.min(m.top, tl.top) - padding,
          width: Math.max(0, tl.left - m.right),
          height: Math.max(m.bottom, tl.bottom) - Math.min(m.top, tl.top) + 2 * padding,
        };
      } else if (direction === 'right') {
        r = {
          left: tl.right,
          top: Math.min(m.top, tl.top) - padding,
          width: Math.max(0, m.left - tl.right),
          height: Math.max(m.bottom, tl.bottom) - Math.min(m.top, tl.top) + 2 * padding,
        };
      } else if (direction === 'above') {
        r = {
          left: Math.min(m.left, tl.left) - padding,
          top: m.bottom,
          width: Math.max(m.right, tl.right) - Math.min(m.left, tl.left) + 2 * padding,
          height: Math.max(0, tl.top - m.bottom),
        };
      } else {
        // below — popup directly under trigger
        r = {
          left: Math.min(m.left, tl.left) - padding,
          top: tl.bottom,
          width: Math.max(m.right, tl.right) - Math.min(m.left, tl.left) + 2 * padding,
          height: Math.max(0, m.top - tl.bottom),
        };
      }
      setRect(r);
    };
    measure();
    // The popup may animate or measure async; re-measure each frame as long as enabled.
    const tick = () => { measure(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, direction, padding, containerRef, menuRef]);

  if (!enabled || !rect) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: 'rgba(239, 68, 68, 0.30)',
        border: '1px dashed rgba(239, 68, 68, 0.8)',
        pointerEvents: 'none',
        zIndex: 99999,
      }}
    />
  );
}
