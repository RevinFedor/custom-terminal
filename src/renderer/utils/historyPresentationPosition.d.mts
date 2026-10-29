export type HistoryPositionUuid = string | number | boolean | bigint | null | undefined;
export interface HistoryPositionEntry { readonly uuid?: unknown; }
export type HistoryPositionUnit<Entry extends HistoryPositionEntry = HistoryPositionEntry> =
  | { readonly kind: 'entry'; readonly entry: Entry }
  | { readonly kind: 'group'; readonly entries: readonly Entry[] };
declare const positionPublicationBrand: unique symbol;
declare const positionAddressBrand: unique symbol;
export interface HistoryPositionPublication {
  readonly [positionPublicationBrand]: true;
  readonly frame: object | null;
  readonly witness: object | null;
  readonly projectionId: string;
  readonly unitCount: number;
  readonly status: 'pending' | 'ready' | 'failed' | 'superseded';
  readonly error: unknown;
  readonly promise: Promise<HistoryPositionPublication>;
}
export interface HistoryPositionAddress<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly [positionAddressBrand]: true;
  readonly publication: HistoryPositionPublication;
  readonly index: number;
  readonly memberIndex: number;
  readonly memberCount: number;
  readonly kind: 'entry' | 'group';
  readonly physicalKey: string;
  readonly uuid: HistoryPositionUuid;
  readonly entry: Entry;
}
export interface HistoryPositionReadOptions { readonly owns?: () => boolean; readonly signal?: AbortSignal; }
export interface HistoryPositionTransportReadOptions extends HistoryPositionReadOptions {
  /** Fixed local consumer identity; never sent as an IPC capability. */
  readonly queryOwner?: object;
}
export interface HistoryPositionRetirement {
  readonly promise: Promise<void>;
  readonly status: 'pending' | 'released' | 'unknown';
  readonly error?: unknown;
}
export interface HistoryPositionRecord {
  readonly uuid: HistoryPositionUuid;
  readonly index: number;
  readonly memberIndex: number;
  readonly memberCount: number;
}
export interface HistoryPositionTransportClient {
  resolve(uuid: HistoryPositionUuid, options?: HistoryPositionTransportReadOptions): Promise<
    { kind: 'found'; index: number; memberIndex: number } | { kind: 'missing' }>;
  close(): Promise<void>;
  /** Includes independent query children; parent close ACK alone is insufficient. */
  retirement?(): HistoryPositionRetirement;
}
export type HistoryPositionInvoke = (channel: string, payload: unknown) => Promise<unknown>;
export type HistoryPositionOpen = (invoke: HistoryPositionInvoke, input: {
  projectionId: string; unitCount: number; records: Iterable<HistoryPositionRecord> | AsyncIterable<HistoryPositionRecord>;
  owns: () => boolean; signal: AbortSignal;
  readThroughIpc: (invoke: HistoryPositionInvoke, channel: string, payload: unknown,
    options?: { signal?: AbortSignal }) => Promise<unknown>;
}) => Promise<HistoryPositionTransportClient>;
/** Independently owned selected prepared/current publication. Opening must
 * retain its own child; closing it cannot revoke the shared prepared parent.
 * Actual selected points are immutable and entryAt is a bounded, synchronous
 * witness check. No historical native array is part of this interface. */
