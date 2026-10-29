export interface HistoryPrimaryMetadataOrigin {
  readonly subject: Readonly<object>; readonly ordinal: number; readonly native: boolean;
}
/** Called once for a fresh actual server metadata array, before its freeze. */
export function registerHistoryPrimaryMetadataOrigin(entries: readonly object[]): Readonly<object>;
export function historyPrimaryMetadataSubject(entries: unknown): Readonly<object> | null;
export function historyPrimaryMetadataOrigin(row: unknown): HistoryPrimaryMetadataOrigin | null;
export function copyHistoryPrimaryMetadataOrigin<T extends object>(from: unknown, to: T): T;
