import { create } from 'zustand';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}

interface FilePreview {
  path: string;
  content: string;
  language: string | null;
}

export type AIModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';

export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type ChatType = 'research' | 'compact';

export type WorkspaceView = 'terminal' | 'home';



export interface ChatTypeSettings {

  model: AIModel;

  thinkingLevel: ThinkingLevel;

  prompt: string;

}



export type ChatSettingsMap = Record<ChatType, ChatTypeSettings>;



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



  // Research Prompt (system prompt for Research Selection)

  researchPrompt: string;

  setResearchPrompt: (prompt: string) => void;



  // Claude Default Prompt toggle
  claudeDefaultPromptEnabled: boolean;
  setClaudeDefaultPromptEnabled: (enabled: boolean) => void;

  // Documentation Prompt (for Update Docs feature)

  docPrompt: DocPromptSettings;

  setDocPromptUseFile: (useFile: boolean) => void;

  setDocPromptFilePath: (path: string) => void;

  setDocPromptInlineContent: (content: string) => void;



  // Per-chat-type settings (research, compact, etc.)

  chatSettings: ChatSettingsMap;

  getChatSettings: (type: ChatType) => ChatTypeSettings;

  setChatSettings: (type: ChatType, settings: Partial<ChatTypeSettings>) => void;



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

  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;

  removeToast: (id: string) => void;



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

  // Notes Editor Modal
  notesEditorOpen: boolean;
  notesEditorProjectId: string | null;
  openNotesEditor: (projectId: string) => void;
  closeNotesEditor: () => void;

  // Tab Notes Font Size
  tabNotesFontSize: number;
  setTabNotesFontSize: (size: number) => void;

  // Workspace View (terminal or project home)
  currentView: WorkspaceView;
  setCurrentView: (view: WorkspaceView) => void;
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



const DEFAULT_RESEARCH_PROMPT = 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ';



const DEFAULT_COMPACT_PROMPT = 'Проанализируй всю нашу текущую сессию и составь структурированное резюме для переноса контекста в новый чат, включив в него: изначальную цель; список всех созданных файлов с пояснением, почему мы выбрали именно такую структуру и эти файлы; краткий отчет о том, что работает; детальный разбор того, что НЕ получилось, с указанием конкретных причин ошибок (почему выбранные решения не сработали); текущее состояние кода и пошаговый план дальнейших действий — оформи это всё одним компактным сообщением, которое я смогу скопировать и отправить тебе в новом чате для полного восстановления контекста.\n\nВот текст сессии:\n';



const DEFAULT_CHAT_SETTINGS: ChatSettingsMap = {

  research: {

    model: 'gemini-3-flash-preview',

    thinkingLevel: 'HIGH',

    prompt: DEFAULT_RESEARCH_PROMPT

  },

  compact: {

    model: 'gemini-3-flash-preview',

    thinkingLevel: 'HIGH',

    prompt: DEFAULT_COMPACT_PROMPT

  }

};

const loadChatSettings = (): ChatSettingsMap => {
  try {
    const saved = localStorage.getItem('noted-terminal-chat-settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults to ensure all types have settings
      return {
        research: { ...DEFAULT_CHAT_SETTINGS.research, ...parsed.research },
        compact: { ...DEFAULT_CHAT_SETTINGS.compact, ...parsed.compact }
      };
    }
  } catch (e) {
    console.error('Failed to load chat settings:', e);
  }
  return DEFAULT_CHAT_SETTINGS;
};

const saveChatSettings = (settings: ChatSettingsMap) => {
  try {
    localStorage.setItem('noted-terminal-chat-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save chat settings:', e);
  }
};

const loadResearchPrompt = (): string => {
  try {
    const saved = localStorage.getItem('noted-terminal-research-prompt');
    if (saved) return saved;
  } catch (e) {
    console.error('Failed to load research prompt:', e);
  }
  return DEFAULT_RESEARCH_PROMPT;
};

const saveResearchPrompt = (prompt: string) => {
  try {
    localStorage.setItem('noted-terminal-research-prompt', prompt);
  } catch (e) {
    console.error('Failed to save research prompt:', e);
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
const initialResearchPrompt = loadResearchPrompt();
const initialDocPrompt = loadDocPrompt();
const initialChatSettings = loadChatSettings();

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

  // Research Prompt
  researchPrompt: initialResearchPrompt,
  setResearchPrompt: (prompt) => {
    set({ researchPrompt: prompt });
    saveResearchPrompt(prompt);
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

  // Per-chat-type settings
  chatSettings: initialChatSettings,
  getChatSettings: (type) => {
    return get().chatSettings[type];
  },
  setChatSettings: (type, settings) => {
    const current = get().chatSettings;
    const updated = {
      ...current,
      [type]: { ...current[type], ...settings }
    };
    set({ chatSettings: updated });
    saveChatSettings(updated);
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
  showToast: (message, type = 'success') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }]
    }));

    // Auto remove after 2.5 seconds
    setTimeout(() => {
      get().removeToast(id);
    }, 2500);
  },
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id)
  })),

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

  // Notes Editor Modal
  notesEditorOpen: false,
  notesEditorProjectId: null,
  openNotesEditor: (projectId) => set({ notesEditorOpen: true, notesEditorProjectId: projectId }),
  closeNotesEditor: () => set({ notesEditorOpen: false, notesEditorProjectId: null }),

  // Tab Notes Font Size
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

  // Workspace View
  currentView: 'terminal',
  setCurrentView: (view) => set({ currentView: view }),

  // Focus Area
  activeArea: 'workspace',
  setActiveArea: (area) => set({ activeArea: area })
}));

if (typeof window !== 'undefined') {
  (window as any).useUIStore = useUIStore;
}
