import { create } from 'zustand';
import {
  forgetScrollTop,
  getRememberedScrollTop,
  readScrollMemory,
  rememberScrollTop,
} from '../utils/filePreviewScrollMemory.mjs';
import {
  readComposerViewMemory,
  rememberComposerView,
} from '../utils/composerViewState.mjs';
import {
  buildComposerDraftMemory,
  splitComposerDraftMemory,
} from '../utils/composerDraftPersistence.mjs';
import type { GeminiModelId } from '../constants/geminiModels';
import { isGeminiModelId } from '../constants/geminiModels';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning' | 'pink';
  persistent?: boolean;
  copyText?: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: 'github-desktop';
  // When set, toast is only rendered while this tab is the effective active tab.
  // Used for tab-scoped notifications (e.g. "history chain recovered" in Timeline).
  tabId?: string;
}

interface FilePreview {
  path: string;
  content: string;
  language: string | null;
  source?: 'sidebar' | 'terminal-link' | 'tab';
  sourceTabId?: string;
}

/** Reading position per absolute file path. See utils/filePreviewScrollMemory. */
type FilePreviewScrollMemory = Record<string, { top: number; at: number }>;

export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type AIModel = GeminiModelId;

// Re-export from canonical source. Older code imports DefaultClaudeEffort from useUIStore
// because the type used to be defined here; we keep the alias so we don't touch dozens
// of call sites. The list itself lives in constants/claudeLevels.ts.
export type { ClaudeCodeModelOption, ClaudeCodeSettings, DefaultClaudeEffort, DefaultClaudeModel } from '../constants/claudeLevels';
import type { ClaudeCodeSettings, DefaultClaudeEffort, DefaultClaudeModel } from '../constants/claudeLevels';
import {
  DEFAULT_CLAUDE_CODE_SETTINGS,
  normalizeClaudeCodeSettings,
  resolveClaudeEffortForModel,
} from '../constants/claudeLevels';
export type { DefaultCodexEffort, DefaultCodexModel } from '../constants/codexSettings';
import type { CodexSettings, DefaultCodexEffort, DefaultCodexModel } from '../constants/codexSettings';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SETTINGS,
  normalizeCodexEffortOptions,
  normalizeCodexModelOptions,
  normalizeCodexRemovedModelIds,
  resolveCodexPersistentEffortForModel,
} from '../constants/codexSettings';
import {
  DEFAULT_AI_COMPOSER_CHIP_THRESHOLD,
  normalizeComposerChipThreshold,
  normalizeComposerChips,
  removeComposerChip,
  upsertComposerChip,
} from '../utils/composerChips.mjs';

export const HISTORY_PANEL_DEFAULT_WIDTH = 580;
export const HISTORY_PANEL_MIN_WIDTH = 280;

export interface HistoryRewindPreview {
  opId: string;
  targetUuid: string;
  targetText: string;
  startedAt: number;
  sessionId?: string;
  writerGeneration?: string;
}

export interface HistoryPromptDraftImageRef {
  id: number;
  path: string;
  assetId?: string;
  mediaType?: string | null;
  size?: number;
  availability?: 'available' | 'missing';
  error?: string;
}

export type HistoryPromptDraftChipKind = 'prompt' | 'paste';

export interface HistoryPromptDraftChip {
  id: string;
  kind: HistoryPromptDraftChipKind;
  text: string;
  label?: string;
  /**
   * Stable identity of a saved prompt or its variation. Prompt chips with the
   * same sourceKey replace one another in place; paste chips are never deduped.
   */
  sourceKey?: string;
  createdAt?: number;
}

export interface HistoryPromptDraftWriteOptions {
  images?: HistoryPromptDraftImageRef[] | null;
  preserveImages?: boolean;
  chips?: HistoryPromptDraftChip[] | null;
  preserveChips?: boolean;
}

export interface HistoryComposerViewState {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  updatedAt: number;
}

export interface HistoryComposerAvailability {
  ownerId: string;
  canSend: boolean;
  canAcceptSubmitIntent: boolean;
  canInterruptTurn: boolean;
  canPullDraft: boolean;
  status: string;
  lifecycleGeneration?: string | null;
  canStopProcess?: boolean;
}

export type PromptQueueInputSurface = 'terminal' | 'history';

/* Session status (label + color) — назначается вкладке через ПКМ → Status.
   id = stable handle, который Tab.sessionStatus сохраняет в SQLite.
   color = любой hex/rgb, юзер редактирует через react-colorful. */
export interface SessionStatusDef {
  id: string;
  label: string;
  color: string;
  description?: string;
}

const DEFAULT_SESSION_STATUSES: SessionStatusDef[] = [
  { id: 'dev',       label: 'Идёт разработка',    color: '#FACC15' },
  { id: 'bugfix',    label: 'Отложенный багфикс', color: '#F43F5E' },
  { id: 'knowledge', label: 'Отложенные знания',  color: '#10B981' },
];

function loadSessionStatuses(): SessionStatusDef[] {
  try {
    const raw = localStorage.getItem('noted-terminal-session-statuses');
    if (!raw) return DEFAULT_SESSION_STATUSES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SESSION_STATUSES;
    return parsed
      .filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string' && typeof s.color === 'string')
      .map((s) => ({ id: s.id, label: s.label, color: s.color, description: typeof s.description === 'string' ? s.description : '' }));
  } catch { return DEFAULT_SESSION_STATUSES; }
}

function saveSessionStatuses(list: SessionStatusDef[]) {
  try { localStorage.setItem('noted-terminal-session-statuses', JSON.stringify(list)); } catch {}
}

function loadTaskStatuses(): SessionStatusDef[] {
  try {
    const raw = localStorage.getItem('noted-terminal-task-statuses');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string' && typeof s.color === 'string')
          .map((s) => ({ id: s.id, label: s.label, color: s.color, description: typeof s.description === 'string' ? s.description : '' }));
      }
    }
  } catch {}

  // First launch of task plans: clone the user's current tab palette so the
  // new column is useful immediately, then let both palettes evolve separately.
  const seeded = loadSessionStatuses().map((status) => ({
    ...status,
    id: `task-${status.id}`,
    description: status.description || '',
  }));
  try { localStorage.setItem('noted-terminal-task-statuses', JSON.stringify(seeded)); } catch {}
  return seeded;
}

function saveTaskStatuses(list: SessionStatusDef[]) {
  try { localStorage.setItem('noted-terminal-task-statuses', JSON.stringify(list)); } catch {}
}

export interface ProcessBarSettings {
  colorA: string;       // базовый цвет полоски процесса
  shimmerColor: string; // цвет бегущего AI-busy блика поверх полоски
  inheritedColor: string; // цвет ожидания дочернего Terminal MCP run
  shimmerSpacingPct: number; // высота repeat-tile в %, визуально = расстояние между бликами
  shimmerOpacityPct: number; // peak-alpha блика в %, края считаются слабее в CSS vars
  position: 'left' | 'right'; // где рисовать полоску — у левого или правого края вкладки
}

const DEFAULT_PROCESS_BAR: ProcessBarSettings = {
  colorA: '#155E75',        // cyan-800 — приглушённая базовая полоса
  shimmerColor: '#FFFFFF',  // белый блик, который раньше был зашит в CSS
  inheritedColor: '#A855F7', // purple-500 — ожидание дочерней полной сессии
  shimmerSpacingPct: 50,
  shimmerOpacityPct: 55,
  position: 'left',
};

function loadProcessBar(): ProcessBarSettings {
  try {
    const raw = localStorage.getItem('noted-terminal-process-bar');
    if (!raw) return DEFAULT_PROCESS_BAR;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PROCESS_BAR;
    const rawSpacing = typeof parsed.shimmerSpacingPct === 'number'
      ? parsed.shimmerSpacingPct
      : DEFAULT_PROCESS_BAR.shimmerSpacingPct;
    const rawOpacity = typeof parsed.shimmerOpacityPct === 'number'
      ? parsed.shimmerOpacityPct
      : DEFAULT_PROCESS_BAR.shimmerOpacityPct;
    return {
      colorA: typeof parsed.colorA === 'string' ? parsed.colorA : DEFAULT_PROCESS_BAR.colorA,
      // Legacy `colorB` was a pulse phase, not the shimmer color. When opening an
      // old saved config, keep the current hardcoded white shimmer as the new chip.
      shimmerColor: typeof parsed.shimmerColor === 'string'
        ? parsed.shimmerColor
        : DEFAULT_PROCESS_BAR.shimmerColor,
      inheritedColor: typeof parsed.inheritedColor === 'string'
        ? parsed.inheritedColor
        : DEFAULT_PROCESS_BAR.inheritedColor,
      shimmerSpacingPct: Math.max(20, Math.min(200, Math.round(rawSpacing))),
      shimmerOpacityPct: Math.max(5, Math.min(100, Math.round(rawOpacity))),
      position: parsed.position === 'right' ? 'right' : 'left',
    };
  } catch { return DEFAULT_PROCESS_BAR; }
}

function saveProcessBar(s: ProcessBarSettings) {
  try { localStorage.setItem('noted-terminal-process-bar', JSON.stringify(s)); } catch {}
}

/* AIPulse (whole-tab background pulse during AI-busy) was REMOVED — the loader
   is the process-bar shimmer strip on the tab edge, not a tint of the entire
   tab. See fact-process-bar.md::AIPulse removed. */

export interface StatusMarkerSettings {
  shape: 'dot' | 'square';
  sizePx: number;     // 4..16, 1px step
}

const DEFAULT_STATUS_MARKER: StatusMarkerSettings = { shape: 'dot', sizePx: 8 };

function loadStatusMarker(): StatusMarkerSettings {
  try {
    const raw = localStorage.getItem('noted-terminal-status-marker');
    if (!raw) return DEFAULT_STATUS_MARKER;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STATUS_MARKER;
    return {
      shape: parsed.shape === 'square' ? 'square' : 'dot',
      sizePx: typeof parsed.sizePx === 'number'
        ? Math.max(4, Math.min(16, Math.round(parsed.sizePx)))
        : DEFAULT_STATUS_MARKER.sizePx,
    };
  } catch { return DEFAULT_STATUS_MARKER; }
}

function saveStatusMarker(s: StatusMarkerSettings) {
  try { localStorage.setItem('noted-terminal-status-marker', JSON.stringify(s)); } catch {}
}

export interface TabGeometrySettings {
  paddingX: number;       // горизонтальный padding внутри таба, default 6 (clamp 0..32)
  paddingY: number;       // вертикальный, default 3 (clamp 0..24)
  paddingLeft: number;    // левый отступ (резерв под process-bar 3px + status marker 8px + воздух), default 16 (clamp 4..48)
  borderRadius: number;   // скругление углов, default 6 (clamp 0..20)
  gap: number;            // зазор между табами, default 3 (clamp 0..16)
}

const DEFAULT_TAB_GEOMETRY: TabGeometrySettings = {
  paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 3,
};

function clampInt(v: any, fallback: number, min: number, max: number): number {
  return typeof v === 'number' ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
}

function loadTabGeometry(): TabGeometrySettings {
  try {
    const raw = localStorage.getItem('noted-terminal-tab-geometry');
    if (!raw) return DEFAULT_TAB_GEOMETRY;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return DEFAULT_TAB_GEOMETRY;
    return {
      paddingX:     clampInt(p.paddingX,     DEFAULT_TAB_GEOMETRY.paddingX,     0, 32),
      paddingY:     clampInt(p.paddingY,     DEFAULT_TAB_GEOMETRY.paddingY,     0, 24),
      paddingLeft:  clampInt(p.paddingLeft,  DEFAULT_TAB_GEOMETRY.paddingLeft,  4, 48),
      borderRadius: clampInt(p.borderRadius, DEFAULT_TAB_GEOMETRY.borderRadius, 0, 20),
      gap:          clampInt(p.gap,          DEFAULT_TAB_GEOMETRY.gap,          0, 16),
    };
  } catch { return DEFAULT_TAB_GEOMETRY; }
}

function saveTabGeometry(s: TabGeometrySettings) {
  try { localStorage.setItem('noted-terminal-tab-geometry', JSON.stringify(s)); } catch {}
}

export interface ProjectTabGeometrySettings {
  paddingX: number;   // default 12 (clamp 0..32) — соответствует px-3
  paddingY: number;   // default 6  (clamp 0..16) — соответствует py-1.5
}

const DEFAULT_PROJECT_TAB_GEOMETRY: ProjectTabGeometrySettings = { paddingX: 12, paddingY: 6 };

function loadProjectTabGeometry(): ProjectTabGeometrySettings {
  try {
    const raw = localStorage.getItem('noted-terminal-project-tab-geometry');
    if (!raw) return DEFAULT_PROJECT_TAB_GEOMETRY;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return DEFAULT_PROJECT_TAB_GEOMETRY;
    return {
      paddingX: clampInt(p.paddingX, DEFAULT_PROJECT_TAB_GEOMETRY.paddingX, 0, 32),
      paddingY: clampInt(p.paddingY, DEFAULT_PROJECT_TAB_GEOMETRY.paddingY, 0, 16),
    };
  } catch { return DEFAULT_PROJECT_TAB_GEOMETRY; }
}

function saveProjectTabGeometry(s: ProjectTabGeometrySettings) {
  try { localStorage.setItem('noted-terminal-project-tab-geometry', JSON.stringify(s)); } catch {}
}





interface UIStore {

  // Font Settings

  terminalFontSize: number;

  tabsFontSize: number;        // Working tabs in TabSidebar

  projectTabsFontSize: number; // Project chips in Title Bar

  sidebarFontSize: number;     // File explorer sidebar
  sidebarWidth: number;        // File explorer width (px)
  tabSidebarWidth: number;     // Permanent left tab sidebar width (px)
  storageBrowserExpanded: boolean; // Global Home Storage disclosure state.

  /* Session statuses (configurable via Settings → Системные).
     Default seed = dev / bugfix / knowledge with их saturated colors.
     Tab.sessionStatus stores `id` of selected status; if id was deleted —
     TabBar просто не рендерит маркер (graceful degrade).
     Stored in localStorage as JSON array. */
  sessionStatuses: SessionStatusDef[];
  setSessionStatuses: (next: SessionStatusDef[]) => void;
  addSessionStatus: () => string; // returns generated id
  updateSessionStatus: (id: string, patch: Partial<Omit<SessionStatusDef, 'id'>>) => void;
  removeSessionStatus: (id: string) => void;

  taskStatuses: SessionStatusDef[];
  setTaskStatuses: (next: SessionStatusDef[]) => void;
  addTaskStatus: () => string;
  updateTaskStatus: (id: string, patch: Partial<Omit<SessionStatusDef, 'id'>>) => void;
  removeTaskStatus: (id: string) => void;

  /* Process bar — полоска слева/справа во вкладке когда процесс жив.
     Полоса всегда видима при живом процессе; настройка НЕ содержит выключателя.
     AI-busy рисуется отдельным shimmer-оверлеем с цветом/расстоянием/плотностью из настроек.
     CSS читает значения через --process-bar-* переменные на :root, обновляемые из App. */
  processBar: ProcessBarSettings;
  setProcessBar: (patch: Partial<ProcessBarSettings>) => void;

  /* Status marker — маркер слева во вкладке (vertical mode) для sessionStatus.
     shape='dot' → круг, 'square' → квадрат (border-radius различается).
     sizePx — длина стороны (для круга = диаметр). Clamp 4..16. */
  statusMarker: StatusMarkerSettings;
  setStatusMarker: (patch: Partial<StatusMarkerSettings>) => void;
  taskStatusMarker: StatusMarkerSettings;
  setTaskStatusMarker: (patch: Partial<StatusMarkerSettings>) => void;

  /* Tab geometry — рабочие вкладки в TabSidebar (vertical mode). Все поля px.
     Раньше — три константы TAB_VERTICAL_PADDING_* в TabBar.tsx, юзер не мог менять
     не открывая код. Теперь Settings → Размеры → Вкладки → Рабочие вкладки. */
  tabGeometry: TabGeometrySettings;
  setTabGeometry: (patch: Partial<TabGeometrySettings>) => void;

  /* Project tab geometry — чипы проектов в TitleBar. */
  projectTabGeometry: ProjectTabGeometrySettings;
  setProjectTabGeometry: (patch: Partial<ProjectTabGeometrySettings>) => void;

  filePreviewFontSize: number; // FilePreview readOnly editor
  promptPickerFontSize: number; // Opt+V picker rows
  promptPickerBottomOffsetPx: number; // Отступ от низа viewport'а для fallback-якоря picker'а (PTY-табы)
  promptPickerLeftOffsetPx: number;   // 0 — центр или прижатие к правому. >0 — прижатие к левому краю.
  promptPickerRightOffsetPx: number;  // 0 — центр или прижатие к левому. >0 — приоритет: прижатие к правому краю.
  timelineFontSize: number;    // Timeline entries preview text
  timelineSummaryFontSize: number; // Generated user-prompt summaries in expanded Timeline
  timelineWidth: number;       // Timeline width (px) when expanded (treeMode). Drag-resizable.
  timelineLineClamp: number;   // How many lines of preview text show in expanded mode.
  historyFontSize: number; // Primary History transcript font size (messages + tool blocks).
  historyComposerFontSize: number; // Primary History prompt textarea font size.
  aiSecondaryFontSize: number; // Secondary AI labels, statuses and composer chips.
  historyMarkdownCodeMaxLines: number; // Vertical viewport of fenced Markdown blocks; long lines wrap.
  historyComposerMinRows: number; // Empty height for the primary History prompt textarea.
  historyComposerMaxRows: number; // Auto-grow ceiling for the primary History prompt textarea.
  stackedComposerMaxRows: number; // Same ceiling for a pane stacked in a column (starts at 1 row).
  setStackedComposerMaxRows: (rows: number) => void;
  aiComposerChipThreshold: number; // Manual paste becomes a chip only above this many characters.
  promptQueueChipFontSize: number; // Run-after chip title font inside the queue list.
  promptQueueEditorFontSize: number; // Run-after chip editor title/body font in the slideout.
  promptQueueChipLineClamp: number; // How many lines of chip text show inside Run After overlay (1 = single-line ellipsis).
  promptQueueWidth: number;    // Run-after overlay width (px). FIXED — adding a +grab chip must not reflow it. Drag-resizable on the free (non-anchor) edge. Global, like timelineWidth.

