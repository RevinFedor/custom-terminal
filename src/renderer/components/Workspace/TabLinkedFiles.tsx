import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { publishedTabLinkedFilesSnapshot, isLinkedFilePreview, placeLinkedFilePopup,preferredLinkedFile } from '../../utils/tabLinkedFiles.mjs';
import {isFileMissing,probeFiles,subscribeMissingFiles} from '../../utils/missingFileTracker';
import {closeTabLinkedFile} from '../../utils/tabLinkedFilePreview';
import TabLinkedFileTree from './TabLinkedFileTree';
import { TAB_CARD_LINE_HEIGHT } from '../../utils/tabCardVisual.mjs';
import { useWorkspaceOverlayTarget } from '../../hooks/useWorkspaceOverlayTarget';
import './TabLinkedFiles.css';

const LINKED_FILE_HOVER_MS = 100;
const LINKED_FILE_HOVER_ANIMATION = 'tab-linked-file-hover-intent';

export type LinkedFile = { projectId: string; id: string; ownerTabId: string; path: string; name: string; parentTabId?:string;depth?:number };
export function useTabLinkedFiles(tabId: string, enabled = true): LinkedFile[] {
  // A value snapshot avoids allocating new selector results or reacting to
  // unrelated activity updates. No file bodies or MD-only context inventory.
  const snapshot = useWorkspaceStore(s => enabled ? publishedTabLinkedFilesSnapshot(s, tabId) : '[]');
  return useMemo(() => JSON.parse(snapshot), [snapshot]);
}

