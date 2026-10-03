import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { paneSlots } from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { pointInHoverCluster } from '../../utils/hoverBridge.mjs';
import TabCard from './TabCard';
import { useUIStore } from '../../store/useUIStore';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';

type PreviewTab = { id: string; projectId: string; name: string; chooser?: boolean };

/** Background chooses the window's current selection; a card chooses its exact tab. */
export default function HiddenWindowPicker({ paneIndex, spaceId }: { paneIndex: number; spaceId: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ windowId: string; spaceId: string; displayKey: string | null } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [hoveredWindowId, setHoveredWindowId] = useState<string | null>(null);
  const [openMode, setOpenMode] = useState<'hover' | 'pinned' | null>(null);
  const tabGap = useUIStore(state => state.tabGeometry.gap);
  const key = useWorkspaceStore(state => {
    if (state.activeSpaceId !== spaceId) return '[]';
    return JSON.stringify(state.splitPanes.filter(p => p.displayHidden).map(pane => ({
      id: pane.windowId,
      shownTabId: pane.selectedSlotId || pane.tabId,
      tabs: paneSlots(pane).map((tab: any) => tab.slotId ? {
        id: tab.slotId, projectId: tab.projectId || pane.projectId || '', name: 'Новая вкладка', chooser: true,
      } : ({
        id: tab.tabId,
        projectId: tab.projectId,
        name: state.openProjects.get(tab.projectId)?.tabs.get(tab.tabId)?.name || 'Вкладка',
      })),
    })));
  });
  const windows: Array<{ id: string; shownTabId: string; tabs: PreviewTab[] }> = JSON.parse(key);
  const activeSpaceId = useWorkspaceStore(state => state.activeSpaceId);
  const displayKey = useWorkspaceStore(state => state.windowDisplayKey);
  useEffect(() => { setTarget(null); }, [activeSpaceId, displayKey]);
  useEffect(() => {
    if (!target) {
      setHoveredWindowId(null);
      setOpenMode(null);
    }
  }, [target]);
  useEffect(() => {
    if (!target) return;
    const dismiss = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setTarget(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setTarget(null); button.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [target]);
  useLayoutEffect(() => {
    if (!target || !button.current || !popup.current) return;
    const place = () => {
      if (!button.current || !popup.current) return;
      const anchor = button.current.getBoundingClientRect();
      const rect = popup.current.getBoundingClientRect();
      const next = clampMenuToViewport({ x: anchor.right - rect.width, y: anchor.bottom + 4,
        width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      setPosition(previous => previous.left === next.x && previous.top === next.y
        ? previous : { left: next.x, top: next.y });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup.current);
    observer.observe(button.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [target, key]);
  useEffect(() => {
    if (!target || openMode !== 'hover') return;
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const popupRect = popup.current?.getBoundingClientRect() || null;
        const buttonRect = button.current?.getBoundingClientRect() || null;
        if (pointInHoverCluster({
          hub: popupRect,
          satellites: [buttonRect],
          x: event.clientX,
          y: event.clientY,
          pad: 6,
        })) return;
        setTarget(null);
      });
    };
    const onWindowLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null) setTarget(null);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseout', onWindowLeave, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseout', onWindowLeave, true);
    };
  }, [target, openMode]);
  const openPicker = (mode: 'hover' | 'pinned') => {
    if (target) {
      if (mode === 'pinned') setOpenMode('pinned');
      return;
    }
    const state = useWorkspaceStore.getState();
    const pane = state.splitPanes[paneIndex];
    if (state.activeSpaceId === spaceId && pane?.windowId && !pane.displayHidden) {
      setTarget({ windowId: pane.windowId, spaceId, displayKey: state.windowDisplayKey });
      setOpenMode(mode);
    }
  };
  const removeHiddenChip = (candidateId: string, tabId: string): boolean => {
    const state = useWorkspaceStore.getState();
    const candidate = state.splitPanes.find(pane => pane.windowId === candidateId && pane.displayHidden);
    if (!candidate || !paneSlots(candidate).some((slot: any) => slot.tabId === tabId)) return false;
    state.clearTabFromSplitPane(tabId);
    return true;
  };
  const chooseWindow = (candidateId: string, tab?: PreviewTab) => {
    if (!target) return;
    const state = useWorkspaceStore.getState();
    const index = state.splitPanes.findIndex(p => p.windowId === target.windowId && !p.displayHidden);
    if (state.activeSpaceId !== target.spaceId || state.windowDisplayKey !== target.displayKey || index < 0) {
      setTarget(null);
      return;
    }
    let selected: Parameters<typeof state.showHiddenWindow>[2];
    if (tab?.chooser) selected = { slotId: tab.id };
    else if (tab) selected = { projectId: tab.projectId, tabId: tab.id };
    if (state.showHiddenWindow(index, candidateId, selected)) {
      const shown = useWorkspaceStore.getState().splitPanes[index];
      if (shown?.tabId && !shown.selectedSlotId) requestTabPrimaryInputFocus(shown.tabId, 'hidden-window-picker');
    }
    setTarget(null);
  };
  if (!windows.length) return null;
  return <>
    <button ref={button} type="button" data-hidden-window-picker-button data-split-button
      aria-label={`Скрытые окна: ${windows.length}`} aria-expanded={!!target} aria-haspopup="dialog"
      title={`Показать другое окно · скрытых ${windows.length}`}
      onPointerDown={event => event.stopPropagation()}
      onMouseEnter={() => openPicker('hover')}
      onFocus={() => openPicker('pinned')}
      onClick={event => {
        event.stopPropagation();
        // A click pins the list until an outside click or Escape; it never
        // toggles the hover-opened popup closed on the same activation.
        openPicker('pinned');
      }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'stretch', flexShrink: 0,
        padding: '0 6px', border: 0, borderRadius: 4, cursor: 'pointer', fontSize: 11,
        background: target ? '#34343a' : 'transparent', color: '#b8b8c2' }}>
      <PanelsTopLeft size={14} /><span>{windows.length}</span>
    </button>
    {target && createPortal(<div ref={popup} role="dialog" aria-label="Скрытые окна"
      data-hidden-window-picker style={{ position: 'fixed', ...position, zIndex: 100060,
        width: 'min(420px, calc(100vw - 16px))', maxHeight: 'min(560px, calc(100vh - 16px))',
        display: 'flex', flexDirection: 'column', gap: Math.max(4, tabGap),
        overflowY: 'auto', padding: 0, background: '#242427', border: '1px solid #444', borderRadius: 7,
        boxShadow: '0 8px 24px #0008' }}>
      {windows.map(candidate => <div key={candidate.id} role="button" tabIndex={0} data-hidden-window-id={candidate.id}
        aria-label={`Показать окно: ${candidate.tabs.map(tab => tab.name).join(', ') || 'Пустое окно'}`}
        onMouseOver={event => setHoveredWindowId((event.target as Element).closest('[data-tab-card]') ? null : candidate.id)}
        onMouseLeave={() => setHoveredWindowId(current => current === candidate.id ? null : current)}
        onFocus={event => setHoveredWindowId(event.target === event.currentTarget ? candidate.id : null)}
        onBlur={() => setHoveredWindowId(current => current === candidate.id ? null : current)}
        onClick={event => {
          event.stopPropagation();
          chooseWindow(candidate.id);
        }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); chooseWindow(candidate.id);
        }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tabGap,
          width: '100%', minHeight: 28, boxSizing: 'border-box', textAlign: 'left', cursor: 'pointer', padding: 0,
          border: '1px solid #75658b', borderRadius: 7, margin: 0,
          background: hoveredWindowId === candidate.id ? 'rgba(255,255,255,0.10)' : 'transparent', transition: 'none' }}>
        {candidate.tabs.map(tab => <TabCard key={tab.id} as="button" projectId={tab.projectId} tabId={tab.id}
          chooser={tab.chooser} label={tab.name} shown={tab.id === candidate.shownTabId} showShownStripe showProjectIcon reserveSignalSpace
          data-hidden-window-tab-id={tab.chooser ? undefined : tab.id}
          data-hidden-window-slot-id={tab.chooser ? tab.id : undefined}
          title={tab.chooser ? tab.name : `${tab.name}\nCmd+клик или средний клик — убрать из окна`}
          style={{ maxWidth: '100%' }}
          onPointerDown={event => { event.stopPropagation(); if (event.button === 1) event.preventDefault(); }}
          onClick={event => {
            event.stopPropagation();
            if (!tab.chooser && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
              event.preventDefault(); removeHiddenChip(candidate.id, tab.id); return;
            }
            chooseWindow(candidate.id, tab);
          }}
          onAuxClick={event => {
            if (event.button !== 1 || tab.chooser) return;
            event.preventDefault(); event.stopPropagation(); removeHiddenChip(candidate.id, tab.id);
          }}
        />)}
      </div>)}
    </div>, document.body)}
  </>;
}
