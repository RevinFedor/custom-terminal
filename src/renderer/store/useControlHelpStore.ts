import { create } from 'zustand';

interface ControlHelpState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useControlHelpStore = create<ControlHelpState>((set) => ({
  enabled: true,
  setEnabled: (enabled) => set({ enabled }),
  toggle: () => set((state) => ({ enabled: !state.enabled })),
}));
