import { historyEntryHasExactIdentity } from './historyPromptPresentation.mjs';

export type HistoryPromptHandoffTool = 'claude' | 'codex';

export type HistoryPromptHandoffStatus =
  | 'preparing'
  | 'sending'
  | 'queued'
  | 'audit-pending'
  | 'delivery-unknown'
  | 'sent'
  | 'cancelled'
  | 'failed';

export type SettledHistoryPromptHandoffStatus = Exclude<
  HistoryPromptHandoffStatus,
  'preparing' | 'sending'
>;

export type HistoryPromptHandoffUnconfirmedStatus =
  | 'audit-pending'
  | 'delivery-unknown';

export interface HistoryPromptHandoffStatusPresentation {
  label: string;
  tone: 'info' | 'accent' | 'success' | 'warning' | 'danger';
  pending: boolean;
  title: string;
}

export type HistoryPromptHandoffAgentStatus =
  | 'active'
  | 'busy'
  | 'inactive'
  | 'starting'
  | 'stopping'
  | 'unknown';

export interface HistoryPromptHandoffChip {
  id?: string;
  kind: 'prompt';
  label?: string;
  text: string;
  sourceKey?: string;
}

export interface HistoryPromptHandoffImageRef {
  id: number;
  path: string;
  assetId?: string;
  mediaType?: string | null;
  size?: number;
  availability?: 'available' | 'missing';
  error?: string;
}

export interface HistoryPromptHandoffAuditProof {
  auditTimestamp: string;
  actualHash: string;
  sessionId: string | null;
  entryUuid?: string;
  sourceIdentity?: string;
  recordByteOffset?: number;
  actualLen?: number;
  canonicalized?: boolean;
  canonicalReason?: string;
}

/**
 * Exact identity of the native Claude queue item that accepted this send.
 * Enqueue proves ownership, not yet a canonical user turn, so this remains
 * separate from `auditProof` until the queue item is consumed.
 */
export interface HistoryPromptHandoffProviderQueueProof {
  sourceIdentity: string;
  sessionId: string | null;
  entryUuid?: string;
  recordByteOffset?: number;
}

export interface HistoryPromptHandoff {
  tabId: string;
  handoffId: string;
  sendAttemptId: string | null;
  sendOperationKey: string | null;
  toolType: HistoryPromptHandoffTool;
  sessionIdHint: string | null;
  text: string;
  promptChips: readonly Readonly<HistoryPromptHandoffChip>[];
  imagePaths: readonly Readonly<HistoryPromptHandoffImageRef>[];
  submittedAt: number;
  source: string;
  statusAtSend: HistoryPromptHandoffAgentStatus;
  queueStatus: HistoryPromptHandoffStatus;
  statusReason: string;
  statusChangedAt: number;
  requiresAuditIdentity: boolean;
  auditProof: Readonly<HistoryPromptHandoffAuditProof> | null;
  providerQueueProof: Readonly<HistoryPromptHandoffProviderQueueProof> | null;
}

export interface BeginHistoryPromptHandoffInput {
  tabId: string;
  handoffId: string;
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
  toolType: HistoryPromptHandoffTool;
  sessionIdHint?: string | null;
  text: string;
  promptChips?: readonly HistoryPromptHandoffChip[];
  imagePaths?: readonly HistoryPromptHandoffImageRef[];
  submittedAt?: number;
  source?: string;
  statusAtSend?: HistoryPromptHandoffAgentStatus;
  initialStatus?: Extract<HistoryPromptHandoffStatus, 'preparing' | 'sending' | 'queued'>;
  requiresAuditIdentity?: boolean;
  initialProviderQueueProof?: HistoryPromptHandoffProviderQueueProof | null;
  /** Durable remount only: seed the first observable snapshot at its receipt state. */
  initialReceipt?: SettleHistoryPromptHandoffInput;
}

export interface SettleHistoryPromptHandoffInput {
  queueStatus: SettledHistoryPromptHandoffStatus;
  reason: string;
  proof?: HistoryPromptHandoffAuditProof | null;
  requiresAuditIdentity?: boolean;
  changedAt?: number;
}

export interface BindHistoryPromptHandoffSendIdentityInput {
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
}

export interface AcceptHistoryPromptHandoffProviderQueueInput
  extends BindHistoryPromptHandoffSendIdentityInput {
  changedAt?: number;
  proof?: HistoryPromptHandoffProviderQueueProof | null;
}

