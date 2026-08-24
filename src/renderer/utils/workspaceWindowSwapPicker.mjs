import { useSyncExternalStore } from 'react';

const EMPTY = Object.freeze({
  active: false,
  revision: 0,
  sourceSpaceId: null,
  sourcePaneIndex: null,
  targetSpaceId: null,
});

let snapshot = EMPTY;
const listeners = new Set();

const publish = (next) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

export function beginWorkspaceWindowSwapPicker({
  sourceSpaceId,
  sourcePaneIndex = null,
}) {
  if (!sourceSpaceId) return false;
  publish({
    active: true,
    revision: snapshot.revision + 1,
    sourceSpaceId,
    sourcePaneIndex: sourcePaneIndex === null ? null : Number(sourcePaneIndex),
    targetSpaceId: sourceSpaceId,
  });
  return true;
}

export function selectWorkspaceWindowSwapTarget(spaceId) {
  if (!snapshot.active || !spaceId || snapshot.targetSpaceId === spaceId) return false;
  publish({ ...snapshot, revision: snapshot.revision + 1, targetSpaceId: spaceId });
  return true;
}

export function endWorkspaceWindowSwapPicker() {
  if (!snapshot.active) return false;
  publish({ ...EMPTY, revision: snapshot.revision + 1 });
  return true;
}

export const getWorkspaceWindowSwapPickerSnapshot = () => snapshot;
export const subscribeWorkspaceWindowSwapPicker = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useWorkspaceWindowSwapPickerSnapshot() {
  return useSyncExternalStore(
    subscribeWorkspaceWindowSwapPicker,
    getWorkspaceWindowSwapPickerSnapshot,
    getWorkspaceWindowSwapPickerSnapshot,
  );
}
