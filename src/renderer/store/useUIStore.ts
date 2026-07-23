import { create } from 'zustand';
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

export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type ApiGeminiModel = GeminiModelId;
export type AIModel = GeminiModelId;
export type ApiClaudeModel = 'claude-opus-4.6' | 'claude-sonnet-4.5';

// Re-export from canonical source. Older code imports DefaultClaudeEffort from useUIStore
// because the type used to be defined here; we keep the alias so we don't touch dozens
// of call sites. The list itself lives in constants/claudeLevels.ts.
export type { ClaudeCodeModelOption, ClaudeCodeSettings, DefaultClaudeEffort, DefaultClaudeModel } from '../constants/claudeLevels';
import type { ClaudeCodeSettings, DefaultClaudeEffort, DefaultClaudeModel } from '../constants/claudeLevels';
import { DEFAULT_CLAUDE_CODE_SETTINGS } from '../constants/claudeLevels';
export type { DefaultCodexEffort, DefaultCodexModel } from '../constants/codexSettings';
import type { CodexSettings, DefaultCodexEffort, DefaultCodexModel } from '../constants/codexSettings';
import {
  DEFAULT_CODEX_SETTINGS,
  normalizeCodexEfforts,
  normalizeCodexModelOptions,
  resolveCodexPersistentEffortForModel,
} from '../constants/codexSettings';

export const HISTORY_PANEL_DEFAULT_WIDTH = 580;
export const HISTORY_PANEL_MIN_WIDTH = 280;

export interface HistoryRewindPreview {
  opId: string;
  targetUuid: string;
  targetText: string;
  startedAt: number;
  sessionId?: string;
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

export interface HistoryPromptDraftWriteOptions {
  images?: HistoryPromptDraftImageRef[] | null;
  preserveImages?: boolean;
}

export interface ApiSettings {
  claudeModel: ApiClaudeModel;
  claudeThinking: ThinkingLevel;
  geminiModel: ApiGeminiModel;
  geminiThinking: ThinkingLevel;
}

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
  shimmerSpacingPct: number; // высота repeat-tile в %, визуально = расстояние между бликами
  shimmerOpacityPct: number; // peak-alpha блика в %, края считаются слабее в CSS vars
  position: 'left' | 'right'; // где рисовать полоску — у левого или правого края вкладки
}

