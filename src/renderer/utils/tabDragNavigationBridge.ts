import { useSyncExternalStore } from 'react';

export type TabDragNavigationKind = 'workflow' | 'project';
export type TabDragNavigationSource = 'pane' | 'sidebar';

export type TabDragNavigationTarget = {
  kind: TabDragNavigationKind;
  id: string;
  clientX: number;
  clientY: number;
  blocked?: boolean;
};

type Snapshot = {
  revision: number;
  cycle: number;
  source: TabDragNavigationSource | null;
  target: TabDragNavigationTarget | null;
};

const EMPTY: Snapshot = Object.freeze({ revision: 0, cycle: 0, source: null, target: null });
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();

const publish = (next: Snapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

export function setTabDragNavigationTarget(
  source: TabDragNavigationSource,
  target: TabDragNavigationTarget,
) {
  if (!target?.id) return;
  const sameTarget = snapshot.source === source
    && snapshot.target?.kind === target.kind
    && snapshot.target?.id === target.id
    && snapshot.target?.blocked === !!target.blocked;
  const samePoint = sameTarget
    && Math.abs((snapshot.target?.clientX || 0) - target.clientX) < 0.5
    && Math.abs((snapshot.target?.clientY || 0) - target.clientY) < 0.5;
  if (samePoint) return;
  publish({
    revision: snapshot.revision + 1,
    cycle: sameTarget ? snapshot.cycle : snapshot.cycle + 1,
    source,
    target: { ...target, blocked: !!target.blocked },
  });
}

export function clearTabDragNavigationTarget(source?: TabDragNavigationSource) {
  if (!snapshot.target || (source && snapshot.source !== source)) return;
  publish({
    revision: snapshot.revision + 1,
    cycle: snapshot.cycle + 1,
    source: null,
    target: null,
  });
}

export const getTabDragNavigationSnapshot = () => snapshot;
export const subscribeTabDragNavigation = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useTabDragNavigationSnapshot() {
  return useSyncExternalStore(
    subscribeTabDragNavigation,
    getTabDragNavigationSnapshot,
    getTabDragNavigationSnapshot,
  );
}
