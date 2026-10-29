import type { HistoryPrimaryRootReadModel, HistoryPrimaryReadHeader, HistoryPrimaryReadOptions,
  HistoryPrimaryMetadata } from './historyPrimaryRootReadModel.mjs';
import type { HistoryPrimaryPreparedOwner } from './historyPrimaryPreparedOwner.mjs';

export interface HistoryPrimaryPromptLocal {
  content: unknown;
  timestamp: unknown;
  optimisticAt?: unknown;
  auditEntryUuid?: unknown;
  sourceIdentity?: unknown;
  requiresAuditIdentity?: unknown;
  auditTimestamp?: unknown;
  auditSessionId?: unknown;
  handoffId?: unknown;
  queueStatus?: unknown;
}
export interface HistoryPrimaryLegacyPromptHandoff {
  handoffId: unknown;
  source?: unknown;
  queueStatus: unknown;
  sendOperationKey?: unknown;
  sendAttemptId?: unknown;
}
export type HistoryPrimaryPromptAdoptionOptions = HistoryPrimaryReadOptions & {
  excludedUuids?: ReadonlySet<string>;
  legacyHandoff?: HistoryPrimaryLegacyPromptHandoff;
  /** Held source/query freshness only; pair with the caller’s exact publication owner.
   * Runs for both match and confirmed absence. It grants no ACK/Send authority. */
  onProof?: (isCurrent: () => boolean) => void;
} & ({ scope?: 'canonical'; committed?: boolean } | { scope: 'prepared'; committed?: false });
/** Selected identity/sidecar projection, never a complete History body. */
export interface HistoryPrimaryPromptAdoptionEntry {
  readonly uuid: string;
  readonly sessionId?: string;
  readonly sourceIdentity?: string;
  readonly sourceIdentityAliases?: readonly unknown[];
  readonly sourceUuidAliases?: readonly unknown[];
}
export interface HistoryPrimaryPromptAdoptionProof {
  readonly header: HistoryPrimaryReadHeader;
  readonly dataSubject: Readonly<object>;
  readonly ordinal: number;
  readonly entry: HistoryPrimaryPromptAdoptionEntry;
  readonly legacy: boolean;
  readonly hasPromptChips: boolean;
  readonly hasImagePaths: boolean;
}
export interface HistoryPrimaryPromptMetadataProof<T> {
  readonly entries: T[];
  readonly publication?: HistoryPrimarySparsePublication<T>;
  /** Fresh full current authoring witness plus exact owner/cut checks. */
  isCurrent(): boolean;
}
export interface HistoryPrimaryPromptMetadataOptions<T> extends HistoryPrimaryReadOptions {
  isLocal(row: T): boolean;
}
export interface HistoryPrimaryPromptSuppression {
  readonly text: unknown;
  readonly requiresAuditIdentity?: unknown;
  readonly auditTimestamp?: unknown;
  readonly auditSessionId?: unknown;
  readonly sourceIdentity?: unknown;
  readonly since?: unknown;
  readonly until?: unknown;
}
/** CURRENT-local deltas in original prepared source coordinates. It contains
 * no historical row array, key inventory, layout shape or writer authority. */
declare const historyPrimarySparsePublicationBrand: unique symbol;
export interface HistoryPrimarySparsePublication<T> {
  readonly [historyPrimarySparsePublicationBrand]: true;
  readonly kind: 'history-primary-sparse-presentation-v1';
  readonly header: HistoryPrimaryReadHeader;
  readonly dataSubject: Readonly<object>;
  readonly sourceEntryCount: number;
  readonly replacements: readonly Readonly<{ ordinal: number; row: T }>[];
  readonly exclusions: readonly number[];
  readonly enrichments: readonly Readonly<{ uuid: unknown; promptChips?: unknown; imagePaths?: unknown }>[];
  readonly insertionOrder: 'buildHistoryLivePresentation';
  readonly insertions: readonly T[];
  readonly currentLocals: readonly T[];
}
export interface HistoryPrimarySparsePromptMetadataOptions<T> extends HistoryPrimaryPromptMetadataOptions<T> {
  readonly suppressions?: readonly HistoryPrimaryPromptSuppression[];
}
export interface HistoryPrimarySparsePromptMetadataProof<T> {
  readonly publication: HistoryPrimarySparsePublication<T>;
  /** Original local witness and native proof replay; grants no ACK authority. */
  isCurrent(): boolean;
  /** Compatibility-only Np result from the exact original metadata owner. */
  materializeCompatibility(prepared: T[]): T[];
}
export interface HistoryPrimaryPromptAdoptionCandidate {
  readonly header: HistoryPrimaryReadHeader;
  readonly metadata: HistoryPrimaryMetadata;
  preparePromptAdoption<T extends {uuid: string; rowStub?: boolean}>(
    prepared: T[], currentRows: T[], capturedLocalRows: T[], options: HistoryPrimaryPromptMetadataOptions<T>,
  ): Promise<HistoryPrimaryPromptMetadataProof<T>>;
  preparePromptAdoptionSparse<T extends {uuid: string; rowStub?: boolean}>(
    currentLocalRows: T[], capturedLocalRows: T[], options: HistoryPrimarySparsePromptMetadataOptions<T>,
  ): Promise<HistoryPrimarySparsePromptMetadataProof<T> & { readonly prepared: HistoryPrimaryPreparedOwner }>;
}
export function historyPrimaryPromptAdoptionFingerprint(value: unknown): string;
export function readHistoryPrimaryPromptAdoption(
  model: HistoryPrimaryRootReadModel, view: unknown, local: HistoryPrimaryPromptLocal,
  options?: HistoryPrimaryPromptAdoptionOptions,
): Promise<HistoryPrimaryPromptAdoptionProof | null>;
export function prepareHistoryPrimarySparsePromptAdoption<T extends {uuid: string; rowStub?: boolean}>(
  model: HistoryPrimaryRootReadModel, view: unknown, currentLocalRows: T[], capturedLocalRows: T[],
  options: HistoryPrimarySparsePromptMetadataOptions<T>,
): Promise<HistoryPrimarySparsePromptMetadataProof<T>>;
export function materializeHistoryPrimarySparseCompatibility<T>(
  publication: HistoryPrimarySparsePublication<T>, prepared: T[],
): T[];
export function historyPrimarySparsePreparedOverride<T>(
  publication: HistoryPrimarySparsePublication<T>, ordinal: number,
): T | boolean;
export function historyPrimarySparseCompatibilityOrdinal<T>(
  publication: HistoryPrimarySparsePublication<T>, row: unknown,
): number | null;
export function selectHistoryPrimarySparsePreparedRow<T>(
  publication: HistoryPrimarySparsePublication<T>, ordinal: number, selectedMetadata: T,
): T | false;
