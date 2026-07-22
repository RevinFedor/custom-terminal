import { create } from 'zustand';

interface ControlHelpState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useControlHelpStore = create<ControlHelpState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
  toggle: () => set((state) => ({ enabled: !state.enabled })),
}));

