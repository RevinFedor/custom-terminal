import React, { useCallback } from 'react';
import TabBar from './TabBar';
import { TabLocationLine } from './TabLocationLine';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

// Permanent left column rendering tabs vertically. Hosts <TabBar layout="vertical" />
// and exposes a 6px drag handle on its right edge for width resize. State lives in
// useUIStore.tabSidebarWidth (persisted via the store's localStorage hydration).
//
// Project tools now live in the single App-owned WorkspaceNavigationRow so the
// same row survives Dashboard ↔ Workspace. The location line remains here: it
// describes the active tab inside this project's actual sidebar.
const MIN_W = 140;
const MAX_W = 400;

interface TabSidebarProps {
  projectId: string;
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
}

export default function TabSidebar({
  projectId,
  processStatus,
  busyTabs,
  pasteBusyTabs,
}: TabSidebarProps) {
  const width = useUIStore((s) => s.tabSidebarWidth);
  const setWidth = useUIStore((s) => s.setTabSidebarWidth);
  // Путь АКТИВНОЙ вкладки проекта — строкой под инструментами. Раньше строка
  // пути стояла в шапке КАЖДОГО окна и съедала там по строке на окно ради
  // подписи, которая нужна изредка (юзер: «лишняя строчка под вкладкой,
  // которая путь занимает целую строку»). Здесь она одна на панель и стоит
  // там же, откуда открываются файлы проекта.
  const activeTabId = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.activeTabId || ''
  ));

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
      data-tab-sidebar
      data-keyboard-focus-surface="sidebar"
      className="relative shrink-0 h-full flex flex-col min-h-0"
      // Своей верхней линии у панели больше нет. Она рисовала границу под
      // удалённой полосой кнопок — короткую, обрывавшуюся на краю сайдбара.
      // Теперь сверху шапка со своей линией во всю ширину, и вторая давала бы
      // двойную черту шириной ровно с эту панель.
      //
      // Своего z у панели НЕТ намеренно. Боковая панель окна ложится поверх
      // этого списка простым порядком слоёв (окно позиционировано с z, список
      // без него) — так попросили («терминал должен перекрывать боковое
      // меню»). Дать списку z значило бы завести ему стек-контекст, и меню
      // вкладок, которые рендерятся внутри без порталов (z 100030), оказались
      // бы прижаты ПОД поднятое окно.
      style={{ width }}
      onPointerDownCapture={(event) => {
        if (event.button === 0) useUIStore.getState().setActiveArea('sidebar');
      }}
    >
      {activeTabId && (
        <div
          data-sidebar-location-line
          style={{ padding: '3px 8px 4px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <TabLocationLine projectId={projectId} tabId={activeTabId} />
        </div>
      )}
      <div className="flex-1 min-h-0">
        <TabBar
          projectId={projectId}
          layout="vertical"
          sharedProcessStatus={processStatus}
          sharedBusyTabs={busyTabs}
          sharedPasteBusyTabs={pasteBusyTabs}
        />
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
