import { create } from 'zustand';
import { normalizeAutoCompactPolicy } from '../utils/autoCompactPolicy.mjs';

const { ipcRenderer } = window.require('electron');
const STATE_KEY = 'globalAutoCompact';
export type AutoCompactPolicy = ReturnType<typeof normalizeAutoCompactPolicy>;
export type AutoCompactActivity = {
  phase: 'waiting' | 'checking' | 'resuming' | 'compacting' | 'error';
  message: string;
  handoffId?: string;
};
type State = {
  policy: AutoCompactPolicy;
  hydrated: boolean;
  activities: Record<string, AutoCompactActivity>;
  updatePolicy: (patch: Partial<AutoCompactPolicy>) => void;
  setExcluded: (tabId: string, excluded: boolean) => void;
  setActivity: (tabId: string, activity: AutoCompactActivity | null) => void;
};

let hydratePromise: Promise<void> | null = null;
let saveTail = Promise.resolve();
let saveGeneration = 0;
function persist(policy: AutoCompactPolicy) {
  // Settings are tiny and infrequent. Preserve write order; never allow a late
  // earlier save to overwrite a newer exclusion or the global off switch.
  const serialized = JSON.stringify(policy);
  const generation = saveGeneration;
  saveTail = saveTail.catch(() => {}).then(async () => {
    if (generation !== saveGeneration) return;
    await ipcRenderer.invoke('app:setState', { key: STATE_KEY, value: serialized });
  });
  void saveTail.catch((error) => console.error('[AutoCompact] settings save failed', error));
}

export function flushAutoCompactStoreSync(): void {
  const state = useAutoCompactStore.getState();
  if (!state.hydrated) return;
  saveGeneration += 1;
  ipcRenderer.sendSync('app:setStateSync', { key: STATE_KEY, value: JSON.stringify(state.policy) });
}

export function takeAutoCompactPersistence(): string {
  const state = useAutoCompactStore.getState();
  if (!state.hydrated) throw new Error('run_after_policy_unavailable');
  // Supersede an older not-yet-dispatched save. Already sent IPC writes keep
  // their order before the strict remote transaction on the same Main owner.
  saveGeneration += 1;
  return JSON.stringify(state.policy);
}

export const useAutoCompactStore = create<State>((set, get) => ({
  policy: normalizeAutoCompactPolicy(),
  hydrated: false,
  activities: {},
  updatePolicy: (patch) => {
    if (!get().hydrated) return;
    const policy = normalizeAutoCompactPolicy({ ...get().policy, ...patch, migrationEligibility: {}, armedAt: Date.now() });
    set({ policy });
    persist(policy);
  },
  setExcluded: (tabId, excluded) => {
    if (!get().hydrated) return;
    const ids = new Set<string>(get().policy.excludedTabIds);
    if (excluded) ids.add(tabId); else ids.delete(tabId);
    const migrationEligibility = {...get().policy.migrationEligibility};
    delete migrationEligibility[tabId];
    const policy = normalizeAutoCompactPolicy({ ...get().policy, migrationEligibility, excludedTabIds: [...ids] });
    set({ policy });
    persist(policy);
  },
  setActivity: (tabId, activity) => set((state) => {
    const previous = state.activities[tabId];
    if (!activity && !previous || activity && previous?.phase === activity.phase && previous.message === activity.message
      && previous.handoffId === activity.handoffId) return state;
    const activities = { ...state.activities };
    if (activity) activities[tabId] = activity; else delete activities[tabId];
    return { activities };
  }),
}));

export function hydrateAutoCompactStore(): Promise<void> {
  if (useAutoCompactStore.getState().hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw = await ipcRenderer.invoke('app:getState', STATE_KEY);
      const policy = normalizeAutoCompactPolicy(typeof raw === 'string' ? JSON.parse(raw) : raw || {});
      useAutoCompactStore.setState({ policy, hydrated: true });
    } catch (error) {
      console.error('[AutoCompact] settings load failed', error);
      // Do not save a default over data that could not be read.
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}
