import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare,
  CornerDownRight,
  ListChecks,
  ListPlus,
  PanelRightDashed,
  Plus,
  Redo2,
  Square,
  TextCursorInput,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  useWorkspaceStore,
  type CommandType,
  type TabTaskPlanDocument,
  type TabTaskPlanItem,
  type TabTaskPlanOperation,
} from '../../store/useWorkspaceStore';
import { useUIStore, type SessionStatusDef } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import {
  consumeTaskPlanNavigation,
  subscribeTaskPlanNavigation,
  type TaskPlanNavigationTarget,
} from '../../utils/taskPlanNavigation';
import {
  appendTaskPlanTransfer,
  buildTaskPlanSelectionExtraction,
  collectTaskTreeIds,
  formatTaskPlanTransfer,
  taskPlanStateFingerprint,
} from '../../utils/taskPlanSelectionModel.mjs';

const { ipcRenderer } = window.require('electron');
const path = window.require('path');

const EMPTY_PLAN: TabTaskPlanDocument = {
  version: 1,
  revision: 0,
  items: [],
  archivedItems: [],
  history: { past: [], future: [] },
  updatedAt: null,
  updatedBy: null,
};

type TmpFile = { name: string; path: string; isDirectory?: boolean };

const TASK_PLAN_COLLAPSED_WIDTH_STORAGE_KEY = 'noted-terminal-task-plan-collapsed-widths';

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

function loadCollapsedWidth(tabId: string): number | null {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_PLAN_COLLAPSED_WIDTH_STORAGE_KEY) || '{}');
    const width = Number(value?.[tabId]);
    return Number.isFinite(width) && width >= 96 ? width : null;
  } catch {
    return null;
  }
}

function saveCollapsedWidth(tabId: string, width: number) {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_PLAN_COLLAPSED_WIDTH_STORAGE_KEY) || '{}');
    const next = {
      ...(value && typeof value === 'object' ? value : {}),
      [tabId]: Math.round(width),
    };
    const entries = Object.entries(next);
    const capped = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : next;
    localStorage.setItem(TASK_PLAN_COLLAPSED_WIDTH_STORAGE_KEY, JSON.stringify(capped));
  } catch {}
}

const TASK_PLAN_LAYOUT_STORAGE_KEY = 'noted-terminal-task-plan-layout';
const TASK_PLAN_LEGACY_WIDTH_STORAGE_KEY = 'noted-terminal-task-plan-widths';
const TASK_PLAN_MIN_WIDTH = 156;
const TASK_PLAN_CONTENT_MAX_WIDTH = 420;
const TASK_PLAN_RESERVE_MAX_WIDTH = 640;
const TASK_PLAN_DEFAULT_RESERVE_WIDTH = 380;
const TASK_PLAN_NAVIGATION_FLASH_MS = 360;
const TASK_PLAN_SELECTION_EXTRA_WIDTH = 21;

type TaskPlanInputSurface = 'history' | 'sdk' | 'terminal';
type TaskPlanInputTarget = 'history' | 'sdk' | 'claude' | 'codex';

type InputTransferTransaction = {
  beforePlan: string;
  afterPlan: string;
  beforeInput: string;
  afterInput: string;
  inputTarget: TaskPlanInputTarget;
  undone: boolean;
};

const inputTransferTransactions = new Map<string, InputTransferTransaction[]>();

function getInputTransactions(tabId: string): InputTransferTransaction[] {
  const current = inputTransferTransactions.get(tabId);
  if (current) return current;
  const created: InputTransferTransaction[] = [];
  inputTransferTransactions.set(tabId, created);
  return created;
}

function resolveTaskPlanInputTarget(
  surface: TaskPlanInputSurface,
  commandType: CommandType | null,
): TaskPlanInputTarget | null {
  if (surface === 'history' || surface === 'sdk') return surface;
  return commandType === 'claude' || commandType === 'codex' ? commandType : null;
}

function getSdkComposerTextarea(tabId: string): HTMLTextAreaElement | null {
  const root = document.querySelector<HTMLElement>(
    `[data-claude-sdk-tab-id="${CSS.escape(tabId)}"]`,
  );
  return root?.querySelector('textarea') || null;
}

async function readTaskPlanInput(tabId: string, target: TaskPlanInputTarget): Promise<string> {
  if (target === 'history') {
    return useUIStore.getState().historyPromptDrafts[tabId] || '';
  }
  if (target === 'sdk') {
    const textarea = getSdkComposerTextarea(tabId);
    if (!textarea) throw new Error('sdk_input_not_available');
    return textarea.value;
  }
  const result = await ipcRenderer.invoke(`${target}:copy-input`, tabId);
  if (result?.success !== true || typeof result.text !== 'string') {
    throw new Error(result?.error || `${target}_input_not_available`);
  }
  return result.text;
}

async function replaceTaskPlanInput(
  tabId: string,
  target: TaskPlanInputTarget,
  expectedText: string,
  text: string,
  focus: boolean,
): Promise<{ replaced: boolean; actualText?: string }> {
  if (target === 'history') {
    const state = useUIStore.getState();
    const actualText = state.historyPromptDrafts[tabId] || '';
    if (actualText !== expectedText) return { replaced: false, actualText };
    state.setHistoryPromptDraft(tabId, text, {
      preserveImages: true,
      preserveChips: true,
    });
    if (focus) {
      requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          `textarea[data-history-composer-tab-id="${CSS.escape(tabId)}"]`,
        );
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    }
    return { replaced: true };
  }
  if (target === 'sdk') {
    const textarea = getSdkComposerTextarea(tabId);
    if (!textarea) throw new Error('sdk_input_not_available');
    if (textarea.value !== expectedText) {
      return { replaced: false, actualText: textarea.value };
    }
    window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', {
      detail: { tabId, text, replace: true, skipChip: true },
    }));
    const updated = getSdkComposerTextarea(tabId);
    if (!updated || updated.value !== text) throw new Error('sdk_input_replace_failed');
    if (focus) {
      updated.focus();
      updated.setSelectionRange(updated.value.length, updated.value.length);
    }
    return { replaced: true };
  }
  const result = await ipcRenderer.invoke(`${target}:replace-input-if-unchanged`, {
    tabId,
    expectedText,
    text,
  });
  if (result?.success !== true) throw new Error(result?.error || `${target}_input_replace_failed`);
  if (result?.replaced !== true) {
    return {
      replaced: false,
      ...(typeof result?.actualText === 'string' ? { actualText: result.actualText } : {}),
    };
  }
  if (focus) {
    terminalRegistry.get(tabId)?.focus();
  }
  return { replaced: true };
}

function isTextEditingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || target.isContentEditable;
}

type TaskPlanLayout = {
  reserveWidth: number;
  resizeEnabled: boolean;
};

function clampReserveWidth(width: number): number {
  return Math.max(TASK_PLAN_MIN_WIDTH, Math.min(TASK_PLAN_RESERVE_MAX_WIDTH, width));
}

function clampContentWidth(width: number): number {
  return Math.max(TASK_PLAN_MIN_WIDTH, Math.min(TASK_PLAN_CONTENT_MAX_WIDTH, width));
}

function loadPanelLayout(tabId: string): TaskPlanLayout {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_PLAN_LAYOUT_STORAGE_KEY) || 'null');
    const width = Number(value?.reserveWidth);
    if (Number.isFinite(width)) {
      return { reserveWidth: clampReserveWidth(width), resizeEnabled: value?.resizeEnabled === true };
    }
  } catch {
    // Fall through to the previous per-tab width format.
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(TASK_PLAN_LEGACY_WIDTH_STORAGE_KEY) || '{}');
    const legacyValues = legacy && typeof legacy === 'object' ? Object.values(legacy) : [];
    const fallbackValue = legacyValues.length > 0 ? legacyValues[legacyValues.length - 1] : null;
    const rawWidth = legacy?.[tabId] ?? fallbackValue;
    const width = rawWidth === null || rawWidth === undefined ? Number.NaN : Number(rawWidth);
    if (Number.isFinite(width)) return { reserveWidth: clampReserveWidth(width), resizeEnabled: false };
  } catch {
    // Use the deterministic default below.
  }

  return { reserveWidth: TASK_PLAN_DEFAULT_RESERVE_WIDTH, resizeEnabled: false };
}

