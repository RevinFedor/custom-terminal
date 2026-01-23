/**
 * STORE: Research Chat
 *
 * Упрощённая версия useResearchStore для design-lab.
 * Использует localStorage вместо SQLite через mock IPC.
 */

import { create } from 'zustand';

// ============================================================================
// ТИПЫ
// ============================================================================
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface ResearchStore {
  // Текущий диалог (для простоты - один на весь лаб)
  conversation: Conversation | null;
  messages: Message[];

  // Actions
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  updateLastMessage: (content: string) => void;
  clearChat: () => void;

  // Состояние загрузки
  isLoading: boolean;
  setLoading: (loading: boolean) => void;

  // Abort
  abortController: AbortController | null;
  setAbortController: (controller: AbortController | null) => void;
  cancelRequest: () => void;
}

// ============================================================================
// HELPERS
// ============================================================================
const STORAGE_KEY = 'design-lab-research-chat';

function loadFromStorage(): Message[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveToStorage(messages: Message[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error('Failed to save messages:', e);
  }
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// STORE
// ============================================================================
export const useResearchStore = create<ResearchStore>((set, get) => ({
  conversation: null,
  messages: loadFromStorage(),

  addMessage: (role, content) => {
    const message: Message = {
      id: generateId(),
      role,
      content,
      timestamp: Date.now(),
    };

    set((state) => {
      const newMessages = [...state.messages, message];
      saveToStorage(newMessages);
      return { messages: newMessages };
    });
  },

  updateLastMessage: (content) => {
    set((state) => {
      const messages = [...state.messages];
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === 'assistant') {
          messages[messages.length - 1] = { ...last, content };
          saveToStorage(messages);
        }
      }
      return { messages };
    });
  },

  clearChat: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ messages: [] });
  },

  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),

  abortController: null,
  setAbortController: (controller) => set({ abortController: controller }),
  cancelRequest: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
      set({ abortController: null, isLoading: false });
    }
  },
}));
