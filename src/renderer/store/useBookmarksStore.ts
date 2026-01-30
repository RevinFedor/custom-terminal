import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

export interface Bookmark {
  id: number;
  path: string;
  name: string;
  description: string;
  position: number;
  created_at: number;
}

interface BookmarksStore {
  bookmarks: Bookmark[];
  isLoading: boolean;

  loadBookmarks: () => Promise<void>;
  addBookmark: (path: string, name: string, description?: string) => Promise<Bookmark>;
  addBookmarkFromDialog: () => Promise<Bookmark | null>;
  updateBookmark: (id: number, updates: Partial<Pick<Bookmark, 'name' | 'description' | 'position'>>) => Promise<void>;
  deleteBookmark: (id: number) => Promise<void>;
}

export const useBookmarksStore = create<BookmarksStore>((set, get) => ({
  bookmarks: [],
  isLoading: false,

  loadBookmarks: async () => {
    set({ isLoading: true });
    try {
      const bookmarks = await ipcRenderer.invoke('bookmark:list');
      set({ bookmarks, isLoading: false });
    } catch (err) {
      console.error('[BookmarksStore] Failed to load bookmarks:', err);
      set({ isLoading: false });
    }
  },

  addBookmark: async (path, name, description = '') => {
    const bookmark = await ipcRenderer.invoke('bookmark:create', { path, name, description });
    const { bookmarks } = get();
    set({ bookmarks: [...bookmarks, bookmark] });
    return bookmark;
  },

  addBookmarkFromDialog: async () => {
    const bookmark = await ipcRenderer.invoke('bookmark:select-directory');
    if (bookmark) {
      const { bookmarks } = get();
      // Check if already in list
      const exists = bookmarks.some(b => b.id === bookmark.id);
      if (!exists) {
        set({ bookmarks: [...bookmarks, bookmark] });
      }
      return bookmark;
    }
    return null;
  },

  updateBookmark: async (id, updates) => {
    await ipcRenderer.invoke('bookmark:update', { id, updates });
    const { bookmarks } = get();
    set({
      bookmarks: bookmarks.map(b =>
        b.id === id ? { ...b, ...updates } : b
      )
    });
  },

  deleteBookmark: async (id) => {
    await ipcRenderer.invoke('bookmark:delete', id);
    const { bookmarks } = get();
    set({ bookmarks: bookmarks.filter(b => b.id !== id) });
  }
}));