  setSidebarWidth: (width: number) => void;
  setTabSidebarWidth: (width: number) => void;
  setStorageBrowserExpanded: (expanded: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setTabsFontSize: (size: number) => void;

  setProjectTabsFontSize: (size: number) => void;

  setSidebarFontSize: (size: number) => void;

  setFilePreviewFontSize: (size: number) => void;
  setPromptPickerFontSize: (size: number) => void;
  setPromptPickerBottomOffsetPx: (px: number) => void;
  setPromptPickerLeftOffsetPx: (px: number) => void;
  setPromptPickerRightOffsetPx: (px: number) => void;

  setTimelineFontSize: (size: number) => void;
  setTimelineSummaryFontSize: (size: number) => void;
  setTimelineWidth: (width: number) => void;
  setTimelineLineClamp: (lines: number) => void;
  setHistoryFontSize: (size: number) => void;
  setHistoryComposerFontSize: (size: number) => void;
  setAiSecondaryFontSize: (size: number) => void;
  setHistoryMarkdownCodeMaxLines: (lines: number) => void;
  setHistoryComposerMinRows: (rows: number) => void;
  setHistoryComposerMaxRows: (rows: number) => void;
  setAiComposerChipThreshold: (characters: number) => void;
  setPromptQueueChipFontSize: (size: number) => void;
  setPromptQueueEditorFontSize: (size: number) => void;
  setPromptQueueChipLineClamp: (lines: number) => void;
  setPromptQueueWidth: (width: number) => void;

  incrementTerminalFontSize: () => void;

  decrementTerminalFontSize: () => void;

  incrementAllFontSizes: () => void;  // Cmd++

  decrementAllFontSizes: () => void;  // Cmd+-



  // Editor Settings (from gt-editor)

  wordWrap: boolean;

  setWordWrap: (wrap: boolean) => void;

  confirmDelete: boolean;

  setConfirmDelete: (confirm: boolean) => void;

  iconTheme: 'vscode' | 'emoji';

  setIconTheme: (theme: 'vscode' | 'emoji') => void;



  // AI Model Selection (global)

  selectedModel: AIModel;

  setSelectedModel: (model: AIModel) => void;



  // Thinking Level for Gemini 3

  thinkingLevel: ThinkingLevel;

  setThinkingLevel: (level: ThinkingLevel) => void;




  // Claude Default Prompt toggle
  claudeDefaultPromptEnabled: boolean;
  setClaudeDefaultPromptEnabled: (enabled: boolean) => void;

  // File Explorer

  fileExplorerOpen: boolean;

  toggleFileExplorer: () => void;

  setFileExplorerOpen: (open: boolean) => void;



  // File Preview

  filePreview: FilePreview | null;

  openFilePreview: (preview: FilePreview) => void;

  closeFilePreview: () => void;

  filePreviewScroll: FilePreviewScrollMemory;

  getFilePreviewScrollTop: (path: string) => number;

  setFilePreviewScrollTop: (path: string, scrollTop: number) => void;

  clearFilePreviewScrollTop: (path: string) => void;



  // Toast Notifications

  toasts: Toast[];

  showToast: (message: string, type?: Toast['type'], duration?: number, persistent?: boolean, copyText?: string, actionLabel?: string, onAction?: () => void, tabId?: string, actionIcon?: Toast['actionIcon'], details?: string) => void;

  removeToast: (id: string) => void;



  // Prompt picker overlay (Opt+V) — global, not per-tab. The picker resolves
  // its target tab dynamically via getEffectiveTabId() when a prompt is chosen,
  // so there's no per-tab open state to track.
  promptPickerOpen: boolean;
  setPromptPickerOpen: (open: boolean) => void;

  // Reopen-tab pulse — flips true synchronously on Shift+Cmd+T keydown so the
  // user sees TabBar glow flicker BEFORE the IPC round-trip + Claude resume
  // handshake finishes. Auto-clears after ~600ms via the action's internal
  // timer; subsequent presses re-arm it.
  reopenPulseActive: boolean;
  triggerReopenPulse: () => void;

  // History Panel (per-tab state)
  historyPanelOpenTabs: Record<string, boolean>;
  historyPanelWidth: number;
  sideTerminalWidth: number;
  // Per-tab "side terminal is open" (History-primary layouts). Persisted so a
  // restart brings the side terminal back exactly where it was — single mode
  // and split panes share this one map.
  sideTerminalOpenTabs: Record<string, boolean>;
  historyScrollToUuid: string | null;
  historyScrollTargetTabId: string | null;
  historyVisibleUuids: Record<string, string[]>;
  historyScrollPositions: Record<string, number>;
  historyPromptDrafts: Record<string, string>;
  historyPromptDraftImages: Record<string, HistoryPromptDraftImageRef[]>;
  historyPromptDraftChips: Record<string, HistoryPromptDraftChip[]>;
  historyPromptDraftUpdatedAt: Record<string, number>;
  historyComposerViewByTab: Record<string, HistoryComposerViewState>;
  historyComposerAvailability: Record<string, HistoryComposerAvailability>;
  historyRewindPreviews: Record<string, HistoryRewindPreview>;
  promptQueueInputSurfaceTabs: Record<string, PromptQueueInputSurface>;
  setHistoryPanelOpen: (tabId: string, open: boolean) => void;
  setHistoryPanelWidth: (width: number) => void;
  setSideTerminalWidth: (width: number) => void;
  setSideTerminalOpen: (tabId: string, open: boolean) => void;
  setHistoryScrollToUuid: (uuid: string | null, tabId?: string | null) => void;
  setHistoryVisibleUuids: (tabId: string, uuids: string[]) => void;
  setHistoryScrollPosition: (tabId: string, scrollTop: number) => void;
  setHistoryPromptDraft: (tabId: string, draft: string, options?: HistoryPromptDraftWriteOptions) => void;
  setHistoryPromptDraftChips: (tabId: string, chips: HistoryPromptDraftChip[]) => void;
  addHistoryPromptDraftChip: (tabId: string, chip: HistoryPromptDraftChip) => void;
  removeHistoryPromptDraftChip: (tabId: string, chipId: string) => void;
  appendHistoryPromptDraft: (tabId: string, text: string) => void;
  flushHistoryComposerDrafts: () => void;
  /**
   * Записать черновик на диск через полсекунды покоя. Вызывается КАЖДЫМ
   * изменением текста, картинок и чипов — чтобы при перезапуске восстановилось
   * то, что человек печатал, а не то, что он успел отправить.
   */
  scheduleHistoryComposerDraftSave: () => void;
  setHistoryComposerView: (
    tabId: string,
    patch: Partial<Pick<HistoryComposerViewState, 'selectionStart' | 'selectionEnd' | 'scrollTop'>>,
  ) => void;
  flushHistoryComposerView: () => void;
  setHistoryComposerAvailability: (
    tabId: string,
    availability: HistoryComposerAvailability | null,
    ownerId: string,
  ) => void;
  setHistoryRewindPreview: (tabId: string, preview: HistoryRewindPreview | null) => void;
  setPromptQueueInputSurface: (tabId: string, surface: PromptQueueInputSurface) => void;

  // Timeline panel visibility (per-tab state, default open)
  timelinePanelOpenTabs: Record<string, boolean>;
  setTimelinePanelOpen: (tabId: string, open: boolean) => void;

  // Timeline tree mode (per-tab state)
  timelineTreeModeTabs: Record<string, boolean>;
  setTimelineTreeMode: (tabId: string, open: boolean) => void;

  // Notes Panel Width

  notesPanelWidth: number;

  setNotesPanelWidth: (width: number) => void;

  // Edit Range Panel Size
  editRangePanelSize: { width: number; height: number };
  setEditRangePanelSize: (size: { width: number; height: number }) => void;

  timelineTooltipWidth: number;
  setTimelineTooltipWidth: (width: number) => void;

  // Drag Area Width (title bar window drag handle)
  dragAreaWidth: number;
  setDragAreaWidth: (width: number) => void;



  // Edit Project Modal

  editingProject: any | null;

  openEditModal: (project: any) => void;

  closeEditModal: () => void;



  // Session Input Modal

  sessionModal: {

    open: boolean;

    title: string;

    label: string;

    placeholder: string;

    hint: string;

    resolve: ((value: string | null) => void) | null;

  };

  showSessionModal: (title: string, label: string, placeholder: string, hint: string) => Promise<string | null>;

  closeSessionModal: (value: string | null) => void;

  // Copy Settings (shared between CopySessionButton and Timeline)
  // Sidebar (file explorer) behavior toggles
  sidebarPersistFile: boolean;
  sidebarOverlayCloseOnClickOutside: boolean;
  setSidebarPersistFile: (v: boolean) => void;
  setSidebarOverlayCloseOnClickOutside: (v: boolean) => void;

  copyIncludeEditing: boolean;
  copyIncludeReading: boolean;
  copyFromStart: boolean;
  copyIncludeSubagentResult: boolean;
  copyIncludeSubagentHistory: boolean;
  copyIncludeUser: boolean;
  copyIncludeClaude: boolean;
  copyIncludeText: boolean;
  copyIncludeThinking: boolean;
  copyIncludeActions: boolean;
  copyIncludeSearch: boolean;
  copyIncludeRun: boolean;
  copyIncludeGit: boolean;
  copyIncludeMcp: boolean;
  copyIncludePlan: boolean;
  copyIncludeBash: boolean;
  copyIncludeTools: boolean;
  copyIncludeWebSearch: boolean;
  copyIncludeToolSearch: boolean;
  copyIncludeOtherTools: boolean;
  setCopyIncludeEditing: (v: boolean) => void;
  setCopyIncludeReading: (v: boolean) => void;
  setCopyFromStart: (v: boolean) => void;
  setCopyIncludeSubagentResult: (v: boolean) => void;
  setCopyIncludeSubagentHistory: (v: boolean) => void;
  setCopyIncludeUser: (v: boolean) => void;
  setCopyIncludeClaude: (v: boolean) => void;
  setCopyIncludeText: (v: boolean) => void;
  setCopyIncludeThinking: (v: boolean) => void;
  setCopyIncludeActions: (v: boolean) => void;
  setCopyIncludeSearch: (v: boolean) => void;
  setCopyIncludeRun: (v: boolean) => void;
  setCopyIncludeGit: (v: boolean) => void;
  setCopyIncludeMcp: (v: boolean) => void;
  setCopyIncludePlan: (v: boolean) => void;
  setCopyIncludeBash: (v: boolean) => void;
  setCopyIncludeTools: (v: boolean) => void;
  setCopyIncludeWebSearch: (v: boolean) => void;
  setCopyIncludeToolSearch: (v: boolean) => void;
  setCopyIncludeOtherTools: (v: boolean) => void;

  // Status bar debug toggles
  debugHoverBridges: boolean;
  setDebugHoverBridges: (v: boolean) => void;
  // Streaming/privacy mode hides public remote-control hosts/IPs from chrome.
  streamerMode: boolean;
  setStreamerMode: (v: boolean) => void;
  /** Временный A/B built-in style: project icons используют исходный raster,
   *  но отображаются grayscale. Metadata не переписывается. */
  projectIconsGrayscalePreview: boolean;
  setProjectIconsGrayscalePreview: (v: boolean) => void;
  // Global opt-out for provisional History text read from committed PTY frames.
  // Canonical JSONL History remains enabled regardless of this preference.
  terminalHistoryStreamingEnabled: boolean;
  setTerminalHistoryStreamingEnabled: (v: boolean) => void;
  // Diagnostic toggle: when true, Cmd-popups (tooltip/note/fork) stay open
  // after pointer leaves so user can inspect their inner DOM in devtools.
  freezeCmdPopups: boolean;
  setFreezeCmdPopups: (v: boolean) => void;
  historyPinned: boolean;
  setHistoryPinned: (v: boolean) => void;
  /** Project selected in the Run after picker. Survives restart; manual only. */
  runAfterPickerProjectId: string | null;
  setRunAfterPickerProjectId: (projectId: string | null) => void;
  timelinePinned: boolean;
  setTimelinePinned: (v: boolean) => void;
  /** Полоса вкладок в шапке окна ПЕРЕНОСИТ чипы на следующие строки вместо
   *  горизонтальной прокрутки. Переключается пунктом «Перенос вкладок» в
   *  ⋮-меню шапки; глобальная, как и остальные режимы раскладки. */
  paneTabStripWrap: boolean;
  setPaneTabStripWrap: (v: boolean) => void;
  /** Automatically reveal a selected pane chip that is outside the current
   * horizontal viewport. Off by default: manual scroll position wins. */
  paneTabStripAutoReveal: boolean;
  setPaneTabStripAutoReveal: (v: boolean) => void;
  // Center-surface owner for Claude/Codex PTY tabs. See loader comment above.
  terminalIsPrimary: boolean;
  setTerminalIsPrimary: (v: boolean) => void;
  newTabPrimarySurface: 'history' | 'terminal';
  terminalIsPrimaryTabs: Record<string, boolean>;
  setNewTabPrimarySurface: (surface: 'history' | 'terminal') => void;
  setTabTerminalIsPrimary: (tabId: string, v: boolean) => void;

  // Free-ports toggle. When ON, every npm-script start / restart / stop from a
  // devServer-tab first calls `system:free-project-ports` for the tab's cwd —
  // resolves project's declared ports (vite.config, .env PORT, NestJS main.ts)
  // and kills whatever holds them. Solves "address in use" after a previous run
  // crashed without releasing the port (common after Electron force-quit).
  freePortsBeforeStart: boolean;
  setFreePortsBeforeStart: (v: boolean) => void;

  // Completion notification sound for tab bell. Default ON; persisted globally.
  tabCompletionNotificationSound: boolean;
  setTabCompletionNotificationSound: (v: boolean) => void;

  // Default Claude effort applied to new sessions (status-bar selector).
  // 'none' means "do not apply any default" — current session keeps whatever was last picked.
  defaultClaudeEffort: DefaultClaudeEffort;
  setDefaultClaudeEffort: (v: DefaultClaudeEffort) => void;
  // Default Claude model applied to new Claude PTY sessions. 'none' means no
  // startup /model command; 'default' is a real Claude model alias.
  defaultClaudeModel: DefaultClaudeModel;
  setDefaultClaudeModel: (v: DefaultClaudeModel) => void;
  claudeCodeSettings: ClaudeCodeSettings;
  setClaudeCodeSettings: (settings: ClaudeCodeSettings) => void;
  // Default Codex launch overrides. 'none' means "let Codex read ~/.codex/config.toml".
  // Per-tab Codex model/effort still wins over these defaults.
  defaultCodexModel: DefaultCodexModel;
  setDefaultCodexModel: (v: DefaultCodexModel) => void;
  defaultCodexEffort: DefaultCodexEffort;
  setDefaultCodexEffort: (v: DefaultCodexEffort) => void;
  // Manual display/order settings. Actual availability is still reconciled
  // with the account-scoped `codex debug models` catalog at use sites.
  codexSettings: CodexSettings;
  setCodexSettings: (settings: CodexSettings) => void;

  // Notes Panel — per-tab slide-in. `notesPanelOpenTabs` holds tab IDs for
  // which the panel is currently expanded. Size is shared across tabs and
  // persists via SQLite (so it survives dev-port shuffles).
  notesPanelOpenTabs: Record<string, boolean>;
  setNotesPanelOpen: (tabId: string, open: boolean) => void;
  notesPanelSize: { width: number; height: number };
  setNotesPanelSize: (size: { width: number; height: number }) => void;
  // Vertical offset from the default anchor (bottom of the Open trigger button).
  // 0 = модалка сидит низом ровно на нижней кромке кнопки Open. Отрицательные значения
  // двигают модалку вверх, положительные — вниз. Сохраняется в localStorage + SQLite
  // (тем же путём, что и notesPanelSize), чтобы position переживала перезапуски.
  notesPanelOffsetY: number;
  setNotesPanelOffsetY: (offset: number) => void;
  // Last-known cursor head position per tab. Used to restore selection when
  // slideout is reopened — без этого editor unmount'ится на close и selection
  // сбрасывается на 0, юзер видит «курсор всегда в начало».
  notesPanelSelectionByTab: Record<string, number>;
  setNotesPanelSelection: (tabId: string, head: number) => void;

  // Tab Preview popover (CMD+hover на табах + Home-карточках). Width + maxLines
  // фиксируются в Settings, дополнительно поверх живёт пользовательский
  // resize (live-drag на правом / нижнем / угловом handle popover'а) который
  // апдейтит те же поля. См. useUIStore.tabPreview*.
  // Превью CMD+hover: ширина = ПОТОЛОК переноса текста, задаётся resize-ручкой
  // на самом превью (как у заметок), персистится. Высота динамическая (построчно
  // под контент), скроллится при упоре в tabPreviewMaxHeight ИЛИ при нехватке
  // места до края экрана. Ширина — `tabPreviewMaxWidth`: в Settings показывается
  // disabled (юзер меняет её только перетаскиванием правого края превью).
  // См. fact-tab-preview-popover.md `Sizing`.
  tabPreviewMaxWidth: number;
  setTabPreviewMaxWidth: (px: number) => void;
  tabPreviewMaxHeight: number;
  setTabPreviewMaxHeight: (px: number) => void;

  // Notes Editor — три независимых шрифта для трёх поверхностей tab.notes:
  //   notesSidebarFontSize  — inline-превью в InfoPanel сайдбара
  //   notesExpandedFontSize — раскрытый slide-out (TabNotesSlideout)
  //   notesTooltipFontSize  — CMD+hover tab-preview popover
  // Padding X/Y — общие для всех (визуальные отступы редактора).
  notesSidebarFontSize: number;
  setNotesSidebarFontSize: (size: number) => void;
  notesExpandedFontSize: number;
  setNotesExpandedFontSize: (size: number) => void;
  notesTooltipFontSize: number;
  setNotesTooltipFontSize: (size: number) => void;
  notesEditorPaddingX: number;
  setNotesEditorPaddingX: (px: number) => void;
  notesEditorPaddingY: number;
  setNotesEditorPaddingY: (px: number) => void;
  // Show line-number gutter, independent per surface:
  //   notesEditorShowLineNumbers  — раскрытый slide-out редактор (TabNotesSlideout)
  //   notesPreviewShowLineNumbers — CMD+hover tab-preview popover (TabPreviewPopover)
  // Default true (= прежнее поведение, package default showLineNumbers=true).
  notesEditorShowLineNumbers: boolean;
  setNotesEditorShowLineNumbers: (on: boolean) => void;
  notesPreviewShowLineNumbers: boolean;
  setNotesPreviewShowLineNumbers: (on: boolean) => void;

  // Параллелизм семантической индексации — сколько Codex worker'ов запускает
  // MCP docs_reindex. Default 10, диапазон 1-20.
  semanticIndexParallelism: number;
  setSemanticIndexParallelism: (n: number) => void;
  semanticAutoIndexTitles: boolean;
  setSemanticAutoIndexTitles: (on: boolean) => void;
  semanticAutoIndexIterations: boolean;
  setSemanticAutoIndexIterations: (on: boolean) => void;

  // CLAUDE.md mirror toggle. ON = main process переписывает AGENTS.md/GEMINI.md
  // в корне каждого открытого проекта при правке CLAUDE.md, и обратно перезатирает
  // если правят сами mirror'ы. Off-by-default — авто-копирование никогда не должно
  // случаться неожиданно. Persist через app:setState (SQLite, vite-port-stable).
  claudeMdMirrorEnabled: boolean;
  setClaudeMdMirrorEnabled: (on: boolean) => void;

  // Which visible surface owns keyboard-scoped tab commands. This is not
  // persisted: it is the last explicit click in the current window, not part
  // of the durable workspace layout.
  activeArea: 'projects' | 'sidebar' | 'workspace';
  setActiveArea: (area: 'projects' | 'sidebar' | 'workspace') => void;
}

export const resolveTabTerminalPrimary = (
  state: Pick<UIStore, 'terminalIsPrimaryTabs' | 'newTabPrimarySurface'>,
  tabId: string,
): boolean => state.terminalIsPrimaryTabs[tabId]
  ?? (state.newTabPrimarySurface === 'terminal');



// Load font settings from localStorage

const loadFontSettings = () => {

  try {

    const saved = localStorage.getItem('noted-terminal-font-settings');

    if (saved) {

      const parsed = JSON.parse(saved);

      // Migration from old format

      return {

        terminalFontSize: parsed.terminalFontSize ?? 13,

        tabsFontSize: parsed.tabsFontSize ?? parsed.mainTabsFontSize ?? 14,

        projectTabsFontSize: parsed.projectTabsFontSize ?? 12,

        sidebarFontSize: parsed.sidebarFontSize ?? 13

      };

    }

  } catch (e) {

    console.error('Failed to load font settings:', e);

  }

  return { terminalFontSize: 13, tabsFontSize: 14, projectTabsFontSize: 12, sidebarFontSize: 13 };

};



// Load editor settings from localStorage (from gt-editor)

const loadEditorSettings = () => {

  try {

    const saved = localStorage.getItem('noted-terminal-editor-settings');

    if (saved) {

      const parsed = JSON.parse(saved);

      return {

        wordWrap: parsed.wordWrap ?? true,

        confirmDelete: parsed.confirmDelete ?? true,

        iconTheme: parsed.iconTheme ?? 'vscode'

      };

    }

  } catch (e) {

    console.error('Failed to load editor settings:', e);

  }

  return { wordWrap: true, confirmDelete: true, iconTheme: 'vscode' as const };

};



const saveEditorSettings = (settings: { wordWrap: boolean; confirmDelete: boolean; iconTheme: 'vscode' | 'emoji' }) => {

  try {

    localStorage.setItem('noted-terminal-editor-settings', JSON.stringify(settings));

  } catch (e) {

    console.error('Failed to save editor settings:', e);

  }

};



// Load AI model from localStorage

const loadSelectedModel = (): AIModel => {

  try {

    const saved = localStorage.getItem('noted-terminal-ai-model');

    if (isGeminiModelId(saved)) {

      return saved as AIModel;

    }

  } catch (e) {

    console.error('Failed to load AI model:', e);

  }

  return 'gemini-3-flash-preview';

};



const saveSelectedModel = (model: AIModel) => {

  try {

    localStorage.setItem('noted-terminal-ai-model', model);

  } catch (e) {

    console.error('Failed to save AI model:', e);

  }

};



// Load/save thinking level

const loadThinkingLevel = (): ThinkingLevel => {

  try {

    const saved = localStorage.getItem('noted-terminal-thinking-level');

    if (saved && ['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(saved)) {

      return saved as ThinkingLevel;

    }

  } catch (e) {

    console.error('Failed to load thinking level:', e);

  }

  return 'HIGH'; // Default to HIGH

};



const saveThinkingLevel = (level: ThinkingLevel) => {

  try {

    localStorage.setItem('noted-terminal-thinking-level', level);

  } catch (e) {

    console.error('Failed to save thinking level:', e);

  }

};




const saveFontSettings = (settings: { terminalFontSize: number; tabsFontSize: number; projectTabsFontSize: number; sidebarFontSize: number }) => {
  try {
    localStorage.setItem('noted-terminal-font-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save font settings:', e);
  }
};

const initialFontSettings = loadFontSettings();

const loadFilePreviewFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-file-preview-font-size');
    if (v) return Math.max(10, Math.min(24, Number(v) || 13));
  } catch {}
  return 13;
};

