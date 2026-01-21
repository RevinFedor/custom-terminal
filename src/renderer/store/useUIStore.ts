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

export type AIModel = 'gemini-2.0-flash' | 'gemini-3-flash-preview' | 'gemini-3-pro-preview';
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
  setTerminalFontSize: (size: number) => void;
  setTabsFontSize: (size: number) => void;
  setProjectTabsFontSize: (size: number) => void;
  incrementTerminalFontSize: () => void;
  decrementTerminalFontSize: () => void;

  // AI Model Selection (global)
  selectedModel: AIModel;
  setSelectedModel: (model: AIModel) => void;

  // Thinking Level for Gemini 3
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;

  // Research Prompt (system prompt for Research Selection)
  researchPrompt: string;
  setResearchPrompt: (prompt: string) => void;

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
  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  removeToast: (id: string) => void;

  // Notes Panel Width
  notesPanelWidth: number;
  setNotesPanelWidth: (width: number) => void;

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
        projectTabsFontSize: parsed.projectTabsFontSize ?? 12
      };
    }
  } catch (e) {
    console.error('Failed to load font settings:', e);
  }
  return { terminalFontSize: 13, tabsFontSize: 14, projectTabsFontSize: 12 };
};

// Load AI model from localStorage
const loadSelectedModel = (): AIModel => {
  try {
    const saved = localStorage.getItem('noted-terminal-ai-model');
    if (saved && ['gemini-2.0-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview'].includes(saved)) {
      return saved as AIModel;
    }
  } catch (e) {
    console.error('Failed to load AI model:', e);
  }
  return 'gemini-2.0-flash';
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

const saveFontSettings = (settings: { terminalFontSize: number; tabsFontSize: number; projectTabsFontSize: number }) => {
  try {
    localStorage.setItem('noted-terminal-font-settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save font settings:', e);
  }
};

const initialFontSettings = loadFontSettings();
const initialModel = loadSelectedModel();
const initialThinkingLevel = loadThinkingLevel();
const initialResearchPrompt = loadResearchPrompt();
const initialDocPrompt = loadDocPrompt();

export const useUIStore = create<UIStore>((set, get) => ({
  // Font Settings
  terminalFontSize: initialFontSettings.terminalFontSize,
  tabsFontSize: initialFontSettings.tabsFontSize,
  projectTabsFontSize: initialFontSettings.projectTabsFontSize,

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
    const { tabsFontSize, projectTabsFontSize } = get();
    saveFontSettings({ terminalFontSize: clamped, tabsFontSize, projectTabsFontSize });
  },
  setTabsFontSize: (size) => {
    const clamped = Math.max(10, Math.min(20, size));
    set({ tabsFontSize: clamped });
    const { terminalFontSize, projectTabsFontSize } = get();
    saveFontSettings({ terminalFontSize, tabsFontSize: clamped, projectTabsFontSize });
  },
  setProjectTabsFontSize: (size) => {
    const clamped = Math.max(10, Math.min(16, size));
    set({ projectTabsFontSize: clamped });
    const { terminalFontSize, tabsFontSize } = get();
    saveFontSettings({ terminalFontSize, tabsFontSize, projectTabsFontSize: clamped });
  },
  incrementTerminalFontSize: () => {
    const current = get().terminalFontSize;
    const newSize = Math.min(24, current + 1);
    set({ terminalFontSize: newSize });
    const { tabsFontSize, projectTabsFontSize } = get();
    saveFontSettings({ terminalFontSize: newSize, tabsFontSize, projectTabsFontSize });
  },
  decrementTerminalFontSize: () => {
    const current = get().terminalFontSize;
    const newSize = Math.max(8, current - 1);
    set({ terminalFontSize: newSize });
    const { tabsFontSize, projectTabsFontSize } = get();
    saveFontSettings({ terminalFontSize: newSize, tabsFontSize, projectTabsFontSize });
  },

  // File Explorer
  fileExplorerOpen: false,
  toggleFileExplorer: () => set((state) => ({ fileExplorerOpen: !state.fileExplorerOpen })),
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

  // Edit Project Modal
  editingProject: null,
  openEditModal: (project) => set({ editingProject: project }),
  closeEditModal: () => set({ editingProject: null }),

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
  }
}));