const DEFAULT_PROCESS_BAR: ProcessBarSettings = {
  colorA: '#155E75',        // cyan-800 — приглушённая базовая полоса
  shimmerColor: '#FFFFFF',  // белый блик, который раньше был зашит в CSS
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


interface DocPromptSettings {

  useFile: boolean; // true = read from file path, false = use inline content

  filePath: string;

  inlineContent: string;

}



interface UIStore {

  // Font Settings

  terminalFontSize: number;

  // SDK assistant rendering — отдельно от terminalFontSize, потому что PTY
  // xterm.js рендерит моноширинный grid (1px шаг ощущается сразу), а SDK-таб
  // рендерит markdown в потоке Virtuoso, и юзеру обычно комфортнее ставить
  // SDK-шрифт крупнее без раздувания PTY-табов.
  sdkFontSize: number;

  tabsFontSize: number;        // Main + Utils tabs in TabBar

  projectTabsFontSize: number; // Project chips in Title Bar

  sidebarFontSize: number;     // File explorer sidebar
  sidebarWidth: number;        // File explorer width (px)
  tabSidebarWidth: number;     // Permanent left tab sidebar width (px)

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
  historyComposerMinRows: number; // Empty height for the primary History prompt textarea.
  historyComposerMaxRows: number; // Auto-grow ceiling for the primary History prompt textarea.
  promptQueueChipFontSize: number; // Run-after chip title font inside the queue list.
  promptQueueEditorFontSize: number; // Run-after chip editor title/body font in the slideout.
  promptQueueChipLineClamp: number; // How many lines of chip text show inside Run After overlay (1 = single-line ellipsis).
  promptQueueWidth: number;    // Run-after overlay width (px). FIXED — adding a +grab chip must not reflow it. Drag-resizable on the free (non-anchor) edge. Global, like timelineWidth.

  setSidebarWidth: (width: number) => void;
  setTabSidebarWidth: (width: number) => void;
  setTerminalFontSize: (size: number) => void;
  setSdkFontSize: (size: number) => void;

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
  setHistoryComposerMinRows: (rows: number) => void;
  setHistoryComposerMaxRows: (rows: number) => void;
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

  // Documentation Prompt (for Update Docs feature)

  docPrompt: DocPromptSettings;

  setDocPromptUseFile: (useFile: boolean) => void;

  setDocPromptFilePath: (path: string) => void;

  setDocPromptInlineContent: (content: string) => void;




  // Terminal Selection (global state for selected text)

  terminalSelection: string;

  setTerminalSelection: (text: string) => void;



  // File Explorer

  fileExplorerOpen: boolean;

  toggleFileExplorer: () => void;

  setFileExplorerOpen: (open: boolean) => void;



  // File Preview

  filePreview: FilePreview | null;

  openFilePreview: (preview: FilePreview) => void;

  closeFilePreview: () => void;



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
  historyScrollToUuid: string | null;
  historyVisibleUuids: Record<string, string[]>;
  historyScrollPositions: Record<string, number>;
  historyPromptDrafts: Record<string, string>;
  historyPromptDraftImages: Record<string, HistoryPromptDraftImageRef[]>;
  historyRewindPreviews: Record<string, HistoryRewindPreview>;
  setHistoryPanelOpen: (tabId: string, open: boolean) => void;
  setHistoryPanelWidth: (width: number) => void;
  setHistoryScrollToUuid: (uuid: string | null) => void;
  setHistoryVisibleUuids: (tabId: string, uuids: string[]) => void;
  setHistoryScrollPosition: (tabId: string, scrollTop: number) => void;
  setHistoryPromptDraft: (tabId: string, draft: string, options?: HistoryPromptDraftWriteOptions) => void;
  appendHistoryPromptDraft: (tabId: string, text: string) => void;
  setHistoryRewindPreview: (tabId: string, preview: HistoryRewindPreview | null) => void;

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

  // Copy Settings (shared between ActionsPanel and Timeline)
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
  // Diagnostic toggle: when true, Cmd-popups (tooltip/note/fork) stay open
  // after pointer leaves so user can inspect their inner DOM in devtools.
  freezeCmdPopups: boolean;
  setFreezeCmdPopups: (v: boolean) => void;
  historyPinned: boolean;
  setHistoryPinned: (v: boolean) => void;
  timelinePinned: boolean;
  setTimelinePinned: (v: boolean) => void;

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

  // API Settings Modal
  apiSettingsOpen: boolean;
  openApiSettings: () => void;
  closeApiSettings: () => void;
  apiSettings: ApiSettings;
  setApiClaudeModel: (model: ApiClaudeModel) => void;
  setApiGeminiModel: (model: ApiGeminiModel) => void;
  setApiClaudeThinking: (level: ThinkingLevel) => void;
  setApiGeminiThinking: (level: ThinkingLevel) => void;

  // Auto-apply toggle (Update API → Haiku auto-submits confirmation)
  autoApplyDocs: boolean;
  setAutoApplyDocs: (on: boolean) => void;

  // Post-check toggle (lightweight verification after main analysis)
  postCheckDocs: boolean;
  setPostCheckDocs: (on: boolean) => void;

  // Post-check prompt text
  postCheckPrompt: string;
  setPostCheckPrompt: (text: string) => void;

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
}



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




const DEFAULT_DOC_PROMPT_PATH = '/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/docs-rules.prompt.md';

const loadDocPrompt = (): DocPromptSettings => {
  try {
    const saved = localStorage.getItem('noted-terminal-doc-prompt');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load doc prompt:', e);
  }
  return {
    useFile: true,
    filePath: DEFAULT_DOC_PROMPT_PATH,
    inlineContent: ''
  };
};

const saveDocPrompt = (settings: DocPromptSettings) => {
  try {
    localStorage.setItem('noted-terminal-doc-prompt', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save doc prompt:', e);
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

const loadSdkFontSize = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-sdk-font-size');
    if (v) return Math.max(8, Math.min(24, Number(v) || 13));
  } catch {}
  return 13;
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
// Run-after overlay width. Clamp [240, 600] — 240 ≈ the old PANEL_MIN_WIDTH so
// existing layouts don't shrink; default 300 sits inside the old fit-content
// [240,360] band so the first render after this change doesn't jump.
const PROMPT_QUEUE_WIDTH_MIN = 240;
const PROMPT_QUEUE_WIDTH_MAX = 600;
const loadPromptQueueWidth = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-width');
    if (v) return Math.max(PROMPT_QUEUE_WIDTH_MIN, Math.min(PROMPT_QUEUE_WIDTH_MAX, Number(v) || 300));
  } catch {}
  return 300;
};
const initialEditorSettings = loadEditorSettings();
const initialModel = loadSelectedModel();
const initialThinkingLevel = loadThinkingLevel();
const initialDocPrompt = loadDocPrompt();

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

// Copy settings — flat shape kept for backwards compatibility with existing callsites.
// New hierarchical fields (copyIncludeUser/Claude/Text/Thinking/Bash/Tools) added in v2.
// Defaults preserve old behavior: everything user did before remains visible; new groups
// (Bash/Tools) default OFF so power users don't suddenly get 200KB Bash logs in their paste.
type CopySettings = {
  copyIncludeEditing: boolean;
  copyIncludeReading: boolean;
  copyFromStart: boolean;
  copyIncludeSubagentResult: boolean;
  copyIncludeSubagentHistory: boolean;
  copyIncludeUser: boolean;
  copyIncludeClaude: boolean;
  copyIncludeText: boolean;
  copyIncludeThinking: boolean;
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
      return {
        copyIncludeEditing: parsed.copyIncludeEditing ?? true,
        copyIncludeReading: parsed.copyIncludeReading ?? false,
        copyFromStart: parsed.copyFromStart ?? true,
        copyIncludeSubagentResult: parsed.copyIncludeSubagentResult ?? false,
        copyIncludeSubagentHistory: parsed.copyIncludeSubagentHistory ?? false,
        copyIncludeUser: parsed.copyIncludeUser ?? true,
        copyIncludeClaude: parsed.copyIncludeClaude ?? true,
        copyIncludeText: parsed.copyIncludeText ?? true,
        copyIncludeThinking: parsed.copyIncludeThinking ?? true,
        copyIncludeBash: parsed.copyIncludeBash ?? false,
        copyIncludeTools: parsed.copyIncludeTools ?? false,
        copyIncludeWebSearch: parsed.copyIncludeWebSearch ?? parsed.copyIncludeTools ?? false,
        copyIncludeToolSearch: parsed.copyIncludeToolSearch ?? parsed.copyIncludeTools ?? false,
        copyIncludeOtherTools: parsed.copyIncludeOtherTools ?? parsed.copyIncludeTools ?? false,
      };
    }
  } catch (e) {
    console.error('Failed to load copy settings:', e);
  }
  return {
    copyIncludeEditing: true, copyIncludeReading: false, copyFromStart: true,
    copyIncludeSubagentResult: false, copyIncludeSubagentHistory: false,
    copyIncludeUser: true, copyIncludeClaude: true,
    copyIncludeText: true, copyIncludeThinking: true,
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
    localStorage.setItem('noted-terminal-copy-settings', JSON.stringify({ ...prev, ...settings }));
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
  let models = normalizeCodexModelOptions(rawModels);
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
    efforts: normalizeCodexEfforts(obj.efforts),
    quickModel,
    quickEffort,
  };
};
const loadCodexSettings = (): CodexSettings => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_CODEX_SETTINGS);
    if (raw) return normalizeCodexSettings(JSON.parse(raw));
  } catch {}
  return normalizeCodexSettings(DEFAULT_CODEX_SETTINGS);
};
const saveCodexSettings = (settings: CodexSettings) => {
  const normalized = normalizeCodexSettings(settings);
  try { localStorage.setItem(LOCAL_KEY_CODEX_SETTINGS, JSON.stringify(normalized)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CODEX_SETTINGS, value: normalized }).catch(() => {});
  } catch {}
};
const initialCodexSettings = loadCodexSettings();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CODEX_SETTINGS);
    if (v !== null && v !== undefined) {
      const normalized = normalizeCodexSettings(v);
      useUIStore.setState({ codexSettings: normalized });
      try { localStorage.setItem(LOCAL_KEY_CODEX_SETTINGS, JSON.stringify(normalized)); } catch {}
    }
  } catch {}
})();