const FILE_PREVIEW_SCROLL_KEY = 'noted-terminal-file-preview-scroll';

const loadFilePreviewScrollMemory = (): FilePreviewScrollMemory => {
  try {
    const raw = localStorage.getItem(FILE_PREVIEW_SCROLL_KEY);
    if (raw) return readScrollMemory(JSON.parse(raw));
  } catch {}
  return {};
};

const saveFilePreviewScrollMemory = (memory: FilePreviewScrollMemory) => {
  try { localStorage.setItem(FILE_PREVIEW_SCROLL_KEY, JSON.stringify(memory)); } catch {}
};

const loadPromptPickerFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-picker-font-size');
    if (v) return Math.max(9, Math.min(20, Number(v) || 12));
  } catch {}
  return 12;
};

const loadPromptPickerBottomOffsetPx = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-picker-bottom-offset');
    if (v !== null && v !== undefined && v !== '') {
      return Math.max(0, Math.min(400, Number(v) || 50));
    }
  } catch {}
  return 50;
};

const loadPromptPickerLeftOffsetPx = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-picker-left-offset');
    if (v !== null && v !== undefined && v !== '') {
      return Math.max(0, Math.min(2000, Number(v) || 0));
    }
  } catch {}
  return 0;
};

const loadPromptPickerRightOffsetPx = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-picker-right-offset');
    if (v !== null && v !== undefined && v !== '') {
      return Math.max(0, Math.min(2000, Number(v) || 0));
    }
  } catch {}
  return 0;
};

const loadTimelineFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-timeline-font-size');
    if (v) return Math.max(10, Math.min(18, Number(v) || 12));
  } catch {}
  return 12;
};

const loadTimelineSummaryFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-timeline-summary-font-size');
    if (v) return Math.max(10, Math.min(22, Number(v) || 13));
  } catch {}
  return 13;
};

// Width applied when treeMode is on (expanded layout with chip + preview).
// Drag-resizable via handle on Timeline's left edge.
const loadTimelineWidth = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-timeline-width');
    if (v) return Math.max(160, Math.min(600, Number(v) || 220));
  } catch {}
  return 220;
};

const loadTimelineLineClamp = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-timeline-line-clamp');
    if (v) return Math.max(1, Math.min(10, Number(v) || 3));
  } catch {}
  return 3;
};
const loadHistoryFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-history-font-size');
    if (v) return Math.max(8, Math.min(24, Math.round(Number(v) || 13)));
  } catch {}
  return 13;
};
const loadHistoryComposerFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-history-composer-font-size');
    if (v) return Math.max(8, Math.min(24, Number(v) || 12));
  } catch {}
  return 12;
};
const loadAiSecondaryFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-ai-secondary-font-size');
    if (v) return Math.max(8, Math.min(18, Math.round(Number(v) || 11)));
  } catch {}
  return 11;
};
const loadHistoryMarkdownCodeMaxLines = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-history-markdown-code-max-lines');
    if (v) return Math.max(5, Math.min(100, Math.round(Number(v) || 30)));
  } catch {}
  return 30;
};
const loadHistoryComposerMinRows = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-history-composer-min-rows');
    if (v) return Math.max(1, Math.min(20, Math.round(Number(v) || 3)));
  } catch {}
  return 3;
};
const loadHistoryComposerMaxRows = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-history-composer-max-rows');
    if (v) return Math.max(1, Math.min(40, Math.round(Number(v) || 20)));
  } catch {}
  return 20;
};
// Stacked panes are short by construction, so the composer starts at ONE row
// there and grows to this ceiling instead of the full-height one.
const loadStackedComposerMaxRows = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-stacked-composer-max-rows');
    if (v) return Math.max(1, Math.min(20, Math.round(Number(v) || 3)));
  } catch {}
  return 3;
};
const loadAiComposerChipThreshold = (): number => {
  try {
    const value = localStorage.getItem('noted-terminal-ai-composer-chip-threshold');
    if (value !== null) return normalizeComposerChipThreshold(value);
  } catch {}
  return DEFAULT_AI_COMPOSER_CHIP_THRESHOLD;
};
const initialHistoryComposerMinRows = loadHistoryComposerMinRows();
const initialHistoryComposerMaxRows = Math.max(initialHistoryComposerMinRows, loadHistoryComposerMaxRows());
const loadPromptQueueChipLineClamp = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-chip-line-clamp');
    if (v) return Math.max(1, Math.min(10, Number(v) || 1));
  } catch {}
  return 1;
};
const loadPromptQueueChipFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-chip-font-size');
    if (v) return Math.max(9, Math.min(18, Number(v) || 11));
  } catch {}
  return 11;
};
const loadPromptQueueEditorFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-editor-font-size');
    if (v) return Math.max(10, Math.min(24, Number(v) || 12));
  } catch {}
  return 12;
};
// Run-after overlay is now a single compact column. Existing user-resized
// values remain valid, while fresh installs default to half the old width.
// Border-mounted Post / Loop / add / meta controls remain a single readable
// row at the minimum. A narrower panel physically cannot expose all four hit
// targets without overlap, so resize clamps at their measured compact width.
const PROMPT_QUEUE_WIDTH_MIN = 168;
const PROMPT_QUEUE_WIDTH_MAX = 600;
const loadPromptQueueWidth = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-width');
    if (v) return Math.max(PROMPT_QUEUE_WIDTH_MIN, Math.min(PROMPT_QUEUE_WIDTH_MAX, Number(v) || 150));
  } catch {}
  return 150;
};
const initialEditorSettings = loadEditorSettings();
const initialModel = loadSelectedModel();
const initialThinkingLevel = loadThinkingLevel();

const loadClaudeDefaultPromptEnabled = (): boolean => {
  try {
    const saved = localStorage.getItem('noted-terminal-claude-default-prompt-enabled');
    if (saved !== null) return saved === 'true';
  } catch (e) {
    console.error('Failed to load claude default prompt enabled:', e);
  }
  return true; // Enabled by default
};

const saveClaudeDefaultPromptEnabled = (enabled: boolean) => {
  try {
    localStorage.setItem('noted-terminal-claude-default-prompt-enabled', String(enabled));
  } catch (e) {
    console.error('Failed to save claude default prompt enabled:', e);
  }
};

const initialClaudeDefaultPromptEnabled = loadClaudeDefaultPromptEnabled();

// Copy settings v3: message kinds + provider-neutral semantic action families.
// Legacy Claude/Bash/Tools fields stay readable during migration/HMR skew, but
// the public UI and current exporters use Actions + Read/Search/Edit/Run/Git/
// MCP/Web/Plan/Other. Detail families default mostly OFF so an upgrade cannot
// suddenly put hundreds of KB of tool output into the clipboard.
type CopySettings = {
  copySettingsVersion: number;
  copyIncludeEditing: boolean;
  copyIncludeReading: boolean;
  copyFromStart: boolean;
  copyIncludeSubagentResult: boolean;
  copyIncludeSubagentHistory: boolean;
  copyIncludeUser: boolean;
  copyIncludeClaude: boolean;
  copyIncludeText: boolean;
  copyIncludeThinking: boolean;
  copyIncludeActions: boolean;
  copyIncludeSearch: boolean;
  copyIncludeRun: boolean;
  copyIncludeGit: boolean;
  copyIncludeMcp: boolean;
  copyIncludePlan: boolean;
  copyIncludeBash: boolean;
  copyIncludeTools: boolean;
  copyIncludeWebSearch: boolean;
  copyIncludeToolSearch: boolean;
  copyIncludeOtherTools: boolean;
};

const loadCopySettings = (): CopySettings => {
  try {
    const saved = localStorage.getItem('noted-terminal-copy-settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      const semanticV3 = Number(parsed.copySettingsVersion || 0) >= 3
        || Object.prototype.hasOwnProperty.call(parsed, 'copyIncludeActions');
      const legacyAgentEnabled = parsed.copyIncludeClaude ?? true;
      return {
        copySettingsVersion: 3,
        copyIncludeEditing: parsed.copyIncludeEditing ?? true,
        copyIncludeReading: parsed.copyIncludeReading ?? false,
        copyFromStart: parsed.copyFromStart ?? true,
        copyIncludeSubagentResult: parsed.copyIncludeSubagentResult ?? false,
        copyIncludeSubagentHistory: parsed.copyIncludeSubagentHistory ?? false,
        copyIncludeUser: parsed.copyIncludeUser ?? true,
        copyIncludeClaude: parsed.copyIncludeClaude ?? true,
        copyIncludeText: semanticV3 ? (parsed.copyIncludeText ?? true) : (legacyAgentEnabled && (parsed.copyIncludeText ?? true)),
        copyIncludeThinking: semanticV3 ? (parsed.copyIncludeThinking ?? true) : (legacyAgentEnabled && (parsed.copyIncludeThinking ?? true)),
        copyIncludeActions: semanticV3 ? (parsed.copyIncludeActions ?? true) : legacyAgentEnabled,
        // v2 put local search, Git and every remaining command behind one
        // Bash transport toggle. Preserve that user's chosen DEPTH while
        // splitting it into semantic action families.
        copyIncludeSearch: parsed.copyIncludeSearch ?? parsed.copyIncludeBash ?? false,
        copyIncludeRun: parsed.copyIncludeRun ?? parsed.copyIncludeBash ?? false,
        copyIncludeGit: parsed.copyIncludeGit ?? parsed.copyIncludeBash ?? false,
        copyIncludeMcp: parsed.copyIncludeMcp ?? parsed.copyIncludeTools ?? false,
        copyIncludePlan: parsed.copyIncludePlan ?? parsed.copyIncludeToolSearch ?? parsed.copyIncludeOtherTools ?? false,
        copyIncludeBash: parsed.copyIncludeBash ?? false,
        copyIncludeTools: parsed.copyIncludeTools ?? false,
        copyIncludeWebSearch: parsed.copyIncludeWebSearch ?? parsed.copyIncludeTools ?? false,
        copyIncludeToolSearch: parsed.copyIncludeToolSearch ?? parsed.copyIncludeTools ?? false,
        copyIncludeOtherTools: parsed.copyIncludeOtherTools ?? parsed.copyIncludeToolSearch ?? parsed.copyIncludeTools ?? false,
      };
    }
  } catch (e) {
    console.error('Failed to load copy settings:', e);
  }
  return {
    copySettingsVersion: 3,
    copyIncludeEditing: true, copyIncludeReading: false, copyFromStart: true,
    copyIncludeSubagentResult: false, copyIncludeSubagentHistory: false,
    copyIncludeUser: true, copyIncludeClaude: true,
    copyIncludeText: true, copyIncludeThinking: true,
    copyIncludeActions: true,
    copyIncludeSearch: false, copyIncludeRun: false, copyIncludeGit: false,
    copyIncludeMcp: false, copyIncludePlan: false,
    copyIncludeBash: false, copyIncludeTools: false,
    copyIncludeWebSearch: false, copyIncludeToolSearch: false, copyIncludeOtherTools: false,
  };
};

const saveCopySettings = (settings: Partial<CopySettings>) => {
  try {
    let prev = {};
    try {
      prev = JSON.parse(localStorage.getItem('noted-terminal-copy-settings') || '{}');
    } catch {
      prev = {};
    }
    localStorage.setItem('noted-terminal-copy-settings', JSON.stringify({ ...prev, ...settings, copySettingsVersion: 3 }));
  } catch (e) {
    console.error('Failed to save copy settings:', e);
  }
};

const initialCopySettings = loadCopySettings();

const parsePersistedBool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true';

// Status-bar toggles (persisted).
// SQLite-backed via app:setState — same migration pattern as defaultClaudeEffort
// and freePortsBeforeStart. localStorage stays as fast initial-paint cache, SQLite
// is authoritative on hydrate. Without SQLite the toggle would reset whenever
// vite swaps dev-server origin (5181 → 5182…) and localStorage scopes by origin.
const APP_STATE_KEY_BRIDGES = 'debugHoverBridges';
const loadDebugHoverBridges = (): boolean => {
  try { return localStorage.getItem('noted-terminal-debug-hover-bridges') === 'true'; }
  catch { return false; }
};
const saveDebugHoverBridges = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-debug-hover-bridges', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_BRIDGES, value: v }).catch(() => {});
  } catch {}
};
const initialDebugHoverBridges = loadDebugHoverBridges();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_BRIDGES);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().debugHoverBridges !== bool) {
        useUIStore.setState({ debugHoverBridges: bool });
        try { localStorage.setItem('noted-terminal-debug-hover-bridges', String(bool)); } catch {}
      }
    }
  } catch {}
})();

const APP_STATE_KEY_STREAMER_MODE = 'streamerMode';
const LOCAL_KEY_STREAMER_MODE = 'noted-terminal-streamer-mode';
const loadStreamerMode = (): boolean => {
  try { return localStorage.getItem(LOCAL_KEY_STREAMER_MODE) === 'true'; }
  catch { return false; }
};
const saveStreamerMode = (v: boolean) => {
  try { localStorage.setItem(LOCAL_KEY_STREAMER_MODE, String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_STREAMER_MODE, value: v }).catch(() => {});
  } catch {}
};
const initialStreamerMode = loadStreamerMode();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_STREAMER_MODE);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().streamerMode !== bool) {
        useUIStore.setState({ streamerMode: bool });
        try { localStorage.setItem(LOCAL_KEY_STREAMER_MODE, String(bool)); } catch {}
      }
    }
  } catch {}
})();

const APP_STATE_KEY_PROJECT_ICONS_GRAYSCALE = 'projectIconsGrayscalePreview';
const LOCAL_KEY_PROJECT_ICONS_GRAYSCALE = 'noted-terminal-project-icons-grayscale-preview';
const loadProjectIconsGrayscalePreview = (): boolean => {
  try {
    const saved = localStorage.getItem(LOCAL_KEY_PROJECT_ICONS_GRAYSCALE);
    return saved === null ? true : saved !== 'false';
  } catch { return true; }
};
const saveProjectIconsGrayscalePreview = (v: boolean) => {
  try { localStorage.setItem(LOCAL_KEY_PROJECT_ICONS_GRAYSCALE, String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_PROJECT_ICONS_GRAYSCALE, value: v }).catch(() => {});
  } catch {}
};
const syncProjectIconsGrayscalePreviewDom = (v: boolean) => {
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.projectIconsGrayscale = v ? 'true' : 'false';
    }
  } catch {}
};
const initialProjectIconsGrayscalePreview = loadProjectIconsGrayscalePreview();
syncProjectIconsGrayscalePreviewDom(initialProjectIconsGrayscalePreview);
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_PROJECT_ICONS_GRAYSCALE);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().projectIconsGrayscalePreview !== bool) {
        useUIStore.setState({ projectIconsGrayscalePreview: bool });
        try { localStorage.setItem(LOCAL_KEY_PROJECT_ICONS_GRAYSCALE, String(bool)); } catch {}
      }
      syncProjectIconsGrayscalePreviewDom(bool);
    }
  } catch {}
})();

const LOCAL_KEY_TERMINAL_HISTORY_STREAMING = 'noted-terminal-terminal-history-streaming';
const loadTerminalHistoryStreamingEnabled = (): boolean => {
  try {
    const saved = localStorage.getItem(LOCAL_KEY_TERMINAL_HISTORY_STREAMING);
    return saved === null ? true : saved !== 'false';
  } catch { return true; }
};
const saveTerminalHistoryStreamingEnabled = (enabled: boolean) => {
  try { localStorage.setItem(LOCAL_KEY_TERMINAL_HISTORY_STREAMING, String(enabled)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('agent-transcript:set-terminal-preview-enabled', {
      enabled,
      source: 'ai-composer-toggle',
    }).catch(() => {});
  } catch {}
};
const initialTerminalHistoryStreamingEnabled = loadTerminalHistoryStreamingEnabled();

// freePortsBeforeStart — SQLite-backed (vite-port-stable). Same migration pattern as
// defaultClaudeEffort (localStorage initial → async SQLite override).
const APP_STATE_KEY_FREE_PORTS = 'freePortsBeforeStart';
const loadFreePortsBeforeStart = (): boolean => {
  try { return localStorage.getItem('noted-terminal-free-ports') === 'true'; }
  catch { return false; }
};
const saveFreePortsBeforeStart = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-free-ports', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_FREE_PORTS, value: v }).catch(() => {});
  } catch {}
};
const initialFreePortsBeforeStart = loadFreePortsBeforeStart();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_FREE_PORTS);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().freePortsBeforeStart !== bool) {
        useUIStore.setState({ freePortsBeforeStart: bool });
        try { localStorage.setItem('noted-terminal-free-ports', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// tabCompletionNotificationSound — global UX preference for the tab-completion
// bell. Default is ON; persisted in SQLite so it survives vite origin changes.
const APP_STATE_KEY_TAB_COMPLETION_SOUND = 'tabCompletionNotificationSound';
const LOCAL_KEY_TAB_COMPLETION_SOUND = 'noted-terminal-tab-completion-notification-sound';
const loadTabCompletionNotificationSound = (): boolean => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_TAB_COMPLETION_SOUND);
    return raw === null ? true : raw === 'true';
  } catch { return true; }
};
const saveTabCompletionNotificationSound = (v: boolean) => {
  try { localStorage.setItem(LOCAL_KEY_TAB_COMPLETION_SOUND, String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_TAB_COMPLETION_SOUND, value: v }).catch(() => {});
  } catch {}
};
const initialTabCompletionNotificationSound = loadTabCompletionNotificationSound();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TAB_COMPLETION_SOUND);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().tabCompletionNotificationSound !== bool) {
        useUIStore.setState({ tabCompletionNotificationSound: bool });
        try { localStorage.setItem(LOCAL_KEY_TAB_COMPLETION_SOUND, String(bool)); } catch {}
      }
    }
  } catch {}
})();

