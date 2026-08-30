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
let cleanupInputListeners = null;
let scheduledEndSession = null;
const listeners = new Set();

const publish = (next) => {
  snapshot = next;
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
export const subscribeSidebarTabDrag = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function resetSidebarTabDragForTests() {
  if (snapshot.active) historyForegroundPriority.endInteraction(interactionOwner(snapshot.sessionId));
  scheduledEndSession = null;
  detachInputListeners();
  snapshot = EMPTY;
  listeners.clear();
}
