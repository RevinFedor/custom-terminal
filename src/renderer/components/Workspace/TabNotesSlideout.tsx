import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { generateAITitle } from '../../utils/generateAITitle';

// No props. The slideout binds itself to whichever tab id is currently flagged
// open in useUIStore.notesPanelOpenTabs (one-at-a-time policy). Independence
// from the workspace activeTabId is intentional: user can Cmd-click the notes
// button on a non-active tab and the slideout opens for THAT tab while the
// terminal stays on the previously-active tab.

const MARGIN = 12;
const MIN_W = 240;
const MAX_W = 1200;
const MIN_H = 180;
const MAX_H = 900;

// Slide-in notes panel anchored to the RIGHT edge of the left-side TabSidebar
// (the `[data-tabbar-vertical]` element rendered inside TabSidebar.tsx). Opens
// left→right: its left edge sits flush against the sidebar's right edge.
//
// Resize handles (mirror of the previous right-anchored version):
//   • right edge   — width drag (was: left edge)
//   • left edge    — vertical position drag (was: right edge), so it's right
//                    next to the TabItem button that opens it; user pulls the
//                    handle along the same column as the trigger
//   • top / bottom — height drag (unchanged)
//   • corner-br / corner-tr — height + width (now on the FAR side from anchor)
//
// Anchor: every frame on resize/window-resize, reads boundingClientRect of
// `[data-tabbar-vertical]` and parks the panel's left edge against the
// sidebar's right edge. Size is persisted in useUIStore.notesPanelSize → SQLite.
export default function TabNotesSlideout() {
  const notesPanelOpenTabs = useUIStore((s) => s.notesPanelOpenTabs);
  const setNotesPanelOpen = useUIStore((s) => s.setNotesPanelOpen);
  const notesPanelSize = useUIStore((s) => s.notesPanelSize);
  const setNotesPanelSize = useUIStore((s) => s.setNotesPanelSize);
  const notesPanelOffsetY = useUIStore((s) => s.notesPanelOffsetY);
  const setNotesPanelOffsetY = useUIStore((s) => s.setNotesPanelOffsetY);
  const wordWrap = useUIStore((s) => s.wordWrap);
  const notesEditorFontSize = useUIStore((s) => s.notesExpandedFontSize);
  const notesEditorPaddingX = useUIStore((s) => s.notesEditorPaddingX);
  const notesEditorPaddingY = useUIStore((s) => s.notesEditorPaddingY);

  // One-at-a-time: whichever tab id has true in the map is THE slideout target.
  const activeTabId: string | null = (() => {
    for (const [tid, on] of Object.entries(notesPanelOpenTabs)) if (on) return tid;
    return null;
  })();
  const isOpen = activeTabId !== null;

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
    if (activeTabId) setTabNotes(activeTabId, next);
  }, [activeTabId, setTabNotes]);

  const handleClose = useCallback(() => {
    if (activeTabId) setNotesPanelOpen(activeTabId, false);
  }, [activeTabId, setNotesPanelOpen]);

  // Track TabSidebar right edge as our LEFT anchor. Falls back to viewport
  // left edge (MARGIN) if the sidebar isn't rendered (defensive).
  const [anchorLeft, setAnchorLeft] = useState<number>(MARGIN);
  useEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const sidebar = document.querySelector('[data-tabbar-vertical]') as HTMLElement | null;
      const rect = sidebar ? sidebar.getBoundingClientRect() : null;
      setAnchorLeft(rect ? rect.right : MARGIN);
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    const sidebar = document.querySelector('[data-tabbar-vertical]');
    if (sidebar) ro.observe(sidebar);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [isOpen]);

  // Anchor по нижнему краю модалки — экранная Y нижней кромки кнопки
  // `[data-tab-notes-open-trigger][data-tab-id="<activeTabId>"]`. Конкретный
  // tab-id обязателен потому что при Cmd-hover кнопки появляются на нескольких
  // вкладках одновременно — без фильтра querySelector возьмёт первую попавшуюся.
  const [anchorBottomY, setAnchorBottomY] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen || !activeTabId) return;
    const sel = `[data-tab-notes-open-trigger][data-tab-id="${activeTabId}"]`;
    const measure = () => {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (!btn) { setAnchorBottomY(null); return; }
      const r = btn.getBoundingClientRect();
      setAnchorBottomY(r.bottom);
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    const btn = document.querySelector(sel);
    if (btn) ro.observe(btn);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [isOpen, activeTabId]);

  // Live preview state — drag пишет сюда, store обновляется один раз на mouseup.
  const [dragPreview, setDragPreview] = useState<{ w: number; h: number; offsetY: number } | null>(null);

  // Edges (post-flip):
  //   'right'      — width drag (anchored to TabSidebar.right; left fixed)
  //   'top'/'bottom' — height
  //   'left-move'  — vertical position (was 'right-move' in mirror version)
  //   'corner-br'  — height + width (bottom + right grow)
  //   'corner-tr'  — top + width
  type ResizeEdge = 'right' | 'top' | 'bottom' | 'left-move' | 'corner-tr' | 'corner-br';
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
    setDragPreview({ w: notesPanelSize.width, h: notesPanelSize.height, offsetY: notesPanelOffsetY });

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;

      let nextW = d.startW;
      let nextH = d.startH;
      let nextOffsetY = d.startOffsetY;

      // Anchored to LEFT now — width grows to the RIGHT, so dx is positive-grow.
      if (d.edge === 'right') {
        nextW = Math.max(MIN_W, Math.min(MAX_W, d.startW + dx));
      } else if (d.edge === 'top') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH - dy));
      } else if (d.edge === 'bottom') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH + dy));
      } else if (d.edge === 'left-move') {
        nextOffsetY = d.startOffsetY + dy;
      } else if (d.edge === 'corner-br') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH + dy));
        nextW = Math.max(MIN_W, Math.min(MAX_W, d.startW + dx));
      } else if (d.edge === 'corner-tr') {
        nextH = Math.max(MIN_H, Math.min(MAX_H, d.startH - dy));
        nextW = Math.max(MIN_W, Math.min(MAX_W, d.startW + dx));
      }
      setDragPreview({ w: nextW, h: nextH, offsetY: nextOffsetY });
    };
    const onUp = () => {
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
      if (target.closest('[data-tab-notes-slideout]')) return;
      if (target.closest('[data-tab-notes-open-trigger]')) return;
      if (target.closest('[data-command-palette]')) return;
      if (target.closest('[data-context-menu]')) return;
      if (target.closest('[data-ai-paste-indicator]')) return;
      handleClose();
    };
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

  const effectiveW = dragPreview ? dragPreview.w : notesPanelSize.width;
  const effectiveH = dragPreview ? dragPreview.h : notesPanelSize.height;
  const effectiveOffsetY = dragPreview ? dragPreview.offsetY : notesPanelOffsetY;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // After flip: width is capped by viewport-right edge (anchor is LEFT).
  const availableW = Math.max(MIN_W, vw - anchorLeft - MARGIN);
  const w = Math.min(effectiveW, availableW);
  const h = Math.min(effectiveH, vh - MARGIN * 2);
  // Vertical position: anchored to bottom edge of the Open trigger button (same
  // as before), then shifted by `effectiveOffsetY`. Низ модалки = anchorBottomY + offsetY.
  let top: number;
  if (anchorBottomY !== null) {
    top = anchorBottomY - h + effectiveOffsetY;
  } else {
    top = (vh - h) / 2 + effectiveOffsetY;
  }
  if (top < MARGIN) top = MARGIN;
  if (top + h > vh - MARGIN) top = vh - h - MARGIN;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="panel"
          data-tab-notes-slideout
          // Flipped enter/exit direction: now slides IN from the LEFT
          // (negative x → 0). Matches the new left-anchored layout.
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          style={{
            position: 'fixed',
            top,
            left: anchorLeft,
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
          {/* Resize handles. Mirror of the previous version: width drag now on
              the RIGHT edge, vertical-position drag now on the LEFT edge. */}
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
          {/* RIGHT edge — width drag (was LEFT in the mirror version). */}
          <div
            onMouseDown={(e) => startResize('right', e)}
            style={{ position: 'absolute', top: 12, bottom: 12, right: -3, width: 6, cursor: 'ew-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          {/* LEFT edge — vertical drag handle (was RIGHT in the mirror version).
              Лежит ровно вдоль кромки которая прижата к TabSidebar; юзер тянет
              слайдер той же стороной, что и хватал кнопку Open в активной вкладке. */}
          <div
            onMouseDown={(e) => startResize('left-move', e)}
            style={{ position: 'absolute', top: 12, bottom: 12, left: -3, width: 6, cursor: 'ns-resize', zIndex: 2 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          {/* Bottom-right and top-right corners — both height + width. With
              anchor on LEFT, only RIGHT-side corners make sense (LEFT corners
              would resize the height while keeping the panel glued to anchor —
              redundant with separate top/bottom edge handles). */}
          <div
            onMouseDown={(e) => startResize('corner-br', e)}
            style={{ position: 'absolute', right: -3, bottom: -3, width: 14, height: 14, cursor: 'nwse-resize', zIndex: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />
          <div
            onMouseDown={(e) => startResize('corner-tr', e)}
            style={{ position: 'absolute', right: -3, top: -3, width: 14, height: 14, cursor: 'nesw-resize', zIndex: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
          />

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
                compact
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
