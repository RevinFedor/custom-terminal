'use strict';

// Observe the held FULL pre-overlay semantic rows, never settingsFact,
// settingsBefore, thin stubs or a renderer's current selection. The existing
// utility remains the only slash parser AND timestamp reducer. At most two
// native scalar witnesses enter it at a time; no history DTO is built.
//
// OPEN: that unchanged utility requires a complete native content/timestamp
// scalar. Chunked cursor reads make cancellation cooperative, not its peak
// memory bounded. Returned model/effort are the selected ORIGINAL slash-content
// field descriptors, not bare model names or previews (see valueEncoding).
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const tick = () => new Promise(resolve => setImmediate(resolve));
let utility;
const reducer = () => utility ||= import('../../../shared/codex-history-effective-settings.mjs')
  .then(module => {
    if (typeof module.deriveCodexEffectiveSettingsFromHistory !== 'function') throw new TypeError('missing reducer');
    return module.deriveCodexEffectiveSettingsFromHistory;
  }).catch(cause => { throw fail('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_REDUCER_UNAVAILABLE', { cause }); });

async function scalar(cursor, check, checkpoint) {
  check();
  if (cursor.kind !== 'text') {
    if (!['undefined', 'scalar', 'scalar-root', 'number', 'bigint'].includes(cursor.kind)) {
      // A compound value cannot be called absent, nor decoded as a hidden DTO.
      throw fail('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_SCALAR_REQUIRED');
    }
    return cursor.scalar();
  }
  let value = '', steps = 0;
  for (const part of cursor.textChunks()) {
    check(); value += part; // Explicit single-scalar native compatibility sink.
    if (++steps % 32 === 0) await checkpoint();
  }
  check(); return value;
}

function isSlash(cursor, check) {
  if (cursor.kind !== 'text' || cursor.length !== 5) return false;
  let offset = 0;
  for (const part of cursor.textChunks()) {
    check();
    if (part !== 'slash'.slice(offset, offset + part.length)) return false;
    offset += part.length;
  }
  return offset === 5;
}

async function readPrimaryEffectiveSettings(plane, state, request, { consumerKey, control } = {}) {
  const allowed = ['leaseId', 'ownerKey', 'revision', 'generation', 'nodeToken', 'parentNodeToken', 'kind',
    'semanticIdentity', 'metadataIdentity', 'metadataSchema', 'semanticRevisionToken', 'viewRevisionToken',
    'canonicalEntryCount', 'creditBytes', 'readDemandId', 'diagnosticReadId', 'diagnosticActionId', '_historyRootConsumerKey'];
  const p = state.primaryPresentation;
  if (Object.keys(request).some(key => !allowed.includes(key)) || request.kind !== 'primary-effective-settings' || !p?.toolCoverageInputs
    || p.metadataSchema !== 1 || p.semanticSnapshotComplete !== true
    || p.headerCursor?.kind !== 'array' || p.durableMetadataCursor?.kind !== 'array'
    || request.metadataSchema !== p.metadataSchema || request.semanticIdentity !== p.semanticIdentity
    || request.metadataIdentity !== p.metadataIdentity || request.semanticRevisionToken !== p.semanticRevisionToken
    || request.viewRevisionToken !== p.viewRevisionToken || request.revision !== p.viewRevisionToken
    || !integer(request.canonicalEntryCount) || request.canonicalEntryCount !== p.canonicalEntryCount
    || !integer(request.creditBytes) || request.creditBytes < 512 || request.creditBytes > 65536
    || plane.cursor(state, request.parentNodeToken).identity() !== p.headerCursor.identity()
    || plane.cursor(state, request.nodeToken).identity() !== p.durableMetadataCursor.identity()
    || request.parentNodeToken !== plane.nodeToken(state, p.headerCursor)
    || request.nodeToken !== plane.nodeToken(state, p.durableMetadataCursor)) {
    throw fail('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_INVALID');
  }
  const { entries } = p.toolCoverageInputs();
  if (entries.kind !== 'array' || entries.length !== request.canonicalEntryCount
    || entries.identity() !== p.settingsIndexes?.entries?.identity()) {
    throw fail('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_CUT_REQUIRED');
  }
  const check = () => {
    control?.assertCurrent();
    if (control?.signal?.aborted) throw fail('HISTORY_READ_CANCELLED');
    if (plane.state(request, consumerKey) !== state || state.primaryPresentation !== p) {
      throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    }
    p.toolCoverageInputs(); // The semantic bundle must still own this exact cut.
  };
  const checkpoint = async () => {
    check(); if (control?.checkpoint) await control.checkpoint(); else await tick(); check();
  };
  check(); const derive = await reducer(); check();
  let model = null, effort = null, witness = null, proofAt = 0, ordinal = 0;
  for (const row of entries.rows()) {
    check();
    if (['object', 'array', 'map', 'set'].includes(row.kind) && isSlash(row.field('role'), check)) {
      const content = row.field('content');
      const native = { role: 'slash', content: await scalar(content, check, checkpoint) };
      check();
      // Classification also goes through the unchanged utility. Only matched
      // rows read timestamp, exactly as in the original function's control flow.
      const matched = derive([native]);
      if (matched) {
        native.timestamp = await scalar(row.field('timestamp'), check, checkpoint); check();
        const observed = derive(witness ? [witness, native] : [native]);
        // The retained witness carries the prefix's MAX matched finite time,
        // even after a later setting with an older/invalid timestamp wins.
        // No new Date.parse/Math.max or copy of either slash expression here.
        if (!witness || observed.proofAt > proofAt) witness = native;
        proofAt = observed.proofAt;
        if (own(matched, 'model')) model = content;
        if (own(matched, 'effort')) effort = content;
      }
    }
    if (++ordinal % 32 === 0) await checkpoint();
  }
  check();
  const packet = { success: true, ...plane.identity(state), nodeToken: request.nodeToken,
    parentNodeToken: request.parentNodeToken, kind: 'primary-effective-settings',
    semanticIdentity: p.semanticIdentity, metadataIdentity: p.metadataIdentity, metadataSchema: 1,
    semanticRevisionToken: p.semanticRevisionToken, viewRevisionToken: p.viewRevisionToken,
    canonicalEntryCount: entries.length, valueEncoding: 'slash-content-fields-v1',
    model: model ? plane.describe(state, model, { inline: false }) : null,
    effort: effort ? plane.describe(state, effort, { inline: false }) : null,
    proofAt, proof: model || effort ? 'rollout-turn-context' : null,
    producerBounded: false, nativeMemoryMeasured: false, creditBytesUsed: 0 };
  let previous;
  do { previous = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); }
  while (previous !== packet.creditBytesUsed);
  if (packet.creditBytesUsed > request.creditBytes) {
    throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
  }
  check();
  plane.metrics.maxPacketBytes = Math.max(plane.metrics.maxPacketBytes, packet.creditBytesUsed);
  plane.metrics.maxReturnedItems = Math.max(plane.metrics.maxReturnedItems, Number(!!model) + Number(!!effort));
  return packet;
}

module.exports = { readPrimaryEffectiveSettings };
