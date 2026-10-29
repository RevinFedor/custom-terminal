import type { HistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';
import type { HistoryAgentCatalogCurrent, HistoryAgentCatalogCounts, HistoryAgentCatalogRecord,
  HistoryAgentCatalogSelection, HistoryAgentCatalogSection } from '../../shared/history-agent-catalog-client.mjs';
export interface HistoryPrimaryAgentCatalogSnapshot {
  readonly ownerKey: string; readonly generation: number; readonly subject: object;
  readonly status: 'pending' | 'ready' | 'error'; readonly counts: HistoryAgentCatalogCounts | null;
  readonly rows: readonly HistoryAgentCatalogRecord[]; readonly section: HistoryAgentCatalogSection;
  readonly pageStart: number; readonly pageSize: number;
  readonly backgroundRows: readonly HistoryAgentCatalogRecord[];
  readonly backgroundStart: number; readonly backgroundPageSize: number;
  readonly selected: HistoryAgentCatalogSelection; readonly error: unknown;
  readonly errorStage: 'source' | 'model' | 'read' | 'presentation' | null;
  readonly membership: HistoryPrimaryAgentCatalogMembership;
}
export interface HistoryPrimaryAgentCatalogMembershipRequest {
  readonly entries?: readonly string[]; readonly calls?: readonly string[];
  readonly any?: readonly Readonly<{id: string; kind: 'entry' | 'call'; values: () => Iterable<string>}>[];
}
export interface HistoryPrimaryAgentCatalogMembership {
  readonly status: 'pending' | 'ready' | 'error';
  readonly entries: readonly Readonly<{value: string; found: boolean | null}>[];
  readonly calls: readonly Readonly<{value: string; found: boolean | null}>[];
  readonly any: readonly Readonly<{id: string; found: boolean | null}>[];
}
export interface HistoryPrimaryAgentCatalogInputBase {
  readonly prepared: HistoryPrimaryPreparedOwner | null;
  readonly publication?: Readonly<{ownerKey: string; generation: number}>;
  readonly ownerKey?: string; readonly generation?: number;
  readonly subject?: object;
  /** Optional original absolute Date.now() deadline. Never extended beyond 30s. */
  readonly deadlineAt?: number;
  readonly owns?: () => boolean; readonly replay?: () => boolean;
  readonly fullWitness: () => boolean; readonly ownerFence?: () => boolean;
}
/** Construction failure is an explicit error input, never a fake CURRENT
 * capability or empty catalog. Runtime additionally requires a truthy error. */
export type HistoryPrimaryAgentCatalogInput = HistoryPrimaryAgentCatalogInputBase & (
  {readonly current: HistoryAgentCatalogCurrent; readonly sourceError?: unknown}
  | {readonly current: null; readonly sourceError: unknown}
);
export type HistoryPrimaryAgentCatalogUpdater = (previous: HistoryPrimaryAgentCatalogSnapshot | null)
  => HistoryPrimaryAgentCatalogSnapshot | null;
export interface HistoryPrimaryAgentCatalogOwner {
  update(input: HistoryPrimaryAgentCatalogInput): void;
  requestPage(options?: {section?: HistoryAgentCatalogSection; offset?: number; limit?: number}): void;
  select(key: string | null): void;
  requestMembership(request?: HistoryPrimaryAgentCatalogMembershipRequest): void;
  snapshot(): HistoryPrimaryAgentCatalogSnapshot | null;
  /** Fresh original proof at a synchronous publication/cleanup boundary. */
  isCurrent(snapshot: HistoryPrimaryAgentCatalogSnapshot | null): boolean;
  state(): Readonly<{closed: boolean; running: 'build' | 'query' | null;
    pending: boolean; held: boolean; candidate: boolean}>;
  close(): void;
}
export function createHistoryPrimaryAgentCatalogOwner(options?: {
  onChange?: (updater: HistoryPrimaryAgentCatalogUpdater) => void;
  onReleaseError?: (error: unknown) => void;
}): HistoryPrimaryAgentCatalogOwner;
