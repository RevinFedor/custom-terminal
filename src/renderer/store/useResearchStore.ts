import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type ChatType = 'research' | 'compact' | 'description';

export interface Conversation {
  id: string;
  title: string; // First user message preview
  messages: Message[];
  type: ChatType; // Type of chat (research, compact, etc.)
  createdAt: number;
  updatedAt: number;
}

interface ResearchStore {
  // Panel state
  isOpen: boolean;
  openResearch: () => void;
  closeResearch: () => void;
  toggleResearch: () => void;

  // Trigger research from context menu (survives panel mount/unmount)
  pendingResearch: boolean;
  pendingChatType: ChatType;
  triggerResearch: (type?: ChatType) => void;
  clearPendingResearch: () => void;

  // Conversations per project: projectId -> conversationId -> Conversation
  conversations: Record<string, Record<string, Conversation>>;

  // Active conversation per project
  activeConversationId: Record<string, string | null>;

  // Create new conversation and return its id
  createConversation: (projectId: string, projectPath: string, firstUserMessage: string, type?: ChatType) => string;

  // Add message to active conversation
  addMessage: (projectId: string, projectPath: string, role: 'user' | 'assistant', content: string) => void;

  // Get all conversations for project
  getProjectConversations: (projectId: string) => Conversation[];

  // Get active conversation
  getActiveConversation: (projectId: string) => Conversation | null;

  // Set active conversation
  setActiveConversation: (projectId: string, conversationId: string | null) => void;

  // Delete conversation
  deleteConversation: (projectId: string, projectPath: string, conversationId: string) => void;

  // Edit message (truncates history after this message)
  editMessage: (projectId: string, projectPath: string, messageId: string, newContent: string) => void;

  // Delete single message (and its pair if user message)
  deleteMessage: (projectId: string, projectPath: string, messageId: string) => void;

  // Truncate history after message (for retry) - removes this message and all after it
  truncateFromMessage: (projectId: string, projectPath: string, messageId: string) => void;

  // Loading state
  isLoading: boolean;
  setLoading: (loading: boolean) => void;

  // Abort controller for cancellation
  abortController: AbortController | null;
  setAbortController: (controller: AbortController | null) => void;
  cancelRequest: () => void;

  // Sync with DB
  loadFromDB: (projectId: string, projectPath: string) => Promise<void>;
}

// Load from localStorage (Legacy fallback / Cache)
const loadData = () => {
  try {
    const saved = localStorage.getItem('noted-terminal-research-v2');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load research data:', e);
  }
  return { conversations: {}, activeConversationId: {} };
};

// Save to localStorage
const saveData = (conversations: Record<string, Record<string, Conversation>>, activeConversationId: Record<string, string | null>) => {
  try {
    localStorage.setItem('noted-terminal-research-v2', JSON.stringify({ conversations, activeConversationId }));
  } catch (e) {
    console.error('Failed to save research data:', e);
  }
};

// Helper to save specific conversation to DB
const saveToDB = async (projectPath: string, conversation: Conversation) => {
  try {
    const { ipcRenderer } = window.require('electron');
    await ipcRenderer.invoke('research:save-conversation', { dirPath: projectPath, conversation });
  } catch (e) {
    console.error('Failed to save conversation to DB:', e);
  }
};

// Helper to delete from DB
const deleteFromDB = async (projectPath: string, conversationId: string) => {
  try {
    const { ipcRenderer } = window.require('electron');
    await ipcRenderer.invoke('research:delete-conversation', { dirPath: projectPath, conversationId });
  } catch (e) {
    console.error('Failed to delete conversation from DB:', e);
  }
};

const initialData = loadData();

