export const TIMELINE_PRIMARY_PROFILE: 'timeline-primary-v1';
export interface TimelineRootIdentity {
  readonly leaseId: string; readonly ownerKey: string; readonly revision: string; readonly generation: string;
}
export interface TimelineRootHeader extends TimelineRootIdentity {
  readonly success: true;
  readonly __notedHistoryTransport: 'root-v1';
  readonly readProfile: typeof TIMELINE_PRIMARY_PROFILE;
  readonly semanticSnapshotComplete: true;
  readonly semanticRevisionToken: string;
  readonly totalEntries: number;
  readonly root: Readonly<TimelineRootIdentity & { protocol: 'history-root-v1'; kind: 'array'; nodeToken: string; length: number }>;
  readonly sessionMeta: Readonly<TimelineRootIdentity & { protocol: 'history-root-v1'; kind: 'object'; nodeToken: string }>;
  readonly sourceSnapshot: Readonly<{ sessionId: string; filePath: string; size: number; mtimeMs: number;
    ctimeMs: number; fileIdentity: string; linkKind: 'end'; sourceGeneration?: string }>;
  readonly mode: 'rebuild' | 'append' | 'unchanged';
  readonly readMetrics: Readonly<Record<string, number | boolean>>;
  readonly producerBounded: boolean;
  readonly nativeMemoryMeasured: boolean;
}
export interface TimelineRootRequest {
  toolType?: string; sessionId?: string; cwd?: string; tabId?: string;
  [key: string]: unknown;
}
export interface TimelineReadOwnership { signal?: AbortSignal; owns?: () => boolean }
export interface TimelineWindowSnapshot<Entry = any, Metadata = any> {
  readonly header: TimelineRootHeader; readonly adoptionId: number; readonly totalCount: number;
  readonly metadata: Metadata;
  /** Compact entries cover [start,end). Public readWindow/noteRange use inclusive end. */
  readonly start: number; readonly end: number; readonly entries: readonly Entry[];
}
export function readTimelineSelectedValue(reader: any, descriptor: any, options?: TimelineReadOwnership): Promise<any>;
export class TimelineRootReadModel<Entry = any, Metadata = any> {
  constructor(invoke: (channel: string, payload: any) => Promise<any>,
    transport: { openHistoryRootThroughIpc: (...args: any[]) => Promise<any> },
    options?: { creditBytes?: number; maxWindowRows?: number });
  readonly header: TimelineRootHeader | null;
  readonly totalCount: number;
  readonly metadata: Metadata | null;
  readonly closed: boolean;
  snapshot(): TimelineWindowSnapshot<Entry, Metadata> | null;
  entryAt(index: number): Entry | undefined;
  /** Indexed on this immutable root; no renderer-wide UUID catalog. */
  findUUID(uuid: string, options?: TimelineReadOwnership): Promise<{ readonly index: number; readonly header: TimelineRootHeader } | null>;
  subscribe(listener: () => void): () => void;
  /** Demand only, no RPC. Also usable before the first open. */
  noteRange(start: number, end: number): void;
  /** One provisional root at a time; overlap rejects TIMELINE_ROOT_OPEN_IN_FLIGHT. */
  open(payload: TimelineRootRequest, options?: TimelineReadOwnership & {
    beforeAdopt?: () => Promise<void> | void;
    adopt?: (model: TimelineRootReadModel<Entry, Metadata>) => void;
    expectedOwnerKey?: string; expectedGeneration?: string;
  }): Promise<{ kind: 'root'; model: TimelineRootReadModel<Entry, Metadata> }>;
  /** Same demand/signal/owns coalesces; covered demand costs zero RPC. */
  readWindow(start: number, end: number, options?: TimelineReadOwnership): Promise<TimelineWindowSnapshot<Entry, Metadata> | null>;
  cancelWindow(): void;
  close(): Promise<void>;
}
