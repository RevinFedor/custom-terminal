// Ctrl+Q — hold-and-release switching between projects.
//
// The selected project owns the titlebar highlight and the left sidebar. It
// does not own the workflow layout, so committing a row must never replace a
// pane, switch a workflow, or move the center tab.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { useWorkspaceStore, selectFocusedProjectId } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import {
  buildProjectSwitcherRows,
  initialProjectIndex,
  stepProjectIndex,
} from '../../utils/projectSwitcherModel.mjs';
import { TOP_STRIP_H } from '../../constants/layout';
import { emitProjectHoverPreview } from '../../constants/projectHoverPreview';

const PANEL_BG = '#1d1d1f';
const PANEL_BORDER = '#3a3a3d';
const SWITCHER_RADIUS = '0 0 8px 8px';
const Z_INDEX = 100500;

interface ProjectRow {
  id: string;
  name: string;
  icon: string | null;
  kind: 'home' | 'project';
  current: boolean;
}

/** Live rows shared by rendering and the fast Ctrl press/release path. */
function computeProjectRows(): ProjectRow[] {
  const workspace = useWorkspaceStore.getState();
  const projects = useProjectsStore.getState().projects as Record<string, {
    name?: string;
    icon?: string | null;
  }>;

  return buildProjectSwitcherRows({
    openProjectIds: Array.from(workspace.openProjects.keys()),
    projectHistory: workspace.projectHistory,
    currentProjectId: selectFocusedProjectId(workspace),
    onDashboard: workspace.view === 'dashboard',
    meta: (id: string) => ({
      name: projects[id]?.name
        || (isInboxProjectId(id) ? INBOX_PROJECT_NAME : (
          workspace.openProjects.get(id)?.projectPath?.split('/').filter(Boolean).pop() || 'Project'
        )),
      icon: projects[id]?.icon || null,
    }),
  }) as ProjectRow[];
}

export default function ProjectSwitcherOverlay() {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // Keep the visible rows fresh, without subscribing to the whole project Map
  // anywhere outside this short-lived overlay.
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const projectHistory = useWorkspaceStore((state) => state.projectHistory);
  const view = useWorkspaceStore((state) => state.view);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const projectsMeta = useProjectsStore((state) => state.projects);

  const openRef = useRef(false);
  openRef.current = open;
  const mouseBlockedRef = useRef(true);
  const rows = useMemo(
    () => (open ? computeProjectRows() : []),
    [open, openProjects, projectHistory, view, focusedProjectId, projectsMeta],
  );
  const rowsRef = useRef<ProjectRow[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const close = useCallback(() => {
    // Synchronous ownership release prevents a pointer commit followed by the
    // still-held Control keyup from committing a second row.
    openRef.current = false;
    setOpen(false);
    setSelectedIndex(-1);
  }, []);

  const commitRow = useCallback((row: ProjectRow | undefined) => {
    close();
    if (!row || row.current) return;
    const store = useWorkspaceStore.getState();
    if (row.kind === 'home') {
      void store.showDashboard();
      return;
    }

    // This is the same canonical action as clicking a project chip. It changes
    // focusedProjectId/projectHistory and therefore the sidebar, while keeping
    // activeProjectId, activeSpaceId and every pane placement untouched.
    store.showWorkspace(row.id);
  }, [close]);

  useEffect(() => {
    if (!open || selectedIndex >= 0 || rows.length === 0) return;
    setSelectedIndex(initialProjectIndex(rows));
  }, [open, rows, selectedIndex]);

  // Keyboard selection previews the exact same hover state as the titlebar
  // project card. Home has no project card, so it clears the preview.
  useEffect(() => {
    if (!open) {
      emitProjectHoverPreview(null);
      return;
    }
    const row = rows[selectedIndex];
    emitProjectHoverPreview(row?.kind === 'project' ? row.id : null);
  }, [open, rows, selectedIndex]);
  useEffect(() => () => emitProjectHoverPreview(null), []);

  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof (event as any).stopImmediatePropagation === 'function') {
        (event as any).stopImmediatePropagation();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // event.code keeps Ctrl+Q working on non-Latin keyboard layouts.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'KeyQ') {
        swallow(event);
        if (!openRef.current) {
          mouseBlockedRef.current = true;
          setOpen(true);
          setSelectedIndex(-1);
        } else {
          setSelectedIndex((previous) => stepProjectIndex(
            rowsRef.current,
            previous,
            event.shiftKey ? -1 : +1,
          ));
        }
        return;
      }
      if (!openRef.current) return;
      if (event.key === 'Escape') {
        swallow(event);
        close();
        return;
      }
      if (event.key === 'ArrowDown') {
        swallow(event);
        setSelectedIndex((previous) => stepProjectIndex(rowsRef.current, previous, +1));
        return;
      }
      if (event.key === 'ArrowUp') {
        swallow(event);
        setSelectedIndex((previous) => stepProjectIndex(rowsRef.current, previous, -1));
        return;
      }
      if (event.key === 'Enter') {
        swallow(event);
        commitRow(rowsRef.current[selectedIndexRef.current]);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!openRef.current || event.key !== 'Control') return;
      let effectiveRows = rowsRef.current;
      let index = selectedIndexRef.current;
      if (index < 0) {
        // Ctrl can be released before React paints the first overlay frame.
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

  // The pointer must move once before hover can replace keyboard selection;
  // opening the panel under a stationary cursor is not a user hover.
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
      onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}
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
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.button === 0) commitRow(row);
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
