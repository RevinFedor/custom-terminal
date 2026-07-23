import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, startTransition } from 'react';
import { useWorkspaceStore, TabColor, TabType, PendingAction } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import ControlHint from '../UI/ControlHint';
// Fixed card widths so the wrap-grid stays uniform regardless of name length.
// Without this, short labels (`tab-1`) sit next to long labels (`worker-search`)
// and the column gutters drift — visually ragged. Cards use uniform width and
// truncate long names; Tooltip surfaces the full name on hover.
// Width dropped from 140 → 100px (~28%): user feedback "вкладки можно поменьше".
const CARD_W = 100;        // History + Favorites
const ACTIVE_CARD_W = 100; // Active row — same width for visual consistency

// Left history-column width is drag-resizable. Persisted GLOBALLY across machines via
// the localStorage ↔ SQLite mirror (see utils/persistedStorage.ts). The mirror
// only fires for keys with prefix `noted-terminal-` или `sidebarWidth`, поэтому
// ключ префиксуется `noted-terminal-`. Старый pre-split key ignored: the new
// layout stores the left column, not the removed right card rail.
const RIGHT_COL_STORAGE_KEY = 'noted-terminal-project-home-list-col-width';
const RIGHT_COL_DEFAULT = 420;
const RIGHT_COL_MIN = 300;
const RIGHT_COL_MAX = 620;
const ITERATION_RANGE_LOADER_MIN_MS = 350;
const loadRightColWidth = (): number => {
  try {
    let raw = localStorage.getItem(RIGHT_COL_STORAGE_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return RIGHT_COL_DEFAULT;
    return Math.max(RIGHT_COL_MIN, Math.min(RIGHT_COL_MAX, n));
  } catch { return RIGHT_COL_DEFAULT; }
};
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import TabPreviewPopover from './TabPreviewPopover';
import HistoryPanel from './HistoryPanel';
import Timeline from './Timeline';
import { Virtuoso } from 'react-virtuoso';
import { FolderOpen, Clock, Trash2, Pencil, Search, Database, Loader2, RotateCw, X, Check, ChevronDown } from 'lucide-react';
import {
  generateTabTitleFromSession,
  refreshGeneratedTabTitle,
  type RefreshTabTitleReason,
} from '../../utils/generateTabTitle';
import { INBOX_PROJECT_NAME, isInboxProjectId } from '../../constants/systemProjects';

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
  name_set_manually?: number | null;
  cwd: string;
  color: string | null;
  notes: string | null;
  task_plan?: string | null;
  command_type: string | null;
  tab_type: string;
  url: string | null;
  file_path?: string | null;
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

interface TabIterationIndexStats extends TabTitleIndexStats {
  discovered: number;
}

type IterationSearchResult = ScoredTabHistoryEntry & {
  toolType: 'claude' | 'codex';
  sessionId: string;
  entryUuid: string;
  iterationIndex: number;
  summary?: string | null;
  content: string;
};

type PreviewToolType = 'claude' | 'gemini' | 'codex';
type IterationToolFilter = 'all' | 'codex' | 'claude';

type PersistedHomeState = {
  version: 1;
  historyQuery?: string;
  iterationQuery?: string;
  iterationResults?: IterationSearchResult[];
  iterationToolFilter?: IterationToolFilter;
};

type PreviewSelection = {
  entry: TabHistoryEntry;
  targetUuid?: string | null;
  source: 'history' | 'iteration';
} | null;

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

function formatDateInput(unix: number): string {
  const date = new Date(unix * 1000);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function todayDateInput(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysAgoDateInput(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function tabTitleRefreshErrorText(reason?: RefreshTabTitleReason, error?: string): string {
  switch (reason) {
    case 'unsupported-tab':
      return 'Обновление названия доступно для Claude/Codex';
    case 'no-session':
      return 'У сессии нет ID';
    case 'no-user-prompt':
      return 'Не найдено пользовательское сообщение';
    case 'generation-failed':
      return 'Gemini не вернул название';
    case 'timeline-error':
      return error || 'Не удалось прочитать Timeline';
    case 'rename-skipped':
      return 'Название не изменилось';
    case 'tab-not-found':
      return 'Вкладка не найдена';
    case 'manual-name':
      return 'Название задано вручную';
    default:
      return 'Не удалось обновить название';
  }
}

function getHistoryTitleTarget(entry: TabHistoryEntry): { toolType: 'claude' | 'codex'; sessionId: string } | null {
  if (entry.command_type === 'codex' && entry.codex_session_id) {
    return { toolType: 'codex', sessionId: entry.codex_session_id };
  }
  if (entry.command_type === 'claude' && entry.claude_session_id) {
    return { toolType: 'claude', sessionId: entry.claude_session_id };
  }
  if (entry.codex_session_id) {
    return { toolType: 'codex', sessionId: entry.codex_session_id };
  }
  if (entry.claude_session_id) {
    return { toolType: 'claude', sessionId: entry.claude_session_id };
  }
  return null;
}

function getHistoryPreviewTarget(entry: TabHistoryEntry): { toolType: PreviewToolType; sessionId: string } | null {
  if (entry.command_type === 'codex' && entry.codex_session_id) {
    return { toolType: 'codex', sessionId: entry.codex_session_id };
  }
  if (entry.command_type === 'gemini' && entry.gemini_session_id) {
    return { toolType: 'gemini', sessionId: entry.gemini_session_id };
  }
  if (entry.command_type === 'claude' && entry.claude_session_id) {
    return { toolType: 'claude', sessionId: entry.claude_session_id };
  }
  if (entry.codex_session_id) return { toolType: 'codex', sessionId: entry.codex_session_id };
  if (entry.gemini_session_id) return { toolType: 'gemini', sessionId: entry.gemini_session_id };
  if (entry.claude_session_id) return { toolType: 'claude', sessionId: entry.claude_session_id };
  return null;
}

function makeHomePreviewTabId(projectId: string, historyId: number): string {
  return `home-preview:${projectId}:${historyId}`;
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

function withAlpha(color: string, alpha: number): string {
  const rgba = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${alpha})`;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

function selectedCardBg(colorConfig: { bgColor: string; borderColor: string }): string {
  const isDefault = colorConfig.borderColor === '#666';
  return withAlpha(isDefault ? colorConfig.borderColor : colorConfig.bgColor, isDefault ? 0.14 : 0.34);
}

function hoverCardBg(colorConfig: { bgColor: string; borderColor: string }): string {
  const isDefault = colorConfig.borderColor === '#666';
  return withAlpha(isDefault ? colorConfig.borderColor : colorConfig.bgColor, isDefault ? 0.18 : 0.42);
}

function makeIterationHoverKey(entry: IterationSearchResult): string {
  return `${entry.id}:${entry.entryUuid}`;
}

function homeStateStorageKey(projectId: string): string {
  return `noted-terminal-project-home-state:${projectId}`;
}

function isIterationToolFilter(value: unknown): value is IterationToolFilter {
  return value === 'all' || value === 'codex' || value === 'claude';
}

function loadPersistedHomeState(projectId: string): PersistedHomeState {
  try {
    const raw = localStorage.getItem(homeStateStorageKey(projectId));
    if (!raw) return { version: 1 };
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      historyQuery: typeof parsed?.historyQuery === 'string' ? parsed.historyQuery : '',
      iterationQuery: typeof parsed?.iterationQuery === 'string' ? parsed.iterationQuery : '',
      iterationResults: Array.isArray(parsed?.iterationResults) ? parsed.iterationResults.slice(0, 120) : [],
      iterationToolFilter: isIterationToolFilter(parsed?.iterationToolFilter) ? parsed.iterationToolFilter : 'all',
    };
  } catch {
    return { version: 1 };
  }
}

function savePersistedHomeState(projectId: string, state: PersistedHomeState): void {
  try {
    localStorage.setItem(homeStateStorageKey(projectId), JSON.stringify({
      version: 1,
      historyQuery: state.historyQuery || '',
      iterationQuery: state.iterationQuery || '',
      iterationResults: Array.isArray(state.iterationResults) ? state.iterationResults.slice(0, 120) : [],
      iterationToolFilter: state.iterationToolFilter || 'all',
    }));
  } catch {}
}

export default function ProjectHome({ projectId }: ProjectHomeProps) {
  const renderStartedAt = performance.now();
  const isSystemProject = isInboxProjectId(projectId);
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const restoreTabHistoryEntry = useWorkspaceStore((state) => state.restoreTabHistoryEntry);
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
      tab.taskPlan?.revision ?? 0,
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
  const setHistoryPanelOpen = useUIStore((state) => state.setHistoryPanelOpen);
  const setHistoryScrollToUuid = useUIStore((state) => state.setHistoryScrollToUuid);
  const tabTitleNamingIds = useWorkspaceStore((state) => state.tabTitleNamingIds);
  const setTabTitleNaming = useWorkspaceStore((state) => state.setTabTitleNaming);
  // Status-marker palette + shape/size. Granular selectors — re-rendered только когда
  // юзер правит палитру в SettingsModal, не на каждый closed-tab card flip.
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);
  const [syncName, setSyncName] = useState<string | null>(null);
  const [history, setHistory] = useState<TabHistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [iterationQuery, setIterationQuery] = useState('');
  const [iterationResults, setIterationResults] = useState<IterationSearchResult[]>([]);
  const [iterationToolFilter, setIterationToolFilter] = useState<IterationToolFilter>('all');
  const [iterationSearching, setIterationSearching] = useState(false);
  const [titleSearchError, setTitleSearchError] = useState<string | null>(null);
  const [iterationSearchError, setIterationSearchError] = useState<string | null>(null);
  const [titleIndexStats, setTitleIndexStats] = useState<TabTitleIndexStats | null>(null);
  const [iterationIndexStats, setIterationIndexStats] = useState<TabIterationIndexStats | null>(null);
  const [titleIndexing, setTitleIndexing] = useState(false);
  const [iterationIndexing, setIterationIndexing] = useState(false);
  const [titleRefreshInFlight, setTitleRefreshInFlight] = useState<Set<string>>(new Set());
  const [titleIndexProgress, setTitleIndexProgress] = useState<{ current: number; total: number } | null>(null);
  const [iterationIndexProgress, setIterationIndexProgress] = useState<{ current: number; total: number } | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<PreviewSelection>(null);
  const [iterationRangeOpen, setIterationRangeOpen] = useState(false);
  const [iterationDateFrom, setIterationDateFrom] = useState('');
  const [iterationDateDraft, setIterationDateDraft] = useState('');
  const [iterationDateApplying, setIterationDateApplying] = useState(false);
  const [previewScrollPending, setPreviewScrollPending] = useState<{ tabId: string; uuid: string } | null>(null);
  const [visibleRange, setVisibleRange] = useState<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 0 });
  const historyLoadProjectRef = useRef<string | null>(null);
  const homeStateReadyRef = useRef(false);
  const restoreInFlightRef = useRef<Set<number>>(new Set());
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
  // Left history-column width — drag the vertical divider to resize. Wider =
  // more room for titles; narrower = more room for the preview.
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
      const delta = ev.clientX - st.startX;
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

  useEffect(() => {
    homeStateReadyRef.current = false;
    const saved = loadPersistedHomeState(projectId);
    setHistoryQuery(saved.historyQuery || '');
    setIterationQuery(saved.iterationQuery || '');
    setIterationResults(saved.iterationResults || []);
    setIterationToolFilter(saved.iterationToolFilter || 'all');
    setSelectedPreview(null);
    setPreviewScrollPending(null);
    const key = `noted-terminal-project-home-iteration-date-from:${projectId}`;
    let stored = '';
    try { stored = localStorage.getItem(key) || ''; } catch {}
    setIterationDateFrom(stored);
    setIterationDateDraft(stored);
    setIterationRangeOpen(false);
    const frame = window.requestAnimationFrame(() => {
      homeStateReadyRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [projectId]);

  useEffect(() => {
    if (!homeStateReadyRef.current) return;
    savePersistedHomeState(projectId, {
      version: 1,
      historyQuery,
      iterationQuery,
      iterationResults,
      iterationToolFilter,
    });
  }, [historyQuery, iterationQuery, iterationResults, iterationToolFilter, projectId]);

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
  const iterationPopover = useCmdHoverPopover<string>(isCmdPressed, 180);

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
    const handleMessageCountUpdated = (_event: any, payload: { id?: number; message_count?: number }) => {
      const id = Number(payload?.id);
      const messageCount = Number(payload?.message_count);
      if (!Number.isFinite(id) || !Number.isFinite(messageCount)) return;
      setHistory(prev => prev.map(entry => (
        entry.id === id ? { ...entry, message_count: messageCount } : entry
      )));
    };
    ipcRenderer.on('tab-history:message-count-updated', handleMessageCountUpdated);
    return () => {
      ipcRenderer.removeListener('tab-history:message-count-updated', handleMessageCountUpdated);
    };
  }, []);

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

  // Restore a closed tab from history. Foreground restore switches away from Home
  // only after successful PTY creation; otherwise a missing cwd would make Home
  // disappear even though no tab opened.
  const restoreTab = async (entry: TabHistoryEntry, mode: 'foreground' | 'background' = 'foreground') => {
    if (restoreInFlightRef.current.has(entry.id)) {
      console.warn('[ProjectHome:Restore] duplicate-skip historyId=' + entry.id + ' mode=' + mode);
      return;
    }
    restoreInFlightRef.current.add(entry.id);
    const started = performance.now();
    const background = mode === 'background';
    const sessionId = entry.claude_session_id || entry.gemini_session_id || entry.codex_session_id || '';
    console.warn(
      '[ProjectHome:Restore] start' +
      ' mode=' + mode +
      ' project=' + projectId.slice(-12) +
      ' historyId=' + entry.id +
      ' name=' + JSON.stringify(entry.name || '') +
      ' cwd=' + (entry.cwd || 'unset') +
      ' cmd=' + (entry.command_type || 'none') +
      ' sid=' + (sessionId ? sessionId.slice(0, 8) : 'none')
    );

    try {
      const result = await restoreTabHistoryEntry(projectId, entry.id, {
        background,
        restorePosition: false,
        resumePolicy: 'always',
      });
      if (!result.tabId) {
        const kind = result.reason === 'busy' || result.reason === 'cancelled' ? 'info' : 'error';
        showToast(result.message || 'Не удалось восстановить вкладку', kind, 4500);
        return;
      }

      if (!result.historyDeleteFailed) {
        setHistory(prev => prev.filter(h => h.id !== entry.id));
        setSelectedPreview(prev => (prev?.entry.id === entry.id ? null : prev));
      } else {
        showToast(result.message || 'Вкладка открыта, но запись истории сохранена', 'warning', 6500);
      }
      if (result.fallbackFrom) {
        showToast(`Оригинальная папка удалена. Открыто в ${result.cwd}`, 'warning', 6500, false, result.fallbackFrom);
      }
      console.warn(
        '[ProjectHome:Restore] success' +
        ' mode=' + mode +
        ' project=' + projectId.slice(-12) +
        ' historyId=' + entry.id +
        ' tab=' + String(result.tabId).slice(-12) +
        (result.fallbackFrom ? ' cwdFallback=' + result.fallbackFrom + '->' + result.cwd : '') +
        (result.historyDeleteFailed ? ' historyRetained=1' : '') +
        ' durMs=' + (performance.now() - started).toFixed(1)
      );
    } catch (err: any) {
      console.error(
        '[ProjectHome:Restore] failed' +
        ' mode=' + mode +
        ' project=' + projectId.slice(-12) +
        ' historyId=' + entry.id +
        ' name=' + JSON.stringify(entry.name || '') +
        ' cwd=' + (entry.cwd || 'unset') +
        ' durMs=' + (performance.now() - started).toFixed(1),
        err?.stack || err?.message || err
      );
      showToast('Не удалось восстановить вкладку', 'error', 4500);
    } finally {
      restoreInFlightRef.current.delete(entry.id);
    }
  };

  // Restore a history tab in the background (middle-click) — no view switch, no activation
  const restoreTabBackground = async (entry: TabHistoryEntry) => {
    await restoreTab(entry, 'background');
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

  const displayName = syncName || project?.name || (isSystemProject ? INBOX_PROJECT_NAME : '');

  const handleCreateTab = async () => {
    if (project) {
      await createTab(projectId, undefined, project.path);
      setProjectView(projectId, 'terminal');
    }
  };

  const handleClearHistory = async () => {
    await ipcRenderer.invoke('project:clear-tab-history', { projectId });
    setHistory([]);
    setSelectedPreview(null);
  };

  const handleChangeDirectory = async () => {
    if (isSystemProject) return;
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
    setSelectedPreview(prev => (prev?.entry.id === id ? null : prev));
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

  const refreshIterationIndexStats = useCallback(async () => {
    try {
      const res = await ipcRenderer.invoke('tab-iteration-index:stats', {
        projectId,
        dateFrom: iterationDateFrom || null,
      });
      if (res?.success) {
        setIterationIndexStats(res.data);
        setIterationIndexing(!!res.data?.inProgress);
      }
    } catch (err: any) {
      setIterationSearchError(err?.message || 'Failed to load iteration index stats');
    }
  }, [iterationDateFrom, projectId]);

  const setTitleRefreshKey = useCallback((key: string, active: boolean) => {
    setTitleRefreshInFlight(prev => {
      const has = prev.has(key);
      if (has === active) return prev;
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const handleRefreshActiveTabTitle = useCallback(async (tabId: string) => {
    const key = `tab:${tabId}`;
    if (titleRefreshInFlight.has(key) || tabTitleNamingIds.has(tabId)) {
      showToast('Название уже обновляется', 'info');
      return;
    }

    setTitleRefreshKey(key, true);
    setTabTitleNaming(tabId, true);

    try {
      const result = await refreshGeneratedTabTitle(tabId, {
        overrideManualName: true,
        markNameSetManually: true,
      });
      if (result.ok) {
        showToast(`Название обновлено: ${result.title}`, 'success');
      } else {
        showToast(tabTitleRefreshErrorText(result.reason, result.error), result.reason === 'rename-skipped' ? 'info' : 'warning');
      }
    } catch (err: any) {
      console.warn('[ProjectHome:RefreshTabTitle] failed tab=' + tabId.slice(-8) + ': ' + (err?.message || String(err)));
      showToast('Не удалось обновить название', 'error');
    } finally {
      setTitleRefreshKey(key, false);
      setTabTitleNaming(tabId, false);
      setHomeContextMenu(null);
    }
  }, [setTabTitleNaming, setTitleRefreshKey, showToast, tabTitleNamingIds, titleRefreshInFlight]);

  const handleRefreshHistoryTitle = useCallback(async (entry: TabHistoryEntry) => {
    const target = getHistoryTitleTarget(entry);
    if (!target) {
      showToast('Обновление названия доступно для Claude/Codex', 'warning');
      setHomeContextMenu(null);
      return;
    }

    const key = `history:${entry.id}`;
    if (titleRefreshInFlight.has(key)) {
      showToast('Название уже обновляется', 'info');
      return;
    }

    setTitleRefreshKey(key, true);

    try {
      const result = await generateTabTitleFromSession({
        toolType: target.toolType,
        sessionId: target.sessionId,
        cwd: entry.cwd,
        source: 'ProjectHome.refreshHistoryTitle',
        reason: 'history-context-menu',
      });
      if (!result.ok || !result.title) {
        showToast(tabTitleRefreshErrorText(result.reason, result.error), result.reason === 'rename-skipped' ? 'info' : 'warning');
        return;
      }

      const update = await ipcRenderer.invoke('project:update-tab-history-title', {
        id: entry.id,
        name: result.title,
        nameSetManually: true,
      });
      if (!update?.success) {
        showToast('Не удалось сохранить название', 'error');
        return;
      }

      setHistory(prev => prev.map(item => (
        item.id === entry.id ? { ...item, name: result.title! } : item
      )));
      setIterationResults(prev => prev.map(item => (
        item.id === entry.id ? { ...item, name: result.title! } : item
      )));
      refreshTitleIndexStats();
      showToast(`Название обновлено: ${result.title}`, 'success');
    } catch (err: any) {
      console.warn('[ProjectHome:RefreshHistoryTitle] failed historyId=' + entry.id + ': ' + (err?.message || String(err)));
      showToast('Не удалось обновить название', 'error');
    } finally {
      setTitleRefreshKey(key, false);
      setHomeContextMenu(null);
    }
  }, [refreshTitleIndexStats, setTitleRefreshKey, showToast, titleRefreshInFlight]);

  useEffect(() => {
    if (!isLoaded) return;
    refreshTitleIndexStats();
    refreshIterationIndexStats();
  }, [isLoaded, history.length, refreshIterationIndexStats, refreshTitleIndexStats]);

  useEffect(() => {
    const handler = (_: any, data: any) => {
      if (data?.projectId !== projectId) return;
      setTitleIndexProgress({ current: data.current || 0, total: data.total || 0 });
    };
    ipcRenderer.on('tab-title-index:progress', handler);
    return () => { ipcRenderer.removeListener('tab-title-index:progress', handler); };
  }, [projectId]);

  useEffect(() => {
    const handler = (_: any, data: any) => {
      if (data?.projectId !== projectId) return;
      refreshTitleIndexStats();
    };
    ipcRenderer.on('tab-title-index:changed', handler);
    return () => { ipcRenderer.removeListener('tab-title-index:changed', handler); };
  }, [projectId, refreshTitleIndexStats]);

  useEffect(() => {
    const handler = (_: any, data: any) => {
      if (data?.projectId !== projectId) return;
      setIterationIndexProgress({ current: data.current || 0, total: data.total || 0 });
    };
    ipcRenderer.on('tab-iteration-index:progress', handler);
    return () => { ipcRenderer.removeListener('tab-iteration-index:progress', handler); };
  }, [projectId]);

  useEffect(() => {
    const handler = (_: any, data: any) => {
      if (data?.projectId !== projectId) return;
      refreshIterationIndexStats();
    };
    ipcRenderer.on('tab-iteration-index:changed', handler);
    return () => { ipcRenderer.removeListener('tab-iteration-index:changed', handler); };
  }, [projectId, refreshIterationIndexStats]);

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

  const handleClearTitleIndex = useCallback(async () => {
    setTitleSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-title-index:clear', { projectId });
      if (res?.success) {
        setTitleIndexStats(res.stats || null);
      } else {
        setTitleSearchError(res?.error || 'Title index clear failed');
      }
    } catch (err: any) {
      setTitleSearchError(err?.message || 'Title index clear failed');
    } finally {
      refreshTitleIndexStats();
    }
  }, [projectId, refreshTitleIndexStats]);

  const handleReindexIterations = useCallback(async () => {
    setIterationIndexing(true);
    setIterationIndexProgress(null);
    setIterationSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-iteration-index:reindex', {
        projectId,
        force: false,
        dateFrom: iterationDateFrom || null,
      });
      if (res?.success) {
        setIterationIndexStats(res.stats || null);
      } else {
        setIterationSearchError(res?.error || 'Iteration indexing failed');
      }
    } catch (err: any) {
      setIterationSearchError(err?.message || 'Iteration indexing failed');
    } finally {
      setIterationIndexing(false);
      setIterationIndexProgress(null);
      refreshIterationIndexStats();
    }
  }, [iterationDateFrom, projectId, refreshIterationIndexStats]);

  const handleClearIterationIndex = useCallback(async () => {
    setIterationSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-iteration-index:clear', { projectId });
      if (res?.success) {
        setIterationIndexStats(res.stats || null);
        setIterationResults([]);
        setIterationQuery('');
      } else {
        setIterationSearchError(res?.error || 'Iteration index clear failed');
      }
    } catch (err: any) {
      setIterationSearchError(err?.message || 'Iteration index clear failed');
    } finally {
      refreshIterationIndexStats();
    }
  }, [projectId, refreshIterationIndexStats]);

  const applyIterationDateRange = useCallback(async (nextDate: string) => {
    const startedAt = performance.now();
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(nextDate) ? nextDate : '';
    setIterationDateApplying(true);
    setIterationSearchError(null);
    setIterationDateFrom(normalized);
    setIterationDateDraft(normalized);
    setIterationResults([]);
    setIterationQuery('');
    try {
      const key = `noted-terminal-project-home-iteration-date-from:${projectId}`;
      if (normalized) localStorage.setItem(key, normalized);
      else localStorage.removeItem(key);
    } catch {}
    await nextAnimationFrame();
    try {
      const res = await ipcRenderer.invoke('tab-iteration-index:stats', {
        projectId,
        dateFrom: normalized || null,
      });
      if (res?.success) {
        setIterationIndexStats(res.data);
        setIterationIndexing(!!res.data?.inProgress);
      } else {
        setIterationSearchError(res?.error || 'Iteration range failed');
      }
    } catch (err: any) {
      setIterationSearchError(err?.message || 'Iteration range failed');
    } finally {
      await nextAnimationFrame();
      const remaining = ITERATION_RANGE_LOADER_MIN_MS - (performance.now() - startedAt);
      if (remaining > 0) await delay(remaining);
      setIterationDateApplying(false);
    }
  }, [projectId]);

  const toggleIterationRange = useCallback(() => {
    if (iterationRangeOpen) {
      setIterationRangeOpen(false);
      void applyIterationDateRange(iterationDateDraft);
    } else {
      setIterationDateDraft(iterationDateFrom);
      setIterationRangeOpen(true);
    }
  }, [applyIterationDateRange, iterationDateDraft, iterationDateFrom, iterationRangeOpen]);

  const titleIndexButtonLabel = useMemo(() => {
    if (!titleIndexing) return 'Index';
    const total = titleIndexProgress?.total ?? titleIndexStats?.unindexed ?? 0;
    const current = titleIndexProgress?.current ?? 0;
    return total > 0 ? `${Math.min(current, total)}/${total}` : 'Indexing';
  }, [titleIndexing, titleIndexProgress, titleIndexStats?.unindexed]);

  const iterationIndexButtonLabel = useMemo(() => {
    if (!iterationIndexing) return 'Index';
    const total = iterationIndexProgress?.total ?? iterationIndexStats?.unindexed ?? 0;
    const current = iterationIndexProgress?.current ?? 0;
    return total > 0 ? `${Math.min(current, total)}/${total}` : 'Indexing';
  }, [iterationIndexing, iterationIndexProgress, iterationIndexStats?.unindexed]);

  const iterationRangeLabel = iterationDateFrom ? `${iterationDateFrom} - today` : 'Full';
  const iterationDateMin = useMemo(() => {
    const rows = history.filter(entry => entry.claude_session_id || entry.codex_session_id);
    if (rows.length === 0) return '';
    return formatDateInput(Math.min(...rows.map(entry => entry.closed_at)));
  }, [history]);
  const iterationDateMax = useMemo(() => todayDateInput(), []);

  const localFilteredHistory = useMemo(() => {
    const q = normalizeSearchText(historyQuery);
    if (!q) return history as ScoredTabHistoryEntry[];
    const tokens = q.split(' ').filter(Boolean);
    return history.filter((entry) => {
      const haystack = normalizeSearchText(entry.name || '');
      return tokens.every((token) => haystack.includes(token));
    });
  }, [history, historyQuery]);

  const iterationModeActive = Boolean(iterationQuery.trim());

  const displayedHistory = localFilteredHistory;
  const displayedIterations = useMemo(() => {
    if (iterationToolFilter === 'all') return iterationResults;
    return iterationResults.filter((entry) => entry.toolType === iterationToolFilter);
  }, [iterationResults, iterationToolFilter]);
  const iterationToolCounts = useMemo(() => {
    let codex = 0;
    let claude = 0;
    for (const entry of iterationResults) {
      if (entry.toolType === 'codex') codex += 1;
      if (entry.toolType === 'claude') claude += 1;
    }
    return { all: iterationResults.length, codex, claude };
  }, [iterationResults]);

  useEffect(() => {
    if (iterationModeActive) historyPopover.close();
    else iterationPopover.close();
  }, [iterationModeActive, historyPopover.close, iterationPopover.close]);

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

  const handleIterationSearch = useCallback(async () => {
    const query = historyQuery.trim();
    if (query.length < 2) return;
    setIterationSearching(true);
    setIterationSearchError(null);
    try {
      const res = await ipcRenderer.invoke('tab-iteration-search:semantic', {
        projectId,
        query,
        maxResults: 120,
        minScore: 0.32,
        dateFrom: iterationDateFrom || null,
      });
      if (res?.success) {
        setIterationQuery(query);
        setIterationResults(res.data || []);
        setVisibleRange({ startIndex: 0, endIndex: 0 });
      } else {
        setIterationSearchError(res?.error || 'Iteration search failed');
      }
    } catch (err: any) {
      setIterationSearchError(err?.message || 'Iteration search failed');
    } finally {
      setIterationSearching(false);
    }
  }, [historyQuery, iterationDateFrom, projectId]);

  const selectPreview = useCallback((entry: TabHistoryEntry, targetUuid?: string | null, source: 'history' | 'iteration' = 'history') => {
    const previewTarget = getHistoryPreviewTarget(entry);
    if (!previewTarget) {
      setSelectedPreview({ entry, targetUuid: null, source });
      setPreviewScrollPending(null);
      return;
    }
    const previewTabId = makeHomePreviewTabId(projectId, entry.id);
    setHistoryPanelOpen(previewTabId, true);
    setSelectedPreview({ entry, targetUuid: targetUuid || null, source });
    if (targetUuid) {
      setPreviewScrollPending({ tabId: previewTabId, uuid: targetUuid });
      requestAnimationFrame(() => setHistoryScrollToUuid(targetUuid));
    } else {
      setPreviewScrollPending(null);
    }
  }, [projectId, setHistoryPanelOpen, setHistoryScrollToUuid]);

  useEffect(() => {
    if (!previewScrollPending) return;
    const startedAt = performance.now();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.tabId !== previewScrollPending.tabId) return;
      if (detail.uuid !== previewScrollPending.uuid) return;
      setPreviewScrollPending(null);
    };
    const timer = window.setTimeout(() => {
      setPreviewScrollPending(prev => {
        if (!prev) return prev;
        if (prev.tabId !== previewScrollPending.tabId || prev.uuid !== previewScrollPending.uuid) return prev;
        console.warn('[ProjectHome:PreviewScroll] timeout tab=' + prev.tabId.slice(-12) +
          ' uuid=' + prev.uuid.slice(0, 8) +
          ' elapsedMs=' + Math.round(performance.now() - startedAt));
        return null;
      });
    }, 8000);
    window.addEventListener('history-panel:scrolled-to', handler);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('history-panel:scrolled-to', handler);
    };
  }, [previewScrollPending]);

  useEffect(() => {
    setSelectedPreview(prev => {
      if (!prev) return prev;
      const updated = history.find(entry => entry.id === prev.entry.id);
      return updated ? { ...prev, entry: updated } : null;
    });
  }, [history]);

  useEffect(() => {
    if (!selectedPreview) return;
    const previewTarget = getHistoryPreviewTarget(selectedPreview.entry);
    if (!previewTarget) return;
    const previewTabId = makeHomePreviewTabId(projectId, selectedPreview.entry.id);
    setHistoryPanelOpen(previewTabId, true);
    if (selectedPreview.targetUuid) {
      requestAnimationFrame(() => setHistoryScrollToUuid(selectedPreview.targetUuid!));
    }
  }, [projectId, selectedPreview, setHistoryPanelOpen, setHistoryScrollToUuid]);

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

  const searchError = iterationSearchError || titleSearchError;
  const previewTarget = selectedPreview ? getHistoryPreviewTarget(selectedPreview.entry) : null;
  const previewTabId = selectedPreview ? makeHomePreviewTabId(projectId, selectedPreview.entry.id) : '';
  const previewDate = selectedPreview ? formatShortStamp(selectedPreview.entry.closed_at) : null;
  const previewScrollLoading = Boolean(
    previewScrollPending &&
    selectedPreview?.targetUuid &&
    previewScrollPending.tabId === previewTabId &&
    previewScrollPending.uuid === selectedPreview.targetUuid,
  );

  return (
    <div className="h-full bg-bg-main p-6 overflow-hidden flex flex-col" style={{ position: 'relative' }}>
      {/* Project Header */}
      <div className="mb-5 w-full flex-shrink-0">
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
              <ControlHint label="Выбрать директорию проекта">
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
              </ControlHint>
            </div>
          </>
        ) : isEditingName && !isSystemProject ? (
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
              <ControlHint label="Изменить директорию проекта">
              <button
                onClick={handleChangeDirectory}
                className="text-[#666] hover:text-[#999] cursor-pointer transition-colors p-0.5"
              >
                <Pencil size={12} />
              </button>
              </ControlHint>
            </div>
          </>
        ) : (
          /* Normal display mode */
          <>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl text-white font-medium">{displayName}</h1>
              {!isSystemProject && (
                <ControlHint label="Переименовать проект">
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
                </ControlHint>
              )}
            </div>
            {!isSystemProject && (
              <div className="flex items-center gap-2 text-[#666] text-sm">
                <FolderOpen size={14} />
                <span>{project.path.startsWith('__unset__') ? 'No path' : project.path}</span>
                <ControlHint label="Изменить директорию проекта">
                <button
                  onClick={handleChangeDirectory}
                  className="text-[#666] hover:text-[#999] cursor-pointer transition-colors p-0.5"
                >
                  <Pencil size={12} />
                </button>
                </ControlHint>
              </div>
            )}
          </>
        )}
      </div>

      {!isLoaded && (
        <div className="flex-1 min-h-0 w-full space-y-3">
          <div className="h-8 w-full bg-white/[0.04] rounded animate-pulse" />
          <div className="h-7 w-64 bg-white/[0.04] rounded animate-pulse" />
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-[34px] w-full bg-white/[0.03] rounded animate-pulse" />
          ))}
        </div>
      )}

      {isLoaded && (
        <div className="flex-1 min-h-0 w-full flex">
          <div
            className="min-w-0 flex-shrink-0 flex flex-col pr-3"
            style={{ width: rightColWidth }}
          >
            <div className="grid grid-cols-2 items-start gap-2 mb-2 flex-shrink-0 pt-2">
              <div className="relative mt-3 rounded border border-[#242424] bg-[#111] p-2 pt-3 min-w-0">
                <div className="absolute -top-[7px] left-2 px-1.5 rounded bg-[#111] text-[10px] leading-none text-[#aaa] font-medium">
                  Title
                </div>
                <div className="absolute -top-[7px] right-2 px-1.5 rounded bg-[#111] text-[10px] leading-none text-[#666] font-mono">
                  {titleIndexStats?.indexed ?? 0}/{titleIndexStats?.total ?? history.length}
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-7 min-w-0 flex-1 px-2 rounded border border-[#2a2a2a] bg-[#0d0d0d] text-[11px] text-[#888] flex items-center gap-1.5">
                    <Database size={12} className={titleIndexStats?.unindexed ? 'text-[#d97706]' : 'text-[#666]'} />
                    <span className="truncate">{titleIndexStats?.unindexed ?? 0} new</span>
                  </div>
                  <button
                    onClick={handleReindexTitles}
                    disabled={titleIndexing || !titleIndexStats?.unindexed}
                    className={`h-7 min-w-[62px] px-2 rounded border text-[11px] flex items-center justify-center gap-1 ${
                      titleIndexing
                        ? 'border-[#3a3a52] bg-[#151528] text-[#d7d7ff] cursor-default'
                        : titleIndexStats?.unindexed
                          ? 'border-[#333] text-[#aaa] hover:text-white hover:border-[#555] cursor-pointer'
                          : 'border-[#333] text-[#aaa] opacity-40 cursor-default'
                    }`}
                  >
                    {titleIndexing ? <Loader2 size={12} className="animate-spin text-[#818cf8]" /> : <Database size={12} />}
                    {titleIndexButtonLabel}
                  </button>
                  <button
                    onClick={handleClearTitleIndex}
                    disabled={!titleIndexStats?.indexed}
                    className="h-7 w-7 rounded border border-[#333] text-[#666] hover:text-[#aaa] hover:border-[#555] disabled:opacity-35 disabled:hover:text-[#666] disabled:hover:border-[#333] cursor-pointer disabled:cursor-default flex items-center justify-center"
                    title="Clear title index"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div className="relative rounded border border-[#242424] bg-[#111] p-2 pt-3 min-w-0">
                <div className="absolute -top-[7px] left-2 px-1.5 rounded bg-[#111] text-[10px] leading-none text-[#aaa] font-medium">
                  Iterations
                </div>
                <span className="absolute -top-[8px] right-2 px-1.5 rounded bg-[#111] text-[10px] leading-none text-[#666] font-mono flex items-center justify-end min-w-[52px] h-[14px]">
                  {iterationIndexing || iterationDateApplying ? (
                    <Loader2 size={11} className="animate-spin text-[#818cf8]" />
                  ) : (
                    `${iterationIndexStats?.indexed ?? 0}/${iterationIndexStats?.total ?? 0}`
                  )}
                </span>
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    onClick={toggleIterationRange}
                    className="h-7 min-w-0 flex-1 px-2 rounded border border-[#2a2a2a] bg-[#0d0d0d] text-[11px] text-[#aaa] hover:text-white hover:border-[#444] cursor-pointer flex items-center justify-between gap-1"
                    title="Iteration date range"
                  >
                    <span className="truncate text-[#777]">{iterationRangeLabel}</span>
                    <ChevronDown
                      size={12}
                      className={`flex-shrink-0 text-[#666] transition-transform ${iterationRangeOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>
                {iterationRangeOpen && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="relative group flex-shrink-0">
                      <button
                        type="button"
                        className="h-7 w-7 rounded border border-[#2a2a2a] bg-[#0d0d0d] text-[#777] hover:text-[#ddd] hover:border-[#444] cursor-pointer flex items-center justify-center"
                        title="Date presets"
                      >
                        <Clock size={12} />
                      </button>
                      <div className="hidden group-hover:block absolute left-0 top-full z-50 pt-1">
                        <div className="w-[88px] rounded border border-[#333] bg-[#151515] p-1 shadow-xl">
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setIterationDateDraft(daysAgoDateInput(7))}
                            className="w-full h-6 px-2 rounded text-left text-[11px] text-[#bbb] hover:bg-[#242424] hover:text-white"
                          >
                            за неделю
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setIterationDateDraft(daysAgoDateInput(30))}
                            className="w-full h-6 px-2 rounded text-left text-[11px] text-[#bbb] hover:bg-[#242424] hover:text-white"
                          >
                            за месяц
                          </button>
                        </div>
                      </div>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={iterationDateDraft}
                      maxLength={10}
                      placeholder="YYYY-MM-DD"
                      onChange={(e) => {
                        setIterationDateDraft(e.target.value.replace(/[^\d-]/g, '').slice(0, 10));
                      }}
                      className="h-7 w-[112px] flex-shrink-0 rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 text-[11px] text-[#ccc] outline-none focus:border-[#555] font-mono"
                      title={iterationDateMin ? `From ${iterationDateMin} to ${iterationDateMax}` : `Up to ${iterationDateMax}`}
                    />
                    <button
                      onClick={() => {
                        setIterationRangeOpen(false);
                        void applyIterationDateRange(iterationDateDraft);
                      }}
                      className="h-7 w-7 rounded border border-[#164e3f] bg-[#071b16] text-[#89d8c1] hover:border-[#10A37F] hover:text-white cursor-pointer flex items-center justify-center"
                      title="Apply range"
                    >
                      <Check size={13} />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <div className="h-7 min-w-0 flex-1 px-2 rounded border border-[#2a2a2a] bg-[#0d0d0d] text-[11px] text-[#888] flex items-center gap-1.5">
                    <Database size={12} className={iterationIndexStats?.unindexed ? 'text-[#d97706]' : 'text-[#666]'} />
                    <span className="truncate">{iterationIndexStats?.unindexed ?? 0} new</span>
                  </div>
                  <button
                    onClick={handleReindexIterations}
                    disabled={iterationIndexing || !iterationIndexStats?.unindexed}
                    className={`h-7 min-w-[62px] px-2 rounded border text-[11px] flex items-center justify-center gap-1 ${
                      iterationIndexing
                        ? 'border-[#3a3a52] bg-[#151528] text-[#d7d7ff] cursor-default'
                        : iterationIndexStats?.unindexed
                          ? 'border-[#333] text-[#aaa] hover:text-white hover:border-[#555] cursor-pointer'
                          : 'border-[#333] text-[#aaa] opacity-40 cursor-default'
                    }`}
                  >
                    {iterationIndexing ? <Loader2 size={12} className="animate-spin text-[#818cf8]" /> : <Database size={12} />}
                    {iterationIndexButtonLabel}
                  </button>
                  <button
                    onClick={handleClearIterationIndex}
                    disabled={!iterationIndexStats?.indexed}
                    className="h-7 w-7 rounded border border-[#333] text-[#666] hover:text-[#aaa] hover:border-[#555] disabled:opacity-35 disabled:hover:text-[#666] disabled:hover:border-[#333] cursor-pointer disabled:cursor-default flex items-center justify-center"
                    title="Clear iteration index"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 mb-2 flex-shrink-0">
              <div className="relative flex-1 min-w-0">
                <input
                  value={historyQuery}
                  onChange={(e) => {
                    setHistoryQuery(e.target.value);
                    setTitleSearchError(null);
                    setIterationSearchError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleIterationSearch();
                    }
                  }}
                  placeholder="Search tab titles..."
                  className="w-full h-8 bg-[#151515] border border-[#2a2a2a] rounded pl-2 pr-8 text-[12px] text-white outline-none focus:border-[#555]"
                />
                {iterationSearching && (
                  <Loader2 size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#10A37F] animate-spin" />
                )}
                {!iterationSearching && historyQuery && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setHistoryQuery('');
                      setTitleSearchError(null);
                      setIterationSearchError(null);
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded text-[#666] hover:text-[#bbb] hover:bg-[#242424] flex items-center justify-center"
                    title="Clear input"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <button
                onClick={handleIterationSearch}
                disabled={iterationSearching || historyQuery.trim().length < 2}
                className="h-8 px-3 rounded border border-[#333] text-[12px] text-[#ccc] hover:text-white hover:border-[#555] disabled:opacity-40 disabled:hover:text-[#ccc] disabled:hover:border-[#333] cursor-pointer disabled:cursor-default flex items-center gap-1.5"
                title="Search iterations (Cmd+Enter)"
              >
                <Search size={13} />
                RAG
              </button>
            </div>

            {iterationModeActive && (
              <div className="mb-2 flex-shrink-0">
                <button
                  onClick={() => {
                    setHistoryQuery('');
                    setIterationQuery('');
                    setIterationResults([]);
                  }}
                  className="max-w-full h-6 pl-2 pr-1 rounded border border-[#164e3f] bg-[#071b16] text-[11px] text-[#89d8c1] hover:border-[#10A37F] cursor-pointer inline-flex items-center gap-1.5"
                  title="Back to title filter"
                >
                  <span className="truncate">RAG: {iterationQuery}</span>
                  <X size={12} className="flex-shrink-0" />
                </button>
              </div>
            )}

            <div className="flex items-center justify-between mb-2 flex-shrink-0 text-[11px]">
              <div className="text-[#666] truncate">
                {iterationModeActive
                  ? `Iteration RAG · ${displayedIterations.length}`
                  : `Instant title filter · ${displayedHistory.length}/${history.length}`}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                {searchError && <div className="text-[#DA7756] truncate max-w-[210px]">{searchError}</div>}
                <button
                  onClick={() => handleClearHistory()}
                  className="h-6 w-6 rounded text-[#555] hover:text-[#999] cursor-pointer flex items-center justify-center"
                  title="Clear history"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 border border-[#242424] rounded bg-[#0f0f0f] overflow-hidden">
              {iterationModeActive ? (
                displayedIterations.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-[#555] text-xs px-4 text-center">
                    {iterationSearching ? 'Идёт поиск по итерациям...' : 'Итерации не найдены.'}
                  </div>
                ) : (
                  <div className="h-full min-h-0 flex flex-col">
                    <div className="h-8 px-3 bg-[#151515]/95 border-b border-[#2a2a2a] flex items-center justify-between gap-2 text-[11px] flex-shrink-0">
                      <div className="flex items-center gap-2 text-[#888] min-w-0">
                        <Search size={13} className="text-[#10A37F] flex-shrink-0" />
                        <span className="truncate">Iteration results</span>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {(['all', 'codex', 'claude'] as const).map((filter) => {
                          const active = iterationToolFilter === filter;
                          const label = filter === 'all' ? 'all' : filter;
                          return (
                            <button
                              key={filter}
                              type="button"
                              onClick={() => setIterationToolFilter(filter)}
                              className={`h-5 px-1.5 rounded text-[10px] leading-none transition-colors ${
                                active
                                  ? 'bg-[#252525] text-[#e6e6e6]'
                                  : 'text-[#666] hover:text-[#aaa] hover:bg-[#1d1d1d]'
                              }`}
                              title={`${label}: ${iterationToolCounts[filter]}`}
                            >
                              {label}
                            </button>
                          );
                        })}
                        <div className="text-[#666] font-mono min-w-[22px] text-right">{displayedIterations.length}</div>
                      </div>
                    </div>
                    <Virtuoso
                      style={{ height: '100%' }}
                      data={displayedIterations}
                      itemContent={(index, entry) => {
                        const color = (entry.color || 'default') as TabColor;
                        const colorConfig = TAB_COLORS[color];
                        const { date, time } = formatShortStamp(entry.closed_at);
                        const selected = selectedPreview?.entry.id === entry.id && selectedPreview?.targetUuid === entry.entryUuid;
                        const hoverKey = makeIterationHoverKey(entry);
                        const cmdHover = isCmdPressed && iterationPopover.hoveredItem?.id === hoverKey;
                        const previewText = (entry.summary || entry.content || '').trim();
                        return (
                          <div
                            className="px-2 py-[3px]"
                            {...iterationPopover.triggerProps(hoverKey)}
                            onContextMenu={(e) => handleCardContextMenu(e, 'history', entry.id)}
                          >
                            <div
                              className="relative cursor-pointer transition-opacity hover:opacity-90"
                              onClick={(e) => {
                                selectPreview(entry, entry.entryUuid, 'iteration');
                              }}
                              style={{
                                minHeight: 46,
                                padding: '6px 8px',
                                backgroundColor: cmdHover ? hoverCardBg(colorConfig) : selected ? selectedCardBg(colorConfig) : colorConfig.bgColor,
                                borderRadius: 5,
                                borderLeft: `2px solid ${colorConfig.borderColor}`,
                                outline: cmdHover ? `1px solid ${withAlpha(colorConfig.borderColor, 0.55)}` : selected ? `1px solid ${withAlpha(colorConfig.borderColor, 0.42)}` : 'none',
                                opacity: cmdHover || selected ? 0.98 : 0.7,
                              }}
                            >
                              <div className="text-[12px] leading-[16px] text-[#d9fff3] line-clamp-2 break-words">
                                {previewText || 'Empty iteration'}
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[#888] font-mono">
                                <span className="min-w-0 truncate text-[#aaa]">#{entry.iterationIndex + 1} · {entry.name}</span>
                                <span className="flex-shrink-0">
                                  {typeof entry.score === 'number' && <span className="text-[#10A37F] mr-2">{entry.score.toFixed(2)}</span>}
                                  {date}<span style={{ color: '#555', margin: '0 2px' }}>|</span>{time}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    />
                  </div>
                )
              ) : displayedHistory.length === 0 ? (
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
                      const iterationCount = entry.message_count == null ? NaN : Number(entry.message_count);
                      const iterationLabel = Number.isFinite(iterationCount) ? `${iterationCount} it` : null;
                      const selected = selectedPreview?.entry.id === entry.id && !selectedPreview?.targetUuid;
                      const cmdHover = isCmdPressed && historyPopover.hoveredItem?.id === entry.id;
                      return (
                        <div
                          className="px-2 py-[3px]"
                          {...historyPopover.triggerProps(entry.id)}
                          onContextMenu={(e) => handleCardContextMenu(e, 'history', entry.id)}
                        >
                          <div
                            className="relative cursor-pointer transition-opacity hover:opacity-90"
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey) {
                                void restoreTab(entry);
                                return;
                              }
                              selectPreview(entry);
                            }}
                            onMouseDown={(e) => {
                              if (e.button === 1) {
                                e.preventDefault();
                                e.stopPropagation();
                                restoreTabBackground(entry);
                              }
                            }}
                            onAuxClick={(e) => {
                              if (e.button === 1) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                            }}
                            style={{
                              minHeight: 32,
                              padding: '5px 8px',
                              backgroundColor: cmdHover ? 'rgba(16, 163, 127, 0.2)' : selected ? selectedCardBg(colorConfig) : colorConfig.bgColor,
                              borderRadius: 5,
                              borderLeft: `2px solid ${cmdHover ? '#10A37F' : colorConfig.borderColor}`,
                              outline: cmdHover ? '1px solid rgba(16, 163, 127, 0.55)' : selected ? `1px solid ${withAlpha(colorConfig.borderColor, 0.42)}` : 'none',
                              opacity: cmdHover || selected ? 0.96 : 0.62,
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
                              {iterationLabel && (
                                <span className="text-[#b8a75f]">{iterationLabel}</span>
                              )}
                              <span>{date}<span style={{ color: '#555', margin: '0 2px' }}>|</span>{time}</span>
                            </div>
                            {cmdHover && (
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[#10A37F]/45 bg-[#05231c] px-2 py-0.5 text-[10px] text-[#9be6cf] shadow-lg">
                                Resume
                              </div>
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

          <div
            className="w-[7px] mx-1 flex-shrink-0 cursor-col-resize rounded hover:bg-[#333]"
            onPointerDown={handleDividerPointerDown}
            onDoubleClick={() => setRightColWidth(RIGHT_COL_DEFAULT)}
            title="Resize preview"
          />

          <div className="flex-1 min-w-0 min-h-0 border border-[#242424] rounded bg-[#101010] overflow-hidden flex flex-col">
            {selectedPreview && previewTarget ? (
              <>
                <div className="h-9 px-3 border-b border-[#2a2a2a] bg-[#151515] flex items-center justify-between gap-3 flex-shrink-0">
                  <div className="min-w-0">
                    <div className="text-[12px] text-white truncate">{selectedPreview.entry.name}</div>
                    <div className="text-[10px] text-[#777] font-mono truncate">
                      {previewTarget.toolType} · {previewDate ? `${previewDate.date} | ${previewDate.time}` : ''}
                    </div>
                  </div>
                  {selectedPreview.source === 'iteration' && selectedPreview.targetUuid && (
                    <div className="flex-shrink-0 text-[10px] text-[#10A37F] font-mono">iteration</div>
                  )}
                </div>
                <div className="flex-1 min-h-0 flex relative">
                  <div className="flex-1 min-w-0">
                    <HistoryPanel
                      tabId={previewTabId}
                      sessionId={previewTarget.sessionId}
                      cwd={selectedPreview.entry.cwd}
                      width={420}
                      notesPanelWidth={0}
                      isOpen={true}
                      toolType={previewTarget.toolType}
                      enableClaudePtyControls={false}
                      embedded
                      embeddedFill
                      previewMode
                    />
                  </div>
                  <div className="w-[33px] flex-shrink-0 border-l border-[#2a2a2a] bg-[#141414] relative overflow-hidden">
                    <Timeline
                      tabId={previewTabId}
                      sessionId={previewTarget.sessionId}
                      cwd={selectedPreview.entry.cwd}
                      isActive={false}
                      isVisible={true}
                      isOpen={true}
                      toolType={previewTarget.toolType}
                      readOnly
                    />
                  </div>
                  {previewScrollLoading && (
                    <div className="absolute inset-0 z-20 bg-[#101010] flex items-center justify-center">
                      <div className="flex items-center gap-2 text-[12px] text-[#818cf8]">
                        <Loader2 size={16} className="animate-spin" />
                        <span>Loading iteration...</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="h-10 px-3 border-t border-[#2a2a2a] bg-[#151515] flex items-center justify-between flex-shrink-0">
                  <div className="text-[11px] text-[#777] truncate">{selectedPreview.entry.cwd}</div>
                  <button
                    onClick={() => restoreTab(selectedPreview.entry)}
                    className="h-7 px-3 rounded border border-[#164e3f] bg-[#071b16] text-[12px] text-[#9be6cf] hover:border-[#10A37F] hover:text-white cursor-pointer"
                  >
                    Resume
                  </button>
                </div>
              </>
            ) : selectedPreview ? (
              <div className="h-full flex items-center justify-center text-[#555] text-xs px-6 text-center">
                У этой записи нет сохранённой AI-сессии для предпросмотра.
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-[#555] text-xs px-6 text-center">
                Выбери вкладку слева, чтобы посмотреть History и Timeline без открытия терминала.
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
              const refreshing = titleRefreshInFlight.has(`tab:${tabId}`) || tabTitleNamingIds.has(tabId);
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
                  <button
                    className={`w-full text-left px-4 py-1.5 text-[13px] flex items-center gap-2 ${
                      refreshing
                        ? 'text-[#777] cursor-default'
                        : 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                    }`}
                    disabled={refreshing}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (refreshing) return;
                      void handleRefreshActiveTabTitle(tabId);
                    }}
                  >
                    <RotateCw size={12} className={refreshing ? 'text-[#777] animate-spin' : 'text-[#888]'} />
                    {refreshing ? 'Название обновляется...' : 'Обновить название'}
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
              const canRefreshTitle = !!getHistoryTitleTarget(entry);
              const refreshing = titleRefreshInFlight.has(`history:${histId}`);
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
                  {canRefreshTitle && (
                    <button
                      className={`w-full text-left px-4 py-1.5 text-[13px] flex items-center gap-2 ${
                        refreshing
                          ? 'text-[#777] cursor-default'
                          : 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                      }`}
                      disabled={refreshing}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (refreshing) return;
                        void handleRefreshHistoryTitle(entry);
                      }}
                    >
                      <RotateCw size={12} className={refreshing ? 'text-[#777] animate-spin' : 'text-[#888]'} />
                      {refreshing ? 'Название обновляется...' : 'Обновить название'}
                    </button>
                  )}
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
            split
            pointerThrough
            isLocked={historyPopover.isLocked}
            source="home-history"
          />
        );
      })()}

      {iterationPopover.isVisible && iterationPopover.hoveredItem && (() => {
        const hovered = displayedIterations.find(entry => makeIterationHoverKey(entry) === iterationPopover.hoveredItem!.id);
        if (!hovered) return null;
        const rect = iterationPopover.hoveredItem.rect;
        const width = Math.max(220, Math.min(rect.width, window.innerWidth - 16));
        const height = Math.max(96, Math.min(rect.height * 2, 260, window.innerHeight - 16));
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const aboveTop = rect.top - height - 6;
        const top = aboveTop >= 8
          ? aboveTop
          : Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8));
        const text = String(hovered.content || hovered.summary || '').trim() || 'Empty iteration';
        return (
          <div
            style={{
              position: 'fixed',
              left,
              top,
              width,
              height,
              zIndex: 120,
              background: '#151515',
              border: `1px solid ${withAlpha(TAB_COLORS[(hovered.color || 'default') as TabColor].borderColor, 0.55)}`,
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              padding: 10,
              color: '#ddd',
              fontSize: 12,
              lineHeight: '18px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
            onMouseEnter={iterationPopover.popoverProps.onMouseEnter}
            onMouseLeave={iterationPopover.popoverProps.onMouseLeave}
            data-cmd-hover-popover
          >
            {text}
          </div>
        );
      })()}

    </div>
  );
}