// freezeCmdPopups — status-bar diagnostic toggle. It is user-controlled state, so
// it must survive app restarts in SQLite; localStorage is only a synchronous boot
// mirror for the first paint.
const APP_STATE_KEY_FREEZE_CMD_POPUPS = 'freezeCmdPopups';
const loadFreezeCmdPopups = (): boolean => {
  try { return localStorage.getItem('noted-terminal-freeze-cmd-popups') === 'true'; }
  catch { return false; }
};
const saveFreezeCmdPopups = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-freeze-cmd-popups', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_FREEZE_CMD_POPUPS, value: v }).catch(() => {});
  } catch {}
};
const initialFreezeCmdPopups = loadFreezeCmdPopups();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_FREEZE_CMD_POPUPS);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().freezeCmdPopups !== bool) {
        useUIStore.setState({ freezeCmdPopups: bool });
        try { localStorage.setItem('noted-terminal-freeze-cmd-popups', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// timelinePinned — global layout mode: expanded Timeline reserves real
// horizontal space instead of overlaying the terminal.
const APP_STATE_KEY_TIMELINE_PINNED = 'timelinePinned';
const loadTimelinePinned = (): boolean => {
  try { return localStorage.getItem('noted-terminal-timeline-pinned') === 'true'; }
  catch { return false; }
};
const saveTimelinePinned = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-timeline-pinned', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_TIMELINE_PINNED, value: v }).catch(() => {});
  } catch {}
};
const initialTimelinePinned = loadTimelinePinned();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TIMELINE_PINNED);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().timelinePinned !== bool) {
        useUIStore.setState({ timelinePinned: bool });
        try { localStorage.setItem('noted-terminal-timeline-pinned', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// paneTabStripWrap — «Перенос вкладок»: полоса чипов в шапке окна переносит
// строки вместо горизонтальной прокрутки. Та же двойная запись, что у
// timelinePinned: localStorage для мгновенного старта + SQLite-зеркало, чтобы
// настройка переживала смену dev-порта.
const APP_STATE_KEY_PANE_STRIP_WRAP = 'paneTabStripWrap';
const loadPaneTabStripWrap = (): boolean => {
  try { return localStorage.getItem('noted-terminal-pane-strip-wrap') === 'true'; }
  catch { return false; }
};
const savePaneTabStripWrap = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-pane-strip-wrap', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_PANE_STRIP_WRAP, value: v }).catch(() => {});
  } catch {}
};
const initialPaneTabStripWrap = loadPaneTabStripWrap();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_PANE_STRIP_WRAP);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().paneTabStripWrap !== bool) {
        useUIStore.setState({ paneTabStripWrap: bool });
        try { localStorage.setItem('noted-terminal-pane-strip-wrap', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// Optional automatic reveal of a selected pane chip. Default OFF: selecting a
// tab must not rewrite a manually chosen horizontal position unless the user
// explicitly opts into that behaviour from the strip's ⋮ menu.
const APP_STATE_KEY_PANE_STRIP_AUTO_REVEAL = 'paneTabStripAutoReveal';
const loadPaneTabStripAutoReveal = (): boolean => {
  try { return localStorage.getItem('noted-terminal-pane-strip-auto-reveal') === 'true'; }
  catch { return false; }
};
const savePaneTabStripAutoReveal = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-pane-strip-auto-reveal', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_PANE_STRIP_AUTO_REVEAL, value: v }).catch(() => {});
  } catch {}
};
const initialPaneTabStripAutoReveal = loadPaneTabStripAutoReveal();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_PANE_STRIP_AUTO_REVEAL);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().paneTabStripAutoReveal !== bool) {
        useUIStore.setState({ paneTabStripAutoReveal: bool });
        try { localStorage.setItem('noted-terminal-pane-strip-auto-reveal', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// historyPinned — global layout mode for Cmd+] / Option+] HistoryPanel. Defaults to the
// legacy combined timelinePinned value so users keep their previous layout.
const APP_STATE_KEY_HISTORY_PINNED = 'historyPinned';
const loadHistoryPinned = (): boolean => {
  try {
    const own = localStorage.getItem('noted-terminal-history-pinned');
    if (own !== null) return own === 'true';
    return loadTimelinePinned();
  } catch { return false; }
};
const saveHistoryPinned = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-history-pinned', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_HISTORY_PINNED, value: v }).catch(() => {});
  } catch {}
};
const initialHistoryPinned = loadHistoryPinned();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    let v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_HISTORY_PINNED);
    if (v === null || v === undefined) {
      v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TIMELINE_PINNED);
    }
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().historyPinned !== bool) {
        useUIStore.setState({ historyPinned: bool });
        try { localStorage.setItem('noted-terminal-history-pinned', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// Legacy global center-surface preference. Kept as a migration seed and for
// older consumers; Workspace resolves the owner from the per-tab map below.
const APP_STATE_KEY_TERMINAL_PRIMARY = 'terminalIsPrimary';
const loadTerminalIsPrimary = (): boolean => {
  try {
    return localStorage.getItem('noted-terminal-terminal-primary') === 'true';
  } catch { return false; }
};
const saveTerminalIsPrimary = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-terminal-primary', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_TERMINAL_PRIMARY, value: v }).catch(() => {});
  } catch {}
};
const initialTerminalIsPrimary = loadTerminalIsPrimary();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TERMINAL_PRIMARY);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().terminalIsPrimary !== bool) {
        useUIStore.setState({ terminalIsPrimary: bool });
        try { localStorage.setItem('noted-terminal-terminal-primary', String(bool)); } catch {}
      }
    }
  } catch {}
})();

type PrimarySurface = 'history' | 'terminal';
const APP_STATE_KEY_NEW_TAB_PRIMARY_SURFACE = 'newTabPrimarySurface';
const APP_STATE_KEY_TERMINAL_PRIMARY_TABS = 'terminalIsPrimaryTabs';
const APP_STATE_KEY_SIDE_TERMINAL_WIDTH = 'sideTerminalWidth';
const APP_STATE_KEY_SIDE_TERMINAL_OPEN_TABS = 'sideTerminalOpenTabs';
// Which project the Run after picker shows. Durable and changed ONLY by a
// click on a project chip: "I work over here" is a standing context, unlike
// the show-all toggle next to it, which is a one-off "show me more right now"
// and therefore never persists.
const APP_STATE_KEY_RUN_AFTER_PICKER_PROJECT = 'runAfterPickerProjectId';
// Side TRANSCRIPT open-state, the twin of the side-terminal map above. Both
// halves of the Cmd+] pair must survive a restart, otherwise the restored
// layout is only half the one the user left.
const APP_STATE_KEY_HISTORY_PANEL_OPEN_TABS = 'historyPanelOpenTabs';
const LS_NEW_TAB_PRIMARY_SURFACE = 'noted-terminal-new-tab-primary-surface';
const LS_TERMINAL_PRIMARY_TABS = 'noted-terminal-terminal-primary-tabs';
const LS_SIDE_TERMINAL_WIDTH = 'noted-terminal-side-terminal-width';
const LS_SIDE_TERMINAL_OPEN_TABS = 'noted-terminal-side-terminal-open-tabs';
const LS_RUN_AFTER_PICKER_PROJECT = 'noted-terminal-run-after-picker-project';
const LS_HISTORY_PANEL_OPEN_TABS = 'noted-terminal-history-panel-open-tabs';
const SIDE_TERMINAL_MIN_WIDTH = 360;
const SIDE_TERMINAL_MAX_WIDTH = 1200;

const parsePrimarySurface = (value: unknown): PrimarySurface | null => (
  value === 'history' || value === 'terminal' ? value : null
);
const sanitizeTerminalPrimaryTabs = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => (
    typeof entry[1] === 'boolean'
  )));
};
const clampSideTerminalWidth = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 620;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(SIDE_TERMINAL_MIN_WIDTH, Math.min(SIDE_TERMINAL_MAX_WIDTH, parsed))
    : 620;
};
const readLocalHistoryPanelOpenTabs = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(LS_HISTORY_PANEL_OPEN_TABS);
    return raw ? sanitizeTerminalPrimaryTabs(JSON.parse(raw)) : {};
  } catch { return {}; }
};
const readLocalPrimarySurface = (): PrimarySurface | null => {
  try { return parsePrimarySurface(localStorage.getItem(LS_NEW_TAB_PRIMARY_SURFACE)); }
  catch { return null; }
};
const readLocalTerminalPrimaryTabs = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(LS_TERMINAL_PRIMARY_TABS);
    return raw ? sanitizeTerminalPrimaryTabs(JSON.parse(raw)) : {};
  } catch { return {}; }
};
const readLocalSideTerminalWidth = (): number => {
  try { return clampSideTerminalWidth(localStorage.getItem(LS_SIDE_TERMINAL_WIDTH)); }
  catch { return 620; }
};
const readLocalSideTerminalOpenTabs = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(LS_SIDE_TERMINAL_OPEN_TABS);
    return raw ? sanitizeTerminalPrimaryTabs(JSON.parse(raw)) : {};
  } catch { return {}; }
};
const saveNewTabPrimarySurface = (surface: PrimarySurface) => {
  try { localStorage.setItem(LS_NEW_TAB_PRIMARY_SURFACE, surface); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_NEW_TAB_PRIMARY_SURFACE, value: surface }).catch(() => {});
  } catch {}
};
const saveTerminalPrimaryTabs = (tabs: Record<string, boolean>) => {
  try { localStorage.setItem(LS_TERMINAL_PRIMARY_TABS, JSON.stringify(tabs)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_TERMINAL_PRIMARY_TABS, value: tabs }).catch(() => {});
  } catch {}
};
const saveSideTerminalWidth = (width: number) => {
  try { localStorage.setItem(LS_SIDE_TERMINAL_WIDTH, String(width)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_SIDE_TERMINAL_WIDTH, value: width }).catch(() => {});
  } catch {}
};
const saveHistoryPanelOpenTabs = (tabs: Record<string, boolean>) => {
  try { localStorage.setItem(LS_HISTORY_PANEL_OPEN_TABS, JSON.stringify(tabs)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_HISTORY_PANEL_OPEN_TABS, value: tabs }).catch(() => {});
  } catch {}
};
const readLocalRunAfterPickerProject = (): string | null => {
  try { return localStorage.getItem(LS_RUN_AFTER_PICKER_PROJECT) || null; }
  catch { return null; }
};
const saveRunAfterPickerProject = (projectId: string | null) => {
  try {
    if (projectId) localStorage.setItem(LS_RUN_AFTER_PICKER_PROJECT, projectId);
    else localStorage.removeItem(LS_RUN_AFTER_PICKER_PROJECT);
  } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_RUN_AFTER_PICKER_PROJECT, value: projectId }).catch(() => {});
  } catch {}
};
const saveSideTerminalOpenTabs = (tabs: Record<string, boolean>) => {
  try { localStorage.setItem(LS_SIDE_TERMINAL_OPEN_TABS, JSON.stringify(tabs)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_SIDE_TERMINAL_OPEN_TABS, value: tabs }).catch(() => {});
  } catch {}
};

const localPrimarySurface = readLocalPrimarySurface();
const initialNewTabPrimarySurface: PrimarySurface = localPrimarySurface
  ?? (initialTerminalIsPrimary ? 'terminal' : 'history');
const initialTerminalPrimaryTabs = readLocalTerminalPrimaryTabs();
const initialSideTerminalWidth = readLocalSideTerminalWidth();
const initialSideTerminalOpenTabs = readLocalSideTerminalOpenTabs();
const initialHistoryPanelOpenTabs = readLocalHistoryPanelOpenTabs();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = parsePrimarySurface(await ipcRenderer.invoke('app:getState', APP_STATE_KEY_NEW_TAB_PRIMARY_SURFACE));
    if (persisted) {
      useUIStore.setState({ newTabPrimarySurface: persisted });
      try { localStorage.setItem(LS_NEW_TAB_PRIMARY_SURFACE, persisted); } catch {}
      return;
    }
    if (localPrimarySurface) {
      saveNewTabPrimarySurface(localPrimarySurface);
      return;
    }
    const legacy = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TERMINAL_PRIMARY);
    const seeded: PrimarySurface = legacy !== null && legacy !== undefined && parsePersistedBool(legacy)
      ? 'terminal'
      : 'history';
    useUIStore.setState({ newTabPrimarySurface: seeded });
    saveNewTabPrimarySurface(seeded);
  } catch {}
})();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_RUN_AFTER_PICKER_PROJECT);
    if (typeof persisted === 'string' && persisted) {
      useUIStore.setState({ runAfterPickerProjectId: persisted });
      try { localStorage.setItem(LS_RUN_AFTER_PICKER_PROJECT, persisted); } catch {}
    }
  } catch {}
})();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_TERMINAL_PRIMARY_TABS);
    if (persisted !== null && persisted !== undefined) {
      const tabs = sanitizeTerminalPrimaryTabs(persisted);
      useUIStore.setState({ terminalIsPrimaryTabs: tabs });
      try { localStorage.setItem(LS_TERMINAL_PRIMARY_TABS, JSON.stringify(tabs)); } catch {}
    } else if (Object.keys(initialTerminalPrimaryTabs).length > 0) {
      saveTerminalPrimaryTabs(initialTerminalPrimaryTabs);
    }
  } catch {}
})();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_SIDE_TERMINAL_WIDTH);
    if (persisted !== null && persisted !== undefined) {
      const width = clampSideTerminalWidth(persisted);
      useUIStore.setState({ sideTerminalWidth: width });
      try { localStorage.setItem(LS_SIDE_TERMINAL_WIDTH, String(width)); } catch {}
    } else {
      saveSideTerminalWidth(initialSideTerminalWidth);
    }
  } catch {}
})();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_SIDE_TERMINAL_OPEN_TABS);
    if (persisted !== null && persisted !== undefined) {
      const tabs = sanitizeTerminalPrimaryTabs(persisted);
      useUIStore.setState({ sideTerminalOpenTabs: tabs });
      try { localStorage.setItem(LS_SIDE_TERMINAL_OPEN_TABS, JSON.stringify(tabs)); } catch {}
    } else if (Object.keys(initialSideTerminalOpenTabs).length > 0) {
      saveSideTerminalOpenTabs(initialSideTerminalOpenTabs);
    }
  } catch {}
})();

(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const persisted = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_HISTORY_PANEL_OPEN_TABS);
    if (persisted && typeof persisted === 'object') {
      const tabs = sanitizeTerminalPrimaryTabs(persisted);
      useUIStore.setState({ historyPanelOpenTabs: tabs });
      try { localStorage.setItem(LS_HISTORY_PANEL_OPEN_TABS, JSON.stringify(tabs)); } catch {}
    } else if (Object.keys(initialHistoryPanelOpenTabs).length > 0) {
      saveHistoryPanelOpenTabs(initialHistoryPanelOpenTabs);
    }
  } catch {}
})();

const APP_STATE_KEY_SEMANTIC_AUTO_TITLES = 'semanticAutoIndexTitles';
const APP_STATE_KEY_SEMANTIC_AUTO_TITLES_SINCE = 'semanticAutoIndexTitlesSince';
const APP_STATE_KEY_SEMANTIC_AUTO_ITERATIONS = 'semanticAutoIndexIterations';
const APP_STATE_KEY_SEMANTIC_AUTO_ITERATIONS_SINCE = 'semanticAutoIndexIterationsSince';
const LS_SEMANTIC_AUTO_TITLES = 'noted-terminal-semantic-auto-title-index';
const LS_SEMANTIC_AUTO_TITLES_SINCE = 'noted-terminal-semantic-auto-title-index-since';
const LS_SEMANTIC_AUTO_ITERATIONS = 'noted-terminal-semantic-auto-iteration-index';
const LS_SEMANTIC_AUTO_ITERATIONS_SINCE = 'noted-terminal-semantic-auto-iteration-index-since';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const saveSemanticAutoIndexSetting = (key: string, sinceKey: string, localKey: string, localSinceKey: string, on: boolean) => {
  const since = on ? nowSeconds() : 0;
  try { localStorage.setItem(localSinceKey, String(since)); } catch {}
  try { localStorage.setItem(localKey, String(on)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: sinceKey, value: since }).catch(() => {});
    ipcRenderer.invoke('app:setState', { key, value: on }).catch(() => {});
  } catch {}
};
const initialSemanticAutoIndexTitles = (() => {
  try { return localStorage.getItem(LS_SEMANTIC_AUTO_TITLES) === 'true'; }
  catch { return false; }
})();
const initialSemanticAutoIndexIterations = (() => {
  try { return localStorage.getItem(LS_SEMANTIC_AUTO_ITERATIONS) === 'true'; }
  catch { return false; }
})();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_SEMANTIC_AUTO_TITLES);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().semanticAutoIndexTitles !== bool) {
        useUIStore.setState({ semanticAutoIndexTitles: bool });
        try { localStorage.setItem(LS_SEMANTIC_AUTO_TITLES, String(bool)); } catch {}
      }
    }
  } catch {}
})();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_SEMANTIC_AUTO_ITERATIONS);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().semanticAutoIndexIterations !== bool) {
        useUIStore.setState({ semanticAutoIndexIterations: bool });
        try { localStorage.setItem(LS_SEMANTIC_AUTO_ITERATIONS, String(bool)); } catch {}
      }
    }
  } catch {}
})();

// claudeMdMirrorEnabled — SQLite-backed по тем же причинам что и freePortsBeforeStart
// (localStorage привязан к vite-origin → теряется при смене порта).
// Main процесс читает тот же ключ из app_state на старте, чтобы знать про тогл до
// первого IPC из renderer'а.
const APP_STATE_KEY_MIRROR = 'claudeMdMirrorEnabled';
const loadMirrorEnabled = (): boolean => {
  try { return localStorage.getItem('noted-terminal-claude-md-mirror') === 'true'; }
  catch { return false; }
};
const saveMirrorEnabled = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-claude-md-mirror', String(v)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    // Зеркалим в SQLite через общий app:setState — main процесс читает то же.
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_MIRROR, value: v }).catch(() => {});
    // И триггерим main, чтобы он сразу применил флаг (включил/выключил writes).
    ipcRenderer.invoke('mirror:set-enabled', { enabled: v }).catch(() => {});
  } catch {}
};
const initialMirrorEnabled = loadMirrorEnabled();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_MIRROR);
    if (v !== null && v !== undefined) {
      const bool = parsePersistedBool(v);
      if (useUIStore.getState().claudeMdMirrorEnabled !== bool) {
        useUIStore.setState({ claudeMdMirrorEnabled: bool });
        try { localStorage.setItem('noted-terminal-claude-md-mirror', String(bool)); } catch {}
      }
    }
  } catch {}
})();

