import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { Terminal, FolderOpen, Plus, Clock, Trash2, Pencil, Star, ChevronDown, ChevronRight } from 'lucide-react';
import SemanticSearchSection from './SemanticSearch';

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
  message_count: number | null;
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
  created_at: number;
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
  'Older': 'Старее',
};

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
};

export default function ProjectHome({ projectId }: ProjectHomeProps) {
  const { openProjects, switchTab, createTab, closeTab, setProjectView } = useWorkspaceStore();
  const { projects, updateProject } = useProjectsStore();
  const { showToast } = useUIStore();
  // tabNotes* font / padding теперь читаются внутри TabPreviewPopover.
  const [syncName, setSyncName] = useState<string | null>(null);
  const [history, setHistory] = useState<TabHistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
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
  const activePopover = useCmdHoverPopover<string>(isCmdPressed);
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

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];
  const tabs = workspace ? Array.from(workspace.tabs.values()) : [];

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
    });
  };

  // Subscribe to OSC 133 process status — green/red dot on Active cards.
  // Initial sync on mount + on tabs.length change (covers create/close).
  // Same event names as TabBar — single source of truth in main process.
  useEffect(() => {
    if (!workspace) return;
    const tabIds = Array.from(workspace.tabs.keys());

    Promise.all(
      tabIds.map(async (tabId) => {
        try {
          const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
          return [tabId, !!state?.isRunning] as [string, boolean];
        } catch {
          return [tabId, false] as [string, boolean];
        }
      })
    ).then((pairs) => {
      setProcessStatus(new Map(pairs));
    });

    const handleStarted = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
    };
    const handleFinished = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
    };
    ipcRenderer.on('terminal:command-started', handleStarted);
    ipcRenderer.on('terminal:command-finished', handleFinished);
    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleFinished);
    };
  }, [projectId, tabs.length]);

  // Fetch history + favorites in parallel. We gate the entire content (lists +
  // SemanticSearch) on Promise.all so the user doesn't see Search appear before
  // history finishes loading — IPC for large tab_history can take 200-500ms.
  // Skeleton placeholder fills the same vertical real-estate, so when content
  // arrives the layout doesn't jump.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    Promise.all([
      ipcRenderer.invoke('project:get-tab-history', { projectId }) as Promise<TabHistoryEntry[]>,
      ipcRenderer.invoke('project:get-favorites', { projectId }) as Promise<FavoriteEntry[]>,
    ]).then(([h, f]) => {
      if (cancelled) return;
      setHistory(h || []);
      setFavorites(f || []);
      setIsLoaded(true);
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

  if (!workspace || !project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        Project not found
      </div>
    );
  }

  const handleTabClick = (tabId: string) => {
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
    <div className="h-full bg-bg-main p-6 overflow-y-auto overflow-x-hidden" style={{ position: 'relative' }}>
      {/* Project Header */}
      <div className="mb-6">
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

      {/* Skeleton — gates the lists+search while initial IPC is in-flight.
          Same vertical footprint as final content so layout doesn't jump. */}
      {!isLoaded && (
        <div className="flex gap-6">
          <div className="flex-1 space-y-3">
            <div className="h-4 w-40 bg-white/5 rounded animate-pulse" />
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[40px] w-[120px] bg-white/[0.03] rounded animate-pulse" />
              ))}
            </div>
            <div className="h-4 w-32 bg-white/5 rounded animate-pulse mt-6" />
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[36px] w-[110px] bg-white/[0.03] rounded animate-pulse" />
              ))}
            </div>
          </div>
          <div className="w-px bg-[#2a2a2a]" />
          <div style={{ width: rightColWidth, flexShrink: 0 }} className="space-y-3">
            <div className="h-4 w-28 bg-white/5 rounded animate-pulse" />
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-[40px] w-[120px] bg-white/[0.03] rounded animate-pulse" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Two-column layout: LEFT = closed-tab history + (below) semantic search;
          RIGHT = Active tabs + Favorites. Divider is a real 1px column between them.
          Right column is fixed width so it doesn't collapse on narrow viewports —
          history (left) takes the rest. */}
      {isLoaded && (
      <div className="flex gap-6">

        {/* LEFT — closed tabs history */}
        <div className="flex-1 min-w-0">
          {history.length === 0 ? (
            <div className="text-[#555] text-xs">Нет закрытых вкладок в истории.</div>
          ) : (
            <>
              {Array.from(groupByTime(history).entries()).map(([group, entries]) => {
                const alwaysOpen = group === 'Recent' || group === 'This Week';
                const isCollapsed = !alwaysOpen && collapsedGroups.has(group);
                const label = TIME_GROUP_LABEL[group];

                return (
                  <div key={group} className="mb-6">
                    <div className="flex items-center justify-between mb-3">
                      {alwaysOpen ? (
                        <div className="flex items-center gap-2">
                          <Clock size={14} className="text-[#888]" />
                          <h2 className="text-sm text-[#888]">{label} ({entries.length})</h2>
                        </div>
                      ) : (
                        <div
                          className="flex items-center gap-2 cursor-pointer"
                          style={{ display: 'inline-flex' }}
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev);
                            if (next.has(group)) next.delete(group); else next.add(group);
                            return next;
                          })}
                        >
                          {isCollapsed ? <ChevronRight size={14} className="text-[#888]" /> : <ChevronDown size={14} className="text-[#888]" />}
                          <Clock size={14} className="text-[#888]" />
                          <h2 className="text-sm text-[#888]">{label} ({entries.length})</h2>
                        </div>
                      )}
                      {!alwaysOpen && (
                        <div
                          className="flex items-center gap-2"
                          onMouseEnter={() => setShowKeepNotes(true)}
                          onMouseLeave={() => setShowKeepNotes(false)}
                        >
                          {showKeepNotes && history.some(h => h.notes) && (
                            <button
                              onClick={handleClearExceptNotes}
                              className="flex items-center gap-1 text-[11px] text-[#DA7756] hover:text-[#e89070] cursor-pointer transition-all"
                            >
                              Keep with notes
                            </button>
                          )}
                          <button
                            onClick={() => handleClearHistory()}
                            className="flex items-center gap-1 text-[11px] text-[#666] hover:text-[#999] cursor-pointer transition-colors"
                          >
                            <Trash2 size={12} />
                            Clear
                          </button>
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        maxHeight: isCollapsed ? '0' : 'none',
                        opacity: isCollapsed ? 0 : 1,
                        overflow: 'hidden',
                        transition: 'max-height 0.2s ease, opacity 0.15s ease',
                      }}
                    >
                      <div className="flex flex-wrap gap-2">
                        {entries.map((entry) => {
                          const color = (entry.color || 'default') as TabColor;
                          const colorConfig = TAB_COLORS[color];

                          return (
                            <div
                              key={entry.id}
                              className="relative"
                              {...historyPopover.triggerProps(entry.id)}
                              onContextMenu={(e) => handleCardContextMenu(e, 'history', entry.id)}
                            >
                              <div
                                className="transition-all duration-150 cursor-pointer hover:opacity-70"
                                onClick={() => restoreTab(entry)}
                                onAuxClick={(e) => {
                                  if (e.button === 1) {
                                    e.preventDefault();
                                    restoreTabBackground(entry);
                                  }
                                }}
                                style={{
                                  width: CARD_W,
                                  padding: '6px 10px',
                                  backgroundColor: colorConfig.bgColor,
                                  borderRadius: '5px',
                                  borderLeft: `2px solid ${colorConfig.borderColor}`,
                                  opacity: 0.5,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '1px',
                                }}
                              >
                                <span className="text-[12px] text-white truncate block">
                                  {entry.name}
                                </span>
                                {/* Second row is the closed-at stamp, not the
                                    CWD: brighter (#aaa vs #666), and useful for
                                    disambiguating same-named tabs ("claude-03"
                                    closed twice). CWD still surfaces in the
                                    Cmd+hover popover.

                                    Negative horizontal margin (-3px each side)
                                    pulls the stamp slightly past the card's
                                    own padding so the date and time both fit
                                    inside the 100px card; the bar between them
                                    uses tight 2px margins so it doesn't waste
                                    width on word-spaces. */}
                                {(() => {
                                  const { date, time } = formatShortStamp(entry.closed_at);
                                  return (
                                    <span
                                      className="text-[9px] text-[#aaa] truncate block font-mono"
                                      style={{ marginLeft: -3, marginRight: -3 }}
                                    >
                                      {date}
                                      <span style={{ color: '#555', margin: '0 2px' }}>|</span>
                                      {time}
                                    </span>
                                  );
                                })()}
                              </div>

                              {/* CMD indicator: notes exist */}
                              {isCmdPressed && entry.notes && (
                                <span
                                  style={{
                                    position: 'absolute',
                                    top: '6px',
                                    right: '6px',
                                    width: '5px',
                                    height: '5px',
                                    borderRadius: '50%',
                                    backgroundColor: '#DA7756',
                                    zIndex: 10,
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Resizable divider — 5px hit area, 1px visual line. Wider hit area
            means user doesn't need pixel-precise aim. cursor:col-resize on the
            strip makes the affordance discoverable; hover-tint reinforces it. */}
        <div
          onPointerDown={handleDividerPointerDown}
          className="self-stretch flex-shrink-0 relative group"
          style={{
            width: 5,
            cursor: 'col-resize',
            // Negative margin pulls neighbours together so the visual gap stays
            // tight while the hit area extends ±2px around the visual line.
            marginLeft: -2,
            marginRight: -2,
          }}
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-[#2a2a2a] group-hover:bg-[#4a4a4a] transition-colors" />
        </div>

        {/* RIGHT — Active + Favorites */}
        <div style={{ width: rightColWidth, flexShrink: 0 }}>
          {/* Active Tabs */}
          <div className="mb-6">
            <h2 className="text-sm text-[#888] mb-3">Active Tabs ({tabs.length})</h2>
            <div className="flex flex-wrap gap-3 w-full">
          {tabs.map((tab) => {
            const colorConfig = TAB_COLORS[tab.color || 'default'];
            const isActive = workspace.activeTabId === tab.id;
            const isRunning = processStatus.get(tab.id) || false;

            return (
              <div
                key={tab.id}
                {...activePopover.triggerProps(tab.id)}
                onContextMenu={(e) => handleCardContextMenu(e, 'active-tab', tab.id)}
              >
                <button
                  onClick={() => handleTabClick(tab.id)}
                  className="group cursor-pointer transition-all duration-150"
                  style={{
                    position: 'relative',
                    width: ACTIVE_CARD_W,
                    padding: '6px 10px',
                    backgroundColor: colorConfig.bgColor,
                    border: `1px solid ${isActive ? colorConfig.borderColor : 'transparent'}`,
                    borderRadius: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = colorConfig.borderColor;
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.borderColor = 'transparent';
                    }
                  }}
                >
                  {isCmdPressed && tab.notes && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: '#DA7756',
                        zIndex: 10,
                      }}
                    />
                  )}
                  <Terminal size={12} className="text-[#888] flex-shrink-0" />
                  <span
                    className="text-sm text-white truncate flex-1 min-w-0 text-left"
                  >
                    {tab.name}
                  </span>
                  {isRunning && (
                    <span
                      style={{
                        flexShrink: 0,
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        backgroundColor: '#4ade80',
                        boxShadow: '0 0 4px rgba(74, 222, 128, 0.5)',
                      }}
                    />
                  )}
                </button>
              </div>
            );
          })}

          {/* New Tab Button — same dimensions as active cards for grid uniformity */}
          <button
            onClick={handleCreateTab}
            className="cursor-pointer transition-all duration-150 hover:border-[#666]"
            style={{
              width: ACTIVE_CARD_W,
              padding: '6px 10px',
              backgroundColor: 'transparent',
              border: '1px dashed #444',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <Plus size={14} className="text-[#666]" />
            <span className="text-[12px] text-[#666]">New Tab</span>
          </button>
        </div>
      </div>

      {/* Favorites Section — same right column; Favorites entries are allowed
          to also appear in the history list (no dedup). */}
      {favorites.length > 0 && (
        <div className="mb-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <Star size={14} className="text-[#b8860b]" />
            <h2 className="text-sm text-[#888]">Favorites ({favorites.length})</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {favorites.map((entry) => {
              const color = (entry.color || 'default') as TabColor;
              const colorConfig = TAB_COLORS[color];

              return (
                <div
                  key={entry.id}
                  className="transition-all duration-150 cursor-pointer"
                  onClick={() => restoreFromFavorite(entry)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      deleteFavorite(entry.id);
                    }
                  }}
                  onContextMenu={(e) => handleCardContextMenu(e, 'favorite', entry.id)}
                  style={{
                    width: CARD_W,
                    padding: '6px 10px',
                    backgroundColor: colorConfig.bgColor,
                    borderRadius: '5px',
                    borderLeft: `2px solid ${colorConfig.borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.opacity = '0.7';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.opacity = '1';
                  }}
                >
                  <span className="text-[12px] text-white truncate block">
                    {entry.name || 'tab'}
                  </span>
                  {/* Second row = added-to-favorites timestamp, mirrors the
                      Recent group's card format (DD.MM.YY | HH:MM) verbatim.
                      Same color/size/margins so the two grids read as one
                      visual system. CWD still surfaces in Cmd+hover popover. */}
                  {(() => {
                    const { date, time } = formatShortStamp(entry.created_at);
                    return (
                      <span
                        className="text-[9px] text-[#aaa] truncate block font-mono"
                        style={{ marginLeft: -3, marginRight: -3 }}
                      >
                        {date}
                        <span style={{ color: '#555', margin: '0 2px' }}>|</span>
                        {time}
                      </span>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}
        </div>
      </div>
      )}

      {/* Semantic Search — full width below both columns, gated by isLoaded. */}
      {isLoaded && <SemanticSearchSection projectPath={project?.path || ''} />}

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

      {/* CMD+Hover Active Tab Popover. Уникальное окно с unified shape
          (name → metadata → notes). Тот же компонент используется в TabBar и
          в History-карточках ниже. Metadata теперь живёт ПОД именем и НАД
          заметками, потому что заметки могут быть переменной длины и должны
          получать всю остающуюся высоту — техническая инфа сессии сверху. */}
      {activePopover.isVisible && activePopover.hoveredItem && (() => {
        const tab = tabs.find(t => t.id === activePopover.hoveredItem!.id);
        if (!tab) return null;
        const metaRows = [
          { label: 'Path', value: tab.cwd },
          ...(tab.commandType ? [{ label: 'Type', value: tab.commandType }] : []),
        ];
        return (
          <TabPreviewPopover
            rect={activePopover.hoveredItem!.rect}
            popoverProps={activePopover.popoverProps}
            metaRows={metaRows}
            notes={tab.notes}
            split
            disableResize
            pointerThrough
            isLocked={activePopover.isLocked}
          />
        );
      })()}

      {/* CMD+Hover History Popover. Та же компонента — отличается набором
          metaRows (Closed/Created/Path/Type/Messages). */}
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
            disableResize
            pointerThrough
            isLocked={historyPopover.isLocked}
          />
        );
      })()}

    </div>
  );
}
