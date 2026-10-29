export type HistoryPrimaryRequestClass = 'view' | 'semantic' | 'source';
export function normalizeHistoryPrimaryRequestClass(value: unknown): HistoryPrimaryRequestClass;
export function mergeHistoryPrimaryRequestClass(pending: HistoryPrimaryRequestClass | null, requested: unknown): HistoryPrimaryRequestClass;
export function historyPrimaryViewInputsReusable(applied: any, current: any, suppressions: ReadonlyMap<any, any>): boolean;
export function historyPrimaryCompositionRequestClass(applied: any, current: any, suppressions: ReadonlyMap<any, any>, header: any, appliedSuppressionCount: number | null): 'view' | 'semantic';
export function historyPrimaryRequestPayload(address: { toolType: string; sessionId: string; cwd?: string; tabId: string }, requestClass: HistoryPrimaryRequestClass, presentation: any, suppressions: ReadonlyMap<any, any>, header: any): any;
