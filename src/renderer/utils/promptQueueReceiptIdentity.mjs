function shortStableFingerprint(value) {
  const text = String(value || '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, '0')
    + (second >>> 0).toString(16).padStart(8, '0');
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TypeError(label + ' must be a non-empty string');
  return text;
}

/**
 * A queue item is one durable operation. Editing its payload changes the
 * operation suffix, while a renderer restart with the same item reuses it.
 * A Loop item intentionally repeats, so its exact causal turn is part of the
 * key: replaying one turn is idempotent; the next turn remains a new send.
 */
export function buildPromptQueueReceiptHandoffId({
  kind,
  itemId,
  payload,
  causeKey = null,
  armedAt = undefined,
}) {
  const normalizedKind = kind === 'loop' ? 'loop' : 'queue';
  const exactItemId = requiredText(itemId, 'itemId');
  const exactPayload = typeof payload === 'string'
    ? payload
    : (() => { throw new TypeError('payload must be a string'); })();
  const itemToken = encodeURIComponent(exactItemId);
  const payloadToken = exactPayload.length + '-' + shortStableFingerprint(exactPayload);
  if (normalizedKind === 'queue') {
    const base = 'run-after-' + itemToken + '-' + payloadToken;
    // New automatic intents distinguish an explicit Pause→Play from an
    // internal Resume. Legacy callers retain byte-for-byte operation keys.
    return armedAt === undefined ? base : base + '-arm-' + (armedAt === null ? 'none' : String(armedAt));
  }
  const exactCauseKey = requiredText(causeKey, 'causeKey');
  return 'prompt-loop-' + itemToken + '-' + encodeURIComponent(exactCauseKey)
    + '-' + payloadToken;
}

export function promptQueueReceiptReplayNeedsNoBusyStart(result) {
  if (!result || typeof result !== 'object' || result.replayed !== true) return false;
  return new Set([
    'confirmed',
    'audit-pending',
    'delivery-unknown',
    'enter-armed',
  ]).has(String(result.status || ''));
}

const PROMPT_QUEUE_PENDING_TRANSPORT_STATUSES = new Set([
  'preparing',
  'sending',
  'queued',
  'audit-pending',
]);

export function promptQueueHandoffMatchesItem(handoffId, itemId) {
  const exactHandoffId = String(handoffId || '');
  const exactItemId = String(itemId || '').trim();
  if (!exactHandoffId || !exactItemId) return false;
  const token = encodeURIComponent(exactItemId);
  return exactHandoffId.startsWith('run-after-' + token + '-')
    || exactHandoffId.startsWith('prompt-loop-' + token + '-');
}

/**
 * Project one exact queue handoff into the Run After UI. Text similarity is
 * deliberately absent: the durable handoff embeds the exact queue item id.
 */
export function selectPromptQueueTransportProgress(handoffs, itemIds = []) {
  const exactItemIds = Array.from(new Set(
    Array.isArray(itemIds)
      ? itemIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  ));
  let latest = null;
  for (const handoff of Array.isArray(handoffs) ? handoffs : []) {
    const source = String(handoff?.source || '');
    const queueStatus = String(handoff?.queueStatus || '');
    if (source !== 'prompt-queue' && source !== 'prompt-loop') continue;
    if (!PROMPT_QUEUE_PENDING_TRANSPORT_STATUSES.has(queueStatus)) continue;
    const itemId = source === 'prompt-loop'
      ? null
      : exactItemIds.find((candidate) => (
          promptQueueHandoffMatchesItem(handoff?.handoffId, candidate)
        )) || null;
    // A consumed/edited queue item must not inherit a stale handoff merely
    // because some old prompt is still awaiting transcript reconciliation.
    if (source === 'prompt-queue' && !itemId) continue;
    const changedAt = Number(handoff?.statusChangedAt || handoff?.submittedAt || 0);
    if (!latest || changedAt >= latest.changedAt) {
      latest = Object.freeze({
        handoffId: String(handoff?.handoffId || ''),
        itemId,
        queueStatus,
        changedAt,
      });
    }
  }
  return latest;
}
