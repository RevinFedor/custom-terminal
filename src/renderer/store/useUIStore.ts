import { create } from 'zustand';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  persistent?: boolean;
}

interface FilePreview {
  path: string;
  content: string;
  language: string | null;
}

export type AIModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';

export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';


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

  setTerminalFontSize: (size: number) => void;

  setTabsFontSize: (size: number) => void;

  setProjectTabsFontSize: (size: number) => void;

  setSidebarFontSize: (size: number) => void;

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

  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number, persistent?: boolean) => void;

  removeToast: (id: string) => void;



  // History Panel (per-tab state)
  historyPanelOpenTabs: Record<string, boolean>;
  historyPanelWidth: number;
  historyScrollToUuid: string | null;
  historyVisibleUuids: Record<string, string[]>;
  setHistoryPanelOpen: (tabId: string, open: boolean) => void;
  setHistoryPanelWidth: (width: number) => void;
  setHistoryScrollToUuid: (uuid: string | null) => void;
  setHistoryVisibleUuids: (tabId: string, uuids: string[]) => void;

  // Notes Panel Width

  notesPanelWidth: number;

  setNotesPanelWidth: (width: number) => void;

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
  copyIncludeEditing: boolean;
  copyIncludeReading: boolean;
  copyFromStart: boolean;
  copyIncludeSubagentResult: boolean;
  copyIncludeSubagentHistory: boolean;
  setCopyIncludeEditing: (v: boolean) => void;
  setCopyIncludeReading: (v: boolean) => void;
  setCopyFromStart: (v: boolean) => void;
  setCopyIncludeSubagentResult: (v: boolean) => void;
  setCopyIncludeSubagentHistory: (v: boolean) => void;

  // Notes Editor Modal
  notesEditorOpen: boolean;
  notesEditorProjectId: string | null;
  openNotesEditor: (projectId: string) => void;
  closeNotesEditor: () => void;

  // Tab Notes Font Size & Padding
  tabNotesFontSize: number;
  setTabNotesFontSize: (size: number) => void;
  tabNotesPaddingX: number;
  setTabNotesPaddingX: (px: number) => void;
  tabNotesPaddingY: number;
  setTabNotesPaddingY: (px: number) => void;

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

const loadCopySettings = (): { copyIncludeEditing: boolean; copyIncludeReading: boolean; copyFromStart: boolean; copyIncludeSubagentResult: boolean; copyIncludeSubagentHistory: boolean } => {
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
      };
    }
  } catch (e) {
    console.error('Failed to load copy settings:', e);
  }
  return { copyIncludeEditing: true, copyIncludeReading: false, copyFromStart: true, copyIncludeSubagentResult: false, copyIncludeSubagentHistory: false };
};

const saveCopySettings = (settings: { copyIncludeEditing: boolean; copyIncludeReading: boolean; copyFromStart: boolean; copyIncludeSubagentResult: boolean; copyIncludeSubagentHistory: boolean }) => {
  try {
    localStorage.setItem('noted-terminal-copy-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save copy settings:', e);
  }
};

const initialCopySettings = loadCopySettings();

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

export const useUIStore = create<UIStore>((set, get) => ({
  // Font Settings
  terminalFontSize: initialFontSettings.terminalFontSize,
  tabsFontSize: initialFontSettings.tabsFontSize,
  projectTabsFontSize: initialFontSettings.projectTabsFontSize,
  sidebarFontSize: initialFontSettings.sidebarFontSize,

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
  showToast: (message, type = 'success', duration = 2500, persistent = false) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, persistent }]
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
      return saved ? Math.max(280, Math.min(700, parseInt(saved, 10))) : 580;
    } catch { return 580; }
  })(),
  historyScrollToUuid: null,
  historyVisibleUuids: {},
  setHistoryPanelOpen: (tabId, open) => set(state => ({
    historyPanelOpenTabs: { ...state.historyPanelOpenTabs, [tabId]: open }
  })),
  setHistoryScrollToUuid: (uuid) => set({ historyScrollToUuid: uuid }),
  setHistoryVisibleUuids: (tabId, uuids) => set(state => ({
    historyVisibleUuids: { ...state.historyVisibleUuids, [tabId]: uuids }
  })),
  setHistoryPanelWidth: (width) => {
    const clamped = Math.max(280, Math.min(700, width));
    set({ historyPanelWidth: clamped });
    localStorage.setItem('noted-terminal-history-panel-width', String(clamped));
  },

  // Notes Panel Width
  notesPanelWidth: 300,
  setNotesPanelWidth: (width) => set({ notesPanelWidth: Math.max(150, Math.min(600, width)) }),

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

  // Copy Settings
  copyIncludeEditing: initialCopySettings.copyIncludeEditing,
  copyIncludeReading: initialCopySettings.copyIncludeReading,
  copyFromStart: initialCopySettings.copyFromStart,
  copyIncludeSubagentResult: initialCopySettings.copyIncludeSubagentResult,
  copyIncludeSubagentHistory: initialCopySettings.copyIncludeSubagentHistory,
  setCopyIncludeEditing: (v) => {
    set({ copyIncludeEditing: v });
    const { copyIncludeReading, copyFromStart, copyIncludeSubagentResult, copyIncludeSubagentHistory } = get();
    saveCopySettings({ copyIncludeEditing: v, copyIncludeReading, copyFromStart, copyIncludeSubagentResult, copyIncludeSubagentHistory });
  },
  setCopyIncludeReading: (v) => {
    set({ copyIncludeReading: v });
    const { copyIncludeEditing, copyFromStart, copyIncludeSubagentResult, copyIncludeSubagentHistory } = get();
    saveCopySettings({ copyIncludeEditing, copyIncludeReading: v, copyFromStart, copyIncludeSubagentResult, copyIncludeSubagentHistory });
  },
  setCopyFromStart: (v) => {
    set({ copyFromStart: v });
    const { copyIncludeEditing, copyIncludeReading, copyIncludeSubagentResult, copyIncludeSubagentHistory } = get();
    saveCopySettings({ copyIncludeEditing, copyIncludeReading, copyFromStart: v, copyIncludeSubagentResult, copyIncludeSubagentHistory });
  },
  setCopyIncludeSubagentResult: (v) => {
    set({ copyIncludeSubagentResult: v });
    const { copyIncludeEditing, copyIncludeReading, copyFromStart, copyIncludeSubagentHistory } = get();
    saveCopySettings({ copyIncludeEditing, copyIncludeReading, copyFromStart, copyIncludeSubagentResult: v, copyIncludeSubagentHistory });
  },
  setCopyIncludeSubagentHistory: (v) => {
    set({ copyIncludeSubagentHistory: v });
    const { copyIncludeEditing, copyIncludeReading, copyFromStart, copyIncludeSubagentResult } = get();
    saveCopySettings({ copyIncludeEditing, copyIncludeReading, copyFromStart, copyIncludeSubagentResult, copyIncludeSubagentHistory: v });
  },

  // Notes Editor Modal
  notesEditorOpen: false,
  notesEditorProjectId: null,
  openNotesEditor: (projectId) => set({ notesEditorOpen: true, notesEditorProjectId: projectId }),
  closeNotesEditor: () => set({ notesEditorOpen: false, notesEditorProjectId: null }),

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
