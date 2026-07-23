export type RewindOperationTool = 'claude' | 'gemini' | 'codex';
export type RewindOperationMode = 'native' | 'ai';

export type RewindOperationPhase =
  | 'preparing'
  | 'compacting'
  | 'rewinding'
  | 'pasting'
  | 'cancelling'
  | 'committing'
  | 'done';

export interface RewindOperation {
  tabId: string;
  opId: string;
  toolType: RewindOperationTool;
  mode: RewindOperationMode;
  sourceSessionId: string | null;
  activeSessionId?: string | null;
  targetUuid: string;
  targetText: string;
  targetIndex: number;
  phase: RewindOperationPhase;
  message?: string;
  runtimeRequestStarted: boolean;
  startedAt: number;
  updatedAt: number;
  cancelRequestedAt?: number;
}

export interface RewindOperationTable {
  operationsByKey: Readonly<Record<string, RewindOperation>>;
  activeOpIdByTab: Readonly<Record<string, string>>;
}

export interface StartRewindOperationInput {
  tabId: string;
  opId: string;
  toolType: RewindOperationTool;
  mode: RewindOperationMode;
  sourceSessionId?: string | null;
  targetUuid: string;
  targetText: string;
  targetIndex: number;
  phase?: RewindOperationPhase;
  message?: string;
  startedAt?: number;
}

export type RewindCancelReplyKind = 'accepted' | 'too-late' | 'rejected';

export function createEmptyRewindOperationTable(): RewindOperationTable {
  return {
    operationsByKey: {},
    activeOpIdByTab: {},
  };
}

export function makeRewindOperationKey(tabId: string, opId: string): string {
  return JSON.stringify([tabId, opId]);
}

export function selectRewindOperation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
): RewindOperation | null {
  if (!tabId || !opId) return null;
  return state.operationsByKey[makeRewindOperationKey(tabId, opId)] || null;
}

export function selectActiveRewindOperation(
  state: RewindOperationTable,
  tabId: string,
): RewindOperation | null {
  const opId = state.activeOpIdByTab[tabId];
  return opId ? selectRewindOperation(state, tabId, opId) : null;
}

export function isRewindOperationBlocking(operation: RewindOperation | null): boolean {
  return !!operation && operation.phase !== 'done';
}

export function isRewindOperationCancellable(operation: RewindOperation | null): boolean {
  return !!operation && (
    operation.phase === 'preparing'
    || operation.phase === 'compacting'
    || operation.phase === 'rewinding'
    || operation.phase === 'pasting'
  );
}

function replaceOperation(
  state: RewindOperationTable,
  operation: RewindOperation,
): RewindOperationTable {
  const key = makeRewindOperationKey(operation.tabId, operation.opId);
  return {
    operationsByKey: {
      ...state.operationsByKey,
      [key]: operation,
    },
    activeOpIdByTab: state.activeOpIdByTab,
  };
}

export function startRewindOperation(
  state: RewindOperationTable,
  input: StartRewindOperationInput,
): RewindOperationTable {
  if (!input.tabId || !input.opId || state.activeOpIdByTab[input.tabId]) return state;
  const now = Number.isFinite(input.startedAt) ? Number(input.startedAt) : Date.now();
  const operation: RewindOperation = {
    tabId: input.tabId,
    opId: input.opId,
    toolType: input.toolType,
    mode: input.mode,
    sourceSessionId: input.sourceSessionId || null,
    targetUuid: input.targetUuid,
    targetText: input.targetText,
    targetIndex: Number.isFinite(input.targetIndex) ? input.targetIndex : 0,
    phase: input.phase || 'preparing',
    message: input.message,
    runtimeRequestStarted: false,
    startedAt: now,
    updatedAt: now,
  };
  const key = makeRewindOperationKey(input.tabId, input.opId);
  return {
    operationsByKey: {
      ...state.operationsByKey,
      [key]: operation,
    },
    activeOpIdByTab: {
      ...state.activeOpIdByTab,
      [input.tabId]: input.opId,
    },
  };
}

export function updateRewindOperation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  patch: Partial<Pick<
    RewindOperation,
    'phase' | 'message' | 'activeSessionId' | 'runtimeRequestStarted' | 'cancelRequestedAt'
  >>,
  updatedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId) return state;
  return replaceOperation(state, {
    ...operation,
    ...patch,
    updatedAt,
  });
}

export function requestRewindCancellation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  requestedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!isRewindOperationCancellable(operation)) return state;
  return updateRewindOperation(state, tabId, opId, {
    phase: 'cancelling',
    message: 'Waiting for Rewind cancellation confirmation',
    cancelRequestedAt: requestedAt,
  }, requestedAt);
}

export function markRewindMutationStarted(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  toolType?: RewindOperationTool,
  updatedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId) return state;
  if (toolType && operation.toolType !== toolType) return state;
  if (operation.phase === 'done') return state;
  return updateRewindOperation(state, tabId, opId, {
    phase: 'committing',
    message: 'Rewind is applying; waiting for the durable result',
  }, updatedAt);
}

export function resolveRewindCancellation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  resolution: Exclude<RewindCancelReplyKind, 'rejected'>,
  updatedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId) return state;
  // A successful operation result or mutation-started event wins a race with
  // an older cancel reply. Only the still-pending cancellation may consume it.
  if (operation.phase !== 'cancelling') return state;
  if (resolution === 'accepted') {
    return clearRewindOperation(state, tabId, opId);
  }
  return updateRewindOperation(state, tabId, opId, {
    phase: 'committing',
    message: 'Cancellation was too late; Rewind is finishing',
  }, updatedAt);
}

export function markRewindCancellationRejected(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  message = 'Cancellation was not accepted; waiting for the Rewind result',
  updatedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId || operation.phase !== 'cancelling') {
    return state;
  }
  return updateRewindOperation(state, tabId, opId, {
    phase: 'committing',
    message,
  }, updatedAt);
}

export function completeRewindOperation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
  activeSessionId?: string | null,
  updatedAt = Date.now(),
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId) return state;
  return updateRewindOperation(state, tabId, opId, {
    phase: 'done',
    message: undefined,
    activeSessionId,
  }, updatedAt);
}

export function clearRewindOperation(
  state: RewindOperationTable,
  tabId: string,
  opId: string,
): RewindOperationTable {
  const operation = selectRewindOperation(state, tabId, opId);
  if (!operation || state.activeOpIdByTab[tabId] !== opId) return state;
  const key = makeRewindOperationKey(tabId, opId);
  const operationsByKey = { ...state.operationsByKey };
  const activeOpIdByTab = { ...state.activeOpIdByTab };
  delete operationsByKey[key];
  delete activeOpIdByTab[tabId];
  return { operationsByKey, activeOpIdByTab };
}

export function classifyRewindCancelReply(reply: unknown): RewindCancelReplyKind {
  if (!reply || typeof reply !== 'object') return 'rejected';
  const result = reply as Record<string, unknown>;
  if (result.tooLate === true || result.error === 'rewind_cancel_too_late') return 'too-late';
  if (result.accepted === true) return 'accepted';
  // Backward compatibility until every runtime returns the explicit contract.
  if (result.success === true && result.accepted !== false) return 'accepted';
  return 'rejected';
}