const APP_STATE_KEY_CLAUDE_CODE_SETTINGS = 'claudeCodeSettings';
const LOCAL_KEY_CLAUDE_CODE_SETTINGS = 'noted-terminal-claude-code-settings';

const normalizeClaudeCodeSettings = (raw: unknown): ClaudeCodeSettings => {
  const obj = raw && typeof raw === 'object' ? raw as Partial<ClaudeCodeSettings> : {};
  const modelsRaw = Array.isArray(obj.models) ? obj.models : [];
  const models = modelsRaw
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      let id = String((m as any).id || '').trim();
      if (!id) return null;
      if (id === 'claude-fable-5') id = 'claude-fable-5[1m]';
      const label = String((m as any).label || id).trim() || id;
      return { id, label, cmd: true };
    })
    .filter(Boolean) as ClaudeCodeSettings['models'];
  const mergedModels = models.length > 0 ? [...models] : [...DEFAULT_CLAUDE_CODE_SETTINGS.models];
  DEFAULT_CLAUDE_CODE_SETTINGS.models.forEach((m) => {
    if (!mergedModels.some((existing) => existing.id === m.id)) mergedModels.push(m);
  });

  const effortsRaw = Array.isArray(obj.efforts) ? obj.efforts : [];
  const efforts = effortsRaw
    .map((v) => String(v || '').trim())
    .filter((v, index, arr) => v && arr.indexOf(v) === index);

  return {
    models: mergedModels,
    efforts: efforts.length > 0 ? efforts : [...DEFAULT_CLAUDE_CODE_SETTINGS.efforts],
  };
};

