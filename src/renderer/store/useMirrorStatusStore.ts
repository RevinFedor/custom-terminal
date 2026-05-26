import { create } from 'zustand';

// Per-project mirror status — kept separately from useUIStore so the Map
// updates don't churn the whole UI store. Populated by App.tsx subscribing
// to 'mirror:status' IPC pushes from main.

export interface MirrorFileInfo {
  path: string;
  name: string;
  exists: boolean;
  sizeBytes: number;
  mtime: number | null;
  inSync: boolean;
  lastWriteAt: number | null;
}

export interface MirrorStatus {
  enabled: boolean;
  source: {
    path: string;
    name: string;
    exists: boolean;
    sizeBytes: number;
    mtime: number | null;
  };
  mirrors: MirrorFileInfo[];
}

interface MirrorStatusStore {
  byProject: Record<string, MirrorStatus>;
  setStatus: (projectId: string, status: MirrorStatus) => void;
  clearStatus: (projectId: string) => void;
}

export const useMirrorStatusStore = create<MirrorStatusStore>((set) => ({
  byProject: {},
  setStatus: (projectId, status) =>
    set((state) => ({ byProject: { ...state.byProject, [projectId]: status } })),
  clearStatus: (projectId) =>
    set((state) => {
      const next = { ...state.byProject };
      delete next[projectId];
      return { byProject: next };
    }),
}));
