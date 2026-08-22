// Ctrl+Q — the same hold-and-release gesture as Ctrl+Tab, one level up.
//
// Deliberately the SIMPLER sibling of TabSwitcherOverlay, and the differences
// are all consequences of one fact: there are six or seven projects, not dozens
// of tabs.
//
//   • no search — the whole list fits on screen, so a filter would be a control
//     with nothing to do;
//   • no scrolling — same reason;
//   • nothing is hidden — Ctrl+Tab drops what is already visible because a list
//     of "every tab" would be useless; here "everything" IS the useful list;
//   • Home is a row — it is a destination in the titlebar, so it is a
//     destination here. A switcher that silently omits one of the places you can
//     be is a map with a hole in it. (Inbox needs no special case: it is an open
//     project like any other and arrives through the same list.)
//
// What it keeps from the tab switcher, because these are properties of the
// GESTURE and not of what is being switched: row 1 is where you are, the
// highlight starts on row 2, the panel hangs off the top strip, and a fast tap
// (Ctrl released before the first frame) still lands on the previous place.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { useWorkspaceStore, selectFocusedProjectId } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import {
  HOME_ROW_ID,
  buildProjectSwitcherRows,
  initialProjectIndex,
  stepProjectIndex,
} from '../../utils/projectSwitcherModel.mjs';
import { TOP_STRIP_H } from '../../constants/layout';
import { emitProjectHoverPreview } from '../../constants/projectHoverPreview';

const PANEL_BG = '#1d1d1f';
const PANEL_BORDER = '#3a3a3d';
const SWITCHER_RADIUS = '0 0 8px 8px';
// Above the tab switcher's own z (100500) is unnecessary — the two are never
// open together — but it must clear the same file preview.
const Z_INDEX = 100500;

interface ProjectRow {
  id: string;
  name: string;
  icon: string | null;
  kind: 'home' | 'project';
  current: boolean;
}

/** Rows straight from the live stores — shared by the render path and the fast tap. */
function computeProjectRows(): ProjectRow[] {
  const ws = useWorkspaceStore.getState();
  const projectsMeta = useProjectsStore.getState().projects as Record<string, { name?: string; icon?: string | null }>;
  return buildProjectSwitcherRows({
    openProjectIds: Array.from(ws.openProjects.keys()),
    projectHistory: ws.projectHistory,
    currentProjectId: selectFocusedProjectId(ws),
    onDashboard: ws.view === 'dashboard',
    meta: (id: string) => ({
      name: projectsMeta[id]?.name
        || (isInboxProjectId(id) ? INBOX_PROJECT_NAME : (
          ws.openProjects.get(id)?.projectPath?.split('/').filter(Boolean).pop() || 'Project'
        )),
      icon: projectsMeta[id]?.icon || null,
    }),
  }) as ProjectRow[];
}

