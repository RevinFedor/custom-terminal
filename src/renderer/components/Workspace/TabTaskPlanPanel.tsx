import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, ChevronUp, CornerDownRight, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
  useWorkspaceStore,
  type TabTaskPlanDocument,
  type TabTaskPlanItem,
  type TabTaskPlanOperation,
} from '../../store/useWorkspaceStore';
import { useUIStore, type SessionStatusDef } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');
const path = window.require('path');

const EMPTY_PLAN: TabTaskPlanDocument = {
  version: 1,
  revision: 0,
  items: [],
  history: { past: [], future: [] },
  updatedAt: null,
  updatedBy: null,
};

type TmpFile = { name: string; path: string; isDirectory?: boolean };

function loadExpanded(tabId: string): boolean {
  try {
    const value = JSON.parse(localStorage.getItem('noted-terminal-task-plan-expanded-tabs') || '{}');
    return value?.[tabId] === true;
  } catch {
    return false;
  }
}

function saveExpanded(tabId: string, expanded: boolean) {
  try {
    const value = JSON.parse(localStorage.getItem('noted-terminal-task-plan-expanded-tabs') || '{}');
    const next = { ...(value && typeof value === 'object' ? value : {}), [tabId]: expanded };
    const entries = Object.entries(next);
    const capped = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : next;
    localStorage.setItem('noted-terminal-task-plan-expanded-tabs', JSON.stringify(capped));
  } catch {}
}

const TASK_PLAN_WIDTH_STORAGE_KEY = 'noted-terminal-task-plan-widths';
const TASK_PLAN_MIN_WIDTH = 156;
const TASK_PLAN_AUTO_MAX_WIDTH = 380;
const TASK_PLAN_MAX_WIDTH = 520;

function loadPanelWidth(tabId: string): number | null {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_PLAN_WIDTH_STORAGE_KEY) || '{}');
    const width = Number(value?.[tabId]);
    return Number.isFinite(width) ? Math.max(TASK_PLAN_MIN_WIDTH, Math.min(TASK_PLAN_MAX_WIDTH, width)) : null;
  } catch {
    return null;
  }
}

function savePanelWidth(tabId: string, width: number) {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_PLAN_WIDTH_STORAGE_KEY) || '{}');
    const next = { ...(value && typeof value === 'object' ? value : {}), [tabId]: Math.round(width) };
    const entries = Object.entries(next);
    const capped = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : next;
    localStorage.setItem(TASK_PLAN_WIDTH_STORAGE_KEY, JSON.stringify(capped));
  } catch {}
}

function renderTitle(title: string) {
  const parts = title.split(/(@[^@]*?\.md)/g).filter(Boolean);
  return parts.map((part, index) => part.startsWith('@') && part.endsWith('.md') ? (
    <code
      key={`${part}-${index}`}
      style={{
        padding: '1px 4px',
        borderRadius: 4,
        color: '#c4b5fd',
        background: 'rgba(139,92,246,0.12)',
        border: '1px solid rgba(139,92,246,0.18)',
        fontSize: '0.92em',
      }}
    >
      {part}
    </code>
  ) : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>);
}

