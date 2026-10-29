import type { HistoryAgentCatalogSegment } from './historyAgentCatalogSourceOwner.mjs';
declare const mainFactsMapBrand: unique symbol;
declare const mainFactsSetBrand: unique symbol;
declare const mainFactRecordBrand: unique symbol;
export interface HistoryAgentCatalogMainFactRecord { readonly [mainFactRecordBrand]: true }
/** Own data produced at Main's existing normalization. Returns a fresh
 * ordinary record; field values/launchSettings keep their original identity.
 * Custom accessors/prototypes are outside this new Main-facts API, while
 * native CURRENT rows/actions retain their existing full grammar. */
export function createHistoryAgentCatalogMainFact<T extends object>(fields: T): T & HistoryAgentCatalogMainFactRecord;
/** A fresh intrinsic collection created by the actual Main-facts adapter.
 * Values must be original createHistoryAgentCatalogMainFact results and stay
 * mutable. A structural ReadonlyMap/custom getter is not
 * accepted by the catalog; legacy collectors retain their separate API. */
export interface HistoryAgentCatalogMainFactsMap<K, V> extends Map<K, V> {
  readonly [mainFactsMapBrand]: true;
}
export interface HistoryAgentCatalogMainFactsSet<T> extends Set<T> {
  readonly [mainFactsSetBrand]: true;
}
export function createHistoryAgentCatalogMainFactsMap<K = string, V = unknown>(
  entries?: Iterable<readonly [K, V]> | null): HistoryAgentCatalogMainFactsMap<K, V>;
export function createHistoryAgentCatalogMainFactsSet<T = string>(
  values?: Iterable<T> | null): HistoryAgentCatalogMainFactsSet<T>;
export interface HistoryAgentCatalogCurrent {
  readonly wire: Readonly<object>;
  readonly values: unknown[];
  drive(stage: any, options?: { signal?: AbortSignal; owns?(): boolean }): Promise<void>;
  isCurrent(): boolean;
  /** Original C Main contents/fields and optional genuine non-Proxy settings
   * descriptors; true verifies values after native replay/FULL/owner fences.
   * Missing Node authority and arbitrary CURRENT getters retain exact replay. */
  hasIntrinsicReadAuthority(verifyValues?: boolean): boolean;
}
export function createHistoryAgentCatalogCurrent<T>(options: {
  recipe: { segments?: readonly HistoryAgentCatalogSegment<T>[]; replacements?: readonly { ordinal: number; row: T }[];
    exclusions?: readonly number[]; insertions?: readonly T[]; live?: readonly T[] };
  context: { isTurnBusy: boolean; agentProcessAlive: boolean; currentSessionId: string;
    currentProcessGeneration: string | null; chipToolType: string;
    exactActiveSubagents?: HistoryAgentCatalogMainFactsMap<string, unknown> | null;
    exactActiveBackgroundTasks?: HistoryAgentCatalogMainFactsMap<string, unknown> | null;
    terminalBackgroundTaskCalls?: HistoryAgentCatalogMainFactsSet<string> | null;
    terminalFacts?: HistoryAgentCatalogMainFactsMap<string, unknown> };
  isLocalPromptEntry(row: T): boolean; isTaskAction(action: any): boolean;
  historyAgentKey(action: any, entryUuid: string): string;
  owns?(): boolean; fingerprint(value: unknown): string;
}): HistoryAgentCatalogCurrent;
