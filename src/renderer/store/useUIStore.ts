import { create } from 'zustand';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning' | 'pink';
  persistent?: boolean;
  copyText?: string;
  actionLabel?: string;
  onAction?: () => void;
  // When set, toast is only rendered while this tab is the effective active tab.
  // Used for tab-scoped notifications (e.g. "history chain recovered" in Timeline).
  tabId?: string;
}

interface FilePreview {
  path: string;
  content: string;
  language: string | null;
}

export type AIModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';

export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type ApiGeminiModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';
export type ApiClaudeModel = 'claude-opus-4.6' | 'claude-sonnet-4.5';

// Re-export from canonical source. Older code imports DefaultClaudeEffort from useUIStore
// because the type used to be defined here; we keep the alias so we don't touch dozens
// of call sites. The list itself lives in constants/claudeLevels.ts.
export type { DefaultClaudeEffort } from '../constants/claudeLevels';
import type { DefaultClaudeEffort } from '../constants/claudeLevels';
import { CLAUDE_EFFORT_LEVELS_WITH_NONE } from '../constants/claudeLevels';

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
      .map((s) => ({ id: s.id, label: s.label, color: s.color }));
  } catch { return DEFAULT_SESSION_STATUSES; }
}

function saveSessionStatuses(list: SessionStatusDef[]) {
  try { localStorage.setItem('noted-terminal-session-statuses', JSON.stringify(list)); } catch {}
}

export interface ProcessBarSettings {
  enabled: boolean;     // false → статичный colorA (без анимации)
  colorA: string;       // нижняя фаза пульса (или единственный цвет если enabled=false)
  colorB: string;       // верхняя фаза пульса
  durationMs: number;   // длительность одного цикла (300..6000ms — clamp в setter)
  position: 'left' | 'right'; // где рисовать полоску — у левого или правого края вкладки
}

const DEFAULT_PROCESS_BAR: ProcessBarSettings = {
  enabled: true,
  colorA: '#155E75',  // cyan-800 — приглушённая нижняя фаза
  colorB: '#0E7490',  // cyan-700 — мягкая верхняя
  durationMs: 2400,
  position: 'left',
};