function savePanelLayout(layout: TaskPlanLayout) {
  try {
    localStorage.setItem(TASK_PLAN_LAYOUT_STORAGE_KEY, JSON.stringify({
      reserveWidth: Math.round(clampReserveWidth(layout.reserveWidth)),
      resizeEnabled: layout.resizeEnabled,
    }));
  } catch {}
}

function renderTitle(title: string, preserveTextMetrics = false) {
  const parts = title.split(/(`[^`\n]+`|(?<!\*)\*[^*\n]+\*(?!\*)|@[^@\n]*?\.md)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <span
          key={`${part}-${index}`}
          style={{ color: '#73d29a', background: 'rgba(64,192,116,0.1)', borderRadius: 3 }}
        >
          {part}
        </span>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**') && !part.endsWith('**')) {
      return <span key={`${part}-${index}`} style={{ color: '#69dbdb', fontStyle: 'italic' }}>{part}</span>;
    }
    if (part.startsWith('@') && part.endsWith('.md')) {
      if (preserveTextMetrics) {
        return <span key={`${part}-${index}`} style={{ color: '#c4b5fd', background: 'rgba(139,92,246,0.12)', borderRadius: 3 }}>{part}</span>;
      }
      return (
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
      );
    }
    return <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
  });
}

function PlanTitleField({
  fieldId,
  value,
  projectPath,
  autoFocus,
  onCommit,
  onDraftChange,
  onAutoFocusConsumed,
}: {
  fieldId: string;
  value: string;
  projectPath: string;
  autoFocus: boolean;
  onCommit: (title: string) => Promise<unknown> | unknown;
  onDraftChange: (fieldId: string, draft: string | null) => void;
  onAutoFocusConsumed: () => void;
}) {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(value);
  const [pendingCommit, setPendingCommit] = useState<string | null>(null);
  const [files, setFiles] = useState<TmpFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cancelBlurCommitRef = useRef(false);
  const pendingBaseValueRef = useRef<string | null>(null);
  const commitSequenceRef = useRef(0);

  useEffect(() => {
    if (editing) return;
    if (pendingCommit !== null) {
      if (value === pendingCommit || (pendingBaseValueRef.current !== null && value !== pendingBaseValueRef.current)) {
        pendingBaseValueRef.current = null;
        setPendingCommit(null);
        setDraft(value);
      }
      return;
    }
    setDraft(value);
  }, [editing, pendingCommit, value]);

  useEffect(() => {
    if (!autoFocus) return;
    setEditing(true);
    setDraft(value);
    onAutoFocusConsumed();
  }, [autoFocus, onAutoFocusConsumed, value]);

  useLayoutEffect(() => {
    if (!editing) return;
    const editor = inputRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [editing]);

  useLayoutEffect(() => {
    onDraftChange(fieldId, editing || pendingCommit !== null ? draft : null);
  }, [draft, editing, fieldId, onDraftChange, pendingCommit]);

  useEffect(() => () => onDraftChange(fieldId, null), [fieldId, onDraftChange]);

  useLayoutEffect(() => {
    if (!editing || !inputRef.current) return;
    const editor = inputRef.current;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
    editor.style.overflowY = 'hidden';
  });

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
    const displayedValue = pendingCommit ?? value;
    cancelBlurCommitRef.current = !commit;
    setEditing(false);
    setPickerDismissed(false);
    setAnchorRect(null);
    if (commit && title && title !== displayedValue) {
      const sequence = commitSequenceRef.current + 1;
      commitSequenceRef.current = sequence;
      pendingBaseValueRef.current = value;
      setPendingCommit(title);
      setDraft(title);
      Promise.resolve(onCommit(title)).then((result) => {
        if (result || commitSequenceRef.current !== sequence) return;
        pendingBaseValueRef.current = null;
        setPendingCommit(null);
        setDraft(value);
      }).catch(() => {
        if (commitSequenceRef.current !== sequence) return;
        pendingBaseValueRef.current = null;
        setPendingCommit(null);
        setDraft(value);
      });
    } else {
      setDraft(displayedValue);
    }
  }, [draft, onCommit, pendingCommit, value]);

  const wrapSelectedText = useCallback((marker: '`' | '*') => {
    const editor = inputRef.current;
    if (!editor || editor.selectionStart === editor.selectionEnd) return false;
    const from = editor.selectionStart;
    const to = editor.selectionEnd;
    const selectedText = draft.slice(from, to);
    const nextDraft = `${draft.slice(0, from)}${marker}${selectedText}${marker}${draft.slice(to)}`;
    setDraft(nextDraft);
    setPickerDismissed(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(from + marker.length, to + marker.length);
    });
    return true;
  }, [draft]);

  if (!editing) {
    const displayedValue = pendingCommit ?? value;
    return (
      <button
        type="button"
        onClick={() => {
          cancelBlurCommitRef.current = false;
          setDraft(displayedValue);
          setEditing(true);
          setPickerDismissed(false);
        }}
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
        {renderTitle(displayedValue)}
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
      <div
        style={{
          position: 'relative', width: '100%', minWidth: 0, boxSizing: 'border-box',
          color: '#eee', background: '#17171a', border: '1px solid rgba(139,92,246,0.55)',
          borderRadius: 5, overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, zIndex: 0, padding: '3px 5px', boxSizing: 'border-box',
            color: '#eee', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.3,
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', pointerEvents: 'none',
          }}
        >
          {renderTitle(draft || ' ', true)}
        </div>
        <textarea
          ref={inputRef}
          className="task-plan-title-editor"
          spellCheck={false}
          rows={1}
          wrap="soft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value.replace(/[\r\n]+/g, ' '));
            setPickerDismissed(false);
          }}
          onBlur={() => {
            if (cancelBlurCommitRef.current) {
              cancelBlurCommitRef.current = false;
              return;
            }
            finish(true);
          }}
          onKeyDown={(event) => {
            const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
            const wantsBackticks = plainKey && !event.shiftKey && event.code === 'Backquote';
            const wantsSingleStars = plainKey && (event.key === '*' || (event.shiftKey && event.code === 'Digit8'));
            if ((wantsBackticks && wrapSelectedText('`')) || (wantsSingleStars && wrapSelectedText('*'))) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
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
            position: 'relative', zIndex: 1, display: 'block', width: '100%', minWidth: 0,
            boxSizing: 'border-box', resize: 'none', padding: '3px 5px', color: 'transparent',
            WebkitTextFillColor: 'transparent', caretColor: '#f1f1f1', background: 'transparent',
            border: 0, borderRadius: 4, outline: 'none', fontFamily: 'inherit', fontSize: 12,
            lineHeight: 1.3, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden',
          }}
        />
      </div>
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

type TaskMenuState = {
  x: number;
  y: number;
} & (
  | { kind: 'task'; taskId: string; archived: boolean; subtaskCount: number }
  | { kind: 'subtask'; taskId: string; subtaskId: string }
  | { kind: 'selection' }
);

