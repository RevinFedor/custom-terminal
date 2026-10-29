import type { HistoryPrimaryReadHeader, HistoryPrimaryPreparedMetadataRow, HistoryPrimaryReadOptions } from './historyPrimaryRootReadModel.mjs';
import type { HistoryAgentCatalogCurrent, HistoryAgentCatalogReader } from '../../shared/history-agent-catalog-client.mjs';
declare const preparedCapabilityBrand: unique symbol;
export interface HistoryPrimaryPreparedCapability { readonly [preparedCapabilityBrand]: true; }
/** Independent LOCAL handle to one already-issued read-plane child. */
export interface HistoryPrimaryPreparedOwner {
  readonly kind: 'history-primary-prepared-owner-v1';
  readonly capability: HistoryPrimaryPreparedCapability;
  readonly header: HistoryPrimaryReadHeader;
  readonly originHeader: HistoryPrimaryReadHeader;
  readonly metadataSubject: Readonly<object> | null;
  readonly closed: boolean;
  readonly releaseState: 'held' | 'pending' | 'released' | 'unknown';
  readonly receiptDataSubject: Readonly<object>;
  retain(options?: HistoryPrimaryReadOptions): HistoryPrimaryPreparedOwner;
  assertCurrent(options?: HistoryPrimaryReadOptions): void;
  ownsCompatibilityMetadata(entries: unknown): boolean;
  readMetadataOrdinal(ordinal: number, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPreparedMetadataRow>;
  openAgentCatalog(current: HistoryAgentCatalogCurrent, options?: HistoryPrimaryReadOptions): Promise<HistoryAgentCatalogReader>;
  close(): Promise<unknown>;
  retirement(): Promise<unknown>;
}
export function createHistoryPrimaryPreparedOwner(capability: HistoryPrimaryPreparedCapability, transport: unknown,
  options: { receiptDataSubject: Readonly<object>; compatibilityEntries: readonly HistoryPrimaryPreparedMetadataRow[];
    readMetadata: (...args: never[]) => unknown;
    readText?: (...args: any[]) => Promise<string> }): HistoryPrimaryPreparedOwner;
