import React, { useCallback } from 'react';
import TabBar from './TabBar';
import SidebarToolsRow from './SidebarToolsRow';
import { useUIStore } from '../../store/useUIStore';

// Permanent left column rendering tabs vertically. Hosts <TabBar layout="vertical" />
// and exposes a 6px drag handle on its right edge for width resize. State lives in
// useUIStore.tabSidebarWidth (persisted via the store's localStorage hydration).
//
// Первой строкой здесь стоят инструменты проекта (SidebarToolsRow) — они
// переехали из полосы во всю ширину окна, которая жила под шапкой. Всё, что там
// было, относится к тому же проекту, чей список вкладок идёт ниже, поэтому
// кнопки стоят над своим списком, а не тянутся через весь экран.
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
      className="relative shrink-0 h-full flex flex-col min-h-0"
      // Своей верхней линии у панели больше нет. Она рисовала границу под
      // удалённой полосой кнопок — короткую, обрывавшуюся на краю сайдбара.
      // Теперь сверху шапка со своей линией во всю ширину, и вторая давала бы
      // двойную черту шириной ровно с эту панель.
      style={{ width }}
    >
      <SidebarToolsRow projectId={projectId} />
      <div className="flex-1 min-h-0">
        <TabBar projectId={projectId} layout="vertical" />
      </div>
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
