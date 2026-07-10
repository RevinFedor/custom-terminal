import { create } from 'zustand';
import type { GeminiModelId } from '../constants/geminiModels';

export type AIModel = GeminiModelId;
export type ThinkingLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export const TAB_TITLE_PROMPT_ID = 'tab-title';
export const RUN_AFTER_TITLE_PROMPT_ID = 'run-after-title';
export const PROMPT_SUMMARY_PROMPT_ID = 'prompt-summary';
export const TIMELINE_GROUPING_PROMPT_ID = 'timeline-grouping';
export const GIT_COMMIT_PROMPT_ID = 'git-commit';
export const DEFAULT_TAB_TITLE_PROMPT = 'На основе первого пользовательского сообщения придумай короткое название вкладки. Верни только название: 2-6 слов, без кавычек, без точки, без markdown, без пояснений.';
export const DEFAULT_RUN_AFTER_TITLE_PROMPT = 'На основе текста задачи Run after придумай короткое название задачи. Верни только название: 2-7 слов, без кавычек, без точки, без markdown, без пояснений. Если текст на русском — название тоже на русском; если на английском — на английском.';
export const DEFAULT_PROMPT_SUMMARY_PROMPT = 'Перескажи пользовательское сообщение для строки таймлайна. Верни только краткий пересказ до 70 символов: без кавычек, без точки в конце, без пояснений. Сохрани язык исходного сообщения. Оберни одинарными звездочками 1-2 главных смысловых акцента, за которые цепляется взгляд: объект или тему действия, например смена *названий системных промптов* или *обновление документации*. Не выделяй всю строку и не используй другой markdown.';
export const DEFAULT_TIMELINE_GROUPING_PROMPT = 'Group a chronological list of user turns into a compact semantic outline.\nA group is one concrete work phase with at least two contiguous turns.\nKeep the hierarchy flat, preserve chronological order, and leave uncertain or isolated turns ungrouped.\nNever cross an item marked boundaryBefore.\nUse short titles and descriptions in the predominant language of the supplied turns.\nMeta-prompt markers describe workflow actions; do not infer their omitted template body.';
export const DEFAULT_GIT_COMMIT_PROMPT = 'You write concise Git commit messages for local commits.\nReturn only JSON with keys "summary" and "description".\n\nRules:\n- The summary must be one line, imperative mood when possible, no trailing period, under 72 characters.\n- The description may be empty. If non-empty, use 1-4 short lines with concrete facts.\n- Do not mention files that are not present in the provided changes.\n- If docs/ changed, base the commit message on changed docs files only when the prompt data says docs-only context was applied.\n- If docs/ did not change, use all included changes.';

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
  },
  {
    id: TIMELINE_GROUPING_PROMPT_ID,
    name: 'Timeline Grouping',
    content: DEFAULT_TIMELINE_GROUPING_PROMPT,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'LOW',
    color: '#c084fc',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 8,
    filePaths: []
  },
  {
    id: GIT_COMMIT_PROMPT_ID,
    name: 'Git Commit',
    content: DEFAULT_GIT_COMMIT_PROMPT,
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'NONE',
    color: '#facc15',
    isBuiltIn: true,
    showInContextMenu: false,
    position: 9,
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
