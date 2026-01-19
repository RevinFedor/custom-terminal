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

interface UIStore {
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

export const useUIStore = create<UIStore>((set, get) => ({
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