function loadProcessBar(): ProcessBarSettings {
  try {
    const raw = localStorage.getItem('noted-terminal-process-bar');
    if (!raw) return DEFAULT_PROCESS_BAR;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PROCESS_BAR;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PROCESS_BAR.enabled,
      colorA: typeof parsed.colorA === 'string' ? parsed.colorA : DEFAULT_PROCESS_BAR.colorA,
      colorB: typeof parsed.colorB === 'string' ? parsed.colorB : DEFAULT_PROCESS_BAR.colorB,
      durationMs: typeof parsed.durationMs === 'number'
        ? Math.max(300, Math.min(6000, parsed.durationMs))
        : DEFAULT_PROCESS_BAR.durationMs,
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

  /* Process bar — мигающая полоска слева во вкладке когда PTY-процесс жив.
     enabled=false → статичный colorA, без анимации.
     durationMs — длительность одного цикла пульса (default 2400ms = медленное дыхание).
     CSS читает значения через --process-bar-* переменные на :root, обновляемые из App. */
  processBar: ProcessBarSettings;
  setProcessBar: (patch: Partial<ProcessBarSettings>) => void;

  /* Status marker — маркер слева во вкладке (vertical mode) для sessionStatus.
     shape='dot' → круг, 'square' → квадрат (border-radius различается).
     sizePx — длина стороны (для круга = диаметр). Clamp 4..16. */
  statusMarker: StatusMarkerSettings;
  setStatusMarker: (patch: Partial<StatusMarkerSettings>) => void;

  /* Tab geometry — табы терминала в TabSidebar (vertical mode). Все поля px.
     Раньше — три константы TAB_VERTICAL_PADDING_* в TabBar.tsx, юзер не мог менять
     не открывая код. Теперь Settings → Размеры → ТАБЫ → Терминал. */
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
  timelineWidth: number;       // Timeline width (px) when expanded (treeMode). Drag-resizable.
  timelineLineClamp: number;   // How many lines of preview text show in expanded mode.
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
  setTimelineWidth: (width: number) => void;
  setTimelineLineClamp: (lines: number) => void;
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

  showToast: (message: string, type?: Toast['type'], duration?: number, persistent?: boolean, copyText?: string, actionLabel?: string, onAction?: () => void, tabId?: string) => void;

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
  setHistoryPanelOpen: (tabId: string, open: boolean) => void;
  setHistoryPanelWidth: (width: number) => void;
  setHistoryScrollToUuid: (uuid: string | null) => void;
  setHistoryVisibleUuids: (tabId: string, uuids: string[]) => void;
  setHistoryScrollPosition: (tabId: string, scrollTop: number) => void;

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

  // Status bar debug toggles
  debugHoverBridges: boolean;
  setDebugHoverBridges: (v: boolean) => void;
  // Diagnostic toggle: when true, Cmd-popups (tooltip/note/fork) stay open
  // after pointer leaves so user can inspect their inner DOM in devtools.
  freezeCmdPopups: boolean;
  setFreezeCmdPopups: (v: boolean) => void;

  // Free-ports toggle. When ON, every npm-script start / restart / stop from a
  // devServer-tab first calls `system:free-project-ports` for the tab's cwd —
  // resolves project's declared ports (vite.config, .env PORT, NestJS main.ts)
  // and kills whatever holds them. Solves "address in use" after a previous run
  // crashed without releasing the port (common after Electron force-quit).
  freePortsBeforeStart: boolean;
  setFreePortsBeforeStart: (v: boolean) => void;

  // Default Claude effort applied to new sessions (status-bar selector).
  // 'none' means "do not apply any default" — current session keeps whatever was last picked.
  defaultClaudeEffort: DefaultClaudeEffort;
  setDefaultClaudeEffort: (v: DefaultClaudeEffort) => void;

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

  // Параллелизм семантической индексации — сколько параллельных claude/Haiku воркеров
  // запускает scripts/ai/build-index.sh. Default 10 (совпадает с дефолтом в скрипте).
  // Диапазон 1-20 — выше Anthropic начнёт жёстко 429-ить.
  semanticIndexParallelism: number;
  setSemanticIndexParallelism: (n: number) => void;

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

    if (saved && ['gemini-3-flash-preview', 'gemini-3-pro-preview'].includes(saved)) {

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
const loadPromptQueueChipLineClamp = (): number => {
  try {
    const v = localStorage.getItem('noted-terminal-prompt-queue-chip-line-clamp');
    if (v) return Math.max(1, Math.min(10, Number(v) || 1));
  } catch {}
  return 1;
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
  };
};

const saveCopySettings = (settings: CopySettings) => {
  try {
    localStorage.setItem('noted-terminal-copy-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save copy settings:', e);
  }
};

const initialCopySettings = loadCopySettings();

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
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_BRIDGES, value: v ? '1' : '0' }).catch(() => {});
  } catch {}
};
const initialDebugHoverBridges = loadDebugHoverBridges();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_BRIDGES);
    if (v !== null && v !== undefined) {
      const bool = v === '1' || v === 'true' || v === true;
      if (useUIStore.getState().debugHoverBridges !== bool) {
        useUIStore.setState({ debugHoverBridges: bool });
        try { localStorage.setItem('noted-terminal-debug-hover-bridges', String(bool)); } catch {}
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
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_FREE_PORTS, value: v ? '1' : '0' }).catch(() => {});
  } catch {}
};
const initialFreePortsBeforeStart = loadFreePortsBeforeStart();
(async () => {
  try {
    const { ipcRenderer } = window.require('electron');
    const v = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_FREE_PORTS);
    if (v !== null && v !== undefined) {
      const bool = v === '1' || v === 'true' || v === true;
      if (useUIStore.getState().freePortsBeforeStart !== bool) {
        useUIStore.setState({ freePortsBeforeStart: bool });
        try { localStorage.setItem('noted-terminal-free-ports', String(bool)); } catch {}
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
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_MIRROR, value: v ? '1' : '0' }).catch(() => {});
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
      const bool = v === '1' || v === 'true' || v === true;
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
    if (saved && (CLAUDE_EFFORT_LEVELS_WITH_NONE as readonly string[]).includes(saved)) return saved as DefaultClaudeEffort;
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
    if (v && (CLAUDE_EFFORT_LEVELS_WITH_NONE as readonly string[]).includes(v)) {
      // Use the store's setter so the change propagates to all subscribers.
      // Importing here would be circular; reach into the store after it's defined below
      // — useUIStore.setState exists by the time this IIFE awaits.
      const s = useUIStore.getState();
      if (s.defaultClaudeEffort !== v) {
        // Bypass save (we just read from SQLite) — write only to localStorage mirror.
        useUIStore.setState({ defaultClaudeEffort: v as DefaultClaudeEffort });
        try { localStorage.setItem('noted-terminal-default-claude-effort', v); } catch {}
      }
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
        geminiModel: parsed.geminiModel || 'gemini-3-flash-preview',
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

  processBar: loadProcessBar(),
  setProcessBar: (patch) => {
    const cur = get().processBar;
    const next: ProcessBarSettings = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      colorA: typeof patch.colorA === 'string' ? patch.colorA : cur.colorA,
      colorB: typeof patch.colorB === 'string' ? patch.colorB : cur.colorB,
      durationMs: typeof patch.durationMs === 'number'
        ? Math.max(300, Math.min(6000, patch.durationMs))
        : cur.durationMs,
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
  timelineWidth: loadTimelineWidth(),
  timelineLineClamp: loadTimelineLineClamp(),
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
  showToast: (message, type = 'success', duration = 2500, persistent = false, copyText, actionLabel, onAction, tabId) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, persistent, copyText, actionLabel, onAction, tabId }]
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
      return saved ? Math.max(280, parseInt(saved, 10)) : 580;
    } catch { return 580; }
  })(),
  historyScrollToUuid: null,
  historyVisibleUuids: {},
  historyScrollPositions: {},
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

  timelinePanelOpenTabs: {},
  setTimelinePanelOpen: (tabId, open) => set(state => ({
    timelinePanelOpenTabs: { ...state.timelinePanelOpenTabs, [tabId]: open }
  })),

  timelineTreeModeTabs: {},
  setTimelineTreeMode: (tabId, open) => set(state => ({
    timelineTreeModeTabs: { ...state.timelineTreeModeTabs, [tabId]: open }
  })),
  setHistoryPanelWidth: (width) => {
    const clamped = Math.max(280, width);
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

  // Status bar debug toggles
  debugHoverBridges: initialDebugHoverBridges,
  setDebugHoverBridges: (v) => { set({ debugHoverBridges: v }); saveDebugHoverBridges(v); },
  freezeCmdPopups: false,
  setFreezeCmdPopups: (v) => set({ freezeCmdPopups: v }),

  freePortsBeforeStart: initialFreePortsBeforeStart,
  setFreePortsBeforeStart: (v) => { set({ freePortsBeforeStart: v }); saveFreePortsBeforeStart(v); },

  claudeMdMirrorEnabled: initialMirrorEnabled,
  setClaudeMdMirrorEnabled: (v) => { set({ claudeMdMirrorEnabled: v }); saveMirrorEnabled(v); },

  // Default Claude effort (status-bar selector)
  defaultClaudeEffort: initialDefaultClaudeEffort,
  setDefaultClaudeEffort: (v) => { set({ defaultClaudeEffort: v }); saveDefaultClaudeEffort(v); },

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

  // Параллелизм семантической индексации (build-index.sh --parallel N).
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
