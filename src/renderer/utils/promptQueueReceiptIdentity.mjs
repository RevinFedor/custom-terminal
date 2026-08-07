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
}) {
  const normalizedKind = kind === 'loop' ? 'loop' : 'queue';
  const exactItemId = requiredText(itemId, 'itemId');
  const exactPayload = typeof payload === 'string'
    ? payload
    : (() => { throw new TypeError('payload must be a string'); })();
  const itemToken = encodeURIComponent(exactItemId);
  const payloadToken = exactPayload.length + '-' + shortStableFingerprint(exactPayload);
  if (normalizedKind === 'queue') {
    return 'run-after-' + itemToken + '-' + payloadToken;
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

