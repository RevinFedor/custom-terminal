import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';

// ─── useCmdKey ───────────────────────────────────────────────
// Tracks CMD (Meta) key state. One instance per component.

export function useCmdKey(enabled = true): boolean {
  const [pressed, setPressed] = useState(false);
  const physical = useRef(false), projected = useRef(false), relevant = useRef(enabled);
  relevant.current = enabled;
  const sync = useCallback((held: boolean) => {
    physical.current = held;
    const next = held && relevant.current;
    if (next === projected.current) return;
    projected.current = next;setPressed(next);
  }, []);
  // A retained owner remembers the physical key without rendering. Entering
  // its hover surface while Cmd is already held reveals feedback in this frame.
  useLayoutEffect(() => { sync(physical.current); }, [enabled, sync]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Meta') sync(true); };
    const up   = (e: KeyboardEvent) => { if (e.key === 'Meta') sync(false); };
    const blur = () => sync(false);
    // Самокоррекция по фактическому состоянию клавиши. keyup по Meta теряется,
    // когда отпускание случилось «не здесь»: во время системного шортката,
    // нативного меню, перетаскивания или пока фокус был у другого окна (blur
    // ловит не все такие пути). Залипший флаг рисовал ⌘-подсказки без зажатого
    // ⌘ («плашка "добавить в это окно", а CMD уже отпущен»). Каждое движение
    // мыши несёт правду в e.metaKey. Не вызываем setState вообще, если
    // проекция не менялась: скрытые владельцы остаются вне React hot path.
    const move = (e: MouseEvent) => sync(e.metaKey === true);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('mousemove', move, true);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('mousemove', move, true);
    };
  }, [sync]);

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
  /**
   * Закреп: CMD+Shift над trigger'ом → popover становится «прибитым». В locked
   * состоянии все hover-выходы / переключения на другие триггеры игнорируются.
   * Снимается повторным CMD+Shift или любым mousedown в приложении вне popover'а
   * (popover-элемент должен иметь атрибут `data-cmd-hover-popover` чтобы внутренние
   * клики/drag'и не разлочивали).
   */
  isLocked: boolean;
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
  /** Toggle lock (used by external triggers if нужно). */
  toggleLock: () => void;
}

export function useCmdHoverPopover<T>(
  isCmdPressed: boolean,
  bridgeTimeout = 150,
): CmdHoverPopoverReturn<T> {
  const [hoveredItem, setHoveredItem] = useState<HoveredItem<T> | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const closeRef = useRef<NodeJS.Timeout | null>(null);
  // Зеркала state'а для синхронного чтения в keydown/mousedown слушателях:
  // window-handlers замыкают первое значение state'а на момент подписки.
  const isLockedRef = useRef(false);
  const hoveredItemRef = useRef<HoveredItem<T> | null>(null);
  useEffect(() => { isLockedRef.current = isLocked; }, [isLocked]);
  useEffect(() => { hoveredItemRef.current = hoveredItem; }, [hoveredItem]);

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
    // В locked-режиме игнорируем перенаведение на другие триггеры —
    // popover остаётся прибитым к исходному элементу.
    if (isLockedRef.current) return;
    cancelClose();
    setHoveredItem({ id, rect });
  }, [cancelClose]);

  const clearHovered = useCallback((id: T) => {
    if (isLockedRef.current) return;
    closeRef.current = setTimeout(() => {
      setHoveredItem(prev => (prev && prev.id === id ? null : prev));
      closeRef.current = null;
    }, bridgeTimeout);
  }, [bridgeTimeout]);

  const triggerProps = useCallback((id: T) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      if (isLockedRef.current) return;
      cancelClose();
      setHoveredItem({ id, rect: e.currentTarget.getBoundingClientRect() });
    },
    onMouseLeave: () => {
      if (isLockedRef.current) return;
      closeRef.current = setTimeout(() => {
        setHoveredItem(prev => (prev && prev.id === id ? null : prev));
        closeRef.current = null;
      }, bridgeTimeout);
    },
  }), [bridgeTimeout, cancelClose]);

  const popoverProps = useMemo(() => ({
    onMouseEnter: () => {
      if (isLockedRef.current) return;
      cancelClose();
      setIsPinned(true);
    },
    onMouseLeave: () => {
      if (isLockedRef.current) return;
      setHoveredItem(null);
      setIsPinned(false);
      cancelClose();
    },
  }), [cancelClose]);

  const close = useCallback(() => {
    setHoveredItem(null);
    setIsPinned(false);
    setIsLocked(false);
    cancelClose();
  }, [cancelClose]);

  const toggleLock = useCallback(() => {
    // Закреплять можно только когда есть hovered trigger — снаружи бессмысленно.
    if (!hoveredItemRef.current && !isLockedRef.current) return;
    setIsLocked(prev => {
      const next = !prev;
      // При закрепе popover остаётся видимым даже без CMD — pin сохраняем.
      // При снятии замка естественный hover-life-cycle продолжится: если
      // курсор сейчас вне triggers/popover, mouseleave уже зависел от lock,
      // поэтому даём пользователю шанс уйти штатно — просто снимаем lock,
      // ничего не закрываем сразу.
      if (next) setIsPinned(true);
      return next;
    });
  }, []);

  // ─── Глобальные слушатели для lock-режима ──────────────────
  useEffect(() => {
    // CMD+Shift toggle. Любое нажатие Shift при зажатом Meta — переключает
    // закреп. Срабатывает только если есть текущий hovered item ИЛИ popover
    // уже залочен (чтобы снять).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && e.metaKey) {
        if (!hoveredItemRef.current && !isLockedRef.current) return;
        e.preventDefault();
        toggleLock();
      }
    };
    // Mousedown вне popover'а в locked-режиме снимает lock + закрывает.
    // Popover-обёртки в TabPreviewPopover помечены `data-cmd-hover-popover`
    // — клики/drag'и внутри них (resize handles, текст) не разлочивают.
    const onMouseDown = (e: MouseEvent) => {
      if (!isLockedRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-cmd-hover-popover]')) return;
      setIsLocked(false);
      setIsPinned(false);
      setHoveredItem(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [toggleLock]);

  const isVisible = (isCmdPressed || isPinned || isLocked) && hoveredItem !== null;

  return { hoveredItem, isVisible, isLocked, triggerProps, setHovered, clearHovered, popoverProps, close, toggleLock };
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
