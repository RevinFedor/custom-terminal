import {uiDragDiagnostic} from '../../utils/uiPerformanceDiagnostics.mjs';
import {getPaneTabPointerSnapshot} from '../../utils/paneTabPointerBridge';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import NavigationDwellStroke from './NavigationDwellStroke';
import {beginNavigationDwell,TAB_DRAG_NAVIGATION_DWELL_MS} from '../../utils/navigationDwell.mjs';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  getTabDragNavigationSnapshot,
  subscribeTabDragNavigationPointer,
  useTabDragNavigationSnapshot,
} from '../../utils/tabDragNavigationBridge';

export {TAB_DRAG_NAVIGATION_DWELL_MS};

export default function TabDragNavigationController({
  onNavigateProject,
}: {
  onNavigateProject: (projectId: string) => void | Promise<void>;
}) {
  const snapshot = useTabDragNavigationSnapshot();
  const indicatorRef = useRef<HTMLDivElement>(null);
  const projectCallbackRef = useRef(onNavigateProject);
  projectCallbackRef.current = onNavigateProject;

  useLayoutEffect(() => {
    let frame = 0;
    const paint = () => {
      frame = 0;
      const point = getTabDragNavigationSnapshot().target;
      if (indicatorRef.current && point) {
        indicatorRef.current.style.transform = `translate3d(${point.clientX - 12}px, ${point.clientY - 12}px, 0)`;
      }
    };
    const unsubscribe = subscribeTabDragNavigationPointer(() => {
      if (!frame) frame = requestAnimationFrame(paint);
    });
    paint();
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, [snapshot.cycle]);

  useEffect(() => {
    const target = snapshot.target;
    if (!target || target.blocked) return undefined;
    const cycle = snapshot.cycle;
    const startedAt = performance.now();
    return beginNavigationDwell({isCurrent:()=>{
      const current = getTabDragNavigationSnapshot();
      return current.cycle===cycle&&current.target?.kind===target.kind&&current.target?.id===target.id&&!current.target?.blocked;
    },onComplete:()=>{
      const current = getTabDragNavigationSnapshot();
      console.log('[TabDnd:navigate] kind=' + target.kind + ' id=' + target.id + ' source=' + current.source
        + ' cycle=' + cycle + ' waitMs=' + (performance.now() - startedAt).toFixed(1));
      uiDragDiagnostic('navigation-accepted',{gestureId:getPaneTabPointerSnapshot().source?.gestureId,
        workflowId:target.kind==='workflow'?target.id:undefined,revision:cycle,owner:current.source});
      if (target.kind === 'workflow') {
        useWorkspaceStore.getState().switchWorkspaceSpace(target.id);
      } else {
        void projectCallbackRef.current(target.id);
      }
    }});
  }, [snapshot.cycle, snapshot.target?.blocked, snapshot.target?.id, snapshot.target?.kind]);

  const target = snapshot.target;
  if (!target || target.blocked || typeof document === 'undefined') return null;
  const circumference = 2 * Math.PI * 9;
  return ReactDOM.createPortal(
    <div
      ref={indicatorRef}
      key={`${target.kind}:${target.id}:${snapshot.cycle}`}
      data-tab-drag-navigation-indicator
      data-navigation-kind={target.kind}
      data-navigation-id={target.id}
      aria-hidden
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 24,
        height: 24,
        zIndex: 100000,
        pointerEvents: 'none',
        contain: 'strict',
        willChange: 'transform',
        overflow: 'visible',
      }}
    >
      <svg
        width="24" height="24" viewBox="0 0 24 24"
        style={{
          display: 'block',
          filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.7))',
          transform: 'rotate(-90deg)',
        }}
      >
        <NavigationDwellStroke length={circumference} attributes={{cx:12,cy:12,r:9}} trackFill="rgba(20,20,24,0.78)"/>
        <circle cx="12" cy="12" r="2" fill="#ddd6fe" />
      </svg>
    </div>,
    document.body,
  );
}
