import { useCallback, useEffect, useRef, useState } from 'react';
const { ipcRenderer } = window.require('electron');

export interface SelfRewindOperation {
  tabId: string; operationId: string; kind: 'rewind'; toolType: 'claude' | 'codex';
  expectedSessionId: string; targetUuid: string; state: string; phase: string;
  revision: number; createdAt: number; updatedAt: number; error?: string | null;
  historyMutated: boolean; bindingCommitted: boolean; newSessionId?: string;
  activeSessionId?: string | null; hasNextPrompt: boolean; contextUpdateId?: string;
  presentationHiddenAt?: number; resume?: { status?: string };
  followup?: { operationKey: string; handoffId: string; receiptState: string;
    updatedAt?: number; attemptId?: string; error?: string | null; cancelledAt?: string | number | null };
}
export function mergeSelfRewinds(previous: SelfRewindOperation[], incoming: SelfRewindOperation[]) {
  const rows = new Map(previous.map(row => [row.operationId, row]));
  for (const row of incoming) {
    const old = rows.get(row.operationId);
    const base = old && old.revision > row.revision ? old : row;
    const sameFollowup = old?.followup?.operationKey && old.followup.operationKey === row.followup?.operationKey;
    const followup = sameFollowup && ((old.followup?.updatedAt || 0) > (row.followup?.updatedAt || 0)
      || old.followup?.receiptState === 'confirmed' && row.followup?.receiptState !== 'confirmed') ? old.followup : base.followup;
    rows.set(row.operationId, { ...base, ...(followup ? { followup } : {}),
      presentationHiddenAt: Math.max(old?.presentationHiddenAt || 0, row.presentationHiddenAt || 0) || undefined });
  }
  return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
}
export function useSelfRewinds(tabId: string) {
  const [rows, setRows] = useState<SelfRewindOperation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const subscription = useRef<object | null>(null);
  useEffect(() => {
    const scope = {}; subscription.current = scope;
    let active = true;
    setRows([]); setError(null);
    const changed = (_event: unknown, row: SelfRewindOperation) => {
      if (active && row?.tabId === tabId) setRows(current => mergeSelfRewinds(current, [row]));
    };
    ipcRenderer.on('self-rewind:changed', changed);
    void ipcRenderer.invoke('self-rewind:list', tabId).then((result: SelfRewindOperation[]) => {
      if (active && Array.isArray(result)) setRows(current => mergeSelfRewinds(result, current));
    }).catch((reason: Error) => {
      if (active && !String(reason).includes('No handler registered')) setError(reason.message);
    });
    return () => {
      active = false;
      if (subscription.current === scope) subscription.current = null;
      ipcRenderer.removeListener('self-rewind:changed', changed);
    };
  }, [tabId]);
  const dismiss = useCallback(async (operation: SelfRewindOperation) => {
    const scope = subscription.current;
    try {
      const result = await ipcRenderer.invoke('self-rewind:dismiss', { tabId, operationId: operation.operationId });
      if (!scope || subscription.current !== scope) return;
      setRows(current => mergeSelfRewinds(current, [result])); setError(null);
    } catch (reason) {
      if (scope && subscription.current === scope) setError(String((reason as Error)?.message || reason));
    }
  }, [tabId]);
  return { rows, error, dismiss };
}
