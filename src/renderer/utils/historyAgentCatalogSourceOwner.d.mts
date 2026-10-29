import type { HistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';
export interface HistoryAgentCatalogSourceHint { readonly prepared: HistoryPrimaryPreparedOwner; close(): void; }
export type HistoryAgentCatalogSegment<T> = Readonly<{ start: number; end: number }> | Readonly<{ row: T }>;
export interface HistoryAgentCatalogSource<T> {
  readonly kind: 'held-chip-source' | 'unestablished-chip-source' | 'chip-source-error';
  readonly ownerKey: string;
  readonly generation: number;
  readonly sequence: number;
  readonly prepared: HistoryPrimaryPreparedOwner | null;
  readonly metadataSubject: Readonly<object> | null;
  readonly sourceHeader: HistoryPrimaryPreparedOwner['header'] | null;
  readonly sourceOriginHeader: HistoryPrimaryPreparedOwner['originHeader'] | null;
  readonly historicalCount: number | null;
  readonly segments: readonly HistoryAgentCatalogSegment<T>[] | null;
  readonly rows: readonly T[] | null;
  readonly localRows: readonly T[] | null;
  readonly entries: WeakRef<T[]>;
  readonly dataSubject: Readonly<object>;
  readonly error?: Error & { code?: string };
}
export interface HistoryAgentCatalogSourceOwner<T> {
  prepare(entries: T[], scope: { ownerKey: string; generation: number }, options?: {
    prepared?: HistoryPrimaryPreparedOwner | null; hint?: HistoryAgentCatalogSourceHint | null; enabled?: boolean;
  }): { readonly rows?: readonly T[] | null; commit(): HistoryAgentCatalogSource<T> | null; discard(): void };
  capture(entries: T[]): HistoryAgentCatalogSourceHint | null;
  current(): HistoryAgentCatalogSource<T> | null;
  matches(publication: HistoryAgentCatalogSource<T> | null, entries: T[], scope: { ownerKey: string; generation: number }): boolean;
  clear(): void;
  close(): void;
}
export function createHistoryAgentCatalogSourceOwner<T>(options: {
  isLocal(row: T): boolean; onReleaseError?(error: unknown): void;
}): HistoryAgentCatalogSourceOwner<T>;
