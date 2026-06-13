import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, startTransition } from 'react';
import { useWorkspaceStore, TabColor, TabType, PendingAction } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Tooltip from '../UI/Tooltip';
// Fixed card widths so the wrap-grid stays uniform regardless of name length.
// Without this, short labels (`tab-1`) sit next to long labels (`worker-search`)
// and the column gutters drift — visually ragged. Cards use uniform width and
// truncate long names; Tooltip surfaces the full name on hover.
// Width dropped from 140 → 100px (~28%): user feedback "вкладки можно поменьше".
const CARD_W = 100;        // History + Favorites
const ACTIVE_CARD_W = 100; // Active row — same width for visual consistency

// Right-column width is drag-resizable. Persisted GLOBALLY across machines via
// the localStorage ↔ SQLite mirror (see utils/persistedStorage.ts). The mirror
// only fires for keys with prefix `noted-terminal-` или `sidebarWidth`, поэтому
// ключ префиксуется `noted-terminal-`. Старый ключ `project-home:right-col-width`
// мигрируется автоматически при первом чтении (read old → write new → delete old).
// Default sized for two 100px cards per row (2×100 + 8 gap + 12 padding) — anything
// wider creates dead space. Double-click the divider to reset.
const RIGHT_COL_STORAGE_KEY = 'noted-terminal-project-home-right-col-width';
const RIGHT_COL_LEGACY_KEY = 'project-home:right-col-width';
const RIGHT_COL_DEFAULT = 220;
const RIGHT_COL_MIN = 140;
const RIGHT_COL_MAX = 480;
const loadRightColWidth = (): number => {
  try {
    // Migration: read from new key first; fall back to legacy key и сразу
    // переписываем под новый prefix (после этого mirror зеркалит в SQLite).
    let raw = localStorage.getItem(RIGHT_COL_STORAGE_KEY);
    if (raw == null) {
      const legacy = localStorage.getItem(RIGHT_COL_LEGACY_KEY);
      if (legacy != null) {
        try {
          localStorage.setItem(RIGHT_COL_STORAGE_KEY, legacy);
          localStorage.removeItem(RIGHT_COL_LEGACY_KEY);
        } catch {}
        raw = legacy;
      }
    }
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return RIGHT_COL_DEFAULT;
    if (n >= 320) {
      try { localStorage.removeItem(RIGHT_COL_STORAGE_KEY); } catch {}
      return RIGHT_COL_DEFAULT;
    }
    return Math.max(RIGHT_COL_MIN, Math.min(RIGHT_COL_MAX, n));
  } catch { return RIGHT_COL_DEFAULT; }
};
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import TabPreviewPopover from './TabPreviewPopover';
import { Virtuoso } from 'react-virtuoso';
import { FolderOpen, Clock, Trash2, Pencil, Search, Database, Loader2 } from 'lucide-react';

// Tooltip is still used for the small icon buttons in the project header
// (Select/Change directory, Rename project). Cards themselves don't use it —
// their details surface through the CMD+hover popover (single source for any
// per-card metadata), not bare-hover tooltips.

const { ipcRenderer } = window.require('electron');

interface ProjectHomeProps {
  projectId: string;
}

interface TabHistoryEntry {
  id: number;
  project_id: string;
  name: string;
  cwd: string;
  color: string | null;
  notes: string | null;
  command_type: string | null;
  tab_type: string;
  url: string | null;
  created_at: number;
  closed_at: number;
  claude_session_id: string | null;
  gemini_session_id: string | null;
  codex_session_id: string | null;
  codex_model: string | null;
  codex_effort: string | null;
  message_count: number | null;
  session_status: string | null;
  group_id: string | null;
}

interface FavoriteEntry {
  id: number;
  project_id: string;
  name: string | null;
  cwd: string | null;
  color: string | null;
  notes: string | null;
  command_type: string | null;
  tab_type: string;
  url: string | null;
  claude_session_id: string | null;
  gemini_session_id: string | null;
  codex_session_id: string | null;
  created_at: number;
}

type ScoredTabHistoryEntry = TabHistoryEntry & { score?: number };

interface TabTitleIndexStats {
  total: number;
  indexed: number;
  unindexed: number;
  model: string;
  dims: number;
  inProgress: boolean;
}

type ContextMenuState = {
  x: number;
  y: number;
  type: 'active-tab' | 'favorite' | 'history';
  itemId: string | number;
} | null;

// Today and Yesterday are merged into a single 'Recent' group per UX request —
// 'сегодня и вчера' = единый «недавний» бакет, чтобы не плодить заголовки.
type TimeGroup = 'Recent' | 'This Week' | 'This Month' | 'Older';

const TIME_GROUP_ORDER: TimeGroup[] = ['Recent', 'This Week', 'This Month', 'Older'];

const TIME_GROUP_LABEL: Record<TimeGroup, string> = {
  'Recent': 'Вкладки за сегодня — вчера',
  'This Week': 'На этой неделе',
  'This Month': 'Этот месяц',
  'Older': 'Старее месяца',
};

const RU_MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

function getTimeGroup(timestamp: number): TimeGroup {
  const now = new Date();
  const date = new Date(timestamp * 1000);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= yesterdayStart) return 'Recent';
  if (date >= weekStart) return 'This Week';
  if (date >= monthStart) return 'This Month';
  return 'Older';
}

function groupByTime(entries: TabHistoryEntry[]): Map<TimeGroup, TabHistoryEntry[]> {
  const groups = new Map<TimeGroup, TabHistoryEntry[]>();
  for (const entry of entries) {
    const group = getTimeGroup(entry.closed_at);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(entry);
  }
  const ordered = new Map<TimeGroup, TabHistoryEntry[]>();
  for (const key of TIME_GROUP_ORDER) {
    if (groups.has(key)) ordered.set(key, groups.get(key)!);
  }
  return ordered;
}