export interface DurableHistorySendReceiptRecord {
  operationKey?: string | null;
  surface?: string | null;
  tabId?: string | null;
  handoffId?: string | null;
  provider?: string | null;
  sessionId?: string | null;
  state?: string | null;
  attemptId?: string | null;
  receipt?: Record<string, any> | null;
  auditIdentity?: {
    attemptId?: string | null;
    provider?: string | null;
    sessionId?: string | null;
    promptHash?: string | null;
    entryUuid?: string | null;
    sourceIdentity?: string | null;
    auditTimestamp?: string | null;
  } | null;
  presentation?: {
    attemptId?: string | null;
    surface?: string | null;
    provider?: string | null;
    sessionId?: string | null;
    entryUuid?: string | null;
    sourceIdentity?: string | null;
    acknowledgedAt?: number | null;
  } | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface DurableHistoryCanonicalPromptEntry {
  uuid?: string | null;
  sessionId?: string | null;
  sourceIdentity?: string | null;
  sourceIdentityAliases?: string[] | null;
  semanticTags?: Array<{
    kind?: string | null;
    runId?: string | null;
    phase?: string | null;
  }> | null;
}

export interface DurableHistorySendHydrationResult {
  hydrated: boolean;
  reason: string;
  restorableDraft?: string;
  handoff?: Readonly<HistoryPromptHandoff>;
}

export type BindHistoryPromptHandoffSendIdentityResult =
  | {
      ok: true;
      changed: boolean;
      handoff: Readonly<HistoryPromptHandoff>;
    }
  | {
      ok: false;
      reason:
        | 'handoff-not-found'
        | 'send-attempt-id-conflict'
        | 'send-operation-key-conflict'
        | 'bounds';
    };

/**
 * Receipt-shaped fields stored on History's renderer-local prompt rows.
 *
 * The durable transcript row is deliberately not part of this contract. This
 * projection is reconciled only by the exact app-owned handoff id; text and
 * timestamps are presentation data, never identity fallbacks.
 */
export interface HistoryPromptHandoffProjectionRow {
  handoffId?: string | null;
  queueStatus?: HistoryPromptHandoffStatus;
  statusReason?: string;
  statusChangedAt?: number;
  statusAtSend?: HistoryPromptHandoffAgentStatus;
  timestamp?: string;
  optimisticAt?: number;
  requiresAuditIdentity?: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditSessionId?: string;
  auditEntryUuid?: string;
  sourceIdentity?: string;
  recordByteOffset?: number;
  sessionId?: string;
}

export interface HistoryPromptHandoffProjectionTombstone {
  handoffId: string;
  state: 'consumed' | 'retracted';
}

export interface HistoryPromptHandoffReconcileLimits {
  maxRows: number;
  maxHandoffs: number;
  maxTombstones: number;
}

export interface ReconcileHistoryPromptHandoffRowsInput<
  TRow extends HistoryPromptHandoffProjectionRow,
> {
  rows: readonly TRow[];
  handoffs: readonly Readonly<HistoryPromptHandoff>[];
  tombstones?: readonly Readonly<HistoryPromptHandoffProjectionTombstone>[];
  createRow: (handoff: Readonly<HistoryPromptHandoff>) => TRow | null | undefined;
  limits?: Partial<HistoryPromptHandoffReconcileLimits>;
}

export interface ReconcileHistoryPromptHandoffRowsResult<
  TRow extends HistoryPromptHandoffProjectionRow,
> {
  rows: readonly TRow[];
  changed: boolean;
  added: number;
  updated: number;
  removed: number;
  /** At least one input or addition exceeded the caller-visible hard bound. */
  truncated: boolean;
}

export interface RunHistoryPromptHandoffInput
  extends Omit<BeginHistoryPromptHandoffInput, 'handoffId'> {
  handoffId?: string;
  send: (handoffId: string) => Promise<any>;
}

export type HistoryPromptHandoffChange =
  | { type: 'replay' }
  | { type: 'begin'; handoffId: string }
  | { type: 'transport-phase'; handoffId: string }
  | { type: 'provider-queue-accepted'; handoffId: string }
  | { type: 'bind-send-identity'; handoffId: string }
  | { type: 'settle'; handoffId: string }
  | { type: 'retract'; handoffId: string; reason: string }
  | { type: 'consume'; handoffId: string }
  | { type: 'evict'; handoffId: string; reason: 'bounds' };

export type HistoryPromptHandoffListener = (
  snapshot: readonly Readonly<HistoryPromptHandoff>[],
  change: HistoryPromptHandoffChange,
) => void;

export interface HistoryPromptHandoffStoreLimits {
  maxTabs: number;
  maxHandoffs: number;
  maxBytes: number;
}

export interface HistoryPromptHandoffStoreStats {
  tabs: number;
  handoffs: number;
  approxBytes: number;
}

export type HistoryPromptHandoffTransportPhase = 'sending' | 'queued' | 'confirming';

export function historyPromptHandoffInitialStatus(
  statusAtSend: HistoryPromptHandoffAgentStatus | null | undefined,
): Extract<HistoryPromptHandoffStatus, 'preparing' | 'sending' | 'queued'> {
  if (statusAtSend === 'inactive' || statusAtSend === 'starting') return 'preparing';
  if (statusAtSend === 'busy') return 'queued';
  return 'sending';
}

export function selectLatestHistoryPromptInputStatus(
  handoffs: readonly Pick<HistoryPromptHandoff, 'submittedAt' | 'statusChangedAt' | 'queueStatus'>[],
): HistoryPromptHandoffStatus | null {
  let latest: Pick<HistoryPromptHandoff, 'submittedAt' | 'statusChangedAt' | 'queueStatus'> | null = null;
  for (const handoff of handoffs) {
    if (
      handoff.queueStatus !== 'preparing'
      && handoff.queueStatus !== 'sending'
      && handoff.queueStatus !== 'queued'
      && handoff.queueStatus !== 'audit-pending'
    ) continue;
    if (!latest
      || handoff.submittedAt > latest.submittedAt
      || (handoff.submittedAt === latest.submittedAt
        && handoff.statusChangedAt > latest.statusChangedAt)) {
      latest = handoff;
    }
  }
  return latest?.queueStatus || null;
}

export function historyPromptHandoffAcceptsAuditIdentity(
  handoff: Pick<HistoryPromptHandoff, 'sendAttemptId' | 'sendOperationKey'> | null | undefined,
  audit: { sendAttemptId?: unknown; sendOperationKey?: unknown } | null | undefined,
): boolean {
  if (!handoff) return false;
  if (handoff.sendAttemptId
    && handoff.sendAttemptId !== String(audit?.sendAttemptId || '')) {
    return false;
  }
  if (handoff.sendOperationKey
    && handoff.sendOperationKey !== String(audit?.sendOperationKey || '')) {
    return false;
  }
  return true;
}

/** Exact provider evidence that Claude moved this queue item back to its TUI composer. */
export function historyPromptAuditIsProviderQueueReturn(
  audit: Record<string, unknown> | null | undefined,
): boolean {
  return audit?.success === false
    && audit?.cancelled === true
    && audit?.semanticStatus === 'not-submitted'
    && audit?.providerAccepted === false
    && audit?.providerTurnCreated === false
    && audit?.providerQueueReturned === true
    && audit?.providerQueueOperation === 'popAll'
    && audit?.composerDraftState === 'exact-provider-queue-return'
    && audit?.draftPreserved === true
    && typeof audit?.sourceIdentity === 'string'
    && audit.sourceIdentity.startsWith('claude-queue:');
}

export const DEFAULT_HISTORY_PROMPT_HANDOFF_LIMITS:
  Readonly<HistoryPromptHandoffStoreLimits> = Object.freeze({
    maxTabs: 16,
    maxHandoffs: 128,
    maxBytes: 8 * 1024 * 1024,
  });

export const DEFAULT_HISTORY_PROMPT_HANDOFF_RECONCILE_LIMITS:
  Readonly<HistoryPromptHandoffReconcileLimits> = Object.freeze({
    // Matches HistoryVolatileOverlayCache's global item bound. Reconciliation
    // must stay a small UI projection, never become a transcript walk.
    maxRows: 512,
    maxHandoffs: DEFAULT_HISTORY_PROMPT_HANDOFF_LIMITS.maxHandoffs,
    maxTombstones: DEFAULT_HISTORY_PROMPT_HANDOFF_LIMITS.maxHandoffs,
  });

export const HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS = 15_000;

const RECORD_OVERHEAD_BYTES = 256;

interface StoredHandoff {
  value: Readonly<HistoryPromptHandoff>;
  approxBytes: number;
}

const stringBytes = (value: unknown) => String(value ?? '').length * 2;

function estimateHandoffBytes(value: HistoryPromptHandoff): number {
  let bytes = RECORD_OVERHEAD_BYTES
    + stringBytes(value.tabId)
    + stringBytes(value.handoffId)
    + stringBytes(value.sendAttemptId)
    + stringBytes(value.sendOperationKey)
    + stringBytes(value.toolType)
    + stringBytes(value.sessionIdHint)
    + stringBytes(value.text)
    + stringBytes(value.source)
    + stringBytes(value.statusAtSend)
    + stringBytes(value.queueStatus)
    + stringBytes(value.statusReason)
    + stringBytes(value.providerQueueProof?.sourceIdentity)
    + stringBytes(value.providerQueueProof?.sessionId)
    + stringBytes(value.providerQueueProof?.entryUuid)
    + stringBytes(value.providerQueueProof?.recordByteOffset);
  for (const chip of value.promptChips) {
    bytes += RECORD_OVERHEAD_BYTES
      + stringBytes(chip.id)
      + stringBytes(chip.kind)
      + stringBytes(chip.label)
      + stringBytes(chip.text)
      + stringBytes(chip.sourceKey);
  }
  for (const ref of value.imagePaths) {
    bytes += RECORD_OVERHEAD_BYTES
      + stringBytes(ref.id)
      + stringBytes(ref.path)
      + stringBytes(ref.assetId)
      + stringBytes(ref.mediaType)
      + stringBytes(ref.size)
      + stringBytes(ref.availability)
      + stringBytes(ref.error);
  }
  if (value.auditProof) {
    bytes += RECORD_OVERHEAD_BYTES
      + stringBytes(value.auditProof.auditTimestamp)
      + stringBytes(value.auditProof.actualHash)
      + stringBytes(value.auditProof.sessionId)
      + stringBytes(value.auditProof.entryUuid)
      + stringBytes(value.auditProof.sourceIdentity)
      + stringBytes(value.auditProof.recordByteOffset)
      + stringBytes(value.auditProof.canonicalReason);
  }
  return bytes;
}

function requireKey(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`);
  return normalized;
}

function finiteTimestamp(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function freezeChip(chip: HistoryPromptHandoffChip): Readonly<HistoryPromptHandoffChip> {
  return Object.freeze({
    ...(typeof chip.id === 'string' ? { id: chip.id } : {}),
    kind: 'prompt' as const,
    ...(typeof chip.label === 'string' ? { label: chip.label } : {}),
    text: String(chip.text || ''),
    ...(typeof chip.sourceKey === 'string' ? { sourceKey: chip.sourceKey } : {}),
  });
}

function freezeImageRef(
  ref: HistoryPromptHandoffImageRef,
): Readonly<HistoryPromptHandoffImageRef> {
  return Object.freeze({
    id: Number(ref.id),
    path: String(ref.path || ''),
    ...(typeof ref.assetId === 'string' ? { assetId: ref.assetId } : {}),
    ...(typeof ref.mediaType === 'string' || ref.mediaType === null
      ? { mediaType: ref.mediaType }
      : {}),
    ...(Number.isFinite(ref.size) ? { size: Number(ref.size) } : {}),
    ...(ref.availability === 'available' || ref.availability === 'missing'
      ? { availability: ref.availability }
      : {}),
    ...(typeof ref.error === 'string' ? { error: ref.error } : {}),
  });
}

function freezeProof(
  proof: HistoryPromptHandoffAuditProof | null | undefined,
): Readonly<HistoryPromptHandoffAuditProof> | null {
  if (!proof) return null;
  return Object.freeze({
    auditTimestamp: String(proof.auditTimestamp || ''),
    actualHash: String(proof.actualHash || ''),
    sessionId: typeof proof.sessionId === 'string' ? proof.sessionId : null,
    ...(typeof proof.entryUuid === 'string' && proof.entryUuid
      ? { entryUuid: proof.entryUuid }
      : {}),
    ...(typeof proof.sourceIdentity === 'string' && proof.sourceIdentity
      ? { sourceIdentity: proof.sourceIdentity }
      : {}),
    ...(Number.isSafeInteger(Number(proof.recordByteOffset))
      && Number(proof.recordByteOffset) >= 0
      ? { recordByteOffset: Number(proof.recordByteOffset) }
      : {}),
    ...(Number.isFinite(proof.actualLen) ? { actualLen: Number(proof.actualLen) } : {}),
    ...(proof.canonicalized === true ? { canonicalized: true } : {}),
    ...(typeof proof.canonicalReason === 'string'
      ? { canonicalReason: proof.canonicalReason }
      : {}),
  });
}

function freezeProviderQueueProof(
  proof: HistoryPromptHandoffProviderQueueProof | null | undefined,
): Readonly<HistoryPromptHandoffProviderQueueProof> | null {
  if (!proof) return null;
  const sourceIdentity = String(proof.sourceIdentity || '').trim();
  if (!sourceIdentity) return null;
  return Object.freeze({
    sourceIdentity,
    sessionId: typeof proof.sessionId === 'string' ? proof.sessionId : null,
    ...(typeof proof.entryUuid === 'string' && proof.entryUuid
      ? { entryUuid: proof.entryUuid }
      : {}),
    ...(Number.isSafeInteger(Number(proof.recordByteOffset))
      && Number(proof.recordByteOffset) >= 0
      ? { recordByteOffset: Number(proof.recordByteOffset) }
      : {}),
  });
}

function mergeCompatibleProviderQueueProof(
  current: Readonly<HistoryPromptHandoffProviderQueueProof> | null,
  incoming: HistoryPromptHandoffProviderQueueProof | null | undefined,
): Readonly<HistoryPromptHandoffProviderQueueProof> | null {
  if (!incoming) return current;
  const frozenIncoming = freezeProviderQueueProof(incoming);
  if (!frozenIncoming) return current;
  if (!current) return frozenIncoming;
  const conflicts = current.sourceIdentity !== frozenIncoming.sourceIdentity
    || (!!current.sessionId
      && !!frozenIncoming.sessionId
      && current.sessionId !== frozenIncoming.sessionId)
    || (!!current.entryUuid
      && !!frozenIncoming.entryUuid
      && current.entryUuid !== frozenIncoming.entryUuid)
    || (current.recordByteOffset !== undefined
      && frozenIncoming.recordByteOffset !== undefined
      && current.recordByteOffset !== frozenIncoming.recordByteOffset);
  if (conflicts) return current;
  if (
    current.sessionId === (current.sessionId || frozenIncoming.sessionId)
    && current.entryUuid === (current.entryUuid || frozenIncoming.entryUuid)
    && current.recordByteOffset === (
      current.recordByteOffset ?? frozenIncoming.recordByteOffset
    )
  ) {
    return current;
  }
  return freezeProviderQueueProof({
    sourceIdentity: current.sourceIdentity,
    sessionId: current.sessionId || frozenIncoming.sessionId,
    entryUuid: current.entryUuid || frozenIncoming.entryUuid,
    recordByteOffset: current.recordByteOffset ?? frozenIncoming.recordByteOffset,
  });
}

function mergeCompatibleAuditProof(
  current: Readonly<HistoryPromptHandoffAuditProof> | null,
  incoming: HistoryPromptHandoffAuditProof | null | undefined,
): Readonly<HistoryPromptHandoffAuditProof> | null {
  if (!incoming) return current;
  const frozenIncoming = freezeProof(incoming);
  if (!current) return frozenIncoming;
  if (!frozenIncoming) return current;

  // The first exact receipt owns this attempt. A later observation may fill
  // optional metadata, but a different writer/hash/entry can only belong to a
  // different attempt and must not rewrite the established identity here.
  const conflicts = current.actualHash !== frozenIncoming.actualHash
    || (!!current.entryUuid
      && !!frozenIncoming.entryUuid
      && current.entryUuid !== frozenIncoming.entryUuid)
    || (!!current.sessionId
      && !!frozenIncoming.sessionId
      && current.sessionId !== frozenIncoming.sessionId)
    || (!!current.sourceIdentity
      && !!frozenIncoming.sourceIdentity
      && current.sourceIdentity !== frozenIncoming.sourceIdentity)
    || (current.recordByteOffset !== undefined
      && frozenIncoming.recordByteOffset !== undefined
      && current.recordByteOffset !== frozenIncoming.recordByteOffset);
  if (conflicts) return current;

  return freezeProof({
    auditTimestamp: current.auditTimestamp,
    actualHash: current.actualHash,
    sessionId: current.sessionId || frozenIncoming.sessionId,
    entryUuid: current.entryUuid || frozenIncoming.entryUuid,
    sourceIdentity: current.sourceIdentity || frozenIncoming.sourceIdentity,
    recordByteOffset: current.recordByteOffset ?? frozenIncoming.recordByteOffset,
    actualLen: current.actualLen ?? frozenIncoming.actualLen,
    canonicalized: current.canonicalized === true || frozenIncoming.canonicalized === true,
    canonicalReason: current.canonicalReason || frozenIncoming.canonicalReason,
  });
}

function freezeHandoff(value: HistoryPromptHandoff): Readonly<HistoryPromptHandoff> {
  return Object.freeze({
    ...value,
    promptChips: Object.freeze(value.promptChips.map(freezeChip)),
    imagePaths: Object.freeze(value.imagePaths.map(freezeImageRef)),
    auditProof: freezeProof(value.auditProof),
    providerQueueProof: freezeProviderQueueProof(value.providerQueueProof),
  });
}

const reconcileLimit = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
};

const submittedTimestamp = (
  submittedAt: number,
  fallback: string | undefined,
): string | undefined => {
  if (!Number.isFinite(submittedAt)) return fallback;
  const date = new Date(submittedAt);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

function projectHandoffReceiptOntoRow<TRow extends HistoryPromptHandoffProjectionRow>(
  row: TRow,
  handoff: Readonly<HistoryPromptHandoff>,
): TRow {
  const proof = handoff.auditProof;
  const queueProof = handoff.providerQueueProof;
  const timestamp = submittedTimestamp(handoff.submittedAt, row.timestamp);
  const auditSessionId = proof?.sessionId || undefined;
  const sessionId = auditSessionId || queueProof?.sessionId || row.sessionId;
  const auditTimestamp = proof?.auditTimestamp || undefined;
  const auditHash = proof?.actualHash || undefined;
  const auditEntryUuid = proof?.entryUuid || undefined;
  const sourceIdentity = proof?.sourceIdentity || queueProof?.sourceIdentity || undefined;
  const recordByteOffset = proof?.recordByteOffset ?? queueProof?.recordByteOffset;

  if (
    row.handoffId === handoff.handoffId
    && row.queueStatus === handoff.queueStatus
    && row.statusReason === handoff.statusReason
    && row.statusChangedAt === handoff.statusChangedAt
    && row.statusAtSend === handoff.statusAtSend
    && row.timestamp === timestamp
    && row.optimisticAt === handoff.submittedAt
    && row.requiresAuditIdentity === handoff.requiresAuditIdentity
    && row.auditTimestamp === auditTimestamp
    && row.auditHash === auditHash
    && row.auditSessionId === auditSessionId
    && row.auditEntryUuid === auditEntryUuid
    && row.sourceIdentity === sourceIdentity
    && row.recordByteOffset === recordByteOffset
    && row.sessionId === sessionId
  ) {
    return row;
  }

  return {
    ...row,
    handoffId: handoff.handoffId,
    queueStatus: handoff.queueStatus,
    statusReason: handoff.statusReason,
    statusChangedAt: handoff.statusChangedAt,
    statusAtSend: handoff.statusAtSend,
    timestamp,
    optimisticAt: handoff.submittedAt,
    requiresAuditIdentity: handoff.requiresAuditIdentity,
    auditTimestamp,
    auditHash,
    auditSessionId,
    auditEntryUuid,
    sourceIdentity,
    recordByteOffset,
    sessionId,
  } as TRow;
}

/**
 * Reconciles only the bounded renderer-local prompt projection.
 *
 * Snapshot absence is not a deletion proof: a handoff may have been evicted
 * from the bounded store while its local SENT row is still the only honest UI
 * state. Removal therefore requires an explicit consumed/retracted tombstone.
 * Durable adoption stays owned by History's transcript merge and is never
 * inferred here from equal text or nearby timestamps.
 */
export function reconcileHistoryPromptHandoffRows<
  TRow extends HistoryPromptHandoffProjectionRow,
>(
  input: ReconcileHistoryPromptHandoffRowsInput<TRow>,
): ReconcileHistoryPromptHandoffRowsResult<TRow> {
  const limits: HistoryPromptHandoffReconcileLimits = {
    maxRows: reconcileLimit(
      input.limits?.maxRows,
      DEFAULT_HISTORY_PROMPT_HANDOFF_RECONCILE_LIMITS.maxRows,
      'maxRows',
    ),
    maxHandoffs: reconcileLimit(
      input.limits?.maxHandoffs,
      DEFAULT_HISTORY_PROMPT_HANDOFF_RECONCILE_LIMITS.maxHandoffs,
      'maxHandoffs',
    ),
    maxTombstones: reconcileLimit(
      input.limits?.maxTombstones,
      DEFAULT_HISTORY_PROMPT_HANDOFF_RECONCILE_LIMITS.maxTombstones,
      'maxTombstones',
    ),
  };

  // The overlay cache is already bounded. If a caller accidentally passes a
  // transcript-sized array, preserve it untouched instead of doing an
  // unbounded walk or dropping rows without proof.
  if (input.rows.length > limits.maxRows) {
    return {
      rows: input.rows,
      changed: false,
      added: 0,
      updated: 0,
      removed: 0,
      truncated: true,
    };
  }

  let truncated = input.handoffs.length > limits.maxHandoffs
    || (input.tombstones?.length || 0) > limits.maxTombstones;
  const tombstoneIds = new Set<string>();
  for (
    let index = 0;
    index < Math.min(input.tombstones?.length || 0, limits.maxTombstones);
    index += 1
  ) {
    const tombstone = input.tombstones?.[index];
    if (!tombstone || typeof tombstone.handoffId !== 'string' || !tombstone.handoffId) continue;
    if (tombstone.state !== 'consumed' && tombstone.state !== 'retracted') continue;
    tombstoneIds.add(tombstone.handoffId);
  }

  const handoffsById = new Map<string, Readonly<HistoryPromptHandoff>>();
  for (
    let index = 0;
    index < Math.min(input.handoffs.length, limits.maxHandoffs);
    index += 1
  ) {
    const handoff = input.handoffs[index];
    if (!handoff || typeof handoff.handoffId !== 'string' || !handoff.handoffId) continue;
    if (tombstoneIds.has(handoff.handoffId)) continue;
    handoffsById.set(handoff.handoffId, handoff);
  }

  const seenHandoffIds = new Set<string>();
  const nextRows: TRow[] = [];
  let updated = 0;
  let removed = 0;
  for (const row of input.rows) {
    const handoffId = typeof row.handoffId === 'string' ? row.handoffId : '';
    if (handoffId && tombstoneIds.has(handoffId)) {
      removed += 1;
      continue;
    }
    if (!handoffId) {
      nextRows.push(row);
      continue;
    }

    seenHandoffIds.add(handoffId);
    const handoff = handoffsById.get(handoffId);
    if (!handoff) {
      // No active record and no tombstone is uncertainty, not consumption.
      nextRows.push(row);
      continue;
    }
    const projected = projectHandoffReceiptOntoRow(row, handoff);
    if (projected !== row) updated += 1;
    nextRows.push(projected);
  }

  let added = 0;
  for (const [handoffId, handoff] of handoffsById) {
    if (seenHandoffIds.has(handoffId)) continue;
    if (nextRows.length >= limits.maxRows) {
      truncated = true;
      continue;
    }
    const created = input.createRow(handoff);
    if (!created) continue;
    nextRows.push(projectHandoffReceiptOntoRow(created, handoff));
    seenHandoffIds.add(handoffId);
    added += 1;
  }

  const changed = added > 0 || updated > 0 || removed > 0;
  return {
    rows: changed ? nextRows : input.rows,
    changed,
    added,
    updated,
    removed,
    truncated,
  };
}

/**
 * Renderer-local ownership bridge for prompts that have crossed from an
 * external sender (Run After, API, dictation) into a tab's PTY but have not
 * necessarily appeared in its durable transcript yet.
 *
 * Data and subscribers are deliberately separate. Evicting an old payload
 * never silently unsubscribes a mounted History surface, and a background
 * begin remains replayable when that surface mounts later.
 */
export class HistoryPromptHandoffStore {
  private readonly limits: Readonly<HistoryPromptHandoffStoreLimits>;
  private readonly tabs = new Map<string, Map<string, StoredHandoff>>();
  private readonly listeners = new Map<string, Set<HistoryPromptHandoffListener>>();
  private handoffs = 0;
  private approxBytes = 0;

  constructor(
    limits: HistoryPromptHandoffStoreLimits = DEFAULT_HISTORY_PROMPT_HANDOFF_LIMITS,
  ) {
    if (!Number.isSafeInteger(limits.maxTabs) || limits.maxTabs <= 0) {
      throw new RangeError('maxTabs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limits.maxHandoffs) || limits.maxHandoffs <= 0) {
      throw new RangeError('maxHandoffs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.limits = Object.freeze({ ...limits });
  }

  begin(input: BeginHistoryPromptHandoffInput): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(input.tabId, 'tabId');
    const handoffId = requireKey(input.handoffId, 'handoffId');
    const existing = this.tabs.get(tabId)?.get(handoffId);
    if (existing) {
      this.promoteTab(tabId);
      const nextAttemptId = typeof input.sendAttemptId === 'string'
        ? input.sendAttemptId.trim()
        : '';
      const currentAttemptId = existing.value.sendAttemptId || '';
      // Permission to retry belongs to the scenario/transport layer. If it did
      // start a genuinely new physical attempt, the History projection must
      // follow that exact attempt even when the previous receipt was already
      // terminal. A duplicate begin without a fresh attempt id stays
      // idempotent and can never clear an exact receipt.
      if (nextAttemptId && nextAttemptId !== currentAttemptId) {
        const submittedAt = finiteTimestamp(input.submittedAt, Date.now());
        const initialReceipt = input.initialReceipt;
        const initialStatus = initialReceipt?.queueStatus || input.initialStatus || 'sending';
        const next = freezeHandoff({
          ...existing.value,
          sendAttemptId: nextAttemptId,
          sendOperationKey: typeof input.sendOperationKey === 'string'
            ? input.sendOperationKey.trim() || null
            : existing.value.sendOperationKey,
          sessionIdHint: typeof input.sessionIdHint === 'string'
            ? input.sessionIdHint
            : existing.value.sessionIdHint,
          submittedAt,
          source: typeof input.source === 'string' ? input.source : existing.value.source,
          statusAtSend: input.statusAtSend || existing.value.statusAtSend,
          queueStatus: initialStatus,
          statusReason: initialReceipt?.reason
            || (initialStatus === 'preparing' ? 'send-retry-preparing' : 'send-retry-start'),
          statusChangedAt: initialReceipt
            ? Math.max(submittedAt, finiteTimestamp(initialReceipt.changedAt, submittedAt))
            : submittedAt,
          requiresAuditIdentity: existing.value.requiresAuditIdentity
            || input.requiresAuditIdentity === true,
          auditProof: freezeProof(initialReceipt?.proof),
          providerQueueProof: freezeProviderQueueProof(input.initialProviderQueueProof),
        });
        const nextBytes = estimateHandoffBytes(next);
        this.approxBytes += nextBytes - existing.approxBytes;
        this.tabs.get(tabId)?.set(handoffId, { value: next, approxBytes: nextBytes });
        this.notify(tabId, { type: 'begin', handoffId });
        return next;
      }
      if (input.initialReceipt) {
        this.bindSendIdentity(tabId, handoffId, {
          sendAttemptId: input.sendAttemptId,
          sendOperationKey: input.sendOperationKey,
        });
        return this.settle(tabId, handoffId, input.initialReceipt);
      }
      return existing.value;
    }

    const now = Date.now();
    const submittedAt = finiteTimestamp(input.submittedAt, now);
    const initialReceipt = input.initialReceipt;
    const initialStatus = initialReceipt?.queueStatus || input.initialStatus || 'sending';
    const value = freezeHandoff({
      tabId,
      handoffId,
      sendAttemptId: typeof input.sendAttemptId === 'string'
        ? input.sendAttemptId.trim() || null
        : null,
      sendOperationKey: typeof input.sendOperationKey === 'string'
        ? input.sendOperationKey.trim() || null
        : null,
      toolType: input.toolType,
      sessionIdHint: typeof input.sessionIdHint === 'string' ? input.sessionIdHint : null,
      text: String(input.text || ''),
      promptChips: input.promptChips || [],
      imagePaths: input.imagePaths || [],
      submittedAt,
      source: typeof input.source === 'string' ? input.source : '',
      statusAtSend: input.statusAtSend || 'unknown',
      queueStatus: initialStatus,
      statusReason: initialReceipt?.reason
        || (initialStatus === 'preparing'
          ? 'send-preparing'
          : initialStatus === 'queued'
            ? 'send-queued'
            : 'send-start'),
      statusChangedAt: initialReceipt
        ? Math.max(submittedAt, finiteTimestamp(initialReceipt.changedAt, submittedAt))
        : submittedAt,
      requiresAuditIdentity: input.requiresAuditIdentity !== false,
      auditProof: freezeProof(initialReceipt?.proof),
      providerQueueProof: freezeProviderQueueProof(input.initialProviderQueueProof),
    });
    const approxBytes = estimateHandoffBytes(value);
    if (approxBytes > this.limits.maxBytes) return undefined;

    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = new Map();
      this.tabs.set(tabId, tab);
    } else {
      this.promoteTab(tabId);
      tab = this.tabs.get(tabId)!;
    }
    tab.set(handoffId, { value, approxBytes });
    this.handoffs += 1;
    this.approxBytes += approxBytes;
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return undefined;
    this.notify(tabId, { type: 'begin', handoffId });
    return value;
  }

  advanceTransportPhase(
    tabIdValue: string,
    handoffIdValue: string,
    phase: HistoryPromptHandoffTransportPhase,
  ): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current) return undefined;

    if (
      current.value.queueStatus === 'cancelled'
      || current.value.queueStatus === 'failed'
    ) {
      // These are terminal outcomes of the exact attempt. A caller that was
      // already awaiting the audit may return afterwards with its older
      // audit-pending/timeout snapshot; it cannot resurrect the operation.
      // Only begin() with a genuinely new attempt is a reset boundary.
      return current.value;
    }

    let queueStatus: HistoryPromptHandoffStatus | null = null;
    if (phase === 'queued') {
      if (current.value.queueStatus === 'preparing' || current.value.queueStatus === 'sending') {
        queueStatus = 'queued';
      }
    } else if (phase === 'sending') {
      if (current.value.queueStatus === 'preparing' || current.value.queueStatus === 'queued') {
        queueStatus = 'sending';
      }
    } else if (phase === 'confirming') {
      if (
        current.value.queueStatus === 'preparing'
        || current.value.queueStatus === 'sending'
        || current.value.queueStatus === 'queued'
      ) {
        queueStatus = 'audit-pending';
      }
    }
    if (!queueStatus) return current.value;

    const next = freezeHandoff({
      ...current.value,
      queueStatus,
      statusReason: phase === 'confirming'
        ? 'send-enter-written-confirming'
        : phase === 'queued'
          ? 'send-ready-queued'
          : 'send-ready-pasting',
      statusChangedAt: Math.max(current.value.statusChangedAt, Date.now()),
    });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return undefined;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.promoteTab(tabId);
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return undefined;
    this.notify(tabId, { type: 'transport-phase', handoffId });
    return next;
  }

  acceptProviderQueue(
    tabIdValue: string,
    handoffIdValue: string,
    input: AcceptHistoryPromptHandoffProviderQueueInput = {},
  ): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current) return undefined;
    if (!historyPromptHandoffAcceptsAuditIdentity(current.value, input)) {
      return current.value;
    }
    if (
      current.value.queueStatus === 'sent'
      || current.value.queueStatus === 'cancelled'
      || current.value.queueStatus === 'failed'
    ) {
      return current.value;
    }

    const statusChangedAt = Math.max(
      current.value.statusChangedAt,
      finiteTimestamp(input.changedAt, Date.now()),
    );
    const providerQueueProof = mergeCompatibleProviderQueueProof(
      current.value.providerQueueProof,
      input.proof,
    );
    if (
      current.value.queueStatus === 'queued'
      && current.value.statusReason === 'provider-queue-accepted'
      && current.value.statusChangedAt === statusChangedAt
      && current.value.providerQueueProof === providerQueueProof
    ) {
      return current.value;
    }
    const next = freezeHandoff({
      ...current.value,
      queueStatus: 'queued',
      statusReason: 'provider-queue-accepted',
      statusChangedAt,
      providerQueueProof,
    });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return undefined;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.promoteTab(tabId);
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return undefined;
    this.notify(tabId, { type: 'provider-queue-accepted', handoffId });
    return next;
  }

  bindSendIdentity(
    tabIdValue: string,
    handoffIdValue: string,
    input: BindHistoryPromptHandoffSendIdentityInput,
  ): BindHistoryPromptHandoffSendIdentityResult {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current) return { ok: false, reason: 'handoff-not-found' };

    const incomingAttemptId = typeof input.sendAttemptId === 'string'
      ? input.sendAttemptId.trim() || null
      : null;
    const incomingOperationKey = typeof input.sendOperationKey === 'string'
      ? input.sendOperationKey.trim() || null
      : null;
    if (
      current.value.sendAttemptId
      && incomingAttemptId
      && current.value.sendAttemptId !== incomingAttemptId
    ) {
      return { ok: false, reason: 'send-attempt-id-conflict' };
    }
    if (
      current.value.sendOperationKey
      && incomingOperationKey
      && current.value.sendOperationKey !== incomingOperationKey
    ) {
      return { ok: false, reason: 'send-operation-key-conflict' };
    }

    const sendAttemptId = current.value.sendAttemptId || incomingAttemptId;
    const sendOperationKey = current.value.sendOperationKey || incomingOperationKey;
    if (
      sendAttemptId === current.value.sendAttemptId
      && sendOperationKey === current.value.sendOperationKey
    ) {
      this.promoteTab(tabId);
      return { ok: true, changed: false, handoff: current.value };
    }

    // Binding is atomic and intentionally receipt-neutral: it cannot alter a
    // row's status, timestamps, or proof. That makes a main-side auto receipt
    // safe to attach after send-result without reopening the send attempt.
    const next = freezeHandoff({
      ...current.value,
      sendAttemptId,
      sendOperationKey,
    });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return { ok: false, reason: 'bounds' };
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.promoteTab(tabId);
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return { ok: false, reason: 'bounds' };
    this.notify(tabId, { type: 'bind-send-identity', handoffId });
    return { ok: true, changed: true, handoff: next };
  }

  settle(
    tabIdValue: string,
    handoffIdValue: string,
    input: SettleHistoryPromptHandoffInput,
  ): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current) return undefined;

    if (
      current.value.queueStatus === 'cancelled'
      || current.value.queueStatus === 'failed'
    ) {
      // Final provider refusal/cancellation belongs to this exact attempt.
      // A promise that began before it may resolve later with an older timeout
      // snapshot, but only begin() with a new attempt may reopen the handoff.
      return current.value;
    }

    const nextProof = mergeCompatibleAuditProof(current.value.auditProof, input.proof);
    const currentHasExactReceipt = current.value.queueStatus === 'sent'
      && current.value.auditProof !== null;
    const incomingKeepsExactReceipt = input.queueStatus === 'sent'
      && nextProof !== null;
    if (currentHasExactReceipt && !incomingKeepsExactReceipt) {
      // Same-attempt timeout/failure callbacks can arrive after the exact
      // audit. They are weaker observations, not permission to resurrect
      // CONFIRMING or erase the writer UUID. A new begin with a fresh attempt
      // id is the only reset boundary.
      return current.value;
    }
    const currentHasProviderQueueReceipt = current.value.queueStatus === 'queued'
      && current.value.statusReason === 'provider-queue-accepted';
    if (
      currentHasProviderQueueReceipt
      && (input.queueStatus === 'audit-pending' || input.queueStatus === 'delivery-unknown')
    ) {
      // Claude's exact queue-operation is stronger than the caller timeout
      // that follows it. The timeout still leaves the final transcript audit
      // pending, but it cannot turn an accepted provider queue item back into
      // CONFIRMING/UNCONFIRMED.
      return current.value;
    }

    const statusChangedAt = Math.max(
      current.value.statusChangedAt,
      finiteTimestamp(input.changedAt, Date.now()),
    );

    const next = freezeHandoff({
      ...current.value,
      queueStatus: input.queueStatus,
      statusReason: String(input.reason || ''),
      statusChangedAt,
      // Exact identity is monotonic. Once a sender declares that a local row
      // needs audit proof, a timeout/mismatch cannot downgrade it to text/time
      // similarity and accidentally adopt an older identical prompt.
      requiresAuditIdentity: current.value.requiresAuditIdentity
        || input.requiresAuditIdentity === true,
      // Proof is monotonic inside an attempt. `null` means this particular
      // observation had no proof; it does not revoke an earlier exact one.
      auditProof: nextProof,
    });
    if (
      next.queueStatus === current.value.queueStatus
      && next.statusReason === current.value.statusReason
      && next.statusChangedAt === current.value.statusChangedAt
      && next.requiresAuditIdentity === current.value.requiresAuditIdentity
      && next.auditProof === current.value.auditProof
    ) {
      return current.value;
    }
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return undefined;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.promoteTab(tabId);
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return undefined;
    this.notify(tabId, { type: 'settle', handoffId });
    return next;
  }

  retract(tabId: string, handoffId: string, reason: string): boolean {
    return this.remove(tabId, handoffId, {
      type: 'retract',
      handoffId: requireKey(handoffId, 'handoffId'),
      reason: String(reason || ''),
    });
  }

  consume(tabId: string, handoffId: string): boolean {
    return this.remove(tabId, handoffId, {
      type: 'consume',
      handoffId: requireKey(handoffId, 'handoffId'),
    });
  }

  getSnapshot(tabIdValue: string): readonly Readonly<HistoryPromptHandoff>[] {
    const tabId = requireKey(tabIdValue, 'tabId');
    this.pruneExpiredFailures(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return Object.freeze([]);
    this.promoteTab(tabId);
    return Object.freeze(Array.from(tab.values(), record => record.value));
  }

  subscribe(
    tabIdValue: string,
    listener: HistoryPromptHandoffListener,
  ): () => void {
    const tabId = requireKey(tabIdValue, 'tabId');
    let tabListeners = this.listeners.get(tabId);
    if (!tabListeners) {
      tabListeners = new Set();
      this.listeners.set(tabId, tabListeners);
    }
    tabListeners.add(listener);
    listener(this.getSnapshot(tabId), { type: 'replay' });
    return () => {
      const current = this.listeners.get(tabId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(tabId);
    };
  }

  stats(): Readonly<HistoryPromptHandoffStoreStats> {
    return Object.freeze({
      tabs: this.tabs.size,
      handoffs: this.handoffs,
      approxBytes: this.approxBytes,
    });
  }

  private remove(
    tabIdValue: string,
    handoffIdValue: string,
    change: HistoryPromptHandoffChange,
  ): boolean {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current) return false;
    tab.delete(handoffId);
    this.handoffs -= 1;
    this.approxBytes -= current.approxBytes;
    if (tab.size === 0) this.tabs.delete(tabId);
    this.notify(tabId, change);
    return true;
  }

  private pruneExpiredFailures(tabId: string, now = Date.now()): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    for (const [handoffId, record] of Array.from(tab.entries())) {
      const status = record.value.queueStatus;
      if (status !== 'failed' && status !== 'cancelled') continue;
      if (now - record.value.statusChangedAt < HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS) continue;
      tab.delete(handoffId);
      this.handoffs -= 1;
      this.approxBytes -= record.approxBytes;
    }
    if (tab.size === 0) this.tabs.delete(tabId);
  }

  private promoteTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.tabs.set(tabId, tab);
  }

  private enforceLimits(protectedTabId: string, protectedHandoffId: string): void {
    while (this.tabs.size > this.limits.maxTabs) {
      const victimTabId = Array.from(this.tabs.keys())
        .find(tabId => tabId !== protectedTabId) || protectedTabId;
      this.evictTab(victimTabId);
    }
    while (
      this.handoffs > this.limits.maxHandoffs
      || this.approxBytes > this.limits.maxBytes
    ) {
      let victimTabId: string | undefined;
      let victimHandoffId: string | undefined;
      for (const [tabId, tab] of this.tabs) {
        for (const handoffId of tab.keys()) {
          if (tabId === protectedTabId && handoffId === protectedHandoffId) continue;
          victimTabId = tabId;
          victimHandoffId = handoffId;
          break;
        }
        if (victimTabId) break;
      }
      if (!victimTabId || !victimHandoffId) {
        victimTabId = protectedTabId;
        victimHandoffId = protectedHandoffId;
      }
      this.remove(victimTabId, victimHandoffId, {
        type: 'evict',
        handoffId: victimHandoffId,
        reason: 'bounds',
      });
    }
  }

  private evictTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const handoffIds = Array.from(tab.keys());
    for (const record of tab.values()) {
      this.handoffs -= 1;
      this.approxBytes -= record.approxBytes;
    }
    this.tabs.delete(tabId);
    for (const handoffId of handoffIds) {
      this.notify(tabId, {
        type: 'evict',
        handoffId,
        reason: 'bounds',
      });
    }
  }

  private notify(tabId: string, change: HistoryPromptHandoffChange): void {
    const tabListeners = this.listeners.get(tabId);
    if (!tabListeners || tabListeners.size === 0) return;
    const snapshot = this.getSnapshot(tabId);
    for (const listener of Array.from(tabListeners)) listener(snapshot, change);
  }
}

const historyPromptHandoffStore = new HistoryPromptHandoffStore();

const createHistoryPromptHandoffId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `external-${uuid}`
    : `external-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function historyPromptHandoffAuditProofFromSendResult(
  result: any,
): HistoryPromptHandoffAuditProof | null {
  const audit = result?.codexAudit || result?.pasteAudit || null;
  if (!audit || audit.success !== true || !audit.auditTimestamp || !audit.actualHash) {
    return null;
  }
  return {
    auditTimestamp: String(audit.auditTimestamp),
    actualHash: String(audit.actualHash),
    sessionId: typeof audit.sessionId === 'string' ? audit.sessionId : null,
    ...(typeof audit.entryUuid === 'string' && audit.entryUuid
      ? { entryUuid: audit.entryUuid }
      : {}),
    ...(typeof audit.sourceIdentity === 'string' && audit.sourceIdentity
      ? { sourceIdentity: audit.sourceIdentity }
      : {}),
    ...(Number.isSafeInteger(Number(audit.recordByteOffset))
      && Number(audit.recordByteOffset) >= 0
      ? { recordByteOffset: Number(audit.recordByteOffset) }
      : {}),
    ...(Number.isFinite(audit.actualLen) ? { actualLen: Number(audit.actualLen) } : {}),
    ...(audit.canonicalized === true ? { canonicalized: true } : {}),
    ...(typeof audit.canonicalReason === 'string'
      ? { canonicalReason: audit.canonicalReason }
      : {}),
  };
}

/**
 * Maps only an explicit transport receipt to a presentation state. This is a
 * renderer projection, not permission to send or retry the prompt.
 */
export function historyPromptHandoffUnconfirmedStatusFromSendResult(
  result: any,
): HistoryPromptHandoffUnconfirmedStatus | null {
  if (!result || typeof result !== 'object') return null;
  if (result.deliveryUnknown === true || result.status === 'delivery-unknown') {
    return 'delivery-unknown';
  }
  if (
    result.auditPending === true
    || result.userMessageAuditPending === true
    || result.status === 'audit-pending'
    || result.codexAudit?.lateReconciliationPending === true
    || result.pasteAudit?.lateReconciliationPending === true
  ) {
    return 'audit-pending';
  }
  return null;
}

export function historyPromptHandoffStatusPresentation(
  status: HistoryPromptHandoffStatus | null | undefined,
): HistoryPromptHandoffStatusPresentation | null {
  switch (status) {
    case 'preparing':
      return {
        label: 'PREPARING',
        tone: 'info',
        pending: true,
        title: 'Сообщение сохранено и ждёт готовности терминала',
      };
    case 'sending':
      return {
        label: 'SENDING',
        tone: 'info',
        pending: true,
        title: 'Сообщение отправляется',
      };
    case 'queued':
      return {
        label: 'QUEUED',
        tone: 'accent',
        pending: true,
        title: 'Сообщение ждёт завершения текущего ответа',
      };
    case 'audit-pending':
      return {
        label: 'CONFIRMING',
        tone: 'accent',
        pending: true,
        title: 'Команда отправлена; приложение ждёт точного подтверждения в истории',
      };
    case 'delivery-unknown':
      return {
        label: 'UNCONFIRMED',
        tone: 'warning',
        pending: false,
        title: 'Доставка не подтверждена. Не отправляйте текст повторно как новую команду',
      };
    case 'sent':
      return {
        label: 'SENT',
        tone: 'success',
        pending: false,
        title: 'Сообщение передано агенту и ожидает появления в сохранённой истории',
      };
    case 'cancelled':
      return {
        label: 'CANCELLED',
        tone: 'warning',
        pending: false,
        title: 'Отправка отменена до появления сообщения в сохранённой истории',
      };
    case 'failed':
      return {
        label: 'SEND FAILED',
        tone: 'danger',
        pending: false,
        title: 'Сообщение не удалось отправить',
      };
    default:
      return null;
  }
}

/**
 * Starts the renderer-owned History projection before an external transport
 * touches the PTY, then settles that exact row from the shared send result.
 */
export async function runHistoryPromptHandoff(
  input: RunHistoryPromptHandoffInput,
  store: HistoryPromptHandoffStore = historyPromptHandoffStore,
): Promise<any> {
  const handoffId = typeof input.handoffId === 'string' && input.handoffId.trim()
    ? input.handoffId.trim()
    : createHistoryPromptHandoffId();
  store.begin({
    ...input,
    handoffId,
    requiresAuditIdentity: true,
  });

  try {
    const result = await input.send(handoffId);
    const providerQueueReturned = historyPromptAuditIsProviderQueueReturn(
      result?.pasteAudit || result,
    );
    const transferred = !result
      || typeof result !== 'object'
      || result.success !== false
      || result.submitted === true;
    const unconfirmedStatus = historyPromptHandoffUnconfirmedStatusFromSendResult(result);
    const proof = historyPromptHandoffAuditProofFromSendResult(result);
    const queueStatus: SettledHistoryPromptHandoffStatus = providerQueueReturned
      ? 'cancelled'
      : !transferred
      || (result?.success === false && result?.submitted === true && !unconfirmedStatus)
      ? 'failed'
      : unconfirmedStatus
        || (result?.queued === true ? 'queued' : 'sent');
    store.settle(input.tabId, handoffId, {
      queueStatus,
      reason: !transferred
        ? 'send-refused-before-submit'
        : providerQueueReturned
          ? 'provider-queue-returned-to-terminal-composer'
        : queueStatus === 'failed'
          ? 'send-submitted-audit-failed'
          : queueStatus === 'audit-pending'
            ? 'send-submitted-audit-pending'
            : queueStatus === 'delivery-unknown'
              ? 'send-delivery-unknown'
            : 'send-result',
      ...(proof ? { proof } : {}),
      requiresAuditIdentity: transferred,
    });
    return result && typeof result === 'object'
      ? { ...result, handoffId: result.handoffId || handoffId }
      : result;
  } catch (error) {
    store.settle(input.tabId, handoffId, {
      queueStatus: 'failed',
      reason: 'send-error-before-submit',
      requiresAuditIdentity: false,
    });
    throw error;
  }
}

export const beginHistoryPromptHandoff = (input: BeginHistoryPromptHandoffInput) =>
  historyPromptHandoffStore.begin(input);

export const bindHistoryPromptHandoffSendIdentity = (
  tabId: string,
  handoffId: string,
  input: BindHistoryPromptHandoffSendIdentityInput,
) => historyPromptHandoffStore.bindSendIdentity(tabId, handoffId, input);

export const advanceHistoryPromptHandoffTransportPhase = (
  tabId: string,
  handoffId: string,
  phase: HistoryPromptHandoffTransportPhase,
) => historyPromptHandoffStore.advanceTransportPhase(tabId, handoffId, phase);

export const acceptHistoryPromptHandoffProviderQueue = (
  tabId: string,
  handoffId: string,
  input: AcceptHistoryPromptHandoffProviderQueueInput = {},
) => historyPromptHandoffStore.acceptProviderQueue(tabId, handoffId, input);

export const settleHistoryPromptHandoff = (
  tabId: string,
  handoffId: string,
  input: SettleHistoryPromptHandoffInput,
) => historyPromptHandoffStore.settle(tabId, handoffId, input);

export const retractHistoryPromptHandoff = (
  tabId: string,
  handoffId: string,
  reason: string,
) => historyPromptHandoffStore.retract(tabId, handoffId, reason);

export const consumeHistoryPromptHandoff = (tabId: string, handoffId: string) =>
  historyPromptHandoffStore.consume(tabId, handoffId);

export const subscribeHistoryPromptHandoffs = (
  tabId: string,
  listener: HistoryPromptHandoffListener,
) => historyPromptHandoffStore.subscribe(tabId, listener);

export const getHistoryPromptHandoffsSnapshot = (tabId: string) =>
  historyPromptHandoffStore.getSnapshot(tabId);

export function waitForHistoryPromptHandoffSendIdentity(
  tabId: string,
  handoffId: string,
  timeoutMs = 1500,
): Promise<Readonly<HistoryPromptHandoff> | null> {
  const current = getHistoryPromptHandoffsSnapshot(tabId)
    .find((handoff) => handoff.handoffId === handoffId);
  if (!current) return Promise.resolve(null);
  if (current.sendOperationKey && current.sendAttemptId) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (handoff: Readonly<HistoryPromptHandoff> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(handoff);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    const registeredUnsubscribe = subscribeHistoryPromptHandoffs(tabId, (snapshot) => {
      const handoff = snapshot.find((candidate) => candidate.handoffId === handoffId) || null;
      if (!handoff) {
        finish(null);
        return;
      }
      if (handoff.sendOperationKey && handoff.sendAttemptId) finish(handoff);
    });
    unsubscribe = registeredUnsubscribe;
    // subscribe() replays synchronously; if that replay settled the promise,
    // finish() still had the initial no-op cleanup function.
    if (settled) registeredUnsubscribe();
  });
}

const ORCHESTRATION_COMPLETION_HANDOFF_PREFIX = 'orchestration-complete:';
const ORCHESTRATION_COMPLETION_SOURCE_PREFIX = 'orchestration-completion:';

/**
 * Legacy completion notifications predate desktop History receipts. Their
 * durable presentation still carries the exact orchestration run identity, so
 * that tag can retire the old local SENT projection without falling back to
 * equal text or timestamps.
 */
export function legacyOrchestrationCompletionMatchesCanonicalEntry(
  handoff: Pick<HistoryPromptHandoff, 'handoffId' | 'source' | 'queueStatus'> & {
    sendOperationKey?: string | null;
    sendAttemptId?: string | null;
  },
  entry: DurableHistoryCanonicalPromptEntry,
) {
  if (handoff?.queueStatus !== 'sent') return false;
  if (handoff?.sendOperationKey || handoff?.sendAttemptId) return false;
  const handoffId = String(handoff?.handoffId || '');
  if (!handoffId.startsWith(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX)) return false;
  const runId = handoffId.slice(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX.length).trim();
  if (!runId) return false;
  const source = String(handoff?.source || '');
  if (source && source !== ORCHESTRATION_COMPLETION_SOURCE_PREFIX + runId) return false;
  return (Array.isArray(entry?.semanticTags) ? entry.semanticTags : []).some((tag) => (
    tag?.kind === 'orchestration'
    && tag?.runId === runId
    && (tag?.phase === 'completion' || tag?.phase === 'failure')
  ));
}

export function durableHistorySendReceiptMatchesCanonicalEntry(
  record: DurableHistorySendReceiptRecord,
  entry: DurableHistoryCanonicalPromptEntry,
) {
  if (record?.state !== 'confirmed' || record?.presentation) return false;
  const receipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  const auditIdentity = record?.auditIdentity && typeof record.auditIdentity === 'object'
    ? record.auditIdentity
    : {};
  const entryUuid = typeof receipt.entryUuid === 'string' && receipt.entryUuid
    ? receipt.entryUuid
    : (typeof auditIdentity.entryUuid === 'string' ? auditIdentity.entryUuid : '');
  const sourceIdentity = typeof receipt.sourceIdentity === 'string' && receipt.sourceIdentity
    ? receipt.sourceIdentity
    : (typeof auditIdentity.sourceIdentity === 'string' ? auditIdentity.sourceIdentity : '');
  const exactSessionId = typeof receipt.sessionId === 'string' && receipt.sessionId
    ? receipt.sessionId
    : (typeof record.sessionId === 'string' ? record.sessionId : '');
  if (exactSessionId && entry.sessionId && exactSessionId !== entry.sessionId) return false;
  if (entryUuid) return historyEntryHasExactIdentity(entry, entryUuid);
  return !!sourceIdentity && historyEntryHasExactIdentity(entry, sourceIdentity);
}

export function hydrateHistoryPromptHandoffFromDurableReceipt(
  record: DurableHistorySendReceiptRecord,
): DurableHistorySendHydrationResult {
  const tabId = typeof record?.tabId === 'string' ? record.tabId.trim() : '';
  const handoffId = typeof record?.handoffId === 'string' ? record.handoffId.trim() : '';
  const operationKey = typeof record?.operationKey === 'string' ? record.operationKey.trim() : '';
  const attemptId = typeof record?.attemptId === 'string' ? record.attemptId.trim() : '';
  const toolType = record?.provider === 'claude' || record?.provider === 'codex'
    ? record.provider
    : null;
  const receipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  const promptText = typeof receipt.promptText === 'string' ? receipt.promptText : '';
  if (record?.surface !== 'desktop-history'
    || !tabId
    || !handoffId
    || !operationKey
    || !attemptId
    || !toolType
    || !promptText) {
    return { hydrated: false, reason: 'durable-history-receipt-incomplete' };
  }
  if (record.state === 'not-submitted') {
    return {
      hydrated: false,
      reason: 'durable-history-send-not-submitted',
      restorableDraft: promptText,
    };
  }
  if (record.state === 'provider-not-accepted') {
    return {
      hydrated: false,
      reason: receipt.providerQueueReturned === true
        ? 'durable-history-send-returned-to-terminal-composer'
        : 'durable-history-send-provider-not-accepted',
    };
  }
  if (
    Number.isFinite(Number(receipt.presentationDismissedAt))
    && receipt.presentationDismissedSurface === 'desktop-history'
  ) {
    return { hydrated: false, reason: 'durable-history-presentation-dismissed' };
  }
  if (record.presentation) {
    return { hydrated: false, reason: 'durable-history-presentation-already-materialized' };
  }

  const presentation = receipt.presentationSnapshot && typeof receipt.presentationSnapshot === 'object'
    ? receipt.presentationSnapshot
    : {};
  const providerQueue = receipt.providerQueue && typeof receipt.providerQueue === 'object'
    ? receipt.providerQueue
    : {};
  const exactProviderQueueAccepted = (
    record.state === 'audit-pending'
    || record.state === 'enter-armed'
    || record.state === 'delivery-unknown'
  )
    && providerQueue.accepted === true
    && providerQueue.provider === 'claude'
    && providerQueue.operationKey === operationKey
    && providerQueue.attemptId === attemptId;
  let queueStatus: SettledHistoryPromptHandoffStatus | null = null;
  if (record.state === 'confirmed') queueStatus = 'sent';
  else if (exactProviderQueueAccepted) queueStatus = 'queued';
  else if (record.state === 'audit-pending') queueStatus = 'audit-pending';
  else if (record.state === 'delivery-unknown' || record.state === 'enter-armed') {
    queueStatus = 'delivery-unknown';
  }
  const auditIdentity = record?.auditIdentity && typeof record.auditIdentity === 'object'
    ? record.auditIdentity
    : {};
  const auditTimestamp = typeof receipt.auditTimestamp === 'string' && receipt.auditTimestamp.trim()
    ? receipt.auditTimestamp.trim()
    : (typeof auditIdentity.auditTimestamp === 'string' && auditIdentity.auditTimestamp.trim()
      ? auditIdentity.auditTimestamp.trim()
      : '');
  const entryUuid = typeof receipt.entryUuid === 'string' && receipt.entryUuid
    ? receipt.entryUuid
    : (typeof auditIdentity.entryUuid === 'string' ? auditIdentity.entryUuid : '');
  const sourceIdentity = typeof receipt.sourceIdentity === 'string' && receipt.sourceIdentity
    ? receipt.sourceIdentity
    : (typeof auditIdentity.sourceIdentity === 'string' && auditIdentity.sourceIdentity
      ? auditIdentity.sourceIdentity
      : (typeof providerQueue.sourceIdentity === 'string' ? providerQueue.sourceIdentity : ''));
  const recordByteOffset = Number.isSafeInteger(Number(receipt.recordByteOffset))
    && Number(receipt.recordByteOffset) >= 0
    ? Number(receipt.recordByteOffset)
    : (Number.isSafeInteger(Number(providerQueue.recordByteOffset))
      && Number(providerQueue.recordByteOffset) >= 0
      ? Number(providerQueue.recordByteOffset)
      : null);
  const providerQueueEntryUuid = typeof providerQueue.entryUuid === 'string'
    && providerQueue.entryUuid
    ? providerQueue.entryUuid
    : '';
  const providerQueueSourceIdentity = typeof providerQueue.sourceIdentity === 'string'
    && providerQueue.sourceIdentity
    ? providerQueue.sourceIdentity
    : (providerQueueEntryUuid ? `claude-queue:uuid:${providerQueueEntryUuid}` : '');
  const initialProviderQueueProof = exactProviderQueueAccepted && providerQueueSourceIdentity
    ? {
        sourceIdentity: providerQueueSourceIdentity,
        sessionId: typeof providerQueue.sessionId === 'string'
          ? providerQueue.sessionId
          : (typeof record.sessionId === 'string' ? record.sessionId : null),
        ...(providerQueueEntryUuid ? { entryUuid: providerQueueEntryUuid } : {}),
        ...(Number.isSafeInteger(Number(providerQueue.recordByteOffset))
          && Number(providerQueue.recordByteOffset) >= 0
          ? { recordByteOffset: Number(providerQueue.recordByteOffset) }
          : {}),
      }
    : null;
  if (queueStatus === 'sent' && !entryUuid && !sourceIdentity) {
    // Legacy confirmed receipts already prove transcript delivery, but older
    // builds discarded Codex's exact row identity. Recreating a local SENT row
    // can only duplicate canonical History and can never be consumed safely.
    return { hydrated: false, reason: 'durable-history-confirmed-identity-missing' };
  }
  if (queueStatus === 'sent' && (
    typeof receipt.actualHash !== 'string'
    || !receipt.actualHash
    || !auditTimestamp
  )) {
    // The exact transcript row is known, but an older receipt cannot rebuild
    // a safe adoption proof. Delivery is already confirmed, so showing a new
    // local SENT row would only create an unconsumable duplicate.
    return { hydrated: false, reason: 'durable-history-confirmed-proof-incomplete' };
  }
  const proof = queueStatus === 'sent'
    && typeof receipt.actualHash === 'string'
    && receipt.actualHash
    && auditTimestamp
    ? {
        auditTimestamp,
        actualHash: receipt.actualHash,
        sessionId: typeof receipt.sessionId === 'string'
          ? receipt.sessionId
          : (typeof record.sessionId === 'string' ? record.sessionId : null),
        ...(entryUuid
          ? { entryUuid }
          : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        ...(recordByteOffset !== null ? { recordByteOffset } : {}),
        ...(receipt.canonicalized === true ? { canonicalized: true } : {}),
        ...(typeof receipt.canonicalReason === 'string' && receipt.canonicalReason
          ? { canonicalReason: receipt.canonicalReason }
          : {}),
      }
    : null;
  const initialReceipt = queueStatus
    ? {
        queueStatus,
        reason: queueStatus === 'sent'
          ? 'durable-audit-confirmed'
          : queueStatus === 'queued'
            ? 'durable-provider-queue-accepted'
          : queueStatus === 'audit-pending'
            ? 'durable-audit-pending'
            : 'durable-delivery-unknown',
        proof,
        requiresAuditIdentity: true,
        changedAt: Number(record.updatedAt) || Date.now(),
      }
    : undefined;
  const begun = beginHistoryPromptHandoff({
    tabId,
    handoffId,
    sendAttemptId: attemptId,
    sendOperationKey: operationKey,
    toolType,
    sessionIdHint: typeof record.sessionId === 'string' ? record.sessionId : null,
    text: promptText,
    promptChips: Array.isArray(presentation.promptChips) ? presentation.promptChips : [],
    imagePaths: Array.isArray(presentation.imagePaths) ? presentation.imagePaths : [],
    submittedAt: Number(record.createdAt) || Date.now(),
    source: typeof receipt.source === 'string' ? receipt.source : 'history-panel',
    statusAtSend: 'unknown',
    requiresAuditIdentity: true,
    initialProviderQueueProof,
    ...(initialReceipt ? { initialReceipt } : {}),
  });
  if (!begun) return { hydrated: false, reason: 'durable-history-handoff-bounds' };
  const bound = bindHistoryPromptHandoffSendIdentity(tabId, handoffId, {
    sendAttemptId: attemptId,
    sendOperationKey: operationKey,
  });
  if (!bound.ok) return { hydrated: false, reason: bound.reason };
  const hydratedHandoff = initialProviderQueueProof
    && bound.handoff.providerQueueProof?.sourceIdentity !== initialProviderQueueProof.sourceIdentity
    ? acceptHistoryPromptHandoffProviderQueue(tabId, handoffId, {
        sendAttemptId: attemptId,
        sendOperationKey: operationKey,
        proof: initialProviderQueueProof,
        changedAt: Number(record.updatedAt) || Date.now(),
      }) || bound.handoff
    : bound.handoff;

  if (!queueStatus) {
    return { hydrated: true, reason: 'durable-history-send-active', handoff: hydratedHandoff };
  }
  return {
    hydrated: true,
    reason: 'durable-history-receipt-hydrated',
    handoff: hydratedHandoff,
  };
}
