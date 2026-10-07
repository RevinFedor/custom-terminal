import { create } from 'zustand';
const f = (window as any).settingsFixture;
export const useWorkspaceStore = create<any>((set, get) => ({
  spaces: [
    { id: 'a', kind: 'ordinary', name: 'Development', icon: f.icon, future: { preserved: true } },
    { id: 'b', kind: 'ordinary', name: 'Inbox', icon: null },
    { id: 'inbox', kind: 'inbox', name: 'Renamed system inbox', icon: null },
  ],
  addWorkspaceSpace: async (options: any) => {
    f.workflowCalls.push({ type: 'add', options });
    if (f.delayCreate) await new Promise<void>(resolve => { f.releaseCreate = resolve; });
    if (f.failCreate) return null;
    const id = 'new-' + f.workflowCalls.length;
    set({ spaces: [...get().spaces, { id, kind: 'ordinary', name: options.name, icon: null }] });
    return id;
  },
  removeWorkspaceSpace: (id: string) => {
    f.workflowCalls.push({ type: 'remove', id });
    if (get().spaces.find((space: any) => space.id === id)?.kind === 'inbox') throw new Error('System Inbox delete');
    set({ spaces: get().spaces.filter((space: any) => space.id !== id) });
  },
  renameWorkspaceSpace: (id: string, name: string) => {
    f.workflowCalls.push({ type: 'rename', id, name });
    set({ spaces: get().spaces.map((space: any) => space.id === id ? { ...space, name } : space) });
  },
  reorderWorkspaceSpaces: (ids: string[]) => {
    f.workflowCalls.push({ type: 'reorder', ids });
    set({ spaces: ids.map(id => get().spaces.find((space: any) => space.id === id)) });
    return true;
  },
  updateWorkspaceSpaceMetadata: async (id: string, metadata: any) => {
    f.workflowCalls.push({ type: 'metadata', id, metadata });
    if (f.failIcon) return false;
    set({ spaces: get().spaces.map((space: any) => space.id === id ? { ...space, ...metadata } : space) });
    return true;
  },
}));
f.setSpaces = (spaces: any[]) => useWorkspaceStore.setState({ spaces });
f.getSpaces = () => useWorkspaceStore.getState().spaces;
