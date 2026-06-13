import { create } from 'zustand';
import type { GeminiModelId } from '../constants/geminiModels';

export type AIModel = GeminiModelId;
export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export const TAB_TITLE_PROMPT_ID = 'tab-title';
export const RUN_AFTER_TITLE_PROMPT_ID = 'run-after-title';
export const PROMPT_SUMMARY_PROMPT_ID = 'prompt-summary';
export const DEFAULT_TAB_TITLE_PROMPT = 'На основе первого пользовательского сообщения придумай короткое название вкладки. Верни только название: 2-6 слов, без кавычек, без точки, без markdown, без пояснений.';
export const DEFAULT_RUN_AFTER_TITLE_PROMPT = 'На основе текста задачи Run after придумай короткое название задачи. Верни только название: 2-7 слов, без кавычек, без точки, без markdown, без пояснений. Если текст на русском — название тоже на русском; если на английском — на английском.';
export const DEFAULT_PROMPT_SUMMARY_PROMPT = 'Перескажи пользовательское сообщение для строки таймлайна. Верни только краткий пересказ до 70 символов: без кавычек, без точки в конце, без пояснений. Сохрани язык исходного сообщения. Одно главное ключевое слово или короткую ключевую фразу оберни одинарными звездочками, например *fork*.';

export interface AIPrompt {
  id: string;              // built-ins like 'research' | 'compact' | 'tab-title' or 'prompt-<timestamp>'
  name: string;            // "Research", "Compact (Резюме)", "Code Review"
  content: string;         // Текст промпта
  model: AIModel;
  thinkingLevel: ThinkingLevel;
  color: string;           // '#0ea5e9'
  isBuiltIn: boolean;      // true для Research/Compact/Description — нельзя удалить
  showInContextMenu: boolean;
  position: number;        // Порядок сортировки
  filePaths: string[];     // Абсолютные пути к прикреплённым файлам
}

const { ipcRenderer } = window.require('electron');

interface PromptsStore {
  prompts: AIPrompt[];
  isLoaded: boolean;
  loadPrompts: () => Promise<void>;
  getPromptById: (id: string) => AIPrompt | undefined;
  savePrompt: (prompt: AIPrompt) => Promise<void>;
  deletePrompt: (id: string) => Promise<void>;
  rewindPromptId: string;
  setRewindPromptId: (id: string) => void;
}

// Fallback defaults (used before DB loads)
const FALLBACK_PROMPTS: AIPrompt[] = [
  {
    id: 'rewind',
    name: 'Rewind (Откат)',
    content: 'Ниже представлена сессия из нейронки (Claude Code). Составь краткую сводку:\n\n1. **Изначальная цель** — что делали\n2. **Изменённые файлы** — путь, какие функции/компоненты затронуты, зачем\n3. **Что работает** — кратко\n4. **Что НЕ работает и ПОЧЕМУ** — конкретные причины ошибок, какие решения пробовали и почему они не сработали\n5. **Текущее состояние** — на чём остановились\n\nВажно: только факты и анализ. Никакого плана, никаких рекомендаций, никаких \"следующих шагов\". Не добавляй своё мнение. Начни сразу со сводки.\n\nСессия:\n',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'HIGH',
    color: '#ec4899',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 3,
    filePaths: []
  },
  {
    id: 'description',
    name: 'Description',
    content: '1-2 предложения: что сделано. Без маркдауна, без вступлений.\n\n',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'NONE',
    color: '#f59e0b',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 2,
    filePaths: []
  },
  {
    id: 'adopt',
    name: 'Adopt Summary',
    content: 'Ниже — сессия разработки Claude Code. Опиши конкретно что агент делал и на чём остановился (3-7 предложений). Какие файлы менял, какие действия выполнил, что осталось незавершённым. Только факты — без оценок и рекомендаций.\n',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'NONE',
    color: '#6366f1',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 4,
    filePaths: []
  },
  {
    id: TAB_TITLE_PROMPT_ID,
    name: 'Tab Title',
    content: DEFAULT_TAB_TITLE_PROMPT,
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'NONE',
    color: '#22c55e',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 5,
    filePaths: []
  },
  {
    id: RUN_AFTER_TITLE_PROMPT_ID,
    name: 'Run After Title',
    content: DEFAULT_RUN_AFTER_TITLE_PROMPT,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'NONE',
    color: '#DA7756',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 6,
    filePaths: []
  },
  {
    id: PROMPT_SUMMARY_PROMPT_ID,
    name: 'Prompt Summary',
    content: DEFAULT_PROMPT_SUMMARY_PROMPT,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'NONE',
    color: '#38bdf8',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 7,
    filePaths: []
  }
];

export const usePromptsStore = create<PromptsStore>((set, get) => ({
  prompts: FALLBACK_PROMPTS,
  isLoaded: false,

  loadPrompts: async () => {
    try {
      const result = await ipcRenderer.invoke('ai-prompts:get');
      if (result.success && Array.isArray(result.data) && result.data.length > 0) {
        set({ prompts: result.data, isLoaded: true });
      } else {
        // DB empty — use fallbacks
        set({ isLoaded: true });
      }

      // Also load rewindPromptId from app_state
      const rewindId = await ipcRenderer.invoke('app:getState', 'rewindPromptId');
      if (rewindId) {
        set({ rewindPromptId: rewindId });
      }
    } catch (e) {
      console.error('[PromptsStore] Failed to load prompts:', e);
      set({ isLoaded: true });
    }
  },

  getPromptById: (id: string) => {
    return get().prompts.find(p => p.id === id);
  },

  savePrompt: async (prompt: AIPrompt) => {
    try {
      await ipcRenderer.invoke('ai-prompts:save', prompt);
      // Update local state
      set((state) => {
        const idx = state.prompts.findIndex(p => p.id === prompt.id);
        if (idx >= 0) {
          const updated = [...state.prompts];
          updated[idx] = prompt;
          return { prompts: updated };
        } else {
          return { prompts: [...state.prompts, prompt] };
        }
      });
    } catch (e) {
      console.error('[PromptsStore] Failed to save prompt:', e);
    }
  },

  deletePrompt: async (id: string) => {
    try {
      await ipcRenderer.invoke('ai-prompts:delete', id);
      set((state) => ({
        prompts: state.prompts.filter(p => p.id !== id)
      }));
    } catch (e) {
      console.error('[PromptsStore] Failed to delete prompt:', e);
    }
  },

  rewindPromptId: 'rewind',

  setRewindPromptId: (id: string) => {
    set({ rewindPromptId: id });
    ipcRenderer.invoke('app:setState', { key: 'rewindPromptId', value: id });
  }
}));