// localStorage is bound to vite dev-server origin (http://localhost:5181 vs 5182…).
// When orphan Electron instances push vite to a different port, the new origin has
// empty localStorage — user sees "max disappeared". Move persistence to SQLite via
// app:setState so it survives across origins and restarts unconditionally.
const APP_STATE_KEY_EFFORT = 'defaultClaudeEffort';
const loadDefaultClaudeEffort = (): DefaultClaudeEffort => {
  // Fallback to localStorage so existing users don't lose their setting on first load;
  // we'll migrate it into SQLite on the first set. Async load below overrides this.
  try {
    let saved = localStorage.getItem('noted-terminal-default-claude-effort');
    // Legacy migration: Claude removed 'auto' in May 2026 and added 'xhigh'.
    // Old persisted values: map 'auto' → 'low' (the new toggle-off-equivalent).
    if (saved === 'auto') saved = 'low';
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return 'none';
};
const saveDefaultClaudeEffort = (v: DefaultClaudeEffort) => {
  try { localStorage.setItem('noted-terminal-default-claude-effort', v); } catch {}
  // Authoritative: SQLite (origin-independent, survives any vite port reshuffle).
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_EFFORT, value: v }).catch(() => {});
  } catch {}
};
const initialDefaultClaudeEffort = loadDefaultClaudeEffort();
// Async upgrade: pull authoritative value from SQLite on startup and overwrite the
// localStorage-derived initial value if they differ.
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    let v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_EFFORT);
    if (v === 'auto') v = 'low'; // legacy migration — Claude dropped 'auto' May 2026
    if (typeof v === 'string' && v.trim()) {
      // Use the store's setter so the change propagates to all subscribers.
      // Importing here would be circular; reach into the store after it's defined below
      // — useUIStore.setState exists by the time this IIFE awaits.
      const s = useUIStore.getState();
      if (s.defaultClaudeEffort !== v) {
        // Bypass save (we just read from SQLite) — write only to localStorage mirror.
        useUIStore.setState({ defaultClaudeEffort: v.trim() });
        try { localStorage.setItem('noted-terminal-default-claude-effort', v); } catch {}
      }
    }
  } catch {}
})();

const APP_STATE_KEY_MODEL = 'defaultClaudeModel';
const loadDefaultClaudeModel = (): DefaultClaudeModel => {
  // Same persistence shape as defaultClaudeEffort: localStorage is only the
  // synchronous boot mirror; SQLite is authoritative and origin-independent.
  try {
    const saved = localStorage.getItem('noted-terminal-default-claude-model');
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return 'none';
};
const saveDefaultClaudeModel = (v: DefaultClaudeModel) => {
  try { localStorage.setItem('noted-terminal-default-claude-model', v); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_MODEL, value: v }).catch(() => {});
  } catch {}
};
const initialDefaultClaudeModel = loadDefaultClaudeModel();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_MODEL);
    if (typeof v === 'string' && v.trim()) {
      const s = useUIStore.getState();
      if (s.defaultClaudeModel !== v) {
        useUIStore.setState({ defaultClaudeModel: v.trim() });
        try { localStorage.setItem('noted-terminal-default-claude-model', v); } catch {}
      }
    }
  } catch {}
})();

const APP_STATE_KEY_CODEX_MODEL = 'defaultCodexModel';
const loadDefaultCodexModel = (): DefaultCodexModel => {
  try {
    const saved = localStorage.getItem('noted-terminal-default-codex-model');
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return 'none';
};
const saveDefaultCodexModel = (v: DefaultCodexModel) => {
  try { localStorage.setItem('noted-terminal-default-codex-model', v); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CODEX_MODEL, value: v }).catch(() => {});
  } catch {}
};
const initialDefaultCodexModel = loadDefaultCodexModel();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CODEX_MODEL);
    if (typeof v === 'string' && v.trim()) {
      const s = useUIStore.getState();
      if (s.defaultCodexModel !== v) {
        useUIStore.setState({ defaultCodexModel: v.trim() });
        try { localStorage.setItem('noted-terminal-default-codex-model', v); } catch {}
      }
    }
  } catch {}
})();

const APP_STATE_KEY_CODEX_EFFORT = 'defaultCodexEffort';
const normalizePersistentCodexEffort = (value: unknown): DefaultCodexEffort => {
  const effort = typeof value === 'string' ? value.trim() : '';
  return effort && effort !== 'ultra' ? effort : 'none';
};
const loadDefaultCodexEffort = (): DefaultCodexEffort => {
  try {
    const saved = localStorage.getItem('noted-terminal-default-codex-effort');
    if (saved && saved.trim()) return normalizePersistentCodexEffort(saved);
  } catch {}
  return 'none';
};
const saveDefaultCodexEffort = (v: DefaultCodexEffort) => {
  const persistentEffort = normalizePersistentCodexEffort(v);
  try { localStorage.setItem('noted-terminal-default-codex-effort', persistentEffort); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CODEX_EFFORT, value: persistentEffort }).catch(() => {});
  } catch {}
};
const initialDefaultCodexEffort = loadDefaultCodexEffort();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CODEX_EFFORT);
    if (typeof v === 'string' && v.trim()) {
      const persistentEffort = normalizePersistentCodexEffort(v);
      const s = useUIStore.getState();
      if (s.defaultCodexEffort !== persistentEffort) {
        useUIStore.setState({ defaultCodexEffort: persistentEffort });
        try { localStorage.setItem('noted-terminal-default-codex-effort', persistentEffort); } catch {}
      }
    }
  } catch {}
})();

// Main owns the durable transaction for native Codex model migration. Renderer
// only mirrors that committed/pending value into Zustand + localStorage; using
// the public setters here would issue a second unconditional app:setState and
// could race a newer main-process commit.
export const syncDefaultCodexSettingsMirror = ({
  model,
  effort,
  expectedModel,
  expectedEffort,
}: {
  model?: DefaultCodexModel;
  effort?: DefaultCodexEffort;
  expectedModel?: DefaultCodexModel;
  expectedEffort?: DefaultCodexEffort;
}) => {
  const current = useUIStore.getState();
  const modelAccepted = model !== undefined
    && expectedModel !== undefined
    && current.defaultCodexModel === expectedModel;
  const effortAccepted = effort !== undefined
    && expectedEffort !== undefined
    && current.defaultCodexEffort === expectedEffort;

  if (modelAccepted) {
    useUIStore.setState({ defaultCodexModel: model });
    try { localStorage.setItem('noted-terminal-default-codex-model', model); } catch {}
  }
  if (effortAccepted) {
    const persistentEffort = normalizePersistentCodexEffort(effort);
    useUIStore.setState({ defaultCodexEffort: persistentEffort });
    try { localStorage.setItem('noted-terminal-default-codex-effort', persistentEffort); } catch {}
  }
  return {
    modelUpdated: modelAccepted,
    effortUpdated: effortAccepted,
  };
};

const APP_STATE_KEY_CODEX_SETTINGS = 'codexSettings';
const LOCAL_KEY_CODEX_SETTINGS = 'noted-terminal-codex-settings';
const normalizeCodexSettings = (raw: unknown): CodexSettings => {
  const obj = raw && typeof raw === 'object' ? raw as Partial<CodexSettings> : {};
  const rawModels = Array.isArray(obj.models) ? obj.models : [];
  const effortOptions = normalizeCodexEffortOptions(obj.effortOptions, obj.efforts);
  const availableEfforts = new Set(effortOptions.map((option) => option.id));
  const removedModelIds = normalizeCodexRemovedModelIds(obj.removedModelIds);
  const removed = new Set(removedModelIds);
  const legacyDefaultOrder = [
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
  ];
  const canonicalOrder = DEFAULT_CODEX_SETTINGS.models.map((model) => model.id);
  let models = normalizeCodexModelOptions(rawModels, !removed.has(DEFAULT_CODEX_MODEL))
    .filter((model) => !removed.has(model.id))
    .map((model) => ({
      ...model,
      efforts: (model.efforts || []).filter((effort) => availableEfforts.has(effort)),
      supportedEfforts: (model.supportedEfforts || []).filter((effort) => availableEfforts.has(effort)),
    }));
  // The original built-in order put 5.5 first. Move untouched legacy settings
  // to the current catalog order without disturbing a user-made custom order.
  if (
    rawModels.length === legacyDefaultOrder.length
    && rawModels.every((model: any, index) => String(model?.id || '').trim() === legacyDefaultOrder[index])
  ) {
    const rank = new Map(canonicalOrder.map((id, index) => [id, index]));
    models = [...models].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const requestedQuickModel = typeof obj.quickModel === 'string' ? obj.quickModel.trim() : '';
  const quickModel = requestedQuickModel && models.some((model) => model.id === requestedQuickModel)
    ? requestedQuickModel
    : null;
  const quickEffort = quickModel
    ? resolveCodexPersistentEffortForModel(models.find((model) => model.id === quickModel), obj.quickEffort)
    : null;
  return {
    models,
    effortOptions,
    efforts: effortOptions.map((option) => option.id),
    quickModel,
    quickEffort,
    removedModelIds,
  };
};
const loadCodexSettings = (): CodexSettings => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_CODEX_SETTINGS);
    if (raw) return normalizeCodexSettings(JSON.parse(raw));
  } catch {}
  return normalizeCodexSettings(DEFAULT_CODEX_SETTINGS);
};
let codexSettingsMutationVersion = 0;
const saveCodexSettings = (settings: CodexSettings) => {
  codexSettingsMutationVersion += 1;
  const normalized = normalizeCodexSettings(settings);
  try { localStorage.setItem(LOCAL_KEY_CODEX_SETTINGS, JSON.stringify(normalized)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CODEX_SETTINGS, value: normalized }).catch(() => {});
  } catch {}
};
const initialCodexSettings = loadCodexSettings();
const initialCodexSettingsMutationVersion = codexSettingsMutationVersion;
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CODEX_SETTINGS);
    if (v !== null && v !== undefined && codexSettingsMutationVersion === initialCodexSettingsMutationVersion) {
      const normalized = normalizeCodexSettings(v);
      useUIStore.getState().setCodexSettings(normalized);
      try { localStorage.setItem(LOCAL_KEY_CODEX_SETTINGS, JSON.stringify(normalized)); } catch {}
    }
  } catch {}
})();

const APP_STATE_KEY_CLAUDE_CODE_SETTINGS = 'claudeCodeSettings';
const LOCAL_KEY_CLAUDE_CODE_SETTINGS = 'noted-terminal-claude-code-settings';

const loadClaudeCodeSettings = (): ClaudeCodeSettings => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_CLAUDE_CODE_SETTINGS);
    if (raw) return normalizeClaudeCodeSettings(JSON.parse(raw));
  } catch {}
  return normalizeClaudeCodeSettings(DEFAULT_CLAUDE_CODE_SETTINGS);
};

let claudeCodeSettingsMutationVersion = 0;
const saveClaudeCodeSettings = (settings: ClaudeCodeSettings) => {
  claudeCodeSettingsMutationVersion += 1;
  const normalized = normalizeClaudeCodeSettings(settings);
  try { localStorage.setItem(LOCAL_KEY_CLAUDE_CODE_SETTINGS, JSON.stringify(normalized)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CLAUDE_CODE_SETTINGS, value: normalized }).catch(() => {});
  } catch {}
};

const initialClaudeCodeSettings = loadClaudeCodeSettings();
const initialClaudeCodeSettingsMutationVersion = claudeCodeSettingsMutationVersion;
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CLAUDE_CODE_SETTINGS);
    if (v !== null && v !== undefined && claudeCodeSettingsMutationVersion === initialClaudeCodeSettingsMutationVersion) {
      const normalized = normalizeClaudeCodeSettings(v);
      // Use the public setter so a hydrated model/effort pair stays coherent.
      useUIStore.getState().setClaudeCodeSettings(normalized);
    }
  } catch {}
})();

// Hydrate the Notes-Editor-Modal sizing knobs from SQLite — same pattern as effort
// above. localStorage gives the synchronous boot value; SQLite is the authoritative
// store that survives dev-port shuffles (each vite port is a separate origin and
// gets its own localStorage bucket).
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const [padX, padY] = await Promise.all([
      ipcRenderer.invoke('app:getState', 'notesEditorPaddingX'),
      ipcRenderer.invoke('app:getState', 'notesEditorPaddingY'),
    ]);
    const patch: Partial<{ notesEditorPaddingX: number; notesEditorPaddingY: number }> = {};
    const px = Number(padX);
    const py = Number(padY);
    if (Number.isFinite(px) && px >= 0 && px <= 48) patch.notesEditorPaddingX = px;
    if (Number.isFinite(py) && py >= 0 && py <= 48) patch.notesEditorPaddingY = py;
    if (Object.keys(patch).length > 0) {
      useUIStore.setState(patch);
      if (patch.notesEditorPaddingX != null) localStorage.setItem('noted-terminal-notes-editor-padding-x', String(patch.notesEditorPaddingX));
      if (patch.notesEditorPaddingY != null) localStorage.setItem('noted-terminal-notes-editor-padding-y', String(patch.notesEditorPaddingY));
    }
  } catch {}
})();

// Hydrate Tab-preview width (resizable via drag on the popover's right edge) from SQLite.
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', 'tabPreviewMaxWidth');
    const n = Number(v);
    if (Number.isFinite(n)) {
      const w = Math.max(120, Math.min(900, n));
      if (useUIStore.getState().tabPreviewMaxWidth !== w) {
        useUIStore.setState({ tabPreviewMaxWidth: w });
        try { localStorage.setItem('noted-terminal-tab-preview-max-width', String(w)); } catch {}
      }
    }
  } catch {}
})();

// Hydrate Notes Panel size (slide-in resizable panel) from SQLite.
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', 'notesPanelSize');
    if (v && typeof v === 'object' && Number.isFinite(Number(v.width)) && Number.isFinite(Number(v.height))) {
      const w = Math.max(240, Math.min(1200, Number(v.width)));
      const h = Math.max(180, Math.min(900, Number(v.height)));
      const cur = useUIStore.getState().notesPanelSize;
      if (cur.width !== w || cur.height !== h) {
        useUIStore.setState({ notesPanelSize: { width: w, height: h } });
        try { localStorage.setItem('noted-terminal-notes-panel-size', JSON.stringify({ width: w, height: h })); } catch {}
      }
    }
  } catch {}
})();

// Hydrate Notes Panel vertical offset (drag-along-Y from Open anchor) from SQLite.
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', 'notesPanelOffsetY');
    const n = Number(v);
    if (Number.isFinite(n)) {
      const cur = useUIStore.getState().notesPanelOffsetY;
      if (cur !== n) {
        useUIStore.setState({ notesPanelOffsetY: n });
        try { localStorage.setItem('noted-terminal-notes-panel-offset-y', String(n)); } catch {}
      }
    }
  } catch {}
})();

const loadSidebarBehavior = (): { sidebarPersistFile: boolean; sidebarOverlayCloseOnClickOutside: boolean } => {
  try {
    const saved = localStorage.getItem('noted-terminal-sidebar-behavior');
    if (saved) {
      const p = JSON.parse(saved);
      return {
        sidebarPersistFile: p.sidebarPersistFile ?? false,
        sidebarOverlayCloseOnClickOutside: p.sidebarOverlayCloseOnClickOutside ?? true,
      };
    }
  } catch {}
  // Defaults match the user's stated preferences:
  //  - sidebar reopen should NOT restore previously open file (persist=false)
  //  - sidebar acts as an overlay, click outside closes it
  return { sidebarPersistFile: false, sidebarOverlayCloseOnClickOutside: true };
};
const saveSidebarBehavior = (s: { sidebarPersistFile: boolean; sidebarOverlayCloseOnClickOutside: boolean }) => {
  try { localStorage.setItem('noted-terminal-sidebar-behavior', JSON.stringify(s)); } catch {}
};
const initialSidebarBehavior = loadSidebarBehavior();

const loadDragAreaWidth = (): number => {
  try {
    const saved = localStorage.getItem('noted-terminal-drag-area-width');
    if (saved) {
      const parsed = Number(saved);
      if (!isNaN(parsed)) return Math.max(80, Math.min(600, parsed));
    }
  } catch (e) {
    console.error('Failed to load drag area width:', e);
  }
  return 300;
};
const initialDragAreaWidth = loadDragAreaWidth();

const HISTORY_COMPOSER_DRAFTS_STORAGE_KEY = 'noted-terminal-history-composer-drafts';

// Автосохранение черновика поля ввода, пока пользователь печатает.
//
// Раньше запись на диск делали только «события»: отправка, уход со вкладки,
// закрытие окна. Пока человек просто печатал, текст жил только в памяти — и
// любое падение или убитый процесс уносили длинный промпт целиком. Юзер: *«всё,
// что находится в инпуте, должно сохраняться в базу, чтобы если приложение
// перезапущу — восстанавливалось всегда всё»*.
//
// Задержка, а не запись на каждую букву: промпты бывают в десятки килобайт, а
// запись синхронно зеркалится в SQLite. Полсекунды покоя — цена, которую
// пользователь не замечает, а платит за неё раз на абзац, а не раз на символ.
// Явные `flush*` остаются и после этого: они гарантируют запись ИМЕННО СЕЙЧАС —
// на закрытии окна ждать полсекунды уже некому.
const COMPOSER_DRAFT_AUTOSAVE_MS = 500;
let composerDraftAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
const initialHistoryComposerDraftState = (() => {
  try {
    const raw = localStorage.getItem(HISTORY_COMPOSER_DRAFTS_STORAGE_KEY);
    return splitComposerDraftMemory(raw ? JSON.parse(raw) : {});
  } catch {
    return splitComposerDraftMemory({});
  }
})();

