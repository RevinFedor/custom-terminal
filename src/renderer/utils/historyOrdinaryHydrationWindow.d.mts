export const HISTORY_ORDINARY_BUFFER: number;
export function ordinaryHistoryDeltaFillsViewport(units: any[], range: { start: number; end: number }, selections: Map<string, any> | null, changedEntries: any[]): boolean;
export function ordinaryHistoryHydrationDemand(entries: any[], units: any[], range: { start: number; end: number }, selections?: Map<string, any> | null): { centerUuid: string; radius: number; stubUuid: string } | null;