export const useResearchStore = create<ResearchStore>((set, get) => ({
  // Panel state
  isOpen: false,
  openResearch: () => set({ isOpen: true }),
  closeResearch: () => set({ isOpen: false }),
  toggleResearch: () => set((state) => ({ isOpen: !state.isOpen })),

  // Pending research trigger (survives panel mount)
  pendingResearch: false,
  pendingChatType: 'research' as ChatType,
  triggerResearch: (type: ChatType = 'research') => set({ pendingResearch: true, pendingChatType: type, isOpen: true }),
  clearPendingResearch: () => set({ pendingResearch: false }),

  // Data
  conversations: initialData.conversations || {},
  activeConversationId: initialData.activeConversationId || {},

  loadFromDB: async (projectId, projectPath) => {
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('research:get-conversations', projectPath);
      
      if (result.success && Array.isArray(result.data)) {
        const dbConversations = result.data;
        
        // Convert array to record
        const convRecord: Record<string, Conversation> = {};
        dbConversations.forEach((conv: Conversation) => {
          convRecord[conv.id] = conv;
        });

        set((state) => {
          const existingProjectConvs = state.conversations[projectId] || {};
          
          // Merge DB conversations into existing ones (DB takes precedence if ID exists)
          const mergedProjectConvs = {
             ...existingProjectConvs,
             ...convRecord
          };

          const newConversations = {
            ...state.conversations,
            [projectId]: mergedProjectConvs
          };
          
          // Determine active ID if not set
          let newActiveId = state.activeConversationId[projectId];
          if (!newActiveId && dbConversations.length > 0) {
             newActiveId = dbConversations[0].id; // Most recent due to SQL sorting
          }

          const newActiveIds = {
            ...state.activeConversationId,
            [projectId]: newActiveId
          };

          saveData(newConversations, newActiveIds);
          return { conversations: newConversations, activeConversationId: newActiveIds };
        });
      }
    } catch (e) {
      console.error('Error loading conversations from DB:', e);
    }
  },

  createConversation: (projectId, projectPath, firstUserMessage, type = 'research') => {
    const convId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const conversation: Conversation = {
      id: convId,
      title: firstUserMessage.slice(0, 50) + (firstUserMessage.length > 50 ? '...' : ''),
      messages: [{
        id: `msg-${now}`,
        role: 'user',
        content: firstUserMessage,
        timestamp: now
      }],
      type,
      createdAt: now,
      updatedAt: now
    };

    set((state) => {
      const projectConvs = state.conversations[projectId] || {};
      const newConversations = {
        ...state.conversations,
        [projectId]: {
          ...projectConvs,
          [convId]: conversation
        }
      };
      const newActiveIds = {
        ...state.activeConversationId,
        [projectId]: convId
      };
      saveData(newConversations, newActiveIds);
      
      // Save to DB
      saveToDB(projectPath, conversation);

      return {
        conversations: newConversations,
        activeConversationId: newActiveIds
      };
    });

    return convId;
  },

  addMessage: (projectId, projectPath, role, content) => {
    const state = get();
    const activeId = state.activeConversationId[projectId];
    if (!activeId) {
      console.error('[ResearchStore] No active conversation');
      return;
    }

    const message: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role,
      content,
      timestamp: Date.now()
    };

    set((state) => {
      const conv = state.conversations[projectId]?.[activeId];
      if (!conv) return state;

      const updatedConv: Conversation = {
        ...conv,
        messages: [...conv.messages, message],
        updatedAt: Date.now()
      };

      const newConversations = {
        ...state.conversations,
        [projectId]: {
          ...state.conversations[projectId],
          [activeId]: updatedConv
        }
      };
      saveData(newConversations, state.activeConversationId);
      
      // Save to DB
      saveToDB(projectPath, updatedConv);

      return { conversations: newConversations };
    });
  },

  getProjectConversations: (projectId) => {
    const convs = get().conversations[projectId] || {};
    return Object.values(convs).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  getActiveConversation: (projectId) => {
    const state = get();
    const activeId = state.activeConversationId[projectId];
    if (!activeId) return null;
    return state.conversations[projectId]?.[activeId] || null;
  },

  setActiveConversation: (projectId, conversationId) => {
    set((state) => {
      const newActiveIds = {
        ...state.activeConversationId,
        [projectId]: conversationId
      };
      saveData(state.conversations, newActiveIds);
      return { activeConversationId: newActiveIds };
    });
  },

  deleteConversation: (projectId, projectPath, conversationId) => {
    set((state) => {
      const projectConvs = { ...state.conversations[projectId] };
      delete projectConvs[conversationId];

      const newConversations = {
        ...state.conversations,
        [projectId]: projectConvs
      };

      // If deleted active, set to null or first available
      let newActiveId = state.activeConversationId[projectId];
      if (newActiveId === conversationId) {
        const remaining = Object.keys(projectConvs);
        newActiveId = remaining.length > 0 ? remaining[0] : null;
      }

      const newActiveIds = {
        ...state.activeConversationId,
        [projectId]: newActiveId
      };

      saveData(newConversations, newActiveIds);
      
      // Delete from DB
      deleteFromDB(projectPath, conversationId);
      
      return {
        conversations: newConversations,
        activeConversationId: newActiveIds
      };
    });
  },

  editMessage: (projectId, projectPath, messageId, newContent) => {
    set((state) => {
      const activeId = state.activeConversationId[projectId];
      if (!activeId) return state;

      const conv = state.conversations[projectId]?.[activeId];
      if (!conv) return state;

      const msgIndex = conv.messages.findIndex(m => m.id === messageId);
      if (msgIndex === -1) return state;

      // Keep messages up to the edited one (inclusive)
      // Actually, we replace the content of the target message, and remove everything AFTER it.
      // Because we will probably trigger a re-fetch immediately after this in the UI.
      
      const updatedMessages = conv.messages.slice(0, msgIndex + 1);
      updatedMessages[msgIndex] = {
        ...updatedMessages[msgIndex],
        content: newContent,
        timestamp: Date.now()
      };

      const updatedConv: Conversation = {
        ...conv,
        messages: updatedMessages,
        updatedAt: Date.now()
      };

      const newConversations = {
        ...state.conversations,
        [projectId]: {
          ...state.conversations[projectId],
          [activeId]: updatedConv
        }
      };

      saveData(newConversations, state.activeConversationId);
      
      // Save to DB
      saveToDB(projectPath, updatedConv);
      
      return { conversations: newConversations };
    });
  },

  deleteMessage: (projectId, projectPath, messageId) => {
    set((state) => {
      const activeId = state.activeConversationId[projectId];
      if (!activeId) return state;

      const conv = state.conversations[projectId]?.[activeId];
      if (!conv) return state;

      const msgIndex = conv.messages.findIndex(m => m.id === messageId);
      if (msgIndex === -1) return state;

      const targetMsg = conv.messages[msgIndex];
      let updatedMessages: Message[];

      if (targetMsg.role === 'user') {
        // Delete user message AND the following assistant response (if exists)
        const nextMsg = conv.messages[msgIndex + 1];
        if (nextMsg && nextMsg.role === 'assistant') {
          updatedMessages = [
            ...conv.messages.slice(0, msgIndex),
            ...conv.messages.slice(msgIndex + 2)
          ];
        } else {
          updatedMessages = [
            ...conv.messages.slice(0, msgIndex),
            ...conv.messages.slice(msgIndex + 1)
          ];
        }
      } else {
        // Delete only the assistant message
        updatedMessages = [
          ...conv.messages.slice(0, msgIndex),
          ...conv.messages.slice(msgIndex + 1)
        ];
      }

      const updatedConv: Conversation = {
        ...conv,
        messages: updatedMessages,
        updatedAt: Date.now()
      };

      const newConversations = {
        ...state.conversations,
        [projectId]: {
          ...state.conversations[projectId],
          [activeId]: updatedConv
        }
      };

      saveData(newConversations, state.activeConversationId);
      saveToDB(projectPath, updatedConv);

      return { conversations: newConversations };
    });
  },

  truncateFromMessage: (projectId, projectPath, messageId) => {
    set((state) => {
      const activeId = state.activeConversationId[projectId];
      if (!activeId) return state;

      const conv = state.conversations[projectId]?.[activeId];
      if (!conv) return state;

      const msgIndex = conv.messages.findIndex(m => m.id === messageId);
      if (msgIndex === -1) return state;

      // Remove this message and everything after it
      const updatedMessages = conv.messages.slice(0, msgIndex);

      const updatedConv: Conversation = {
        ...conv,
        messages: updatedMessages,
        updatedAt: Date.now()
      };

      const newConversations = {
        ...state.conversations,
        [projectId]: {
          ...state.conversations[projectId],
          [activeId]: updatedConv
        }
      };

      saveData(newConversations, state.activeConversationId);
      saveToDB(projectPath, updatedConv);

      return { conversations: newConversations };
    });
  },

  // Loading state
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),

  // Abort controller
  abortController: null,
  setAbortController: (controller) => set({ abortController: controller }),
  cancelRequest: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
      set({ abortController: null, isLoading: false });
    }
  }
}));
