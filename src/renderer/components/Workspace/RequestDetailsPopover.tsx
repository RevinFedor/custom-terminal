import { useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type RequestPreviewAnchor = { anchor: HTMLElement; rect: DOMRect };

// Shared click-open surface for one selected request. Hover belongs to its
// row; only the owner's explicit selection mounts this dialog.
export function RequestDetailsPopover({ anchor, rect, previewRef, onClose, title, icon, id, closeLabel,
  children, attributes = {} }: RequestPreviewAnchor & {
  previewRef: RefObject<HTMLElement | null>; onClose: () => void; title: string; icon?: ReactNode;
  id: string; closeLabel: string; children: ReactNode; attributes?: Record<string, string>;
}) {
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const reposition = () => {
      const target = anchor.isConnected ? anchor.getBoundingClientRect() : rect;
      const parent = anchor.closest('[data-orchestration-history-panel]')?.getBoundingClientRect() || target;
      const preview = previewRef.current?.getBoundingClientRect();
      if (!preview) return;
      const left = parent.left >= preview.width + 14 ? parent.left - preview.width - 6 : parent.right + 6;
      const next = { left: Math.max(8, Math.min(left, window.innerWidth - preview.width - 8)),
        top: Math.max(8, Math.min(target.top, window.innerHeight - preview.height - 8)) };
      setPosition(current => current.left === next.left && current.top === next.top ? current : next);
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (previewRef.current) observer.observe(previewRef.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [anchor, rect, previewRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !previewRef.current?.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown);
    return () => { document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('mousedown', onMouseDown); };
  }, [anchor, onClose, previewRef]);
  return createPortal(<aside {...attributes} ref={previewRef} id={id} data-request-preview role="dialog" aria-label={title}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    style={{ position: 'fixed', ...position, zIndex: 220, width: 310, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(520px, calc(100vh - 16px))',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#151515', color: '#d4d4d4', border: '1px solid #444', borderRadius: 6,
      boxShadow: '0 10px 28px rgba(0,0,0,0.44)', pointerEvents: 'auto' }}>
    <div data-request-preview-header style={{ display: 'flex', alignItems: 'center', padding: '4px 6px 4px 10px', gap: 6, flexShrink: 0 }}>
      {icon}<strong style={{ flex: 1, fontSize: 11 }}>{title}</strong>
      <button type="button" aria-label={closeLabel} title="Закрыть" onClick={onClose}
        style={{ width: 23, height: 23, display: 'grid', placeItems: 'center', flexShrink: 0, padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: '#aaa', cursor: 'pointer' }}><X size={14} /></button>
    </div>
    <div className="scrollbar-thin" style={{ overflowY: 'auto', minHeight: 0 }}>{children}</div>
  </aside>, document.body);
}
