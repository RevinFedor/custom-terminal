import { create } from 'zustand';
import {
  classifyRewindCancelReply,
  clearRewindOperation,
  completeRewindOperation,
  createEmptyRewindOperationTable,
  markRewindCancellationRejected,
  markRewindMutationStarted,
  requestRewindCancellation,
  resolveRewindCancellation,
  startRewindOperation,
  updateRewindOperation,
  type RewindCancelReplyKind,
  type RewindOperationPhase,
  type RewindOperationTable,
  type RewindOperationTool,
  type StartRewindOperationInput,
} from './rewindOperationState';

interface RewindOperationStore extends RewindOperationTable {
  begin: (input: StartRewindOperationInput) => boolean;
  setPhase: (
    tabId: string,
    opId: string,
    phase: RewindOperationPhase,
    message?: string,
  ) => boolean;
  markRuntimeStarted: (tabId: string, opId: string) => boolean;
  requestCancel: (tabId: string, opId: string) => boolean;
  resolveCancel: (
    tabId: string,
    opId: string,
    resolution: Exclude<RewindCancelReplyKind, 'rejected'>,
  ) => boolean;
  rejectCancel: (tabId: string, opId: string, message?: string) => boolean;
  markMutationStarted: (
    tabId: string,
    opId: string,
    toolType?: RewindOperationTool,
  ) => boolean;
  complete: (
    tabId: string,
    opId: string,
    activeSessionId?: string | null,
  ) => boolean;
  clear: (tabId: string, opId: string) => boolean;
}

type RewindTransition = (state: RewindOperationTable) => RewindOperationTable;

export const useRewindOperationStore = create<RewindOperationStore>((set, get) => {
  const apply = (transition: RewindTransition): boolean => {
    const current = get();
    const snapshot: RewindOperationTable = {
      operationsByKey: current.operationsByKey,
      activeOpIdByTab: current.activeOpIdByTab,
    };
    const next = transition(snapshot);
    if (next === snapshot) return false;
    set({
      operationsByKey: next.operationsByKey,
      activeOpIdByTab: next.activeOpIdByTab,
    });
    return true;
  };

  return {
    ...createEmptyRewindOperationTable(),
    begin: (input) => apply((state) => startRewindOperation(state, input)),
    setPhase: (tabId, opId, phase, message) => apply((state) => (
      updateRewindOperation(state, tabId, opId, { phase, message })
    )),
    markRuntimeStarted: (tabId, opId) => apply((state) => (
      updateRewindOperation(state, tabId, opId, { runtimeRequestStarted: true })
    )),
    requestCancel: (tabId, opId) => apply((state) => (
      requestRewindCancellation(state, tabId, opId)
    )),
    resolveCancel: (tabId, opId, resolution) => apply((state) => (
      resolveRewindCancellation(state, tabId, opId, resolution)
    )),
    rejectCancel: (tabId, opId, message) => apply((state) => (
      markRewindCancellationRejected(state, tabId, opId, message)
    )),
    markMutationStarted: (tabId, opId, toolType) => apply((state) => (
      markRewindMutationStarted(state, tabId, opId, toolType)
    )),
    complete: (tabId, opId, activeSessionId) => apply((state) => (
      completeRewindOperation(state, tabId, opId, activeSessionId)
    )),
    clear: (tabId, opId) => apply((state) => (
      clearRewindOperation(state, tabId, opId)
    )),
  };
});

let rewindOperationIpcBridgeInstalled = false;

export function installRewindOperationIpcBridge(ipcRenderer: {
  on: (channel: string, listener: (event: unknown, payload?: any) => void) => unknown;
}): void {
  if (rewindOperationIpcBridgeInstalled) return;
  rewindOperationIpcBridgeInstalled = true;
  ipcRenderer.on('rewind:mutation-started', (_event, payload = {}) => {
    const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
    const opId = typeof payload.opId === 'string' ? payload.opId : '';
    const toolType = payload.toolType === 'claude' || payload.toolType === 'gemini' || payload.toolType === 'codex'
      ? payload.toolType
      : undefined;
    if (!tabId || !opId) return;
    const changed = useRewindOperationStore.getState().markMutationStarted(tabId, opId, toolType);
    if (changed) {
      console.warn(
        '[RewindOperation] mutation-started tab=' + tabId.slice(-12)
        + ' op=' + opId
        + ' tool=' + (toolType || 'unknown'),
      );
    }
  });
}

export { classifyRewindCancelReply };
