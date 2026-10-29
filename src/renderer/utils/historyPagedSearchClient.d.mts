/** Reader capabilities only. These identities confer no input/Send authority. */
export interface HistoryPagedSearchIdentity {
  readonly leaseId: string;
  readonly ownerKey: string;
  readonly revision: string;
  readonly generation: string;
}
export interface HistoryPagedSearchRoot extends HistoryPagedSearchIdentity {
  readonly protocol: 'history-root-v1';
  readonly kind: 'array';
  readonly nodeToken: string;
  readonly length: number;
}
export interface HistoryPagedSearchSource {
  readonly filePath: string;
  readonly sessionId: string;
  readonly fileIdentity: string;
  readonly sourceGeneration: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
export interface HistoryPagedSearchHeader extends HistoryPagedSearchIdentity {
  readonly readProfile: 'history-search-v1';
  readonly searchSchema1: 1;
  readonly root: HistoryPagedSearchRoot;
  readonly total: number;
  readonly entryTotal: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly sourceSnapshot: HistoryPagedSearchSource;
}
export interface HistoryPagedSearchMatch {
  readonly entryUuid: string;
  readonly entryIndex: number;
  readonly entryRef: unknown;
  readonly sourceIdentity: string | null;
  readonly physicalSessionId: string | null;
  readonly offset: number;
  /** Global occurrence index, not an index into the requested page. */
  readonly matchIndex: number;
  readonly occurrence: number;
  readonly role: string;
  readonly turnKeys: readonly string[];
  readonly snippet: string;
  readonly snippetStart: number;
  readonly hasImages: boolean;
}
export interface HistoryPagedSearchEntryFlag {
  /** Exact identity key; despite the wire name this may be any entry alias. */
  readonly entryUuid: string;
  readonly match: boolean;
}
export type HistoryPagedSearchInvoke = (channel: string, payload: unknown) => Promise<any>;
export interface HistoryPagedSearchScope { sessionId: string; tabId?: string; cwd?: string }
export interface HistoryPagedSearchRequest extends HistoryPagedSearchScope {
  toolType?: string;
  query?: string;
  type?: string;
  offset?: number;
  limit?: number;
  diagnosticActionId?: string | null;
}
export interface HistoryPagedSearchResult extends HistoryPagedSearchHeader {
  readonly success: true;
  readonly matches: readonly HistoryPagedSearchMatch[];
  readonly searchClient: HistoryPagedSearchClient;
}
export class HistoryPagedSearchClient {
  constructor(invoke: HistoryPagedSearchInvoke, result: unknown, scope: HistoryPagedSearchScope);
  readonly header: HistoryPagedSearchHeader;
  readonly identity: HistoryPagedSearchIdentity;
  readonly closed: boolean;
  /** Only the requested offset/limit page (default100, max5000). */
  matches(options?: { signal?: AbortSignal }): Promise<readonly HistoryPagedSearchMatch[]>;
  /** Exact matching-entry keys only; each call must contain 1..3 strings. */
  entryFlags(entryUuids: readonly string[]): Promise<readonly HistoryPagedSearchEntryFlag[]>;
  /** Local reference, independent of the owning History and other readers. */
  retain(): () => Promise<void>;
  release(token: object | 'owner'): Promise<void>;
  close(): Promise<void>;
}
export function openHistoryPagedSearch(invoke: HistoryPagedSearchInvoke, payload: HistoryPagedSearchRequest,
  options?: { signal?: AbortSignal }): Promise<HistoryPagedSearchResult>;
