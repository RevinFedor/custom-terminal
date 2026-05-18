import React, { useCallback } from 'react';
import TabBar from './TabBar';
import { useUIStore } from '../../store/useUIStore';

// Permanent left column rendering tabs vertically. Hosts <TabBar layout="vertical" />
// and exposes a 6px drag handle on its right edge for width resize. State lives in
// useUIStore.tabSidebarWidth (persisted via the store's localStorage hydration).
const MIN_W = 140;
const MAX_W = 400;

interface TabSidebarProps {
  projectId: string;
}

export default function TabSidebar({ projectId }: TabSidebarProps) {
  const width = useUIStore((s) => s.tabSidebarWidth);
  const setWidth = useUIStore((s) => s.setTabSidebarWidth);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
      setWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width, setWidth]);

  return (
    <div
      className="relative shrink-0 h-full"
      style={{ width, borderTop: '1px solid #5a5a60' }}
    >
      <TabBar projectId={projectId} layout="vertical" />
      <div
        onMouseDown={handleResizeMouseDown}
        style={{
          position: 'absolute',
          right: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 30,
        }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'rgba(99,102,241,0.4)'; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.background = ''; }}
      />
    </div>
  );
}
