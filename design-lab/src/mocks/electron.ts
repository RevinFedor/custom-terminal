/**
 * MOCK: Electron IPC
 *
 * Этот файл эмулирует window.require('electron') для работы без Electron.
 * Все вызовы ipcRenderer.invoke перехватываются и возвращают mock-данные.
 *
 * Данные сохраняются в localStorage вместо SQLite.
 */

// ============================================================================
// ЛОКАЛЬНОЕ ХРАНИЛИЩЕ (вместо SQLite)
// ============================================================================
const STORAGE_KEYS = {
  conversations: 'design-lab-conversations',
  settings: 'design-lab-settings',
};

function getFromStorage<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('[Mock Storage] Failed to save:', e);
  }
}

// ============================================================================
// IPC HANDLERS
// Добавляй сюда новые хендлеры по мере необходимости
// ============================================================================
const ipcHandlers: Record<string, (args: any) => Promise<any>> = {
  // Research: сохранение беседы
  'research:save-conversation': async ({ dirPath, conversation }) => {
    const conversations = getFromStorage<Record<string, any>>(
      STORAGE_KEYS.conversations,
      {}
    );
    const key = `${dirPath}:${conversation.id}`;
    conversations[key] = conversation;
    saveToStorage(STORAGE_KEYS.conversations, conversations);
    console.log('[Mock IPC] Saved conversation:', conversation.id);
    return { success: true };
  },

  // Research: получение бесед
  'research:get-conversations': async (dirPath: string) => {
    const conversations = getFromStorage<Record<string, any>>(
      STORAGE_KEYS.conversations,
      {}
    );
    // Фильтруем по dirPath
    const filtered = Object.entries(conversations)
      .filter(([key]) => key.startsWith(`${dirPath}:`))
      .map(([, value]) => value)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { success: true, data: filtered };
  },

  // Research: удаление беседы
  'research:delete-conversation': async ({ dirPath, conversationId }) => {
    const conversations = getFromStorage<Record<string, any>>(
      STORAGE_KEYS.conversations,
      {}
    );
    const key = `${dirPath}:${conversationId}`;
    delete conversations[key];
    saveToStorage(STORAGE_KEYS.conversations, conversations);
    console.log('[Mock IPC] Deleted conversation:', conversationId);
    return { success: true };
  },

  // Fallback для неизвестных каналов
  default: async (channel: string) => {
    console.warn(`[Mock IPC] Unhandled channel: ${channel}`);
    return { success: true, data: null };
  },
};

// ============================================================================
// MOCK ipcRenderer
// ============================================================================
const mockIpcRenderer = {
  invoke: async (channel: string, ...args: any[]) => {
    const handler = ipcHandlers[channel] || ipcHandlers.default;
    return handler(args[0] ?? channel);
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    console.log(`[Mock IPC] Registered listener for: ${channel}`);
    return mockIpcRenderer;
  },
  removeListener: () => mockIpcRenderer,
  removeAllListeners: () => mockIpcRenderer,
};

// ============================================================================
// ПАТЧ window.require
// ============================================================================
(window as any).require = (module: string) => {
  if (module === 'electron') {
    return { ipcRenderer: mockIpcRenderer };
  }
  throw new Error(`[Mock] Cannot require module: ${module}`);
};

console.log('[Design Lab] Electron IPC mock initialized');