export default function ProjectSwitcherOverlay() {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // Subscriptions that keep the rendered list fresh while the panel is open.
  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const projectHistory = useWorkspaceStore((s) => s.projectHistory);
  const view = useWorkspaceStore((s) => s.view);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const projectsMeta = useProjectsStore((s) => s.projects);

  const openRef = useRef(false);
  openRef.current = open;
  const mouseBlockedRef = useRef(true);

  const rows: ProjectRow[] = useMemo(
    () => (open ? computeProjectRows() : []),
    [open, openProjects, projectHistory, view, focusedProjectId, projectsMeta],
  );
  const rowsRef = useRef<ProjectRow[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const close = useCallback(() => {
    setOpen(false);
    setSelectedIndex(-1);
  }, []);

  const commitRow = useCallback((row: ProjectRow | undefined) => {
    close();
    if (!row || row.current) return; // staying put is not a navigation
    const store = useWorkspaceStore.getState();
    if (row.kind === 'home') {
      void store.showDashboard();
      return;
    }
    // An open project only needs the view moved to it — the sidebar pointer and
    // the project history are showWorkspace's job, and it does not touch which
    // tab is on screen.
    store.showWorkspace(row.id);
    if (store.view !== 'workspace') useWorkspaceStore.setState({ view: 'workspace' });
  }, [close]);

  // Resolve the initial highlight once rows exist (same two-step as Ctrl+Tab:
  // the key handler cannot compute it before the first render).
  useEffect(() => {
    if (!open || selectedIndex >= 0 || rows.length === 0) return;
    setSelectedIndex(initialProjectIndex(rows));
  }, [open, rows, selectedIndex]);

  // Выбранная строка = наведение на карточку проекта в титлбаре.
  //
  // Панель показывает выбор внутри себя, но проект человек знает по карточке
  // наверху, и без этого две части экрана говорят о разном. Сообщаем только
  // «сейчас стоим вот на этом» — как именно выглядит наведение, решает сама
  // карточка, поэтому подсветка не может разойтись с мышиной.
  //
  // Home — не проект, поэтому в титлбаре гасим всё: чужая карточка не должна
  // оставаться подсвеченной, пока выбран Dashboard.
  useEffect(() => {
    if (!open) { emitProjectHoverPreview(null); return; }
    const row = rows[selectedIndex];
    emitProjectHoverPreview(row && row.kind === 'project' ? row.id : null);
  }, [open, rows, selectedIndex]);
  // Панель может исчезнуть вместе с переходом — снимаем подсветку и тогда.
  useEffect(() => () => emitProjectHoverPreview(null), []);

  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // e.code, not e.key: on a RU layout Ctrl+Q is Ctrl+Й, and the gesture must
      // not depend on which alphabet is active.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyQ') {
        swallow(e);
        if (!openRef.current) {
          mouseBlockedRef.current = true;
          setOpen(true);
          setSelectedIndex(-1);
        } else {
          setSelectedIndex((prev) => stepProjectIndex(rowsRef.current, prev, e.shiftKey ? -1 : +1));
        }
        return;
      }
      if (!openRef.current) return;
      if (e.key === 'Escape') { swallow(e); close(); return; }
      if (e.key === 'ArrowDown') { swallow(e); setSelectedIndex((p) => stepProjectIndex(rowsRef.current, p, +1)); return; }
      if (e.key === 'ArrowUp') { swallow(e); setSelectedIndex((p) => stepProjectIndex(rowsRef.current, p, -1)); return; }
      if (e.key === 'Enter') { swallow(e); commitRow(rowsRef.current[selectedIndexRef.current]); }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!openRef.current || e.key !== 'Control') return;
      let effectiveRows = rowsRef.current;
      let index = selectedIndexRef.current;
      if (index < 0) {
        // Fast tap: Ctrl released before React rendered the first frame. Rebuild
        // from the live stores so the classic "go to the previous place" still
        // fires — same fallback the tab switcher needs, for the same reason.
        effectiveRows = computeProjectRows();
        index = initialProjectIndex(effectiveRows);
      }
      commitRow(effectiveRows[index]);
    };

    const onBlur = () => { if (openRef.current) close(); };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [close, commitRow]);

  // Phantom-hover guard: opening under a resting cursor must not steal the
  // keyboard's selection. Unblocked by the first REAL mouse move.
  useEffect(() => {
    if (!open) return;
    mouseBlockedRef.current = true;
    const unblock = () => { mouseBlockedRef.current = false; };
    window.addEventListener('mousemove', unblock, { once: true });
    return () => window.removeEventListener('mousemove', unblock);
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-project-switcher-root
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z_INDEX,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: TOP_STRIP_H,
      }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        style={{
          width: 360,
          border: `1px solid ${PANEL_BORDER}`,
          borderTop: 'none',
          borderRadius: SWITCHER_RADIUS,
          background: PANEL_BG,
          boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontSize: 13,
          padding: '4px 6px 6px',
        }}
      >
        {rows.map((row, index) => {
          const selected = index === selectedIndex;
          return (
            <div
              key={row.id}
              data-project-switcher-row={row.id}
              data-project-switcher-current={row.current ? '1' : undefined}
              onPointerEnter={() => { if (!mouseBlockedRef.current) setSelectedIndex(index); }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.button === 0) commitRow(row);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                marginBottom: 1,
                borderRadius: 5,
                cursor: 'pointer',
                userSelect: 'none',
                background: selected ? 'rgba(255,255,255,0.10)' : 'transparent',
                // The anchor row reads as a starting point, not a target: a left
                // rail and dimmed text, never the selection ring — the ring
                // belongs to the row the keyboard is on, and two rings would ask
                // "which of these am I picking?". Same language as Ctrl+Tab.
                boxShadow: selected
                  ? 'inset 0 0 0 1px rgba(255,255,255,0.30)'
                  : (row.current ? 'inset 2px 0 0 0 #6e6e76' : 'none'),
              }}
            >
              {row.kind === 'home' ? (
                <Home size={13} style={{ flexShrink: 0, color: '#F09018' }} aria-hidden />
              ) : row.icon ? (
                <img
                  data-project-icon={row.id}
                  src={row.icon}
                  alt=""
                  draggable={false}
                  style={{ width: 13, height: 13, borderRadius: 2, objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 2,
                    flexShrink: 0,
                    border: '1px dashed rgba(148,163,184,0.8)',
                    background: 'rgba(148,163,184,0.08)',
                  }}
                />
              )}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: row.current ? '#9a9a9f' : '#e6e6e6',
                }}
              >
                {row.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
