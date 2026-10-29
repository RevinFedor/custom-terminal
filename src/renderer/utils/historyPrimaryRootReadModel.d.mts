import type { HistoryPrimaryPromptLocal, HistoryPrimaryPromptAdoptionOptions, HistoryPrimaryPromptAdoptionProof,
  HistoryPrimaryPromptMetadataOptions, HistoryPrimaryPromptMetadataProof, HistoryPrimaryPromptAdoptionCandidate,
  HistoryPrimarySparsePromptMetadataOptions, HistoryPrimarySparsePromptMetadataProof } from './historyPrimaryPromptAdoption.mjs';
import type { HistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';
export const HISTORY_PRIMARY_PROFILE: 'history-primary-v1';
export const HISTORY_PRIMARY_FIELDS: readonly string[];
export type HistoryPrimaryRequestClass = 'view' | 'semantic' | 'source';
export interface HistoryPrimarySourceSnapshot {
  readonly filePath: string; readonly sessionId: string; readonly size: number;
  readonly mtimeMs: number; readonly ctimeMs: number; readonly fileIdentity: string;
  readonly linkKind: 'end'; readonly sourceGeneration?: string;
}
export interface HistoryPrimaryMetadataValidationCapability {
  readonly profile: 'primary-canonical-metadata-v1'; readonly schema: 1;
  readonly sourceProof: string; readonly validationDigest: string | null;
  readonly diagnosticTailDigest: string; readonly validationToken: string;
}
/** Fixed bounded diagnostic vocabulary, including a marker for an omitted
 * invalid value. This selected sample is never a full History row or body. */
export type HistoryPrimaryDiagnosticMetadataValue = string | number | boolean | null
  | Readonly<{ kind: 'invalid-diagnostic-metadata' }>;
export interface HistoryPrimaryCanonicalDiagnosticRow {
  readonly uuid?: HistoryPrimaryDiagnosticMetadataValue;
  readonly sourceIdentity?: HistoryPrimaryDiagnosticMetadataValue;
  readonly contentRevision?: HistoryPrimaryDiagnosticMetadataValue;
  readonly recordByteOffset?: HistoryPrimaryDiagnosticMetadataValue;
  readonly sessionId?: HistoryPrimaryDiagnosticMetadataValue;
  readonly liveProjection?: HistoryPrimaryDiagnosticMetadataValue;
  readonly sourceSequence?: HistoryPrimaryDiagnosticMetadataValue;
}
export type HistoryPrimaryCanonicalDiagnosticTail = Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'row'; ordinal: number; row: HistoryPrimaryCanonicalDiagnosticRow }>;
declare const historyPrimaryCanonicalMetadataFactBrand: unique symbol;
/** Established only by the dedicated checked reader. Full canonical validation
 * and exact immutable cut binding are required, including for hidden rows.
 * A source-owner authenticated reuse demand may retain the SAME selected tail. */
export interface HistoryPrimaryCanonicalMetadataFact {
  readonly [historyPrimaryCanonicalMetadataFactBrand]: true;
  readonly kind: 'validated-canonical-metadata';
  readonly profile: 'primary-canonical-metadata-v1'; readonly schema: 1;
  readonly leaseId: string; readonly ownerKey: string; readonly revision: string; readonly generation: string;
  readonly parentNodeToken: string; readonly nodeToken: string; readonly sourceNodeToken: string;
  readonly metadataIdentity: string; readonly metadataSchema: 1; readonly semanticIdentity: string;
  readonly semanticRevisionToken: string; readonly viewRevisionToken: string;
  readonly canonicalEntryCount: number; readonly sourceEntryCount: number;
  readonly sourceProof: string; readonly validationDigest: string; readonly diagnosticTailDigest: string;
  readonly validationToken: string; readonly validationReceipt: string;
  readonly sourceSnapshot: HistoryPrimarySourceSnapshot;
  readonly diagnosticTail: HistoryPrimaryCanonicalDiagnosticTail;
}
/** Genuine native prepared Np compatibility graph. Its vocabulary follows the
 * existing thin predicate, which admits arbitrary truthy uuid values. This
 * owner remains OPEN; it carries no canonical Nc inventory authority. */
export type HistoryPrimaryPreparedMetadataValue = string | number | boolean | bigint | null | undefined
  | readonly HistoryPrimaryPreparedMetadataValue[] | { readonly [key: string]: HistoryPrimaryPreparedMetadataValue };
