import { historyForegroundPriority } from './historyForegroundPriority.mjs';

const EMPTY = Object.freeze({
  active: false,
  revision: 0,
  sessionId: null,
  sourceProjectId: null,
  sourceId: null,
  sourceNode: null,
  rootTabId: null,
  tabIds: [],
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  metaKey: false,
});

let snapshot = EMPTY;
let sessionSnapshot = EMPTY;
let cleanupInputListeners = null;
let scheduledEndSession = null;
const listeners = new Set();
const sessionListeners = new Set();

const publish = (next) => {
  const sessionChanged = next.active !== snapshot.active
    || next.sessionId !== snapshot.sessionId
    || next.sourceNode !== snapshot.sourceNode
    || next.pointerId !== snapshot.pointerId
    || next.metaKey !== snapshot.metaKey;
  snapshot = next;
  if (sessionChanged) {
    sessionSnapshot = next;
    sessionListeners.forEach((listener) => listener());
  }
  listeners.forEach((listener) => listener());
};

const interactionOwner = (sessionId) => `sidebar-outline-drag:${sessionId}`;

const detachInputListeners = () => {
  cleanupInputListeners?.();
  cleanupInputListeners = null;
};

const schedulePhysicalRelease = (sessionId) => {
  if (!sessionId || scheduledEndSession === sessionId) return;
  scheduledEndSession = sessionId;
  queueMicrotask(() => {
    if (scheduledEndSession !== sessionId) return;
    scheduledEndSession = null;
    endSidebarTabDrag(sessionId);
  });
};

const attachInputListeners = () => {
  if (cleanupInputListeners) return;
  const target = globalThis.window;
  if (!target?.addEventListener) return;
  const onPointerMove = (event) => {
    if (!snapshot.active) return;
    updateSidebarTabDragPointer({
      sessionId: snapshot.sessionId,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      metaKey: event.metaKey,
    });
  };
  const onMeta = (event) => {
    if (!snapshot.active) return;
    const isMeta = event.key === 'Meta'
      || event.code === 'MetaLeft'
      || event.code === 'MetaRight';
    if (!isMeta) return;
    updateSidebarTabDragPointer({
      sessionId: snapshot.sessionId,
      metaKey: event.type !== 'keyup',
    });
  };
  const onRelease = () => schedulePhysicalRelease(snapshot.sessionId);
  target.addEventListener('pointermove', onPointerMove, true);
  target.addEventListener('keydown', onMeta, true);
  target.addEventListener('keyup', onMeta, true);
  target.addEventListener('pointerup', onRelease, true);
  target.addEventListener('pointercancel', onRelease, true);
  target.addEventListener('mouseup', onRelease, true);
  target.addEventListener('dragend', onRelease, true);
  target.addEventListener('blur', onRelease, true);
  cleanupInputListeners = () => {
    target.removeEventListener('pointermove', onPointerMove, true);
    target.removeEventListener('keydown', onMeta, true);
    target.removeEventListener('keyup', onMeta, true);
    target.removeEventListener('pointerup', onRelease, true);
    target.removeEventListener('pointercancel', onRelease, true);
    target.removeEventListener('mouseup', onRelease, true);
    target.removeEventListener('dragend', onRelease, true);
    target.removeEventListener('blur', onRelease, true);
  };
};

export function beginSidebarTabDrag(input) {
  const sessionId = String(input?.sessionId || '');
  const sourceProjectId = String(input?.sourceProjectId || '');
  const sourceId = String(input?.sourceId || '');
  const rootTabId = String(input?.rootTabId || '');
  const sourceNode = input?.sourceNode || null;
  const tabIds = Array.from(new Set((input?.tabIds || []).map(String).filter(Boolean)));
  if (!sessionId || !sourceProjectId || !sourceId || !rootTabId || !sourceNode || tabIds.length === 0) return false;

  if (snapshot.active
    && snapshot.sessionId === sessionId
    && snapshot.sourceProjectId === sourceProjectId
    && snapshot.sourceId === sourceId
    && snapshot.rootTabId === rootTabId) {
    updateSidebarTabDragPointer({
      sessionId,
      pointerId: input?.pointerId,
      clientX: input?.clientX,
      clientY: input?.clientY,
      metaKey: input?.metaKey,
    });
    return true;
  }

  if (snapshot.active && snapshot.sessionId !== sessionId) {
    historyForegroundPriority.endInteraction(interactionOwner(snapshot.sessionId));
    detachInputListeners();
  }
  scheduledEndSession = null;
  const next = {
    active: true,
    revision: snapshot.revision + 1,
    sessionId,
    sourceProjectId,
    sourceId,
    sourceNode,
    rootTabId,
    tabIds,
    pointerId: Number.isFinite(Number(input?.pointerId)) ? Number(input.pointerId) : 1,
    clientX: Number(input?.clientX) || 0,
    clientY: Number(input?.clientY) || 0,
    metaKey: input?.metaKey === true,
  };
  publish(next);
  historyForegroundPriority.beginInteraction(interactionOwner(sessionId));
  attachInputListeners();
  return true;
}

