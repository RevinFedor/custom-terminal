// Ctrl+Q — hold-and-release switcher for top-level places.
//
// Tabs belong to projects, but WINDOW LAYOUTS belong to workflows. Therefore
// Ctrl+Q switches Home / Inbox / workflow, while project navigation remains in
// the titlebar and Cmd+P. Selecting a workflow changes the whole saved layout,
// not merely which project's rows the sidebar shows.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home, Inbox as InboxIcon } from 'lucide-react';
import { useWorkspaceStore, selectFocusedProjectId } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import {
  INBOX_PROJECT_ID,
  INBOX_PROJECT_NAME,
  getInboxProjectPath,
} from '../../constants/systemProjects';
import {
  HOME_ROW_ID,
  buildWorkflowSwitcherRows,
  initialWorkflowIndex,
  stepWorkflowIndex,
} from '../../utils/workflowSwitcherModel.mjs';
import { TOP_STRIP_H } from '../../constants/layout';
import {
  resolveWorkflowIcon,
  workflowFallbackColor,
  workflowInitial,
} from '../../utils/workflowVisuals.mjs';

const PANEL_BG = '#1d1d1f';
const PANEL_BORDER = '#3a3a3d';
const SWITCHER_RADIUS = '0 0 8px 8px';
const Z_INDEX = 100500;

interface WorkflowRow {
  id: string;
  name: string;
  icon: string | null;
  kind: 'home' | 'inbox' | 'workflow';
  current: boolean;
}

function computeWorkflowRows(): WorkflowRow[] {
  const ws = useWorkspaceStore.getState();
  const projects = useProjectsStore.getState().projects as Record<string, {
    name?: string;
    path?: string;
    icon?: string | null;
  }>;
  return buildWorkflowSwitcherRows({
    spaces: ws.spaces.map((space) => ({
      ...space,
      icon: resolveWorkflowIcon(space, (projectId: string) => projects[projectId]?.icon || null),
    })),
    activeSpaceId: ws.activeSpaceId,
    onDashboard: ws.view === 'dashboard',
    onInbox: ws.view === 'workspace' && selectFocusedProjectId(ws) === INBOX_PROJECT_ID,
    inboxId: INBOX_PROJECT_ID,
    inboxName: projects[INBOX_PROJECT_ID]?.name || INBOX_PROJECT_NAME,
    inboxIcon: projects[INBOX_PROJECT_ID]?.icon || null,
  }) as WorkflowRow[];
}

export default function WorkflowSwitcherOverlay() {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const spaces = useWorkspaceStore((state) => state.spaces);
  const activeSpaceId = useWorkspaceStore((state) => state.activeSpaceId);
  const view = useWorkspaceStore((state) => state.view);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const projectsMeta = useProjectsStore((state) => state.projects);

  const openRef = useRef(false);
  openRef.current = open;
  const mouseBlockedRef = useRef(true);
  const rows = useMemo(
    () => (open ? computeWorkflowRows() : []),
    [open, spaces, activeSpaceId, view, focusedProjectId, projectsMeta],
  );
  const rowsRef = useRef<WorkflowRow[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setSelectedIndex(-1);
  }, []);

  const commitRow = useCallback((row: WorkflowRow | undefined) => {
    close();
    if (!row || row.current) return;
    const store = useWorkspaceStore.getState();
    if (row.kind === 'home') {
      void store.showDashboard();
      return;
    }
    if (row.kind === 'inbox') {
      const project = useProjectsStore.getState().projects[INBOX_PROJECT_ID];
      void store.openProject(INBOX_PROJECT_ID, project?.path || getInboxProjectPath());
      return;
    }
    store.switchWorkspaceSpace(row.id);
    if (useWorkspaceStore.getState().view !== 'workspace') {
      useWorkspaceStore.setState({ view: 'workspace' });
    }
  }, [close]);

  useEffect(() => {
    if (!open || selectedIndex >= 0 || rows.length === 0) return;
    setSelectedIndex(initialWorkflowIndex(rows));
  }, [open, rows, selectedIndex]);

  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof (event as any).stopImmediatePropagation === 'function') {
        (event as any).stopImmediatePropagation();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'KeyQ') {
        swallow(event);
        if (!openRef.current) {
          mouseBlockedRef.current = true;
          setOpen(true);
          setSelectedIndex(-1);
        } else {
          setSelectedIndex((previous) => stepWorkflowIndex(
            rowsRef.current,
            previous,
            event.shiftKey ? -1 : +1,
          ));
        }
        return;
      }
      if (!openRef.current) return;
      if (event.key === 'Escape') { swallow(event); close(); return; }
      if (event.key === 'ArrowDown') {
        swallow(event);
        setSelectedIndex((previous) => stepWorkflowIndex(rowsRef.current, previous, +1));
        return;
      }
      if (event.key === 'ArrowUp') {
        swallow(event);
        setSelectedIndex((previous) => stepWorkflowIndex(rowsRef.current, previous, -1));
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
        effectiveRows = computeWorkflowRows();
        index = initialWorkflowIndex(effectiveRows);
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
      data-workflow-switcher-root
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
              data-workflow-switcher-row={row.id}
              data-workflow-switcher-current={row.current ? '1' : undefined}
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
                <Home size={14} style={{ flexShrink: 0, color: '#F09018' }} aria-hidden />
              ) : row.kind === 'inbox' ? (
                row.icon ? (
                  <img
                    data-project-icon={INBOX_PROJECT_ID}
                    src={row.icon}
                    alt=""
                    draggable={false}
                    style={{ width: 15, height: 15, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
                  />
                ) : (
                  <InboxIcon size={14} style={{ flexShrink: 0, color: '#9ca3af' }} aria-hidden />
                )
              ) : row.icon ? (
                <img
                  data-workflow-icon={row.id}
                  src={row.icon}
                  alt=""
                  draggable={false}
                  style={{ width: 16, height: 16, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: workflowFallbackColor(row.id),
                    color: '#fff',
                    fontSize: 8,
                    fontWeight: 800,
                  }}
                >
                  {workflowInitial(row.name)}
                </span>
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
