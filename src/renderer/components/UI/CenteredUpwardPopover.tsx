import React, { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react';

type PopoverLayout = {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
};

interface CenteredUpwardPopoverProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Reads the live trigger geometry on every measurement. */
  getAnchorRect: () => DOMRect | null;
  horizontalAlign?: 'center' | 'end';
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
 * A portal-friendly wrapper for menus that open above a trigger. It measures
 * the actual card width, aligns it to the trigger, then clamps it to the usable
 * window. Center alignment is the default; compact secondary choices can align
 * their trailing edge to the trigger. A Timeline column only constrains the popup when it is really
 * to the right of the trigger; StatusBar controls that live inside that column
 * still use the full window width.
 */
const CenteredUpwardPopover = forwardRef<HTMLDivElement, CenteredUpwardPopoverProps>(
  function CenteredUpwardPopover(
    {
      getAnchorRect,
      horizontalAlign = 'center',
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
    const [layout, setLayout] = useState<PopoverLayout | null>(null);

    const setRefs = useCallback((node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      assignRef(forwardedRef, node);
    }, [forwardedRef]);

    const measure = useCallback(() => {
      const anchor = getAnchorRect();
      const wrapper = wrapperRef.current;
      if (!anchor || !wrapper) return;

      const viewportRight = window.innerWidth - edgePadding;
      const anchorCenter = anchor.left + anchor.width / 2;
      // Split mode can mount several Timeline columns. The first document
      // match may belong to another pane; constrain against the nearest column
      // actually to the right of this anchor.
      const timelineLeft = Array.from(
        document.querySelectorAll('[data-timeline]') as NodeListOf<HTMLElement>,
      ).map((timeline) => timeline.getBoundingClientRect().left)
        .filter((left) => left > anchorCenter + edgePadding)
        .reduce<number | null>(
          (nearest, left) => nearest === null ? left : Math.min(nearest, left),
          null,
        );
      const rightLimit = timelineLeft != null && timelineLeft > anchorCenter + edgePadding
        ? Math.min(viewportRight, timelineLeft - edgePadding)
        : viewportRight;
      const leftLimit = edgePadding;
      const maxWidth = Math.max(1, rightLimit - leftLimit);
      const width = Math.min(wrapper.offsetWidth, maxWidth);
      const intendedLeft = horizontalAlign === 'end'
        ? anchor.right - width
        : anchorCenter - width / 2;
      const left = Math.min(
        Math.max(intendedLeft, leftLimit),
        Math.max(leftLimit, rightLimit - width),
      );
      // Prefer the space above the trigger, but never let the card leave the
      // application viewport. When a History row sits close to the top after
      // scrolling, clamping the top edge keeps the full card reachable; its
      // own vertical scroller handles the reduced height instead of rendering
      // content behind the title bar/outside the window.
      const viewportBottom = Math.max(edgePadding + 1, window.innerHeight - edgePadding);
      const maxHeight = Math.max(1, viewportBottom - edgePadding);
      const measuredHeight = Math.min(
        Math.max(wrapper.scrollHeight, wrapper.offsetHeight),
        maxHeight,
      );
      // The wrapper includes `gap` as transparent bottom padding. That keeps a
      // continuous hover bridge between trigger and card for menus which close
      // on pointer leave, while the visible card still ends `gap` px above it.
      const intendedTop = anchor.top - measuredHeight;
      const top = Math.min(
        Math.max(intendedTop, edgePadding),
        Math.max(edgePadding, viewportBottom - measuredHeight),
      );
      const next = { left, top, maxWidth, maxHeight };

      setLayout((current) => (
        current
        && Math.abs(current.left - next.left) < 0.5
        && Math.abs(current.top - next.top) < 0.5
        && Math.abs(current.maxWidth - next.maxWidth) < 0.5
        && Math.abs(current.maxHeight - next.maxHeight) < 0.5
          ? current
          : next
      ));
    }, [edgePadding, gap, getAnchorRect, horizontalAlign]);

    useLayoutEffect(() => {
      measure();
      window.addEventListener('resize', measure);
      // Anchors can live inside nested scroll containers (History/Virtuoso,
      // popovers, sidebars). Capture-phase scroll keeps the fixed portal tied
      // to the trigger without assuming which ancestor owns scrolling.
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
          paddingBottom: gap,
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
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

export default CenteredUpwardPopover;
