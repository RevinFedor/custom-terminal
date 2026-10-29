'use strict';

// Selected complete semantic rows from the held primary cut. This dedicated
// profile proves traversal scope/count/progress even for zero rows; generic
// range/field success cannot stand in for canonical absence. Neither metadata
// bodies nor the full canonical/prepared collection are materialized here.
const PROFILE = 'primary-canonical-consumers-v1';
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const wireBytes = value => Buffer.byteLength(JSON.stringify(value));
const ALLOWED = new Set(['leaseId', 'ownerKey', 'revision', 'generation', 'nodeToken', 'parentNodeToken',
  'kind', 'profile', 'scope', 'offset', 'limit', 'semanticIdentity', 'metadataIdentity', 'metadataSchema',
  'semanticRevisionToken', 'viewRevisionToken', 'canonicalEntryCount', 'sourceEntryCount', 'creditBytes',
  'readDemandId', 'diagnosticReadId', 'diagnosticActionId', '_historyRootConsumerKey']);

async function readPrimaryCanonicalConsumers(plane, state, request, { consumerKey, control } = {}) {
  const p = state.primaryPresentation;
  const invalid = () => fail('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_INVALID');
  if (Object.keys(request).some(key => !ALLOWED.has(key))
    || request.kind !== 'primary-canonical-consumers' || request.profile !== PROFILE
    || !['canonical', 'prepared'].includes(request.scope)
    || !p?.toolCoverageInputs || !p.presentationSource || p.metadataSchema !== 1 || p.semanticSnapshotComplete !== true
    || p.headerCursor?.kind !== 'array' || p.durableMetadataCursor?.kind !== 'array' || p.sourceMetadataCursor?.kind !== 'array'
    || request.metadataSchema !== 1 || request.semanticIdentity !== p.semanticIdentity || request.metadataIdentity !== p.metadataIdentity
    || request.semanticRevisionToken !== p.semanticRevisionToken || request.viewRevisionToken !== p.viewRevisionToken
    || request.revision !== p.viewRevisionToken
    || !integer(request.canonicalEntryCount) || request.canonicalEntryCount !== p.canonicalEntryCount
    || !integer(request.sourceEntryCount) || request.sourceEntryCount !== p.sourceMetadataCursor.length
    || !integer(request.offset) || !integer(request.limit) || request.limit < 1 || request.limit > 3
    || !integer(request.creditBytes) || request.creditBytes < 512 || request.creditBytes > 65536
    || wireBytes(request) > 65536) throw invalid();

  const metadata = request.scope === 'canonical' ? p.durableMetadataCursor : p.sourceMetadataCursor;
  if (request.parentNodeToken !== plane.nodeToken(state, p.headerCursor)
    || request.nodeToken !== plane.nodeToken(state, metadata)
    || plane.cursor(state, request.parentNodeToken).identity() !== p.headerCursor.identity()
    || plane.cursor(state, request.nodeToken).identity() !== metadata.identity()) throw invalid();

  const check = () => {
    control?.assertCurrent();
    if (control?.signal?.aborted) throw fail('HISTORY_READ_CANCELLED');
    if (plane.state(request, consumerKey) !== state || state.primaryPresentation !== p) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    p.toolCoverageInputs();
  };
  check();
  const canonical = p.toolCoverageInputs().entries;
  const prepared = p.presentationSource();
  if (canonical?.kind !== 'array' || prepared?.kind !== 'array'
    || canonical.length !== request.canonicalEntryCount || prepared.length !== request.sourceEntryCount
    || p.durableMetadataCursor.length !== canonical.length
    || canonical.identity() !== p.settingsIndexes?.entries?.identity()) {
    throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMERS_CUT_REQUIRED');
  }
  p.settingsIndexes.assertOpen();
  const source = request.scope === 'canonical' ? canonical : prepared;
  if (request.offset > source.length) throw invalid();
  const packet = { success: true, ...plane.identity(state), kind: request.kind, profile: PROFILE, scope: request.scope,
    nodeToken: request.nodeToken, parentNodeToken: request.parentNodeToken,
    semanticIdentity: p.semanticIdentity, metadataIdentity: p.metadataIdentity, metadataSchema: 1,
    semanticRevisionToken: p.semanticRevisionToken, viewRevisionToken: p.viewRevisionToken,
    canonicalEntryCount: canonical.length, sourceEntryCount: prepared.length,
    root: plane.describe(state, source, { inline: false }), total: source.length,
    offset: request.offset, nextOffset: request.offset, done: false, items: [], creditBytesUsed: 0 };
  // No hidden scan: each page touches at most three complete row descriptors.
  // Subsequent field/text reads use the existing signed cursor/child lease API.
  for (let at = request.offset; at < source.length && packet.items.length < Math.min(request.limit, plane.maxItems, 3); at++) {
    check();
    const row = source.at(at);
    if (row.kind !== 'object') throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMERS_ROW');
    packet.items.push({ ordinal: at, row: plane.describe(state, row, { inline: false }) });
    packet.nextOffset = at + 1;
  }
  packet.done = packet.nextOffset === source.length;
  let previous;
  do { previous = packet.creditBytesUsed; packet.creditBytesUsed = wireBytes(packet); }
  while (previous !== packet.creditBytesUsed);
  if (packet.creditBytesUsed > request.creditBytes) {
    throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
  }
  check();
  plane.metrics.pages++;
  plane.metrics.maxPacketBytes = Math.max(plane.metrics.maxPacketBytes, packet.creditBytesUsed);
  plane.metrics.maxReturnedItems = Math.max(plane.metrics.maxReturnedItems, packet.items.length);
  return packet;
}

module.exports = { readPrimaryCanonicalConsumers, HISTORY_PRIMARY_CANONICAL_CONSUMERS_PROFILE: PROFILE };
