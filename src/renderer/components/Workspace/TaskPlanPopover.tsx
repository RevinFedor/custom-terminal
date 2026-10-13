import React, { createContext, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceOverlayTarget } from '../../hooks/useWorkspaceOverlayTarget';
import { placeLinkedFilePopup } from '../../utils/tabLinkedFiles.mjs';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import { uiPerformancePhase } from '../../utils/uiPerformanceDiagnostics.mjs';
import { isTaskPlanChildDismissal } from '../../utils/taskPlanPopupDismissal.mjs';

export const TaskPlanPopupOwner = createContext<string | undefined>(undefined);

/** Only an open surface installs listeners. Hover preview never owns keyboard focus. */
export default function TaskPlanPopover({
  owner, tabId, anchor, panel, mode, childrenOpen = false, onClose, children,
}: {
  owner: string;
  tabId: string;
  anchor: HTMLElement;
  panel: HTMLElement;
  mode: 'preview' | 'editor';
  childrenOpen?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const target = useWorkspaceOverlayTarget();
  const popup = useRef<HTMLDivElement>(null);
  const backdrops = useRef<Array<HTMLDivElement | null>>([]);
  const childDismiss = useRef(false);
  const latest = useRef({ childrenOpen, onClose });
  latest.current = { childrenOpen, onClose };
  const hasChild = () => latest.current.childrenOpen || !!document.querySelector(
    `:is([data-task-plan-file-picker],[data-task-plan-editor-menu])[data-task-plan-popup-owner="${CSS.escape(owner)}"]`,
  );

  useLayoutEffect(() => {
    const node = popup.current;
    if (!node) return;
    let source: DOMRect, bounds: DOMRect, positioned = false;
    const position = () => {
      const started = performance.now();
      const root = panel.getBoundingClientRect();
      const l = Math.max(0, Math.min(innerWidth, root.left)), r = Math.max(l, Math.min(innerWidth, root.right));
      const t = Math.max(0, Math.min(innerHeight, root.top)), b = Math.max(t, Math.min(innerHeight, root.bottom));
      const regions = [[0, 0, innerWidth, t], [0, b, innerWidth, innerHeight - b], [0, t, l, b - t], [r, t, innerWidth - r, b - t]];
      backdrops.current.forEach((element, i) => {
        if (element) Object.assign(element.style, { left: `${regions[i][0]}px`, top: `${regions[i][1]}px`, width: `${regions[i][2]}px`, height: `${regions[i][3]}px` });
      });
      source = anchor.getBoundingClientRect();
      if (!anchor.isConnected || root.width === 0 || source.height === 0) {
        latest.current.onClose();
        return;
      }
      const widthLimit = Math.max(0, Math.min(
        mode === 'preview' ? root.width - 12 : 380,
        innerWidth - 16,
      ));
      node.style.maxWidth = `${widthLimit}px`;
      node.style.width = mode === 'preview' ? 'max-content' : `${widthLimit}px`;
      node.style.maxHeight = `${Math.max(0, innerHeight - 16)}px`;
      const width = node.getBoundingClientRect().width;
      const height = Math.min(node.scrollHeight + 2, innerHeight - 16);
      if (mode === 'preview') {
        const placement = placeLinkedFilePopup(
          { left: root.left + 4, top: source.top, bottom: source.bottom },
          { width, height }, { width: innerWidth, height: innerHeight }, 3,
        );
        node.style.left = `${placement.left}px`;
        node.style.top = `${placement.top}px`;
        node.style.maxHeight = `${placement.maxHeight}px`;
      } else {
        const right = root.right + 4;
        const left = right + width <= innerWidth - 8 ? right
          : root.left - width - 4 >= 8 ? root.left - width - 4
            : Math.max(8, Math.min(root.left, innerWidth - width - 8));
        const top = left >= root.right || left + width <= root.left
          ? source.top : source.bottom + 4;
        node.style.left = `${left}px`;
        node.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
      }
      node.style.visibility = 'visible';
      bounds = node.getBoundingClientRect();
      if (!positioned) {
        positioned = true;
        node.querySelector<HTMLElement>('[data-task-plan-autofocus]')?.focus({ preventScroll: true });
      }
      uiPerformancePhase('task-plan-popup', { mode, ms: performance.now() - started });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel); observer.observe(anchor); observer.observe(node);
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && !event.target.contains(anchor)) return;
      position();
    };
    const ownedChild = (element: EventTarget | null) => element instanceof Element
      && element.closest('[data-task-plan-popup-owner]')?.getAttribute('data-task-plan-popup-owner') === owner;
    const outside = (event: MouseEvent) => {
      if (isTaskPlanChildDismissal(event, owner)) return;
      if (hasChild() || ownedChild(event.target)) return;
      if (event.target instanceof Node && (node.contains(event.target) || panel.contains(event.target))) return;
      // Preserve the input until the parent has committed its draft. An outside
      // dismissal does not also activate a control underneath the popup.
      if (mode === 'editor') { event.preventDefault(); event.stopPropagation(); }
      latest.current.onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || latest.current.childrenOpen) return;
      event.preventDefault(); event.stopPropagation(); latest.current.onClose();
    };
    const move = (event: MouseEvent) => {
      if (!bounds || !source || ownedChild(event.target)) return;
      const inside = (r: DOMRect) => event.clientX >= r.left - 2 && event.clientX <= r.right + 2
        && event.clientY >= r.top - 2 && event.clientY <= r.bottom + 2;
      if (inside(source) || inside(bounds)) return;
      const gapTop = Math.min(source.bottom, bounds.bottom);
      const gapBottom = Math.max(source.top, bounds.top);
      const inGap = event.clientY >= gapTop - 2 && event.clientY <= gapBottom + 2
        && event.clientX >= Math.min(source.left, bounds.left) - 2
        && event.clientX <= Math.max(source.right, bounds.right) + 2;
      if (!inGap) latest.current.onClose();
    };
    const presentation = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId === tabId && detail.presented === false) latest.current.onClose();
    };
    const blur = () => { if (mode === 'preview') latest.current.onClose(); };
    const leaveWindow = (event: MouseEvent) => { if (!event.relatedTarget) blur(); };
    window.addEventListener('resize', position);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation);
    window.addEventListener('blur', blur);
    window.addEventListener('mouseout', leaveWindow);
    if (mode === 'preview') window.addEventListener('mousemove', move);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', key);
      window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation);
      window.removeEventListener('blur', blur);
      window.removeEventListener('mouseout', leaveWindow);
      window.removeEventListener('mousemove', move);
    };
  }, [anchor, mode, owner, panel, tabId]);

  return createPortal(
    <TaskPlanPopupOwner.Provider value={owner}>
      {mode === 'editor' && [0, 1, 2, 3].map(i => <div key={i} ref={node => { backdrops.current[i] = node; }}
        data-task-plan-popup-backdrop style={{ position: 'fixed', zIndex: 2147482399, pointerEvents: 'auto' }}
        onMouseDown={event => {
          event.preventDefault(); childDismiss.current = hasChild() || isTaskPlanChildDismissal(event.nativeEvent, owner);
          if (!childDismiss.current) event.stopPropagation();
        }}
        onClick={event => {
          event.preventDefault(); event.stopPropagation();
          const wasChildDismiss = childDismiss.current; childDismiss.current = false;
          if (!wasChildDismiss && !hasChild()) latest.current.onClose();
        }} />)}
      <div ref={popup} data-task-plan-popup={mode} data-task-plan-popup-owner={owner}
        role={mode === 'preview' ? 'tooltip' : 'dialog'} aria-label={mode === 'editor' ? 'Задача' : undefined}
        onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
        style={{ position: 'fixed', visibility: 'hidden', zIndex: 2147482400,
          boxSizing: 'border-box', overflow: 'auto', overscrollBehavior: 'contain',
          padding: mode === 'preview' ? '5px 7px' : 5, borderRadius: 6,
          background: '#1b1b1e', border: '1px solid #554766', color: '#ccc',
          fontSize: 12, lineHeight: 1.4, overflowWrap: 'anywhere', pointerEvents: 'auto',
          boxShadow: '0 5px 16px #0005' }}>
        {children}
      </div>
    </TaskPlanPopupOwner.Provider>, target,
  );
}
