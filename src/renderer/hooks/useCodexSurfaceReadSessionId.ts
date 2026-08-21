import { useCallback, useSyncExternalStore } from 'react';
import {
  getCodexSurfaceReadSessionId,
  subscribeCodexSurfaceReadIdentity,
} from '../utils/codexSurfaceReadIdentityStore.mjs';

export function useCodexSurfaceReadSessionId(tabId: string | null | undefined): string | null {
  const key = String(tabId || '');
  const subscribe = useCallback(
    (listener: () => void) => subscribeCodexSurfaceReadIdentity(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => getCodexSurfaceReadSessionId(key),
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