export default function TabLinkedFiles({ ownerTabId, files, onOpen, insetLeft = 6, fontSize, geometry, onHoverChange, mode = 'menu' }: {
  ownerTabId: string; files: LinkedFile[]; onOpen: (file: LinkedFile) => void; insetLeft?: number;
  fontSize: number; geometry: { paddingX: number; paddingY: number; borderRadius: number };
  onHoverChange?: (hovered: boolean) => void;
  mode?: 'menu' | 'navigate';
}) {
  const trigger = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null);
  const overlayTarget = useWorkspaceOverlayTarget();
  const bridge = useRef<HTMLDivElement>(null);
  const contextMenuActive = useRef(false);
  const dragging=useRef(false),dismissed=useRef(false);
  const hoverIntent = useRef<{ startedAt: number; cancel: () => void; escape: (event: KeyboardEvent) => void } | null>(null);
  const cancelHoverIntent = useCallback(() => {
    const pending = hoverIntent.current; hoverIntent.current = null;
    trigger.current?.removeAttribute('data-linked-files-opening');
    if (!pending) return;
    window.removeEventListener('blur', pending.cancel);
    window.removeEventListener('pointerdown', pending.cancel, true);
    window.removeEventListener('keydown', pending.escape, true);
  }, []);
  const onDraggingChange=useCallback((active:boolean)=>{dragging.current=active;},[]);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const [hovered,setHovered]=useState(false);
  const preview = useUIStore(s => s.filePreview);
  const lastFileId=useUIStore(s=>s.lastLinkedFileByOwner?.[ownerTabId]);
  const [,setMissingRevision]=useState(0);
  useEffect(()=>subscribeMissingFiles(()=>setMissingRevision(n=>n+1)),[]);
  useEffect(()=>{void probeFiles(files.map(file=>file.path));},[files]);
  const close = () => { cancelHoverIntent(); setOpen(false); setPinned(false); setHovered(false); onHoverChange?.(false); };
  const contains = (target: EventTarget | null) => target instanceof Node &&
    [trigger.current, popup.current, bridge.current].some(element => element?.contains(target));
  // The menu also exposes actions on a single file; its count only controls +N.
  const enter = () => {
    setHovered(mode==='menu'); onHoverChange?.(true);
    if (mode!=='menu') { void probeFiles(files.map(file=>file.path)); return; }
    if (!files.length || dismissed.current || open || hoverIntent.current) return;
    const cancel = () => { cancelHoverIntent(); setHovered(false); onHoverChange?.(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    hoverIntent.current = { startedAt: performance.now(), cancel, escape };
    // The finite transform animation is the dwell clock. Fast crossings never
    // mount/measure a popup or perform a fresh file probe.
    trigger.current?.setAttribute('data-linked-files-opening', '1');
    window.addEventListener('blur', cancel);
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('keydown', escape, true);
  };
  const finishHover = (event: React.AnimationEvent<HTMLSpanElement>) => {
    const pending = hoverIntent.current;
    if (event.target !== event.currentTarget || event.animationName !== LINKED_FILE_HOVER_ANIMATION
      || !pending || performance.now() - pending.startedAt < LINKED_FILE_HOVER_MS) return;
    cancelHoverIntent();
    if (mode !== 'menu' || !files.length || dismissed.current || !trigger.current?.isConnected
      || !trigger.current.matches(':hover')) return;
    void probeFiles(files.map(file=>file.path)); setOpen(true);
  };
  const leave = (event: React.MouseEvent) => {
    if (contains(event.relatedTarget)) return;
    cancelHoverIntent();
    dismissed.current=false;
    setHovered(false);
    onHoverChange?.(false);
    if (!pinned && !contextMenuActive.current && !dragging.current) setOpen(false);
  };
  useEffect(() => () => onHoverChange?.(false), [onHoverChange]);
  useEffect(() => { if (!files.length) close(); }, [files.length]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const place = () => {
      const button = trigger.current, menu = popup.current;
      if (!button || !menu) return;
      const anchor = button.getBoundingClientRect();
      const position = placeLinkedFilePopup(anchor, { width: menu.getBoundingClientRect().width, height: menu.scrollHeight + 2 }, { width: innerWidth, height: innerHeight });
      menu.style.left = `${position.left}px`; menu.style.top = `${position.top}px`;
      menu.style.maxHeight = `${position.maxHeight}px`; menu.style.visibility = 'visible';
      menu.dataset.flipped = position.flip ? '1' : '0';
      if (bridge.current) {
        const rect = menu.getBoundingClientRect();
        Object.assign(bridge.current.style, { left: `${Math.min(anchor.left, rect.left)}px`,
          top: `${position.flip ? rect.bottom : anchor.bottom}px`,
          width: `${Math.max(anchor.right, rect.right) - Math.min(anchor.left, rect.left)}px`,
          height: `${Math.max(0, position.flip ? anchor.top - rect.bottom : rect.top - anchor.bottom)}px` });
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(trigger.current); observer.observe(popup.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    // Geometry changes write DOM only. Pointer movement never measures or
    // updates React state, and the portal cannot participate in strip packing.
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, files, fontSize]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || popup.current?.contains(target) || bridge.current?.contains(target)
        || (target instanceof Element && target.closest('[data-tab-context-menu]'))) return;
      close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !contextMenuActive.current) { event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  const chosen=preferredLinkedFile(files.filter(file=>!isFileMissing(file.path)),preview,ownerTabId,lastFileId);
  useEffect(() => () => cancelHoverIntent(), [cancelHoverIntent, ownerTabId, mode, chosen?.id, chosen?.path]);
  if (!chosen) return null;
  const selected = isLinkedFilePreview(preview, ownerTabId);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const openContextMenu = (event: React.MouseEvent, file: LinkedFile) => {
    event.preventDefault(); stop(event);
    cancelHoverIntent();
    if(mode==='navigate')return;
    contextMenuActive.current = true;
    window.dispatchEvent(new CustomEvent('tab-context-menu:open', { detail: {
      projectId: file.projectId, tabId: file.id, x: event.clientX, y: event.clientY,
      singleTarget: true, isCurrent: () => !!trigger.current &&
        useWorkspaceStore.getState().openProjects.get(file.projectId)?.tabs.get(file.id)?.filePath===file.path,
      onClose: () => { contextMenuActive.current = false; if (!pinned) close(); },
    } }));
  };
  return <>
    <span ref={trigger} className="tab-linked-files-chip" data-tab-linked-files={ownerTabId} data-linked-files-mode={mode}
      data-linked-files-hovered={hovered ? '1' : undefined}
      style={{ left: insetLeft, maxWidth: `calc(100% - ${insetLeft + 6}px)` }}
      data-file-selected={selected ? '1' : undefined} aria-label={`Linked files (${files.length})`}
      title={chosen.name}
      aria-expanded={mode==='menu' ? open : undefined} aria-haspopup={mode==='menu' ? 'menu' : undefined}
      onMouseEnter={enter} onMouseLeave={leave}
      onAnimationEnd={finishHover}
      onPointerDown={event=>{stop(event);if(event.button===1)event.preventDefault();}}
      onMouseDown={event=>{stop(event);if(event.button===1)event.preventDefault();}} onDoubleClick={stop}
      onAuxClick={event=>{stop(event);if(event.button!==1)return;event.preventDefault();
        dismissed.current=true;close();void closeTabLinkedFile(ownerTabId);}}
      onContextMenu={event => openContextMenu(event, chosen)}>
      <button type="button" data-linked-file-open onClick={event=>{stop(event);cancelHoverIntent();onOpen(chosen);}}>
        <FileText size={10} aria-hidden="true" /><span data-linked-file-short-name>{chosen.name}</span>
      </button>
      {files.length > 1 && <button type="button" data-linked-file-more data-linked-file-menu-trigger aria-label="Меню файлов"
        aria-expanded={mode==='menu'?open:undefined} onClick={event=>{stop(event);cancelHoverIntent();if(mode==='navigate'){onOpen(chosen);return;}if(pinned){dismissed.current=true;close();}
          else{dismissed.current=false;setOpen(true);setPinned(true);}}}>+{files.length - 1}</button>}
    </span>
    {mode==='menu' && open && createPortal(<><div ref={bridge} data-linked-files-hover-bridge aria-hidden="true"
      style={{ position: 'fixed', zIndex: 100009 }} onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop} />
      <div ref={popup} className="tab-linked-files-popup" style={{ fontSize, lineHeight: TAB_CARD_LINE_HEIGHT,
        '--linked-file-row-radius': `${geometry.borderRadius}px`,
      } as React.CSSProperties} data-tab-linked-files-popup={ownerTabId}
      data-pinned={pinned ? '1' : '0'} role="menu" aria-label="Linked files" onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop}>
      <TabLinkedFileTree ownerTabId={ownerTabId} files={files} onOpen={onOpen} onContextMenu={openContextMenu} onDraggingChange={onDraggingChange}/>
    </div></>, overlayTarget)}
  </>;
}