export function updateSidebarTabDragPointer(input) {
  if (!snapshot.active || (input?.sessionId && input.sessionId !== snapshot.sessionId)) return false;
  const pointerId = Number.isFinite(Number(input?.pointerId)) ? Number(input.pointerId) : snapshot.pointerId;
  const clientX = Number.isFinite(Number(input?.clientX)) ? Number(input.clientX) : snapshot.clientX;
  const clientY = Number.isFinite(Number(input?.clientY)) ? Number(input.clientY) : snapshot.clientY;
  const metaKey = typeof input?.metaKey === 'boolean' ? input.metaKey : snapshot.metaKey;
  if (pointerId === snapshot.pointerId
    && Math.abs(clientX - snapshot.clientX) < 0.5
    && Math.abs(clientY - snapshot.clientY) < 0.5
    && metaKey === snapshot.metaKey) return false;
  publish({
    ...snapshot,
    revision: snapshot.revision + 1,
    pointerId,
    clientX,
    clientY,
    metaKey,
  });
  return true;
}

export function endSidebarTabDrag(sessionId) {
  if (!snapshot.active || (sessionId && snapshot.sessionId !== sessionId)) return false;
  const completedSession = snapshot.sessionId;
  scheduledEndSession = null;
  detachInputListeners();
  historyForegroundPriority.endInteraction(interactionOwner(completedSession));
  publish({ ...EMPTY, revision: snapshot.revision + 1 });
  return true;
}

export const getSidebarTabDragSnapshot = () => snapshot;
// All retained/menu-only TabBars need ownership and Cmd changes, not every
// pointer packet. The pointer remains current for destination adoption.
export const getSidebarTabDragSessionSnapshot = () => sessionSnapshot;
export const subscribeSidebarTabDragSession = (listener) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};
export const getSidebarTabDragProjectionKey = (value = snapshot) => {
  if (!value?.active) return '';
  // Pointer coordinates and modifier state intentionally do not participate.
  // The destination outline is a semantic baseline for the whole adopted
  // gesture; rebuilding it on every packet resets its live Y/X preview.
  return JSON.stringify([
    value.sessionId,
    value.sourceProjectId,
    value.sourceId,
    value.rootTabId,
    value.tabIds,
  ]);
};
export const getSidebarTabDragCursorChip = (value = snapshot) => {
  if (!value?.active || !value.sourceNode) return null;
  return {
    sessionId: value.sessionId,
    rootTabId: value.rootTabId,
    label: String(value.sourceNode.label || value.sourceNode.rawTab?.name || 'Вкладка'),
    count: Math.max(1, value.tabIds?.length || 0),
    clientX: Number(value.clientX) || 0,
    clientY: Number(value.clientY) || 0,
  };
};
// Cmd changes hierarchy, not the representation of a drag. The outline owns
// local Y/X preview; only a matching external receiver needs a cursor payload.
export const sidebarTabDragUsesCursorChip = (value, pane, navigation, hostExternalTarget) => {
  if (!value?.active) return false;
  if (typeof hostExternalTarget === 'boolean') return hostExternalTarget;
  const source = pane?.source;
  const sameSource = pane?.active && source?.owner === 'sidebar'
    && source.rootTabId === value.rootTabId
    && (!source.gestureId || source.gestureId === value.sessionId);
  return !!(sameSource && (pane.target || (navigation?.source === 'sidebar' && navigation.target)));
};
export const subscribeSidebarTabDrag = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function resetSidebarTabDragForTests() {
  if (snapshot.active) historyForegroundPriority.endInteraction(interactionOwner(snapshot.sessionId));
  scheduledEndSession = null;
  detachInputListeners();
  snapshot = EMPTY;
  sessionSnapshot = EMPTY;
  listeners.clear();
  sessionListeners.clear();
}
