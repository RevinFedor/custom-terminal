import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// ─── useCmdKey ───────────────────────────────────────────────
// Tracks CMD (Meta) key state. One instance per component.

export function useCmdKey(): boolean {
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Meta') setPressed(true); };
    const up   = (e: KeyboardEvent) => { if (e.key === 'Meta') setPressed(false); };
    const blur = () => setPressed(false);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return pressed;
}

// ─── useCmdHoverPopover ──────────────────────────────────────
// State machine: CMD tracking + hovered item + bridge timeout + pinning.
// Generic over item ID type (string, number, etc).

export interface HoveredItem<T> {
  id: T;
  rect: DOMRect;
}

export interface CmdHoverPopoverReturn<T> {
  hoveredItem: HoveredItem<T> | null;
  isVisible: boolean;
  /** Spread on trigger element: { onMouseEnter, onMouseLeave } */
  triggerProps: (id: T) => {
    onMouseEnter: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
  };
  /** Manual control — for cases where trigger is a child component callback */
  setHovered: (id: T, rect: DOMRect) => void;
  clearHovered: (id: T) => void;
  /** Spread on popover element */
  popoverProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
  /** Force close */
  close: () => void;
}

export function useCmdHoverPopover<T>(
  isCmdPressed: boolean,
  bridgeTimeout = 150,
): CmdHoverPopoverReturn<T> {
  const [hoveredItem, setHoveredItem] = useState<HoveredItem<T> | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const closeRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup on unmount
  useEffect(() => () => {
    if (closeRef.current) clearTimeout(closeRef.current);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeRef.current) {
      clearTimeout(closeRef.current);
      closeRef.current = null;
    }
  }, []);

  const setHovered = useCallback((id: T, rect: DOMRect) => {
    cancelClose();
    setHoveredItem({ id, rect });
  }, [cancelClose]);

  const clearHovered = useCallback((id: T) => {
    closeRef.current = setTimeout(() => {
      setHoveredItem(prev => (prev && prev.id === id ? null : prev));
      closeRef.current = null;
    }, bridgeTimeout);
  }, [bridgeTimeout]);

  const triggerProps = useCallback((id: T) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      cancelClose();
      setHoveredItem({ id, rect: e.currentTarget.getBoundingClientRect() });
    },
    onMouseLeave: () => {
      closeRef.current = setTimeout(() => {
        setHoveredItem(prev => (prev && prev.id === id ? null : prev));
        closeRef.current = null;
      }, bridgeTimeout);
    },
  }), [bridgeTimeout, cancelClose]);

  const popoverProps = useMemo(() => ({
    onMouseEnter: () => {
      cancelClose();
      setIsPinned(true);
    },
    onMouseLeave: () => {
      setHoveredItem(null);
      setIsPinned(false);
      cancelClose();
    },
  }), [cancelClose]);

  const close = useCallback(() => {
    setHoveredItem(null);
    setIsPinned(false);
    cancelClose();
  }, [cancelClose]);

  const isVisible = (isCmdPressed || isPinned) && hoveredItem !== null;

  return { hoveredItem, isVisible, triggerProps, setHovered, clearHovered, popoverProps, close };
}

// ─── getPopoverPosition ──────────────────────────────────────
// Pure function: DOMRect → style + maxHeight. Smart above/below.

export function getPopoverPosition(
  rect: DOMRect,
  opts?: { maxHeight?: number },
): { style: React.CSSProperties; maxHeight: number; showAbove: boolean } {
  const cap = opts?.maxHeight || 350;
  const spaceBelow = window.innerHeight - rect.bottom;
  const showAbove = spaceBelow < 160;
  const maxHeight = showAbove
    ? Math.min(rect.top - 16, cap)
    : Math.min(spaceBelow - 16, cap);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: rect.left,
    zIndex: 100,
    ...(showAbove
      ? { top: rect.top, paddingBottom: '4px', transform: 'translateY(-100%)' }
      : { top: rect.bottom, paddingTop: '4px' }),
  };

  return { style, maxHeight, showAbove };
}

// ─── CmdHoverPopover ─────────────────────────────────────────
// Thin wrapper: fixed positioning + card styling.
// Handles both "always below" and "smart" placement.

interface CmdHoverPopoverProps {
  rect: DOMRect;
  popoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  width?: number;
  maxHeight?: number;
  smartPosition?: boolean;
  children: React.ReactNode;
}

export function CmdHoverPopover({
  rect,
  popoverProps,
  width = 340,
  maxHeight: maxHeightProp,
  smartPosition = false,
  children,
}: CmdHoverPopoverProps) {
  const pos = smartPosition
    ? getPopoverPosition(rect, { maxHeight: maxHeightProp })
    : {
        style: {
          position: 'fixed' as const,
          left: rect.left,
          top: rect.bottom,
          paddingTop: '4px',
          zIndex: 100,
        },
        maxHeight: maxHeightProp || 350,
      };

  return (
    <div style={pos.style} {...popoverProps}>
      <div
        style={{
          width: `${width}px`,
          maxHeight: `${pos.maxHeight}px`,
          backgroundColor: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}