export interface HistoryPositionSelectedPoint<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly kind: 'found';
  readonly index: number;
  readonly memberIndex: number;
  readonly memberCount: number;
  readonly physicalKey: string;
  readonly entry: Entry;
}
export interface HistoryPositionSelectedClient<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  resolve(uuid: HistoryPositionUuid, options?: HistoryPositionTransportReadOptions): Promise<
    HistoryPositionSelectedPoint<Entry> | { readonly kind: 'missing' }>;
  entryAt(point: HistoryPositionSelectedPoint<Entry>): Entry | null;
  close(): Promise<void>;
  retirement?(): HistoryPositionRetirement;
}
export interface HistoryPositionSelectedSource<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly unitCount: number;
  open(input: {
    readonly projectionId: string;
    readonly unitCount: number;
    readonly owns: () => boolean;
    readonly signal: AbortSignal;
    readonly readThroughIpc: (invoke: HistoryPositionInvoke, channel: string, payload: unknown,
      options?: { signal?: AbortSignal }) => Promise<unknown>;
  }): Promise<HistoryPositionSelectedClient<Entry>>;
}
export interface HistoryPositionSelectedPublicationInput<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly source: HistoryPositionSelectedSource<Entry>;
  readonly frame: object;
  readonly witness: object;
  readonly owns: (witness: object) => boolean;
}
export interface HistoryPositionPublicationInput<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly units: readonly HistoryPositionUnit<Entry>[];
  readonly itemKeys: readonly string[];
  /** Opaque original actual projection identity; excludes canonical Root and visit lifetime. */
  readonly frame: object;
  /** Original registration witness. Never reconstructed after an await. */
  readonly witness: object;
  readonly owns: (witness: object) => boolean;
}
export interface HistoryPresentationPositionOwner<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  publish(input: HistoryPositionPublicationInput<Entry> | HistoryPositionSelectedPublicationInput<Entry>): HistoryPositionPublication | null;
  capture(): HistoryPositionPublication | null;
  owns(publication: HistoryPositionPublication | null): boolean;
  entryAt(address: HistoryPositionAddress<Entry> | null): Entry | null;
  query(publication: HistoryPositionPublication, uuid: HistoryPositionUuid,
    options?: HistoryPositionTransportReadOptions): Promise<HistoryPositionAddress<Entry> | null>;
  /** Fixed resize/anchor/search/Timeline lanes invalidate with the original projection. */
  subscribeInvalidation(listener: () => void): () => void;
  /** Reversible consumer cleanup; exact raw retirement remains owned until its ACK. */
  clear(): Promise<void>;
  activate(): void;
  dispose(): Promise<void>;
  stats(): { registrations: number; published: number; reused: number; unitVisits: number;
    memberVisits: number; unqueryableUUIDs: number; queries: number; selectedValidations: number;
    releases: number; current: number; running: number; pending: number; retiring: number;
    nativeCoordinateMaps: 0 };
}
export interface HistoryPositionSelection<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  readonly status: 'pending' | 'ready' | 'absent' | 'failed' | 'superseded';
  readonly publication: HistoryPositionPublication | null;
  readonly uuid: HistoryPositionUuid;
  readonly address: HistoryPositionAddress<Entry> | null;
  readonly error: unknown;
  readonly promise: Promise<HistoryPositionSelection<Entry>>;
}
export interface HistoryPresentationPositionQuery<Entry extends HistoryPositionEntry = HistoryPositionEntry> {
  read(publication: HistoryPositionPublication | null, uuid: HistoryPositionUuid,
    options?: HistoryPositionReadOptions): HistoryPositionSelection<Entry>;
  resolve(publication: HistoryPositionPublication | null, uuid: HistoryPositionUuid,
    options?: HistoryPositionReadOptions): Promise<HistoryPositionSelection<Entry>>;
  peek(publication: HistoryPositionPublication | null, uuid: HistoryPositionUuid): HistoryPositionSelection<Entry> | null;
  clear(): void;
  dispose(): void;
  stats(): { selected: number; running: number; pending: number };
}
export function createHistoryPresentationPositionOwner<Entry extends HistoryPositionEntry = HistoryPositionEntry>(options: {
  invoke: HistoryPositionInvoke; open?: HistoryPositionOpen;
  onSettled?: (publication: HistoryPositionPublication) => void;
  onError?: (error: unknown) => void;
}): HistoryPresentationPositionOwner<Entry>;
export function createHistoryPresentationPositionQuery<Entry extends HistoryPositionEntry = HistoryPositionEntry>(
  owner: HistoryPresentationPositionOwner<Entry>, options?: { onError?: (error: unknown) => void },
): HistoryPresentationPositionQuery<Entry>;
