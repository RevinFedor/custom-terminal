import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import ActionsPanel from './panels/ActionsPanel';
import ControlHint from '../UI/ControlHint';

// 📚 Docs button — lives in the ProjectToolbar, left of the CopySessionButton
// cluster. Click toggles a popover that contains the full `ActionsPanel embedded`
// (Update Docs / Update API → Haiku pipeline + their settings).
//
// Popover anchors to the BOTTOM-LEFT of the trigger so it visually sits on the
// same horizontal line as the CopySessionButton settings popover (both open
// downward, right-aligned to their trigger). Settings popup внутри ActionsPanel
// поднимается через свой portal — мы только размещаем содержимое.

export default function DocsButton() {
  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Compute popover position relative to the trigger on open + on resize.
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      setPos({
        top: r.bottom + 6,
        right: window.innerWidth - r.right, // anchor to trigger's right edge
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <ControlHint label="Открыть действия с документацией" disabled={open} side="bottom">
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        title="Docs / Update API"
        className="inline-flex items-center gap-1 rounded cursor-pointer hover:opacity-90 transition-colors"
        style={{
          height: 26,
          padding: '0 10px',
          fontSize: 11,
          color: open ? '#fff' : '#bbb',
          backgroundColor: open ? 'rgba(255,255,255,0.06)' : 'transparent',
          border: '1px solid ' + (open ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.10)'),
        }}
      >
        <BookOpen size={12} />
        <span>Docs</span>
      </button>
      </ControlHint>

      {open && pos && createPortal(
        <>
          {/* Backdrop — clicks outside the popover close it. Transparent so we
              don't dim the rest of the UI; only used for capture. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'transparent' }}
          />
          {/* Popover — pinned to bottom-right of the trigger (right edge aligned). */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top,
              right: pos.right,
              zIndex: 9999,
              minWidth: 320,
              maxWidth: 420,
              maxHeight: 'calc(100vh - ' + (pos.top + 16) + 'px)',
              overflowY: 'auto',
              backgroundColor: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: 8,
              padding: '10px 12px',
              boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
            }}
          >
            <ActionsPanel activeTabId={activeTabId} embedded />
          </div>
        </>,
        document.body
      )}
    </>
  );
}
