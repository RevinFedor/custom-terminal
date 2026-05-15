import { create } from 'zustand';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning' | 'pink';
  persistent?: boolean;
  copyText?: string;
  actionLabel?: string;
  onAction?: () => void;
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


interface DocPromptSettings {

  useFile: boolean; // true = read from file path, false = use inline content

  filePath: string;

  inlineContent: string;

}



interface UIStore {

  // Font Settings

  terminalFontSize: number;

  tabsFontSize: number;        // Main + Utils tabs in TabBar

  projectTabsFontSize: number; // Project chips in Title Bar

  sidebarFontSize: number;     // File explorer sidebar
  sidebarWidth: number;        // File explorer width (px)
  filePreviewFontSize: number; // FilePreview readOnly editor

  setSidebarWidth: (width: number) => void;
  setTerminalFontSize: (size: number) => void;

  setTabsFontSize: (size: number) => void;

  setProjectTabsFontSize: (size: number) => void;

  setSidebarFontSize: (size: number) => void;

  setFilePreviewFontSize: (size: number) => void;

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

  showToast: (message: string, type?: Toast['type'], duration?: number, persistent?: boolean, copyText?: string, actionLabel?: string, onAction?: () => void) => void;

  removeToast: (id: string) => void;



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

  // Tab Notes Font Size & Padding
  tabNotesFontSize: number;
  setTabNotesFontSize: (size: number) => void;
  tabNotesPaddingX: number;
  setTabNotesPaddingX: (px: number) => void;
  tabNotesPaddingY: number;
  setTabNotesPaddingY: (px: number) => void;

  // Notes Editor Modal (fullscreen) — separate sizing knobs.
  notesEditorFontSize: number;
  setNotesEditorFontSize: (size: number) => void;
  notesEditorPaddingX: number;
  setNotesEditorPaddingX: (px: number) => void;
  notesEditorPaddingY: number;
  setNotesEditorPaddingY: (px: number) => void;

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

// Status-bar toggles (persisted)
const loadDebugHoverBridges = (): boolean => {
  try { return localStorage.getItem('noted-terminal-debug-hover-bridges') === 'true'; }
  catch { return false; }
};
const saveDebugHoverBridges = (v: boolean) => {
  try { localStorage.setItem('noted-terminal-debug-hover-bridges', String(v)); } catch {}
};
const initialDebugHoverBridges = loadDebugHoverBridges();

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
    const [fontSize, padX, padY] = await Promise.all([
      ipcRenderer.invoke('app:getState', 'notesEditorFontSize'),
      ipcRenderer.invoke('app:getState', 'notesEditorPaddingX'),
      ipcRenderer.invoke('app:getState', 'notesEditorPaddingY'),
    ]);
    const patch: Partial<{ notesEditorFontSize: number; notesEditorPaddingX: number; notesEditorPaddingY: number }> = {};
    const fs = Number(fontSize);
    const px = Number(padX);
    const py = Number(padY);
    if (Number.isFinite(fs) && fs >= 10 && fs <= 28) patch.notesEditorFontSize = fs;
    if (Number.isFinite(px) && px >= 0 && px <= 48) patch.notesEditorPaddingX = px;
    if (Number.isFinite(py) && py >= 0 && py <= 48) patch.notesEditorPaddingY = py;
    if (Object.keys(patch).length > 0) {
      useUIStore.setState(patch);
      if (patch.notesEditorFontSize != null) localStorage.setItem('noted-terminal-notes-editor-font-size', String(patch.notesEditorFontSize));
      if (patch.notesEditorPaddingX != null) localStorage.setItem('noted-terminal-notes-editor-padding-x', String(patch.notesEditorPaddingX));
      if (patch.notesEditorPaddingY != null) localStorage.setItem('noted-terminal-notes-editor-padding-y', String(patch.notesEditorPaddingY));
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
  tabsFontSize: initialFontSettings.tabsFontSize,
  projectTabsFontSize: initialFontSettings.projectTabsFontSize,
  sidebarFontSize: initialFontSettings.sidebarFontSize,
  sidebarWidth: (() => { try { const v = localStorage.getItem('sidebarWidth'); return v ? Number(v) : 280; } catch { return 280; } })(),
  filePreviewFontSize: loadFilePreviewFontSize(),

  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
    try { localStorage.setItem('sidebarWidth', String(width)); } catch {}
  },

