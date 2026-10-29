import type { HistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';
import type { HistoryPrimarySparsePublication, HistoryPrimarySparsePromptMetadataProof } from './historyPrimaryPromptAdoption.mjs';
import type { HistoryAgentCatalogSource, HistoryAgentCatalogSourceHint, HistoryAgentCatalogSourceOwner } from './historyAgentCatalogSourceOwner.mjs';
export interface HistoryPrimaryPublicationScope { readonly ownerKey: string; readonly generation: number; }
export interface HistoryPrimaryShownPublication<T> extends HistoryPrimaryPublicationScope {
  readonly kind: 'prepared-with-current-locals' | 'current-local-only';
  readonly sequence: number;
  readonly prepared: HistoryPrimaryPreparedOwner | null;
  readonly sparse: HistoryPrimarySparsePublication<T> | null;
  readonly rows: readonly T[];
  readonly entries: WeakRef<T[]>;
  readonly dataSubject: Readonly<object>;
  readonly agentCatalog?: HistoryAgentCatalogSource<T> | null;
}
export interface HistoryPrimarySparsePublicationOwner<T> {
  publishCompatibility(entries: T[], scope: HistoryPrimaryPublicationScope,
    options?: { owns?(): boolean; sourceHint?: HistoryAgentCatalogSourceHint | null }): HistoryPrimaryShownPublication<T>;
  adopt(proof: HistoryPrimarySparsePromptMetadataProof<T> & { readonly prepared: HistoryPrimaryPreparedOwner },
    entries: T[], scope: HistoryPrimaryPublicationScope): HistoryPrimaryShownPublication<T>;
  current(scope?: HistoryPrimaryPublicationScope): HistoryPrimaryShownPublication<T> | null;
  localRows(scope: HistoryPrimaryPublicationScope): readonly T[] | null;
  matches(publication: HistoryPrimaryShownPublication<T> | null, entries: T[], scope: HistoryPrimaryPublicationScope): boolean;
  clear(): void;
  close(): void;
}
export function createHistoryPrimarySparsePublicationOwner<T>(options: {
  isLocal(row: T): boolean; onReleaseError?(error: unknown): void;
  agentSourceOwner?: HistoryAgentCatalogSourceOwner<T>; agentCatalogEnabled?(): boolean;
}): HistoryPrimarySparsePublicationOwner<T>;
