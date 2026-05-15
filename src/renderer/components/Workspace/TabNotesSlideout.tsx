import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { generateAITitle } from '../../utils/generateAITitle';

interface TabNotesSlideoutProps {
  // Per-tab open state — derived from useUIStore.notesPanelOpenTabs[activeTabId].
  // Edits live in the workspace tab (setTabNotes) so they persist with the tab.
  activeTabId: string | null;
}

const MARGIN = 12;
const MIN_W = 240;
const MAX_W = 1200;
const MIN_H = 180;
const MAX_H = 900;

// Slide-in notes panel anchored to the LEFT edge of the right-side InfoPanel
// (the `.bg-notes` aside rendered by NotesPanel.tsx). Resizable from the
// left edge (width) and top/bottom edges (height). Click on the backdrop closes
// the panel — there's no chrome/header inside, just the editor and resize handles.
//
// Anchor: every frame on resize/window-resize, the panel reads the live
// boundingClientRect of the `[data-info-aside]` element and parks its right
// edge flush against the aside's left edge. The size itself is persisted in
// useUIStore.notesPanelSize → SQLite (so dev-port shuffles don't reset it).
export default function TabNotesSlideout({ activeTabId }: TabNotesSlideoutProps) {
  const notesPanelOpenTabs = useUIStore((s) => s.notesPanelOpenTabs);
  const setNotesPanelOpen = useUIStore((s) => s.setNotesPanelOpen);
  const notesPanelSize = useUIStore((s) => s.notesPanelSize);
  const setNotesPanelSize = useUIStore((s) => s.setNotesPanelSize);
  const notesPanelOffsetY = useUIStore((s) => s.notesPanelOffsetY);
  const setNotesPanelOffsetY = useUIStore((s) => s.setNotesPanelOffsetY);
  const wordWrap = useUIStore((s) => s.wordWrap);
  const notesEditorFontSize = useUIStore((s) => s.notesEditorFontSize);
  const notesEditorPaddingX = useUIStore((s) => s.notesEditorPaddingX);
  const notesEditorPaddingY = useUIStore((s) => s.notesEditorPaddingY);

  const isOpen = !!(activeTabId && notesPanelOpenTabs[activeTabId]);

  // Reactive subscription to the live tab.notes string — the InfoPanel's
  // inline editor writes to the same field via setTabNotes(); without this
  // selector, our local state would drift out of sync after every external edit.
  const setTabNotes = useWorkspaceStore((s) => s.setTabNotes);
  const content = useWorkspaceStore((s) => {
    if (!activeTabId) return '';
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) return tab.notes || '';
    }
    return '';
  });

  const handleChange = useCallback((next: string) => {
    console.warn('[TabNotesSlideout:onChange]', { tabId: activeTabId?.slice(-12), newLen: next.length });
    if (activeTabId) setTabNotes(activeTabId, next);
  }, [activeTabId, setTabNotes]);

  const handleClose = useCallback(() => {
    if (activeTabId) setNotesPanelOpen(activeTabId, false);
  }, [activeTabId, setNotesPanelOpen]);

  // Track the InfoPanel aside's left edge as our right anchor. Recomputed on
  // every window resize and after each render — cheap getBoundingClientRect.
  const [anchorRight, setAnchorRight] = useState<number>(0);
  useEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const aside = document.querySelector('[data-info-aside]') as HTMLElement | null;
      const rect = aside ? aside.getBoundingClientRect() : null;
      // If the aside is missing for some reason, fall back to viewport right edge.
      setAnchorRight(rect ? window.innerWidth - rect.left : MARGIN);
    };
    measure();
    window.addEventListener('resize', measure);
    // Repeat the measurement on each animation frame for a few seconds — the
    // aside is animatable (its own resize handle changes its width) and we
    // want to track that without subscribing to its inner store.
    const ro = new ResizeObserver(measure);
    const aside = document.querySelector('[data-info-aside]');
    if (aside) ro.observe(aside);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [isOpen]);

  // Anchor по нижнему краю модалки — экранная Y нижней кромки кнопки `[data-tab-notes-open-trigger]`.
  // При vertical resize окна (тянем верхний край) кнопка Open остаётся на месте (она в нижней части
  // правой InfoPanel'и, которая flex'ом укорачивается сверху). Значит и нижний край модалки
  // привязанный к Open будет на месте.
  const [anchorBottomY, setAnchorBottomY] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const btn = document.querySelector('[data-tab-notes-open-trigger]') as HTMLElement | null;
      if (!btn) { setAnchorBottomY(null); return; }
      const r = btn.getBoundingClientRect();
      setAnchorBottomY(r.bottom);
    };
    measure();
    window.addEventListener('resize', measure);
    // Только кнопка — не `document.body`. Body-observer стрелял на любое движение
    // модалки (она в Portal внутри body) → measure → setState → re-render → drag handler
    // получал новые координаты под собой → дёрганый drag. Кнопки достаточно: её
    // bounding rect меняется при window resize и при ресайзе соседних панелей.
    const ro = new ResizeObserver(measure);
    const btn = document.querySelector('[data-tab-notes-open-trigger]');
    if (btn) ro.observe(btn);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [isOpen]);

  // Live preview state — drag пишет сюда, store обновляется один раз на mouseup.
  // Раньше каждый mousemove делал setNotesPanelSize / setNotesPanelOffsetY → запись в
  // localStorage + IPC `app:setState` → SQLite на каждом кадре. 60 sync writes/sec вызывали
  // дёрганый drag. Теперь store-флушинг происходит при отпускании мыши.
  const [dragPreview, setDragPreview] = useState<{ w: number; h: number; offsetY: number } | null>(null);

  type ResizeEdge = 'left' | 'top' | 'bottom' | 'right-move' | 'corner-bl' | 'corner-br';
  const dragRef = useRef<null | {
    edge: ResizeEdge;
    startX: number; startY: number;
    startW: number; startH: number;
    startTop: number;
    startOffsetY: number;
  }>(null);
  const startResize = useCallback((edge: ResizeEdge, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const panelRect = (e.currentTarget as HTMLElement).closest('[data-tab-notes-slideout]')?.getBoundingClientRect();
    const curTop = panelRect ? panelRect.top : 0;
    dragRef.current = {
      edge,
      startX: e.clientX, startY: e.clientY,
      startW: notesPanelSize.width, startH: notesPanelSize.height,
      startTop: curTop,
      startOffsetY: notesPanelOffsetY,
    };
    // Инициализируем preview текущими значениями.
    setDragPreview({ w: notesPanelSize.width, h: notesPanelSize.height, offsetY: notesPanelOffsetY });

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;

      let nextW = d.startW;
      let nextH = d.startH;
      let nextOffsetY = d.startOffsetY;

      if (d.edge === 'left') {
        nextW = Math.max(MIN_W, Math.min(MAX_W, d.startW - dx));
      } else if (d.edge === 'top') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH - dy));
      } else if (d.edge === 'bottom') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH + dy));
      } else if (d.edge === 'right-move') {
        nextOffsetY = d.startOffsetY + dy;
      } else if (d.edge === 'corner-bl' || d.edge === 'corner-br') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH + dy));
        nextW = Math.max(MIN_W, Math.min(MAX_W, d.startW - dx));
      }
      setDragPreview({ w: nextW, h: nextH, offsetY: nextOffsetY });
    };
    const onUp = () => {
      // Финальный flush в store (localStorage + SQLite). Один раз, на отпускании.
      setDragPreview((prev) => {
        if (prev) {
          if (prev.w !== notesPanelSize.width || prev.h !== notesPanelSize.height) {
            setNotesPanelSize({ width: prev.w, height: prev.h });
          }
          if (prev.offsetY !== notesPanelOffsetY) {
            setNotesPanelOffsetY(prev.offsetY);
          }
        }
        return null;
      });
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [notesPanelSize, setNotesPanelSize, notesPanelOffsetY, setNotesPanelOffsetY]);

  // Esc closes. Click-outside also closes — but only if the click is OUTSIDE
  // both the panel itself and the Open trigger button (the trigger has its own
  // toggle handler; without this guard, clicking Open would close-then-reopen).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Inside the panel itself? leave it alone.
      if (target.closest('[data-tab-notes-slideout]')) return;
      // On the Open trigger button? let its own onClick handle the toggle.
      if (target.closest('[data-tab-notes-open-trigger]')) return;
      handleClose();
    };
    // Close when the Settings modal opens — it would otherwise overlap us.
    const onSettingsOpened = () => handleClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('settings:opened', onSettingsOpened);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('settings:opened', onSettingsOpened);
    };
  }, [isOpen, handleClose]);

  if (!activeTabId) return null;

  // Во время drag'а читаем из live preview, иначе — из store. Без preview флушинг store на
  // каждый mousemove делал drag дёрганым (см. dragPreview comment выше).
  const effectiveW = dragPreview ? dragPreview.w : notesPanelSize.width;
  const effectiveH = dragPreview ? dragPreview.h : notesPanelSize.height;
  const effectiveOffsetY = dragPreview ? dragPreview.offsetY : notesPanelOffsetY;

  // Clamp size to viewport every render so a previously-saved-bigger size
  // doesn't bleed past the screen when the window shrinks.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const availableW = Math.max(MIN_W, vw - anchorRight - MARGIN);
  const w = Math.min(effectiveW, availableW);
  const h = Math.min(effectiveH, vh - MARGIN * 2);
  // Vertical position: anchored to bottom edge of the Open trigger button, then shifted
  // by `effectiveOffsetY` (user drag of the right-edge handle). Низ модалки = anchorBottomY + offsetY.
  let top: number;
  if (anchorBottomY !== null) {
    top = anchorBottomY - h + effectiveOffsetY;
  } else {
    top = (vh - h) / 2 + effectiveOffsetY;
  }
  // Clamp в viewport — модалка не должна вылезать за края экрана.
  if (top < MARGIN) top = MARGIN;
  if (top + h > vh - MARGIN) top = vh - h - MARGIN;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="panel"
          data-tab-notes-slideout
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          style={{
            position: 'fixed',
            top,
            right: anchorRight,
            width: w,
            height: h,
            zIndex: 9991,
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Resize handles. Top/bottom change height; left changes width.
              The right-edge handle is for VERTICAL repositioning (drag up/down)
              — horizontal mouse motion is ignored, only Y is read. */}
          {/* Edge handles — sit between the corners (12-px corner inset each side)
              so corner-drags get priority. */}
          <div
            onMouseDown={(e) => startResize('top', e)}
            style={{ position: 'absolute', top: -3, left: 12, right: 12, height: 6, cursor: 'ns-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          <div
            onMouseDown={(e) => startResize('bottom', e)}
            style={{ position: 'absolute', bottom: -3, left: 12, right: 12, height: 6, cursor: 'ns-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          <div
            onMouseDown={(e) => startResize('left', e)}
            style={{ position: 'absolute', top: 12, bottom: 12, left: -3, width: 6, cursor: 'ew-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          {/* Right edge — vertical drag handle. dx игнорируем, dy меняет offsetY (смещение
              всей модалки от anchor'а Open). offsetY персистится в SQLite, позиция сохраняется
              между запусками приложения. */}
          <div
            onMouseDown={(e) => startResize('right-move', e)}
            style={{ position: 'absolute', top: 12, bottom: 12, right: -3, width: 6, cursor: 'ns-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          {/* Corner handles — bottom-left + bottom-right. Single drag grows BOTH
              height (symmetric, top+bottom together) and width (pulling left).
              Top corners are omitted because top/bottom is symmetric — the
              bottom corners alone cover all combinations. */}
          <div
            onMouseDown={(e) => startResize('corner-bl', e)}
            style={{ position: 'absolute', left: -3, bottom: -3, width: 14, height: 14, cursor: 'nesw-resize', zIndex: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          <div
            onMouseDown={(e) => startResize('corner-br', e)}
            style={{ position: 'absolute', right: -3, bottom: -3, width: 14, height: 14, cursor: 'nwse-resize', zIndex: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />

          {/* Editor — same MarkdownEditor as the inline notes; settings come
              from useUIStore.notesEditor* (font + padding) so the slideout
              respects the user's preferred sizing. */}
          <div style={{ flex: 1, minHeight: 0, position: 'relative', backgroundColor: '#1e1e2e' }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <MarkdownEditor
                content={content}
                onChange={handleChange}
                onGenerateTitle={generateAITitle}
                fontSize={notesEditorFontSize}
                contentPaddingX={notesEditorPaddingX}
                contentPaddingY={notesEditorPaddingY}
                wordWrap={wordWrap}
                showLineNumbers={false}
                compact
                foldStateKey={`tab-notes-slideout:${activeTabId}`}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
