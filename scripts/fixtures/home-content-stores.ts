import { create } from 'zustand';

const fixture = (window as any).homeFixture;
export const useWorkspaceStore = create<any>((set) => ({
  spaces: [{ id: 'system-inbox', kind: 'inbox', name: 'Inbox' }],
  addWorkspaceSpace: async (options: unknown) => {
    fixture.creates.push(options);
    if (fixture.delayCreate) await new Promise<void>((resolve) => { fixture.releaseCreate = resolve; });
    if (fixture.failCreate) return null;
    const id = 'workflow-' + fixture.creates.length;
    set((state: any) => ({ spaces: [...state.spaces, { id, kind: 'ordinary', name: 'Workflow' }] }));
    return id;
  },
}));
export const useUIStore = create<any>((set) => ({
  storageBrowserExpanded: true,
  setStorageBrowserExpanded: (storageBrowserExpanded: boolean) => set({ storageBrowserExpanded }),
  showToast: (...args: unknown[]) => fixture.toasts.push(args),
}));
export const useControlHelpStore = create<any>(() => ({ enabled: false }));
fixture.setSpaces = (spaces: unknown[]) => useWorkspaceStore.setState({ spaces });
