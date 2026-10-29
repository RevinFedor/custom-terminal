import type { HistoryPositionEntry, HistoryPositionInvoke, HistoryPositionOpen,
  HistoryPositionReadOptions, HistoryPositionRetirement, HistoryPositionSelectedSource } from './historyPresentationPosition.mjs';
import type { HistoryPrimarySparsePublication } from './historyPrimaryPromptAdoption.mjs';

/** A model-created validated prepared child, retained independently by the
 * actual shown presentation owner. Compatibility matching is exact WeakRef
 * identity; no count/key approximation can authorize a different array. */
export interface HistoryPreparedPositionMetadataOwner<Entry extends HistoryPositionEntry> {
  readonly closed: boolean;
  retain(options?: HistoryPositionReadOptions): HistoryPreparedPositionMetadataOwner<Entry> | Promise<HistoryPreparedPositionMetadataOwner<Entry>>;
  ownsCompatibilityMetadata(entries: readonly unknown[]): boolean;
  readMetadataOrdinal(ordinal: number, options?: HistoryPositionReadOptions): Promise<Entry>;
  close(): unknown | Promise<unknown>;
  retirement?(): HistoryPositionRetirement | Promise<unknown>;
}
export interface HistoryPreparedPositionSource<Entry extends HistoryPositionEntry> extends HistoryPositionSelectedSource<Entry> {
  /** Drops only transient compatibility registration borrows, never another child. */
  discard(): void;
  stats(): { compatibilityUnitVisits: number; compatibilityMemberVisits: number;
    metadataIdentityComparisons: number; fallbackScans: number; enrichedSelections: number;
    nativeHistoricalEntries: 0; compatibilityBorrowed: number; sparseNativeRows: number };
}
export function createHistoryPreparedPositionSource<Entry extends HistoryPositionEntry,
  Metadata extends HistoryPositionEntry = Entry>(input: {
  invoke: HistoryPositionInvoke;
  prepared?: HistoryPreparedPositionMetadataOwner<Metadata> | null;
  metadata?: readonly unknown[] | null;
  sparse?: HistoryPrimarySparsePublication<Entry> | null;
  currentRows?: readonly Entry[];
  units: readonly ({ readonly kind: 'entry'; readonly entry: Entry }
    | { readonly kind: 'group'; readonly entries: readonly Entry[] })[];
  itemKeys: readonly string[];
  owns?: () => boolean;
  open?: HistoryPositionOpen;
}): HistoryPreparedPositionSource<Entry | Metadata>;

/** Selects the migrated adapter before allocating a coordinate/child lease.
 * False preserves the genuine named native adapter. It is never absence proof. */
export function canBindHistoryPreparedPositionFrame<Entry extends HistoryPositionEntry,
  Metadata extends HistoryPositionEntry = Entry>(input: {
  prepared?: HistoryPreparedPositionMetadataOwner<Metadata> | null;
  metadata?: readonly unknown[] | null;
  sparse?: HistoryPrimarySparsePublication<Entry> | null;
  currentRows?: readonly Entry[];
  units: readonly ({ readonly kind: 'entry'; readonly entry: Entry }
    | { readonly kind: 'group'; readonly entries: readonly Entry[] })[];
  owns?: () => boolean;
}, options?: { signal?: AbortSignal }): Promise<boolean>;
