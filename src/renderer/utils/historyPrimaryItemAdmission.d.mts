import type { HistoryPrimaryRootReadModel, HistoryPrimaryRenderSnapshot } from './historyPrimaryRootReadModel.mjs';
export function createHistoryPrimaryItemAdmission(root: HistoryPrimaryRootReadModel | null,
  snapshot: HistoryPrimaryRenderSnapshot | null, matches: (index: number, unit: any) => boolean): {
  admit(index: number): boolean; key(index: number): string;
};
