import React, { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  getSidebarTabDragCursorChip, getSidebarTabDragSnapshot,
  getSidebarTabDragSessionSnapshot, subscribeSidebarTabDrag, subscribeSidebarTabDragSession,
} from '../../utils/sidebarTabDragBridge.mjs';

// Geometry belongs to this small overlay, never to the retained TabBar tree.
export default memo(function SidebarTabDragCursorChip({ enabled }: { enabled: boolean }) {
  const session = useSyncExternalStore(subscribeSidebarTabDragSession, getSidebarTabDragSessionSnapshot, getSidebarTabDragSessionSnapshot);
  const sidebarDragCursorChip = getSidebarTabDragCursorChip(session);
  const chipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!enabled || !sidebarDragCursorChip) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const point = getSidebarTabDragSnapshot();
      const chip = chipRef.current;
      if (!chip || !point.active) return;
      const right = point.clientX + 14;
      const below = point.clientY + 14;
      const left = right + 240 <= window.innerWidth - 8 ? right : Math.max(8, point.clientX - 254);
      const top = below + 34 <= window.innerHeight - 8 ? below : Math.max(8, point.clientY - 48);
      chip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    };
    const unsubscribe = subscribeSidebarTabDrag(() => { if (!frame) frame = requestAnimationFrame(paint); });
    paint();
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, [enabled, session.active, session.metaKey, session.sessionId]);
  return (<>
      {sidebarDragCursorChip && enabled && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={chipRef}
              aria-hidden
              data-sidebar-tab-drag-cursor-chip
              data-drag-session-id={sidebarDragCursorChip.sessionId}
              data-root-tab-id={sidebarDragCursorChip.rootTabId}
              data-tab-count={sidebarDragCursorChip.count}
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                zIndex: 100080,
                maxWidth: 240,
                minHeight: 28,
                padding: '4px 7px 4px 9px',
                borderRadius: 7,
                border: '1px solid rgba(167, 139, 250, 0.72)',
                background: 'rgba(24, 23, 37, 0.96)',
                boxShadow: '0 5px 16px rgba(0, 0, 0, 0.42)',
                color: '#f5f3ff',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                pointerEvents: 'none',
                userSelect: 'none',
                contain: 'layout paint',
                willChange: 'transform',
                transition: 'none',
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  maxWidth: 184,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  fontWeight: 650,
                  lineHeight: '18px',
                }}
              >
                {sidebarDragCursorChip.label}
              </span>
              {sidebarDragCursorChip.count > 1 && (
                <span
                  data-sidebar-tab-drag-cursor-count
                  style={{
                    flexShrink: 0,
                    minWidth: 20,
                    height: 18,
                    padding: '0 5px',
                    borderRadius: 9,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ecfdf5',
                    background: '#15803d',
                    border: '1px solid rgba(255, 255, 255, 0.30)',
                    fontSize: 10,
                    fontWeight: 750,
                    lineHeight: '16px',
                  }}
                >
                  {`×${sidebarDragCursorChip.count}`}
                </span>
              )}
            </div>,
            document.body,
          )
        : null}
  </>);
});