export interface HistoryPrimaryPreparedMetadataRow {
  readonly uuid: HistoryPrimaryPreparedMetadataValue;
  readonly rowStub: true;
  readonly [key: string]: HistoryPrimaryPreparedMetadataValue;
}
export interface HistoryPrimaryEffectiveSettings {
  readonly model?: string; readonly effort?: string;
  readonly proofAt: number; readonly proof: 'rollout-turn-context';
}
export interface HistoryPrimaryMetadata {
  readonly preparedCompatibilityKind: 'prepared-metadata-compatibility';
  readonly entries: readonly HistoryPrimaryPreparedMetadataRow[];
  readonly canonicalMetadataFact: HistoryPrimaryCanonicalMetadataFact;
  readonly effectiveSettings: HistoryPrimaryEffectiveSettings | null;
}
export interface HistoryPrimaryReadRequest {
  toolType?: string; sessionId?: string; cwd?: string; tabId?: string;
  primaryRequestClass?: HistoryPrimaryRequestClass;
  primaryPresentation?: any;
  primaryPresentationOnly?: boolean;
  primaryViewOptions?: { grouping?: any; captionSelections?: [string, string][] };
  suppressions?: any[];
  [key: string]: any;
}
export interface HistoryPrimaryReadHeader {
  readonly leaseId: string; readonly ownerKey: string; readonly revision: string; readonly generation: string;
  readonly semanticIdentity?: string; readonly metadataIdentity?: string; readonly metadataSchema?: 1;
  readonly semanticRevisionToken?: string; readonly viewRevisionToken?: string;
  readonly primaryRequestClass?: HistoryPrimaryRequestClass;
  readonly canonicalEntryCount: number; readonly sourceEntryCount: number;
  readonly sourceSnapshot: HistoryPrimarySourceSnapshot;
  readonly canonicalMetadataValidation?: HistoryPrimaryMetadataValidationCapability;
  readonly [key: string]: any;
}
export interface HistoryPrimaryCanonicalMetadataDescriptor {
  readonly protocol: 'history-root-v1'; readonly kind: 'object'; readonly nodeToken: string;
  readonly leaseId: string; readonly ownerKey: string; readonly revision: string; readonly generation: string;
}
export type HistoryPrimaryOpenResult = { kind: 'root'; model: HistoryPrimaryRootReadModel }
  | { kind: 'legacy'; result: any }
  | { kind:'superseded-dependency'; requiredClass:'source'; domain:'prompt'|'timing'; generation:string; ownerKey:string;
      witness:{mode:'scoped';before:string;after:string} }
  | { kind: 'recompose-required'; requiredClass: 'semantic' | 'source'; reason: string };
