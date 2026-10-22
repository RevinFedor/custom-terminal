import {
  historyEntryHasExactIdentity,
  matchesHistoryPromptExactProof,
} from './historyPromptPresentation.mjs';
import {
  isStandaloneAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from './agentLocalCommand.mjs';
import { isAutomaticReadinessWaitReceipt } from '../../shared/prompt-queue-send-intent.cjs';
import { readHistorySendRecovery, removeHistorySendRecovery, hideHistorySendRecoveryPresentation } from './historySendRecovery.mjs';
import { normalizeHistorySendInputTiming } from './historySendTiming.mjs';
import { hiddenSendPresentation, canProjectCurrentProviderQueue, retiredSendInputSlot, cancelledSendIntent, isTabMessageNoInputReceipt } from '../../shared/agent-send-receipt-control.cjs';

export type HistoryPromptHandoffTool = 'claude' | 'codex';

export type HistoryPromptHandoffStatus =
  | 'application-queued'
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

export const HISTORY_PROMPT_SENT_PRESENTATION_MS = 2000;

export interface HistoryPromptHandoffStatusPresentationOptions {
  statusChangedAt?: number;
  now?: number;
}

export type HistoryPromptHandoffAgentStatus =
  | 'active'
  | 'busy'
  | 'inactive'
  | 'starting'
  | 'stopping'
  | 'unknown';

export interface HistoryPromptHandoffChip {
  contextUpdateId?: string;
  id?: string;
  kind: 'prompt';
  label?: string;
  text: string;
  sourceKey?: string;
  inheritanceDepth?: number;
  inheritanceParentLabel?: string;
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

export interface HistoryPromptHandoffSemanticTag {
  kind: 'orchestration' | 'prompt-origin' | 'tab-message';
  [key: string]: unknown;
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

export interface QueuedMessageMergeGuard {
  version: 1; tabId: string; operationKey: string; queueId: number; requestHash: string;
  previousOperationKey: string; previousQueueId: number; previousRequestHash: string;
}

export interface HistoryPromptHandoff {
  historyReturn?: any;
  applicationQueuePosition?: number;
  applicationQueuePresentationHandoffId?: string;
  applicationQueueId?: number | null;
  applicationQueueMerge?: QueuedMessageMergeGuard | null;
  applicationQueueReplacement?: boolean;
  tabId: string;
  handoffId: string;
  sendAttemptId: string | null;
  sendOperationKey: string | null;
  toolType: HistoryPromptHandoffTool;
  sessionIdHint: string | null;
  text: string;
  promptChips: readonly Readonly<HistoryPromptHandoffChip>[];
  imagePaths: readonly Readonly<HistoryPromptHandoffImageRef>[];
  semanticTags?: readonly Readonly<HistoryPromptHandoffSemanticTag>[];
  authoringText: string;
  authoringChips: readonly Readonly<Record<string, any>>[];
  authoringImagePaths: readonly Readonly<HistoryPromptHandoffImageRef>[];
  submittedAt: number;
  enterAttemptAt?: number;
  sendInputTiming?: { version: 1; preparationStartedAt: number; payloadStartedAt?: number };
  source: string;
  statusAtSend: HistoryPromptHandoffAgentStatus;
  queueStatus: HistoryPromptHandoffStatus;
  statusReason: string;
  statusChangedAt: number;
  requiresAuditIdentity: boolean;
  auditProof: Readonly<HistoryPromptHandoffAuditProof> | null;
  providerQueueProof: Readonly<HistoryPromptHandoffProviderQueueProof> | null;
}

/**
 * Exact fields a renderer-local History row must retain across remount.
 * The handoff is only presentation; its audit/provider proof owns the real
 * transcript address. Dropping these fields resurrects a confirmed row at the
 * tail because it can no longer adopt its canonical server record.
 */
export function historyPromptHandoffPresentationIdentity(
  handoff: Pick<HistoryPromptHandoff,
    'requiresAuditIdentity' | 'auditProof' | 'providerQueueProof'>,
): {
  requiresAuditIdentity: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditSessionId?: string;
  auditEntryUuid?: string;
  sourceIdentity?: string;
  recordByteOffset?: number;
} {
  const audit = handoff.auditProof;
  const carrier = audit || handoff.providerQueueProof;
  return {
    requiresAuditIdentity: handoff.requiresAuditIdentity === true,
    ...(audit?.auditTimestamp ? { auditTimestamp: audit.auditTimestamp } : {}),
    ...(audit?.actualHash ? { auditHash: audit.actualHash } : {}),
    ...(carrier?.sessionId ? { auditSessionId: carrier.sessionId } : {}),
    ...(audit?.entryUuid ? { auditEntryUuid: audit.entryUuid } : {}),
    ...(carrier?.sourceIdentity ? { sourceIdentity: carrier.sourceIdentity } : {}),
    ...(Number.isSafeInteger(Number(carrier?.recordByteOffset))
      && Number(carrier?.recordByteOffset) >= 0
      ? { recordByteOffset: Number(carrier.recordByteOffset) }
      : {}),
  };
}

export interface BeginHistoryPromptHandoffInput {
  historyReturn?: any;
  applicationQueuePosition?: number;
  applicationQueuePresentationHandoffId?: string;
  applicationQueueId?: number | null;
  applicationQueueMerge?: QueuedMessageMergeGuard | null;
  applicationQueueReplacement?: boolean;
  tabId: string;
  handoffId: string;
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
  toolType: HistoryPromptHandoffTool;
  sessionIdHint?: string | null;
  text: string;
  promptChips?: readonly HistoryPromptHandoffChip[];
  imagePaths?: readonly HistoryPromptHandoffImageRef[];
  semanticTags?: readonly HistoryPromptHandoffSemanticTag[];
  authoringText?: string;
  authoringChips?: readonly Record<string, any>[];
  authoringImagePaths?: readonly HistoryPromptHandoffImageRef[];
  submittedAt?: number;
  enterAttemptAt?: number;
  sendInputTiming?: HistoryPromptHandoff['sendInputTiming'];
  source?: string;
  statusAtSend?: HistoryPromptHandoffAgentStatus;
  initialStatus?: Extract<HistoryPromptHandoffStatus, 'preparing' | 'sending' | 'queued' | 'application-queued'>;
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
  /** Exact main receipt identity; required to promote a terminal local status. */
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
  toolType?: HistoryPromptHandoffTool;
  /** Main certified this exact attempt ended before any terminal input. */
  noWriteAttemptId?: string;
}

export interface AdoptHistoryPromptHandoffCanonicalInput {
  entryUuid: string;
  sessionId?: string | null;
  sourceIdentity?: string | null;
  sourceIdentityAliases?: readonly string[] | null;
}

export interface BindHistoryPromptHandoffSendIdentityInput {
  applicationQueuePosition?: number;
  applicationQueueId?: number | null;
  applicationQueueMerge?: QueuedMessageMergeGuard | null;
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
}

export interface AcceptHistoryPromptHandoffProviderQueueInput
  extends BindHistoryPromptHandoffSendIdentityInput {
  changedAt?: number;
  proof?: HistoryPromptHandoffProviderQueueProof | null;
}

export interface DurableHistorySendReceiptRecord {
  historyReturn?: any;
  deliveryControl?: { version: number; cancelledAt?: number | null; presentationDismissed?: boolean } | null;
  inputSlot?: { version: number; state: string; reason?: string | null; retiredAt?: number | null } | null;
  applicationQueue?: { version: number; id: number; state: string; queuedAt: number;
    waitingBeforeInput?: boolean; lastNoWriteAttemptId?: string; mergePrevious?: QueuedMessageMergeGuard | null;
    position?: number; merge?: { version: number; sourceOperationKeys: string[]; presentationHandoffId?: string } | null } | null;
  promptHash?: string | null;
  imagePresentation?: { version: number; operationKey: string; attemptId: string; requestHash: string;
    imagePaths: HistoryPromptHandoffImageRef[] } | null;
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
  transcriptBoundary?: {
    available?: boolean | null;
    sessionId?: string | null;
    fileSize?: number | null;
    lastUserUuid?: string | null;
  } | null;
}

export interface DurableHistoryCanonicalPromptEntry {
  uuid?: string | null;
  role?: string | null;
  content?: string | null;
  timestamp?: string | null;
  recordByteOffset?: number | null;
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
  historyReturn?: any;
  enterAttemptAt?: number;
  sendInputTiming?: HistoryPromptHandoff['sendInputTiming'];
  semanticTags?: readonly Readonly<HistoryPromptHandoffSemanticTag>[];
  applicationQueuePosition?: number;
  applicationQueueMerge?: QueuedMessageMergeGuard | null;
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
  | { type: 'canonical-adopt'; handoffId: string }
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

export type HistoryPromptHandoffTransportPhase = 'preparing' | 'sending' | 'queued' | 'confirming';

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
      handoff.queueStatus !== 'application-queued'
      && handoff.queueStatus !== 'preparing'
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

export function historyPromptHandoffBlocksNewSubmit(
  handoffs: readonly Pick<HistoryPromptHandoff, 'submittedAt' | 'statusChangedAt' | 'queueStatus'>[],
): boolean {
  return selectLatestHistoryPromptInputStatus(handoffs) !== null;
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
    + stringBytes(value.applicationQueueMerge ? JSON.stringify(value.applicationQueueMerge) : '')
    + stringBytes(value.tabId)
    + stringBytes(value.handoffId)
    + stringBytes(value.sendAttemptId)
    + stringBytes(value.sendOperationKey)
    + stringBytes(value.toolType)
    + stringBytes(value.sessionIdHint)
    + stringBytes(value.text)
    + stringBytes(value.authoringText)
    + stringBytes(value.semanticTags ? JSON.stringify(value.semanticTags) : '')
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
      + stringBytes(chip.sourceKey)
      + stringBytes(chip.inheritanceDepth)
      + stringBytes(chip.contextUpdateId)
      + stringBytes(chip.inheritanceParentLabel);
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
  for (const chip of value.authoringChips) bytes += stringBytes(JSON.stringify(chip));
  for (const ref of value.authoringImagePaths) bytes += RECORD_OVERHEAD_BYTES + stringBytes(ref.path);
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
    ...(typeof chip.contextUpdateId === 'string' ? { contextUpdateId: chip.contextUpdateId } : {}),
    ...(Number.isInteger(chip.inheritanceDepth) && Number(chip.inheritanceDepth) > 0
      ? { inheritanceDepth: Number(chip.inheritanceDepth) }
      : {}),
    ...(typeof chip.inheritanceParentLabel === 'string'
      ? { inheritanceParentLabel: chip.inheritanceParentLabel }
      : {}),
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
    ...(proof.recordByteOffset != null && Number.isSafeInteger(Number(proof.recordByteOffset))
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
    ...(proof.recordByteOffset != null && Number.isSafeInteger(Number(proof.recordByteOffset))
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
    applicationQueueMerge: value.applicationQueueMerge ? Object.freeze({ ...value.applicationQueueMerge }) : null,
    promptChips: Object.freeze(value.promptChips.map(freezeChip)),
    imagePaths: Object.freeze(value.imagePaths.map(freezeImageRef)),
    ...(value.semanticTags ? { semanticTags: Object.freeze(value.semanticTags.map(tag => Object.freeze({ ...tag }))) } : {}),
    authoringChips: Object.freeze(value.authoringChips.map((chip) => Object.freeze({ ...chip }))),
    authoringImagePaths: Object.freeze(value.authoringImagePaths.map(freezeImageRef)),
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
  const semanticTags = handoff.semanticTags?.length ? handoff.semanticTags : row.semanticTags;

  if (
    row.handoffId === handoff.handoffId
    && JSON.stringify(row.semanticTags || []) === JSON.stringify(semanticTags || [])
    && row.applicationQueuePosition === handoff.applicationQueuePosition
    && JSON.stringify(row.applicationQueueMerge || null) === JSON.stringify(handoff.applicationQueueMerge || null)
    && row.queueStatus === handoff.queueStatus
    && row.statusReason === handoff.statusReason
    && row.statusChangedAt === handoff.statusChangedAt
    && row.statusAtSend === handoff.statusAtSend
    && row.timestamp === timestamp
    && row.optimisticAt === handoff.submittedAt
    && row.enterAttemptAt === handoff.enterAttemptAt
    && row.sendInputTiming?.preparationStartedAt === handoff.sendInputTiming?.preparationStartedAt
    && row.sendInputTiming?.payloadStartedAt === handoff.sendInputTiming?.payloadStartedAt
    && row.historyReturn === handoff.historyReturn
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
    ...(semanticTags ? { semanticTags: semanticTags.map(tag => ({ ...tag })) } : {}),
    handoffId: handoff.handoffId,
    applicationQueuePosition: handoff.applicationQueuePosition,
    applicationQueueMerge: handoff.applicationQueueMerge,
    queueStatus: handoff.queueStatus,
    statusReason: handoff.statusReason,
    statusChangedAt: handoff.statusChangedAt,
    statusAtSend: handoff.statusAtSend,
    timestamp,
    optimisticAt: handoff.submittedAt,
    enterAttemptAt: handoff.enterAttemptAt,
    sendInputTiming: handoff.sendInputTiming,
    historyReturn: handoff.historyReturn,
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
  private returned = new Set<string>();
  private restored = new Set<string>();
  isReturned(tabId: string, handoffId: string) { return this.returned.has(tabId + '\0' + handoffId); }
  isRestored(tabId: string, handoffId: string) { return this.restored.has(tabId + '\0' + handoffId); }
  private readonly limits: Readonly<HistoryPromptHandoffStoreLimits>;
  private readonly tabs = new Map<string, Map<string, StoredHandoff>>();
  private readonly listeners = new Map<string, Set<HistoryPromptHandoffListener>>();
  private readonly deliveryControls = new Map<string, { attemptId: string | null; hidden: boolean; retired: boolean; cancelled: boolean }>();
  private handoffs = 0;
  private approxBytes = 0;

  // Thin projection metadata outlives payload eviction. Main remains the
  // durable owner; late receipt/list replies may not undo an observed control.
  observeDeliveryControl(record: DurableHistorySendReceiptRecord) {
    const key = JSON.stringify([record.tabId, record.handoffId, record.operationKey]);
    const previous = this.deliveryControls.get(key);
    const compatible = previous && (previous.cancelled || previous.attemptId === (record.attemptId || null));
    const hidden = hiddenSendPresentation(record), retired = retiredSendInputSlot(record);
    const cancelled = cancelledSendIntent(record);
    if (hidden || retired || cancelled) {
      const next = { attemptId: record.attemptId || null, hidden: hidden || !!(compatible && previous.hidden),
        retired: retired || !!(compatible && previous.retired), cancelled: cancelled || !!(compatible && previous.cancelled) };
      this.deliveryControls.delete(key); this.deliveryControls.set(key, next);
      const cap = Math.min(8192, Math.max(256, this.limits.maxHandoffs * 4));
      while (this.deliveryControls.size > cap) {
        this.deliveryControls.delete(this.deliveryControls.keys().next().value!);
        console.warn('[HistorySendControl] projection metadata evicted; durable Main remains authoritative');
      }
      return next;
    }
    return compatible ? previous : null;
  }

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

  hydrateImagePresentation(record: DurableHistorySendReceiptRecord): boolean {
    const tab = this.tabs.get(String(record.tabId || ''));
    const current = tab?.get(String(record.handoffId || ''));
    const proof = record.imagePresentation;
    if (!tab || !current || current.value.imagePaths.length || !proof || proof.version !== 1
      || proof.operationKey !== record.operationKey || proof.attemptId !== record.attemptId
      || proof.requestHash !== record.promptHash || record.provider !== current.value.toolType
      || record.receipt?.promptText !== current.value.text
      || current.value.sendAttemptId !== record.attemptId || current.value.sendOperationKey !== record.operationKey
      || (current.value.sessionIdHint && current.value.sessionIdHint !== record.sessionId)
      || !Array.isArray(proof.imagePaths) || !proof.imagePaths.length
      || proof.imagePaths.some((ref, i) => ref.id !== i + 1 || !ref.path?.startsWith('/'))) return false;
    const next = freezeHandoff({ ...current.value, imagePaths: proof.imagePaths });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return false;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(next.handoffId, { value: next, approxBytes });
    this.promoteTab(next.tabId);
    this.enforceLimits(next.tabId, next.handoffId);
    if (!this.tabs.get(next.tabId)?.has(next.handoffId)) return false;
    this.notify(next.tabId, { type: 'replay' });
    return true;
  }

  hydrateSemanticPresentation(record: DurableHistorySendReceiptRecord): boolean {
    // Late receipt metadata enriches only its existing immutable send owner.
    const tab = this.tabs.get(String(record.tabId || ''));
    const current = tab?.get(String(record.handoffId || ''));
    const tags = record.receipt?.presentationSnapshot?.semanticTags;
    if (!tab || !current || current.value.semanticTags?.length || !Array.isArray(tags) || !tags.length
      || record.provider !== current.value.toolType
      || record.receipt?.promptText !== current.value.text
      || current.value.sendAttemptId !== (record.attemptId || null)
      || current.value.sendOperationKey !== record.operationKey
      || (current.value.sessionIdHint && current.value.sessionIdHint !== record.sessionId)) return false;
    const next = freezeHandoff({ ...current.value, semanticTags: tags });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return false;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(next.handoffId, { value: next, approxBytes });
    this.promoteTab(next.tabId);
    this.enforceLimits(next.tabId, next.handoffId);
    if (!this.tabs.get(next.tabId)?.has(next.handoffId)) return false;
    this.notify(next.tabId, { type: 'replay' });
    return true;
  }

  begin(input: BeginHistoryPromptHandoffInput): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(input.tabId, 'tabId');
    const handoffId = requireKey(input.handoffId, 'handoffId');
    if (this.restored.has(tabId + '\0' + handoffId)) return undefined;
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
        const submittedAt = currentAttemptId
          ? finiteTimestamp(input.submittedAt, Date.now()) : existing.value.submittedAt;
        const initialReceipt = input.initialReceipt;
        const initialStatus = initialReceipt?.queueStatus || input.initialStatus || 'sending';
        const next = freezeHandoff({
          ...existing.value,
          applicationQueueId: existing.value.applicationQueueId || input.applicationQueueId || null,
          applicationQueueMerge: input.applicationQueueMerge || null,
          sendAttemptId: nextAttemptId,
          sendOperationKey: typeof input.sendOperationKey === 'string'
            ? input.sendOperationKey.trim() || null
            : existing.value.sendOperationKey,
          sessionIdHint: typeof input.sessionIdHint === 'string'
            ? input.sessionIdHint
            : existing.value.sessionIdHint,
          submittedAt,
          enterAttemptAt: currentAttemptId ? input.enterAttemptAt : existing.value.enterAttemptAt || input.enterAttemptAt,
          sendInputTiming: currentAttemptId ? normalizeHistorySendInputTiming(input.sendInputTiming)
            : existing.value.sendInputTiming || normalizeHistorySendInputTiming(input.sendInputTiming),
          source: typeof input.source === 'string' ? input.source : existing.value.source,
          semanticTags: input.semanticTags || existing.value.semanticTags,
          // null → first attempt only binds the existing click to its durable
          // receipt. Hydration has no new click-time observation (usually
          // 'unknown') and must not erase the known busy/active placement.
          // A real attempt A → B still resets from the new send's observation.
          statusAtSend: !currentAttemptId && existing.value.statusAtSend !== 'unknown'
            ? existing.value.statusAtSend
            : input.statusAtSend || existing.value.statusAtSend,
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
        const bound = this.bindSendIdentity(tabId, handoffId, {
          applicationQueueId: input.applicationQueueId,
          applicationQueuePosition: input.applicationQueuePosition,
          applicationQueueMerge: input.applicationQueueMerge,
          sendAttemptId: input.sendAttemptId,
          sendOperationKey: input.sendOperationKey,
        });
        if (!bound.ok) return existing.value;
        return this.settle(tabId, handoffId, {
          ...input.initialReceipt,
          sendAttemptId: input.sendAttemptId,
          sendOperationKey: input.sendOperationKey,
          toolType: input.toolType,
        });
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
      applicationQueueId: input.applicationQueueId || null,
      applicationQueuePosition: input.applicationQueuePosition,
      applicationQueuePresentationHandoffId: input.applicationQueuePresentationHandoffId,
      applicationQueueMerge: input.applicationQueueMerge || null,
      applicationQueueReplacement: input.applicationQueueReplacement === true,
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
      ...(input.semanticTags ? { semanticTags: input.semanticTags } : {}),
      authoringText: typeof input.authoringText === 'string' ? input.authoringText : String(input.text || ''),
      authoringChips: input.authoringChips || [],
      authoringImagePaths: input.authoringImagePaths || input.imagePaths || [],
      submittedAt,
      enterAttemptAt: input.enterAttemptAt,
      sendInputTiming: normalizeHistorySendInputTiming(input.sendInputTiming),
      historyReturn: input.historyReturn,
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

  recordEnterAttempt(tabId: string, handoffId: string, input: BindHistoryPromptHandoffSendIdentityInput & { enterAttemptAt?: number }) {
    const current = this.tabs.get(tabId)?.get(handoffId)?.value;
    if (!current || !Number.isFinite(input.enterAttemptAt) || Number(input.enterAttemptAt) <= 0
      || current.enterAttemptAt || !historyPromptHandoffAcceptsAuditIdentity(current, input)
      || (current.requiresAuditIdentity && (!input.sendAttemptId || !input.sendOperationKey))) return current;
    const bound = this.bindSendIdentity(tabId, handoffId, input);
    if (!bound.ok) return current;
    const tab = this.tabs.get(tabId)!;
    const owned = tab.get(handoffId)!;
    const next = freezeHandoff({ ...owned.value, enterAttemptAt: input.enterAttemptAt });
    tab.set(handoffId, { ...owned, value: next });
    this.notify(tabId, { type: 'transport-phase', handoffId });
    return next;
  }

  recordInputTiming(tabId: string, handoffId: string,
    input: BindHistoryPromptHandoffSendIdentityInput & { sendInputTiming?: HistoryPromptHandoff['sendInputTiming'] }) {
    const current = this.tabs.get(tabId)?.get(handoffId)?.value;
    const timing = normalizeHistorySendInputTiming(input.sendInputTiming);
    if (!current || !timing || !input.sendAttemptId || !input.sendOperationKey
      || !historyPromptHandoffAcceptsAuditIdentity(current, input)
      || current.sendInputTiming && current.sendInputTiming.preparationStartedAt !== timing.preparationStartedAt) return current;
    const bound = this.bindSendIdentity(tabId, handoffId, input);
    if (!bound.ok) return current;
    const tab = this.tabs.get(tabId)!, owned = tab.get(handoffId)!;
    const nextTiming = normalizeHistorySendInputTiming({ ...timing,
      payloadStartedAt: owned.value.sendInputTiming?.payloadStartedAt || timing.payloadStartedAt });
    if (owned.value.sendInputTiming?.preparationStartedAt === nextTiming?.preparationStartedAt
      && owned.value.sendInputTiming?.payloadStartedAt === nextTiming?.payloadStartedAt) return owned.value;
    const next = freezeHandoff({ ...owned.value, sendInputTiming: nextTiming });
    tab.set(handoffId, { ...owned, value: next });
    this.notify(tabId, { type: 'transport-phase', handoffId });
    return next;
  }

  recordReturnControl(control: any) {
    const tab = this.tabs.get(control?.tabId);
    const owned = tab?.get(control?.handoffId);
    if (!owned || control.version !== 1 || !control.token
      || owned.value.historyReturn?.token && owned.value.historyReturn.token !== control.token) return;
    const rank: Record<string, number> = { registering: 0, available: 1, writing: 2, superseded: 2, returned: 2, restored: 3 };
    const prior = owned.value.historyReturn;
    if (prior?.token === control.token && prior?.state === control.state
      && prior?.inputStartedAt === control.inputStartedAt && prior?.returnedAt === control.returnedAt
      && prior?.restoredAt === control.restoredAt) return;
    if (rank[control.state] == null || (rank[prior?.state] || 0) > rank[control.state]
      || prior?.state === 'writing' && control.state !== 'writing'
      || ['returned', 'restored'].includes(prior?.state) && control.state === 'writing') return;
    const next = freezeHandoff({ ...owned.value, historyReturn: Object.freeze({ ...control }),
      ...(['returned', 'restored'].includes(control.state) ? {
        queueStatus: 'cancelled' as const, statusReason: 'history-send-returned',
        statusChangedAt: control.returnedAt || Date.now(),
      } : {}),
    });
    tab!.set(control.handoffId, { ...owned, value: next });
    if (['returned', 'restored'].includes(control.state)) this.returned.add(control.tabId + '\0' + control.handoffId);
    if (control.state === 'restored') this.restored.add(control.tabId + '\0' + control.handoffId);
    if (control.state === 'restored') {
      removeHistorySendRecovery(control.tabId, control.handoffId);
      this.consume(control.tabId, control.handoffId);
      return next;
    }
    this.notify(control.tabId, { type: 'transport-phase', handoffId: control.handoffId });
  }

  preparePresentation(tabId: string, handoffId: string, input: Pick<BeginHistoryPromptHandoffInput, 'text' | 'imagePaths'>) {
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    if (!tab || !current || current.value.sendAttemptId || current.value.sendOperationKey
      || current.value.queueStatus !== 'preparing') return undefined;
    const next = freezeHandoff({ ...current.value, text: input.text, imagePaths: input.imagePaths || [] });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return undefined;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.notify(tabId, { type: 'transport-phase', handoffId });
    return next;
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
    if (phase === 'preparing') {
      if (!current.value.providerQueueProof && !current.value.auditProof
        && ['application-queued', 'sending', 'queued'].includes(current.value.queueStatus)) queueStatus = 'preparing';
    } else if (phase === 'queued') {
      if (current.value.queueStatus === 'application-queued' || current.value.queueStatus === 'preparing' || current.value.queueStatus === 'sending') {
        queueStatus = 'queued';
      }
    } else if (phase === 'sending') {
      if (current.value.queueStatus === 'application-queued' || current.value.queueStatus === 'preparing' || current.value.queueStatus === 'queued') {
        queueStatus = 'sending';
      }
    } else if (phase === 'confirming') {
      if (
        current.value.queueStatus === 'application-queued'
        || current.value.queueStatus === 'preparing'
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
        : phase === 'preparing' ? 'send-preparing'
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
    const control = this.observeDeliveryControl({ tabId, handoffId, operationKey: current.value.sendOperationKey,
      attemptId: current.value.sendAttemptId });
    if (control?.retired || control?.cancelled) return current.value;
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
    const applicationQueueId = current.value.applicationQueueId || input.applicationQueueId || null;
    const applicationQueuePosition = input.applicationQueuePosition ?? current.value.applicationQueuePosition;
    const applicationQueueMerge = Object.hasOwn(input, 'applicationQueueMerge')
      ? input.applicationQueueMerge || null : current.value.applicationQueueMerge || null;
    if (
      sendAttemptId === current.value.sendAttemptId
      && sendOperationKey === current.value.sendOperationKey
      && applicationQueueId === (current.value.applicationQueueId || null)
      && applicationQueuePosition === current.value.applicationQueuePosition
      && JSON.stringify(applicationQueueMerge) === JSON.stringify(current.value.applicationQueueMerge || null)
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
      applicationQueueId,
      applicationQueuePosition,
      applicationQueueMerge,
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
    const control = this.observeDeliveryControl({ tabId, handoffId, operationKey: current.value.sendOperationKey,
      attemptId: current.value.sendAttemptId });
    if ((control?.retired || control?.cancelled) && input.queueStatus === 'queued') return current.value;

    if ((input.sendAttemptId || input.sendOperationKey)
      && (!historyPromptHandoffAcceptsAuditIdentity(current.value, input)
        || (input.toolType && input.toolType !== current.value.toolType))) {
      return current.value;
    }
    if (
      current.value.queueStatus === 'cancelled'
      || current.value.queueStatus === 'failed'
    ) {
      // A late main audit can correct a local failure without sending again.
      // A timeout, a native queue card or another attempt cannot do so.
      const sessionId = current.value.auditProof?.sessionId
        || current.value.providerQueueProof?.sessionId || current.value.sessionIdHint;
      const proof = input.proof;
      const exactConfirmation = input.queueStatus === 'sent'
        && !!current.value.sendAttemptId && !!current.value.sendOperationKey
        && input.sendAttemptId === current.value.sendAttemptId
        && input.sendOperationKey === current.value.sendOperationKey
        && input.toolType === current.value.toolType
        && !!sessionId && proof?.sessionId === sessionId
        && !!proof?.auditTimestamp && !!proof?.actualHash
        && !!(proof?.entryUuid || proof?.sourceIdentity)
        && !/^(?:claude-queue:|codex-tui-queue:)/.test(proof?.sourceIdentity || '');
      const certifiedApplicationWait = current.value.queueStatus === 'failed'
        && input.queueStatus === 'application-queued' && !control?.cancelled && !control?.retired
        && !current.value.auditProof && !current.value.providerQueueProof
        && !!current.value.sendAttemptId && !!current.value.sendOperationKey
        && input.noWriteAttemptId === current.value.sendAttemptId
        && input.sendAttemptId === current.value.sendAttemptId
        && input.sendOperationKey === current.value.sendOperationKey
        && input.toolType === current.value.toolType;
      if (!exactConfirmation && !certifiedApplicationWait) return current.value;
    }

    const nextProof = mergeCompatibleAuditProof(current.value.auditProof, input.proof);
    // A delayed admission ACK cannot move a physically executing/confirmed
    // attempt back to the application backlog.
    if (input.queueStatus === 'application-queued'
      && (current.value.auditProof || current.value.providerQueueProof
        || (current.value.sendAttemptId && (input.noWriteAttemptId !== current.value.sendAttemptId
          || ['sent', 'queued', 'audit-pending', 'delivery-unknown'].includes(current.value.queueStatus))))) return current.value;
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
      && !control?.retired && !control?.cancelled
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

  adoptCanonicalEntry(
    tabIdValue: string,
    handoffIdValue: string,
    input: AdoptHistoryPromptHandoffCanonicalInput,
  ): Readonly<HistoryPromptHandoff> | undefined {
    const tabId = requireKey(tabIdValue, 'tabId');
    const handoffId = requireKey(handoffIdValue, 'handoffId');
    const entryUuid = requireKey(input.entryUuid, 'entryUuid');
    const tab = this.tabs.get(tabId);
    const current = tab?.get(handoffId);
    const proof = current?.value.auditProof || null;
    if (!tab || !current || current.value.queueStatus !== 'sent' || !proof) return undefined;

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (proof.sessionId && sessionId && proof.sessionId !== sessionId) return undefined;
    const sourceIdentity = typeof input.sourceIdentity === 'string'
      ? input.sourceIdentity.trim()
      : '';
    const sourceIdentityAliases = Array.isArray(input.sourceIdentityAliases)
      ? input.sourceIdentityAliases
        .filter((identity) => typeof identity === 'string' && identity.trim())
        .map((identity) => identity.trim())
      : [];
    const canonicalIdentity = {
      uuid: entryUuid,
      sourceIdentity,
      sourceIdentityAliases,
    };
    const exactAuditIdentity = proof.entryUuid || proof.sourceIdentity || '';
    if (!historyEntryHasExactIdentity(canonicalIdentity, exactAuditIdentity)) return undefined;
    if (proof.entryUuid === entryUuid) return current.value;

    // History has already resolved the provider alias to the canonical row.
    // Enrich the same immutable handoff before its presentation ACK consumes
    // it; status/hash/source ownership remain unchanged.
    const next = freezeHandoff({
      ...current.value,
      auditProof: {
        ...proof,
        entryUuid,
        sourceIdentity: proof.sourceIdentity || sourceIdentity || undefined,
      },
    });
    const approxBytes = estimateHandoffBytes(next);
    if (approxBytes > this.limits.maxBytes) return undefined;
    this.approxBytes += approxBytes - current.approxBytes;
    tab.set(handoffId, { value: next, approxBytes });
    this.promoteTab(tabId);
    this.enforceLimits(tabId, handoffId);
    if (!this.tabs.get(tabId)?.has(handoffId)) return undefined;
    this.notify(tabId, { type: 'canonical-adopt', handoffId });
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

  consumeMergedSource(tabId: string, handoffId: string): void {
    if (!this.consume(tabId, handoffId)) {
      // A durable merge is an explicit removal proof even if the bounded
      // handoff cache evicted the original while its History row stayed visible.
      this.notify(requireKey(tabId, 'tabId'), { type: 'consume', handoffId: requireKey(handoffId, 'handoffId') });
    }
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
      if (record.value.applicationQueueId) continue;
      if (record.value.statusReason === 'history-preparation-interrupted') continue;
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
const receiptlessPresentationDismissals = new Map<string, string>();
// Restore presentation/recovery only. A dispatched request may already have
// reached Main; absence of a renderer reply cannot authorize another Send.
try {
  for (const { input, phase, presentationDismissedAt, presentationDismissedReturnToken } of readHistorySendRecovery()) {
    if (Number.isFinite(presentationDismissedAt) && presentationDismissedAt > 0) {
      if (typeof presentationDismissedReturnToken === 'string' && presentationDismissedReturnToken) {
        receiptlessPresentationDismissals.set(JSON.stringify([input.tabId, input.handoffId]), presentationDismissedReturnToken);
      }
      continue;
    }
    historyPromptHandoffStore.begin({ ...input, initialReceipt: {
      queueStatus: phase === 'preparing' ? 'failed' : 'delivery-unknown',
      reason: phase === 'preparing' ? 'history-preparation-interrupted' : 'history-send-reply-interrupted',
    } });
  }
} catch (error) { console.warn('[HistorySendRecovery] restore failed:', error); }
export const hydrateHistoryPromptHandoffImages = (record: DurableHistorySendReceiptRecord) =>
  historyPromptHandoffStore.hydrateImagePresentation(record);

const createHistoryPromptHandoffId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `external-${uuid}`
    : `external-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function historyPromptHandoffAuditProofFromSendResult(
  result: any,
): HistoryPromptHandoffAuditProof | null {
  const topLevelExactAudit = result?.exactAuditConfirmed === true
    && typeof result?.auditTimestamp === 'string'
    && result.auditTimestamp
    && typeof result?.actualHash === 'string'
    && result.actualHash
    ? result
    : null;
  const audit = result?.codexAudit || result?.pasteAudit || topLevelExactAudit;
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
    ...(audit.recordByteOffset != null && Number.isSafeInteger(Number(audit.recordByteOffset))
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
  if (result.providerQueueAccepted === true && result.status === 'queued') {
    return null;
  }
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
  options: HistoryPromptHandoffStatusPresentationOptions = {},
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
    case 'application-queued':
      return {
        label: 'IN APP QUEUE', tone: 'info', pending: false,
        title: 'Сохранено в очереди приложения. Ещё не передано Claude/Codex',
      };
    case 'queued':
      return {
        label: 'QUEUED',
        tone: 'accent',
        pending: true,
        title: 'Сообщение принято очередью Claude/Codex и ждёт обработки',
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
        title: 'Исход отправки неизвестен: сообщение могло быть принято. Не отправляйте его повторно',
      };
    case 'sent':
      if (Number.isFinite(options.now)) {
        const changedAt = Number(options.statusChangedAt);
        if (!Number.isFinite(changedAt)
          || Number(options.now) >= changedAt + HISTORY_PROMPT_SENT_PRESENTATION_MS) {
          return null;
        }
      }
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
  const localCommandCandidate = isStandaloneAgentLocalCommand({
    prompt: input.text,
    imageCount: input.imagePaths?.length || 0,
    chipCount: input.promptChips?.length || 0,
  });
  const begun = store.begin({
    ...input,
    handoffId,
    requiresAuditIdentity: !localCommandCandidate,
  });
  if (input.initialStatus === 'preparing' && input.sendAttemptId
    && begun?.sendAttemptId === input.sendAttemptId
    && begun?.sendOperationKey === input.sendOperationKey) {
    store.advanceTransportPhase(input.tabId, handoffId, 'preparing');
  }

  try {
    const result = await input.send(handoffId);
    if (isAutomaticReadinessWaitReceipt(result) && input.sendAttemptId) {
      store.settle(input.tabId, handoffId, { queueStatus: 'application-queued',
        reason: 'automatic-readiness-wait', sendAttemptId: input.sendAttemptId,
        sendOperationKey: input.sendOperationKey, noWriteAttemptId: input.sendAttemptId,
        requiresAuditIdentity: true });
      return result; // the physical receipt stays NOT_SUBMITTED, never Sent
    }
    if (result?.applicationQueued === true && result?.applicationQueue?.version === 1) {
      store.bindSendIdentity(input.tabId, handoffId, { sendOperationKey: result.operationKey,
        applicationQueueId: result.applicationQueue.id });
      store.settle(input.tabId, handoffId, { queueStatus: 'application-queued',
        reason: 'application-queue-admitted', requiresAuditIdentity: true });
      return result;
    }
    const localCommandReceipt = projectAgentLocalCommandSendResult({
      candidate: localCommandCandidate,
      result,
    });
    const providerQueueReturned = !localCommandReceipt.handled
      && historyPromptAuditIsProviderQueueReturn(result?.pasteAudit || result);
    const provenNotSubmitted = result?.submitted === false
      || (result?.submitted === undefined && (
        result?.deliveryOutcome === 'not-submitted'
        || result?.receiptState === 'not-submitted'
        || result?.status === 'not-submitted'
      ));
    const failedWithoutSubmitProof = result?.success === false
      && result?.submitted !== true && !provenNotSubmitted;
    const cancelledBeforeSubmit = provenNotSubmitted && result?.deliveryUnknown !== true
      && (result?.cancelled === true || cancelledSendIntent(result));
    const transferred = !provenNotSubmitted && (localCommandReceipt.handled
      ? localCommandReceipt.transferred === true
      : !result
      || typeof result !== 'object'
      || result.success !== false
      || result.submitted === true);
    const unconfirmedStatus = localCommandReceipt.handled
      ? (localCommandReceipt.queueStatus === 'delivery-unknown' ? 'delivery-unknown' : null)
      : historyPromptHandoffUnconfirmedStatusFromSendResult(result);
    const proof = localCommandReceipt.handled
      ? null
      : historyPromptHandoffAuditProofFromSendResult(result);
    const queueStatus: SettledHistoryPromptHandoffStatus = localCommandReceipt.handled && transferred
      ? localCommandReceipt.queueStatus
      : failedWithoutSubmitProof
      ? 'delivery-unknown'
      : !transferred
      ? (cancelledBeforeSubmit ? 'cancelled' : 'failed')
      : providerQueueReturned
      ? 'cancelled'
      : (result?.success === false && result?.submitted === true && !unconfirmedStatus)
      ? 'failed'
      : unconfirmedStatus
        || (result?.queued === true ? 'queued' : 'sent');
    store.settle(input.tabId, handoffId, {
      queueStatus,
      // Keep the new exact negative receipt distinguishable from legacy
      // generic failures that were also labelled "before submit". Missing
      // fields alone must not turn an uncertain send into a safe retry/hide.
      reason: cancelledBeforeSubmit
        ? 'send-cancelled-before-submit'
        : provenNotSubmitted
        ? 'send-proven-not-submitted'
        : failedWithoutSubmitProof
          ? 'send-delivery-unknown'
        : !transferred
          ? 'send-refused-before-submit'
        : localCommandReceipt.handled
          ? localCommandReceipt.reason || 'agent-local-command-result'
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
      requiresAuditIdentity: transferred && !localCommandReceipt.handled,
    });
    return result && typeof result === 'object'
      ? { ...result, handoffId: result.handoffId || handoffId }
      : result;
  } catch (error) {
    const receipt = (error as any)?.sendReceipt;
    const beforeSubmit = receipt?.submitted === false;
    const cancelledBeforeSubmit = beforeSubmit && receipt?.deliveryUnknown !== true
      && (receipt?.cancelled === true || cancelledSendIntent(receipt));
    store.settle(input.tabId, handoffId, {
      queueStatus: cancelledBeforeSubmit ? 'cancelled' : beforeSubmit ? 'failed' : 'delivery-unknown',
      reason: cancelledBeforeSubmit ? 'send-cancelled-before-submit'
        : beforeSubmit ? 'send-error-before-submit' : 'send-error-without-delivery-proof',
      requiresAuditIdentity: !beforeSubmit,
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

export const recordHistorySendEnterAttempt = (data: BindHistoryPromptHandoffSendIdentityInput & {
  tabId: string; handoffId: string; enterAttemptAt?: number;
}) => historyPromptHandoffStore.recordEnterAttempt(data.tabId, data.handoffId, data);

export const recordHistorySendReturnControl = (control: any) => historyPromptHandoffStore.recordReturnControl(control);
export const recordHistorySendInputAttempt = (input: { tabId: string; handoffId: string;
  sendAttemptId?: string | null; sendOperationKey?: string | null; sendInputTiming?: HistoryPromptHandoff['sendInputTiming'] }) =>
  historyPromptHandoffStore.recordInputTiming(input.tabId, input.handoffId, input);
export const isHistorySendReturned = (tabId: string, handoffId: string) => historyPromptHandoffStore.isReturned(tabId, handoffId);
export const isHistorySendReturnRestored = (tabId: string, handoffId: string) => historyPromptHandoffStore.isRestored(tabId, handoffId);

export const prepareHistoryPromptHandoffPresentation = (tabId: string, handoffId: string,
  input: Pick<BeginHistoryPromptHandoffInput, 'text' | 'imagePaths'>) =>
  historyPromptHandoffStore.preparePresentation(tabId, handoffId, input);

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

export const adoptHistoryPromptHandoffCanonicalEntry = (
  tabId: string,
  handoffId: string,
  input: AdoptHistoryPromptHandoffCanonicalInput,
) => historyPromptHandoffStore.adoptCanonicalEntry(tabId, handoffId, input);

export const retractHistoryPromptHandoff = (
  tabId: string,
  handoffId: string,
  reason: string,
) => {
  return historyPromptHandoffStore.retract(tabId, handoffId, reason);
};

export const consumeHistoryPromptHandoff = (tabId: string, handoffId: string) => {
  removeHistorySendRecovery(tabId, handoffId);
  return historyPromptHandoffStore.consume(tabId, handoffId);
};

export const dismissReceiptlessHistoryPromptPresentation = (tabId: string, handoffId: string, input: any) => {
  // Called only after Main's successful exact absence read, not an IPC error.
  // Persist before removal; do NOT consume the recovery snapshot/assets.
  const marker = hideHistorySendRecoveryPresentation({ ...input, tabId, handoffId, text: input.text ?? input.content });
  if (marker.presentationDismissedReturnToken) {
    receiptlessPresentationDismissals.set(JSON.stringify([tabId, handoffId]), marker.presentationDismissedReturnToken);
  }
  return historyPromptHandoffStore.consume(tabId, handoffId);
};

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
  return matchesHistoryPromptExactProof(entry, { entryUuid, sourceIdentity });
}

const normalizeDurableDraftText = (value: unknown) => String(value || '')
  .replace(/\r\n/g, '\n')
  .trim();

/**
 * A proved pre-Enter failure remains a valid recovery source until the same
 * payload later appears in the provider transcript. This happens when the
 * automatic send stops, then the user presses Enter manually: delivery still
 * does not belong to the failed attempt, but restoring its draft forever is
 * equally false. The saved transcript boundary makes this stronger than a
 * same-text search over older history.
 */
export function durableHistoryNotSubmittedReceiptMatchesLaterCanonicalEntry(
  record: DurableHistorySendReceiptRecord,
  entry: DurableHistoryCanonicalPromptEntry,
) {
  if (record?.state !== 'not-submitted' || record?.surface !== 'desktop-history') return false;
  if (entry?.role !== 'user') return false;
  const receipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  const boundary = record?.transcriptBoundary && typeof record.transcriptBoundary === 'object'
    ? record.transcriptBoundary
    : {};
  const expectedText = normalizeDurableDraftText(receipt.promptText);
  const actualText = normalizeDurableDraftText(entry.content);
  if (!expectedText || expectedText !== actualText) return false;
  const exactSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const boundarySessionId = typeof boundary.sessionId === 'string' ? boundary.sessionId : '';
  const entrySessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
  if (!exactSessionId || !entrySessionId || exactSessionId !== entrySessionId) return false;
  if (boundarySessionId && boundarySessionId !== exactSessionId) return false;
  const boundaryOffset = Number(boundary.fileSize);
  const entryOffset = Number(entry.recordByteOffset);
  return boundary.available !== false
    && Number.isSafeInteger(boundaryOffset)
    && boundaryOffset >= 0
    && Number.isSafeInteger(entryOffset)
    && entryOffset >= boundaryOffset;
}

export function applyHistoryQueuedMessageMerge(result: any): boolean {
  const retired = result?.receiptRetired === true && result.record === null;
  if (result?.success !== true || result.version !== 1 || (!retired && result.record?.tabId !== result.tabId)
    || (!retired && result.record?.operationKey !== result.operationKey) || !Array.isArray(result.sourceHandoffIds)
    || !Array.isArray(result.sourceOperationKeys) || result.sourceHandoffIds.length !== 2 || result.sourceOperationKeys.length !== 2
    || (!retired && (result.record.applicationQueue?.merge?.version !== 1
      || JSON.stringify(result.record.applicationQueue.merge.sourceOperationKeys) !== JSON.stringify(result.sourceOperationKeys)))) return false;
  const originals = getHistoryPromptHandoffsSnapshot(result.tabId);
  for (let index = 0; index < 2; index++) {
    const handoffId = result.sourceHandoffIds[index], operationKey = result.sourceOperationKeys[index];
    if (typeof handoffId !== 'string' || operationKey !== `history:${result.tabId}:${handoffId}`) return false;
    const current = originals.find(value => value.handoffId === handoffId);
    if (current && (current.sendAttemptId || current.auditProof || current.providerQueueProof
      || current.sendOperationKey !== operationKey)) return false;
  }
  for (const handoffId of result.sourceHandoffIds) historyPromptHandoffStore.consumeMergedSource(result.tabId, handoffId);
  if (!retired) hydrateHistoryPromptHandoffFromDurableReceipt(result.record);
  return true;
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
  const applicationWaiting = record.applicationQueue?.version === 1
    && record.applicationQueue.state === 'waiting'
    && ((!attemptId && (record.state === 'reserved' || record.state === 'preparing'))
      || (record.applicationQueue.waitingBeforeInput === true && !!attemptId
        && record.applicationQueue.lastNoWriteAttemptId === attemptId && record.state === 'not-submitted'
        && (isAutomaticReadinessWaitReceipt(receipt) || isTabMessageNoInputReceipt(record))));
  const applicationNoWrite = record.applicationQueue?.version === 1
    && record.state === 'not-submitted';
  if ((record?.surface !== 'desktop-history' && record.applicationQueue?.version !== 1)
    || !tabId
    || !handoffId
    || !operationKey
    || (!attemptId && !applicationWaiting && !applicationNoWrite)
    || !toolType
    || !promptText) {
    return { hydrated: false, reason: 'durable-history-receipt-incomplete' };
  }
  const controlOwner = getHistoryPromptHandoffsSnapshot(tabId).find(value => value.handoffId === handoffId);
  if (controlOwner?.sendAttemptId && attemptId && controlOwner.sendAttemptId !== attemptId) {
    return { hydrated: false, reason: 'durable-history-receipt-owner-mismatch' };
  }
  if (record.historyReturn?.token && receiptlessPresentationDismissals.get(JSON.stringify([tabId, handoffId])) === record.historyReturn.token) {
    // An exact original return token can join its late durable identity. A
    // different/unproven owner is NOT hidden by the old receiptless card.
    // Canonical History, receipt/audit/FIFO and other handoffs are untouched.
    return { hydrated: false, reason: 'local-history-presentation-dismissed' };
  }
  const deliveryControl = historyPromptHandoffStore.observeDeliveryControl(record);
  if (record.historyReturn) recordHistorySendReturnControl(record.historyReturn);
  if (record.historyReturn?.state === 'restored' || hiddenSendPresentation(record) || deliveryControl?.hidden) {
    const current = getHistoryPromptHandoffsSnapshot(tabId).find(value => value.handoffId === handoffId);
    if (current && current.sendOperationKey === operationKey
      && (!current.sendAttemptId || current.sendAttemptId === attemptId)) consumeHistoryPromptHandoff(tabId, handoffId);
    return { hydrated: false, reason: 'durable-history-presentation-dismissed' };
  }
  if (record.state === 'not-submitted' && !applicationWaiting) {
    if (applicationNoWrite) {
      const current = getHistoryPromptHandoffsSnapshot(tabId).find(item => item.handoffId === handoffId);
      if (current && !historyPromptHandoffAcceptsAuditIdentity(current,
        { sendAttemptId: attemptId, sendOperationKey: operationKey })) {
        return { hydrated: false, reason: 'durable-history-receipt-owner-mismatch' };
      }
      const presentation = receipt.presentationSnapshot || {};
      const handoff = beginHistoryPromptHandoff({ tabId, handoffId, sendOperationKey: operationKey, sendAttemptId: attemptId,
        historyReturn: record.historyReturn,
        applicationQueueId: record.applicationQueue?.id,
        toolType, text: promptText, imagePaths: presentation.imagePaths || [],
        semanticTags: presentation.semanticTags,
        promptChips: presentation.promptChips || [], authoringText: receipt.authoringSnapshot?.editorText,
        authoringChips: receipt.authoringSnapshot?.chips, authoringImagePaths: receipt.authoringSnapshot?.imagePaths,
        submittedAt: Number(presentation.historySendStartedAt) || Number(record.createdAt),
        enterAttemptAt: receipt.enterAttemptAt, sendInputTiming: receipt.sendInputTiming, requiresAuditIdentity: true,
        initialReceipt: { queueStatus: receipt.cancelled || record.applicationQueue?.state === 'cancelled' ? 'cancelled' : 'failed',
          reason: receipt.code || 'application-queue-not-submitted' } });
      historyPromptHandoffStore.hydrateSemanticPresentation(record);
      if (handoff) removeHistorySendRecovery(tabId, handoffId);
      return { hydrated: !!handoff, reason: 'application-queue-not-submitted',
        handoff: getHistoryPromptHandoffsSnapshot(tabId).find(item => item.handoffId === handoffId) || handoff };
    }
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
  if (record.presentation) {
    return { hydrated: false, reason: 'durable-history-presentation-already-materialized' };
  }

  // Reading a receipt cannot begin/revert a retry that already has a different
  // owner. Only the send scenario can introduce a new attempt through begin().
  const existing = getHistoryPromptHandoffsSnapshot(tabId)
    .find((handoff) => handoff.handoffId === handoffId);
  if (existing && (!historyPromptHandoffAcceptsAuditIdentity(existing, {
    sendAttemptId: attemptId, sendOperationKey: operationKey,
  }) || existing.toolType !== toolType
    || (existing.sessionIdHint && record.sessionId && existing.sessionIdHint !== record.sessionId))) {
    return { hydrated: false, reason: 'durable-history-receipt-owner-mismatch' };
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
    && canProjectCurrentProviderQueue(record) && !deliveryControl?.retired && !deliveryControl?.cancelled
    && providerQueue.accepted === true
    && providerQueue.provider === toolType
    && providerQueue.operationKey === operationKey
    && providerQueue.attemptId === attemptId;
  let queueStatus: SettledHistoryPromptHandoffStatus | null = null;
  if (applicationWaiting) queueStatus = 'application-queued';
  else if (record.state === 'confirmed') queueStatus = 'sent';
  else if (deliveryControl?.retired || deliveryControl?.cancelled) queueStatus = 'delivery-unknown';
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
    : (providerQueueEntryUuid ? `${toolType}-queue:uuid:${providerQueueEntryUuid}` : '');
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
        ...(applicationWaiting && attemptId ? { noWriteAttemptId: attemptId } : {}),
        reason: queueStatus === 'sent'
          ? 'durable-audit-confirmed'
          : deliveryControl?.retired ? 'durable-input-slot-retired'
          : applicationWaiting ? record.surface === 'tab-message' ? 'message-application-wait' : 'automatic-readiness-wait'
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
    historyReturn: record.historyReturn,
    applicationQueueId: record.applicationQueue?.id,
    applicationQueuePosition: record.applicationQueue?.position ?? record.applicationQueue?.id,
    applicationQueuePresentationHandoffId: record.applicationQueue?.merge?.presentationHandoffId,
    applicationQueueMerge: record.applicationQueue?.mergePrevious || null,
    applicationQueueReplacement: record.applicationQueue?.merge?.version === 1,
    tabId,
    handoffId,
    sendAttemptId: attemptId,
    sendOperationKey: operationKey,
    toolType,
    sessionIdHint: typeof record.sessionId === 'string' ? record.sessionId : null,
    text: promptText,
    promptChips: Array.isArray(presentation.promptChips) ? presentation.promptChips : [],
    imagePaths: Array.isArray(presentation.imagePaths) ? presentation.imagePaths : [],
    semanticTags: Array.isArray(presentation.semanticTags) ? presentation.semanticTags : undefined,
    authoringText: receipt.authoringSnapshot?.editorText,
    authoringChips: receipt.authoringSnapshot?.chips,
    authoringImagePaths: receipt.authoringSnapshot?.imagePaths,
    submittedAt: Number(presentation.historySendStartedAt) || Number(record.applicationQueue?.queuedAt) || Number(record.createdAt) || Date.now(),
    enterAttemptAt: receipt.enterAttemptAt,
    sendInputTiming: receipt.sendInputTiming,
    source: typeof receipt.source === 'string' ? receipt.source : 'history-panel',
    statusAtSend: 'unknown',
    requiresAuditIdentity: true,
    initialProviderQueueProof,
    ...(initialReceipt ? { initialReceipt } : {}),
  });
  if (!begun) return { hydrated: false, reason: 'durable-history-handoff-bounds' };
  if (record.historyReturn) recordHistorySendReturnControl(record.historyReturn);
  const bound = bindHistoryPromptHandoffSendIdentity(tabId, handoffId, {
    applicationQueueId: record.applicationQueue?.id,
    sendAttemptId: attemptId,
    sendOperationKey: operationKey,
  });
  if (!bound.ok) return { hydrated: false, reason: bound.reason };
  const enteredHandoff = historyPromptHandoffStore.recordEnterAttempt(tabId, handoffId, {
    sendAttemptId: attemptId, sendOperationKey: operationKey, enterAttemptAt: receipt.enterAttemptAt,
  });
  const timedHandoff = historyPromptHandoffStore.recordInputTiming(tabId, handoffId, {
    sendAttemptId: attemptId, sendOperationKey: operationKey, sendInputTiming: receipt.sendInputTiming,
  }) || enteredHandoff;
  let hydratedHandoff = initialProviderQueueProof
    && bound.handoff.providerQueueProof?.sourceIdentity !== initialProviderQueueProof.sourceIdentity
    ? acceptHistoryPromptHandoffProviderQueue(tabId, handoffId, {
        sendAttemptId: attemptId,
        sendOperationKey: operationKey,
        proof: initialProviderQueueProof,
        changedAt: Number(record.updatedAt) || Date.now(),
    }) || bound.handoff
    : timedHandoff || bound.handoff;

  // The receipt may be the first creator or the first attempt binding of
  // this local card. Enrichment before begin/bind cannot prove that identity.
  // Reuse the same strict Main presentation proof after the owner exists;
  // do not infer a path from marker text, nor change its delivery outcome.
  if (hydrateHistoryPromptHandoffImages(record)) {
    hydratedHandoff = getHistoryPromptHandoffsSnapshot(tabId)
      .find(item => item.handoffId === handoffId) || hydratedHandoff;
  }
  if (historyPromptHandoffStore.hydrateSemanticPresentation(record)) {
    hydratedHandoff = getHistoryPromptHandoffsSnapshot(tabId)
      .find(item => item.handoffId === handoffId) || hydratedHandoff;
  }

  if (!queueStatus) {
    removeHistorySendRecovery(tabId, handoffId);
    return { hydrated: true, reason: 'durable-history-send-active', handoff: hydratedHandoff };
  }
  removeHistorySendRecovery(tabId, handoffId);
  return {
    hydrated: true,
    reason: 'durable-history-receipt-hydrated',
    handoff: hydratedHandoff,
  };
}