const loadClaudeCodeSettings = (): ClaudeCodeSettings => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_CLAUDE_CODE_SETTINGS);
    if (raw) return normalizeClaudeCodeSettings(JSON.parse(raw));
  } catch {}
  return normalizeClaudeCodeSettings(DEFAULT_CLAUDE_CODE_SETTINGS);
};

const saveClaudeCodeSettings = (settings: ClaudeCodeSettings) => {
  const normalized = normalizeClaudeCodeSettings(settings);
  try { localStorage.setItem(LOCAL_KEY_CLAUDE_CODE_SETTINGS, JSON.stringify(normalized)); } catch {}
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_CLAUDE_CODE_SETTINGS, value: normalized }).catch(() => {});
  } catch {}
};

const initialClaudeCodeSettings = loadClaudeCodeSettings();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_CLAUDE_CODE_SETTINGS);
    if (v !== null && v !== undefined) {
      const normalized = normalizeClaudeCodeSettings(v);
      useUIStore.setState({ claudeCodeSettings: normalized });
      try { localStorage.setItem(LOCAL_KEY_CLAUDE_CODE_SETTINGS, JSON.stringify(normalized)); } catch {}
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

// API Settings (for [api] button in ActionsPanel)
const loadApiSettings = (): ApiSettings => {
  try {
    const saved = localStorage.getItem('noted-terminal-api-settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        claudeModel: parsed.claudeModel || 'claude-sonnet-4.5',
        claudeThinking: parsed.claudeThinking || 'HIGH',
        geminiModel: isGeminiModelId(parsed.geminiModel) ? parsed.geminiModel : 'gemini-3-flash-preview',
        geminiThinking: parsed.geminiThinking || 'HIGH',
      };
    }
  } catch (e) {
    console.error('Failed to load API settings:', e);
  }
  return { claudeModel: 'claude-sonnet-4.5', claudeThinking: 'HIGH', geminiModel: 'gemini-3-flash-preview', geminiThinking: 'HIGH' };
};

