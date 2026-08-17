import React, { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react';

type FlyoutLayout = {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  /** Which side the card ended up on — decides where the bridge padding goes. */
  placedRight: boolean;
};

interface SideFlyoutProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Reads the live anchor geometry on every measurement. */
  getAnchorRect: () => DOMRect | null;
  /** Preferred side; the flyout flips when that side has no room. */
  side?: 'right' | 'left';
  gap?: number;
  edgePadding?: number;
  zIndex?: number;
}

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

/**
 * A submenu that opens BESIDE its anchor row, the way a nested menu does.
 *
 * The sibling of `CenteredUpwardPopover`: that one is for a menu opening above
 * a control in a bottom bar, this one is for the second level of a vertical
 * menu, where the parent row is the anchor and the choice belongs next to it.
 *
 * Two things it has to get right, both of them classic clipping traps:
 *   • no room on the preferred side → flip to the other one rather than run off
 *     the window (a submenu that fits its parent can still miss the screen);
 *   • taller than the space below its row → lift it up so the bottom edge stays
 *     inside the window, keeping the top aligned with the row whenever it fits.
 */
const SideFlyout = forwardRef<HTMLDivElement, SideFlyoutProps>(
  function SideFlyout(
    {
      getAnchorRect,
      side = 'right',
      gap = 4,
      edgePadding = 8,
      zIndex = 10000,
      style,
      children,
      ...rest
    },
    forwardedRef,
  ) {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [layout, setLayout] = useState<FlyoutLayout | null>(null);

    const setRefs = useCallback((node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      assignRef(forwardedRef, node);
    }, [forwardedRef]);

    const measure = useCallback(() => {
      const anchor = getAnchorRect();
      const wrapper = wrapperRef.current;
      if (!anchor || !wrapper) return;

      const viewportRight = window.innerWidth - edgePadding;
      const viewportBottom = window.innerHeight - edgePadding;
      const width = wrapper.offsetWidth;
      const height = wrapper.offsetHeight;

      const roomRight = viewportRight - anchor.right;
      const roomLeft = anchor.left - edgePadding;
      const preferRight = side === 'right';
      const useRight = preferRight
        ? (roomRight >= width || roomRight >= roomLeft)
        : !(roomLeft >= width || roomLeft >= roomRight);

      // The wrapper starts AT the anchor edge and carries the gap as padding, so
      // the mouse never crosses a dead strip on its way into the card. A plain
      // offset would reopen the classic hover-gap bug where the submenu closes
      // between the row and itself.
      const intendedLeft = useRight
        ? anchor.right
        : anchor.left - width;
      const left = Math.min(
        Math.max(intendedLeft, edgePadding),
        Math.max(edgePadding, viewportRight - width),
      );

      // Vertically CENTRED on the row, not aligned to its top edge: the card is
      // taller than the row it belongs to, and hanging it downward made it read
      // as "below" rather than "beside". Clamped to the window, so a row near
      // an edge shifts the card instead of pushing it off screen.
      const top = Math.min(
        Math.max(anchor.top + anchor.height / 2 - height / 2, edgePadding),
        Math.max(edgePadding, viewportBottom - height),
      );

      const next = {
        left,
        top,
        maxWidth: Math.max(1, (useRight ? viewportRight - left : anchor.left - left)),
        maxHeight: Math.max(1, viewportBottom - top),
        placedRight: useRight,
      };

      setLayout((current) => (
        current
        && current.placedRight === next.placedRight
        && Math.abs(current.left - next.left) < 0.5
        && Math.abs(current.top - next.top) < 0.5
        && Math.abs(current.maxWidth - next.maxWidth) < 0.5
        && Math.abs(current.maxHeight - next.maxHeight) < 0.5
          ? current
          : next
      ));
    }, [edgePadding, gap, getAnchorRect, side]);

    useLayoutEffect(() => {
      measure();
      window.addEventListener('resize', measure);
      // Anchors can live inside nested scroll containers, so capture-phase
      // scroll keeps the fixed portal tied to the row without guessing which
      // ancestor scrolls.
      window.addEventListener('scroll', measure, true);
      const observer = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
      if (observer && wrapperRef.current) observer.observe(wrapperRef.current);
      return () => {
        window.removeEventListener('resize', measure);
        window.removeEventListener('scroll', measure, true);
        observer?.disconnect();
      };
    }, [measure]);

    return (
      <div
        ref={setRefs}
        {...rest}
        style={{
          position: 'fixed',
          left: layout?.left ?? 0,
          top: layout?.top ?? 0,
          maxWidth: layout?.maxWidth ?? `calc(100vw - ${edgePadding * 2}px)`,
          maxHeight: layout?.maxHeight ?? `calc(100vh - ${edgePadding * 2}px)`,
          paddingLeft: layout?.placedRight === false ? 0 : gap,
          paddingRight: layout?.placedRight === false ? gap : 0,
          zIndex,
          visibility: layout ? 'visible' : 'hidden',
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);

export default SideFlyout;