function PlanTitleField({
  value,
  projectPath,
  autoFocus,
  onCommit,
  onAutoFocusConsumed,
}: {
  value: string;
  projectPath: string;
  autoFocus: boolean;
  onCommit: (title: string) => void;
  onAutoFocusConsumed: () => void;
}) {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(value);
  const [files, setFiles] = useState<TmpFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelBlurCommitRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!autoFocus) return;
    setEditing(true);
    setDraft(value);
    onAutoFocusConsumed();
  }, [autoFocus, onAutoFocusConsumed, value]);

  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const atIndex = draft.lastIndexOf('@');
  const suffix = atIndex >= 0 ? draft.slice(atIndex + 1) : '';
  const wantsFiles = editing && !pickerDismissed && atIndex >= 0 && !suffix.includes('.md');

  useEffect(() => {
    if (!wantsFiles || files !== null || !projectPath) return;
    const tmpPath = path.join(projectPath, 'docs', 'tmp');
    ipcRenderer.invoke('file:read-directory', tmpPath).then((items: TmpFile[]) => {
      setFiles((Array.isArray(items) ? items : []).filter((item) => !item.isDirectory && item.name.toLowerCase().endsWith('.md')));
    }).catch(() => setFiles([]));
  }, [files, projectPath, wantsFiles]);

  const matches = useMemo(() => {
    if (!wantsFiles || !files) return [];
    const query = suffix.trim().toLocaleLowerCase();
    return files.filter((file) => !query || file.name.toLocaleLowerCase().includes(query)).slice(0, 10);
  }, [files, suffix, wantsFiles]);

  useLayoutEffect(() => {
    if (!wantsFiles || matches.length === 0) {
      setAnchorRect(null);
      return;
    }
    const measure = () => setAnchorRect(inputRef.current?.getBoundingClientRect() || null);
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [matches.length, wantsFiles]);

  useEffect(() => setSelectedFile(0), [suffix]);

  const chooseFile = useCallback((file: TmpFile) => {
    const prefix = atIndex >= 0 ? draft.slice(0, atIndex) : draft;
    setDraft(`${prefix}@${file.name}`);
    setPickerDismissed(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [atIndex, draft]);

  const finish = useCallback((commit: boolean) => {
    const title = draft.trim();
    cancelBlurCommitRef.current = !commit;
    setEditing(false);
    setPickerDismissed(false);
    setAnchorRect(null);
    if (commit && title && title !== value) onCommit(title);
    else setDraft(value);
  }, [draft, onCommit, value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { cancelBlurCommitRef.current = false; setEditing(true); setPickerDismissed(false); }}
        title="Редактировать"
        style={{
          display: '-webkit-box', width: '100%', minWidth: 0, padding: '3px 5px',
          textAlign: 'left', color: '#d2d2d2', background: 'transparent', border: '1px solid transparent',
          borderRadius: 5, cursor: 'text', overflow: 'hidden', whiteSpace: 'normal',
          WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
          fontSize: 12, lineHeight: 1.3, overflowWrap: 'anywhere', outline: 'none',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.045)'; event.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.borderColor = 'transparent'; }}
      >
        {renderTitle(value)}
      </button>
    );
  }

  const pickerHeight = Math.min(220, 8 + matches.length * 31);
  const pickerTop = anchorRect
    ? (window.innerHeight - anchorRect.bottom >= pickerHeight + 8
      ? anchorRect.bottom + 4
      : Math.max(8, anchorRect.top - pickerHeight - 4))
    : 0;
  const picker = anchorRect && matches.length > 0 ? ReactDOM.createPortal(
    <div
      data-task-plan-file-picker
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 328)),
        top: pickerTop,
        width: Math.min(320, window.innerWidth - 16),
        maxHeight: 220,
        overflowY: 'auto',
        zIndex: 2147482500,
        padding: 4,
        borderRadius: 7,
        background: '#18181b',
        border: '1px solid #3a3a40',
        boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {matches.map((file, index) => (
        <button
          key={file.path}
          type="button"
          onClick={() => chooseFile(file)}
          style={{
            display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left',
            border: 0, borderRadius: 5, cursor: 'pointer', color: index === selectedFile ? '#fff' : '#aaa',
            background: index === selectedFile ? 'rgba(139,92,246,0.24)' : 'transparent',
            fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          @{file.name}
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setPickerDismissed(false); }}
        onBlur={() => {
          if (cancelBlurCommitRef.current) {
            cancelBlurCommitRef.current = false;
            return;
          }
          finish(true);
        }}
        onKeyDown={(event) => {
          if (matches.length > 0 && wantsFiles) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedFile((index) => (index + 1) % matches.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedFile((index) => (index - 1 + matches.length) % matches.length);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              chooseFile(matches[selectedFile]);
              return;
            }
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            inputRef.current?.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            if (wantsFiles && !pickerDismissed) setPickerDismissed(true);
            else finish(false);
          }
        }}
        style={{
          width: '100%', minWidth: 0, padding: '3px 5px', color: '#eee', background: '#17171a',
          border: '1px solid rgba(139,92,246,0.55)', borderRadius: 5, outline: 'none', fontSize: 12,
        }}
      />
      {picker}
    </>
  );
}

function StatusMarker({ status, size, shape }: { status: SessionStatusDef; size: number; shape: 'dot' | 'square' }) {
  return (
    <span
      title={status.description ? `${status.label} — ${status.description}` : status.label}
      style={{
        display: 'inline-block', width: size, height: size, flexShrink: 0,
        borderRadius: shape === 'dot' ? '50%' : Math.max(1, Math.round(size * 0.22)),
        background: status.color,
        boxShadow: `0 0 0 1px ${status.color}55`,
      }}
    />
  );
}

export default function TabTaskPlanPanel({ tabId, projectPath }: { tabId: string; projectPath: string }) {
  const plan = useWorkspaceStore((state) => {
    for (const workspace of state.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab.taskPlan || EMPTY_PLAN;
    }
    return EMPTY_PLAN;
  });
  const applyOperations = useWorkspaceStore((state) => state.applyTabTaskPlanOperations);
  const undo = useWorkspaceStore((state) => state.undoTabTaskPlan);
  const redo = useWorkspaceStore((state) => state.redoTabTaskPlan);
  const taskStatuses = useUIStore((state) => state.taskStatuses);
  const marker = useUIStore((state) => state.taskStatusMarker);
  const [expanded, setExpanded] = useState(() => loadExpanded(tabId));
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [statusMenu, setStatusMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [autoWidth, setAutoWidth] = useState(TASK_PLAN_MIN_WIDTH);
  const [manualWidth, setManualWidth] = useState<number | null>(() => loadPanelWidth(tabId));
  const [isResizing, setIsResizing] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const titleMeasureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(loadExpanded(tabId));
    setManualWidth(loadPanelWidth(tabId));
  }, [tabId]);

  const setPanelExpanded = useCallback((next: boolean) => {
    setExpanded(next);
    saveExpanded(tabId, next);
  }, [tabId]);

  useEffect(() => {
    if (!statusMenu) return;
    const close = (event: MouseEvent) => {
      if (statusMenuRef.current?.contains(event.target as Node)) return;
      setStatusMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setStatusMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape, true);
    };
  }, [statusMenu]);

  useLayoutEffect(() => {
    if (plan.items.length === 0) {
      setAutoWidth(TASK_PLAN_MIN_WIDTH);
      return;
    }
    const children = Array.from(titleMeasureRef.current?.children || []) as HTMLElement[];
    const widestTitle = children.reduce((width, child) => Math.max(width, child.offsetWidth), 0);
    setAutoWidth(Math.max(TASK_PLAN_MIN_WIDTH, Math.min(TASK_PLAN_AUTO_MAX_WIDTH, Math.ceil(widestTitle + 70))));
  }, [plan.items]);

  const statusById = useMemo(() => new Map(taskStatuses.map((status) => [status.id, status])), [taskStatuses]);

  const apply = useCallback(async (operations: TabTaskPlanOperation[]) => {
    return applyOperations(tabId, operations);
  }, [applyOperations, tabId]);

  const addRoot = useCallback(async () => {
    const document = await apply([{ type: 'add_task', title: 'Новая задача' }]);
    const created = document?.items[document.items.length - 1];
    if (created) {
      setPanelExpanded(true);
      setAutoEditId(created.id);
    }
  }, [apply, setPanelExpanded]);

  const addSubtask = useCallback(async (task: TabTaskPlanItem) => {
    const document = await apply([{ type: 'add_subtask', taskId: task.id, title: 'Новая подзадача' }]);
    const updated = document?.items.find((item) => item.id === task.id);
    const created = updated?.subtasks[updated.subtasks.length - 1];
    if (created) setAutoEditId(created.id);
  }, [apply]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;

    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const availableWidth = Math.max(96, (panel.parentElement?.clientWidth || window.innerWidth) - 2);
    const minWidth = plan.items.length === 0 ? 96 : TASK_PLAN_MIN_WIDTH;
    const maxWidth = Math.min(TASK_PLAN_MAX_WIDTH, availableWidth);
    let latestWidth = startWidth;
    setIsResizing(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      latestWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
      setManualWidth(latestWidth);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
      savePanelWidth(tabId, latestWidth);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [plan.items.length, tabId]);

  const statusMenuNode = statusMenu ? ReactDOM.createPortal(
    <div
      ref={statusMenuRef}
      data-task-plan-status-menu
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(statusMenu.x, window.innerWidth - 276)),
        top: Math.max(8, Math.min(statusMenu.y, window.innerHeight - Math.min(360, 42 + taskStatuses.length * 42))),
        width: 268,
        maxHeight: 350,
        overflowY: 'auto',
        zIndex: 2147482600,
        padding: 3,
        borderRadius: 8,
        background: '#18181b',
        border: '1px solid #3a3a40',
        boxShadow: '0 14px 34px rgba(0,0,0,0.6)',
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={() => { void apply([{ type: 'update_task', taskId: statusMenu.taskId, statusId: null }]); setStatusMenu(null); }}
        style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6, padding: '5px 6px', color: '#aaa', background: 'transparent', border: 0, borderRadius: 5, cursor: 'pointer', textAlign: 'left', fontSize: 12, outline: 'none' }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ display: 'inline-flex', width: Math.max(12, marker.sizePx), justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ width: marker.sizePx, height: marker.sizePx, border: '1px solid #555', borderRadius: marker.shape === 'dot' ? '50%' : 2 }} />
        </span>
        Без статуса
      </button>
      {taskStatuses.map((status) => (
        <button
          key={status.id}
          type="button"
          onClick={() => { void apply([{ type: 'update_task', taskId: statusMenu.taskId, statusId: status.id }]); setStatusMenu(null); }}
          style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6, padding: '5px 6px', color: '#ccc', background: 'transparent', border: 0, borderRadius: 5, cursor: 'pointer', textAlign: 'left', outline: 'none' }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ display: 'inline-flex', width: Math.max(12, marker.sizePx), alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><StatusMarker status={status} size={marker.sizePx} shape={marker.shape} /></span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12 }}>{status.label}</span>
            {status.description && <span style={{ display: 'block', marginTop: 2, color: '#777', fontSize: 10, lineHeight: 1.35 }}>{status.description}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  const displayedWidth = manualWidth ?? autoWidth;

  return (
    <section
      ref={panelRef}
      data-tab-task-plan
      data-tab-id={tabId}
      data-expanded={expanded ? 'true' : 'false'}
      style={{
        position: 'absolute',
        top: 1,
        left: 1,
        zIndex: 120,
        width: displayedWidth,
        maxWidth: 'calc(100% - 2px)',
        maxHeight: 'calc(100% - 2px)',
        color: '#ccc',
        background: 'rgba(23,23,25,0.96)',
        border: '1px solid #303036',
        borderRadius: 7,
        boxShadow: expanded ? '0 12px 30px rgba(0,0,0,0.48)' : '0 5px 16px rgba(0,0,0,0.34)',
        backdropFilter: 'blur(8px)',
        overflow: 'hidden',
        transition: isResizing
          ? 'box-shadow 160ms ease'
          : 'width 180ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease',
      }}
    >
      <div
        data-task-plan-header
        role="button"
        tabIndex={0}
        title={expanded ? 'Свернуть' : 'Раскрыть'}
        onClick={() => setPanelExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setPanelExpanded(!expanded);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          minHeight: 23,
          padding: '1px 3px',
          borderBottom: '1px solid #28282d',
          color: '#a7a7ac',
          cursor: 'pointer',
          outline: 'none',
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); void addRoot(); }}
          title="Новая задача"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 2, color: '#8a8a90', background: 'transparent', border: 0, borderRadius: 3, cursor: 'pointer', outline: 'none', flexShrink: 0 }}
        >
          <Plus size={12} />
        </button>
        <span style={{ flex: 1, minWidth: 0, paddingLeft: 3, fontSize: 11, lineHeight: 1, fontWeight: 600 }}>Задачи</span>
        <span style={{ display: 'inline-flex', padding: 2, color: '#777', flexShrink: 0 }}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </div>

      <div
        data-task-plan-details={expanded ? '' : undefined}
        style={{
          maxHeight: expanded ? 'min(430px, calc(100vh - 150px))' : 'min(260px, calc(100vh - 150px))',
          overflowY: 'auto',
          padding: plan.items.length > 0 ? '2px 3px 3px' : 0,
          transition: 'max-height 200ms cubic-bezier(0.2, 0.8, 0.2, 1), padding 160ms ease',
        }}
      >
        {plan.items.map((task) => {
          const status = task.statusId ? statusById.get(task.statusId) : undefined;
          return (
            <div key={task.id} style={{ marginBottom: expanded ? 3 : 1 }}>
              <div
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                  setStatusMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
                }}
                style={{ display: 'flex', alignItems: 'center', minHeight: 24, gap: 4, padding: '0 1px', borderRadius: 5 }}
              >
                <span style={{ width: marker.sizePx, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                  {status ? <StatusMarker status={status} size={marker.sizePx} shape={marker.shape} /> : <span style={{ width: marker.sizePx, height: marker.sizePx }} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {expanded ? (
                    <PlanTitleField
                      value={task.title}
                      projectPath={projectPath}
                      autoFocus={autoEditId === task.id}
                      onAutoFocusConsumed={() => setAutoEditId(null)}
                      onCommit={(title) => void apply([{ type: 'update_task', taskId: task.id, title }])}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPanelExpanded(true)}
                      title={task.title}
                      style={{ display: '-webkit-box', width: '100%', minWidth: 0, padding: '3px 5px', textAlign: 'left', color: '#c8c8cc', background: 'transparent', border: 0, borderRadius: 5, cursor: 'pointer', overflow: 'hidden', whiteSpace: 'normal', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, fontSize: 12, lineHeight: 1.3, overflowWrap: 'anywhere', outline: 'none' }}
                    >
                      {renderTitle(task.title)}
                    </button>
                  )}
                </div>
                <div style={{ display: 'inline-flex', width: 38, opacity: expanded ? 1 : 0, pointerEvents: expanded ? 'auto' : 'none', overflow: 'hidden', flexShrink: 0, transition: 'opacity 120ms ease' }}>
                  <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => void addSubtask(task)} title="Добавить подзадачу" style={{ display: 'inline-flex', padding: 3, color: '#777', background: 'transparent', border: 0, borderRadius: 3, cursor: 'pointer', outline: 'none' }}><Plus size={12} /></button>
                  <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => void apply([{ type: 'remove_task', taskId: task.id }])} title="Удалить задачу" style={{ display: 'inline-flex', padding: 3, color: '#5f5f64', background: 'transparent', border: 0, borderRadius: 3, cursor: 'pointer', outline: 'none' }}><Trash2 size={11} /></button>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateRows: expanded && task.subtasks.length > 0 ? '1fr' : '0fr',
                  opacity: expanded ? 1 : 0,
                  transform: expanded ? 'translateY(0)' : 'translateY(-3px)',
                  transition: 'grid-template-rows 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 130ms ease, transform 180ms ease',
                  pointerEvents: expanded ? 'auto' : 'none',
                }}
              >
                <div style={{ minHeight: 0, overflow: 'hidden' }}>
                  {task.subtasks.map((subtask, index) => (
                    <div key={subtask.id} style={{ display: 'flex', alignItems: 'center', minHeight: 23, gap: 4, marginLeft: marker.sizePx + 6 }}>
                      <CornerDownRight size={11} color={index === task.subtasks.length - 1 ? '#4f4f55' : '#3f3f44'} style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <PlanTitleField
                          value={subtask.title}
                          projectPath={projectPath}
                          autoFocus={autoEditId === subtask.id}
                          onAutoFocusConsumed={() => setAutoEditId(null)}
                          onCommit={(title) => void apply([{ type: 'update_subtask', taskId: task.id, subtaskId: subtask.id, title }])}
                        />
                      </div>
                      <button type="button" onClick={() => void apply([{ type: 'remove_subtask', taskId: task.id, subtaskId: subtask.id }])} title="Удалить подзадачу" style={{ display: 'inline-flex', padding: 3, color: '#55555a', background: 'transparent', border: 0, borderRadius: 3, cursor: 'pointer', outline: 'none' }}><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

      </div>

      <div style={{ display: 'grid', gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0, transition: 'grid-template-rows 170ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 110ms ease' }}>
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <div data-task-plan-footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: 22, padding: '1px 3px', borderTop: '1px solid #28282d' }}>
            <button type="button" disabled={plan.history.past.length === 0} onClick={() => void undo(tabId)} title="Назад" style={{ display: 'inline-flex', padding: 2, color: plan.history.past.length ? '#aaa' : '#444', background: 'transparent', border: 0, borderRadius: 3, cursor: plan.history.past.length ? 'pointer' : 'default', outline: 'none' }}><Undo2 size={12} /></button>
            <button type="button" disabled={plan.history.future.length === 0} onClick={() => void redo(tabId)} title="Вперёд" style={{ display: 'inline-flex', padding: 2, color: plan.history.future.length ? '#aaa' : '#444', background: 'transparent', border: 0, borderRadius: 3, cursor: plan.history.future.length ? 'pointer' : 'default', outline: 'none' }}><Redo2 size={12} /></button>
          </div>
        </div>
      </div>

      <div ref={titleMeasureRef} aria-hidden style={{ position: 'absolute', left: -10000, top: 0, visibility: 'hidden', pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', whiteSpace: 'nowrap', fontSize: 12 }}>
        {plan.items.map((task) => <span key={task.id} style={{ padding: '3px 5px' }}>{task.title}</span>)}
      </div>

      <div
        data-task-plan-resize-handle
        onPointerDown={beginResize}
        title="Изменить ширину"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, zIndex: 3, cursor: 'ew-resize', touchAction: 'none' }}
        onPointerEnter={(event) => { const line = event.currentTarget.firstElementChild as HTMLElement | null; if (line) line.style.opacity = '1'; }}
        onPointerLeave={(event) => { if (isResizing) return; const line = event.currentTarget.firstElementChild as HTMLElement | null; if (line) line.style.opacity = '0'; }}
      >
        <span style={{ position: 'absolute', top: 5, right: 0, bottom: 5, width: 1, borderRadius: 1, background: '#8b5cf6', opacity: isResizing ? 1 : 0, transition: 'opacity 120ms ease' }} />
      </div>
      {statusMenuNode}
    </section>
  );
}