const saveApiSettings = (settings: ApiSettings) => {
  try {
    localStorage.setItem('noted-terminal-api-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save API settings:', e);
  }
};

const initialApiSettings = loadApiSettings();

export const useUIStore = create<UIStore>((set, get) => ({
  // Font Settings
  terminalFontSize: initialFontSettings.terminalFontSize,
  sdkFontSize: loadSdkFontSize(),
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
  historyComposerMinRows: initialHistoryComposerMinRows,
  historyComposerMaxRows: initialHistoryComposerMaxRows,
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

  setHistoryComposerMaxRows: (rows: number) => {
    const clamped = Math.max(get().historyComposerMinRows, Math.min(40, Math.round(rows)));
    set({ historyComposerMaxRows: clamped });
    try { localStorage.setItem('noted-terminal-history-composer-max-rows', String(clamped)); } catch {}
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

  // Documentation Prompt
  docPrompt: initialDocPrompt,
  setDocPromptUseFile: (useFile) => {
    const current = get().docPrompt;
    const updated = { ...current, useFile };
    set({ docPrompt: updated });
    saveDocPrompt(updated);
  },
  setDocPromptFilePath: (filePath) => {
    const current = get().docPrompt;
    const updated = { ...current, filePath };
    set({ docPrompt: updated });
    saveDocPrompt(updated);
  },
  setDocPromptInlineContent: (inlineContent) => {
    const current = get().docPrompt;
    const updated = { ...current, inlineContent };
    set({ docPrompt: updated });
    saveDocPrompt(updated);
  },

  // Terminal Selection
  terminalSelection: '',
  setTerminalSelection: (text) => set({ terminalSelection: text }),

  setTerminalFontSize: (size) => {
    const clamped = Math.max(8, Math.min(24, size));
    set({ terminalFontSize: clamped });
    const { tabsFontSize, projectTabsFontSize, sidebarFontSize } = get();
    saveFontSettings({ terminalFontSize: clamped, tabsFontSize, projectTabsFontSize, sidebarFontSize });
  },
  setSdkFontSize: (size) => {
    const clamped = Math.max(8, Math.min(24, size));
    set({ sdkFontSize: clamped });
    try { localStorage.setItem('noted-terminal-sdk-font-size', String(clamped)); } catch {}
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
	  historyPanelOpenTabs: {},
	  historyPanelWidth: (() => {
	    try {
	      const saved = localStorage.getItem('noted-terminal-history-panel-width');
	      return saved ? Math.max(HISTORY_PANEL_MIN_WIDTH, parseInt(saved, 10)) : HISTORY_PANEL_DEFAULT_WIDTH;
	    } catch { return HISTORY_PANEL_DEFAULT_WIDTH; }
	  })(),
  historyScrollToUuid: null,
  historyVisibleUuids: {},
  historyScrollPositions: {},
  historyPromptDrafts: {},
  historyPromptDraftImages: {},
  historyRewindPreviews: {},
  setHistoryPanelOpen: (tabId, open) => set(state => ({
    historyPanelOpenTabs: { ...state.historyPanelOpenTabs, [tabId]: open }
  })),
  setHistoryScrollToUuid: (uuid) => set({ historyScrollToUuid: uuid }),
  setHistoryVisibleUuids: (tabId, uuids) => set(state => ({
    historyVisibleUuids: { ...state.historyVisibleUuids, [tabId]: uuids }
  })),
  setHistoryScrollPosition: (tabId, scrollTop) => set(state => ({
    historyScrollPositions: { ...state.historyScrollPositions, [tabId]: scrollTop }
  })),
  setHistoryPromptDraft: (tabId, draft, options = {}) => set(state => {
    const next = { ...state.historyPromptDrafts };
    if (draft) next[tabId] = draft;
    else delete next[tabId];
    const shouldTouchImages = !draft || !options.preserveImages || Object.prototype.hasOwnProperty.call(options, 'images');
    if (!shouldTouchImages) return { historyPromptDrafts: next };

    const nextImages = { ...state.historyPromptDraftImages };
    const images = Array.isArray(options.images)
      ? options.images.filter((ref) => ref && Number.isFinite(Number(ref.id)) && typeof ref.path === 'string' && ref.path.trim())
      : [];
    if (draft && images.length > 0) nextImages[tabId] = images;
    else delete nextImages[tabId];
    return { historyPromptDrafts: next, historyPromptDraftImages: nextImages };
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
  freezeCmdPopups: initialFreezeCmdPopups,
  setFreezeCmdPopups: (v) => { set({ freezeCmdPopups: v }); saveFreezeCmdPopups(v); },
  historyPinned: initialHistoryPinned,
  setHistoryPinned: (v) => { set({ historyPinned: v }); saveHistoryPinned(v); },
  timelinePinned: initialTimelinePinned,
  setTimelinePinned: (v) => { set({ timelinePinned: v }); saveTimelinePinned(v); },

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
    set({ codexSettings: normalized });
    saveCodexSettings(normalized);
  },
  claudeCodeSettings: initialClaudeCodeSettings,
  setClaudeCodeSettings: (settings) => {
    const normalized = normalizeClaudeCodeSettings(settings);
    set({ claudeCodeSettings: normalized });
    saveClaudeCodeSettings(normalized);
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

  // API Settings Modal
  apiSettingsOpen: false,
  openApiSettings: () => set({ apiSettingsOpen: true }),
  closeApiSettings: () => set({ apiSettingsOpen: false }),
  apiSettings: initialApiSettings,
  setApiClaudeModel: (model) => {
    const current = get().apiSettings;
    const updated = { ...current, claudeModel: model };
    set({ apiSettings: updated });
    saveApiSettings(updated);
  },
  setApiClaudeThinking: (level) => {
    const current = get().apiSettings;
    const updated = { ...current, claudeThinking: level };
    set({ apiSettings: updated });
    saveApiSettings(updated);
  },
  setApiGeminiModel: (model) => {
    const current = get().apiSettings;
    const updated = { ...current, geminiModel: model };
    set({ apiSettings: updated });
    saveApiSettings(updated);
  },
  setApiGeminiThinking: (level) => {
    const current = get().apiSettings;
    const updated = { ...current, geminiThinking: level };
    set({ apiSettings: updated });
    saveApiSettings(updated);
  },

  // Auto-apply docs toggle
  autoApplyDocs: localStorage.getItem('noted-terminal-auto-apply-docs') === 'true',
  setAutoApplyDocs: (on) => {
    set({ autoApplyDocs: on });
    localStorage.setItem('noted-terminal-auto-apply-docs', String(on));
  },

  // Post-check docs toggle
  postCheckDocs: localStorage.getItem('noted-terminal-post-check-docs') === 'true',
  setPostCheckDocs: (on) => {
    set({ postCheckDocs: on });
    localStorage.setItem('noted-terminal-post-check-docs', String(on));
  },

  // Post-check prompt text
  postCheckPrompt: localStorage.getItem('noted-terminal-post-check-prompt') || `Проверь свой план по двум критериям:\n1. Есть ли в сессии места где разработчик получил 0 результатов / пустой ответ / ошибку парсинга данных, и потом выяснил что формат данных отличался от ожидаемого? Если да — это шрам формата данных, запиши.\n2. Предлагаешь ли ты изменения в CLAUDE.md? Если да — проверь: это guard rail / anti-pattern / инфраструктурная инструкция? Если нет — убери, knowledge-файлы находятся через семантический поиск.`,
  setPostCheckPrompt: (text) => {
    set({ postCheckPrompt: text });
    localStorage.setItem('noted-terminal-post-check-prompt', text);
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

if (typeof window !== 'undefined') {
  (window as any).useUIStore = useUIStore;
  // Cleanup: legacy localStorage keys migrated to SQLite ai_prompts table
  localStorage.removeItem('noted-terminal-chat-settings');
  localStorage.removeItem('noted-terminal-research-prompt');
}
