import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft, Maximize2 } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { paneSlots } from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { hiddenWindowHoverContains } from '../../utils/hiddenWindowHover.mjs';
import { hiddenWindowTabContextHost } from '../../utils/tabContextSurface.mjs';
import { openTabContextMenuAt, TAB_CONTEXT_MENU_CLOSE_EVENT, TAB_RENAME_REQUEST_EVENT } from './TabBar';
import { useInlineRenameInputRef } from '../../hooks/useInlineRenameInput';
import TabCard from './TabCard';
import { useUIStore } from '../../store/useUIStore';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';
import { openTabLinkedFile } from '../../utils/tabLinkedFilePreview';
import { TAB_STRIP_ROW_GAP } from '../../utils/tabCardVisual.mjs';

type PreviewTab = { id: string; projectId: string; name: string; chooser?: boolean };
type MenuLease = { host: string; windowId: string; tab: PreviewTab };
type Rename = { tab: PreviewTab; windowId: string; draft: string };
const ALONGSIDE_SIZE = 24;
const ALONGSIDE_GUTTER = ALONGSIDE_SIZE + 4;

/** Background chooses the window's current selection; a card chooses its exact tab. */
export default function HiddenWindowPicker({ paneIndex, spaceId }: { paneIndex: number; spaceId: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupList = useRef<HTMLDivElement>(null);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const actionNodes = useRef(new Map<string, HTMLButtonElement>());
  const [actionTops, setActionTops] = useState<Record<string, number>>({});
  const instanceId = useId();
  const menuLease = useRef<MenuLease | null>(null);
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const renameRef = useRef(renaming);
  renameRef.current = renaming;
  const renameInput = useInlineRenameInputRef(!!renaming);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dismissedHover = useRef(false);
  const recheckHover = useRef<() => void>(() => {});
  const [target, setTarget] = useState<{ windowId: string; spaceId: string; displayKey: string | null } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [openMode, setOpenMode] = useState<'hover' | 'pinned' | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
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
  function closeContextMenu() {
    const lease = menuLease.current;
    menuLease.current = null;
    if (lease) window.dispatchEvent(new CustomEvent(TAB_CONTEXT_MENU_CLOSE_EVENT, { detail: { host: lease.host } }));
  }
  function finishRename(commit: boolean) {
    const value = renameRef.current;
    if (!value) return;
    renameRef.current = null;
    setRenaming(null);
    const name = value.draft.trim();
    if (commit && name) {
      const state = useWorkspaceStore.getState();
      const tab = state.openProjects.get(value.tab.projectId)?.tabs.get(value.tab.id);
      if (tab && name !== tab.name) state.renameTab(value.tab.projectId, value.tab.id, name);
    }
    recheckHover.current();
  }
  function dismissPicker() {
    finishRename(true);
    closeContextMenu();
    setTarget(null);
  }
  useEffect(() => { setTarget(null); }, [activeSpaceId, displayKey]);
  useEffect(() => {
    const releaseHoverDismissal = (event: MouseEvent) => {
      if (!dismissedHover.current) return;
      const rect = button.current?.getBoundingClientRect();
      if (!rect || event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) dismissedHover.current = false;
    };
    window.addEventListener('mousemove', releaseHoverDismissal, true);
    return () => window.removeEventListener('mousemove', releaseHoverDismissal, true);
  }, []);
  useEffect(() => {
    if (!target) return;
    const state = useWorkspaceStore.getState();
    if (!state.splitPanes.some(p => p.windowId === target.windowId && !p.displayHidden)) {
      dismissPicker(); return;
    }
    const holds = (windowId: string, tab: PreviewTab) => windows.some(p => p.id === windowId
      && p.tabs.some(t => t.id === tab.id && t.projectId === tab.projectId));
    if (menuLease.current && !holds(menuLease.current.windowId, menuLease.current.tab)) closeContextMenu();
    if (renameRef.current && !holds(renameRef.current.windowId, renameRef.current.tab)) finishRename(false);
  }, [key, target]);
  useEffect(() => {
    if (!target) {
      setOpenMode(null);
    }
  }, [target]);
  useEffect(() => {
    if (!target) return;
    const onRename = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const lease = menuLease.current;
      if (!lease || detail?.host !== lease.host || detail?.tabId !== lease.tab.id) return;
      const tab = useWorkspaceStore.getState().openProjects.get(lease.tab.projectId)?.tabs.get(lease.tab.id);
      if (!tab || tab.tabType === 'file') return;
      const value = { tab: lease.tab, windowId: lease.windowId, draft: tab.name };
      renameRef.current = value;
      setRenaming(value);
    };
    window.addEventListener(TAB_RENAME_REQUEST_EVENT, onRename);
    return () => {
      window.removeEventListener(TAB_RENAME_REQUEST_EVENT, onRename);
      closeContextMenu();
      renameRef.current = null;
      setRenaming(null);
    };
  }, [target]);
  useEffect(() => {
    if (!target) return;
    const dismiss = (event: PointerEvent) => {
      const ownedMenu = (event.target as Element)?.closest?.('[data-tab-context-menu-host]');
      if (menuLease.current && ownedMenu?.getAttribute('data-tab-context-menu-host') === menuLease.current.host) return;
      if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) dismissPicker();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const lease = menuLease.current;
      if (lease && document.querySelector(`[data-run-after-picker-menu][data-tab-context-menu-host="${CSS.escape(lease.host)}"]`)) return;
      event.preventDefault(); event.stopPropagation();
      if (renameRef.current) { finishRename(false); return; }
      if (menuLease.current) { closeContextMenu(); recheckHover.current(); return; }
      // At the viewport edge the popup can cover its trigger. Removing it
      // produces a synthetic mouse-enter under a stationary pointer.
      dismissedHover.current = true;
      setTarget(null); button.current?.focus();
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
      // Clamp the painted external controls too, without reserving a column
      // in the list or extending its background/border.
      const next = clampMenuToViewport({ x: anchor.right - rect.width - ALONGSIDE_GUTTER, y: anchor.bottom + 4,
        width: rect.width + ALONGSIDE_GUTTER, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      const left = next.x + ALONGSIDE_GUTTER;
      setPosition(previous => previous.left === left && previous.top === next.y
        ? previous : { left, top: next.y });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup.current);
    observer.observe(button.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [target, key]);
  useLayoutEffect(() => {
    const list = popupList.current, shell = popup.current;
    if (!target || !list || !shell) return;
    const measure = () => {
      const bounds = shell.getBoundingClientRect(), clip = list.getBoundingClientRect();
      const next: Record<string, number> = {};
      for (const [id, node] of rowNodes.current) {
        const rect = node.getBoundingClientRect();
        // Same visibility as an ordinary button at the top of the scrolling
        // row. Controls are siblings of the clipping list, not clipped children.
        if (rect.top >= clip.top - 1 && rect.top + ALONGSIDE_SIZE <= clip.bottom + 1) next[id] = rect.top - bounds.top;
      }
      setActionTops(previous => Object.keys(previous).length === Object.keys(next).length
        && Object.keys(next).every(id => previous[id] === next[id]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const node of rowNodes.current.values()) observer.observe(node);
    list.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener('scroll', measure); };
  }, [target, key, position.left, position.top]);
  useEffect(() => {
    if (!target || openMode !== 'hover') return;
    let frame = 0;
    const check = () => {
      if (menuLease.current || renameRef.current || !pointer.current) return;
      const trigger = button.current;
      for (const action of actionNodes.current.values()) {
        const rect = action.getBoundingClientRect();
        if (pointer.current.x >= rect.left - 2 && pointer.current.x <= rect.right + 6
          && pointer.current.y >= rect.top - 2 && pointer.current.y <= rect.bottom + 2) return;
      }
      if (hiddenWindowHoverContains({
        popup: popup.current?.getBoundingClientRect() || null,
        button: trigger?.getBoundingClientRect() || null,
        header: trigger?.closest('[data-split-attach-row]')?.getBoundingClientRect() || null,
        ...pointer.current,
      })) return;
      setTarget(null);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    recheckHover.current = schedule;
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const onWindowLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null && !menuLease.current && !renameRef.current) setTarget(null);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseout', onWindowLeave, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      recheckHover.current = () => {};
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseout', onWindowLeave, true);
    };
  }, [target, openMode]);
  const openPicker = (mode: 'hover' | 'pinned') => {
    if (mode === 'hover' && dismissedHover.current) return;
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
  const openTabMenu = (event: React.MouseEvent, windowId: string, tab: PreviewTab) => {
    event.preventDefault(); event.stopPropagation();
    if (!target || tab.chooser) return;
    finishRename(true);
    const lease = { windowId, tab, host: hiddenWindowTabContextHost(instanceId, target.spaceId, windowId, tab.id) };
    menuLease.current = lease;
    openTabContextMenuAt(tab.projectId, tab.id, event.clientX, event.clientY, {
      renameHost: lease.host,
      singleTarget: true,
      isCurrent: () => {
        const state = useWorkspaceStore.getState();
        return menuLease.current === lease && targetRef.current === target
          && state.activeSpaceId === target.spaceId && state.windowDisplayKey === target.displayKey
          && state.splitPanes.some(p => p.windowId === windowId && p.displayHidden
            && paneSlots(p).some((slot: any) => slot.tabId === tab.id && slot.projectId === tab.projectId));
      },
      onClose: () => {
        if (menuLease.current !== lease) return;
        menuLease.current = null;
        recheckHover.current();
      },
    });
  };
  const removeHiddenChip = (candidateId: string, tabId: string): boolean => {
    const state = useWorkspaceStore.getState();
    const candidate = state.splitPanes.find(pane => pane.windowId === candidateId && pane.displayHidden);
    if (!candidate || !paneSlots(candidate).some((slot: any) => slot.tabId === tabId)) return false;
    state.clearTabFromSplitPane(tabId);
    return true;
  };
  const chooseWindow = (candidateId: string, tab?: PreviewTab, focusInput = true) => {
    if (!target) return false;
    const state = useWorkspaceStore.getState();
    const index = state.splitPanes.findIndex(p => p.windowId === target.windowId && !p.displayHidden);
    if (state.activeSpaceId !== target.spaceId || state.windowDisplayKey !== target.displayKey || index < 0) {
      setTarget(null);
      return false;
    }
    let selected: Parameters<typeof state.showHiddenWindow>[2];
    if (tab?.chooser) selected = { slotId: tab.id };
    else if (tab) selected = { projectId: tab.projectId, tabId: tab.id };
    const accepted=state.showHiddenWindow(index, candidateId, selected);
    if (accepted && focusInput) {
      const after = useWorkspaceStore.getState();
      const shown = after.splitPanes[after.splitFocusedIndex];
      if (shown?.tabId && !shown.selectedSlotId) requestTabPrimaryInputFocus(shown.tabId, 'hidden-window-picker');
    }
    setTarget(null);
    return accepted;
  };
  const showAlongside=(candidateId:string)=>{
    if(!target)return;
    const state=useWorkspaceStore.getState();
    if(state.activeSpaceId!==target.spaceId || state.windowDisplayKey!==target.displayKey){setTarget(null);return;}
    if(state.showHiddenWindowAlongside(target.spaceId,target.windowId,candidateId))setTarget(null);
    else useUIStore.getState().showToast('Could not expand this window.','warning');
  };
  if (!windows.length) return null;
  return <>
    <button ref={button} type="button" data-hidden-window-picker-button data-split-button
      aria-label={`Hidden windows: ${windows.length}`} aria-expanded={!!target} aria-haspopup="dialog"
      title={`Hidden: ${windows.length}`}
      onPointerDown={event => event.stopPropagation()}
      onMouseEnter={() => openPicker('hover')}
      onFocus={() => openPicker('pinned')}
      onClick={event => {
        event.stopPropagation();
        dismissedHover.current = false;
        // A click pins the list until an outside click or Escape; it never
        // toggles the hover-opened popup closed on the same activation.
        openPicker('pinned');
      }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'stretch', flexShrink: 0,
        padding: '0 6px', border: 0, borderRadius: 4, cursor: 'pointer', fontSize: 11,
        background: target ? '#34343a' : 'transparent', color: '#b8b8c2' }}>
      <PanelsTopLeft size={14} /><span>{windows.length}</span>
    </button>
    {target && createPortal(<div ref={popup} role="dialog" aria-label="Hidden windows"
      data-hidden-window-picker style={{ position: 'fixed', ...position, zIndex: 100020,
        width: `min(500px, calc(100vw - ${16 + ALONGSIDE_GUTTER}px))`, overflow: 'visible' }}>
      <div ref={popupList} data-hidden-window-picker-list style={{ maxHeight: 'min(560px, calc(100vh - 16px))',
        display: 'flex', flexDirection: 'column', gap: Math.max(4, tabGap),
        overflowY: 'auto', padding: 0, background: '#242427', border: '1px solid #444', borderRadius: 7,
        boxShadow: '0 8px 24px #0008' }}>
      {windows.map(candidate => <div key={candidate.id} data-hidden-window-row={candidate.id}
        ref={node => { if (node) rowNodes.current.set(candidate.id, node); else rowNodes.current.delete(candidate.id); }}
        style={{minWidth:0,flexShrink:0}}>
        <div role="button" tabIndex={0} data-hidden-window-id={candidate.id}
        aria-label={`Show: ${candidate.tabs.map(tab => tab.name).join(', ') || 'Empty'}`}
        // A nested card is still inside this window. CSS keeps the whole
        // surface highlighted without resetting it on descendant mouseover.
        className="hover:bg-white/10 focus-visible:bg-white/10"
        onClick={event => {
          event.stopPropagation();
          chooseWindow(candidate.id);
        }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); chooseWindow(candidate.id);
        }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tabGap,rowGap:TAB_STRIP_ROW_GAP,
          flex:'1 1 auto',minWidth:0, minHeight: 28, boxSizing: 'border-box', textAlign: 'left', cursor: 'pointer', padding: `0 0 ${TAB_STRIP_ROW_GAP-1}px`,
          border: '1px solid #75658b', borderRadius: 7, margin: 0,
          transition: 'none' }}>
        {candidate.tabs.length === 0 && <span style={{ padding: '2px 6px', color: '#8f8f94' }}>Empty</span>}
        {candidate.tabs.map(tab => <TabCard key={tab.id} as="span" role="button" tabIndex={0} projectId={tab.projectId} tabId={tab.id}
          chooser={tab.chooser} label={tab.name} shown={tab.id === candidate.shownTabId} showShownStripe showProjectIcon reserveSignalSpace
          linkedFilesMode="navigate"
          onLinkedFileOpen={tab.chooser?undefined:file=>{void openTabLinkedFile(tab.projectId,file,()=>chooseWindow(candidate.id,tab,false));}}
          data-hidden-window-tab-id={tab.chooser ? undefined : tab.id}
          data-hidden-window-slot-id={tab.chooser ? tab.id : undefined}
          title={tab.chooser ? tab.name : `${tab.name}\nCmd/middle click: remove`}
          style={{ maxWidth: '100%' }}
          onPointerDown={event => { event.stopPropagation(); if (event.button !== 0) event.preventDefault(); }}
          onContextMenu={event => openTabMenu(event, candidate.id, tab)}
          onClick={event => {
            event.stopPropagation();
            if (!tab.chooser && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
              event.preventDefault(); removeHiddenChip(candidate.id, tab.id); return;
            }
            chooseWindow(candidate.id, tab);
          }}
          onKeyDown={event=>{
            if(event.target!==event.currentTarget || !['Enter',' '].includes(event.key))return;
            event.preventDefault();event.stopPropagation();chooseWindow(candidate.id,tab);
          }}
          onAuxClick={event => {
            if (event.button !== 1 || tab.chooser) return;
            event.preventDefault(); event.stopPropagation(); removeHiddenChip(candidate.id, tab.id);
          }}
        >
          {renaming?.tab.id === tab.id ? <input ref={renameInput.ref} data-hidden-window-tab-rename
            aria-label="Название вкладки" value={renaming.draft}
            onChange={event => {
              const value = { ...renaming, draft: event.target.value };
              renameRef.current = value; setRenaming(value);
            }}
            onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
            onContextMenu={event => event.stopPropagation()} onBlur={() => finishRename(true)}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); finishRename(true); }
              else if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
            }}
            style={{ width: Math.max(60, renaming.draft.length * 6.5 + 12), maxWidth: '100%', minWidth: 60,
              padding: '0 4px', border: 'none', outline: 'none', background: '#333', borderRadius: 3,
              boxShadow: 'inset 0 0 0 1px var(--color-accent)', color: '#fff', font: 'inherit' }}
          /> : undefined}
        </TabCard>)}
      </div></div>)}
      </div>
      {windows.map(candidate => actionTops[candidate.id] !== undefined && <button key={candidate.id}
        ref={node => { if (node) actionNodes.current.set(candidate.id, node); else actionNodes.current.delete(candidate.id); }}
        type="button" data-hidden-window-alongside={candidate.id}
        title="Показать окно рядом" aria-label="Показать окно рядом"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); showAlongside(candidate.id); }}
        style={{ position: 'absolute', left: -ALONGSIDE_GUTTER, top: actionTops[candidate.id],
          width: ALONGSIDE_SIZE, height: ALONGSIDE_SIZE, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, border: 0, borderRadius: 4, background: '#242427', color: '#c4b5fd', cursor: 'pointer' }}>
        <Maximize2 size={14} aria-hidden="true" />
      </button>)}
    </div>, document.body)}
  </>;
}