export default function TabTaskPlanPanel({
  tabId,
  projectPath,
  inputSurface,
  commandType,
}: {
  tabId: string;
  projectPath: string;
  inputSurface: TaskPlanInputSurface;
  commandType: CommandType | null;
}) {
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
  const showToast = useUIStore((state) => state.showToast);
  const [expandedState, setExpandedState] = useState(() => ({ tabId, expanded: loadExpanded(tabId) }));
  const expanded = expandedState.tabId === tabId ? expandedState.expanded : loadExpanded(tabId);
  const [animatedTabId, setAnimatedTabId] = useState<string | null>(null);
  const animateExpansion = animatedTabId === tabId;
  const [animatedArchiveTabId, setAnimatedArchiveTabId] = useState<string | null>(null);
  const animateArchive = animatedArchiveTabId === tabId;
  const [animatedWidthTabId, setAnimatedWidthTabId] = useState<string | null>(null);
  const animateWidth = animatedWidthTabId === tabId;
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [statusMenu, setStatusMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [taskMenu, setTaskMenu] = useState<TaskMenuState | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [flashTaskId, setFlashTaskId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionControlsVisible, setSelectionControlsVisible] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [hoveredSelectionId, setHoveredSelectionId] = useState<string | null>(null);
  const [panelFocused, setPanelFocused] = useState(false);
  const [autoWidth, setAutoWidth] = useState(TASK_PLAN_MIN_WIDTH);
  const [collapsedWidth, setCollapsedWidth] = useState<number | null>(() => loadCollapsedWidth(tabId));
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({});
  const [panelLayout, setPanelLayout] = useState<TaskPlanLayout>(() => loadPanelLayout(tabId));
  const [availableWidth, setAvailableWidth] = useState(TASK_PLAN_RESERVE_MAX_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHovered, setResizeHovered] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const titleMeasureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAnimatedTabId(null);
    setAutoEditId(null);
    setStatusMenu(null);
    setTaskMenu(null);
    setShowArchive(false);
    setFlashTaskId(null);
    setSelectionMode(false);
    setSelectionControlsVisible(false);
    setSelectedIds(new Set());
    setHoveredSelectionId(null);
    setPanelFocused(false);
    setAnimatedArchiveTabId(null);
    setAnimatedWidthTabId(null);
    setDraftTitles({});
  }, [tabId]);

  useLayoutEffect(() => {
    setAutoWidth(TASK_PLAN_MIN_WIDTH);
    setCollapsedWidth(loadCollapsedWidth(tabId));
  }, [tabId]);

  useLayoutEffect(() => {
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailableWidth(Math.max(96, parent.clientWidth - 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const setPanelExpanded = useCallback((next: boolean, animate = true) => {
    setAnimatedTabId(animate && next !== expanded ? tabId : null);
    setExpandedState({ tabId, expanded: next });
    saveExpanded(tabId, next);
  }, [expanded, tabId]);

  const finishExpansionAnimation = useCallback(() => {
    setAnimatedTabId((current) => current === tabId ? null : current);
  }, [tabId]);

  const handleDraftChange = useCallback((fieldId: string, draft: string | null) => {
    setDraftTitles((current) => {
      if (draft === null) {
        if (!(fieldId in current)) return current;
        const next = { ...current };
        delete next[fieldId];
        return next;
      }
      if (current[fieldId] === draft) return current;
      return { ...current, [fieldId]: draft };
    });
  }, []);

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

  useEffect(() => {
    if (!taskMenu) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setTaskMenu(null);
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
    };
  }, [taskMenu]);

  useEffect(() => {
    const clearPanelFocus = (event?: Event) => {
      if (event?.target instanceof Node && panelRef.current?.contains(event.target)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
      setPanelFocused(false);
    };
    window.addEventListener('mousedown', clearPanelFocus);
    window.addEventListener('blur', clearPanelFocus);
    return () => {
      window.removeEventListener('mousedown', clearPanelFocus);
      window.removeEventListener('blur', clearPanelFocus);
    };
  }, []);

  const archivedItems = plan.archivedItems || EMPTY_PLAN.archivedItems;
  const visibleItems = useMemo(
    () => showArchive ? [...archivedItems, ...plan.items] : plan.items,
    [archivedItems, plan.items, showArchive],
  );

  useEffect(() => {
    if (!showArchive || archivedItems.length > 0) return;
    setAnimatedArchiveTabId(tabId);
    setAnimatedWidthTabId(tabId);
    setShowArchive(false);
  }, [archivedItems.length, showArchive, tabId]);

  useEffect(() => {
    const available = new Set(
      plan.items.flatMap((task) => [task.id, ...task.subtasks.map((subtask) => subtask.id)]),
    );
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [plan.items]);

  const navigateToTask = useCallback((target: TaskPlanNavigationTarget) => {
    if (target.tabId !== tabId) return;
    if (target.view === 'archive') setShowArchive(true);
    setPanelExpanded(true);
    setFlashTaskId(null);
    if (target.taskId) {
      requestAnimationFrame(() => setFlashTaskId(target.taskId || null));
    }
  }, [setPanelExpanded, tabId]);

  useEffect(() => {
    const unsubscribe = subscribeTaskPlanNavigation(tabId, navigateToTask);
    const pending = consumeTaskPlanNavigation(tabId);
    if (pending) navigateToTask(pending);
    return unsubscribe;
  }, [navigateToTask, tabId]);

  useLayoutEffect(() => {
    if (!flashTaskId) return;
    const task = panelRef.current?.querySelector<HTMLElement>(`[data-task-plan-task-id="${CSS.escape(flashTaskId)}"]`);
    task?.scrollIntoView({ block: 'nearest' });
  }, [flashTaskId, showArchive, visibleItems]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const children = Array.from(titleMeasureRef.current?.children || []) as HTMLElement[];
    const widestTitle = children.reduce((width, child) => {
      const extra = Number(child.dataset.widthExtra || 0);
      return Math.max(width, child.offsetWidth + extra);
    }, 0);
    setAutoWidth(clampContentWidth(Math.ceil(widestTitle || TASK_PLAN_MIN_WIDTH)));
  }, [draftTitles, expanded, marker.sizePx, plan.items, showArchive, visibleItems]);

  const statusById = useMemo(() => new Map(taskStatuses.map((status) => [status.id, status])), [taskStatuses]);

  const apply = useCallback(async (operations: TabTaskPlanOperation[]) => {
    return applyOperations(tabId, operations);
  }, [applyOperations, tabId]);

  const addRoot = useCallback(async () => {
    setShowArchive(false);
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

  const inputTarget = useMemo(
    () => resolveTaskPlanInputTarget(inputSurface, commandType),
    [commandType, inputSurface],
  );

  const selectedNodeCount = selectedIds.size;

  const enterSelectionMode = useCallback((ids?: Set<string>) => {
    setAnimatedWidthTabId(tabId);
    setSelectionControlsVisible(false);
    setSelectionMode(true);
    setSelectedIds(ids ? new Set(ids) : new Set());
    setHoveredSelectionId(null);
    setPanelExpanded(true);
    setTaskMenu(null);
    setStatusMenu(null);
  }, [setPanelExpanded, tabId]);

  const clearSelectionMode = useCallback(() => {
    setSelectionControlsVisible(false);
    setAnimatedWidthTabId(tabId);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setHoveredSelectionId(null);
  }, [tabId]);

  const toggleSelectionMode = useCallback(() => {
    if (selectionMode) clearSelectionMode();
    else enterSelectionMode();
  }, [clearSelectionMode, enterSelectionMode, selectionMode]);

  const togglePanelExpanded = useCallback(() => {
    const next = !expanded;
    if (!next) {
      const width = Math.min(
        availableWidth,
        panelRef.current?.getBoundingClientRect().width || TASK_PLAN_MIN_WIDTH,
      );
      setCollapsedWidth(width);
      saveCollapsedWidth(tabId, width);
      if (selectionMode) clearSelectionMode();
    }
    setPanelExpanded(next);
  }, [
    availableWidth,
    clearSelectionMode,
    expanded,
    selectionMode,
    setPanelExpanded,
    tabId,
  ]);

  const toggleArchive = useCallback(() => {
    if (archivedItems.length === 0) return;
    setAnimatedArchiveTabId(tabId);
    setAnimatedWidthTabId(tabId);
    setPanelExpanded(true);
    setShowArchive((current) => !current);
    setTaskMenu(null);
    setStatusMenu(null);
  }, [archivedItems.length, setPanelExpanded, tabId]);

  const toggleTaskSelection = useCallback((task: TabTaskPlanItem) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const ids = collectTaskTreeIds(task);
      if (next.has(task.id)) ids.forEach((id: string) => next.delete(id));
      else ids.forEach((id: string) => next.add(id));
      return next;
    });
  }, []);

  const toggleSubtaskSelection = useCallback((subtaskId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(subtaskId)) next.delete(subtaskId);
      else next.add(subtaskId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectionMode) return;
    const closeSelectionOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (taskMenuRef.current?.contains(target) || statusMenuRef.current?.contains(target)) return;
      clearSelectionMode();
    };
    const closeSelectionOnWindowBlur = () => clearSelectionMode();
    window.addEventListener('mousedown', closeSelectionOutside, true);
    window.addEventListener('blur', closeSelectionOnWindowBlur);
    return () => {
      window.removeEventListener('mousedown', closeSelectionOutside, true);
      window.removeEventListener('blur', closeSelectionOnWindowBlur);
    };
  }, [clearSelectionMode, selectionMode]);

  const transferIdsToInput = useCallback(async (ids: Set<string>) => {
    const extraction = buildTaskPlanSelectionExtraction(plan.items, ids);
    if (!extraction.movedNodeCount || extraction.transferItems.length === 0) return;
    if (!inputTarget) {
      showToast('Для этой вкладки нет точного чтения input — задачи оставлены в плане', 'warning', 3500);
      return;
    }

    const insertion = formatTaskPlanTransfer(extraction.transferItems);
    if (!insertion) return;

    let beforeInput: string;
    try {
      beforeInput = await readTaskPlanInput(tabId, inputTarget);
    } catch (error: any) {
      showToast(`Не удалось прочитать input: ${error?.message || String(error)}`, 'error', 3500);
      return;
    }
    const afterInput = appendTaskPlanTransfer(beforeInput, insertion);

    try {
      const replacement = await replaceTaskPlanInput(
        tabId,
        inputTarget,
        beforeInput,
        afterInput,
        true,
      );
      if (!replacement.replaced) {
        showToast('Input изменился во время переноса — новый текст оставлен без изменений', 'warning', 3500);
        return;
      }
    } catch (error: any) {
      showToast(`Не удалось изменить input: ${error?.message || String(error)}`, 'error', 3500);
      return;
    }

    const beforePlan = taskPlanStateFingerprint(plan.items, archivedItems);
    const resultDocument = await apply([{ type: 'replace_plan', tasks: extraction.nextItems }]);
    if (!resultDocument) {
      let rolledBack = false;
      try {
        rolledBack = (await replaceTaskPlanInput(
          tabId,
          inputTarget,
          afterInput,
          beforeInput,
          false,
        )).replaced;
      } catch {}
      showToast(
        rolledBack
          ? 'План не изменился; input возвращён в исходное состояние'
          : 'План не изменился; более новый текст в input оставлен без изменений',
        'error',
        3500,
      );
      return;
    }

    const transactions = getInputTransactions(tabId);
    transactions.push({
      beforePlan,
      afterPlan: taskPlanStateFingerprint(resultDocument.items, resultDocument.archivedItems),
      beforeInput,
      afterInput,
      inputTarget,
      undone: false,
    });
    if (transactions.length > 60) transactions.splice(0, transactions.length - 60);

    setTaskMenu(null);
    clearSelectionMode();
  }, [apply, archivedItems, clearSelectionMode, inputTarget, plan.items, showToast, tabId]);

  const deleteIdsFromPlan = useCallback(async (ids: Set<string>) => {
    const extraction = buildTaskPlanSelectionExtraction(plan.items, ids);
    if (!extraction.movedNodeCount) return;
    const result = await apply([{ type: 'replace_plan', tasks: extraction.nextItems }]);
    if (result) {
      setTaskMenu(null);
      clearSelectionMode();
    }
  }, [apply, clearSelectionMode, plan.items]);

  const findUndoInputTransaction = useCallback((): InputTransferTransaction | null => {
    if (plan.history.past.length === 0) return null;
    const previous = plan.history.past[plan.history.past.length - 1];
    const currentFingerprint = taskPlanStateFingerprint(plan.items, archivedItems);
    const previousFingerprint = taskPlanStateFingerprint(previous.items, previous.archivedItems || []);
    const transactions = getInputTransactions(tabId);
    for (let index = transactions.length - 1; index >= 0; index -= 1) {
      const transaction = transactions[index];
      if (
        !transaction.undone
        && transaction.afterPlan === currentFingerprint
        && transaction.beforePlan === previousFingerprint
      ) return transaction;
    }
    return null;
  }, [archivedItems, plan.history.past, plan.items, tabId]);

  const findRedoInputTransaction = useCallback((): InputTransferTransaction | null => {
    if (plan.history.future.length === 0) return null;
    const next = plan.history.future[0];
    const currentFingerprint = taskPlanStateFingerprint(plan.items, archivedItems);
    const nextFingerprint = taskPlanStateFingerprint(next.items, next.archivedItems || []);
    const transactions = getInputTransactions(tabId);
    for (let index = transactions.length - 1; index >= 0; index -= 1) {
      const transaction = transactions[index];
      if (
        transaction.undone
        && transaction.beforePlan === currentFingerprint
        && transaction.afterPlan === nextFingerprint
      ) return transaction;
    }
    return null;
  }, [archivedItems, plan.history.future, plan.items, tabId]);

  const runPlanUndo = useCallback(async () => {
    const transaction = findUndoInputTransaction();
    let inputBeforeAction: string | null = null;
    let replacedInput = false;
    let inputChangedDuringAction = false;
    if (transaction) {
      try {
        inputBeforeAction = await readTaskPlanInput(tabId, transaction.inputTarget);
        if (inputBeforeAction === transaction.afterInput) {
          const replacement = await replaceTaskPlanInput(
            tabId,
            transaction.inputTarget,
            transaction.afterInput,
            transaction.beforeInput,
            false,
          );
          replacedInput = replacement.replaced;
          inputChangedDuringAction = !replacement.replaced;
        }
      } catch (error: any) {
        showToast(`Отмена остановлена: input недоступен (${error?.message || String(error)})`, 'error', 3500);
        return;
      }
    }

    const result = await undo(tabId);
    if (!result) {
      if (transaction && replacedInput && inputBeforeAction !== null) {
        try {
          await replaceTaskPlanInput(
            tabId,
            transaction.inputTarget,
            transaction.beforeInput,
            inputBeforeAction,
            false,
          );
        } catch {}
      }
      return;
    }
    if (transaction) {
      transaction.undone = true;
      if (
        inputChangedDuringAction
        || (
          inputBeforeAction !== transaction.afterInput
          && inputBeforeAction !== transaction.beforeInput
        )
      ) {
        showToast('План отменён; более новый текст в input оставлен без изменений', 'warning', 3000);
      }
    }
  }, [findUndoInputTransaction, showToast, tabId, undo]);

  const runPlanRedo = useCallback(async () => {
    const transaction = findRedoInputTransaction();
    let inputBeforeAction: string | null = null;
    let replacedInput = false;
    let inputChangedDuringAction = false;
    if (transaction) {
      try {
        inputBeforeAction = await readTaskPlanInput(tabId, transaction.inputTarget);
        if (inputBeforeAction === transaction.beforeInput) {
          const replacement = await replaceTaskPlanInput(
            tabId,
            transaction.inputTarget,
            transaction.beforeInput,
            transaction.afterInput,
            false,
          );
          replacedInput = replacement.replaced;
          inputChangedDuringAction = !replacement.replaced;
        }
      } catch (error: any) {
        showToast(`Повтор остановлен: input недоступен (${error?.message || String(error)})`, 'error', 3500);
        return;
      }
    }

    const result = await redo(tabId);
    if (!result) {
      if (transaction && replacedInput && inputBeforeAction !== null) {
        try {
          await replaceTaskPlanInput(
            tabId,
            transaction.inputTarget,
            transaction.afterInput,
            inputBeforeAction,
            false,
          );
        } catch {}
      }
      return;
    }
    if (transaction) {
      transaction.undone = false;
      if (
        inputChangedDuringAction
        || (
          inputBeforeAction !== transaction.beforeInput
          && inputBeforeAction !== transaction.afterInput
        )
      ) {
        showToast('План повторён; более новый текст в input оставлен без изменений', 'warning', 3000);
      }
    }
  }, [findRedoInputTransaction, redo, showToast, tabId]);

  const focusPlanPanel = useCallback(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!event.metaKey || event.altKey || isTextEditingElement(event.target)) return;
    const key = event.key.toLocaleLowerCase();
    const wantsUndo = key === 'z' && !event.shiftKey;
    const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!wantsUndo && !wantsRedo) return;
    event.preventDefault();
    event.stopPropagation();
    if (wantsUndo) void runPlanUndo();
    else void runPlanRedo();
  }, [runPlanRedo, runPlanUndo]);

  const openTaskMenu = useCallback((
    event: React.MouseEvent,
    task: TabTaskPlanItem,
    archived: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setStatusMenu(null);

    if (selectionMode && !archived) {
      if (!selectedIds.has(task.id)) {
        setSelectedIds(new Set(collectTaskTreeIds(task)));
      }
      setTaskMenu({ kind: 'selection', x: event.clientX, y: event.clientY });
      return;
    }

    setTaskMenu({
      kind: 'task',
      taskId: task.id,
      archived,
      subtaskCount: task.subtasks.length,
      x: event.clientX,
      y: event.clientY,
    });
  }, [selectedIds, selectionMode]);

  const openSubtaskMenu = useCallback((
    event: React.MouseEvent,
    taskId: string,
    subtaskId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setStatusMenu(null);

    if (selectionMode) {
      if (!selectedIds.has(subtaskId)) setSelectedIds(new Set([subtaskId]));
      setTaskMenu({ kind: 'selection', x: event.clientX, y: event.clientY });
      return;
    }

    setTaskMenu({
      kind: 'subtask',
      taskId,
      subtaskId,
      x: event.clientX,
      y: event.clientY,
    });
  }, [selectedIds, selectionMode]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelLayout.resizeEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    const host = hostRef.current;
    if (!host) return;

    const startX = event.clientX;
    const startWidth = Math.min(panelLayout.reserveWidth, host.getBoundingClientRect().width);
    const available = Math.max(96, (host.parentElement?.clientWidth || window.innerWidth) - 2);
    const maxWidth = Math.min(TASK_PLAN_RESERVE_MAX_WIDTH, available);
    let latestWidth = startWidth;
    setIsResizing(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      latestWidth = Math.max(Math.min(TASK_PLAN_MIN_WIDTH, maxWidth), Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
      setPanelLayout((current) => ({ ...current, reserveWidth: latestWidth }));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
      setPanelLayout((current) => {
        const next = { ...current, reserveWidth: latestWidth };
        savePanelLayout(next);
        return next;
      });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [panelLayout.reserveWidth, panelLayout.resizeEnabled]);

  const toggleResize = useCallback(() => {
    setResizeHovered(false);
    setPanelLayout((current) => {
      const next = { ...current, resizeEnabled: !current.resizeEnabled };
      savePanelLayout(next);
      return next;
    });
  }, []);

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
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={() => { void apply([{ type: 'update_task', taskId: statusMenu.taskId, statusId: null }]); setStatusMenu(null); }}
        style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6, padding: '5px 6px', color: '#aaa', background: 'transparent', border: 0, borderRadius: 5, cursor: 'pointer', textAlign: 'left', fontSize: 12, outline: 'none' }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ display: 'inline-flex', width: Math.max(12, marker.sizePx), justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ width: marker.sizePx, height: marker.sizePx, background: '#73737a', border: '1px solid rgba(0,0,0,0.38)', borderRadius: marker.shape === 'dot' ? '50%' : 2, boxSizing: 'border-box' }} />
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

  const taskMenuButton = (
    key: string,
    icon: React.ReactNode,
    label: string,
    action: () => void,
    danger = false,
    disabled = false,
  ) => (
    <button
      key={key}
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        action();
        setTaskMenu(null);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 7,
        padding: '6px 7px',
        color: disabled ? '#4d4d52' : danger ? '#e38c8c' : '#ccc',
        background: 'transparent',
        border: 0,
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        fontSize: 12,
        outline: 'none',
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = danger
          ? 'rgba(239,68,68,0.11)'
          : 'rgba(255,255,255,0.07)';
      }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const taskMenuContent = (() => {
    if (!taskMenu) return null;
    if (taskMenu.kind === 'selection') {
      const selectionSnapshot = new Set(selectedIds);
      return (
        <>
          {taskMenuButton(
            'selection-input',
            <TextCursorInput size={13} />,
            `Переместить в input${selectedNodeCount > 1 ? ` [${selectedNodeCount}]` : ''}`,
            () => void transferIdsToInput(selectionSnapshot),
            false,
            selectedNodeCount === 0,
          )}
          {taskMenuButton(
            'selection-delete',
            <Trash2 size={13} />,
            `Удалить выбранное${selectedNodeCount > 0 ? ` [${selectedNodeCount}]` : ''}`,
            () => void deleteIdsFromPlan(selectionSnapshot),
            true,
            selectedNodeCount === 0,
          )}
        </>
      );
    }

    if (taskMenu.kind === 'subtask') {
      return (
        <>
          {taskMenuButton(
            'subtask-select',
            <CheckSquare size={13} />,
            'Выделить',
            () => enterSelectionMode(new Set([taskMenu.subtaskId])),
          )}
          {taskMenuButton(
            'subtask-input',
            <TextCursorInput size={13} />,
            'Переместить в input',
            () => void transferIdsToInput(new Set([taskMenu.subtaskId])),
          )}
          {taskMenuButton(
            'subtask-delete',
            <Trash2 size={13} />,
            'Удалить подзадачу',
            () => void apply([{
              type: 'remove_subtask',
              taskId: taskMenu.taskId,
              subtaskId: taskMenu.subtaskId,
            }]),
            true,
          )}
        </>
      );
    }

    if (taskMenu.archived) {
      return taskMenuButton(
        'task-restore',
        <ArchiveRestore size={13} />,
        'Вернуть в активное',
        () => void apply([{ type: 'restore_task', taskId: taskMenu.taskId }]),
      );
    }

    const task = plan.items.find((item) => item.id === taskMenu.taskId);
    return (
      <>
        {taskMenuButton(
          'task-select',
          <CheckSquare size={13} />,
          'Выделить',
          () => {
            if (task) enterSelectionMode(new Set(collectTaskTreeIds(task)));
          },
          false,
          !task,
        )}
        {taskMenuButton(
          'task-add-subtask',
          <ListPlus size={13} />,
          'Добавить подзадачу',
          () => {
            if (task) void addSubtask(task);
          },
          false,
          !task,
        )}
        {taskMenuButton(
          'task-input',
          <TextCursorInput size={13} />,
          'Переместить в input',
          () => {
            if (task) void transferIdsToInput(new Set(collectTaskTreeIds(task)));
          },
          false,
          !task,
        )}
        {taskMenuButton(
          'task-complete',
          <Check size={13} color="#73d29a" />,
          'Отметить выполненной',
          () => void apply([{ type: 'archive_task', taskId: taskMenu.taskId }]),
        )}
        {taskMenuButton(
          'task-delete',
          <Trash2 size={13} />,
          `Удалить задачу${taskMenu.subtaskCount > 0 ? ` [${taskMenu.subtaskCount}]` : ''}`,
          () => void apply([{ type: 'remove_task', taskId: taskMenu.taskId }]),
          true,
        )}
      </>
    );
  })();

  const taskMenuNode = taskMenu ? ReactDOM.createPortal(
    <>
      <div
        data-task-plan-action-menu-backdrop
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2147482599,
          background: 'transparent',
          cursor: 'default',
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTaskMenu(null);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTaskMenu(null);
        }}
      />
      <div
        ref={taskMenuRef}
        data-task-plan-action-menu
        style={{
          position: 'fixed',
          left: Math.max(8, Math.min(taskMenu.x, window.innerWidth - 244)),
          top: Math.max(8, Math.min(taskMenu.y, window.innerHeight - 246)),
          width: 236,
          zIndex: 2147482600,
          padding: 3,
          borderRadius: 8,
          background: '#18181b',
          border: '1px solid #3a3a40',
          boxShadow: '0 14px 34px rgba(0,0,0,0.6)',
        }}
        onContextMenu={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
      >
        {taskMenuContent}
      </div>
    </>,
    document.body,
  ) : null;

  const reserveDisplayWidth = Math.min(panelLayout.reserveWidth, availableWidth);
  const contentDisplayedWidth = Math.min(autoWidth, reserveDisplayWidth);
  const selectionLaneWidth = selectionMode ? TASK_PLAN_SELECTION_EXTRA_WIDTH : 0;
  const expandedDisplayWidth = Math.min(
    availableWidth,
    contentDisplayedWidth + selectionLaneWidth,
  );
  const displayedWidth = !expanded && collapsedWidth !== null
    ? Math.min(availableWidth, collapsedWidth)
    : expandedDisplayWidth;
  const hostDisplayWidth = Math.min(
    availableWidth,
    Math.max(reserveDisplayWidth, displayedWidth),
  );
  const reserveGap = Math.max(0, reserveDisplayWidth - displayedWidth);

  const renderTaskCard = (task: TabTaskPlanItem, archived: boolean) => {
    const status = task.statusId ? statusById.get(task.statusId) : undefined;
    const rootSelected = selectedIds.has(task.id);
    const rootHovered = selectionMode && hoveredSelectionId === task.id;
    const isFlashing = flashTaskId === task.id;
    const canSelect = selectionMode && !archived;
    const markerNode = status
      ? <StatusMarker status={status} size={marker.sizePx} shape={marker.shape} />
      : (
        <span
          style={{
            width: marker.sizePx,
            height: marker.sizePx,
            background: '#73737a',
            border: '1px solid rgba(0,0,0,0.38)',
            borderRadius: marker.shape === 'dot' ? '50%' : 2,
            boxSizing: 'border-box',
          }}
        />
      );

    return (
      <div
        key={task.id}
        data-task-plan-task-id={task.id}
        data-task-plan-archived={archived ? 'true' : undefined}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && isFlashing) setFlashTaskId(null);
        }}
        style={{
          marginBottom: expanded ? 3 : 1,
          paddingLeft: archived ? 2 : 0,
          borderRadius: 5,
          background: archived ? 'rgba(139,92,246,0.075)' : 'transparent',
          boxShadow: archived ? 'inset 2px 0 rgba(167,139,250,0.72)' : 'none',
          animation: isFlashing
            ? `noted-task-plan-flash ${TASK_PLAN_NAVIGATION_FLASH_MS}ms ease-out`
            : 'none',
        }}
      >
        <div
          onClick={() => {
            if (canSelect) toggleTaskSelection(task);
          }}
          onContextMenu={(event) => openTaskMenu(event, task, archived)}
          onMouseEnter={() => {
            if (canSelect) setHoveredSelectionId(task.id);
          }}
          onMouseLeave={() => {
            if (canSelect) setHoveredSelectionId((current) => current === task.id ? null : current);
          }}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            minHeight: 24,
            gap: 4,
            padding: '0 1px',
            paddingRight: selectionMode ? 22 : 1,
            boxSizing: 'border-box',
            borderRadius: 5,
            background: canSelect
              ? rootSelected
                ? 'rgba(139,92,246,0.15)'
                : rootHovered
                  ? 'rgba(255,255,255,0.055)'
                  : 'transparent'
              : 'transparent',
            cursor: canSelect ? 'pointer' : 'default',
            transition: [
              animateWidth
                ? 'padding-right 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
                : '',
              canSelect ? 'background 90ms ease' : '',
            ].filter(Boolean).join(', ') || 'none',
          }}
        >
          {archived || canSelect ? (
            <span
              aria-hidden
              style={{
                width: marker.sizePx,
                height: marker.sizePx + 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {markerNode}
            </span>
          ) : (
            <button
              type="button"
              data-task-plan-status-trigger
              title={status ? `Изменить статус: ${status.label}` : 'Выбрать статус'}
              // pointerdown тоже гасится: фокус окон живёт на window-capture
              // pointerdown (TerminalArea), и клик по маркеру не имеет права
              // активировать вкладку. Там же этот data-атрибут в исключениях.
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.button !== 0) event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setTaskMenu(null);
                setStatusMenu({
                  taskId: task.id,
                  x: rect.left - 272,
                  y: rect.top,
                });
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: marker.sizePx,
                height: marker.sizePx + 4,
                padding: 0,
                flexShrink: 0,
                color: 'inherit',
                background: 'transparent',
                border: 0,
                borderRadius: 3,
                cursor: 'pointer',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            >
              {markerNode}
            </button>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            {expanded && !archived && !selectionMode ? (
              <PlanTitleField
                fieldId={task.id}
                value={task.title}
                projectPath={projectPath}
                autoFocus={autoEditId === task.id}
                onDraftChange={handleDraftChange}
                onAutoFocusConsumed={() => setAutoEditId(null)}
                onCommit={(title) => apply([{ type: 'update_task', taskId: task.id, title }])}
              />
            ) : (
              <button
                type="button"
                tabIndex={canSelect ? -1 : 0}
                onClick={(event) => {
                  event.stopPropagation();
                  if (canSelect) toggleTaskSelection(task);
                  else if (!expanded) setPanelExpanded(true);
                }}
                title={task.title}
                style={{
                  display: '-webkit-box',
                  width: '100%',
                  minWidth: 0,
                  padding: '3px 5px',
                  textAlign: 'left',
                  color: archived ? '#aaa4b9' : '#c8c8cc',
                  background: 'transparent',
                  border: 0,
                  borderRadius: 5,
                  cursor: canSelect || !expanded ? 'pointer' : 'default',
                  overflow: 'hidden',
                  whiteSpace: 'normal',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  fontSize: 12,
                  lineHeight: 1.3,
                  overflowWrap: 'anywhere',
                  outline: 'none',
                }}
              >
                {renderTitle(task.title)}
              </button>
            )}
          </div>

          {canSelect && selectionControlsVisible && (
            <button
              type="button"
              aria-label={rootSelected ? 'Снять выбор задачи' : 'Выбрать задачу и подзадачи'}
              onClick={(event) => {
                event.stopPropagation();
                toggleTaskSelection(task);
              }}
              style={{
                position: 'absolute',
                top: '50%',
                right: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 17,
                height: 20,
                padding: 0,
                color: rootSelected ? '#c4b5fd' : '#66666d',
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                outline: 'none',
                transform: 'translateY(-50%)',
                animation: 'noted-task-plan-checkbox-reveal 90ms ease-out',
              }}
            >
              {rootSelected ? <CheckSquare size={13} /> : <Square size={13} />}
            </button>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateRows: expanded && task.subtasks.length > 0 ? '1fr' : '0fr',
            opacity: expanded ? 1 : 0,
            transform: expanded ? 'translateY(0)' : 'translateY(-3px)',
            transition: animateExpansion
              ? 'grid-template-rows 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 130ms ease, transform 180ms ease'
              : 'none',
            pointerEvents: expanded ? 'auto' : 'none',
          }}
        >
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            {task.subtasks.map((subtask, index) => {
              const subtaskSelected = selectedIds.has(subtask.id);
              const subtaskHovered = canSelect && hoveredSelectionId === subtask.id;
              return (
                <div
                  key={subtask.id}
                  data-task-plan-task-id={subtask.id}
                  onClick={(event) => {
                    if (!canSelect) return;
                    event.stopPropagation();
                    toggleSubtaskSelection(subtask.id);
                  }}
                  onContextMenu={(event) => {
                    if (archived) openTaskMenu(event, task, true);
                    else openSubtaskMenu(event, task.id, subtask.id);
                  }}
                  onMouseEnter={() => {
                    if (canSelect) setHoveredSelectionId(subtask.id);
                  }}
                  onMouseLeave={() => {
                    if (canSelect) {
                      setHoveredSelectionId((current) => current === subtask.id ? null : current);
                    }
                  }}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    minHeight: 23,
                    gap: 4,
                    marginLeft: marker.sizePx + 6,
                    paddingRight: selectionMode ? TASK_PLAN_SELECTION_EXTRA_WIDTH : 0,
                    boxSizing: 'border-box',
                    borderRadius: 4,
                    background: canSelect
                      ? subtaskSelected
                        ? 'rgba(139,92,246,0.13)'
                        : subtaskHovered
                          ? 'rgba(255,255,255,0.045)'
                          : 'transparent'
                      : 'transparent',
                    cursor: canSelect ? 'pointer' : 'default',
                    transition: [
                      animateWidth
                        ? 'padding-right 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
                        : '',
                      canSelect ? 'background 90ms ease' : '',
                    ].filter(Boolean).join(', ') || 'none',
                  }}
                >
                  <CornerDownRight
                    size={11}
                    color={archived
                      ? '#6f6489'
                      : index === task.subtasks.length - 1
                        ? '#4f4f55'
                        : '#3f3f44'}
                    style={{ flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {!archived && !selectionMode ? (
                      <PlanTitleField
                        fieldId={subtask.id}
                        value={subtask.title}
                        projectPath={projectPath}
                        autoFocus={autoEditId === subtask.id}
                        onDraftChange={handleDraftChange}
                        onAutoFocusConsumed={() => setAutoEditId(null)}
                        onCommit={(title) => apply([{
                          type: 'update_subtask',
                          taskId: task.id,
                          subtaskId: subtask.id,
                          title,
                        }])}
                      />
                    ) : (
                      <div
                        style={{
                          padding: '3px 5px',
                          color: archived ? '#938ba5' : '#b9b9be',
                          fontSize: 12,
                          lineHeight: 1.3,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {renderTitle(subtask.title)}
                      </div>
                    )}
                  </div>
                  {canSelect && selectionControlsVisible && (
                    <button
                      type="button"
                      aria-label={subtaskSelected ? 'Снять выбор подзадачи' : 'Выбрать подзадачу'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleSubtaskSelection(subtask.id);
                      }}
                      style={{
                        position: 'absolute',
                        top: '50%',
                        right: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 17,
                        height: 20,
                        padding: 0,
                        color: subtaskSelected ? '#c4b5fd' : '#66666d',
                        background: 'transparent',
                        border: 0,
                        cursor: 'pointer',
                        outline: 'none',
                        transform: 'translateY(-50%)',
                        animation: 'noted-task-plan-checkbox-reveal 90ms ease-out',
                      }}
                    >
                      {subtaskSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={hostRef}
      data-tab-task-plan-host
      style={{
        position: 'absolute',
        top: 1,
        left: 1,
        zIndex: 120,
        width: hostDisplayWidth,
        maxWidth: 'calc(100% - 2px)',
        maxHeight: 'calc(100% - 2px)',
        pointerEvents: 'none',
      }}
    >
      {panelLayout.resizeEnabled && reserveGap > 0 && (
        <div
          data-task-plan-width-reserve
          aria-hidden
          style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, left: Math.max(0, displayedWidth - 1),
            borderTop: '1px solid rgba(255,255,255,0.055)',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            borderRadius: '0 6px 6px 0',
            background: 'linear-gradient(90deg, rgba(255,255,255,0.018), rgba(255,255,255,0.065))',
            boxShadow: 'inset -1px 0 rgba(167,139,250,0.18)',
            pointerEvents: 'none',
          }}
        />
      )}

      <section
        ref={panelRef}
        data-tab-task-plan
        data-tab-id={tabId}
        data-expanded={expanded ? 'true' : 'false'}
        tabIndex={0}
        onKeyDown={handlePanelKeyDown}
        onFocusCapture={(event) => setPanelFocused(!isTextEditingElement(event.target))}
        onBlurCapture={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setPanelFocused(false);
          else setPanelFocused(!isTextEditingElement(next));
        }}
        style={{
          position: 'relative',
          zIndex: 1,
          width: displayedWidth,
          maxHeight: 'calc(100vh - 112px)',
          color: '#ccc',
          background: 'rgba(23,23,25,0.96)',
          border: `1px solid ${panelFocused ? 'rgba(167,139,250,0.58)' : '#303036'}`,
          borderRadius: 7,
          boxShadow: expanded ? '0 12px 30px rgba(0,0,0,0.48)' : '0 5px 16px rgba(0,0,0,0.34)',
          backdropFilter: 'blur(8px)',
          overflow: 'hidden',
          pointerEvents: 'auto',
          outline: 'none',
          transition: animateExpansion || animateWidth
            ? 'width 180ms cubic-bezier(0.2, 0.8, 0.2, 1), border-color 110ms ease, box-shadow 160ms ease'
            : 'border-color 110ms ease',
        }}
      >
        <style>{`
          @keyframes noted-task-plan-flash {
            0% { background-color: rgba(167, 139, 250, 0.34); box-shadow: inset 0 0 0 1px rgba(196, 181, 253, 0.62); }
            100% { background-color: transparent; box-shadow: inset 0 0 0 1px rgba(196, 181, 253, 0); }
          }
          @keyframes noted-task-plan-selection-reveal {
            from { opacity: 0.999; }
            to { opacity: 1; }
          }
          @keyframes noted-task-plan-checkbox-reveal {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>

        {animateWidth && (
          <span
            aria-hidden
            data-task-plan-selection-reveal
            onAnimationEnd={() => {
              setAnimatedWidthTabId((current) => current === tabId ? null : current);
              if (selectionMode) setSelectionControlsVisible(true);
            }}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              pointerEvents: 'none',
              animation: 'noted-task-plan-selection-reveal 200ms linear',
            }}
          />
        )}

        <div
          data-task-plan-header
          role="button"
          tabIndex={0}
          title={expanded ? 'Свернуть' : 'Раскрыть'}
          onClick={togglePanelExpanded}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            togglePanelExpanded();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            minHeight: 23,
            padding: '1px 3px',
            borderBottom: expanded ? '1px solid #28282d' : 0,
            color: '#a7a7ac',
            cursor: 'pointer',
            outline: 'none',
            userSelect: 'none',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void addRoot();
            }}
            title="Новая задача"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              padding: '2px 4px',
              color: '#9a9aa0',
              background: 'transparent',
              border: 0,
              borderRadius: 3,
              cursor: 'pointer',
              outline: 'none',
              flexShrink: 0,
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            <Plus size={11} />
            <span>New</span>
          </button>
          {!expanded && (
            <span
              data-task-plan-compact-summary
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                overflow: 'hidden',
                flexShrink: 1,
                pointerEvents: 'none',
              }}
            >
              {plan.items.map((task) => {
                const compactStatus = task.statusId ? statusById.get(task.statusId) : undefined;
                return (
                  <span
                    key={task.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      flexShrink: 0,
                      color: '#77777d',
                      fontSize: 9,
                      lineHeight: 1,
                    }}
                  >
                    {compactStatus ? (
                      <StatusMarker status={compactStatus} size={marker.sizePx} shape={marker.shape} />
                    ) : (
                      <span
                        style={{
                          width: marker.sizePx,
                          height: marker.sizePx,
                          background: '#73737a',
                          border: '1px solid rgba(0,0,0,0.38)',
                          borderRadius: marker.shape === 'dot' ? '50%' : 2,
                          boxSizing: 'border-box',
                        }}
                      />
                    )}
                    {task.subtasks.length > 0 && <span>×{task.subtasks.length}</span>}
                  </span>
                );
              })}
            </span>
          )}
          <span aria-hidden style={{ flex: 1, minWidth: 4 }} />
          <button
            type="button"
            aria-pressed={selectionMode}
            onClick={(event) => {
              event.stopPropagation();
              toggleSelectionMode();
            }}
            title={selectionMode ? 'Закрыть выбор задач' : 'Выбрать несколько задач'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              minWidth: 17,
              padding: 2,
              marginRight: 2,
              color: selectionMode ? '#c4b5fd' : '#66666c',
              background: selectionMode ? 'rgba(139,92,246,0.14)' : 'transparent',
              border: 0,
              borderRadius: 3,
              cursor: 'pointer',
              outline: 'none',
              flexShrink: 0,
              fontSize: 9,
              lineHeight: 1,
            }}
          >
            <ListChecks size={13} />
            {selectionMode && selectedNodeCount > 0 && <span>{selectedNodeCount}</span>}
          </button>
          <button
            type="button"
            aria-pressed={panelLayout.resizeEnabled}
            onClick={(event) => {
              event.stopPropagation();
              toggleResize();
            }}
            title={panelLayout.resizeEnabled ? 'Скрыть настройку ширины' : 'Настроить предел ширины'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 2,
              color: panelLayout.resizeEnabled ? '#a78bfa' : '#66666c',
              background: panelLayout.resizeEnabled ? 'rgba(139,92,246,0.12)' : 'transparent',
              border: 0,
              borderRadius: 3,
              cursor: 'pointer',
              outline: 'none',
              flexShrink: 0,
            }}
          >
            <PanelRightDashed size={13} />
          </button>
        </div>

        <div
          data-task-plan-details={expanded ? '' : undefined}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'max-height') {
              finishExpansionAnimation();
            }
          }}
          style={{
            maxHeight: expanded ? 'min(430px, calc(100vh - 150px))' : 0,
            overflowX: 'hidden',
            overflowY: expanded ? 'auto' : 'hidden',
            padding: expanded ? '0 3px 3px' : 0,
            opacity: expanded ? 1 : 0,
            pointerEvents: expanded ? 'auto' : 'none',
            transition: animateExpansion
              ? 'max-height 200ms cubic-bezier(0.2, 0.8, 0.2, 1), padding 160ms ease, opacity 120ms ease'
              : 'none',
          }}
        >
          <button
            type="button"
            data-task-plan-archive-toggle
            disabled={archivedItems.length === 0}
            aria-expanded={showArchive}
            onClick={toggleArchive}
            title={showArchive ? 'Скрыть архив' : `Архив задач: ${archivedItems.length}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 22,
              gap: 4,
              width: 'calc(100% + 6px)',
              marginLeft: -3,
              marginBottom: showArchive ? 2 : 1,
              padding: '2px 4px',
              color: archivedItems.length
                ? showArchive
                  ? '#c4b5fd'
                  : '#77777d'
                : '#424247',
              background: showArchive ? 'rgba(139,92,246,0.13)' : 'rgba(255,255,255,0.018)',
              border: 0,
              borderRadius: 0,
              cursor: archivedItems.length ? 'pointer' : 'default',
              outline: 'none',
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            <Archive size={11} />
            <span>Архив</span>
            <span>{archivedItems.length}</span>
          </button>
          <div
            data-task-plan-archive-list
            onTransitionEnd={(event) => {
              if (
                event.target === event.currentTarget
                && event.propertyName === 'grid-template-rows'
              ) {
                setAnimatedArchiveTabId((current) => current === tabId ? null : current);
              }
            }}
            style={{
              display: 'grid',
              gridTemplateRows: showArchive ? '1fr' : '0fr',
              opacity: showArchive ? 1 : 0,
              transform: showArchive ? 'translateY(0)' : 'translateY(-4px)',
              transition: animateArchive
                ? 'grid-template-rows 190ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 130ms ease, transform 190ms ease'
                : 'none',
            }}
          >
            <div style={{ minHeight: 0, overflow: 'hidden' }}>
              <div
                style={{
                  marginBottom: showArchive && plan.items.length > 0 ? 3 : 0,
                  paddingBottom: showArchive && plan.items.length > 0 ? 2 : 0,
                  borderBottom: showArchive && plan.items.length > 0
                    ? '1px solid rgba(167,139,250,0.13)'
                    : 'none',
                }}
              >
                {archivedItems.map((task) => renderTaskCard(task, true))}
              </div>
            </div>
          </div>
          {plan.items.map((task) => renderTaskCard(task, false))}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateRows: expanded ? '1fr' : '0fr',
            opacity: expanded ? 1 : 0,
            transition: animateExpansion
              ? 'grid-template-rows 170ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 110ms ease'
              : 'none',
          }}
        >
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            <div
              data-task-plan-footer
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) focusPlanPanel();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                padding: '1px 3px',
                borderTop: '1px solid #28282d',
              }}
            >
              <span aria-hidden style={{ flex: 1, minWidth: 6 }} />
              <button
                type="button"
                disabled={plan.history.past.length === 0}
                onClick={() => void runPlanUndo()}
                title="Назад · Cmd+Z"
                style={{
                  display: 'inline-flex',
                  padding: 2,
                  color: plan.history.past.length ? '#aaa' : '#444',
                  background: 'transparent',
                  border: 0,
                  borderRadius: 3,
                  cursor: plan.history.past.length ? 'pointer' : 'default',
                  outline: 'none',
                }}
              >
                <Undo2 size={12} />
              </button>
              <button
                type="button"
                disabled={plan.history.future.length === 0}
                onClick={() => void runPlanRedo()}
                title="Вперёд · Cmd+Y"
                style={{
                  display: 'inline-flex',
                  padding: 2,
                  color: plan.history.future.length ? '#aaa' : '#444',
                  background: 'transparent',
                  border: 0,
                  borderRadius: 3,
                  cursor: plan.history.future.length ? 'pointer' : 'default',
                  outline: 'none',
                }}
              >
                <Redo2 size={12} />
              </button>
            </div>
          </div>
        </div>

        <div
          ref={titleMeasureRef}
          aria-hidden
          style={{
            position: 'absolute',
            left: -10000,
            top: 0,
            visibility: 'hidden',
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            whiteSpace: 'nowrap',
            fontSize: 12,
          }}
        >
          <span
            key="header"
            data-width-extra="0"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '1px 3px',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 4px' }}>
              <span style={{ width: 11, height: 11 }} />
              <span>New</span>
            </span>
            {!expanded && plan.items.map((task) => (
              <span
                key={task.id}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 2 }}
              >
                <span style={{ width: marker.sizePx, height: marker.sizePx }} />
                {task.subtasks.length > 0 && <span style={{ fontSize: 9 }}>×{task.subtasks.length}</span>}
              </span>
            ))}
            <span style={{ width: 42, height: 13 }} />
          </span>
          {expanded && visibleItems.flatMap((task) => [
            <span
              key={task.id}
              data-width-extra={marker.sizePx + 22}
              style={{ padding: '3px 5px' }}
            >
              {renderTitle(draftTitles[task.id] ?? task.title)}
            </span>,
            ...task.subtasks.map((subtask) => (
              <span
                key={subtask.id}
                data-width-extra={marker.sizePx + 42}
                style={{ padding: '3px 5px' }}
              >
                {renderTitle(draftTitles[subtask.id] ?? subtask.title)}
              </span>
            )),
          ])}
        </div>
      </section>

      {panelLayout.resizeEnabled && (
        <div
          data-task-plan-resize-handle
          onPointerDown={beginResize}
          title="Изменить предел ширины"
          style={{
            position: 'absolute',
            top: 0,
            left: Math.min(reserveDisplayWidth, hostDisplayWidth) - 5,
            bottom: 0,
            width: 10,
            zIndex: 3,
            cursor: 'ew-resize', touchAction: 'none', pointerEvents: 'auto', borderRadius: 4,
            background: isResizing || resizeHovered ? 'rgba(139,92,246,0.12)' : 'transparent',
          }}
          onPointerEnter={() => setResizeHovered(true)}
          onPointerLeave={() => setResizeHovered(false)}
        >
          <span style={{ position: 'absolute', top: 4, left: 4, bottom: 4, width: 2, borderRadius: 2, background: isResizing ? '#a78bfa' : 'rgba(167,139,250,0.7)' }} />
        </div>
      )}
      {statusMenuNode}
      {taskMenuNode}
    </div>
  );
}
