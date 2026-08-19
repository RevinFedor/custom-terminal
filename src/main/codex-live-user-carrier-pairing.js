'use strict';

const {
  codexUserCarrierTextsMatch,
} = require('./codex-prompt-audit');

const CARRIER_RESPONSE = 'response_item';
const CARRIER_EVENT = 'event_msg';
const CLEAR_ALL_BOUNDARIES = new Set([
  'task_complete',
  'turn_aborted',
  'thread_rolled_back',
]);

function exactString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function imageRefIdentity(ref) {
  if (typeof ref === 'string') return 'string:' + ref;
  if (!ref || typeof ref !== 'object') return '';
  const stable = exactString(
    ref.assetId
    || ref.path
    || ref.imagePath
    || ref.url
    || ref.src,
  );
  if (stable) return 'ref:' + stable;
  try {
    return 'json:' + JSON.stringify(ref);
  } catch {
    return '';
  }
}

function mergeImagePaths(primary, secondary) {
  const merged = [];
  const seen = new Set();
  for (const ref of [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(secondary) ? secondary : []),
  ]) {
    const identity = imageRefIdentity(ref);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    merged.push(ref);
  }
  return merged;
}

function mergeExactSourceAliases(canonical, companion) {
  const sourceIdentity = exactString(canonical?.sourceIdentity);
  const aliases = [];
  const append = (value) => {
    const identity = exactString(value);
    if (!identity || identity === sourceIdentity || aliases.includes(identity)) return;
    aliases.push(identity);
  };
  for (const alias of Array.isArray(canonical?.sourceIdentityAliases)
    ? canonical.sourceIdentityAliases
    : []) append(alias);
  append(companion?.sourceIdentity);
  for (const alias of Array.isArray(companion?.sourceIdentityAliases)
    ? companion.sourceIdentityAliases
    : []) append(alias);
  return aliases;
}

function mergeCanonicalEventProjection(eventCarrier, responseCarrier) {
  const canonical = eventCarrier.projection;
  const companion = responseCarrier.projection;
  const message = {
    ...canonical.message,
  };
  const aliases = mergeExactSourceAliases(canonical.message, companion.message);
  if (aliases.length > 0) message.sourceIdentityAliases = aliases;
  else delete message.sourceIdentityAliases;
  const imagePaths = mergeImagePaths(
    canonical.message?.imagePaths,
    companion.message?.imagePaths,
  );
  if (imagePaths.length > 0) message.imagePaths = imagePaths;
  else delete message.imagePaths;
  return {
    ...canonical,
    message,
    promptOwner: canonical.promptOwner || companion.promptOwner || null,
  };
}

function normalizeCarrier(input) {
  const kind = input?.kind;
  if (kind !== CARRIER_RESPONSE && kind !== CARRIER_EVENT) return null;
  const projection = input?.projection;
  const sourceIdentity = exactString(projection?.message?.sourceIdentity);
  const uuid = exactString(projection?.message?.uuid);
  const sessionId = exactString(
    projection?.message?.sessionId
    || projection?.sessionId,
  );
  const text = String(input?.text || '');
  if (!projection || !sourceIdentity || !uuid || !sessionId || !text) return null;
  return {
    kind,
    text,
    sourceIdentity,
    sessionId,
    byteOffset: Number.isFinite(input?.byteOffset)
      ? Number(input.byteOffset)
      : null,
    projection,
  };
}

function carrierCanPair(left, right, textsMatch) {
  if (!left || !right || left.kind === right.kind) return false;
  if (left.sessionId !== right.sessionId) return false;
  if (left.sourceIdentity === right.sourceIdentity) return false;
  if (Number.isFinite(left.byteOffset)
    && Number.isFinite(right.byteOffset)
    && left.byteOffset >= right.byteOffset) return false;
  return textsMatch(left.text, right.text);
}

/**
 * Pairs the two structural Codex user carriers across separate file appends.
 *
 * A response_item remains a valid fallback when a protocol generation omits
 * event_msg. Therefore it is published immediately, then upgraded by exact
 * source identity when the canonical event carrier arrives. Pairing is only
 * cross-kind, same-session, monotonically ordered and FIFO. Text participates
 * solely through the same image-aware carrier-equivalence contract as the
 * durable projectors; text by itself is never enough to merge two rows.
 */
function createCodexLiveUserCarrierPairer({
  textsMatch = codexUserCarrierTextsMatch,
} = {}) {
  let pendingResponses = [];
  let pendingEvents = [];

  const accept = (input = {}) => {
    const carrier = normalizeCarrier(input);
    if (!carrier) {
      return {
        paired: false,
        reason: 'exact-carrier-identity-unavailable',
        projections: input?.publish === false || !input?.projection
          ? []
          : [input.projection],
      };
    }
    const opposite = carrier.kind === CARRIER_EVENT
      ? pendingResponses
      : pendingEvents;
    const pendingIndex = opposite.findIndex((candidate) => (
      carrierCanPair(candidate, carrier, textsMatch)
    ));
    if (pendingIndex >= 0) {
      const companion = opposite.splice(pendingIndex, 1)[0];
      const eventCarrier = carrier.kind === CARRIER_EVENT ? carrier : companion;
      const responseCarrier = carrier.kind === CARRIER_RESPONSE ? carrier : companion;
      return {
        paired: true,
        reason: 'exact-cross-carrier-pair',
        responseSourceIdentity: responseCarrier.sourceIdentity,
        eventSourceIdentity: eventCarrier.sourceIdentity,
        projections: [mergeCanonicalEventProjection(eventCarrier, responseCarrier)],
      };
    }

    if (carrier.kind === CARRIER_EVENT) pendingEvents.push(carrier);
    else pendingResponses.push(carrier);
    return {
      paired: false,
      reason: 'awaiting-companion-carrier',
      projections: input.publish === false ? [] : [carrier.projection],
    };
  };

  const observeBoundary = (boundary) => {
    const kind = exactString(boundary);
    if (kind === 'task_started') {
      // Mirrors the durable projector: an event-first canonical user belongs
      // to the current turn only. Response fallbacks may precede task_started
      // in real Codex rollouts, so they remain eligible for the event after it.
      pendingEvents = [];
    } else if (CLEAR_ALL_BOUNDARIES.has(kind)) {
      pendingResponses = [];
      pendingEvents = [];
    }
  };

  const snapshot = () => ({
    pendingResponses: pendingResponses.map((carrier) => carrier.sourceIdentity),
    pendingEvents: pendingEvents.map((carrier) => carrier.sourceIdentity),
  });

  return { accept, observeBoundary, snapshot };
}

module.exports = {
  CARRIER_EVENT,
  CARRIER_RESPONSE,
  createCodexLiveUserCarrierPairer,
};
