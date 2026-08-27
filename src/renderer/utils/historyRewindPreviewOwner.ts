export interface HistoryRewindPreviewOwner {
  tabId: string;
  sessionId?: string | null;
}

export interface HistoryRewindPreviewProof {
  targetUuid?: string | null;
  startedAt?: number | null;
  sessionId?: string | null;
  writerGeneration?: string | null;
}

export interface DurableHistoryUserCandidate {
  uuid?: string | null;
  type?: string | null;
  role?: string | null;
  timestamp?: string | null;
  sessionId?: string | null;
}

export interface CodexWriterTransitionEvent {
  tabId?: string | null;
  engine?: string | null;
  sessionId?: string | null;
  previousSessionId?: string | null;
  writerProven?: boolean;
  writerProof?: string | null;
  writerGeneration?: string | null;
}

/**
 * Projects a native Rewind preview without presenting the restored target as
 * both a sent History row and the current composer draft. Rows that appeared
 * after the operation started (for example local status rows) may be retained
 * by the caller, but the target itself is always removed from History because
 * ownership of that text has moved back to the composer.
 */
export function projectNativeRewindPreview<T extends { uuid?: string | null }>(
  entries: T[],
  targetUuid: string,
  shouldRetainAfterTarget: (entry: T) => boolean,
  isUserTurn: (entry: T) => boolean = () => false,
): { entries: T[]; hiddenCount: number; hiddenTurnCount: number } {
  const source = Array.isArray(entries) ? entries : [];
  const targetIndex = source.findIndex((entry) => entry?.uuid === targetUuid);
  if (targetIndex < 0) return { entries: source, hiddenCount: 0, hiddenTurnCount: 0 };

  const visible = source.slice(0, targetIndex);
  // The target row is hidden from History because it is now the draft.
  let hiddenCount = 1;
  let hiddenTurnCount = isUserTurn(source[targetIndex]) ? 1 : 0;
  for (let index = targetIndex + 1; index < source.length; index++) {
    const entry = source[index];
    if (shouldRetainAfterTarget(entry)) visible.push(entry);
    else {
      hiddenCount++;
      if (isUserTurn(entry)) hiddenTurnCount++;
    }
  }
  return { entries: visible, hiddenCount, hiddenTurnCount };
}

const normalizeOwnerValue = (value: string | null | undefined) => String(value || '');

/**
 * A preview belongs to a tab, not to whichever tab a shared History component
 * happens to present right now. Switching A → B must therefore preserve both
 * previews. Only a writer/session replacement inside the same tab invalidates
 * that tab's preview.
 */
export function shouldClearRewindPreviewForOwnerTransition(
  previous: HistoryRewindPreviewOwner,
  current: HistoryRewindPreviewOwner,
): boolean {
  const previousTabId = normalizeOwnerValue(previous.tabId);
  const currentTabId = normalizeOwnerValue(current.tabId);
  if (!previousTabId || previousTabId !== currentTabId) return false;
  return normalizeOwnerValue(previous.sessionId) !== normalizeOwnerValue(current.sessionId);
}

/**
 * A preview is only the temporary presentation between restoring a native
 * Rewind draft and materializing the next exact provider user row. Once that
 * durable row exists, keeping the preview hides real History rows and leaves
 * Timeline pointing at UUIDs which the visible History projection removed.
 *
 * The caller supplies records only from an exact durable source: either the
 * canonical live transcript stream or a completed server-history projection.
 * Text is deliberately irrelevant because the restored draft is editable.
 */
export function shouldClearRewindPreviewForDurableUser(
  preview: HistoryRewindPreviewProof | null | undefined,
  candidate: DurableHistoryUserCandidate | null | undefined,
): boolean {
  const targetUuid = normalizeOwnerValue(preview?.targetUuid);
  const candidateUuid = normalizeOwnerValue(candidate?.uuid);
  const previewSessionId = normalizeOwnerValue(preview?.sessionId);
  const candidateSessionId = normalizeOwnerValue(candidate?.sessionId);
  const startedAt = Number(preview?.startedAt);
  const candidateAt = Date.parse(String(candidate?.timestamp || ''));
  const isUser = candidate?.type === 'user' || candidate?.role === 'user';
  if (!targetUuid || !candidateUuid || !isUser) return false;
  if (candidateUuid === targetUuid) return false;
  if (previewSessionId && candidateSessionId && previewSessionId !== candidateSessionId) {
    return false;
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(candidateAt)) return false;
  return candidateAt >= startedAt;
}

/**
 * A stable-source Codex Rewind can materialize its replacement rollout only
 * after the next Enter. Authorize the source-history prefix handoff solely
 * from main's exact delayed-writer proof for the same retained Rewind
 * generation. A generic session change must never borrow another owner's rows.
 */
export function shouldCaptureDelayedCodexRewindPrefix({
  tabId,
  currentSessionId,
  preview,
  event,
}: {
  tabId: string;
  currentSessionId?: string | null;
  preview?: HistoryRewindPreviewProof | null;
  event?: CodexWriterTransitionEvent | null;
}): boolean {
  const expectedTabId = normalizeOwnerValue(tabId);
  const eventTabId = normalizeOwnerValue(event?.tabId);
  const sourceSessionId = normalizeOwnerValue(event?.previousSessionId);
  const childSessionId = normalizeOwnerValue(event?.sessionId);
  const previewSessionId = normalizeOwnerValue(preview?.sessionId);
  const previewGeneration = normalizeOwnerValue(preview?.writerGeneration);
  const eventGeneration = normalizeOwnerValue(event?.writerGeneration);
  const visibleSessionId = normalizeOwnerValue(currentSessionId);

  if (!expectedTabId || eventTabId !== expectedTabId) return false;
  if (event?.engine && event.engine !== 'codex') return false;
  if (event?.writerProven !== true) return false;
  if (event?.writerProof !== 'native-rewind-delayed-child') return false;
  if (!sourceSessionId || !childSessionId || sourceSessionId === childSessionId) return false;
  if (!previewSessionId || previewSessionId !== sourceSessionId) return false;
  if (!previewGeneration || previewGeneration !== eventGeneration) return false;
  return !visibleSessionId
    || visibleSessionId === sourceSessionId
    || visibleSessionId === childSessionId;
}
