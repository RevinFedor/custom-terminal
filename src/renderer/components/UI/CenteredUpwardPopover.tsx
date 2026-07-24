import React, { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react';

type PopoverLayout = {
  left: number;
  top: number;
  maxWidth: number;
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
      const timeline = document.querySelector('[data-timeline]') as HTMLElement | null;
      const timelineLeft = timeline?.getBoundingClientRect().left;
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
      const next = { left, top: anchor.top, maxWidth };

      setLayout((current) => (
        current
        && Math.abs(current.left - next.left) < 0.5
        && Math.abs(current.top - next.top) < 0.5
        && Math.abs(current.maxWidth - next.maxWidth) < 0.5
          ? current
          : next
      ));
    }, [edgePadding, getAnchorRect, horizontalAlign]);

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
          paddingBottom: gap,
          transform: 'translateY(-100%)',
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
