import { useSyncExternalStore } from 'react';
import { createDiskCapacityStore } from './diskCapacityStore.mjs';

const store = createDiskCapacityStore({ ipc: window.require('electron').ipcRenderer });
export const useDiskCapacity = () => useSyncExternalStore(store.subscribe, store.getSnapshot);
