import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string; // First user message preview
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface ResearchStore {
  // Panel state
  isOpen: boolean;
  openResearch: () => void;
  closeResearch: () => void;
  toggleResearch: () => void;

  // Conversations per project: projectId -> conversationId -> Conversation
  conversations: Record<string, Record<string, Conversation>>;

  // Active conversation per project
  activeConversationId: Record<string, string | null>;

  // Create new conversation and return its id
  createConversation: (projectId: string, firstUserMessage: string) => string;

  // Add message to active conversation
  addMessage: (projectId: string, role: 'user' | 'assistant', content: string) => void;

  // Get all conversations for project
  getProjectConversations: (projectId: string) => Conversation[];

  // Get active conversation
  getActiveConversation: (projectId: string) => Conversation | null;

  // Set active conversation
  setActiveConversation: (projectId: string, conversationId: string | null) => void;

  // Delete conversation
  deleteConversation: (projectId: string, conversationId: string) => void;

  // Loading state
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
}

// Load from localStorage
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

const initialData = loadData();

export const useResearchStore = create<ResearchStore>((set, get) => ({
  // Panel state
  isOpen: false,
  openResearch: () => set({ isOpen: true }),
  closeResearch: () => set({ isOpen: false }),
  toggleResearch: () => set((state) => ({ isOpen: !state.isOpen })),

  // Data
  conversations: initialData.conversations || {},
  activeConversationId: initialData.activeConversationId || {},

  createConversation: (projectId, firstUserMessage) => {
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
      return {
        conversations: newConversations,
        activeConversationId: newActiveIds
      };
    });

    return convId;
  },

  addMessage: (projectId, role, content) => {
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

  deleteConversation: (projectId, conversationId) => {
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
      return {
        conversations: newConversations,
        activeConversationId: newActiveIds
      };
    });
  },

  // Loading state
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading })
}));
