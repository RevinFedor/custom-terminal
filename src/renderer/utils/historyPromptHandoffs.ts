export type HistoryPromptHandoffTool = 'claude' | 'codex';

export type HistoryPromptHandoffStatus =
  | 'sending'
  | 'queued'
  | 'sent'
  | 'cancelled'
  | 'failed';

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
  actualLen?: number;
  canonicalized?: boolean;
  canonicalReason?: string;
}

export interface HistoryPromptHandoff {
  tabId: string;
  handoffId: string;
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
}

export interface BeginHistoryPromptHandoffInput {
  tabId: string;
  handoffId: string;
  toolType: HistoryPromptHandoffTool;
  sessionIdHint?: string | null;
  text: string;
  promptChips?: readonly HistoryPromptHandoffChip[];
  imagePaths?: readonly HistoryPromptHandoffImageRef[];
  submittedAt?: number;
  source?: string;
  statusAtSend?: HistoryPromptHandoffAgentStatus;
  requiresAuditIdentity?: boolean;
}

export interface SettleHistoryPromptHandoffInput {
  queueStatus: Exclude<HistoryPromptHandoffStatus, 'sending'>;
  reason: string;
  proof?: HistoryPromptHandoffAuditProof | null;
  requiresAuditIdentity?: boolean;
  changedAt?: number;
}

export interface RunHistoryPromptHandoffInput
  extends Omit<BeginHistoryPromptHandoffInput, 'handoffId'> {
  handoffId?: string;
  send: (handoffId: string) => Promise<any>;
}

export type HistoryPromptHandoffChange =
  | { type: 'replay' }
  | { type: 'begin'; handoffId: string }
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

export const DEFAULT_HISTORY_PROMPT_HANDOFF_LIMITS:
  Readonly<HistoryPromptHandoffStoreLimits> = Object.freeze({
    maxTabs: 16,
    maxHandoffs: 128,
    maxBytes: 8 * 1024 * 1024,
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
    + stringBytes(value.toolType)
    + stringBytes(value.sessionIdHint)
    + stringBytes(value.text)
    + stringBytes(value.source)
    + stringBytes(value.statusAtSend)
    + stringBytes(value.queueStatus)
    + stringBytes(value.statusReason);
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
    ...(Number.isFinite(proof.actualLen) ? { actualLen: Number(proof.actualLen) } : {}),
    ...(proof.canonicalized === true ? { canonicalized: true } : {}),
    ...(typeof proof.canonicalReason === 'string'
      ? { canonicalReason: proof.canonicalReason }
      : {}),
  });
}

function freezeHandoff(value: HistoryPromptHandoff): Readonly<HistoryPromptHandoff> {
  return Object.freeze({
    ...value,
    promptChips: Object.freeze(value.promptChips.map(freezeChip)),
    imagePaths: Object.freeze(value.imagePaths.map(freezeImageRef)),
    auditProof: freezeProof(value.auditProof),
  });
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
      return existing.value;
    }

    const now = Date.now();
    const submittedAt = finiteTimestamp(input.submittedAt, now);
    const value = freezeHandoff({
      tabId,
      handoffId,
      toolType: input.toolType,
      sessionIdHint: typeof input.sessionIdHint === 'string' ? input.sessionIdHint : null,
      text: String(input.text || ''),
      promptChips: input.promptChips || [],
      imagePaths: input.imagePaths || [],
      submittedAt,
      source: typeof input.source === 'string' ? input.source : '',
      statusAtSend: input.statusAtSend || 'unknown',
      queueStatus: 'sending',
      statusReason: 'send-start',
      statusChangedAt: submittedAt,
      requiresAuditIdentity: input.requiresAuditIdentity !== false,
      auditProof: null,
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

    const next = freezeHandoff({
      ...current.value,
      queueStatus: input.queueStatus,
      statusReason: String(input.reason || ''),
      statusChangedAt: finiteTimestamp(input.changedAt, Date.now()),
      // Exact identity is monotonic. Once a sender declares that a local row
      // needs audit proof, a timeout/mismatch cannot downgrade it to text/time
      // similarity and accidentally adopt an older identical prompt.
      requiresAuditIdentity: current.value.requiresAuditIdentity
        || input.requiresAuditIdentity === true,
      auditProof: input.proof === undefined
        ? current.value.auditProof
        : freezeProof(input.proof),
    });
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
    ...(Number.isFinite(audit.actualLen) ? { actualLen: Number(audit.actualLen) } : {}),
    ...(audit.canonicalized === true ? { canonicalized: true } : {}),
    ...(typeof audit.canonicalReason === 'string'
      ? { canonicalReason: audit.canonicalReason }
      : {}),
  };
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
    const transferred = !result
      || typeof result !== 'object'
      || result.success !== false
      || result.submitted === true;
    const lateAuditPending = result?.codexAudit?.lateReconciliationPending === true
      || result?.pasteAudit?.lateReconciliationPending === true;
    const proof = historyPromptHandoffAuditProofFromSendResult(result);
    const queueStatus: Exclude<HistoryPromptHandoffStatus, 'sending'> = !transferred
      || (result?.success === false && result?.submitted === true && !lateAuditPending)
      ? 'failed'
      : result?.queued === true
        ? 'queued'
        : 'sent';
    store.settle(input.tabId, handoffId, {
      queueStatus,
      reason: !transferred
        ? 'send-refused-before-submit'
        : queueStatus === 'failed'
          ? 'send-submitted-audit-failed'
          : lateAuditPending
            ? 'send-submitted-audit-pending'
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
