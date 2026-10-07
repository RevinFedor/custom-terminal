import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { tabLinkedFilesSnapshot, isLinkedFilePreview, placeLinkedFilePopup } from '../../utils/tabLinkedFiles.mjs';
import { TAB_CARD_LINE_HEIGHT } from '../../utils/tabCardVisual.mjs';
import { useWorkspaceOverlayTarget } from '../../hooks/useWorkspaceOverlayTarget';
import './TabLinkedFiles.css';

export type LinkedFile = { projectId: string; id: string; ownerTabId: string; path: string; name: string };
export function useTabLinkedFiles(tabId: string, enabled = true): LinkedFile[] {
  // A value snapshot avoids allocating new selector results or reacting to
  // unrelated activity updates. No file bodies or MD-only context inventory.
  const snapshot = useWorkspaceStore(s => enabled ? tabLinkedFilesSnapshot(s.openProjects, tabId) : '[]');
  return useMemo(() => JSON.parse(snapshot), [snapshot]);
}

export default function TabLinkedFiles({ ownerTabId, files, onOpen, insetLeft = 6, fontSize, geometry, onHoverChange }: {
  ownerTabId: string; files: LinkedFile[]; onOpen: (file: LinkedFile) => void; insetLeft?: number;
  fontSize: number; geometry: { paddingX: number; paddingY: number; borderRadius: number };
  onHoverChange?: (hovered: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const overlayTarget = useWorkspaceOverlayTarget();
  const bridge = useRef<HTMLDivElement>(null);
  const contextMenuActive = useRef(false);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const preview = useUIStore(s => s.filePreview);
  const close = () => { setOpen(false); setPinned(false); onHoverChange?.(false); };
  const contains = (target: EventTarget | null) => target instanceof Node &&
    [trigger.current, popup.current, bridge.current].some(element => element?.contains(target));
  const enter = () => { onHoverChange?.(true); if (files.length > 1) setOpen(true); };
  const leave = (event: React.MouseEvent) => {
    if (contains(event.relatedTarget)) return;
    onHoverChange?.(false);
    if (!pinned && !contextMenuActive.current) setOpen(false);
  };
  useLayoutEffect(() => {
    const button = trigger.current, card = button?.parentElement;
    if (!button || !card) return;
    const fit = () => {
      const name = button.querySelector<HTMLElement>('[data-linked-file-measure]');
      if (name) button.dataset.compact = name.getBoundingClientRect().width + 23 > card.clientWidth - insetLeft - 6 ? '1' : '0';
    };
    fit();
    const observer = new ResizeObserver(fit); observer.observe(card);
    return () => observer.disconnect();
  }, [files, fontSize, insetLeft]);
  useEffect(() => () => onHoverChange?.(false), [onHoverChange]);
  useEffect(() => { if (files.length < 2) close(); }, [files.length]);

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
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  if (!files.length) return null;
  const selected = isLinkedFilePreview(preview, ownerTabId);
  const name = files[0].name + (files.length > 1 ? ` +${files.length - 1}` : '');
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const openContextMenu = (event: React.MouseEvent, file: LinkedFile) => {
    event.preventDefault(); stop(event);
    contextMenuActive.current = true;
    window.dispatchEvent(new CustomEvent('tab-context-menu:open', { detail: {
      projectId: file.projectId, tabId: file.id, x: event.clientX, y: event.clientY,
      singleTarget: true, isCurrent: () => !!trigger.current,
      onClose: () => { contextMenuActive.current = false; if (!pinned) close(); },
    } }));
  };
  return <>
    <button ref={trigger} type="button" className="tab-linked-files-chip" data-tab-linked-files={ownerTabId}
      style={{ left: insetLeft, maxWidth: `calc(100% - ${insetLeft + 6}px)` }}
      data-file-selected={selected ? '1' : undefined} aria-label={`Linked files (${files.length})`}
      title={files.length === 1 ? files[0].name : undefined}
      aria-expanded={files.length > 1 ? open : undefined} aria-haspopup={files.length > 1 ? 'menu' : undefined}
      onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop} onAuxClick={stop}
      onContextMenu={event => files.length === 1 ? openContextMenu(event, files[0]) : stop(event)}
      onClick={event => { stop(event); if (files.length === 1) { onOpen(files[0]); return; }
        if (pinned) close(); else { setOpen(true); setPinned(true); } }}>
      <FileText size={10} aria-hidden="true" />
      <span data-linked-file-short-name>{name}</span><span data-linked-file-compact-count>{files.length}</span>
      <span data-linked-file-measure aria-hidden="true">{name}</span>
    </button>
    {open && createPortal(<><div ref={bridge} data-linked-files-hover-bridge aria-hidden="true"
      style={{ position: 'fixed', zIndex: 100009 }} onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop} />
      <div ref={popup} className="tab-linked-files-popup" style={{ fontSize, lineHeight: TAB_CARD_LINE_HEIGHT,
        '--linked-file-row-padding': `${geometry.paddingY}px ${geometry.paddingX}px`,
        '--linked-file-row-radius': `${geometry.borderRadius}px`,
      } as React.CSSProperties} data-tab-linked-files-popup={ownerTabId}
      data-pinned={pinned ? '1' : '0'} role="menu" aria-label="Linked files" onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop}>
      {files.map(file => <button type="button" role="menuitem" key={`${file.projectId}:${file.id}`}
        className="tab-linked-files-row" data-linked-file-id={file.id} title={file.path}
        data-file-selected={isLinkedFilePreview(preview, ownerTabId, file.id, file.projectId) ? '1' : undefined}
        onClick={event => { stop(event); onOpen(file); }}
        onContextMenu={event => openContextMenu(event, file)}><FileText size={14} aria-hidden="true" /><span>{file.name}</span></button>)}
    </div></>, overlayTarget)}
  </>;
}
