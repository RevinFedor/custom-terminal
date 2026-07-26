export interface HistoryRewindPreviewOwner {
  tabId: string;
  sessionId?: string | null;
}

export interface HistoryRewindPreviewProof {
  sessionId?: string | null;
  writerGeneration?: string | null;
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
