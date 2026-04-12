import { create } from 'zustand';

export type AIModel = 'gemini-3-flash-preview' | 'gemini-3-pro-preview';
export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface AIPrompt {
  id: string;              // 'research' | 'compact' | 'description' | 'prompt-<timestamp>'
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
    id: 'research',
    name: 'Research',
    content: 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'HIGH',
    color: '#0ea5e9',
    isBuiltIn: true,
    showInContextMenu: true,
    position: 0,
    filePaths: []
  },
  {
    id: 'compact',
    name: 'Compact (Резюме)',
    content: 'Проанализируй всю нашу текущую сессию и составь структурированное резюме для переноса контекста в новый чат, включив в него: изначальную цель; список всех созданных файлов с пояснением, почему мы выбрали именно такую структуру и эти файлы; краткий отчет о том, что работает; детальный разбор того, что НЕ получилось, с указанием конкретных причин ошибок (почему выбранные решения не сработали); текущее состояние кода и пошаговый план дальнейших действий — оформи это всё одним компактным сообщением, которое я смогу скопировать и отправить тебе в новом чате для полного восстановления контекста.\n\nВот текст сессии:\n',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'HIGH',
    color: '#a855f7',
    isBuiltIn: true,
    showInContextMenu: true,
    position: 1,
    filePaths: []
  },
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