// Short closed-at stamp for history cards. Returned as {date, time} parts so
// JSX can place a thin vertical bar between them with tight horizontal margins
// (a joined "DD.MM.YY | HH:MM" string ate 6+ px on each side of the bar from
// regular word-spaces, truncating the stamp in a 100px card).
function formatShortStamp(unix: number): { date: string; time: string } {
  const d = new Date(unix * 1000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return { date: `${dd}.${mm}.${yy}`, time: `${hh}:${min}` };
}

function formatShortMonthYear(unix: number): string {
  const d = new Date(unix * 1000);
  const month = RU_MONTHS[d.getMonth()] || '';
  const year = String(d.getFullYear()).slice(-2);
  return `${month} ${year}`;
}

function formatTimestamp(unix: number): string {
  const date = new Date(unix * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ', ' + date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

// Color configs matching TabBar
const TAB_COLORS: Record<TabColor, { bgColor: string; borderColor: string }> = {
  default: { bgColor: 'rgba(255,255,255,0.05)', borderColor: '#666' },
  red: { bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)' },
  yellow: { bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)' },
  green: { bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)' },
  blue: { bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)' },
  purple: { bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)' },
  claude: { bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756' },
  gemini: { bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8' },
  codex: { bgColor: 'rgba(16, 163, 127, 0.18)', borderColor: '#10A37F' },
};

export default function ProjectHome({ projectId }: ProjectHomeProps) {
  const renderStartedAt = performance.now();
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const workspaceFingerprint = useWorkspaceStore((state) => {
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return 'missing';

    const tabsKey = Array.from(workspace.tabs.values()).map((tab) => [
      tab.id,
      tab.name,
      tab.cwd,
      tab.color || '',
      tab.commandType || '',
      tab.tabType || '',
      tab.url || '',
      tab.claudeSessionId || '',
      tab.geminiSessionId || '',
      tab.codexSessionId || '',
      tab.wasInterrupted ? '1' : '0',
      tab.overlayDismissed ? '1' : '0',
      tab.notes ? 'notes' : '',
      tab.sessionStatus || '',
    ].join(':')).join('|');

    return [
      workspace.projectPath,
      workspace.activeTabId || '',
      workspace.tabCounter,
      workspace.currentView,
      tabsKey,
    ].join('::');
  });
  const project = useProjectsStore((state) => state.projects[projectId]);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const showToast = useUIStore((state) => state.showToast);
  // Status-marker palette + shape/size. Granular selectors — re-rendered только когда
  // юзер правит палитру в SettingsModal, не на каждый closed-tab card flip.
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);
  // tabNotes* font / padding теперь читаются внутри TabPreviewPopover.
  const [syncName, setSyncName] = useState<string | null>(null);
  const [history, setHistory] = useState<TabHistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<ScoredTabHistoryEntry[]>([]);
  const [semanticSearching, setSemanticSearching] = useState(false);
  const [titleSearchError, setTitleSearchError] = useState<string | null>(null);
  const [titleIndexStats, setTitleIndexStats] = useState<TabTitleIndexStats | null>(null);
  const [titleIndexing, setTitleIndexing] = useState(false);
  const [titleIndexProgress, setTitleIndexProgress] = useState<{ current: number; total: number } | null>(null);
  const [visibleRange, setVisibleRange] = useState<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 0 });
  const historyLoadProjectRef = useRef<string | null>(null);
  const renderSeqRef = useRef(0);
  const pendingReadyRef = useRef<{
    id: number;
    readyAt: number;
    readyAbs: number;
    firstLoad: boolean;
    tabs: number;
    history: number;
    favorites: number;
  } | null>(null);
  const loadSeqRef = useRef(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['This Month', 'Older']));
  // OSC 133 event-driven process status — mirror of TabBar's subscription. Used
  // to render the same green/red status dot on Active cards that the real
  // TabBar shows. Keeping a local copy here (instead of lifting to a store) is
  // intentional: ProjectHome unmounts when user switches back to terminal, so
  // the subscription dies with it and we don't pay the cost when not visible.
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  // Right-column width — drag the vertical divider to resize. Wider = more
  // room for Active/Favorites cards per row; narrower = more room for history.
  const [rightColWidth, setRightColWidth] = useState<number>(() => loadRightColWidth());
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Pointer-based drag — fires on PointerMove from window so the cursor can leave
  // the divider strip without breaking the drag. Pointer-capture would also work
  // but window-level listeners are simpler here since we only care about delta-X.
  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: rightColWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      // Dragging LEFT increases right-column width (we want it intuitive: drag
      // left = give more space to active+favorites; drag right = give more to
      // history). Sign chosen so the divider follows the cursor.
      const delta = st.startX - ev.clientX;
      const w = Math.max(RIGHT_COL_MIN, Math.min(RIGHT_COL_MAX, st.startWidth + delta));
      setRightColWidth(w);
    };
    const onUp = () => {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (st) {
        try { localStorage.setItem(RIGHT_COL_STORAGE_KEY, String(Math.round(rightColWidthRef.current))); } catch {}
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [rightColWidth]);

  // Mirror state into a ref so pointer-up can persist the final width without
  // stale closure over the initial state value.
  const rightColWidthRef = useRef(rightColWidth);
  useEffect(() => { rightColWidthRef.current = rightColWidth; }, [rightColWidth]);
  const [homeContextMenu, setHomeContextMenu] = useState<ContextMenuState>(null);

  // Draft mode detection — check if this project was just created
  const [isDraft, setIsDraft] = useState(false);
  const [draftName, setDraftName] = useState('Новый проект');
  const draftInputRef = useRef<HTMLInputElement>(null);
  const isPickingDirectoryRef = useRef(false);
  const draftConfirmedRef = useRef(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Listen for draft init from App.tsx — only activates once per creation
  useEffect(() => {
    const handleDraftInit = (e: any) => {
      if (e.detail.projectId === projectId) {
        draftConfirmedRef.current = false;
        setIsDraft(true);
        setDraftName(e.detail.name || 'Новый проект');
      }
    };
    window.addEventListener('project:draft-init', handleDraftInit);
    return () => window.removeEventListener('project:draft-init', handleDraftInit);
  }, [projectId]);

  // Auto-focus draft input
  useEffect(() => {
    if (isDraft && draftInputRef.current) {
      draftInputRef.current.focus();
      draftInputRef.current.select();
    }
  }, [isDraft]);

  // Auto-focus name edit input
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const handleDraftSubmit = useCallback((name?: string, path?: string) => {
    const finalName = name || draftName.trim();
    if (!finalName || (finalName === 'Новый проект' && !path)) {
      handleDraftCancel();
      return;
    }
    draftConfirmedRef.current = true;
    setIsDraft(false);
    window.dispatchEvent(new CustomEvent('project:draft-submit', {
      detail: { projectId, name: finalName, path }
    }));
  }, [draftName, projectId]);

  const handleDraftCancel = useCallback(() => {
    setIsDraft(false);
    window.dispatchEvent(new CustomEvent('project:draft-cancel', {
      detail: { projectId }
    }));
  }, [projectId]);

  const handleDraftBlur = useCallback(() => {
    // Delay to let onMouseDown on directory button set the flag first
    setTimeout(() => {
      if (isPickingDirectoryRef.current) return; // Don't cancel — user is picking directory
      if (draftConfirmedRef.current) return; // Already submitted via Enter/directory
      if (isDraft) {
        const trimmed = draftName.trim();
        if (!trimmed || trimmed === 'Новый проект') {
          handleDraftCancel();
        } else {
          handleDraftSubmit(trimmed);
        }
      }
    }, 100);
  }, [isDraft, draftName, handleDraftSubmit, handleDraftCancel]);

  const handleDraftKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = draftName.trim();
      if (!trimmed || trimmed === 'Новый проект') {
        handleDraftCancel();
      } else {
        handleDraftSubmit(trimmed);
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDraftCancel();
    }
  }, [draftName, handleDraftSubmit, handleDraftCancel]);

  const handleDraftDirectoryClick = useCallback(async () => {
    isPickingDirectoryRef.current = true;
    try {
      const selected = await ipcRenderer.invoke('app:select-directory');
      if (selected) {
        // Auto-name from directory
        const dirName = selected.split('/').filter(Boolean).pop() || selected;
        setDraftName(dirName);
        await updateProject(projectId, { path: selected });
        // Sync name with title bar
        window.dispatchEvent(new CustomEvent('project:name-sync', {
          detail: { projectId, name: dirName, source: 'home' }
        }));
        handleDraftSubmit(dirName, selected);
      } else {
        // User cancelled dialog — return to draft, re-focus input
        if (draftInputRef.current) {
          draftInputRef.current.focus();
        }
      }
    } finally {
      isPickingDirectoryRef.current = false;
    }
  }, [projectId, updateProject, handleDraftSubmit]);

  // CMD+hover popovers (unified hooks). Tooltip on bare hover was removed —
  // user already has the muscle memory of "hold Cmd to peek details".
  const isCmdPressed = useCmdKey();
  const historyPopover = useCmdHoverPopover<number>(isCmdPressed);

  // Close context menu on mousedown outside
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!homeContextMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setHomeContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [homeContextMenu]);

  useEffect(() => {
    const handleSync = (e: any) => {
      if (e.detail.projectId === projectId && e.detail.source !== 'home') {
        setSyncName(e.detail.name);
        if (isDraft) setDraftName(e.detail.name);
      }
    };
    window.addEventListener('project:name-sync', handleSync);
    return () => window.removeEventListener('project:name-sync', handleSync);
  }, [projectId, isDraft]);

  const workspace = useMemo(() => (
    useWorkspaceStore.getState().openProjects.get(projectId)
  ), [projectId, workspaceFingerprint]);
  const tabs = useMemo(() => (
    workspace ? Array.from(workspace.tabs.values()) : []
  ), [workspace, workspaceFingerprint]);
  const tabIdsKey = useMemo(() => tabs.map((tab) => tab.id).join('|'), [tabs]);
  const resolveHistoryGroupId = useCallback((entry: TabHistoryEntry): string | undefined => {
    const groupId = entry.group_id || undefined;
    if (!groupId) return undefined;
    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    return currentWorkspace?.tabGroups?.some(group => group.id === groupId) ? groupId : undefined;
  }, [projectId]);

  useEffect(() => {
    const mountedAt = performance.now();
    console.warn(
      `[Perf:Home] mount project=${projectId.slice(-12)}` +
      ` abs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
      ` tabs=${tabs.length}`
    );
    return () => {
      console.warn(
        `[Perf:Home] unmount project=${projectId.slice(-12)}` +
        ` abs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` aliveMs=${(performance.now() - mountedAt).toFixed(1)}`
      );
    };
  }, [projectId]);

  useLayoutEffect(() => {
    renderSeqRef.current += 1;
    const renderToLayoutMs = performance.now() - renderStartedAt;
    if (renderToLayoutMs > 50) {
      console.warn(
        `[Perf:HomeRender] project=${projectId.slice(-12)} seq=${renderSeqRef.current}` +
        ` abs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` loaded=${isLoaded} tabs=${tabs.length} history=${history.length} favorites=${favorites.length}` +
        ` renderToLayoutMs=${renderToLayoutMs.toFixed(1)}`
      );
    }
  });

  useEffect(() => {
    if (!isLoaded || !pendingReadyRef.current) return;
    const pending = pendingReadyRef.current;
    requestAnimationFrame(() => {
      if (pendingReadyRef.current?.id !== pending.id) return;
      const groups = groupByTime(history);
      let visibleHistory = 0;
      const groupParts: string[] = [];
      groups.forEach((entries, group) => {
        const collapsed = group !== 'Recent' && group !== 'This Week' && collapsedGroups.has(group);
        if (!collapsed) visibleHistory += entries.length;
        groupParts.push(group.replace(/\s+/g, '') + ':' + entries.length + (collapsed ? ':closed' : ':open'));
      });
      console.warn(
        `[Perf:HomeCommit] project=${projectId.slice(-12)} loadId=${pending.id}` +
        ` abs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` readyAbs=${pending.readyAbs.toFixed(1)}` +
        ` firstLoad=${pending.firstLoad} readyToFrameMs=${(performance.now() - pending.readyAt).toFixed(1)}` +
        ` tabs=${pending.tabs} history=${pending.history} favorites=${pending.favorites}` +
        ` visibleHistory=${visibleHistory} groups=${groupParts.join(',')}`
      );
      pendingReadyRef.current = null;
    });
  }, [isLoaded, history, favorites, tabs.length, projectId, collapsedGroups]);

  // Restore a closed tab from history
  const restoreTab = async (entry: TabHistoryEntry) => {
    let pendingAction: PendingAction | undefined;
    if (entry.command_type === 'claude') {
      if (entry.claude_session_id) {
        pendingAction = { type: 'claude-continue', sessionId: entry.claude_session_id };
      } else {
        pendingAction = { type: 'claude-new' };
      }
    } else if (entry.command_type === 'gemini') {
      if (entry.gemini_session_id) {
        pendingAction = { type: 'gemini-continue', sessionId: entry.gemini_session_id };
      } else {
        pendingAction = { type: 'gemini-new' };
      }
    } else if (entry.command_type === 'codex') {
      if (entry.codex_session_id) {
        pendingAction = { type: 'codex-continue', sessionId: entry.codex_session_id };
      } else {
        pendingAction = { type: 'codex-new' };
      }
    }

    setProjectView(projectId, 'terminal');
    await createTab(projectId, entry.name, entry.cwd, {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
      codexSessionId: entry.codex_session_id || undefined,
      codexModel: entry.codex_model || undefined,
      codexEffort: entry.codex_effort || undefined,
      sessionStatus: entry.session_status || undefined,
      groupId: resolveHistoryGroupId(entry),
    });

    await ipcRenderer.invoke('project:delete-tab-history-entry', { id: entry.id });
    setHistory(prev => prev.filter(h => h.id !== entry.id));
  };

  // Restore a history tab in the background (middle-click) — no view switch, no activation
  const restoreTabBackground = async (entry: TabHistoryEntry) => {
    let pendingAction: PendingAction | undefined;
    if (entry.command_type === 'claude') {
      if (entry.claude_session_id) {
        pendingAction = { type: 'claude-continue', sessionId: entry.claude_session_id };
      } else {
        pendingAction = { type: 'claude-new' };
      }
    } else if (entry.command_type === 'gemini') {
      if (entry.gemini_session_id) {
        pendingAction = { type: 'gemini-continue', sessionId: entry.gemini_session_id };
      } else {
        pendingAction = { type: 'gemini-new' };
      }
    } else if (entry.command_type === 'codex') {
      if (entry.codex_session_id) {
        pendingAction = { type: 'codex-continue', sessionId: entry.codex_session_id };
      } else {
        pendingAction = { type: 'codex-new' };
      }
    }

    await createTab(projectId, entry.name, entry.cwd, {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
      codexSessionId: entry.codex_session_id || undefined,
      codexModel: entry.codex_model || undefined,
      codexEffort: entry.codex_effort || undefined,
      sessionStatus: entry.session_status || undefined,
      groupId: resolveHistoryGroupId(entry),
      background: true,
    });

    await ipcRenderer.invoke('project:delete-tab-history-entry', { id: entry.id });
    setHistory(prev => prev.filter(h => h.id !== entry.id));
  };

  // Restore from favorite (creates new tab, does NOT delete favorite)
  const restoreFromFavorite = async (entry: FavoriteEntry) => {
    let pendingAction: PendingAction | undefined;
    if (entry.command_type === 'claude') {
      if (entry.claude_session_id) {
        pendingAction = { type: 'claude-continue', sessionId: entry.claude_session_id };
      } else {
        pendingAction = { type: 'claude-new' };
      }
    } else if (entry.command_type === 'gemini') {
      if (entry.gemini_session_id) {
        pendingAction = { type: 'gemini-continue', sessionId: entry.gemini_session_id };
      } else {
        pendingAction = { type: 'gemini-new' };
      }
    } else if (entry.command_type === 'codex') {
      if (entry.codex_session_id) {
        pendingAction = { type: 'codex-continue', sessionId: entry.codex_session_id };
      } else {
        pendingAction = { type: 'codex-new' };
      }
    }

    setProjectView(projectId, 'terminal');
    await createTab(projectId, entry.name || 'tab', entry.cwd || project?.path || '/', {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
      codexSessionId: entry.codex_session_id || undefined,
    });
  };

  // Fetch history only. Active/Favorites are intentionally not rendered on Home:
  // this view is now a single virtualized closed-tab stream with title search.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const loadId = ++loadSeqRef.current;
    const startedAt = performance.now();
    const startAbs = performance.timeOrigin + startedAt;
    const firstLoadForProject = historyLoadProjectRef.current !== projectId;
    historyLoadProjectRef.current = projectId;
    if (firstLoadForProject) {
      setIsLoaded(false);
    }
    (ipcRenderer.invoke('project:get-tab-history', { projectId }) as Promise<TabHistoryEntry[]>).then((h) => {
      if (cancelled) return;
      const historyRows = h || [];
      const ipcMs = performance.now() - startedAt;
      console.warn(
        `[Perf:Home] ready project=${projectId.slice(-12)} loadId=${loadId} firstLoad=${firstLoadForProject}` +
        ` startAbs=${startAbs.toFixed(1)}` +
        ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` tabs=${tabs.length} history=${historyRows.length} favorites=0` +
        ` ipcMs=${ipcMs.toFixed(1)}`
      );
      pendingReadyRef.current = {
        id: loadId,
        readyAt: performance.now(),
        readyAbs: performance.timeOrigin + performance.now(),
        firstLoad: firstLoadForProject,
        tabs: tabs.length,
        history: historyRows.length,
        favorites: 0,
      };
      startTransition(() => {
        setHistory(historyRows);
        setFavorites([]);
        setIsLoaded(true);
      });
    }).catch((err) => {
      console.error('[ProjectHome] Failed to load history/favorites:', err);
      if (cancelled) return;
      const ipcMs = performance.now() - startedAt;
      console.warn(
        `[Perf:Home] ready project=${projectId.slice(-12)} loadId=${loadId} firstLoad=${firstLoadForProject}` +
        ` startAbs=${startAbs.toFixed(1)}` +
        ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` tabs=${tabs.length} history=0 favorites=0 ipcMs=${ipcMs.toFixed(1)} error=true`
      );
      pendingReadyRef.current = {
        id: loadId,
        readyAt: performance.now(),
        readyAbs: performance.timeOrigin + performance.now(),
        firstLoad: firstLoadForProject,
        tabs: tabs.length,
        history: 0,
        favorites: 0,
      };
      startTransition(() => {
        setHistory([]);
        setFavorites([]);
        setIsLoaded(true);
      });
    });
    return () => { cancelled = true; };
  }, [projectId, tabs.length]);

  const displayName = syncName || project?.name || '';

  const handleCreateTab = async () => {
    if (project) {
      await createTab(projectId, undefined, project.path);
      setProjectView(projectId, 'terminal');
    }
  };

  const [showKeepNotes, setShowKeepNotes] = useState(false);

  const handleClearHistory = async () => {
    await ipcRenderer.invoke('project:clear-tab-history', { projectId });
    setHistory([]);
  };

  const handleClearExceptNotes = async () => {
    await ipcRenderer.invoke('project:clear-tab-history-except-notes', { projectId });
    const data = await ipcRenderer.invoke('project:get-tab-history', { projectId });
    setHistory(data || []);
  };

  const handleChangeDirectory = async () => {
    const selected = await ipcRenderer.invoke('app:select-directory');
    if (selected) {
      await updateProject(projectId, { path: selected });
    }
  };

  // Add active tab to favorites
  const addActiveTabToFavorites = async (tabId: string) => {
    const tab = workspace?.tabs.get(tabId);
    if (!tab) return;
    await ipcRenderer.invoke('project:add-favorite', {
      projectId,
      tab: {
        name: tab.name,
        cwd: tab.cwd,
        color: tab.color || null,
        notes: tab.notes || null,
        commandType: tab.commandType || null,
        tabType: tab.tabType || 'terminal',
        url: tab.url || null,
        claudeSessionId: tab.claudeSessionId || null,
        geminiSessionId: tab.geminiSessionId || null,
      }
    });
    showToast(`"${tab.name}" added to favorites`, 'success');
    // Refetch favorites
    const data = await ipcRenderer.invoke('project:get-favorites', { projectId });
    setFavorites(data || []);
  };

  // Add history entry to favorites
  const addHistoryToFavorites = async (entry: TabHistoryEntry) => {
    await ipcRenderer.invoke('project:add-favorite', {
      projectId,
      tab: {
        name: entry.name,
        cwd: entry.cwd,
        color: entry.color || null,
        notes: entry.notes || null,
        commandType: entry.command_type || null,
        tabType: entry.tab_type || 'terminal',
        url: entry.url || null,
        claudeSessionId: entry.claude_session_id || null,
        geminiSessionId: entry.gemini_session_id || null,
      }
    });
    showToast(`"${entry.name}" added to favorites`, 'success');
    const data = await ipcRenderer.invoke('project:get-favorites', { projectId });
    setFavorites(data || []);
  };

  // Delete favorite
  const deleteFavorite = async (id: number) => {
    await ipcRenderer.invoke('project:delete-favorite', { id });
    setFavorites(prev => prev.filter(f => f.id !== id));
  };

  // Delete history entry
  const deleteHistoryEntry = async (id: number) => {
    await ipcRenderer.invoke('project:delete-tab-history-entry', { id });
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  const refreshTitleIndexStats = useCallback(async () => {
    try {
      const res = await ipcRenderer.invoke('tab-title-index:stats', { projectId });
      if (res?.success) {
        setTitleIndexStats(res.data);
        setTitleIndexing(!!res.data?.inProgress);
      }
    } catch (err: any) {
      setTitleSearchError(err?.message || 'Failed to load title index stats');
    }
  }, [projectId]);

  useEffect(() => {
    if (!isLoaded) return;
    refreshTitleIndexStats();
  }, [isLoaded, history.length, refreshTitleIndexStats]);

  useEffect(() => {
    const handler = (_: any, data: any) => {
      if (data?.projectId !== projectId) return;
      setTitleIndexProgress({ current: data.current || 0, total: data.total || 0 });
    };
    ipcRenderer.on('tab-title-index:progress', handler);
    return () => { ipcRenderer.removeListener('tab-title-index:progress', handler); };
  }, [projectId]);

  const handleReindexTitles = useCallback(async () => {
    setTitleIndexing(true);
    setTitleIndexProgress(null);
    setTitleSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-title-index:reindex', { projectId, force: false });
      if (res?.success) {
        setTitleIndexStats(res.stats || null);
      } else {
        setTitleSearchError(res?.error || 'Title indexing failed');
      }
    } catch (err: any) {
      setTitleSearchError(err?.message || 'Title indexing failed');
    } finally {
      setTitleIndexing(false);
      setTitleIndexProgress(null);
      refreshTitleIndexStats();
    }
  }, [projectId, refreshTitleIndexStats]);

  const titleIndexButtonLabel = useMemo(() => {
    if (!titleIndexing) return 'Index';
    const total = titleIndexProgress?.total ?? titleIndexStats?.unindexed ?? 0;
    const current = titleIndexProgress?.current ?? 0;
    return total > 0 ? `${Math.min(current, total)}/${total}` : 'Indexing';
  }, [titleIndexing, titleIndexProgress, titleIndexStats?.unindexed]);

  const localFilteredHistory = useMemo(() => {
    const q = normalizeSearchText(historyQuery);
    if (!q) return history as ScoredTabHistoryEntry[];
    const tokens = q.split(' ').filter(Boolean);
    return history.filter((entry) => {
      const haystack = normalizeSearchText(entry.name || '');
      return tokens.every((token) => haystack.includes(token));
    });
  }, [history, historyQuery]);

  const semanticModeActive = Boolean(
    semanticQuery.trim() &&
    normalizeSearchText(semanticQuery) === normalizeSearchText(historyQuery)
  );

  const displayedHistory = semanticModeActive ? semanticResults : localFilteredHistory;

  const displayedMeta = useMemo(() => {
    const counts = new Map<TimeGroup, number>();
    const ranges = new Map<TimeGroup, { from: number; to: number }>();
    for (const entry of displayedHistory) {
      const group = getTimeGroup(entry.closed_at);
      counts.set(group, (counts.get(group) || 0) + 1);
      const range = ranges.get(group);
      if (!range) {
        ranges.set(group, { from: entry.closed_at, to: entry.closed_at });
      } else {
        range.from = Math.min(range.from, entry.closed_at);
        range.to = Math.max(range.to, entry.closed_at);
      }
    }
    const seen = new Map<TimeGroup, number>();
    return displayedHistory.map((entry) => {
      const group = getTimeGroup(entry.closed_at);
      const indexInGroup = seen.get(group) || 0;
      seen.set(group, indexInGroup + 1);
      const range = ranges.get(group);
      const rangeLabel = group === 'Older' && range
        ? (() => {
            const from = formatShortMonthYear(range.from);
            const to = formatShortMonthYear(range.to);
            return from === to ? from : `${from} — ${to}`;
          })()
        : null;
      return {
        group,
        label: rangeLabel ? `${TIME_GROUP_LABEL[group]} (${rangeLabel})` : TIME_GROUP_LABEL[group],
        indexInGroup,
        groupCount: counts.get(group) || 0,
      };
    });
  }, [displayedHistory]);

  const currentScrollMeta = displayedMeta[Math.min(
    Math.max(visibleRange.endIndex, 0),
    Math.max(displayedMeta.length - 1, 0),
  )];

  const handleSemanticTitleSearch = useCallback(async () => {
    const query = historyQuery.trim();
    if (query.length < 2) return;
    setSemanticSearching(true);
    setTitleSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-title-search:semantic', {
        projectId,
        query,
        maxResults: 120,
        minScore: 0.38,
      });
      if (res?.success) {
        setSemanticQuery(query);
        setSemanticResults(res.data || []);
        setVisibleRange({ startIndex: 0, endIndex: 0 });
      } else {
        setTitleSearchError(res?.error || 'Semantic title search failed');
      }
    } catch (err: any) {
      setTitleSearchError(err?.message || 'Semantic title search failed');
    } finally {
      setSemanticSearching(false);
    }
  }, [historyQuery, projectId]);

  if (!workspace || !project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        Project not found
      </div>
    );
  }

  const handleTabClick = (tabId: string) => {
    const activeBefore = workspace?.activeTabId;
    console.warn(
      `[Perf:HomeAction] active-tab-click project=${projectId.slice(-12)}` +
      ` abs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
      ` tab=${tabId.slice(-12)} activeBefore=${String(activeBefore).slice(-12)}` +
      ` sameActive=${activeBefore === tabId ? '1' : '0'}` +
      ` tabs=${tabs.length} history=${history.length} favorites=${favorites.length}`
    );
    switchTab(projectId, tabId);
    setProjectView(projectId, 'terminal');
  };

  const getFolderName = (pathStr: string) => {
    const parts = pathStr.split('/');
    return parts[parts.length - 1] || pathStr;
  };

  // Context menu handler for cards
  const handleCardContextMenu = (e: React.MouseEvent, type: ContextMenuState['type'], itemId: string | number) => {
    e.preventDefault();
    e.stopPropagation();
    setHomeContextMenu({ x: e.clientX, y: e.clientY, type: type!, itemId });
  };

  return (
    <div className="h-full bg-bg-main p-6 overflow-hidden flex flex-col" style={{ position: 'relative' }}>
      {/* Project Header */}
      <div className="mb-5 w-full max-w-[680px] mx-auto flex-shrink-0">
        {isDraft ? (
          /* Draft mode: inline input for naming */
          <>
            <input
              ref={draftInputRef}
              className="text-xl text-white font-medium mb-1 bg-transparent border-b border-accent outline-none"
              style={{ width: '400px', maxWidth: '100%' }}
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                window.dispatchEvent(new CustomEvent('project:name-sync', {
                  detail: { projectId, name: e.target.value, source: 'home' }
                }));
              }}
              onBlur={handleDraftBlur}
              onKeyDown={handleDraftKeyDown}
              placeholder="Project name..."
            />
            <div className="flex items-center gap-2 text-[#666] text-sm mt-1">
              <FolderOpen size={14} />
              <span className="text-[#555] italic">No directory selected</span>
              <Tooltip content="Select project directory">
              <button
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent blur on input
                  isPickingDirectoryRef.current = true;
                }}
                onClick={handleDraftDirectoryClick}
                className="text-accent hover:text-white cursor-pointer transition-colors p-1 rounded hover:bg-accent/10"
              >
                <FolderOpen size={14} />
              </button>
              </Tooltip>
            </div>
          </>
        ) : isEditingName ? (
          /* Normal editing mode: inline rename */
          <>
            <input
              ref={nameInputRef}
              className="text-xl text-white font-medium mb-1 bg-transparent border-b border-white/20 outline-none focus:border-accent"
              style={{ width: '400px', maxWidth: '100%' }}
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                window.dispatchEvent(new CustomEvent('project:name-sync', {
                  detail: { projectId, name: e.target.value, source: 'home' }
                }));
              }}
              onBlur={async () => {
                setIsEditingName(false);
                window.dispatchEvent(new CustomEvent('project:edit-end', { detail: { projectId } }));
                const trimmed = draftName.trim();
                if (trimmed && trimmed !== project.name) {
                  await updateProject(projectId, { name: trimmed });
                }
              }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  setIsEditingName(false);
                  window.dispatchEvent(new CustomEvent('project:edit-end', { detail: { projectId } }));
                  const trimmed = draftName.trim();
                  if (trimmed && trimmed !== project.name) {
                    await updateProject(projectId, { name: trimmed });
                  }
                }
                if (e.key === 'Escape') {
                  setIsEditingName(false);
                  setDraftName(project.name);
                  window.dispatchEvent(new CustomEvent('project:edit-end', { detail: { projectId } }));
                }
              }}
              placeholder="Project name..."
            />
            <div className="flex items-center gap-2 text-[#666] text-sm mt-1">
              <FolderOpen size={14} />
              <span>{project.path.startsWith('__unset__') ? 'No path' : project.path}</span>
              <Tooltip content="Change project directory">
              <button
                onClick={handleChangeDirectory}
                className="text-[#666] hover:text-[#999] cursor-pointer transition-colors p-0.5"
              >
                <Pencil size={12} />
              </button>
              </Tooltip>
            </div>
          </>
        ) : (
          /* Normal display mode */
          <>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl text-white font-medium">{displayName}</h1>
              <Tooltip content="Rename project">
              <button
                onClick={() => {
                  setDraftName(project.name);
                  setIsEditingName(true);
                  // Start editing in title bar too for sync
                  window.dispatchEvent(new CustomEvent('project:edit-start', {
                    detail: { projectId, name: project.name }
                  }));
                }}
                className="text-[#555] hover:text-[#999] cursor-pointer transition-colors p-0.5"
              >
                <Pencil size={12} />
              </button>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2 text-[#666] text-sm">
              <FolderOpen size={14} />
              <span>{project.path.startsWith('__unset__') ? 'No path' : project.path}</span>
              <Tooltip content="Change project directory">
              <button
                onClick={handleChangeDirectory}
                className="text-[#666] hover:text-[#999] cursor-pointer transition-colors p-0.5"
              >
                <Pencil size={12} />
              </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>

      {!isLoaded && (
        <div className="flex-1 min-h-0 w-full max-w-[680px] mx-auto space-y-3">
          <div className="h-8 w-full bg-white/[0.04] rounded animate-pulse" />
          <div className="h-7 w-64 bg-white/[0.04] rounded animate-pulse" />
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-[34px] w-full bg-white/[0.03] rounded animate-pulse" />
          ))}
        </div>
      )}

      {isLoaded && (
        <div className="flex-1 min-h-0 w-full max-w-[680px] mx-auto flex flex-col">
          <div className="flex items-center gap-2 mb-3 flex-shrink-0">
            <div className="relative flex-1 min-w-0">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#666]" />
              <input
                value={historyQuery}
                onChange={(e) => {
                  setHistoryQuery(e.target.value);
                  setTitleSearchError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSemanticTitleSearch();
                  }
                }}
                placeholder="Search tab titles..."
                className="w-full h-8 bg-[#151515] border border-[#2a2a2a] rounded px-8 text-[12px] text-white outline-none focus:border-[#555]"
              />
              {semanticSearching && (
                <Loader2 size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#818cf8] animate-spin" />
              )}
            </div>
            <button
              onClick={handleSemanticTitleSearch}
              disabled={semanticSearching || historyQuery.trim().length < 2}
              className="h-8 px-3 rounded border border-[#333] text-[12px] text-[#ccc] hover:text-white hover:border-[#555] disabled:opacity-40 disabled:hover:text-[#ccc] disabled:hover:border-[#333] cursor-pointer disabled:cursor-default flex items-center gap-1.5"
              title="Cmd+Enter"
            >
              <Search size={13} />
              RAG
            </button>
            <div className="h-8 px-2 rounded border border-[#2a2a2a] bg-[#111] text-[11px] text-[#888] flex items-center gap-1.5">
              <Database size={12} className={titleIndexStats?.unindexed ? 'text-[#d97706]' : 'text-[#666]'} />
              <span>{titleIndexStats?.unindexed ?? 0} new</span>
            </div>
            <button
              onClick={handleReindexTitles}
              disabled={titleIndexing || !titleIndexStats?.unindexed}
              className={`h-8 min-w-[72px] px-2 rounded border text-[11px] flex items-center justify-center gap-1.5 ${
                titleIndexing
                  ? 'border-[#3a3a52] bg-[#151528] text-[#d7d7ff] cursor-default'
                  : titleIndexStats?.unindexed
                    ? 'border-[#333] text-[#aaa] hover:text-white hover:border-[#555] cursor-pointer'
                    : 'border-[#333] text-[#aaa] opacity-40 cursor-default'
              }`}
            >
              {titleIndexing ? (
                <Loader2 size={12} className="animate-spin text-[#818cf8]" />
              ) : (
                <Database size={12} />
              )}
              {titleIndexButtonLabel}
            </button>
            <button
              onClick={() => handleClearHistory()}
              className="h-8 px-2 rounded text-[11px] text-[#666] hover:text-[#999] cursor-pointer flex items-center gap-1"
              title="Clear history"
            >
              <Trash2 size={12} />
            </button>
          </div>

          <div className="flex items-center justify-between mb-2 flex-shrink-0 text-[11px]">
            <div className="text-[#666]">
              {semanticModeActive ? 'RAG results' : 'Instant title filter'} · {displayedHistory.length}/{history.length}
              {titleIndexStats ? <span className="text-[#4b5563]"> · indexed {titleIndexStats.indexed}/{titleIndexStats.total}</span> : null}
            </div>
            {titleSearchError && <div className="text-[#DA7756] truncate max-w-[50%]">{titleSearchError}</div>}
          </div>

          <div className="flex-1 min-h-0 border border-[#242424] rounded bg-[#0f0f0f] overflow-hidden">
            {displayedHistory.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[#555] text-xs">
                {history.length === 0 ? 'Нет закрытых вкладок в истории.' : 'Ничего не найдено.'}
              </div>
            ) : (
              <div className="h-full min-h-0 flex flex-col">
                <div className="h-8 px-3 bg-[#151515]/95 border-b border-[#2a2a2a] flex items-center justify-between text-[11px] flex-shrink-0">
                    <div className="flex items-center gap-2 text-[#888] min-w-0">
                      <Clock size={13} className="text-[#777] flex-shrink-0" />
                      <span className="truncate">{currentScrollMeta?.label || 'История'}</span>
                    </div>
                    <div className="text-[#666] font-mono">
                      {currentScrollMeta ? `${currentScrollMeta.indexInGroup + 1}/${currentScrollMeta.groupCount}` : `0/${displayedHistory.length}`}
                    </div>
                  </div>
                <Virtuoso
                  style={{ height: '100%' }}
                  data={displayedHistory}
                  rangeChanged={(range) => setVisibleRange((prev) => (
                    prev.startIndex === range.startIndex && prev.endIndex === range.endIndex
                      ? prev
                      : { startIndex: range.startIndex, endIndex: range.endIndex }
                  ))}
                  itemContent={(index, entry) => {
                    const color = (entry.color || 'default') as TabColor;
                    const colorConfig = TAB_COLORS[color];
                    const meta = entry.session_status
                      ? sessionStatuses.find((s) => s.id === entry.session_status)
                      : null;
                    const { date, time } = formatShortStamp(entry.closed_at);
                    return (
                      <div
                        className="px-2 py-[3px]"
                        {...historyPopover.triggerProps(entry.id)}
                        onContextMenu={(e) => handleCardContextMenu(e, 'history', entry.id)}
                      >
                        <div
                          className="relative cursor-pointer transition-opacity hover:opacity-75"
                          onClick={() => restoreTab(entry)}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              restoreTabBackground(entry);
                            }
                          }}
                          style={{
                            minHeight: 32,
                            padding: '5px 8px',
                            backgroundColor: colorConfig.bgColor,
                            borderRadius: 5,
                            borderLeft: `2px solid ${colorConfig.borderColor}`,
                            opacity: 0.62,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          {meta && (
                            <span
                              title={meta.label}
                              style={{
                                flexShrink: 0,
                                width: `${statusMarkerSize}px`,
                                height: `${statusMarkerSize}px`,
                                borderRadius: statusMarkerShape === 'square' ? '2px' : '50%',
                                backgroundColor: meta.color,
                                border: '1px solid rgba(0,0,0,0.4)',
                              }}
                            />
                          )}
                          <div className="min-w-0 flex-1 text-[12px] leading-[16px] text-white break-words">
                            {entry.name}
                          </div>
                          <div className="flex-shrink-0 flex items-center gap-2 text-[10px] text-[#888] font-mono">
                            {semanticModeActive && typeof entry.score === 'number' && (
                              <span className="text-[#818cf8]">{entry.score.toFixed(2)}</span>
                            )}
                            <span>{date}<span style={{ color: '#555', margin: '0 2px' }}>|</span>{time}</span>
                          </div>
                          {isCmdPressed && entry.notes && (
                            <span
                              style={{
                                position: 'absolute',
                                top: 5,
                                right: 5,
                                width: 5,
                                height: 5,
                                borderRadius: '50%',
                                backgroundColor: '#DA7756',
                              }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Context Menu (fixed, pattern from TabBar) */}
      {homeContextMenu && (
        <div
          ref={contextMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: homeContextMenu.x,
            top: homeContextMenu.y,
            zIndex: 9999,
          }}
        >
          <div
            className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[160px]"
            style={{ transform: 'translateY(-4px)' }}
          >
            {/* Active Tab Context Menu */}
            {homeContextMenu.type === 'active-tab' && (() => {
              const tabId = homeContextMenu.itemId as string;
              const tab = workspace.tabs.get(tabId);
              if (!tab) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTabClick(tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Switch to Tab
                  </button>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      addActiveTabToFavorites(tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Add to Favorites
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(projectId, tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Close Tab
                  </button>
                </>
              );
            })()}

            {/* Favorite Context Menu */}
            {homeContextMenu.type === 'favorite' && (() => {
              const favId = homeContextMenu.itemId as number;
              const entry = favorites.find(f => f.id === favId);
              if (!entry) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreFromFavorite(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Open
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFavorite(favId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Remove from Favorites
                  </button>
                </>
              );
            })()}

            {/* History Context Menu */}
            {homeContextMenu.type === 'history' && (() => {
              const histId = homeContextMenu.itemId as number;
              const entry = history.find(h => h.id === histId);
              if (!entry) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreTab(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Restore
                  </button>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      addHistoryToFavorites(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Add to Favorites
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistoryEntry(histId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Delete
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* CMD+Hover History Popover. Name не дублируем: в новой full-width
          карточке оно уже видно полностью. */}
      {historyPopover.isVisible && historyPopover.hoveredItem && (() => {
        const entry = history.find(h => h.id === historyPopover.hoveredItem!.id);
        if (!entry) return null;
        const metaRows = [
          { label: 'Closed', value: formatTimestamp(entry.closed_at) },
          { label: 'Created', value: formatTimestamp(entry.created_at) },
          { label: 'Path', value: entry.cwd },
          ...(entry.command_type ? [{ label: 'Type', value: entry.command_type }] : []),
          ...(entry.message_count != null ? [{ label: 'Messages', value: entry.message_count }] : []),
        ];
        return (
          <TabPreviewPopover
            rect={historyPopover.hoveredItem!.rect}
            popoverProps={historyPopover.popoverProps}
            metaRows={metaRows}
            notes={entry.notes}
            split
            pointerThrough
            isLocked={historyPopover.isLocked}
            source="home-history"
          />
        );
      })()}

    </div>
  );
}