export const useUIStore = create<UIStore>((set, get) => ({
  // Font Settings
  terminalFontSize: initialFontSettings.terminalFontSize,
  tabsFontSize: initialFontSettings.tabsFontSize,
  projectTabsFontSize: initialFontSettings.projectTabsFontSize,
  sidebarFontSize: initialFontSettings.sidebarFontSize,
  sidebarWidth: (() => { try { const v = localStorage.getItem('sidebarWidth'); return v ? Number(v) : 280; } catch { return 280; } })(),
  tabSidebarWidth: (() => {
    // Clamp при чтении из localStorage: защита от corruption + миграция со старых
    // значений если diapazon (140..400) поменяется. Drag-handle в TabSidebar.tsx
    // тоже клампит, но это вторая линия защиты.
    try {
      const raw = localStorage.getItem('tabSidebarWidth');
      const n = raw ? Number(raw) : 200;
      if (!Number.isFinite(n)) return 200;
      return Math.max(140, Math.min(400, n));
    } catch { return 200; }
  })(),
  storageBrowserExpanded: (() => {
    try { return localStorage.getItem('noted-terminal-storage-browser-expanded') === 'true'; }
    catch { return false; }
  })(),

  sessionStatuses: loadSessionStatuses(),
  setSessionStatuses: (next) => {
    set({ sessionStatuses: next });
    saveSessionStatuses(next);
  },
  addSessionStatus: () => {
    const id = `status-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const next = [...get().sessionStatuses, { id, label: 'Новый статус', color: '#7C7C7C' }];
    set({ sessionStatuses: next });
    saveSessionStatuses(next);
    return id;
  },
  updateSessionStatus: (id, patch) => {
    const next = get().sessionStatuses.map((s) => (s.id === id ? { ...s, ...patch } : s));
    set({ sessionStatuses: next });
    saveSessionStatuses(next);
  },
  removeSessionStatus: (id) => {
    const next = get().sessionStatuses.filter((s) => s.id !== id);
    set({ sessionStatuses: next });
    saveSessionStatuses(next);
  },

  taskStatuses: loadTaskStatuses(),
  setTaskStatuses: (next) => {
    set({ taskStatuses: next });
    saveTaskStatuses(next);
  },
  addTaskStatus: () => {
    const id = `task-status-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const next = [...get().taskStatuses, { id, label: 'Новый статус', color: '#7C7C7C', description: '' }];
    set({ taskStatuses: next });
    saveTaskStatuses(next);
    return id;
  },
  updateTaskStatus: (id, patch) => {
    const next = get().taskStatuses.map((s) => (s.id === id ? { ...s, ...patch } : s));
    set({ taskStatuses: next });
    saveTaskStatuses(next);
  },
  removeTaskStatus: (id) => {
    const next = get().taskStatuses.filter((s) => s.id !== id);
    set({ taskStatuses: next });
    saveTaskStatuses(next);
  },

  processBar: loadProcessBar(),
  setProcessBar: (patch) => {
    const cur = get().processBar;
    const next: ProcessBarSettings = {
      colorA: typeof patch.colorA === 'string' ? patch.colorA : cur.colorA,
      shimmerColor: typeof patch.shimmerColor === 'string' ? patch.shimmerColor : cur.shimmerColor,
      inheritedColor: typeof patch.inheritedColor === 'string' ? patch.inheritedColor : cur.inheritedColor,
      shimmerSpacingPct: typeof patch.shimmerSpacingPct === 'number'
        ? Math.max(20, Math.min(200, Math.round(patch.shimmerSpacingPct)))
        : cur.shimmerSpacingPct,
      shimmerOpacityPct: typeof patch.shimmerOpacityPct === 'number'
        ? Math.max(5, Math.min(100, Math.round(patch.shimmerOpacityPct)))
        : cur.shimmerOpacityPct,
      position: patch.position === 'right' || patch.position === 'left' ? patch.position : cur.position,
    };
    set({ processBar: next });
    saveProcessBar(next);
  },


  statusMarker: loadStatusMarker(),
  setStatusMarker: (patch) => {
    const cur = get().statusMarker;
    const next: StatusMarkerSettings = {
      shape: patch.shape === 'square' || patch.shape === 'dot' ? patch.shape : cur.shape,
      sizePx: typeof patch.sizePx === 'number'
        ? Math.max(4, Math.min(16, Math.round(patch.sizePx)))
        : cur.sizePx,
    };
    set({ statusMarker: next });
    saveStatusMarker(next);
  },

  taskStatusMarker: (() => {
    try {
      const raw = localStorage.getItem('noted-terminal-task-status-marker');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          shape: parsed?.shape === 'square' ? 'square' : 'dot',
          sizePx: typeof parsed?.sizePx === 'number'
            ? Math.max(4, Math.min(16, Math.round(parsed.sizePx)))
            : DEFAULT_STATUS_MARKER.sizePx,
        } as StatusMarkerSettings;
      }
    } catch {}
    return loadStatusMarker();
  })(),
  setTaskStatusMarker: (patch) => {
    const cur = get().taskStatusMarker;
    const next: StatusMarkerSettings = {
      shape: patch.shape === 'square' || patch.shape === 'dot' ? patch.shape : cur.shape,
      sizePx: typeof patch.sizePx === 'number'
        ? Math.max(4, Math.min(16, Math.round(patch.sizePx)))
        : cur.sizePx,
    };
    set({ taskStatusMarker: next });
    try { localStorage.setItem('noted-terminal-task-status-marker', JSON.stringify(next)); } catch {}
  },

  tabGeometry: loadTabGeometry(),
  setTabGeometry: (patch) => {
    const cur = get().tabGeometry;
    const next: TabGeometrySettings = {
      paddingX:     clampInt(patch.paddingX,     cur.paddingX,     0, 32),
      paddingY:     clampInt(patch.paddingY,     cur.paddingY,     0, 24),
      paddingLeft:  clampInt(patch.paddingLeft,  cur.paddingLeft,  4, 48),
      borderRadius: clampInt(patch.borderRadius, cur.borderRadius, 0, 20),
      gap:          clampInt(patch.gap,          cur.gap,          0, 16),
    };
    set({ tabGeometry: next });
    saveTabGeometry(next);
  },

  projectTabGeometry: loadProjectTabGeometry(),
  setProjectTabGeometry: (patch) => {
    const cur = get().projectTabGeometry;
    const next: ProjectTabGeometrySettings = {
      paddingX: clampInt(patch.paddingX, cur.paddingX, 0, 32),
      paddingY: clampInt(patch.paddingY, cur.paddingY, 0, 16),
    };
    set({ projectTabGeometry: next });
    saveProjectTabGeometry(next);
  },

  filePreviewFontSize: loadFilePreviewFontSize(),
  promptPickerFontSize: loadPromptPickerFontSize(),
  promptPickerBottomOffsetPx: loadPromptPickerBottomOffsetPx(),
  promptPickerLeftOffsetPx: loadPromptPickerLeftOffsetPx(),
  promptPickerRightOffsetPx: loadPromptPickerRightOffsetPx(),
  timelineFontSize: loadTimelineFontSize(),
  timelineSummaryFontSize: loadTimelineSummaryFontSize(),
  timelineWidth: loadTimelineWidth(),
  timelineLineClamp: loadTimelineLineClamp(),
  historyFontSize: loadHistoryFontSize(),
  historyComposerFontSize: loadHistoryComposerFontSize(),
  aiSecondaryFontSize: loadAiSecondaryFontSize(),
  historyMarkdownCodeMaxLines: loadHistoryMarkdownCodeMaxLines(),
  historyComposerMinRows: initialHistoryComposerMinRows,
  historyComposerMaxRows: initialHistoryComposerMaxRows,
  stackedComposerMaxRows: loadStackedComposerMaxRows(),
  aiComposerChipThreshold: loadAiComposerChipThreshold(),
  promptQueueChipFontSize: loadPromptQueueChipFontSize(),
  promptQueueEditorFontSize: loadPromptQueueEditorFontSize(),
  promptQueueChipLineClamp: loadPromptQueueChipLineClamp(),
  promptQueueWidth: loadPromptQueueWidth(),

  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
    try { localStorage.setItem('sidebarWidth', String(width)); } catch {}
  },
  setTabSidebarWidth: (width) => {
    // Кламп здесь — defence-in-depth. Drag-handle в TabSidebar.tsx уже клампит
    // на mousemove, но кто-то может позвать action напрямую (через DevTools или
    // программно из тестов). Без clamp юзер получает sidebar 50px или 800px.
    const clamped = Math.max(140, Math.min(400, width));
    set({ tabSidebarWidth: clamped });
    try { localStorage.setItem('tabSidebarWidth', String(clamped)); } catch {}
  },
  setStorageBrowserExpanded: (expanded) => {
    set({ storageBrowserExpanded: expanded });
    try { localStorage.setItem('noted-terminal-storage-browser-expanded', String(expanded)); } catch {}
  },

  setFilePreviewFontSize: (size: number) => {
    const clamped = Math.max(10, Math.min(24, size));
    set({ filePreviewFontSize: clamped });
    try { localStorage.setItem('noted-terminal-file-preview-font-size', String(clamped)); } catch {}
  },

  setPromptPickerFontSize: (size: number) => {
    const clamped = Math.max(9, Math.min(20, size));
    set({ promptPickerFontSize: clamped });
    try { localStorage.setItem('noted-terminal-prompt-picker-font-size', String(clamped)); } catch {}
  },

  setPromptPickerBottomOffsetPx: (px: number) => {
    const clamped = Math.max(0, Math.min(400, Math.round(px)));
    set({ promptPickerBottomOffsetPx: clamped });
    try { localStorage.setItem('noted-terminal-prompt-picker-bottom-offset', String(clamped)); } catch {}
  },
  setPromptPickerLeftOffsetPx: (px: number) => {
    const clamped = Math.max(0, Math.min(2000, Math.round(px)));
    set({ promptPickerLeftOffsetPx: clamped });
    try { localStorage.setItem('noted-terminal-prompt-picker-left-offset', String(clamped)); } catch {}
  },
  setPromptPickerRightOffsetPx: (px: number) => {
    const clamped = Math.max(0, Math.min(2000, Math.round(px)));
    set({ promptPickerRightOffsetPx: clamped });
    try { localStorage.setItem('noted-terminal-prompt-picker-right-offset', String(clamped)); } catch {}
  },

  setTimelineFontSize: (size: number) => {
    const clamped = Math.max(10, Math.min(18, size));
    set({ timelineFontSize: clamped });
    try { localStorage.setItem('noted-terminal-timeline-font-size', String(clamped)); } catch {}
  },

  setTimelineSummaryFontSize: (size: number) => {
    const clamped = Math.max(10, Math.min(22, size));
    set({ timelineSummaryFontSize: clamped });
    try { localStorage.setItem('noted-terminal-timeline-summary-font-size', String(clamped)); } catch {}
  },

  setTimelineWidth: (width: number) => {
    const clamped = Math.max(160, Math.min(600, Math.round(width)));
    set({ timelineWidth: clamped });
    try { localStorage.setItem('noted-terminal-timeline-width', String(clamped)); } catch {}
  },

  setTimelineLineClamp: (lines: number) => {
    const clamped = Math.max(1, Math.min(10, Math.round(lines)));
    set({ timelineLineClamp: clamped });
    try { localStorage.setItem('noted-terminal-timeline-line-clamp', String(clamped)); } catch {}
  },

  setHistoryFontSize: (size: number) => {
    const clamped = Math.max(8, Math.min(24, Math.round(size)));
    set({ historyFontSize: clamped });
    try { localStorage.setItem('noted-terminal-history-font-size', String(clamped)); } catch {}
  },

  setHistoryComposerFontSize: (size: number) => {
    const clamped = Math.max(8, Math.min(24, Math.round(size)));
    set({ historyComposerFontSize: clamped });
    try { localStorage.setItem('noted-terminal-history-composer-font-size', String(clamped)); } catch {}
  },

  setAiSecondaryFontSize: (size: number) => {
    const clamped = Math.max(8, Math.min(18, Math.round(size)));
    set({ aiSecondaryFontSize: clamped });
    try { localStorage.setItem('noted-terminal-ai-secondary-font-size', String(clamped)); } catch {}
  },

  setHistoryMarkdownCodeMaxLines: (lines: number) => {
    const clamped = Math.max(5, Math.min(100, Math.round(lines)));
    set({ historyMarkdownCodeMaxLines: clamped });
    try {
      localStorage.setItem('noted-terminal-history-markdown-code-max-lines', String(clamped));
    } catch {}
  },

  setHistoryComposerMinRows: (rows: number) => {
    const clamped = Math.max(1, Math.min(20, Math.round(rows)));
    const currentMax = get().historyComposerMaxRows;
    const nextMax = Math.max(currentMax, clamped);
    set({ historyComposerMinRows: clamped, historyComposerMaxRows: nextMax });
    try {
      localStorage.setItem('noted-terminal-history-composer-min-rows', String(clamped));
      if (nextMax !== currentMax) {
        localStorage.setItem('noted-terminal-history-composer-max-rows', String(nextMax));
      }
    } catch {}
  },

  setStackedComposerMaxRows: (rows: number) => {
    const clamped = Math.max(1, Math.min(20, Math.round(rows)));
    set({ stackedComposerMaxRows: clamped });
    try {
      localStorage.setItem('noted-terminal-stacked-composer-max-rows', String(clamped));
    } catch {}
  },

  setHistoryComposerMaxRows: (rows: number) => {
    const clamped = Math.max(get().historyComposerMinRows, Math.min(40, Math.round(rows)));
    set({ historyComposerMaxRows: clamped });
    try { localStorage.setItem('noted-terminal-history-composer-max-rows', String(clamped)); } catch {}
  },

  setAiComposerChipThreshold: (characters: number) => {
    const normalized = normalizeComposerChipThreshold(characters);
    set({ aiComposerChipThreshold: normalized });
    try {
      localStorage.setItem('noted-terminal-ai-composer-chip-threshold', String(normalized));
    } catch {}
  },

  setPromptQueueChipFontSize: (size: number) => {
    const clamped = Math.max(9, Math.min(18, Math.round(size)));
    set({ promptQueueChipFontSize: clamped });
    try { localStorage.setItem('noted-terminal-prompt-queue-chip-font-size', String(clamped)); } catch {}
  },

  setPromptQueueEditorFontSize: (size: number) => {
    const clamped = Math.max(10, Math.min(24, Math.round(size)));
    set({ promptQueueEditorFontSize: clamped });
    try { localStorage.setItem('noted-terminal-prompt-queue-editor-font-size', String(clamped)); } catch {}
  },

  setPromptQueueChipLineClamp: (lines: number) => {
    const clamped = Math.max(1, Math.min(10, Math.round(lines)));
    set({ promptQueueChipLineClamp: clamped });
    try { localStorage.setItem('noted-terminal-prompt-queue-chip-line-clamp', String(clamped)); } catch {}
  },

  setPromptQueueWidth: (width: number) => {
    const clamped = Math.max(PROMPT_QUEUE_WIDTH_MIN, Math.min(PROMPT_QUEUE_WIDTH_MAX, Math.round(width)));
    set({ promptQueueWidth: clamped });
    try { localStorage.setItem('noted-terminal-prompt-queue-width', String(clamped)); } catch {}
  },

  // Editor Settings (from gt-editor)
  wordWrap: initialEditorSettings.wordWrap,
  confirmDelete: initialEditorSettings.confirmDelete,
  iconTheme: initialEditorSettings.iconTheme as 'vscode' | 'emoji',

  setWordWrap: (wrap) => {
    set({ wordWrap: wrap });
    const { confirmDelete, iconTheme } = get();
    saveEditorSettings({ wordWrap: wrap, confirmDelete, iconTheme });
  },
  setConfirmDelete: (confirm) => {
    set({ confirmDelete: confirm });
    const { wordWrap, iconTheme } = get();
    saveEditorSettings({ wordWrap, confirmDelete: confirm, iconTheme });
  },
  setIconTheme: (theme) => {
    set({ iconTheme: theme });
    const { wordWrap, confirmDelete } = get();
    saveEditorSettings({ wordWrap, confirmDelete, iconTheme: theme });
  },

  // AI Model Selection
  selectedModel: initialModel,
  setSelectedModel: (model) => {
    set({ selectedModel: model });
    saveSelectedModel(model);
  },

  // Thinking Level
  thinkingLevel: initialThinkingLevel,
  setThinkingLevel: (level) => {
    set({ thinkingLevel: level });
    saveThinkingLevel(level);
  },

  // Claude Default Prompt toggle
  claudeDefaultPromptEnabled: initialClaudeDefaultPromptEnabled,
  setClaudeDefaultPromptEnabled: (enabled) => {
    set({ claudeDefaultPromptEnabled: enabled });
    saveClaudeDefaultPromptEnabled(enabled);
  },

  setTerminalFontSize: (size) => {
    const clamped = Math.max(8, Math.min(24, size));
    set({ terminalFontSize: clamped });
    const { tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize: clamped, tabsFontSize, projectTabsFontSize, sidebarFontSize });
  },
  setTabsFontSize: (size) => {
    const clamped = Math.max(10, Math.min(20, size));
    set({ tabsFontSize: clamped });
    const { terminalFontSize, projectTabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize, tabsFontSize: clamped, projectTabsFontSize, sidebarFontSize });
  },
  setProjectTabsFontSize: (size) => {
    const clamped = Math.max(10, Math.min(16, size));
    set({ projectTabsFontSize: clamped });
    const { terminalFontSize, tabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize, tabsFontSize, projectTabsFontSize: clamped, sidebarFontSize });
  },
  setSidebarFontSize: (size) => {
    const clamped = Math.max(10, Math.min(20, size));
    set({ sidebarFontSize: clamped });
    const { terminalFontSize, tabsFontSize, projectTabsFontSize } = get();
    saveFontSettings({ terminalFontSize, tabsFontSize, projectTabsFontSize, sidebarFontSize: clamped });
  },
  incrementTerminalFontSize: () => {
    const current = get().terminalFontSize;
    const newSize = Math.min(24, current + 1);
    set({ terminalFontSize: newSize });
    const { tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize: newSize, tabsFontSize, projectTabsFontSize, sidebarFontSize });
  },
  decrementTerminalFontSize: () => {
    const current = get().terminalFontSize;
    const newSize = Math.max(8, current - 1);
    set({ terminalFontSize: newSize });
    const { tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize: newSize, tabsFontSize, projectTabsFontSize, sidebarFontSize });
  },
  // Global font size controls (Cmd+/Cmd-)
  incrementAllFontSizes: () => {
    const { terminalFontSize, tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    const newSettings = {
      terminalFontSize: Math.min(24, terminalFontSize + 1),
      tabsFontSize: Math.min(20, tabsFontSize + 1),
      projectTabsFontSize: Math.min(16, projectTabsFontSize + 1),
      sidebarFontSize: Math.min(20, sidebarFontSize + 1)
    };
    set(newSettings);
    saveFontSettings(newSettings);
  },
  decrementAllFontSizes: () => {
    const { terminalFontSize, tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    const newSettings = {
      terminalFontSize: Math.max(8, terminalFontSize - 1),
      tabsFontSize: Math.max(10, tabsFontSize - 1),
      projectTabsFontSize: Math.max(10, projectTabsFontSize - 1),
      sidebarFontSize: Math.max(10, sidebarFontSize - 1)
    };
    set(newSettings);
    saveFontSettings(newSettings);
  },

  // File Explorer
  fileExplorerOpen: false,
  toggleFileExplorer: () => {
    const current = useUIStore.getState().fileExplorerOpen;
    console.log('[UIStore] toggleFileExplorer, current:', current, '-> new:', !current);
    set({ fileExplorerOpen: !current });
  },
  setFileExplorerOpen: (open) => set({ fileExplorerOpen: open }),

  // File Preview
  filePreview: null,
  openFilePreview: (preview) => set({ filePreview: preview }),
  closeFilePreview: () => set({ filePreview: null }),

  // Reading position per file. Deliberately keyed by path rather than by tab:
  // the sidebar opens previews without a tab at all, and the user expects the
  // same file to resume where they left it regardless of how it was opened.
  filePreviewScroll: loadFilePreviewScrollMemory(),
  getFilePreviewScrollTop: (path) => getRememberedScrollTop(get().filePreviewScroll, path),
  setFilePreviewScrollTop: (path, scrollTop) => {
    const current = get().filePreviewScroll;
    const next = rememberScrollTop(current, path, scrollTop, Date.now());
    // Identity means nothing changed — skip the write and the re-render.
    if (next === current) return;
    saveFilePreviewScrollMemory(next);
    set({ filePreviewScroll: next });
  },
  clearFilePreviewScrollTop: (path) => {
    const current = get().filePreviewScroll;
    const next = forgetScrollTop(current, path);
    if (next === current) return;
    saveFilePreviewScrollMemory(next);
    set({ filePreviewScroll: next });
  },

  // Toast Notifications
  toasts: [],
  showToast: (message, type = 'success', duration = 2500, persistent = false, copyText, actionLabel, onAction, tabId, actionIcon, details) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, persistent, copyText, details, actionLabel, onAction, tabId, actionIcon }]
    }));

    if (!persistent) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }
  },
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id)
  })),

  // Prompt picker overlay (Opt+V)
  promptPickerOpen: false,
  setPromptPickerOpen: (open) => set({ promptPickerOpen: open }),

  reopenPulseActive: false,
  triggerReopenPulse: () => {
    set({ reopenPulseActive: true });
    // Auto-clear: 600ms is long enough for two glow cycles to read as
    // "deliberate flash" rather than a stutter, but short enough that the
    // Claude resume handshake (~300-800ms) overlaps with the indicator,
    // closing the perceptual gap from keypress to visible tab.
    if (typeof window !== 'undefined') {
      const w = window as any;
      if (w.__reopenPulseTimer) clearTimeout(w.__reopenPulseTimer);
      w.__reopenPulseTimer = setTimeout(() => {
        useUIStore.setState({ reopenPulseActive: false });
        w.__reopenPulseTimer = null;
      }, 600);
    }
  },

  // History Panel (per-tab state)
	  historyPanelOpenTabs: initialHistoryPanelOpenTabs,
	  historyPanelWidth: (() => {
	    try {
	      const saved = localStorage.getItem('noted-terminal-history-panel-width');
	      return saved ? Math.max(HISTORY_PANEL_MIN_WIDTH, parseInt(saved, 10)) : HISTORY_PANEL_DEFAULT_WIDTH;
	    } catch { return HISTORY_PANEL_DEFAULT_WIDTH; }
	  })(),
  sideTerminalWidth: initialSideTerminalWidth,
  sideTerminalOpenTabs: initialSideTerminalOpenTabs,
  historyScrollToUuid: null,
  historyScrollTargetTabId: null,
  historyVisibleUuids: {},
  historyScrollPositions: {},
  historyPromptDrafts: initialHistoryComposerDraftState.drafts,
  historyPromptDraftImages: initialHistoryComposerDraftState.images,
  historyPromptDraftChips: initialHistoryComposerDraftState.chips,
  historyPromptDraftUpdatedAt: initialHistoryComposerDraftState.updatedAtByTab,
  historyComposerViewByTab: (() => {
    try {
      const raw = localStorage.getItem('noted-terminal-history-composer-view');
      return raw ? readComposerViewMemory(JSON.parse(raw)) : {};
    } catch { return {}; }
  })(),
  historyComposerAvailability: {},
  historyRewindPreviews: {},
  promptQueueInputSurfaceTabs: {},
  setHistoryPanelOpen: (tabId, open) => set(state => {
    if ((state.historyPanelOpenTabs[tabId] ?? false) === open) return state;
    const historyPanelOpenTabs = { ...state.historyPanelOpenTabs, [tabId]: open };
    saveHistoryPanelOpenTabs(historyPanelOpenTabs);
    return { historyPanelOpenTabs };
  }),
  setSideTerminalOpen: (tabId, open) => set(state => {
    if ((state.sideTerminalOpenTabs[tabId] ?? false) === open) return state;
    const sideTerminalOpenTabs = { ...state.sideTerminalOpenTabs, [tabId]: open };
    saveSideTerminalOpenTabs(sideTerminalOpenTabs);
    return { sideTerminalOpenTabs };
  }),
  setPromptQueueInputSurface: (tabId, surface) => set(state => {
    if (state.promptQueueInputSurfaceTabs[tabId] === surface) return state;
    return {
      promptQueueInputSurfaceTabs: {
        ...state.promptQueueInputSurfaceTabs,
        [tabId]: surface,
      },
    };
  }),
  setHistoryScrollToUuid: (uuid, tabId = null) => set(state => {
    const targetTabId = uuid ? (tabId || null) : null;
    if (
      state.historyScrollToUuid === uuid
      && state.historyScrollTargetTabId === targetTabId
    ) return state;
    return {
      historyScrollToUuid: uuid,
      historyScrollTargetTabId: targetTabId,
    };
  }),
  setHistoryVisibleUuids: (tabId, uuids) => set(state => ({
    historyVisibleUuids: { ...state.historyVisibleUuids, [tabId]: uuids }
  })),
  setHistoryScrollPosition: (tabId, scrollTop) => set(state => ({
    historyScrollPositions: { ...state.historyScrollPositions, [tabId]: scrollTop }
  })),
  setHistoryPromptDraft: (tabId, draft, options = {}) => set(state => {
    const nextDrafts = { ...state.historyPromptDrafts };
    if (draft) nextDrafts[tabId] = draft;
    else delete nextDrafts[tabId];

    const shouldTouchImages = !draft || !options.preserveImages || Object.prototype.hasOwnProperty.call(options, 'images');
    const hasExplicitChips = Object.prototype.hasOwnProperty.call(options, 'chips');
    // Full draft replacement clears chip authoring state by default, just as
    // it clears images. Callers that mutate existing text (typing, dictation,
    // image-marker resolution, terminal-draft prepend) must opt in with
    // preserveChips:true. This prevents rewind/rollback/replacement paths from
    // silently retaining chips that belonged to the previous draft.
    const shouldTouchChips = hasExplicitChips || options.preserveChips !== true;

    const patch: Partial<UIStore> = { historyPromptDrafts: nextDrafts };

    if (shouldTouchImages) {
      const nextImages = { ...state.historyPromptDraftImages };
      const images = Array.isArray(options.images)
        ? options.images.filter((ref) => ref && Number.isFinite(Number(ref.id)) && typeof ref.path === 'string' && ref.path.trim())
        : [];
      if (draft && images.length > 0) nextImages[tabId] = images;
      else delete nextImages[tabId];
      patch.historyPromptDraftImages = nextImages;
    }

    if (shouldTouchChips) {
      const nextChips = { ...state.historyPromptDraftChips };
      const chips = hasExplicitChips
        ? normalizeComposerChips(options.chips) as HistoryPromptDraftChip[]
        : [];
      if (chips.length > 0) nextChips[tabId] = chips;
      else delete nextChips[tabId];
      patch.historyPromptDraftChips = nextChips;
    }

    const nextImages = patch.historyPromptDraftImages || state.historyPromptDraftImages;
    const nextChips = patch.historyPromptDraftChips || state.historyPromptDraftChips;
    const nextUpdatedAt = { ...state.historyPromptDraftUpdatedAt };
    if (draft || (nextImages[tabId]?.length || 0) > 0 || (nextChips[tabId]?.length || 0) > 0) {
      nextUpdatedAt[tabId] = Date.now();
    } else {
      delete nextUpdatedAt[tabId];
    }
    patch.historyPromptDraftUpdatedAt = nextUpdatedAt;
    return patch;
  }),
  setHistoryPromptDraftChips: (tabId, chips) => set(state => {
    const next = { ...state.historyPromptDraftChips };
    const normalized = normalizeComposerChips(chips) as HistoryPromptDraftChip[];
    if (normalized.length > 0) next[tabId] = normalized;
    else delete next[tabId];
    const nextUpdatedAt = { ...state.historyPromptDraftUpdatedAt };
    if (normalized.length > 0
        || !!state.historyPromptDrafts[tabId]
        || (state.historyPromptDraftImages[tabId]?.length || 0) > 0) {
      nextUpdatedAt[tabId] = Date.now();
    } else {
      delete nextUpdatedAt[tabId];
    }
    return { historyPromptDraftChips: next, historyPromptDraftUpdatedAt: nextUpdatedAt };
  }),
  addHistoryPromptDraftChip: (tabId, chip) => set(state => {
    const next = { ...state.historyPromptDraftChips };
    const current = state.historyPromptDraftChips[tabId] || [];
    const normalized = upsertComposerChip(current, chip) as HistoryPromptDraftChip[];
    if (normalized.length > 0) next[tabId] = normalized;
    else delete next[tabId];
    return {
      historyPromptDraftChips: next,
      historyPromptDraftUpdatedAt: {
        ...state.historyPromptDraftUpdatedAt,
        [tabId]: Date.now(),
      },
    };
  }),
  removeHistoryPromptDraftChip: (tabId, chipId) => set(state => {
    const next = { ...state.historyPromptDraftChips };
    const normalized = removeComposerChip(
      state.historyPromptDraftChips[tabId] || [],
      chipId,
    ) as HistoryPromptDraftChip[];
    if (normalized.length > 0) next[tabId] = normalized;
    else delete next[tabId];
    const nextUpdatedAt = { ...state.historyPromptDraftUpdatedAt };
    if (normalized.length > 0
        || !!state.historyPromptDrafts[tabId]
        || (state.historyPromptDraftImages[tabId]?.length || 0) > 0) {
      nextUpdatedAt[tabId] = Date.now();
    } else {
      delete nextUpdatedAt[tabId];
    }
    return { historyPromptDraftChips: next, historyPromptDraftUpdatedAt: nextUpdatedAt };
  }),
  appendHistoryPromptDraft: (tabId, text) => set(state => {
    const addition = String(text || '');
    if (!addition) return {};
    const current = state.historyPromptDrafts[tabId] || '';
    const separator = !current
      ? ''
      : current.endsWith('\n\n')
        ? ''
        : current.endsWith('\n')
          ? '\n'
          : '\n\n';
    return {
      historyPromptDrafts: {
        ...state.historyPromptDrafts,
        [tabId]: current + separator + addition,
      },
      historyPromptDraftUpdatedAt: {
        ...state.historyPromptDraftUpdatedAt,
        [tabId]: Date.now(),
      },
    };
  }),
  flushHistoryComposerDrafts: () => {
    // Явный flush отменяет отложенный: он пишет ТО ЖЕ состояние, только сейчас,
    // и оставленный таймер потом переписал бы уже записанное ещё раз.
    if (composerDraftAutosaveTimer !== null) {
      clearTimeout(composerDraftAutosaveTimer);
      composerDraftAutosaveTimer = null;
    }
    const state = get();
    const memory = buildComposerDraftMemory({
      drafts: state.historyPromptDrafts,
      images: state.historyPromptDraftImages,
      chips: state.historyPromptDraftChips,
      updatedAtByTab: state.historyPromptDraftUpdatedAt,
    });
    try {
      // persistedStorage mirrors every noted-terminal-* key to SQLite
      // synchronously, so a clean window close cannot outrun this write.
      localStorage.setItem(HISTORY_COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(memory));
    } catch (cause) {
      console.warn('[HistoryComposerPersistence] save failed:', cause);
    }
  },
  scheduleHistoryComposerDraftSave: () => {
    if (composerDraftAutosaveTimer !== null) clearTimeout(composerDraftAutosaveTimer);
    composerDraftAutosaveTimer = setTimeout(() => {
      composerDraftAutosaveTimer = null;
      get().flushHistoryComposerDrafts();
    }, COMPOSER_DRAFT_AUTOSAVE_MS);
  },
  setHistoryComposerView: (tabId, patch) => set(state => {
    const next = rememberComposerView(state.historyComposerViewByTab, tabId, patch);
    return next === state.historyComposerViewByTab ? {} : { historyComposerViewByTab: next };
  }),
  flushHistoryComposerView: () => {
    try {
      localStorage.setItem(
        'noted-terminal-history-composer-view',
        JSON.stringify(get().historyComposerViewByTab),
      );
    } catch {}
  },
  setHistoryComposerAvailability: (tabId, availability, ownerId) => set(state => {
    const current = state.historyComposerAvailability[tabId];
    if (!availability) {
      // A stale unmount must not clear a newer History owner for the same tab.
      if (!current || current.ownerId !== ownerId) return {};
      const next = { ...state.historyComposerAvailability };
      delete next[tabId];
      return { historyComposerAvailability: next };
    }
    if (
      current
      && current.ownerId === availability.ownerId
      && current.canSend === availability.canSend
      && current.canAcceptSubmitIntent === availability.canAcceptSubmitIntent
      && current.canInterruptTurn === availability.canInterruptTurn
      && current.canPullDraft === availability.canPullDraft
      && current.status === availability.status
      && current.lifecycleGeneration === availability.lifecycleGeneration
      && current.canStopProcess === availability.canStopProcess
    ) {
      return {};
    }
    return {
      historyComposerAvailability: {
        ...state.historyComposerAvailability,
        [tabId]: availability,
      },
    };
  }),
  setHistoryRewindPreview: (tabId, preview) => set(state => {
    const next = { ...state.historyRewindPreviews };
    if (preview) next[tabId] = preview;
    else delete next[tabId];
    return { historyRewindPreviews: next };
  }),

  timelinePanelOpenTabs: {},
  setTimelinePanelOpen: (tabId, open) => set(state => ({
    timelinePanelOpenTabs: { ...state.timelinePanelOpenTabs, [tabId]: open }
  })),

  timelineTreeModeTabs: {},
  setTimelineTreeMode: (tabId, open) => set(state => ({
    timelineTreeModeTabs: { ...state.timelineTreeModeTabs, [tabId]: open }
  })),
	  setHistoryPanelWidth: (width) => {
	    const clamped = Math.max(HISTORY_PANEL_MIN_WIDTH, width);
	    set({ historyPanelWidth: clamped });
	    localStorage.setItem('noted-terminal-history-panel-width', String(clamped));
	  },
  setSideTerminalWidth: (width) => {
    const clamped = clampSideTerminalWidth(width);
    set({ sideTerminalWidth: clamped });
    saveSideTerminalWidth(clamped);
  },

  // Notes Panel Width
  notesPanelWidth: 300,
  setNotesPanelWidth: (width) => set({ notesPanelWidth: Math.max(150, Math.min(600, width)) }),

  // Edit Range Panel Size (clamping done in component based on viewport)
  editRangePanelSize: { width: 380, height: 420 },
  setEditRangePanelSize: (size) => set({ editRangePanelSize: size }),

  // Timeline tooltip width
  timelineTooltipWidth: 300,
  setTimelineTooltipWidth: (width) => set({ timelineTooltipWidth: Math.max(200, Math.min(600, width)) }),

  // Drag Area Width
  dragAreaWidth: initialDragAreaWidth,
  setDragAreaWidth: (width) => {
    const clamped = Math.max(80, Math.min(600, width));
    set({ dragAreaWidth: clamped });
    try {
      localStorage.setItem('noted-terminal-drag-area-width', String(clamped));
    } catch (e) {
      console.error('Failed to save drag area width:', e);
    }
  },

  // Edit Project Modal
  editingProject: null,
  openEditModal: (project) => {
    console.log('[UIStore] openEditModal called with:', project?.name);
    set({ editingProject: project });
  },
  closeEditModal: () => {
    console.log('[UIStore] closeEditModal called');
    set({ editingProject: null });
  },

  // Session Input Modal
  sessionModal: {
    open: false,
    title: '',
    label: '',
    placeholder: '',
    hint: '',
    resolve: null
  },
  showSessionModal: (title, label, placeholder, hint) => {
    return new Promise((resolve) => {
      set({
        sessionModal: {
          open: true,
          title,
          label,
          placeholder,
          hint,
          resolve
        }
      });
    });
  },
  closeSessionModal: (value) => {
    const { sessionModal } = get();
    if (sessionModal.resolve) {
      sessionModal.resolve(value);
    }
    set({
      sessionModal: {
        open: false,
        title: '',
        label: '',
        placeholder: '',
        hint: '',
        resolve: null
      }
    });
  },

  // Sidebar behavior
  sidebarPersistFile: initialSidebarBehavior.sidebarPersistFile,
  sidebarOverlayCloseOnClickOutside: initialSidebarBehavior.sidebarOverlayCloseOnClickOutside,
  setSidebarPersistFile: (v) => {
    set({ sidebarPersistFile: v });
    const { sidebarOverlayCloseOnClickOutside } = get();
    saveSidebarBehavior({ sidebarPersistFile: v, sidebarOverlayCloseOnClickOutside });
  },
  setSidebarOverlayCloseOnClickOutside: (v) => {
    set({ sidebarOverlayCloseOnClickOutside: v });
    const { sidebarPersistFile } = get();
    saveSidebarBehavior({ sidebarPersistFile, sidebarOverlayCloseOnClickOutside: v });
  },

  // Copy Settings
  copyIncludeEditing: initialCopySettings.copyIncludeEditing,
  copyIncludeReading: initialCopySettings.copyIncludeReading,
  copyFromStart: initialCopySettings.copyFromStart,
  copyIncludeSubagentResult: initialCopySettings.copyIncludeSubagentResult,
  copyIncludeSubagentHistory: initialCopySettings.copyIncludeSubagentHistory,
  copyIncludeUser: initialCopySettings.copyIncludeUser,
  copyIncludeClaude: initialCopySettings.copyIncludeClaude,
  copyIncludeText: initialCopySettings.copyIncludeText,
  copyIncludeThinking: initialCopySettings.copyIncludeThinking,
  copyIncludeActions: initialCopySettings.copyIncludeActions,
  copyIncludeSearch: initialCopySettings.copyIncludeSearch,
  copyIncludeRun: initialCopySettings.copyIncludeRun,
  copyIncludeGit: initialCopySettings.copyIncludeGit,
  copyIncludeMcp: initialCopySettings.copyIncludeMcp,
  copyIncludePlan: initialCopySettings.copyIncludePlan,
  copyIncludeBash: initialCopySettings.copyIncludeBash,
  copyIncludeTools: initialCopySettings.copyIncludeTools,
  copyIncludeWebSearch: initialCopySettings.copyIncludeWebSearch,
  copyIncludeToolSearch: initialCopySettings.copyIncludeToolSearch,
  copyIncludeOtherTools: initialCopySettings.copyIncludeOtherTools,
  // Single helper avoids the 11-field re-destructure pattern previously copy-pasted in each setter.
  // Reading get() snapshot AFTER set() ensures we persist the merged state including v.
  setCopyIncludeEditing: (v) => {
    set({ copyIncludeEditing: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeReading: (v) => {
    set({ copyIncludeReading: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyFromStart: (v) => {
    set({ copyFromStart: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeSubagentResult: (v) => {
    // Sub-agent History → Result is incremental: turning Result OFF must turn History OFF too,
    // otherwise the history block has nowhere to anchor in the export.
    set((state) => ({
      copyIncludeSubagentResult: v,
      copyIncludeSubagentHistory: v ? state.copyIncludeSubagentHistory : false,
    }));
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeSubagentHistory: (v) => {
    // History ON implies Result ON (incremental).
    set((state) => ({
      copyIncludeSubagentHistory: v,
      copyIncludeSubagentResult: v ? true : state.copyIncludeSubagentResult,
    }));
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeUser: (v) => {
    set({ copyIncludeUser: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeClaude: (v) => {
    set({ copyIncludeClaude: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeText: (v) => {
    set({ copyIncludeText: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeThinking: (v) => {
    set({ copyIncludeThinking: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeActions: (v) => {
    set({ copyIncludeActions: v });
    saveCopySettings({ copyIncludeActions: v });
  },
  setCopyIncludeSearch: (v) => {
    set({ copyIncludeSearch: v });
    saveCopySettings({ copyIncludeSearch: v });
  },
  setCopyIncludeRun: (v) => {
    set({ copyIncludeRun: v });
    saveCopySettings({ copyIncludeRun: v });
  },
  setCopyIncludeGit: (v) => {
    set({ copyIncludeGit: v });
    saveCopySettings({ copyIncludeGit: v });
  },
  setCopyIncludeMcp: (v) => {
    set({ copyIncludeMcp: v });
    saveCopySettings({ copyIncludeMcp: v });
  },
  setCopyIncludePlan: (v) => {
    set({ copyIncludePlan: v });
    saveCopySettings({ copyIncludePlan: v });
  },
  setCopyIncludeBash: (v) => {
    set({ copyIncludeBash: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeTools: (v) => {
    set({ copyIncludeTools: v });
    const s = get(); saveCopySettings({
      copyIncludeEditing: s.copyIncludeEditing, copyIncludeReading: s.copyIncludeReading, copyFromStart: s.copyFromStart,
      copyIncludeSubagentResult: s.copyIncludeSubagentResult, copyIncludeSubagentHistory: s.copyIncludeSubagentHistory,
      copyIncludeUser: s.copyIncludeUser, copyIncludeClaude: s.copyIncludeClaude,
      copyIncludeText: s.copyIncludeText, copyIncludeThinking: s.copyIncludeThinking,
      copyIncludeBash: s.copyIncludeBash, copyIncludeTools: s.copyIncludeTools,
    });
  },
  setCopyIncludeWebSearch: (v) => {
    set({ copyIncludeWebSearch: v });
    saveCopySettings({ copyIncludeWebSearch: v });
  },
  setCopyIncludeToolSearch: (v) => {
    set({ copyIncludeToolSearch: v });
    saveCopySettings({ copyIncludeToolSearch: v });
  },
  setCopyIncludeOtherTools: (v) => {
    set({ copyIncludeOtherTools: v });
    saveCopySettings({ copyIncludeOtherTools: v });
  },

  // Status bar debug toggles
  debugHoverBridges: initialDebugHoverBridges,
  setDebugHoverBridges: (v) => { set({ debugHoverBridges: v }); saveDebugHoverBridges(v); },
  streamerMode: initialStreamerMode,
  setStreamerMode: (v) => { set({ streamerMode: v }); saveStreamerMode(v); },
  projectIconsGrayscalePreview: initialProjectIconsGrayscalePreview,
  setProjectIconsGrayscalePreview: (v) => {
    set({ projectIconsGrayscalePreview: v });
    syncProjectIconsGrayscalePreviewDom(v);
    saveProjectIconsGrayscalePreview(v);
  },
  terminalHistoryStreamingEnabled: initialTerminalHistoryStreamingEnabled,
  setTerminalHistoryStreamingEnabled: (v) => {
    set({ terminalHistoryStreamingEnabled: v });
    saveTerminalHistoryStreamingEnabled(v);
  },
  freezeCmdPopups: initialFreezeCmdPopups,
  setFreezeCmdPopups: (v) => { set({ freezeCmdPopups: v }); saveFreezeCmdPopups(v); },
  historyPinned: initialHistoryPinned,
  setHistoryPinned: (v) => { set({ historyPinned: v }); saveHistoryPinned(v); },
  runAfterPickerProjectId: readLocalRunAfterPickerProject(),
  setRunAfterPickerProjectId: (projectId) => {
    if (get().runAfterPickerProjectId === projectId) return;
    set({ runAfterPickerProjectId: projectId });
    saveRunAfterPickerProject(projectId);
  },
  timelinePinned: initialTimelinePinned,
  setTimelinePinned: (v) => { set({ timelinePinned: v }); saveTimelinePinned(v); },
  paneTabStripWrap: initialPaneTabStripWrap,
  setPaneTabStripWrap: (v) => { set({ paneTabStripWrap: v }); savePaneTabStripWrap(v); },
  paneTabStripAutoReveal: initialPaneTabStripAutoReveal,
  setPaneTabStripAutoReveal: (v) => {
    set({ paneTabStripAutoReveal: v });
    savePaneTabStripAutoReveal(v);
  },
  terminalIsPrimary: initialTerminalIsPrimary,
  setTerminalIsPrimary: (v) => { set({ terminalIsPrimary: v }); saveTerminalIsPrimary(v); },
  newTabPrimarySurface: initialNewTabPrimarySurface,
  terminalIsPrimaryTabs: initialTerminalPrimaryTabs,
  setNewTabPrimarySurface: (surface) => {
    set({ newTabPrimarySurface: surface });
    saveNewTabPrimarySurface(surface);
  },
  setTabTerminalIsPrimary: (tabId, v) => set((state) => {
    if (state.terminalIsPrimaryTabs[tabId] === v) return state;
    const terminalIsPrimaryTabs = { ...state.terminalIsPrimaryTabs, [tabId]: v };
    saveTerminalPrimaryTabs(terminalIsPrimaryTabs);
    return { terminalIsPrimaryTabs };
  }),

  freePortsBeforeStart: initialFreePortsBeforeStart,
  setFreePortsBeforeStart: (v) => { set({ freePortsBeforeStart: v }); saveFreePortsBeforeStart(v); },
  tabCompletionNotificationSound: initialTabCompletionNotificationSound,
  setTabCompletionNotificationSound: (v) => { set({ tabCompletionNotificationSound: v }); saveTabCompletionNotificationSound(v); },

  claudeMdMirrorEnabled: initialMirrorEnabled,
  setClaudeMdMirrorEnabled: (v) => { set({ claudeMdMirrorEnabled: v }); saveMirrorEnabled(v); },

  // Default Claude effort (status-bar selector)
  defaultClaudeEffort: initialDefaultClaudeEffort,
  setDefaultClaudeEffort: (v) => { set({ defaultClaudeEffort: v }); saveDefaultClaudeEffort(v); },
  defaultClaudeModel: initialDefaultClaudeModel,
  setDefaultClaudeModel: (v) => { set({ defaultClaudeModel: v }); saveDefaultClaudeModel(v); },
  defaultCodexModel: initialDefaultCodexModel,
  setDefaultCodexModel: (v) => { set({ defaultCodexModel: v }); saveDefaultCodexModel(v); },
  defaultCodexEffort: initialDefaultCodexEffort,
  setDefaultCodexEffort: (v) => {
    const persistentEffort = normalizePersistentCodexEffort(v);
    set({ defaultCodexEffort: persistentEffort });
    saveDefaultCodexEffort(persistentEffort);
  },
  codexSettings: initialCodexSettings,
  setCodexSettings: (settings) => {
    const normalized = normalizeCodexSettings(settings);
    const current = get();
    let defaultModel = current.defaultCodexModel;
    let defaultEffort = current.defaultCodexEffort;
    if (defaultModel !== 'none') {
      const nextModel = normalized.models.find((model) => model.id === defaultModel);
      defaultModel = nextModel?.id || 'none';
      if (defaultModel !== 'none' && defaultEffort !== 'none') {
        defaultEffort = resolveCodexPersistentEffortForModel(nextModel, defaultEffort) || 'none';
      }
    }
    set({ codexSettings: normalized, defaultCodexModel: defaultModel, defaultCodexEffort: defaultEffort });
    saveCodexSettings(normalized);
    if (defaultModel !== current.defaultCodexModel) saveDefaultCodexModel(defaultModel);
    if (defaultEffort !== current.defaultCodexEffort) saveDefaultCodexEffort(defaultEffort);
  },
  claudeCodeSettings: initialClaudeCodeSettings,
  setClaudeCodeSettings: (settings) => {
    const normalized = normalizeClaudeCodeSettings(settings);
    const current = get();
    let defaultModel = current.defaultClaudeModel;
    let defaultEffort = current.defaultClaudeEffort;

    if (defaultModel !== 'none') {
      const previousModel = current.claudeCodeSettings.models.find((model) => model.id === defaultModel);
      const nextModel = normalized.models.find((model) => model.id === defaultModel)
        || (previousModel?.key
          ? normalized.models.find((model) => model.key === previousModel.key)
          : undefined)
        || normalized.models.find((model) => model.label.toLowerCase() === defaultModel.toLowerCase());
      defaultModel = nextModel?.id || 'none';
      if (defaultModel !== 'none' && defaultEffort !== 'none') {
        defaultEffort = resolveClaudeEffortForModel(nextModel, defaultEffort) || 'none';
      }
    }

    set({ claudeCodeSettings: normalized, defaultClaudeModel: defaultModel, defaultClaudeEffort: defaultEffort });
    saveClaudeCodeSettings(normalized);
    if (defaultModel !== current.defaultClaudeModel) saveDefaultClaudeModel(defaultModel);
    if (defaultEffort !== current.defaultClaudeEffort) saveDefaultClaudeEffort(defaultEffort);
  },

  // Notes Panel — per-tab open state + SQLite-persisted shared size.
  // One-at-a-time policy: opening on tab X closes any previously-open slideout.
  // Single slideout instance is anchored to ONE tab at a time; the only state
  // we need is "which tab id (or null)".
  notesPanelOpenTabs: {},
  setNotesPanelOpen: (tabId, open) => {
    const cur = get().notesPanelOpenTabs;
    if (open) {
      if (cur[tabId]) return; // already open on this tab
      set({ notesPanelOpenTabs: { [tabId]: true } });
    } else {
      if (!cur[tabId]) return; // already closed
      const next = { ...cur };
      delete next[tabId];
      set({ notesPanelOpenTabs: next });
    }
  },
  notesPanelSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-panel-size');
      if (saved) {
        const p = JSON.parse(saved);
        const w = Number(p.width);
        const h = Number(p.height);
        if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
      }
    } catch {}
    return { width: 400, height: 300 };
  })(),
  setNotesPanelSize: (size) => {
    const w = Math.max(240, Math.min(1200, size.width));
    const h = Math.max(180, Math.min(900, size.height));
    const next = { width: w, height: h };
    set({ notesPanelSize: next });
    try { localStorage.setItem('noted-terminal-notes-panel-size', JSON.stringify(next)); } catch {}
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'notesPanelSize', value: next }).catch(() => {});
    } catch {}
  },
  notesPanelOffsetY: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-panel-offset-y');
      if (saved !== null) {
        const n = Number(saved);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return 0;
  })(),
  setNotesPanelOffsetY: (offset) => {
    const v = Number.isFinite(offset) ? offset : 0;
    set({ notesPanelOffsetY: v });
    try { localStorage.setItem('noted-terminal-notes-panel-offset-y', String(v)); } catch {}
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'notesPanelOffsetY', value: v }).catch(() => {});
    } catch {}
  },

  // Per-tab last cursor head position. localStorage only — позиция курсора это
  // pure UX-state, в SQLite mirror'ить не нужно. Cap=200 записей, чтобы для
  // долгоживущих юзеров не разрастался словарь до бесконечности.
  notesPanelSelectionByTab: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-panel-selection');
      if (saved) {
        const p = JSON.parse(saved);
        if (p && typeof p === 'object') {
          const cleaned: Record<string, number> = {};
          for (const [k, v] of Object.entries(p)) {
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleaned[k] = v;
          }
          return cleaned;
        }
      }
    } catch {}
    return {};
  })(),
  setNotesPanelSelection: (tabId, head) => {
    if (!tabId || typeof head !== 'number' || !Number.isFinite(head) || head < 0) return;
    const cur = get().notesPanelSelectionByTab;
    if (cur[tabId] === head) return;
    let next: Record<string, number> = { ...cur, [tabId]: head };
    const entries = Object.entries(next);
    if (entries.length > 200) {
      // Срезаем самые старые — Map preserve insertion order in plain object,
      // entries() читает в порядке вставки. Берём последние 200.
      next = Object.fromEntries(entries.slice(entries.length - 200));
    }
    set({ notesPanelSelectionByTab: next });
    try { localStorage.setItem('noted-terminal-notes-panel-selection', JSON.stringify(next)); } catch {}
  },

  // Tab Preview popover cap'ы (CMD+hover). Это НЕ фиксированный размер —
  // popover рендерится `fit-content` + `max-*: cap`. Layout сам подбирает
  // ширину/высоту под форму контента (target-пропорция 3:2 в компоненте,
  // см. TabPreviewPopover.tsx `computeBalancedSize`). Ключи `noted-terminal-*`
  // зеркалятся в SQLite автоматически через mirror в main.js.
  tabPreviewMaxWidth: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-tab-preview-max-width');
      const n = saved ? parseFloat(saved) : 200;
      return Math.max(120, Math.min(900, Number.isFinite(n) ? n : 200));
    } catch { return 200; }
  })(),
  setTabPreviewMaxWidth: (px) => {
    const clamped = Math.max(120, Math.min(900, px));
    set({ tabPreviewMaxWidth: clamped });
    try { localStorage.setItem('noted-terminal-tab-preview-max-width', String(clamped)); } catch {}
    // Mirror to SQLite so a resize survives vite port shuffles (same as notesPanelSize).
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'tabPreviewMaxWidth', value: clamped }).catch(() => {});
    } catch {}
  },
  tabPreviewMaxHeight: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-tab-preview-max-height');
      const n = saved ? parseFloat(saved) : 250;
      return Math.max(80, Math.min(900, Number.isFinite(n) ? n : 250));
    } catch { return 250; }
  })(),
  setTabPreviewMaxHeight: (px) => {
    const clamped = Math.max(80, Math.min(900, px));
    set({ tabPreviewMaxHeight: clamped });
    try { localStorage.setItem('noted-terminal-tab-preview-max-height', String(clamped)); } catch {}
  },
  // Notes Editor — единые настройки для всех мест где рендерится tab.notes
  // (inline в InfoPanel, slide-out, CMD+hover preview). Persistence:
  // localStorage для синхронного boot read, app:setState mirror в SQLite чтобы
  // значение пережило vite port shuffles (разные порты = разные origin =
  // отдельные localStorage buckets).
  //
  // Migration: до этого фикса у inline/preview был отдельный набор
  // `tab-notes-*` ключей, у slide-out — `notes-editor-*`. Если новый ключ не
  // выставлен, но есть старый — переносим, чтобы юзер не потерял настройку.
  // Три независимых шрифта. Migration: до этого был один `notesEditorFontSize` —
  // если новые ключи пусты, читаем legacy и подставляем во все три, чтобы юзер
  // не получил неожиданные дефолты после апдейта.
  notesSidebarFontSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-sidebar-font-size');
      if (saved) return Math.max(10, Math.min(28, parseInt(saved, 10) || 14));
      const legacy = localStorage.getItem('noted-terminal-notes-editor-font-size')
        || localStorage.getItem('noted-terminal-tab-notes-font-size');
      return legacy ? Math.max(10, Math.min(28, parseInt(legacy, 10) || 14)) : 14;
    } catch { return 14; }
  })(),
  setNotesSidebarFontSize: (size) => {
    const clamped = Math.max(10, Math.min(28, size));
    set({ notesSidebarFontSize: clamped });
    try { localStorage.setItem('noted-terminal-notes-sidebar-font-size', String(clamped)); } catch {}
  },
  notesExpandedFontSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-expanded-font-size');
      if (saved) return Math.max(10, Math.min(28, parseInt(saved, 10) || 14));
      const legacy = localStorage.getItem('noted-terminal-notes-editor-font-size')
        || localStorage.getItem('noted-terminal-tab-notes-font-size');
      return legacy ? Math.max(10, Math.min(28, parseInt(legacy, 10) || 14)) : 14;
    } catch { return 14; }
  })(),
  setNotesExpandedFontSize: (size) => {
    const clamped = Math.max(10, Math.min(28, size));
    set({ notesExpandedFontSize: clamped });
    try { localStorage.setItem('noted-terminal-notes-expanded-font-size', String(clamped)); } catch {}
  },
  notesTooltipFontSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-tooltip-font-size');
      if (saved) return Math.max(10, Math.min(28, parseInt(saved, 10) || 14));
      const legacy = localStorage.getItem('noted-terminal-notes-editor-font-size')
        || localStorage.getItem('noted-terminal-tab-notes-font-size');
      return legacy ? Math.max(10, Math.min(28, parseInt(legacy, 10) || 14)) : 14;
    } catch { return 14; }
  })(),
  setNotesTooltipFontSize: (size) => {
    const clamped = Math.max(10, Math.min(28, size));
    set({ notesTooltipFontSize: clamped });
    try { localStorage.setItem('noted-terminal-notes-tooltip-font-size', String(clamped)); } catch {}
  },
  notesEditorPaddingX: (() => {
    try {
      let saved = localStorage.getItem('noted-terminal-notes-editor-padding-x');
      if (!saved) {
        const legacy = localStorage.getItem('noted-terminal-tab-notes-padding-x');
        if (legacy) { localStorage.setItem('noted-terminal-notes-editor-padding-x', legacy); saved = legacy; }
      }
      return saved ? parseInt(saved, 10) : 12;
    } catch { return 12; }
  })(),
  setNotesEditorPaddingX: (px) => {
    const clamped = Math.max(0, Math.min(48, px));
    set({ notesEditorPaddingX: clamped });
    try { localStorage.setItem('noted-terminal-notes-editor-padding-x', String(clamped)); } catch {}
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'notesEditorPaddingX', value: clamped }).catch(() => {});
    } catch {}
  },
  notesEditorPaddingY: (() => {
    try {
      let saved = localStorage.getItem('noted-terminal-notes-editor-padding-y');
      if (!saved) {
        const legacy = localStorage.getItem('noted-terminal-tab-notes-padding-y');
        if (legacy) { localStorage.setItem('noted-terminal-notes-editor-padding-y', legacy); saved = legacy; }
      }
      return saved ? parseInt(saved, 10) : 12;
    } catch { return 12; }
  })(),
  setNotesEditorPaddingY: (px) => {
    const clamped = Math.max(0, Math.min(48, px));
    set({ notesEditorPaddingY: clamped });
    try { localStorage.setItem('noted-terminal-notes-editor-padding-y', String(clamped)); } catch {}
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'notesEditorPaddingY', value: clamped }).catch(() => {});
    } catch {}
  },
  notesEditorShowLineNumbers: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-editor-line-numbers');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  })(),
  setNotesEditorShowLineNumbers: (on) => {
    set({ notesEditorShowLineNumbers: on });
    try { localStorage.setItem('noted-terminal-notes-editor-line-numbers', String(on)); } catch {}
  },
  notesPreviewShowLineNumbers: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-preview-line-numbers');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  })(),
  setNotesPreviewShowLineNumbers: (on) => {
    set({ notesPreviewShowLineNumbers: on });
    try { localStorage.setItem('noted-terminal-notes-preview-line-numbers', String(on)); } catch {}
  },

  // Параллелизм семантической индексации (MCP docs_reindex parallel=N).
  // localStorage-only — никакого SQLite-зеркала, настройка хост-локальна и легковесна.
  semanticIndexParallelism: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-semantic-index-parallelism');
      if (saved) return Math.max(1, Math.min(20, parseInt(saved, 10) || 10));
    } catch {}
    return 10;
  })(),
  setSemanticIndexParallelism: (n) => {
    const clamped = Math.max(1, Math.min(20, Math.round(n)));
    set({ semanticIndexParallelism: clamped });
    try { localStorage.setItem('noted-terminal-semantic-index-parallelism', String(clamped)); } catch {}
  },
  semanticAutoIndexTitles: initialSemanticAutoIndexTitles,
  setSemanticAutoIndexTitles: (on) => {
    set({ semanticAutoIndexTitles: on });
    saveSemanticAutoIndexSetting(
      APP_STATE_KEY_SEMANTIC_AUTO_TITLES,
      APP_STATE_KEY_SEMANTIC_AUTO_TITLES_SINCE,
      LS_SEMANTIC_AUTO_TITLES,
      LS_SEMANTIC_AUTO_TITLES_SINCE,
      on
    );
  },
  semanticAutoIndexIterations: initialSemanticAutoIndexIterations,
  setSemanticAutoIndexIterations: (on) => {
    set({ semanticAutoIndexIterations: on });
    saveSemanticAutoIndexSetting(
      APP_STATE_KEY_SEMANTIC_AUTO_ITERATIONS,
      APP_STATE_KEY_SEMANTIC_AUTO_ITERATIONS_SINCE,
      LS_SEMANTIC_AUTO_ITERATIONS,
      LS_SEMANTIC_AUTO_ITERATIONS_SINCE,
      on
    );
  },

  // Focus Area
  activeArea: 'workspace',
  setActiveArea: (area) => set({ activeArea: area })
}));