export interface HistoryPrimaryPresentationScope {ownerKey:string;generation:number;visit:number;presented:boolean}
export interface HistoryPrimaryWindowOutcome {status:string;adoptionId?:number;leaseId?:string;reason?:string;error?:any;[key:string]:any}
export interface HistoryPrimaryReadOptions { signal?: AbortSignal; owns?: () => boolean }
export interface HistoryPrimaryPresentationTarget {
  toolUseId?: string;
  requestId?: string;
  readSessionId?: string;
  messageReference?: {
    physicalSessionId?: string; sessionId?: string; transcriptSegmentId?: string; rawUuid?: string;
    provider?: string;
  };
}
export interface HistoryPrimaryPresentationAddress {
  readonly index: number;
  readonly header: HistoryPrimaryCanonicalMetadataDescriptor;
  readonly sourceEntry?: HistoryPrimaryCanonicalMetadataDescriptor;
  readonly sourceOrdinal?: number;
  readonly entryUuid: string; readonly uuid: string;
  readonly firstUuid: string; readonly lastUuid: string;
  readonly groupKey: string | null; readonly physicalKey: string;
  readonly kind: 'entry' | 'group'; readonly entryCount: number; readonly expanded: boolean;
  readonly cut: Readonly<Pick<HistoryPrimaryReadHeader, 'leaseId' | 'ownerKey' | 'revision' | 'generation'
    | 'semanticIdentity' | 'metadataIdentity' | 'semanticRevisionToken' | 'viewRevisionToken'>>;
}
export interface HistoryPrimaryTerminalPreviewTarget {
  readonly canonicalUuid: string; readonly unitIndex: number; readonly domUuid: string;
  readonly groupKey: string | null; readonly presentationKind: 'entry' | 'group'; readonly physicalKey: string;
}
export interface HistoryPrimaryTerminalPreviewMembership {
  readonly header: HistoryPrimaryReadHeader; readonly canonicalPresent: boolean; readonly preparedPresent: boolean;
  readonly preparedTextHash: string | null; readonly target: HistoryPrimaryTerminalPreviewTarget | null;
}
export interface HistoryPrimaryLiveIdentityCoverageProof<T = unknown> {
  readonly header: HistoryPrimaryReadHeader;
  /** Checked same-data source cut, independent of the current query header/sequence. */
  readonly dataSubject: Readonly<object>;
  readonly claims: readonly Readonly<{
    entry: T; fingerprint: string; coveredIdentity: boolean; settingsConflict: boolean;
  }>[];
}
export type HistoryPrimaryReceiptScalar = string | number | boolean | bigint | null | undefined;
export interface HistoryPrimaryConfirmedReceiptProof {
  readonly header: HistoryPrimaryReadHeader;
  readonly found: boolean;
  readonly ordinal: number | null;
  readonly acknowledgement: Readonly<{
    operationKey: string; attemptId: string; handoffId: string; provider: 'claude' | 'codex';
    sessionId: HistoryPrimaryReceiptScalar; entryUuid: HistoryPrimaryReceiptScalar; sourceIdentity: HistoryPrimaryReceiptScalar;
  }> | null;
}
export interface HistoryPrimaryRenderSnapshot {
  readonly header: HistoryPrimaryReadHeader; readonly adoptionId: number; readonly totalCount: number;
  readonly window: Map<number, any>;
  readonly addresses: Map<number, HistoryPrimaryPresentationAddress>;
}
export interface HistoryPrimaryCommittedRange {
  startIndex: number; endIndex: number; totalCount: number; stable: boolean;
  /** Missing counts represent an unadmitted/pending commit, not paint coverage. */
  itemCount?: number; admittedCount?: number;
}
export function historyPrimaryUnitKey(unit: any): string;
export function historyPrimaryColdReadWakeAllowed(options: {
  enabled: boolean; toolType: string; supported: boolean; hasRoot: boolean;
  failure: { ownerKey: string; kind: 'source-changed' | 'fatal' } | null; ownerKey: string; record: any;
}): boolean;
export function selectHistoryPrimaryLocalRows<T extends { uuid: string; rowStub?: boolean }>(currentRows: T[], isLocal: (row: T) => boolean): T[];
export function adoptHistoryPrimaryMetadata<T extends { uuid: string; rowStub?: boolean }>(
  prepared: T[], currentRows: T[], capturedLocalRows: T[],
  options: { isLocal: (row: T) => boolean; mergeLate: (rows: T[], late: T[]) => T[] },
): T[];
export function historyPrimaryToolClaimFingerprint(value: any): string;
/** Fresh full graph plus actual live identity/settings semantics, including inherited alias changes. */
export function historyPrimaryLiveClaimFingerprint(value: any): string;
export function applyHistoryPrimaryToolCoverage<T>(currentResults: Map<string,T>, proofs: readonly {key:string;fingerprint:string}[]): Map<string,T>;
export function readHistoryPrimaryUnitDocument(document: any, options?: { signal?: AbortSignal; owns?: () => boolean }): Promise<any>;
export class HistoryPrimaryRootReadModel {
  constructor(invoke: (channel: string, payload: any) => Promise<any>, transport: any, options?: { creditBytes?: number });
  readonly totalCount: number;
  readonly header: HistoryPrimaryReadHeader | null;
  readonly metadata: HistoryPrimaryMetadata | null;
  closed: boolean;
  windowFailure: any;
  renderSnapshot(): HistoryPrimaryRenderSnapshot | null;
  addressAt(index: number): HistoryPrimaryPresentationAddress | undefined;
  matchesSnapshotUnit(snapshot: HistoryPrimaryRenderSnapshot | null, index: number, unit: any): boolean;
  hasCurrentPresentationCoverage(scope: HistoryPrimaryPresentationScope): boolean;
  finishPresentation(outcome: HistoryPrimaryWindowOutcome): void;
  commitEmptyPresentation(scope:HistoryPrimaryPresentationScope):HistoryPrimaryWindowOutcome|null;
  attachSurface(scope:HistoryPrimaryPresentationScope): {
    noteRange(start:number,end:number):void;
    bootstrapWindow(snapshot:HistoryPrimaryRenderSnapshot,index:number,inputsCurrent?:()=>boolean):Promise<{status:string;error?:unknown}>;
    commit(snapshot:HistoryPrimaryRenderSnapshot,range:HistoryPrimaryCommittedRange,matches:(index:number,unit:any)=>boolean,inputsCurrent?:()=>boolean):HistoryPrimaryWindowOutcome;
    dispose():void;
  };
  waitForPresentation(options?:{signal?:AbortSignal;owns?:()=>boolean;scope?:HistoryPrimaryPresentationScope|(()=>HistoryPrimaryPresentationScope)}):Promise<HistoryPrimaryWindowOutcome>;
  unitAt(index: number): any;
  subscribe(listener: () => void): () => void;
  /** Successful checked adoption only; body notifications do not wake metadata consumers. */
  onMetadata(listener: () => void): () => void;
  /** Current owner-qualified external open adoption/settlement only; never query UNKNOWN or body traffic. */
  onReceiptReadWake(listener: (event: Readonly<{kind:'adopted'|'settled';sequence:number;
    header:HistoryPrimaryReadHeader;dataSubject:Readonly<object>}>) => void): () => void;
  /** Opaque exact canonical/metadata data subject; retained only by checked view reuse. */
  getReceiptDataSubject(): Readonly<object> | null;
  /** Independent prepared child; its lifetime is released by the returned handle. */
  retainPreparedPresentation(options?: HistoryPrimaryReadOptions): HistoryPrimaryPreparedOwner;
  hasEntry(uuid: string): boolean;
  reconcileCommittedToolResults(options: {signal?:AbortSignal;owns?:(header:HistoryPrimaryReadHeader)=>boolean;commitPage:(proofs:{key:string;fingerprint:string}[],header:HistoryPrimaryReadHeader,claimRevision:number)=>void}):Promise<{status:'complete';claims:number;claimRevision:number;header:HistoryPrimaryReadHeader}>;
  /** Exact ordered local-prompt predicate; canonical/prepared and data-commit scopes remain distinct. */
  readPromptAdoption(localEntry: HistoryPrimaryPromptLocal, options?: HistoryPrimaryPromptAdoptionOptions): Promise<HistoryPrimaryPromptAdoptionProof | null>;
  preparePromptAdoption<T extends {uuid: string; rowStub?: boolean}>(prepared: T[], currentRows: T[], capturedLocalRows: T[],
    options: HistoryPrimaryPromptMetadataOptions<T>): Promise<HistoryPrimaryPromptMetadataProof<T>>;
  preparePromptAdoptionSparse<T extends {uuid: string; rowStub?: boolean}>(currentLocalRows: T[], capturedLocalRows: T[],
    options: HistoryPrimarySparsePromptMetadataOptions<T>): Promise<HistoryPrimarySparsePromptMetadataProof<T>>;
  /** Complete normalized USER text strictly at/after the receipt boundary; recovery only, never Send truth. */
  hasLaterCanonicalReceipt(record: unknown, options?: HistoryPrimaryReadOptions): Promise<boolean>;
  /** First eligible exact canonical receipt match; data-commit and ACK CAS remain caller-owned. */
  readConfirmedCanonicalReceipt(record: unknown, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryConfirmedReceiptProof>;
  /** Exact live identity/aliases in canonical and prepared scopes; selected text hash and address remain separate. */
  readTerminalPreviewMembership(identity: string, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryTerminalPreviewMembership>;
  /** At most three current live claims; full live grammar and last settings fact, never paint or Send authority. */
  readLiveIdentityCoverage<T>(claims: readonly T[], options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryLiveIdentityCoverageProof<T>>;
  /** Exact trimmed prompt identity in the held durable cut; returns a signed metadata row, never a decoded row. */
  findCanonicalPromptIdentity(identity: string, options?: { signal?: AbortSignal; owns?: () => boolean }): Promise<{ ordinal: number; row: HistoryPrimaryCanonicalMetadataDescriptor } | null>;
  /** UUID-only membership in the held durable cut; oversized IDs stream exact fields, without native metadata. */
  hasCanonicalUuid(uuid: string, options?: { signal?: AbortSignal; owns?: () => boolean }): Promise<boolean>;
  resolveUuid(uuid: string, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPresentationAddress | null>;
  resolveGroup(key: string, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPresentationAddress | null>;
  resolveKey(key: string, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPresentationAddress | null>;
  resolveIndex(index: number, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPresentationAddress | null>;
  resolvePresentationTarget(identity: string, tool?: HistoryPrimaryPresentationTarget | null, options?: HistoryPrimaryReadOptions): Promise<HistoryPrimaryPresentationAddress | null>;
  resolveAddress(mode: 'uuid' | 'group' | 'key' | 'target' | 'range', value: string | null,
    options?: HistoryPrimaryReadOptions & {tool?: HistoryPrimaryPresentationTarget | null; offset?: number}): Promise<HistoryPrimaryPresentationAddress | null>;
  open<P extends { isCurrent(): boolean } = HistoryPrimaryPromptMetadataProof<any>>(payload: HistoryPrimaryReadRequest,
    options?: { signal?: AbortSignal; owns?: () => boolean; beforeAdopt?: () => Promise<void>;
    prepareAdopt?: (candidate: HistoryPrimaryPromptAdoptionCandidate) => Promise<P>;
    adopt?: (model: HistoryPrimaryRootReadModel, promptAdoption?: P) => void; presentationScope?:HistoryPrimaryPresentationScope }): Promise<HistoryPrimaryOpenResult>;
  readWindow(start: number, end: number, options?: { signal?: AbortSignal; owns?: () => boolean; captionSelections?: [string, string][]; publish?: (model: HistoryPrimaryRootReadModel) => void }): Promise<void>;
  cancelWindow(): void;
  close(): Promise<void> | undefined;
}
