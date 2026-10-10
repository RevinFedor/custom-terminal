import { create } from 'zustand';
import contract from '../../shared/idle-session-stop.cjs';

const { ipcRenderer } = window.require('electron');
export type IdleStopPolicy = ReturnType<typeof contract.normalizeIdleSessionStopPolicy>;
type IdleStopState = { phase: string; deadline: number | null; idleSince: number | null; error?: string };
type Snapshot = { revision: number; sequence: number; policy: IdleStopPolicy; states: Record<string, IdleStopState> };
type Store = Snapshot & { hydrated: boolean; error: string | null };
export const useIdleSessionStopStore = create<Store>(() => ({ revision: -1, sequence: -1,
  policy: contract.normalizeIdleSessionStopPolicy(), states: {}, hydrated: false, error: null }));
let hydration: Promise<void> | null = null, subscribed = false;
function accept(value: Snapshot) {
  if (!value || !Number.isInteger(value.revision) || !value.policy || !value.states) return;
  useIdleSessionStopStore.setState(previous => {
    if (value.sequence < previous.sequence) return previous;
    const states = Object.fromEntries(Object.entries(value.states).map(([id, state]) => [id,
      JSON.stringify(previous.states[id]) === JSON.stringify(state) ? previous.states[id] : state]));
    return { ...value, states, hydrated: true, error: null };
  });
}
export function hydrateIdleSessionStopStore() {
  if (!subscribed) {
    subscribed = true;
    ipcRenderer.on('idle-session-stop:changed', (_event: unknown, value: Snapshot) => accept(value));
  }
  if (useIdleSessionStopStore.getState().hydrated) return Promise.resolve();
  if (!hydration) hydration = ipcRenderer.invoke('idle-session-stop:get').then(accept).catch((error: Error) => {
    hydration = null; useIdleSessionStopStore.setState({ error: error.message });
  });
  return hydration;
}
export async function updateIdleSessionStopPolicy(patch: Partial<IdleStopPolicy>) {
  try { accept(await ipcRenderer.invoke('idle-session-stop:update', patch)); }
  catch (error) { useIdleSessionStopStore.setState({ error: String(error) }); }
}
