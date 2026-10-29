/** Renderer-owned CURRENT references are selected back into records unchanged.
 * Historical values remain in the immutable paged catalog until selected. */
import type { HistoryPrimaryPreparedCapability } from '../renderer/utils/historyPrimaryPreparedOwner.mjs';
export const HISTORY_AGENT_CATALOG_PROFILE: 'history-agent-catalog-v1';
export const HISTORY_AGENT_CATALOG_ENCODING: 'history-primary-agent-catalog-v1';
export interface HistoryAgentCatalogReadOptions { signal?: AbortSignal; owns?: () => boolean }
export type HistoryAgentCatalogSection = 'all' | 'roster' | 'running' | 'completed' | 'interrupted' | 'background';
export interface HistoryAgentCatalogCounts {
  readonly total: number; readonly roster: number; readonly running: number;
  readonly completed: number; readonly interrupted: number; readonly background: number;
  readonly backgroundAgents: number;
}
export interface HistoryAgentCatalogDescriptor {
  readonly protocol: 'history-root-v1'; readonly kind: 'object' | 'array' | 'text';
  readonly nodeToken: string; readonly leaseId: string; readonly ownerKey: string;
  readonly revision: string; readonly generation: string; readonly length?: number;
}
export interface HistoryAgentCatalogNativeRequest {
  readonly kind: 'identities' | 'physical' | 'deferred' | 'setting' | 'isLastUser' | 'task-actions'
    | 'agentKey' | 'property' | 'has' | 'coerce' | 'date' | 'map-get' | 'set-has' | 'iterator'
    | 'next' | 'strict-equal' | 'subtract' | 'setting-conflict-clone';
  readonly arguments: HistoryAgentCatalogDescriptor;
}
export interface HistoryAgentCatalogHeader {
  readonly leaseId: string; readonly ownerKey: string; readonly revision: string; readonly generation: string;
  readonly root: HistoryAgentCatalogDescriptor; readonly binding: Readonly<Record<string, unknown>>;
  readonly catalogRequestId: string; readonly sequence: number; readonly schema: 1;
  readonly readProfile: 'history-agent-catalog-v1'; readonly phase: 'native' | 'ready';
  readonly nativeRequest?: HistoryAgentCatalogNativeRequest;
  readonly counts?: HistoryAgentCatalogCounts;
  readonly sections?: Readonly<Record<HistoryAgentCatalogSection, HistoryAgentCatalogDescriptor>>;
}
export interface HistoryAgentCatalogRecord {
  readonly key: string; readonly kind: 'subagent' | 'bash' | 'monitor'; readonly label: string;
  readonly [field: string]: unknown;
}
export interface HistoryAgentCatalogPage {
  readonly section: HistoryAgentCatalogSection; readonly offset: number; readonly nextOffset: number;
  readonly done: boolean; readonly total: number; readonly rows: readonly HistoryAgentCatalogRecord[];
}
export type HistoryAgentCatalogSelection = Readonly<{kind: 'found'; key: string; record: HistoryAgentCatalogRecord}>
  | Readonly<{kind: 'missing'; key: string}>
  | Readonly<{kind: 'unknown'; key: string | null; record: HistoryAgentCatalogRecord | null}>;
export interface HistoryAgentCatalogStage {
  readonly header: HistoryAgentCatalogHeader;
  advance(value: unknown): Promise<HistoryAgentCatalogHeader>;
  readValue(node: HistoryAgentCatalogDescriptor): Promise<unknown>;
  readRecord(node: HistoryAgentCatalogDescriptor): Promise<HistoryAgentCatalogRecord>;
}
export interface HistoryAgentCatalogCurrent {
  readonly wire: unknown;
  readonly values: unknown[];
  drive(stage: HistoryAgentCatalogStage, options?: HistoryAgentCatalogReadOptions): Promise<void>;
  isCurrent(): boolean;
  /** No-getter provenance check. Final proof validates original C Main
   * collection contents/order and fields, plus intrinsic non-Proxy settings
   * descriptors. It never visits historical request keys. */
  hasIntrinsicReadAuthority?(verifyValues?: boolean): boolean;
}
export interface HistoryAgentCatalogReader {
  readonly kind: 'history-agent-catalog-reader-v1'; readonly header: HistoryAgentCatalogHeader;
  readonly counts: HistoryAgentCatalogCounts; readonly closed: boolean;
  readonly releaseState: 'held' | 'pending' | 'released' | 'unknown';
  readPage(options?: HistoryAgentCatalogReadOptions & {
    section?: HistoryAgentCatalogSection; offset?: number; limit?: number;
  }): Promise<HistoryAgentCatalogPage>;
  lookup(key: string, options?: HistoryAgentCatalogReadOptions): Promise<HistoryAgentCatalogSelection>;
  membership(operation: 'entry' | 'call', values: readonly string[], options?: HistoryAgentCatalogReadOptions):
    Promise<readonly Readonly<{value: string; found: boolean}>[]>;
  readValue(node: HistoryAgentCatalogDescriptor, options?: HistoryAgentCatalogReadOptions): Promise<unknown>;
  readRecord(node: HistoryAgentCatalogDescriptor, options?: HistoryAgentCatalogReadOptions): Promise<HistoryAgentCatalogRecord>;
  close(): Promise<unknown>;
}
declare const historyAgentCatalogCapabilityBrand: unique symbol;
export interface HistoryAgentCatalogCapability {
  readonly [historyAgentCatalogCapabilityBrand]: true;
  readonly kind: 'history-agent-catalog-capability-v1'; readonly header: HistoryAgentCatalogHeader;
  advance(data: Readonly<{value: unknown}>, options?: HistoryAgentCatalogReadOptions): Promise<HistoryAgentCatalogHeader>;
}
export function openHistoryAgentCatalog(capability: HistoryPrimaryPreparedCapability, current: unknown,
  options?: HistoryAgentCatalogReadOptions & {transport?: unknown}): Promise<HistoryAgentCatalogCapability>;
export function createHistoryAgentCatalogReader(capability: HistoryAgentCatalogCapability,
  options: {nativeValues?: unknown[]; readText: (...args: any[]) => Promise<string>}): HistoryAgentCatalogReader;
