import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { tabLinkedFilesSnapshot, isLinkedFilePreview, placeLinkedFilePopup } from '../../utils/tabLinkedFiles.mjs';
import './TabLinkedFiles.css';

export type LinkedFile = { projectId: string; id: string; ownerTabId: string; path: string; name: string };
export function useTabLinkedFiles(tabId: string, enabled = true): LinkedFile[] {
  // A value snapshot avoids allocating new selector results or reacting to
  // unrelated activity updates. No file bodies or MD-only context inventory.
  const snapshot = useWorkspaceStore(s => enabled ? tabLinkedFilesSnapshot(s.openProjects, tabId) : '[]');
  return useMemo(() => JSON.parse(snapshot), [snapshot]);
}

export default function TabLinkedFiles({ ownerTabId, files, onOpen, insetLeft = 6 }: {
  ownerTabId: string; files: LinkedFile[]; onOpen: (file: LinkedFile) => void; insetLeft?: number;
}) {
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const bridge = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuActive = useRef(false);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const preview = useUIStore(s => s.filePreview);
  const fontSize = useUIStore(s => s.tabsFontSize);
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const close = () => { clearTimer(); setOpen(false); setPinned(false); };
  const enter = () => { clearTimer(); setOpen(true); };
  const leave = () => { clearTimer(); if (!pinned && !contextMenuActive.current) timer.current = setTimeout(() => setOpen(false), 180); };
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
  useEffect(() => () => clearTimer(), []);
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
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  if (!files.length) return null;
  const selected = isLinkedFilePreview(preview, ownerTabId);
  const shortName = files.length === 1 && files[0].name.length <= 22;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return <>
    <button ref={trigger} type="button" className="tab-linked-files-chip" data-tab-linked-files={ownerTabId}
      style={{ left: insetLeft, maxWidth: `calc(100% - ${insetLeft + 6}px)` }}
      data-file-selected={selected ? '1' : undefined} aria-label={`Linked files (${files.length})`}
      aria-expanded={open} aria-haspopup="menu" onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop} onAuxClick={stop} onContextMenu={stop}
      onClick={event => { stop(event); clearTimer(); if (pinned) close(); else { setOpen(true); setPinned(true); } }}>
      <FileText size={10} aria-hidden="true" />{shortName ? <>
        <span data-linked-file-short-name>{files[0].name}</span><span data-linked-file-compact-count>1</span>
        <span data-linked-file-measure aria-hidden="true">{files[0].name}</span>
      </> : <span>{files.length}</span>}
    </button>
    {open && createPortal(<><div ref={bridge} data-linked-files-hover-bridge aria-hidden="true"
      style={{ position: 'fixed', zIndex: 100009 }} onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop} />
      <div ref={popup} className="tab-linked-files-popup" style={{ fontSize }} data-tab-linked-files-popup={ownerTabId}
      data-pinned={pinned ? '1' : '0'} role="menu" aria-label="Linked files" onMouseEnter={enter} onMouseLeave={leave}
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onAuxClick={stop}>
      {files.map(file => <button type="button" role="menuitem" key={`${file.projectId}:${file.id}`}
        className="tab-linked-files-row" data-linked-file-id={file.id} title={file.path}
        data-file-selected={isLinkedFilePreview(preview, ownerTabId, file.id, file.projectId) ? '1' : undefined}
        onClick={event => { stop(event); onOpen(file); }}
        onContextMenu={event => {
          event.preventDefault(); stop(event); clearTimer();
          // Keep the hover bridge alive while the existing context actions are
          // used; internal interaction never pins the attachment popup.
          contextMenuActive.current = true;
          // Same public event as openTabContextMenuAt; avoid importing the
          // entire TabBar into every TabCard consumer just for its opener.
          window.dispatchEvent(new CustomEvent('tab-context-menu:open', { detail: {
            projectId: file.projectId, tabId: file.id, x: event.clientX, y: event.clientY,
            singleTarget: true, isCurrent: () => !!popup.current,
            onClose: () => { contextMenuActive.current = false; if (!pinned) close(); },
          } }));
        }}>{file.name}</button>)}
    </div></>, document.body)}
  </>;
}