  setFilePreviewFontSize: (size: number) => {
    const clamped = Math.max(10, Math.min(24, size));
    set({ filePreviewFontSize: clamped });
    try { localStorage.setItem('noted-terminal-file-preview-font-size', String(clamped)); } catch {}
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
  showToast: (message, type = 'success', duration = 2500, persistent = false, copyText, actionLabel, onAction) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, persistent, copyText, actionLabel, onAction }]
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

  freePortsBeforeStart: initialFreePortsBeforeStart,
  setFreePortsBeforeStart: (v) => { set({ freePortsBeforeStart: v }); saveFreePortsBeforeStart(v); },

  // Default Claude effort (status-bar selector)
  defaultClaudeEffort: initialDefaultClaudeEffort,
  setDefaultClaudeEffort: (v) => { set({ defaultClaudeEffort: v }); saveDefaultClaudeEffort(v); },

  // Notes Panel — per-tab open state + SQLite-persisted shared size.
  notesPanelOpenTabs: {},
  setNotesPanelOpen: (tabId, open) => {
    const cur = get().notesPanelOpenTabs;
    if ((cur[tabId] ?? false) === open) return;
    const next = { ...cur };
    if (open) next[tabId] = true;
    else delete next[tabId];
    set({ notesPanelOpenTabs: next });
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

  // Tab Notes Font Size & Padding
  tabNotesFontSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-tab-notes-font-size');
      return saved ? parseInt(saved, 10) : 13;
    } catch { return 13; }
  })(),
  setTabNotesFontSize: (size) => {
    const clamped = Math.max(10, Math.min(24, size));
    set({ tabNotesFontSize: clamped });
    localStorage.setItem('noted-terminal-tab-notes-font-size', String(clamped));
  },
  tabNotesPaddingX: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-tab-notes-padding-x');
      return saved ? parseInt(saved, 10) : 8;
    } catch { return 8; }
  })(),
  setTabNotesPaddingX: (px) => {
    const clamped = Math.max(0, Math.min(32, px));
    set({ tabNotesPaddingX: clamped });
    localStorage.setItem('noted-terminal-tab-notes-padding-x', String(clamped));
  },
  tabNotesPaddingY: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-tab-notes-padding-y');
      return saved ? parseInt(saved, 10) : 8;
    } catch { return 8; }
  })(),
  setTabNotesPaddingY: (px) => {
    const clamped = Math.max(0, Math.min(32, px));
    set({ tabNotesPaddingY: clamped });
    localStorage.setItem('noted-terminal-tab-notes-padding-y', String(clamped));
  },

  // Notes Editor Modal (separate from inline tab-notes). Same persistence
  // pattern: localStorage for synchronous boot reads, app:setState mirror to
  // SQLite so the value survives vite port shuffles (different ports = different
  // origins = separate localStorage buckets). Defaults bigger because the modal
  // is fullscreen and users want more readable text there.
  notesEditorFontSize: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-editor-font-size');
      return saved ? parseInt(saved, 10) : 14;
    } catch { return 14; }
  })(),
  setNotesEditorFontSize: (size) => {
    const clamped = Math.max(10, Math.min(28, size));
    set({ notesEditorFontSize: clamped });
    try { localStorage.setItem('noted-terminal-notes-editor-font-size', String(clamped)); } catch {}
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('app:setState', { key: 'notesEditorFontSize', value: clamped }).catch(() => {});
    } catch {}
  },
  notesEditorPaddingX: (() => {
    try {
      const saved = localStorage.getItem('noted-terminal-notes-editor-padding-x');
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
      const saved = localStorage.getItem('noted-terminal-notes-editor-padding-y');
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
