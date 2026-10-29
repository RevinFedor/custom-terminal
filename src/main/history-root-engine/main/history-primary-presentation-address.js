'use strict';

// Direct addresses from one immutable prepared presentation. This capability
// has no mutation authority. No source/body array crosses this query; a long
// selector receives a signed paged scan source and returns by source ordinal.
const PROFILE = 'primary-presentation-address-v1';
const MODES = ['range', 'uuid', 'group', 'key', 'target', 'scan', 'source-rank'];
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textInput = value => typeof value === 'string' && value.length <= 2048 && Buffer.byteLength(value) <= 4096;
const truth = cursor => cursor.kind === 'text' ? cursor.length > 0
  : ['object', 'array', 'map', 'set'].includes(cursor.kind) ? true : !!cursor.scalar();
const choose = (...cursors) => cursors.find(truth) || cursors.at(-1);

function validTool(tool) {
  if (tool === null) return true;
  if (!record(tool) || Object.keys(tool).some(key => !['toolUseId', 'messageReference'].includes(key))) return false;
  if (tool.messageReference !== undefined) {
    const ref = tool.messageReference;
    return record(ref) && Object.keys(ref).every(key => ['physicalSessionId', 'sessionId', 'transcriptSegmentId', 'rawUuid'].includes(key)
      && textInput(ref[key])) && (tool.toolUseId === undefined || textInput(tool.toolUseId));
  }
  return textInput(tool.toolUseId);
}