// Черновик поля ввода сохраняется САМ, пока человек печатает.
//
// Подписка, а не вызов в каждом писателе: черновик меняют пять разных методов
// (текст, чипы — поставить/добавить/убрать, дописать в конец), и это ровно тот
// случай, когда «не забыть дописать строчку» — вопрос времени. Здесь же
// сохранение следует за самим ФАКТОМ изменения, поэтому шестой писатель,
// который появится завтра, получит его бесплатно.
//
// Сравниваются ссылки: все мутаторы пересобирают объекты, поэтому неравенство
// ссылок и есть «что-то поменялось», без обхода содержимого на каждую букву.
if (typeof window !== 'undefined') {
  let lastDraftSnapshot = {
    drafts: useUIStore.getState().historyPromptDrafts,
    images: useUIStore.getState().historyPromptDraftImages,
    chips: useUIStore.getState().historyPromptDraftChips,
  };
  useUIStore.subscribe((state) => {
    if (state.historyPromptDrafts === lastDraftSnapshot.drafts
      && state.historyPromptDraftImages === lastDraftSnapshot.images
      && state.historyPromptDraftChips === lastDraftSnapshot.chips) return;
    lastDraftSnapshot = {
      drafts: state.historyPromptDrafts,
      images: state.historyPromptDraftImages,
      chips: state.historyPromptDraftChips,
    };
    state.scheduleHistoryComposerDraftSave();
  });
}

if (typeof window !== 'undefined') {
  (window as any).useUIStore = useUIStore;
  // Cleanup: legacy localStorage keys migrated to SQLite ai_prompts table
  localStorage.removeItem('noted-terminal-chat-settings');
  localStorage.removeItem('noted-terminal-research-prompt');
}
