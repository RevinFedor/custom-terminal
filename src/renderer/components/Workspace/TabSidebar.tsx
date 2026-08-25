import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TabBar from './TabBar';
import { TabLocationLine } from './TabLocationLine';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  getStartupRestoreProgress,
  subscribeStartupRestoreProgress,
} from '../../utils/startupRestoreProgress.mjs';

// Permanent left column rendering tabs vertically. Hosts <TabBar layout="vertical" />
// and exposes a 6px drag handle on its right edge for width resize. State lives in
// useUIStore.tabSidebarWidth (persisted via the store's localStorage hydration).
//
// Project tools now live in the single App-owned WorkspaceNavigationRow so the
// same row survives Dashboard ↔ Workspace. The location line remains here: it
// describes the active tab inside this project's actual sidebar.
const MIN_W = 140;
const MAX_W = 400;

// Hidden project sidebars are built once, one per idle frame, then retained.
// The queue is app-wide so opening several projects cannot start several
// expensive row trees in the same frame.
const sidebarWarmQueue: Array<() => void> = [];
let sidebarWarmPumping = false;

function pumpSidebarWarmQueue() {
  if (sidebarWarmPumping) return;
  sidebarWarmPumping = true;
  const step = () => {
    const next = sidebarWarmQueue.shift();
    if (next) next();
    if (sidebarWarmQueue.length > 0) requestAnimationFrame(step);
    else sidebarWarmPumping = false;
  };
  const browser = window as unknown as {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  };
  if (typeof browser.requestIdleCallback === 'function') {
    browser.requestIdleCallback(() => requestAnimationFrame(step), { timeout: 5000 });
  } else {
    requestAnimationFrame(step);
  }
}

function enqueueSidebarWarm(wake: () => void) {
  sidebarWarmQueue.push(wake);
  pumpSidebarWarmQueue();
}

function cancelSidebarWarm(wake: () => void) {
  const index = sidebarWarmQueue.indexOf(wake);
  if (index >= 0) sidebarWarmQueue.splice(index, 1);
}

interface TabSidebarProps {
  projectId: string;
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
}

function TabSidebarComponent({
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

const TabSidebar = React.memo(TabSidebarComponent);

interface PersistentTabSidebarStackProps {
  projectIds: string[];
  presentedProjectId: string;
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
}

/**
 * One live sidebar surface per project.
 *
 * Data was already durable and cached, but the old UI had ONE React tree whose
 * `projectId` prop changed on workflow focus. That rebuilt 17/47 rows after the
 * pane layout was already ready. These layers use the same contract as pane
 * surfaces: exact DOM identity is retained, presentation changes only
 * opacity/inert, and unopened projects prewarm serially after startup.
 */
export function PersistentTabSidebarStack({
  projectIds,
  presentedProjectId,
  processStatus,
  busyTabs,
  pasteBusyTabs,
}: PersistentTabSidebarStackProps) {
  const width = useUIStore((state) => state.tabSidebarWidth);
  const projectIdsKey = projectIds.join('\u0000');
  const effectivePresentedProjectId = projectIds.includes(presentedProjectId)
    ? presentedProjectId
    : (projectIds[0] || '');
  const [awokenProjectIds, setAwokenProjectIds] = useState<Set<string>>(
    () => new Set(effectivePresentedProjectId ? [effectivePresentedProjectId] : []),
  );
  const awokenProjectIdsRef = useRef(awokenProjectIds);
  awokenProjectIdsRef.current = awokenProjectIds;

  // A project reached directly before its idle turn still mounts immediately
  // and is retained from the following passive commit onward. Closed projects
  // are removed so their row subscriptions and DnD registrations are released.
  useEffect(() => {
    const live = new Set(projectIds);
    setAwokenProjectIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => live.has(id)));
      if (effectivePresentedProjectId && live.has(effectivePresentedProjectId)) {
        next.add(effectivePresentedProjectId);
      }
      if (next.size === previous.size && Array.from(next).every((id) => previous.has(id))) {
        return previous;
      }
      awokenProjectIdsRef.current = next;
      return next;
    });
  }, [effectivePresentedProjectId, projectIdsKey]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeStartup: (() => void) | null = null;
    const wakes: Array<() => void> = [];
    const enqueue = () => {
      if (cancelled) return;
      for (const projectId of projectIds) {
        if (!projectId || awokenProjectIdsRef.current.has(projectId)) continue;
        const wake = () => {
          if (cancelled || awokenProjectIdsRef.current.has(projectId)) return;
          const startedAt = performance.now();
          console.warn('[Perf:SidebarWake] phase=start project=' + projectId.slice(-12)
            + ' queue=' + sidebarWarmQueue.length);
          setAwokenProjectIds((previous) => {
            if (previous.has(projectId)) return previous;
            const next = new Set(previous);
            next.add(projectId);
            awokenProjectIdsRef.current = next;
            return next;
          });
          requestAnimationFrame(() => {
            console.warn('[Perf:SidebarWake] phase=painted project=' + projectId.slice(-12)
              + ' durMs=' + (performance.now() - startedAt).toFixed(1));
          });
        };
        wakes.push(wake);
        enqueueSidebarWarm(wake);
      }
    };
    if (getStartupRestoreProgress().blocking) {
      unsubscribeStartup = subscribeStartupRestoreProgress((state: { blocking?: boolean }) => {
        if (state.blocking) return;
        unsubscribeStartup?.();
        unsubscribeStartup = null;
        enqueue();
      });
    } else {
      enqueue();
    }
    return () => {
      cancelled = true;
      unsubscribeStartup?.();
      wakes.forEach(cancelSidebarWarm);
    };
  }, [projectIdsKey]);

  const renderedProjectIds = useMemo(() => projectIds.filter(
    (projectId) => projectId === effectivePresentedProjectId || awokenProjectIds.has(projectId),
  ), [awokenProjectIds, effectivePresentedProjectId, projectIdsKey]);

  return (
    <div
      data-persistent-tab-sidebar-stack
      style={{ position: 'relative', flexShrink: 0, width, height: '100%', minHeight: 0 }}
    >
      {renderedProjectIds.map((projectId) => {
        const presented = projectId === effectivePresentedProjectId;
        return (
          <div
            key={projectId}
            data-tab-sidebar-layer={projectId}
            data-sidebar-presented={presented ? '1' : '0'}
            inert={!presented}
            aria-hidden={!presented}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: presented ? 1 : 0,
              visibility: 'visible',
              pointerEvents: presented ? 'auto' : 'none',
              zIndex: presented ? 1 : 0,
              willChange: 'opacity',
              transition: 'none',
            }}
          >
            <TabSidebar
              projectId={projectId}
              processStatus={processStatus}
              busyTabs={busyTabs}
              pasteBusyTabs={pasteBusyTabs}
            />
          </div>
        );
      })}
    </div>
  );
}

export default TabSidebar;