async function readPrimaryPresentationAddresses(plane, state, request, { consumerKey, control } = {}) {
  const allowed = ['leaseId', 'ownerKey', 'revision', 'generation', 'nodeToken', 'kind', 'profile', 'mode',
    'semanticIdentity', 'metadataIdentity', 'semanticRevisionToken', 'viewRevisionToken',
    'offset', 'limit', 'value', 'tool', 'creditBytes', 'readDemandId', 'diagnosticReadId',
    'diagnosticActionId', '_historyRootConsumerKey'];
  const p = state.primaryPresentation;
  if (!record(request) || Object.keys(request).some(key => !allowed.includes(key))
    || request.kind !== 'primary-presentation-address' || request.profile !== PROFILE
    || !p?.presentationSource || p.semanticSnapshotComplete !== true || p.metadataSchema !== 1
    || request.semanticIdentity !== p.semanticIdentity || request.metadataIdentity !== p.metadataIdentity
    || request.semanticRevisionToken !== p.semanticRevisionToken || request.viewRevisionToken !== p.viewRevisionToken
    || request.revision !== p.viewRevisionToken || !MODES.includes(request.mode)
    || !integer(request.offset) || !integer(request.limit) || request.limit < 1 || request.limit > 3
    || !integer(request.creditBytes) || request.creditBytes < 512 || request.creditBytes > 65536
    || !validTool(request.tool) || request.mode !== 'target' && request.tool !== null
    || (['range', 'scan', 'source-rank'].includes(request.mode) ? request.value !== null : !textInput(request.value))
    || !['range', 'source-rank'].includes(request.mode) && request.offset !== 0
    || plane.cursor(state, request.nodeToken).identity() !== p.headerCursor.identity()
    || request.nodeToken !== plane.nodeToken(state, p.headerCursor)) {
    throw fail('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
  }
  let requestBytes;
  try { requestBytes = Buffer.byteLength(JSON.stringify(request)); }
  catch { throw fail('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID'); }
  if (requestBytes > 65536) throw fail('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
  const source = p.presentationSource();
  if (source.kind !== 'array') throw fail('HISTORY_PRIMARY_ADDRESS_SOURCE');
  const absent = source.at(source.length);
  const field = (cursor, name) => ['object', 'array', 'map', 'set'].includes(cursor.kind) ? cursor.field(name) : absent;
  const check = () => {
    control?.assertCurrent();
    if (control?.signal?.aborted) throw fail('HISTORY_READ_CANCELLED');
    if (plane.state(request, consumerKey) !== state || state.primaryPresentation !== p) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    p.presentationSource();
  };
  let work = 0;
  const checkpoint = async () => {
    if (++work % 64 === 0) {
      if (control?.checkpoint) await control.checkpoint();
      else await new Promise(resolve => setImmediate(resolve));
    }
    check();
  };
  const equal = async (cursor, value) => {
    check();
    if (cursor.kind !== 'text') return !['object', 'array', 'map', 'set'].includes(cursor.kind) && cursor.scalar() === value;
    if (typeof value !== 'string' || cursor.length !== value.length) return false;
    let at = 0;
    for (const chunk of cursor.textChunks()) {
      if (chunk !== value.slice(at, at + chunk.length)) return false;
      at += chunk.length; await checkpoint();
    }
    return at === value.length;
  };
  const identity = async (row, value) => {
    if (!value) return false;
    if (await equal(row.field('uuid'), value) || await equal(row.field('sourceIdentity'), value)) return true;
    for (const name of ['sourceIdentityAliases', 'sourceUuidAliases']) {
      const aliases = row.field(name);
      if (aliases.kind === 'array') for (const alias of aliases.rows()) {
        if (await equal(alias, value)) return true;
        await checkpoint();
      }
    }
    return false;
  };
  const targetMatches = async row => {
    const tool = request.tool, ref = tool?.messageReference;
    if (ref) {
      const entryRef = row.field('entryRef');
      const physical = choose(field(entryRef, 'physicalSessionId'), row.field('physicalSessionId'), row.field('sessionId'));
      const raw = choose(field(entryRef, 'rawUuid'), row.field('rawUuid'), row.field('uuid'));
      const segment = choose(field(entryRef, 'segmentId'), row.field('transcriptSegmentId'));
      if (!await equal(physical, ref.physicalSessionId || ref.sessionId)) return false;
      if (ref.transcriptSegmentId && !await equal(segment, ref.transcriptSegmentId)) return false;
      if (ref.rawUuid && !await equal(raw, ref.rawUuid)) return false;
      return await identity(row, request.value.trim()) || !!ref.rawUuid
        && await equal(raw, ref.rawUuid) && await equal(physical, ref.physicalSessionId);
    }
    if (tool) {
      if (!await equal(row.field('role'), 'assistant')) return false;
      const actions = row.field('actions');
      if (actions.kind === 'array') for (const action of actions.rows()) {
        if (await equal(field(field(action, 'rawTool'), 'toolUseId'), tool.toolUseId)) return true;
        await checkpoint();
      }
      return false;
    }
    return identity(row, request.value.trim());
  };
  const packet = { success: true, ...plane.identity(state), nodeToken: request.nodeToken,
    kind: 'primary-presentation-address', profile: PROFILE, mode: request.mode,
    semanticIdentity: p.semanticIdentity, metadataIdentity: p.metadataIdentity,
    semanticRevisionToken: p.semanticRevisionToken, viewRevisionToken: p.viewRevisionToken,
    totalCount: p.headerCursor.length, sourceCount: source.length, offset: request.offset,
    nextOffset: request.offset, done: true, status: 'absent', items: [], source: null, creditBytesUsed: 0 };
  const bytes = () => {
    let previous;
    do { previous = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); }
    while (previous !== packet.creditBytesUsed);
    return packet.creditBytesUsed;
  };
  const item = (rank, sourceOrdinal = null) => {
    if (!integer(rank) || rank >= packet.totalCount) throw fail('HISTORY_PRIMARY_ADDRESS_RANK');
    const header = p.headerAt(rank);
    if (!header || header.field('rank').scalar() !== rank || header.field('physicalKey').kind !== 'text') throw fail('HISTORY_PRIMARY_ADDRESS_HEADER');
    return { rank, header: plane.describe(state, header, { inline: false }), sourceOrdinal,
      entry: sourceOrdinal === null ? null : plane.describe(state, source.at(sourceOrdinal), { inline: false }) };
  };
  const atSource = ordinal => {
    if (!integer(ordinal) || ordinal >= source.length) throw fail('HISTORY_PRIMARY_ADDRESS_SOURCE_RANK');
    const address = p.presentationSourceAddress(ordinal);
    if (address) { packet.items.push(item(address.index, ordinal)); packet.status = 'found'; }
  };
  check();
  if (request.mode === 'range') {
    if (request.offset > packet.totalCount) throw fail('HISTORY_PRIMARY_ADDRESS_RANK');
    packet.status = 'range';
    for (let rank = request.offset; rank < packet.totalCount && packet.items.length < Math.min(request.limit, plane.maxItems, 3); rank++) {
      check(); packet.items.push(item(rank)); packet.nextOffset = rank + 1;
      packet.done = packet.nextOffset === packet.totalCount;
      const required = bytes();
      if (required > request.creditBytes) {
        packet.items.pop(); packet.nextOffset = rank; packet.done = false;
        if (!packet.items.length) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: required });
        break;
      }
    }
    packet.done = packet.nextOffset === packet.totalCount;
  } else if (request.mode === 'scan') {
    packet.status = 'scan'; packet.source = plane.describe(state, source, { inline: false });
  } else if (request.mode === 'source-rank') atSource(request.offset);
  else if (request.mode === 'uuid') {
    const ordinal = p.presentationSourceOrdinal(request.value);
    if (ordinal !== null) atSource(ordinal);
  } else if (request.mode === 'group' || request.mode === 'key') {
    const address = request.mode === 'group' ? p.presentationGroupAddress(request.value) : p.presentationKeyAddress(request.value);
    if (address?.ambiguous) packet.status = 'ambiguous';
    else if (address) { packet.items.push(item(address.index)); packet.status = 'found'; }
  } else {
    let selected = null, ambiguous = false;
    for (let ordinal = 0; ordinal < source.length; ordinal++) {
      check();
      if (await targetMatches(source.at(ordinal))) {
        if (selected !== null) { ambiguous = true; break; }
        selected = ordinal;
        if (!request.tool) break; // Legacy alias navigation selects the first exact row.
      }
      await checkpoint();
    }
    if (ambiguous) packet.status = 'ambiguous';
    else if (selected !== null) atSource(selected);
  }
  check();
  if (bytes() > request.creditBytes) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
  plane.metrics.pages++; plane.metrics.maxPacketBytes = Math.max(plane.metrics.maxPacketBytes, packet.creditBytesUsed);
  plane.metrics.maxReturnedItems = Math.max(plane.metrics.maxReturnedItems, packet.items.length);
  return packet;
}

module.exports = { readPrimaryPresentationAddresses, HISTORY_PRIMARY_ADDRESS_PROFILE: PROFILE };
