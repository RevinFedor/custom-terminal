import type { PaneTabDragSource } from './paneTabDragBridge';

export type PaneTabPointerSnapshot = {
  active: boolean;
  revision: number;
  source: PaneTabDragSource | null;
  clientX: number;
  clientY: number;
  metaKey: boolean;
  pointerId: number;
};

const EMPTY: PaneTabPointerSnapshot = Object.freeze({
  active: false,
  revision: 0,
  source: null,
  clientX: 0,
  clientY: 0,
  metaKey: false,
  pointerId: 1,
});

let snapshot: PaneTabPointerSnapshot = EMPTY;
const moveListeners = new Set<() => void>();
const dropListeners = new Set<(finalSnapshot: PaneTabPointerSnapshot) => void>();

const notifyMove = () => moveListeners.forEach((listener) => listener());

export function updatePaneTabPointer(
  source: PaneTabDragSource,
  input: { clientX?: number; clientY?: number; metaKey?: boolean; pointerId?: number },
) {
  snapshot = {
    active: true,
    revision: snapshot.revision + 1,
    source,
    clientX: Number(input.clientX) || 0,
    clientY: Number(input.clientY) || 0,
    metaKey: input.metaKey === true,
    pointerId: Number.isFinite(Number(input.pointerId))
      ? Number(input.pointerId)
      : Number(source.pointerId) || snapshot.pointerId || 1,
  };
  notifyMove();
}

export function updatePaneTabPointerMeta(metaKey: boolean) {
  if (!snapshot.active || snapshot.metaKey === metaKey) return;
  snapshot = { ...snapshot, revision: snapshot.revision + 1, metaKey };
  notifyMove();
}

export function finishPaneTabPointer() {
  if (!snapshot.active) return;
  const finalSnapshot = snapshot;
  dropListeners.forEach((listener) => listener(finalSnapshot));
  snapshot = { ...EMPTY, revision: snapshot.revision + 1 };
  notifyMove();
}

export function cancelPaneTabPointer() {
  if (!snapshot.active) return;
  snapshot = { ...EMPTY, revision: snapshot.revision + 1 };
  notifyMove();
}

export const getPaneTabPointerSnapshot = () => snapshot;
export const subscribePaneTabPointer = (listener: () => void) => {
  moveListeners.add(listener);
  return () => moveListeners.delete(listener);
};
export const subscribePaneTabPointerDrop = (listener: (snapshot: PaneTabPointerSnapshot) => void) => {
  dropListeners.add(listener);
  return () => dropListeners.delete(listener);
};
