// Environment-neutral readers for Main jobs and desktop. These are
// cursor/document capabilities, never Arrays, Strings, Proxies or Send receipts.
// The legacy positional API is kept by historyReadTransport; callers must opt
// into the cursor API and handle an explicit legacy response at that boundary.
const IDENTITY = ['leaseId', 'ownerKey', 'revision', 'generation'];
const failure = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const MAX_CREDIT_BYTES = 64 * 1024;
const PRIMARY_METADATA_WINDOW = 'primary-metadata-fields-v1';
const PRIMARY_PRESENTATION_ADDRESSES = 'primary-presentation-address-v1';
const PRIMARY_CANONICAL_CONSUMERS = 'primary-canonical-consumers-v1';
const PRIMARY_CANONICAL_VALUE_ENCODING = 'history-canonical-consumer-text-v1';
const PRIMARY_CANONICAL_METADATA = 'primary-canonical-metadata-v1';
const PRIMARY_PREPARED_PRESENTATION = 'primary-prepared-presentation-v1';
const PREPARED_PRESENTATION_ENCODING = 'history-primary-prepared-presentation-v1';
const PREPARED_CAP_FIELDS = Object.freeze(['profile', 'schema', 'sourceProof', 'validationDigest', 'validationToken']);
const checkedPreparedPresentations = new WeakSet();
const CANONICAL_METADATA_FIELDS = Object.freeze(['uuid', 'sourceIdentity', 'contentRevision', 'recordByteOffset',
  'sessionId', 'liveProjection', 'sourceSequence']);
const CANONICAL_SOURCE_FIELDS = Object.freeze(['filePath', 'sessionId', 'size', 'mtimeMs', 'ctimeMs',
  'fileIdentity', 'linkKind', 'sourceGeneration']);
const CANONICAL_CAP_FIELDS = Object.freeze(['profile', 'schema', 'sourceProof', 'validationDigest',
  'diagnosticTailDigest', 'validationToken']);
// Header string limits are UTF8 bytes; each admitted byte needs at most six
// JSON code units when escaped. Fixed keys, finite numbers and signed-zero
// tags fit the remaining 1024 units. This scratch bound is independent of the
// unchanged 64 KiB request/response credit and never scales with row count.
const MAX_CANONICAL_METADATA_JSON_CHARS = 6 * (4096 + 4096 + 2048 + 2048) + 1024;
const checkedCanonicalMetadataFacts = new WeakSet();
const invalidDiagnosticMetadata = Object.freeze({ kind: 'invalid-diagnostic-metadata' });
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCredit = value => integer(value) && value >= 512 && value <= MAX_CREDIT_BYTES;
const checkWireCredit = (value, creditBytes) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes !== value.creditBytesUsed || bytes > creditBytes) throw failure('HISTORY_ROOT_PAGE_CREDIT');
};
const nodeKind = value => value?.protocol === 'history-text-v1' ? 'text' : value?.kind;
const sameIdentity = (a, b) => IDENTITY.every(name => a?.[name] === b?.[name]);

export function historyRootIdentity(value) {
  const result = {};
  for (const key of IDENTITY) {
    if (!value || typeof value !== 'object' || !own(value, key)
      || typeof value[key] !== 'string' || !value[key] || value[key].length > 2048) {
      throw failure('HISTORY_ROOT_IDENTITY_INVALID');
    }
    result[key] = value[key];
  }
  return Object.freeze(result);
}

export function isHistoryRootDescriptor(value) {
  return value?.protocol === 'history-root-v1' || value?.protocol === 'history-text-v1';
}

function checkedDescriptor(value, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['protocol', 'kind', 'nodeToken', ...IDENTITY].every(key => own(value, key))
    || !isHistoryRootDescriptor(value) || !sameIdentity(value, identity)
    || (value.protocol === 'history-text-v1' ? value.kind !== 'text' : value.kind === 'text')
    || !['array', 'object', 'map', 'set', 'text'].includes(nodeKind(value))
    || typeof value.nodeToken !== 'string' || !value.nodeToken || value.nodeToken.length > 8192
    || (own(value, 'length') && !integer(value.length))
    || (nodeKind(value) === 'text' && (!own(value, 'length') || !own(value, 'digest') || !integer(value.length)
      || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)))) {
    throw failure('HISTORY_ROOT_DESCRIPTOR_INVALID');
  }
  // Copy only the protocol vocabulary. A server extension cannot smuggle a
  // complete DTO into a long-lived renderer document by object spread.
  return Object.freeze({ protocol: value.protocol, ...identity, kind: nodeKind(value),
    nodeToken: value.nodeToken, ...(own(value, 'length') ? { length: value.length } : {}),
    ...(nodeKind(value) === 'text' ? { digest: value.digest } : {}) });
}

// Open is a small control header, not the history body. Only this finite
// vocabulary crosses into retained renderer state; never spread/serialize the
// response, session metadata body, or arbitrary metrics/extensions here.
const METRIC_COUNTS = ['bytes', 'chunks', 'parsed', 'errors', 'replayedPartialBytes', 'maxRecordBytes',
  'maxInputChunkBytes', 'maxBufferedBytes', 'maxRawCarryBytes', 'maxTokenBytes', 'maxNumericTokenChars',
  'maxNumericScratchChars', 'maxParserFrames', 'residentParserFrames', 'maxCollectedRecords',
  'maxConsumerRecords', 'wholeLineStrings', 'wholeRecordGraphs', 'verificationBytes', 'canonicalRows', 'timelineRows',
  'primarySemanticPreparations', 'primaryPromptPasses', 'primaryTimingPasses', 'primaryIndexBuilds',
  'primaryMetadataRows', 'primarySemanticOverlayHashes'];
const headerFailure = () => failure('HISTORY_ROOT_OPEN_HEADER_INVALID');
const headerString = (value, max) => {
  if (typeof value !== 'string' || !value || value.length > max
    || new TextEncoder().encode(value).byteLength > max) throw headerFailure();
  return value;
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PRIMARY_REUSE_FIELDS = ['semanticIdentity', 'metadataIdentity', 'metadataSchema',
  'semanticRevisionToken', 'viewRevisionToken', 'primaryRequestClass'];

// All absent is the legacy protocol. A partial contract cannot authorize a
// pure view or identify an immutable metadata pair.
export function checkedHistoryPrimaryReuseHeader(result) {
  const present = PRIMARY_REUSE_FIELDS.filter(key => own(result, key));
  if (!present.length) return null;
  if (present.length !== PRIMARY_REUSE_FIELDS.length || result.readProfile !== 'history-primary-v1'
    || result.metadataSchema !== 1 || !['view', 'semantic', 'source'].includes(result.primaryRequestClass)) throw headerFailure();
  const header = { metadataSchema: 1, primaryRequestClass: result.primaryRequestClass };
  for (const key of ['semanticIdentity', 'metadataIdentity']) {
    const value = result[key];
    if (typeof value !== 'string' || !value || value.length > 160
      || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) throw headerFailure();
    header[key] = value;
  }
  for (const key of ['semanticRevisionToken', 'viewRevisionToken']) {
    if (typeof result[key] !== 'string' || !/^[a-f0-9]{64}$/.test(result[key])) throw headerFailure();
    header[key] = result[key];
  }
  return Object.freeze(header);
}

export function checkedHistoryRootOpenHeader(result, { sessionId } = {}) {
  if (!record(result) || !['success', '__notedHistoryTransport'].every(key => own(result, key))
    || result.success !== true || result.__notedHistoryTransport !== 'root-v1'
    || own(result, 'root') === own(result, 'payloadDocument')) throw headerFailure();
  const identity = historyRootIdentity(result);
  const timeline = result.readProfile === 'timeline-primary-v1';
  // Timeline has its own semantic root, not History's metadata/view reuse
  // pair. A lone semantic token is complete for this profile only.
  if (timeline && (result.semanticSnapshotComplete !== true
    || typeof result.semanticRevisionToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.semanticRevisionToken)
    || result.semanticRevisionToken !== identity.revision
    || PRIMARY_REUSE_FIELDS.some(key => key !== 'semanticRevisionToken' && own(result, key)))) throw headerFailure();
  const reuseHeader = timeline ? null : checkedHistoryPrimaryReuseHeader(result);
  if (own(result, 'payloadDocument')) {
    if (reuseHeader || timeline) throw headerFailure();
    const payloadDocument = checkedDescriptor(result.payloadDocument, identity);
    if (!['totalChars', 'contentHash', 'payloadId', 'payloadGeneration', 'matchedCandidates', 'encoding']
      .every(key => own(result, key)) || payloadDocument.kind !== 'text' || result.totalChars !== payloadDocument.length
      || typeof result.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.contentHash)
      || !integer(result.matchedCandidates) || result.matchedCandidates < 1
      || !['text', 'json'].includes(result.encoding)) throw headerFailure();
    return Object.freeze({ success: true, __notedHistoryTransport: 'root-v1', ...identity, payloadDocument,
      totalChars: result.totalChars, contentHash: result.contentHash,
      payloadId: headerString(result.payloadId, 8192), payloadGeneration: headerString(result.payloadGeneration, 2048),
      matchedCandidates: result.matchedCandidates, encoding: result.encoding,
      ...(own(result, 'entryUuid') ? { entryUuid: headerString(result.entryUuid, 8192) } : {}) });
  }
  const root = checkedDescriptor(result.root, identity);
  const sessionMeta = checkedDescriptor(result.sessionMeta, identity);
  if (!['totalEntries', 'sessionMeta', 'sourceSnapshot', 'mode', 'readMetrics', 'producerBounded', 'nativeMemoryMeasured']
    .every(key => own(result, key)) || root.kind !== 'array' || !integer(root.length) || result.totalEntries !== root.length
    || sessionMeta.kind !== 'object' || !['rebuild', 'append', 'unchanged'].includes(result.mode)
    || typeof result.producerBounded !== 'boolean' || typeof result.nativeMemoryMeasured !== 'boolean'
    || !record(result.sourceSnapshot) || !record(result.readMetrics)) throw headerFailure();
  const source = result.sourceSnapshot;
  if (!['filePath', 'sessionId', 'size', 'mtimeMs', 'ctimeMs', 'fileIdentity', 'linkKind'].every(key => own(source, key))) {
    throw headerFailure();
  }
  const sourceSnapshot = {
    filePath: headerString(source.filePath, 4096), sessionId: headerString(source.sessionId, 4096),
    size: source.size, mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs,
    fileIdentity: headerString(source.fileIdentity, 2048), linkKind: source.linkKind,
    ...(own(source, 'sourceGeneration') ? { sourceGeneration: headerString(source.sourceGeneration, 2048) } : {}),
  };
  if ((sessionId !== undefined && sourceSnapshot.sessionId !== sessionId) || !integer(sourceSnapshot.size)
    || !Number.isFinite(sourceSnapshot.mtimeMs) || sourceSnapshot.mtimeMs < 0
    || !Number.isFinite(sourceSnapshot.ctimeMs) || sourceSnapshot.ctimeMs < 0
    || sourceSnapshot.linkKind !== 'end') throw headerFailure();
  const readMetrics = {};
  for (const key of METRIC_COUNTS) if (own(result.readMetrics, key)) {
    if (!integer(result.readMetrics[key])) throw headerFailure();
    readMetrics[key] = result.readMetrics[key];
  }
  if (own(result.readMetrics, 'canonicalReducerRouted')) {
    if (typeof result.readMetrics.canonicalReducerRouted !== 'boolean') throw headerFailure();
    readMetrics.canonicalReducerRouted = result.readMetrics.canonicalReducerRouted;
  }
  let indexHeader = {};
  if (own(result, 'readProfile')) {
    if (!['canonical-index-v1', 'history-semantic-v1', 'history-primary-v1', 'timeline-primary-v1'].includes(result.readProfile)
      || typeof result.semanticSnapshotComplete !== 'boolean') throw headerFailure();
    if(timeline){
      indexHeader={readProfile:result.readProfile,semanticSnapshotComplete:true,
        semanticRevisionToken:result.semanticRevisionToken};
    }else if(result.readProfile === 'history-primary-v1'){
      if(!integer(result.canonicalEntryCount)||result.displayUnitCount!==result.totalEntries)throw headerFailure();
      indexHeader={readProfile:result.readProfile,semanticSnapshotComplete:result.semanticSnapshotComplete,
        canonicalEntryCount:result.canonicalEntryCount,displayUnitCount:result.displayUnitCount};
      if(own(result,'sourceMetadata')){
        const sourceMetadata=checkedDescriptor(result.sourceMetadata,identity);
        if(sourceMetadata.kind!=='array')throw headerFailure();
        const sourceEntryCount=own(result,'sourceEntryCount')?result.sourceEntryCount:sourceMetadata.length;
        if(!integer(sourceEntryCount)||sourceEntryCount!==sourceMetadata.length)throw headerFailure();
        indexHeader.sourceMetadata=sourceMetadata;indexHeader.sourceEntryCount=sourceEntryCount;
      }
      if (own(result, 'presentationAddresses')) {
        const cap = result.presentationAddresses;
        if (!record(cap) || Object.keys(cap).length !== 2 || cap.profile !== PRIMARY_PRESENTATION_ADDRESSES
          || cap.maxItems !== 3) throw headerFailure();
        indexHeader.presentationAddresses = Object.freeze({ profile: cap.profile, maxItems: 3 });
      }
      if (own(result, 'canonicalConsumers')) {
        const cap = result.canonicalConsumers;
        if (!record(cap) || Object.keys(cap).length !== 3 || cap.profile !== PRIMARY_CANONICAL_CONSUMERS
          || cap.maxItems !== 3 || cap.valueEncoding !== PRIMARY_CANONICAL_VALUE_ENCODING) throw headerFailure();
        indexHeader.canonicalConsumers = Object.freeze({ profile: cap.profile, maxItems: 3, valueEncoding: cap.valueEncoding });
      }
      const durableMetadata=checkedDescriptor(result.durableMetadata,identity);
      if(durableMetadata.kind!=='array'||durableMetadata.length!==result.canonicalEntryCount)throw headerFailure();
      indexHeader.durableMetadata=durableMetadata;
      if (own(result, 'canonicalMetadataValidation')) {
        const cap = result.canonicalMetadataValidation;
        if (!record(cap) || Object.keys(cap).length !== CANONICAL_CAP_FIELDS.length
          || !CANONICAL_CAP_FIELDS.every(key => own(cap, key)) || cap.profile !== PRIMARY_CANONICAL_METADATA
          || cap.schema !== 1 || !sha256(cap.sourceProof) || !sha256(cap.diagnosticTailDigest)
          || !sha256(cap.validationToken) || cap.validationDigest !== null && !sha256(cap.validationDigest)
          || !reuseHeader || !indexHeader.sourceMetadata || result.semanticSnapshotComplete !== true) throw headerFailure();
        indexHeader.canonicalMetadataValidation = Object.freeze(Object.fromEntries(
          CANONICAL_CAP_FIELDS.map(key => [key, cap[key]])));
      }
      if (own(result, 'preparedPresentation')) {
        const cap = result.preparedPresentation;
        if (!record(cap) || Object.keys(cap).length !== PREPARED_CAP_FIELDS.length
          || !PREPARED_CAP_FIELDS.every(key => own(cap, key)) || cap.profile !== PRIMARY_PREPARED_PRESENTATION
          || cap.schema !== 1 || !sha256(cap.sourceProof) || !sha256(cap.validationToken)
          || cap.validationDigest !== null && !sha256(cap.validationDigest)
          || !reuseHeader || !indexHeader.sourceMetadata || result.semanticSnapshotComplete !== true) throw headerFailure();
        indexHeader.preparedPresentation = Object.freeze(Object.fromEntries(
          PREPARED_CAP_FIELDS.map(key => [key, cap[key]])));
      }
      if (own(result, 'metadataRowWindow')) {
        const cap = result.metadataRowWindow;
        if (!record(cap) || typeof cap.profile !== 'string' || !cap.profile || cap.profile.length > 128) throw headerFailure();
        if (cap.profile === PRIMARY_METADATA_WINDOW) {
          if (!validCredit(cap.minimumCreditBytes) || Object.keys(cap).length !== 2) throw headerFailure();
          indexHeader.metadataRowWindow = Object.freeze({ profile: cap.profile, minimumCreditBytes: cap.minimumCreditBytes });
        }
      }
    }else{
      const settingsBefore = checkedDescriptor(result.settingsBefore, identity);
      if (settingsBefore.kind !== 'array' || settingsBefore.length !== result.totalEntries + 1) throw headerFailure();
      indexHeader = { readProfile: result.readProfile, semanticSnapshotComplete: result.semanticSnapshotComplete, settingsBefore };
    }
  }
  return Object.freeze({ success: true, __notedHistoryTransport: 'root-v1', ...identity, root,
    totalEntries: result.totalEntries, sessionMeta, sourceSnapshot: Object.freeze(sourceSnapshot),
    mode: result.mode, readMetrics: Object.freeze(readMetrics),
    producerBounded: result.producerBounded, nativeMemoryMeasured: result.nativeMemoryMeasured, ...indexHeader,
    ...(reuseHeader || {}) });
}

function canonicalMetadataBinding(header) {
  const parent = checkedHistoryRootOpenHeader(header), cap = parent.canonicalMetadataValidation;
  if (parent.readProfile !== 'history-primary-v1' || parent.semanticSnapshotComplete !== true
    || !checkedHistoryPrimaryReuseHeader(parent) || parent.metadataSchema !== 1
    || parent.viewRevisionToken !== parent.revision || cap?.profile !== PRIMARY_CANONICAL_METADATA
    || cap.schema !== 1 || parent.sourceMetadata?.kind !== 'array'
    || parent.durableMetadata?.kind !== 'array' || !integer(parent.canonicalEntryCount)
    || !integer(parent.sourceEntryCount) || parent.durableMetadata.length !== parent.canonicalEntryCount
    || parent.sourceMetadata.length !== parent.sourceEntryCount) {
    throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_REQUIRED');
  }
  return { parent, binding: Object.freeze({ ...historyRootIdentity(parent), profile: PRIMARY_CANONICAL_METADATA, schema: 1,
    parentNodeToken: parent.root.nodeToken, nodeToken: parent.durableMetadata.nodeToken,
    sourceNodeToken: parent.sourceMetadata.nodeToken, metadataIdentity: parent.metadataIdentity,
    metadataSchema: parent.metadataSchema, semanticIdentity: parent.semanticIdentity,
    semanticRevisionToken: parent.semanticRevisionToken, viewRevisionToken: parent.viewRevisionToken,
    canonicalEntryCount: parent.canonicalEntryCount, sourceEntryCount: parent.sourceEntryCount,
    sourceProof: cap.sourceProof, validationDigest: cap.validationDigest,
    diagnosticTailDigest: cap.diagnosticTailDigest, validationToken: cap.validationToken }) };
}
function sameCanonicalSource(a, b) {
  return CANONICAL_SOURCE_FIELDS.every(key => own(a, key) === own(b, key)
    && (!own(a, key) || Object.is(a[key], b[key])));
}
// Isolate the retained child from the transient query/caller context.
function retainedPreparedInvoke(parent, leaseId, preparedRequestId) {
  return (channel, payload) => parent.invoke(channel,
    channel === parent.releaseChannel && payload?.leaseId === leaseId
      ? { ...payload, preparedRequestId } : payload);
}

function preparedPresentationBinding(header) {
  const parent = checkedHistoryRootOpenHeader(header), cap = parent.preparedPresentation;
  if (parent.readProfile !== 'history-primary-v1' || parent.semanticSnapshotComplete !== true
    || !checkedHistoryPrimaryReuseHeader(parent) || parent.metadataSchema !== 1
    || parent.viewRevisionToken !== parent.revision || cap?.profile !== PRIMARY_PREPARED_PRESENTATION
    || parent.sourceMetadata?.length !== parent.sourceEntryCount
    || parent.durableMetadata?.length !== parent.canonicalEntryCount) {
    throw failure('HISTORY_PRIMARY_PREPARED_VALIDATION_REQUIRED');
  }
  return { parent, binding: Object.freeze({ ...historyRootIdentity(parent), profile: cap.profile, schema: 1,
    parentNodeToken: parent.root.nodeToken, nodeToken: parent.sourceMetadata.nodeToken,
    metadataIdentity: parent.metadataIdentity, metadataSchema: parent.metadataSchema,
    semanticIdentity: parent.semanticIdentity, semanticRevisionToken: parent.semanticRevisionToken,
    viewRevisionToken: parent.viewRevisionToken, canonicalEntryCount: parent.canonicalEntryCount,
    sourceEntryCount: parent.sourceEntryCount, sourceProof: cap.sourceProof,
    validationDigest: cap.validationDigest, validationToken: cap.validationToken }) };
}
// The independent prepared owner is established only by the checked fork.
// Neither a generic Root header nor canonical validation can mint this fact.
export function checkedHistoryPrimaryPreparedPresentation(subject) {
  if (!checkedPreparedPresentations.has(subject)) throw failure('HISTORY_PRIMARY_PREPARED_SUBJECT_INVALID');
  return subject;
}
function canonicalMetadataSourceProjection(source) {
  const result = {};
  for (const key of CANONICAL_SOURCE_FIELDS) if (own(source, key)) {
    const value = source[key];
    result[key] = Object.is(value, -0) ? { kind: 'negative-zero' } : value;
  }
  return result;
}
function makeCanonicalMetadataFact(binding, sourceSnapshot, diagnosticTail, validationReceipt) {
  const fact = Object.freeze({ kind: 'validated-canonical-metadata', ...binding, sourceSnapshot, diagnosticTail, validationReceipt });
  checkedCanonicalMetadataFacts.add(fact);
  return fact;
}
// Only the dedicated checked reader can establish this local fact. A plain
// success-shaped mock, generic empty page or count is not validation authority.
export function checkedHistoryPrimaryCanonicalMetadataFact(fact, header) {
  const { parent, binding } = canonicalMetadataBinding(header);
  if (!checkedCanonicalMetadataFacts.has(fact) || !sha256(fact.validationDigest) || !sha256(fact.validationReceipt)
    || Object.keys(binding).some(key => fact[key] !== binding[key])
    || !sameCanonicalSource(fact.sourceSnapshot, parent.sourceSnapshot)) {
    throw failure('HISTORY_PRIMARY_METADATA_FACT_INVALID');
  }
  return fact;
}
// A new view lease may rebind an already checked immutable data cut. It may
// retain the SAME selected diagnostic row object; no prior root capability or
// newly sampled owner is substituted after asynchronous work.
function canonicalMetadataReuse(fact, previousHeader, header) {
  checkedHistoryPrimaryCanonicalMetadataFact(fact, previousHeader);
  const { parent, binding } = canonicalMetadataBinding(header);
  const stable = ['ownerKey', 'generation', 'metadataIdentity', 'metadataSchema', 'semanticIdentity',
    'semanticRevisionToken', 'canonicalEntryCount', 'sourceEntryCount', 'sourceProof', 'validationDigest', 'diagnosticTailDigest'];
  if (stable.some(key => fact[key] !== binding[key]) || !sameCanonicalSource(fact.sourceSnapshot, parent.sourceSnapshot)) {
    throw failure('HISTORY_PRIMARY_METADATA_FACT_REUSE_CONFLICT');
  }
  const prior = canonicalMetadataBinding(previousHeader).binding;
  return Object.freeze({ ...prior, validationReceipt: fact.validationReceipt });
}
async function canonicalMetadataDigest(value) {
  const text = JSON.stringify(value);
  // Fixed source vocabulary and seven selected fields only, never a graph.
  if (text.length > MAX_CANONICAL_METADATA_JSON_CHARS) throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index); bytes[index * 2] = code & 255; bytes[index * 2 + 1] = code >>> 8;
  }
  if (globalThis.crypto?.subtle) {
    const result = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(result, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (typeof globalThis.window?.require === 'function') {
    return globalThis.window.require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  }
  throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_CRYPTO');
}
function checkedCanonicalDiagnosticTail(value, count) {
  if (!record(value)) throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
  if (count === 0) {
    if (Object.keys(value).length !== 1 || value.kind !== 'empty') throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
    return { wire: Object.freeze({ kind: 'empty' }), diagnosticTail: Object.freeze({ kind: 'empty' }) };
  }
  if (Object.keys(value).length !== 3 || !['kind', 'ordinal', 'fields'].every(key => own(value, key))
    || value.kind !== 'row' || value.ordinal !== count - 1 || !Array.isArray(value.fields)
    || value.fields.length !== CANONICAL_METADATA_FIELDS.length) throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
  const fields = [], row = {};
  for (let index = 0; index < CANONICAL_METADATA_FIELDS.length; index++) {
    const name = CANONICAL_METADATA_FIELDS[index], field = value.fields[index];
    if (!record(field) || field.name !== name || !['missing', 'invalid', 'negative-zero', 'value'].includes(field.kind)
      || Object.keys(field).length !== (field.kind === 'value' ? 3 : 2)
      || !['name', 'kind'].every(key => own(field, key))
      || field.kind === 'value' && (!own(field, 'value') || !(field.value === null
        || typeof field.value === 'boolean' || typeof field.value === 'number' && Number.isFinite(field.value) && !Object.is(field.value, -0)
        || typeof field.value === 'string' && field.value.length <= 512))) {
      throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
    }
    const checked = Object.freeze({ name, kind: field.kind, ...(field.kind === 'value' ? { value: field.value } : {}) });
    fields.push(checked);
    if (checked.kind !== 'missing') Object.defineProperty(row, name, { enumerable: true,
      value: checked.kind === 'invalid' ? invalidDiagnosticMetadata : checked.kind === 'negative-zero' ? -0 : checked.value });
  }
  return { wire: Object.freeze({ kind: 'row', ordinal: value.ordinal, fields: Object.freeze(fields) }),
    diagnosticTail: Object.freeze({ kind: 'row', ordinal: value.ordinal, row: Object.freeze(row) }) };
}

function checkedValue(value, identity, bodyBorrow = false) {
  if (isHistoryRootDescriptor(value)) return checkedDescriptor(value, identity);
  if (value?.kind !== 'scalar' || !['undefined', 'null', 'boolean', 'number', 'string', 'bigint'].includes(value.type)) {
    throw failure('HISTORY_ROOT_VALUE_INVALID');
  }
  if (value.type === 'undefined') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'boolean' && typeof value.value === 'boolean') return value.value;
  if (value.type === 'string' && typeof value.value === 'string' && value.value.length <= 64) return value.value;
  if (value.type === 'number') {
    if (typeof value.value === 'number') return value.value;
    if (typeof value.value === 'string' && value.value.length <= 32
      && ['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value)) return Number(value.value);
  }
  if (bodyBorrow && value.type === 'bigint' && typeof value.value === 'string'
    && value.value.length <= MAX_CREDIT_BYTES && /^-?(0|[1-9]\d*)$/.test(value.value)) return BigInt(value.value);
  // Wide bigint materialization is not part of this small scalar vocabulary.
  if (value.type === 'bigint' && typeof value.value === 'string' && /^-?\d{1,64}$/.test(value.value)) return BigInt(value.value);
  throw failure('HISTORY_ROOT_VALUE_INVALID');
}

/**
 * A root owns one server lease and one in-flight page. There is no promise
 * queue, per-row map, decoded history cache or implicit whole-root iterator.
 * A caller needing concurrent viewports gives each an independent fork lease.
 */
export class HistoryRootClient {
  constructor(invoke, descriptor, { signal = null, pageBytes = 3072, pageItems = 3,
    pageChannel = 'agent-transcript:read-page', releaseChannel = 'agent-transcript:release-read-root',
    forkChannel = 'agent-transcript:fork-read-leaf' } = {}) {
    if (typeof invoke !== 'function' || !validCredit(pageBytes)
      || !integer(pageItems) || pageItems < 1 || pageItems > 64) throw failure('HISTORY_ROOT_LIMITS_INVALID');
    this.identity = historyRootIdentity(descriptor);
    this.root = checkedDescriptor(descriptor, this.identity);
    this.invoke = invoke; this.signal = signal; this.pageBytes = pageBytes; this.pageItems = pageItems;
    this.pageChannel = pageChannel; this.releaseChannel = releaseChannel; this.forkChannel = forkChannel;
    this.closed = false; this.pending = false; this.releasePromise = null;
    this.closeListeners = null;
    this.closedPromise = new Promise((_resolve, reject) => { this.rejectClosed = reject; });
    this.closedPromise.catch(() => {});
    this.abort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  assertOpen(signal = null) {
    if (this.closed || this.signal?.aborted || signal?.aborted) throw failure('HISTORY_READ_CANCELLED');
  }
  // Unlike racing a long-lived closedPromise, this active-demand hook can be
  // removed after a selected read. The owner cannot retain every resolved
  // selected body/header as a pending Promise reaction until its own close.
  subscribeClose(listener) {
    if (typeof listener !== 'function') throw failure('HISTORY_ROOT_CLOSE_LISTENER');
    if (this.closed) { listener(); return () => {}; }
    const listeners = this.closeListeners ||= new Set();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  detachSignal(signal) {
    this.assertOpen(signal);
    if (this.pending || this.signal !== signal) throw failure('HISTORY_ROOT_ABORT_OWNER');
    signal?.removeEventListener('abort',this.abort);
    this.signal = null;
  }
  async page(descriptor, kind, { offset = 0, limit = this.pageItems, fields, field, value, profile, signal,
    creditBytes = this.pageBytes } = {}) {
    this.assertOpen(signal);
    const node = checkedDescriptor(descriptor, this.identity);
    if (this.pending) throw failure('HISTORY_ROOT_CONCURRENT_PULL');
    if (!validCredit(creditBytes)) throw failure('HISTORY_ROOT_LIMITS_INVALID');
    const max = kind === 'leaf' ? Math.floor(creditBytes / 2) : this.pageItems;
    if (!integer(offset) || !integer(limit) || limit < 1 || limit > max
      || !['leaf', 'range', 'fields', 'projection', 'find', 'rowWindow', 'body-pairs', 'body-items'].includes(kind)) throw failure('HISTORY_ROOT_RANGE_INVALID');
    if (kind === 'leaf' && node.kind !== 'text') throw failure('HISTORY_ROOT_NOT_TEXT');
    if (kind === 'projection' && (!Array.isArray(fields) || fields.length > 64
      || fields.some(name => typeof name !== 'string' || name.length > 128))) throw failure('HISTORY_ROOT_FIELDS_INVALID');
    if (kind === 'find' && (typeof field !== 'string' || field.length > 128
      || typeof value !== 'string' || value.length > 2048)) throw failure('HISTORY_ROOT_FIND_INVALID');
    const metadataWindow = profile === PRIMARY_METADATA_WINDOW;
    if (profile !== undefined && (!metadataWindow || !['range', 'rowWindow'].includes(kind))) throw failure('HISTORY_ROOT_METADATA_PROFILE');
    if (kind === 'rowWindow') {
      if (node.kind !== 'array' || !integer(node.length)) throw failure('HISTORY_ROOT_NOT_ARRAY');
      if (offset > node.length) throw failure('HISTORY_ROOT_RANGE_INVALID');
      if (metadataWindow ? limit !== 1 || fields !== undefined : !Array.isArray(fields) || fields.length > 16) throw failure('HISTORY_ROOT_FIELDS_INVALID');
      const selected = new Set();
      for (const name of fields || []) {
        if (typeof name !== 'string' || !name || name.length > 128 || new TextEncoder().encode(name).byteLength > 128
          || selected.has(name)) throw failure('HISTORY_ROOT_FIELDS_INVALID');
        selected.add(name);
      }
      // Capture the request vocabulary before invoking an asynchronous peer.
      if (!metadataWindow) fields = Object.freeze([...selected]);
    }
    const requestIdentity = { ...this.identity, nodeToken: node.nodeToken, kind, offset };
    const contradictsRequest = value => Object.keys(requestIdentity).some(key => own(value, key)
      && value[key] !== requestIdentity[key]);
    this.pending = true;
    const onAbort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const request = this.invoke(this.pageChannel, { ...this.identity, nodeToken: node.nodeToken,
        kind, offset, limit, creditBytes, ...(profile ? { profile } : {}),
        ...(fields ? { fields } : {}), ...(kind === 'find' ? { field, value } : {}) });
      const result = await Promise.race([request, this.closedPromise]);
      this.assertOpen(signal);
      if (result?.success !== true) {
        // Error packets may omit identity (the existing error wire does), but
        // an echo must never contradict the exact request even on refusal.
        if (result && contradictsRequest(result)) {
          throw failure('HISTORY_ROOT_PAGE_IDENTITY');
        }
        const error = failure(result?.success === false && typeof result.error === 'string'
          ? result.error : 'HISTORY_ROOT_READ_FAILED');
        if (result && own(result, 'minimumCreditBytes')) error.minimumCreditBytes = result.minimumCreditBytes;
        throw error;
      }
      if (!sameIdentity(result, this.identity) || result.nodeToken !== node.nodeToken
        || result.kind !== kind || result.offset !== offset || typeof result.done !== 'boolean'
        || !integer(result.nextOffset) || result.nextOffset < offset
        || (!result.done && result.nextOffset === offset)) throw failure('HISTORY_ROOT_PAGE_IDENTITY');
      if (metadataWindow && result.profile !== profile || !metadataWindow && own(result, 'profile')) throw failure('HISTORY_ROOT_METADATA_PROFILE');
      if (!integer(result.creditBytesUsed) || result.creditBytesUsed > creditBytes) throw failure('HISTORY_ROOT_PAGE_CREDIT');
      if (kind === 'rowWindow') {
        checkWireCredit(result, creditBytes);
        if (result.totalLength !== node.length || result.start !== offset
          || result.next !== result.nextOffset || !Array.isArray(result.rows) || result.rows.length > limit
          || result.next !== offset + result.rows.length || result.next > node.length
          || result.done !== (result.next === node.length)) throw failure('HISTORY_ROOT_PAGE_RANGE');
        const rows = Array.from(result.rows, (row, index) => {
          if (row?.ordinal !== offset + index) throw failure('HISTORY_ROOT_PAGE_ORDINAL');
          const entry = checkedDescriptor(row.entry, this.identity);
          if (metadataWindow) {
            if (entry.kind !== 'object' || !Array.isArray(row.fields)
              || row.fields.length > Math.floor(creditBytes / 32)) throw failure('HISTORY_ROOT_FIELDS_INVALID');
            const names = new Set();
            const selected = row.fields.map(item => {
              if (!record(item) || Object.keys(item).length !== 2 || !own(item, 'name') || !own(item, 'value')) throw failure('HISTORY_ROOT_FIELDS_INVALID');
              const name = typeof item.name === 'string' && item.name.length <= 64 ? item.name : checkedDescriptor(item.name, this.identity);
              if (typeof name !== 'string' && name.kind !== 'text') throw failure('HISTORY_ROOT_FIELDS_INVALID');
              const key = typeof name === 'string' ? 's:' + name : 't:' + name.nodeToken;
              if (names.has(key)) throw failure('HISTORY_ROOT_FIELDS_INVALID');
              names.add(key);
              return Object.freeze({ name, value: checkedValue(item.value, this.identity, this.bodyBorrow === true) });
            });
            return Object.freeze({ ordinal: row.ordinal, entry, fields: Object.freeze(selected) });
          }
          if (!row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)
            || Object.keys(row.fields).length !== fields.length
            || fields.some(name => !own(row.fields, name))) throw failure('HISTORY_ROOT_FIELDS_INVALID');
          const selected = Object.create(null);
          for (const name of fields) Object.defineProperty(selected, name, { enumerable: true,
            value: checkedValue(row.fields[name], this.identity) });
          return Object.freeze({ ordinal: row.ordinal, entry, fields: Object.freeze(selected) });
        });
        return Object.freeze({ offset, start: offset, nextOffset: result.nextOffset, next: result.next,
          done: result.done, totalLength: result.totalLength, rows: Object.freeze(rows) });
      }
      if (kind === 'leaf') {
        if (typeof result.text !== 'string' || result.text.length > limit || result.text.length * 2 > creditBytes
          || result.length !== node.length || offset > node.length
          || offset + result.text.length > node.length || result.nextOffset !== offset + result.text.length
          || result.done !== (result.nextOffset === node.length)) throw failure('HISTORY_ROOT_PAGE_RANGE');
        checkWireCredit(result, creditBytes);
        return Object.freeze({ offset, nextOffset: result.nextOffset, done: result.done, text: result.text, length: node.length });
      }
      if (!Array.isArray(result.items) || result.items.length > limit) throw failure('HISTORY_ROOT_PAGE_CREDIT');
      const items = result.items.map(item => {
        const decoded = checkedValue(item.value, this.identity, this.bodyBorrow === true);
        if (kind === 'fields' || kind === 'projection') {
          const name = typeof item.name === 'string' && item.name.length <= (kind === 'projection' ? 128 : 64)
            ? item.name : checkedDescriptor(item.name, this.identity);
          return Object.freeze({ name, value: decoded });
        }
        if (kind === 'body-pairs') return Object.freeze({ ordinal: item.ordinal, key: checkedValue(item.key, this.identity, this.bodyBorrow === true), value: decoded });
        if (!integer(item.ordinal)) throw failure('HISTORY_ROOT_PAGE_ORDINAL');
        if(own(item,'present')&&typeof item.present!=='boolean')throw failure('HISTORY_ROOT_PAGE_ORDINAL');
        if (metadataWindow && (!own(item, 'rowWindowCreditBytes') || item.rowWindowCreditBytes !== null
          && (!integer(item.rowWindowCreditBytes) || item.rowWindowCreditBytes < 512))) throw failure('HISTORY_ROOT_METADATA_BOUND');
        return Object.freeze({ ordinal: item.ordinal, value: decoded, ...(own(item,'present')?{present:item.present}:{}),
          ...(metadataWindow ? { rowWindowCreditBytes: item.rowWindowCreditBytes } : {}) });
      });
      if ((kind === 'range' || kind === 'body-pairs') && items.some((item, index) => item.ordinal !== offset + index)) {
        throw failure('HISTORY_ROOT_PAGE_ORDINAL');
      }
      if (kind === 'body-items' && (node.kind !== 'array' || result.length !== node.length
        || items.some((item, index) => item.ordinal >= node.length || index > 0 && item.ordinal <= items[index - 1].ordinal))) {
        throw failure('HISTORY_ROOT_PAGE_ORDINAL');
      }
      if (this.bodyBorrow === true && ['fields','body-pairs','body-items'].includes(kind)
        && result.nextOffset !== offset + items.length) throw failure('HISTORY_ROOT_PAGE_RANGE');
      checkWireCredit(result, creditBytes);
      return Object.freeze({ offset, nextOffset: result.nextOffset, done: result.done, items: Object.freeze(items),
        ...(integer(result.length) ? { length: result.length } : {}) });
    } catch (error) {
      // A finite, actionable credit refusal did not invalidate the lease. The
      // caller may choose another explicit pull; never grow credit, retry,
      // reopen or fall back here. Missing/invalid minima remain fatal errors.
      if (error?.code === 'HISTORY_ROOT_CREDIT_TOO_SMALL' && own(error, 'minimumCreditBytes') && integer(error.minimumCreditBytes)
        && error.minimumCreditBytes > creditBytes && error.minimumCreditBytes <= MAX_CREDIT_BYTES
        && !contradictsRequest(error)) throw error;
      // A protocol or source failure invalidates this capability. It does not
      // authorize a retry against another revision, session or whole DTO API.
      void this.close().catch(() => {}); throw error;
    } finally {
      this.pending = false; signal?.removeEventListener('abort', onAbort);
    }
  }
  // Validate the complete canonical metadata owner in Main. This dedicated
  // proof carries one bounded diagnostic row; it never asks for canonical
  // range/fields/rowWindow packets or constructs a canonical native inventory.
  async canonicalMetadataValidation(header, { signal, owns = () => true, reuseFact, previousHeader,
    creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal);
    const { parent, binding } = canonicalMetadataBinding(header);
    if (this.pending || typeof invoke !== 'function' || typeof owns !== 'function' || !validCredit(creditBytes)
      || !sameIdentity(parent, this.identity) || parent.root.nodeToken !== this.root.nodeToken
      || parent.root.kind !== this.root.kind || parent.root.length !== this.root.length) {
      throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_QUERY_INVALID');
    }
    const assertCurrent = () => {
      this.assertOpen(signal);
      if (owns() !== true) throw failure('HISTORY_READ_CANCELLED');
      // Caller guards can synchronously revoke/abort this original reader.
      // A true result cannot make that now-closed capability current again.
      this.assertOpen(signal);
    };
    assertCurrent();
    const reuseValidation = reuseFact === undefined ? undefined : canonicalMetadataReuse(reuseFact, previousHeader, parent);
    if (reuseFact === undefined && previousHeader !== undefined) throw failure('HISTORY_PRIMARY_METADATA_FACT_REUSE_CONFLICT');
    const request = { ...binding, kind: 'primary-canonical-metadata', creditBytes,
      ...(reuseValidation ? { reuseValidation } : {}) };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_CREDIT_BYTES) {
      throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_QUERY_INVALID');
    }
    this.pending = true;
    try {
      const sourceProof = await canonicalMetadataDigest(canonicalMetadataSourceProjection(parent.sourceSnapshot));
      assertCurrent();
      if (sourceProof !== binding.sourceProof) throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_SOURCE');
      const result = await Promise.race([invoke(this.pageChannel, request), this.closedPromise]);
      assertCurrent();
      if (result?.success !== true) {
        const keys = ['success', 'error', 'minimumCreditBytes', ...IDENTITY];
        if (!record(result) || result.success !== false || typeof result.error !== 'string'
          || !/^[A-Z][A-Z0-9_]{0,159}$/.test(result.error) || Object.keys(result).some(key => !keys.includes(key))
          || IDENTITY.some(key => own(result, key) && result[key] !== this.identity[key])
          || own(result, 'minimumCreditBytes') && (!integer(result.minimumCreditBytes)
            || result.minimumCreditBytes <= creditBytes || result.minimumCreditBytes > MAX_CREDIT_BYTES)) {
          throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
        }
        const error = failure(result.error);
        if (own(result, 'minimumCreditBytes')) error.minimumCreditBytes = result.minimumCreditBytes;
        throw error;
      }
      const keys = ['success', 'kind', ...Object.keys(binding), 'diagnosticTail', 'validationReceipt', 'creditBytesUsed'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(key => own(result, key))
        || result.kind !== 'primary-canonical-metadata' || !sha256(result.validationDigest) || !sha256(result.validationReceipt)
        || Object.keys(binding).some(key => result[key] !== binding[key])) {
        throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_PROTOCOL');
      }
      const selected = checkedCanonicalDiagnosticTail(result.diagnosticTail, parent.canonicalEntryCount);
      const validationReceipt = result.validationReceipt;
      checkWireCredit(result, creditBytes);
      const diagnosticTailDigest = await canonicalMetadataDigest(selected.wire);
      assertCurrent();
      if (diagnosticTailDigest !== binding.diagnosticTailDigest) throw failure('HISTORY_PRIMARY_METADATA_VALIDATION_TAIL');
      return makeCanonicalMetadataFact(binding, parent.sourceSnapshot,
        reuseValidation ? reuseFact.diagnosticTail : selected.diagnosticTail, validationReceipt);
    } finally {
      // A failed independent demand is not authority to close a shared root.
      // The model owns its provisional lease and performs rollback/release.
      this.pending = false;
    }
  }
  // An independent demand on an already held root. Never close/abort the
  // shared reader on cancellation, query error or UNKNOWN; never retry.
  async retainPreparedPresentation(header, { signal, owns = () => true, reuseSubject, transport } = {}) {
    this.assertOpen(signal);
    const { parent, binding } = preparedPresentationBinding(header);
    if (this.pending || typeof owns !== 'function' || !sameIdentity(parent, this.identity)
      || parent.root.nodeToken !== this.root.nodeToken || parent.root.length !== this.root.length) {
      throw failure('HISTORY_PRIMARY_PREPARED_QUERY_INVALID');
    }
    const assertCurrent = () => {
      this.assertOpen(signal);
      if (owns() !== true) throw failure('HISTORY_READ_CANCELLED');
      this.assertOpen(signal);
    };
    assertCurrent();
    let reuseValidation;
    if (reuseSubject !== undefined) {
      checkedHistoryPrimaryPreparedPresentation(reuseSubject);
      const stable = ['ownerKey', 'generation', 'profile', 'schema', 'metadataIdentity', 'metadataSchema',
        'semanticIdentity', 'semanticRevisionToken', 'canonicalEntryCount', 'sourceEntryCount', 'sourceProof', 'validationDigest'];
      if (parent.primaryRequestClass !== 'view' || stable.some(key => reuseSubject.validation[key] !== binding[key])
        || !sameCanonicalSource(reuseSubject.originalHeader.sourceSnapshot, parent.sourceSnapshot)) {
        throw failure('HISTORY_PRIMARY_PREPARED_VALIDATION_REUSE');
      }
      reuseValidation = reuseSubject.validation;
    }
    const crypto = globalThis.crypto || globalThis.window?.require?.('node:crypto');
    if (typeof crypto?.randomUUID !== 'function') throw failure('HISTORY_PRIMARY_PREPARED_CRYPTO_REQUIRED');
    const preparedRequestId = crypto.randomUUID();
    const request = { ...binding, encoding: PREPARED_PRESENTATION_ENCODING, preparedRequestId,
      ...(reuseValidation ? { reuseValidation } : {}) };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_CREDIT_BYTES) {
      throw failure('HISTORY_PRIMARY_PREPARED_QUERY_INVALID');
    }
    let observed, child, abandoned = false, discarded = false, rejectAbort;
    const discard = result => {
      if (discarded || child || result?.success !== true) return;
      // Release carries OUR allocation ID. The producer refuses it for a
      // parent or any sibling even if a malformed reply substituted its ID.
      let identity;
      try { identity = historyRootIdentity(result); } catch { return; }
      if (identity.leaseId === this.identity.leaseId
        || ['ownerKey', 'revision', 'generation'].some(key => identity[key] !== this.identity[key])) return;
      discarded = true;
      try { Promise.resolve(this.invoke(this.releaseChannel, { ...identity, preparedRequestId })).catch(() => {}); } catch {}
    };
    const rawInvoke = (channel, payload) => {
      const pending = this.invoke(channel, payload);
      if (channel !== this.forkChannel) return pending;
      return Promise.resolve(pending).then(result => {
        observed = result;
        if (abandoned || this.closed || signal?.aborted) discard(result);
        return result;
      });
    };
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const onAbort = () => { abandoned = true; discard(observed); rejectAbort(failure('HISTORY_READ_CANCELLED')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.pending = true;
    try {
      const sourceProof = await canonicalMetadataDigest(canonicalMetadataSourceProjection(parent.sourceSnapshot));
      assertCurrent();
      if (sourceProof !== binding.sourceProof) throw failure('HISTORY_PRIMARY_PREPARED_VALIDATION_SOURCE');
      const pending = transport
        ? transport.readHistoryThroughIpc(rawInvoke, this.forkChannel, request, { signal })
        : rawInvoke(this.forkChannel, request);
      const result = await Promise.race([pending, this.closedPromise, aborted]);
      assertCurrent();
      if (result?.success !== true) throw failure(result?.error || 'HISTORY_PRIMARY_PREPARED_FORK_UNKNOWN');
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CREDIT_BYTES
        || result.encoding !== PREPARED_PRESENTATION_ENCODING || result.retainedPreparedPresentation !== true
        || result.preparedRequestId !== preparedRequestId) throw failure('HISTORY_PRIMARY_PREPARED_FORK_PROTOCOL');
      const heldHeader = checkedHistoryRootOpenHeader(result), validation = result.preparedValidation;
      const keys = [...Object.keys(binding), 'validationReceipt'];
      if (!record(validation) || Object.keys(validation).length !== keys.length || !keys.every(key => own(validation, key))
        || Object.keys(binding).some(key => validation[key] !== binding[key])
        || !sha256(validation.validationDigest) || !sha256(validation.validationReceipt)
        || heldHeader.leaseId === parent.leaseId || ['ownerKey', 'revision', 'generation', 'metadataIdentity', 'metadataSchema',
          'semanticIdentity', 'semanticRevisionToken', 'viewRevisionToken', 'canonicalEntryCount', 'sourceEntryCount',
          'totalEntries', 'primaryRequestClass'].some(key => heldHeader[key] !== parent[key])
        || !sameCanonicalSource(heldHeader.sourceSnapshot, parent.sourceSnapshot)
        || heldHeader.preparedPresentation?.sourceProof !== binding.sourceProof
        || heldHeader.preparedPresentation?.validationDigest !== binding.validationDigest) {
        throw failure('HISTORY_PRIMARY_PREPARED_FORK_PROTOCOL');
      }
      const preparedSource = checkedDescriptor(result.preparedSource, heldHeader);
      const preparedView = checkedDescriptor(result.preparedView, heldHeader);
      if (preparedSource.kind !== 'array' || preparedSource.length !== heldHeader.sourceEntryCount
        || preparedView.kind !== 'object') throw failure('HISTORY_PRIMARY_PREPARED_FORK_PROTOCOL');
      assertCurrent();
      const childInvoke = retainedPreparedInvoke(this, heldHeader.leaseId, preparedRequestId);
      child = new HistoryRootClient(childInvoke, heldHeader.root, { pageBytes: this.pageBytes, pageItems: this.pageItems,
        pageChannel: this.pageChannel, releaseChannel: this.releaseChannel, forkChannel: this.forkChannel });
      const subject = Object.freeze({ kind: 'retained-prepared-presentation', reader: child, root: child.root,
        header: heldHeader, originalHeader: parent, preparedSource, preparedView, preparedRequestId,
        validation: Object.freeze(Object.fromEntries(keys.map(key => [key, validation[key]]))) });
      checkedPreparedPresentations.add(subject);
      return subject;
    } catch (error) {
      abandoned = true;
      if (child) void child.close().catch(() => {}); else discard(observed);
      throw error;
    } finally { this.pending = false; signal?.removeEventListener('abort', onAbort); }
  }

  // An independent demand on an already held root. Never close/abort the
  // shared reader on cancellation, query error or UNKNOWN; never retry.
  async primaryToolCoverage(node, { offset = 0, limit = 3, semanticIdentity, metadataIdentity,
    claimRevision, signal, creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal); node = checkedDescriptor(node, this.identity);
    if (this.pending || node.kind !== 'array' || !integer(offset) || !integer(limit) || limit < 1 || limit > 3
      || !validCredit(creditBytes) || !integer(claimRevision) || claimRevision < 1
      || [semanticIdentity, metadataIdentity].some(x => typeof x !== 'string' || !x || x.length > 160)) {
      throw failure('HISTORY_PRIMARY_TOOL_QUERY_INVALID');
    }
    this.pending = true;
    try {
      const result = await invoke(this.pageChannel, { ...this.identity, nodeToken: node.nodeToken,
        kind: 'primary-tool-coverage', offset, limit, creditBytes, semanticIdentity, metadataIdentity, claimRevision });
      this.assertOpen(signal);
      if (result?.success !== true) {
        if (result && IDENTITY.some(k=>own(result,k)&&result[k]!==this.identity[k])) throw failure('HISTORY_PRIMARY_TOOL_QUERY_PROTOCOL');
        const error=failure(result?.error || 'HISTORY_PRIMARY_TOOL_QUERY_FAILED');
        if(integer(result?.minimumCreditBytes)&&result.minimumCreditBytes>creditBytes&&result.minimumCreditBytes<=MAX_CREDIT_BYTES)error.minimumCreditBytes=result.minimumCreditBytes;
        throw error;
      }
      const keys = ['success', ...IDENTITY, 'nodeToken', 'kind', 'semanticIdentity', 'metadataIdentity',
        'claimRevision', 'offset', 'nextOffset', 'done', 'items', 'creditBytesUsed'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(k => own(result,k))
        || !sameIdentity(result,this.identity) || result.nodeToken !== node.nodeToken || result.kind !== 'primary-tool-coverage'
        || result.semanticIdentity !== semanticIdentity || result.metadataIdentity !== metadataIdentity
        || result.claimRevision !== claimRevision || result.offset !== offset || !integer(result.nextOffset)
        || typeof result.done !== 'boolean' || !Array.isArray(result.items) || result.items.length > limit
        || result.nextOffset !== offset + result.items.length || (!result.done && !result.items.length)) {
        throw failure('HISTORY_PRIMARY_TOOL_QUERY_PROTOCOL');
      }
      checkWireCredit(result,creditBytes);
      const items = result.items.map((item,index) => {
        if (!record(item) || Object.keys(item).length !== 5 || !['ordinal','key','fingerprint','covered','proof'].every(k=>own(item,k))
          || item.ordinal !== offset+index || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint)
          || !['absent','task','raw','result-ref'].includes(item.proof) || item.covered !== (item.proof !== 'absent')) {
          throw failure('HISTORY_PRIMARY_TOOL_QUERY_PROTOCOL');
        }
        const key = checkedDescriptor(item.key,this.identity);
        if (key.kind !== 'text' || !key.length) throw failure('HISTORY_PRIMARY_TOOL_QUERY_PROTOCOL');
        return Object.freeze({...item,key});
      });
      return Object.freeze({nextOffset:result.nextOffset,done:result.done,items:Object.freeze(items),claimRevision});
    } finally { this.pending = false; }
  }
  // Complete semantic rows, explicitly scoped to canonical or prepared data.
  // The dedicated count/progress/done proof is required even for an empty cut;
  // metadata descriptors and a generic successful empty page cannot replace it.
  async primaryCanonicalConsumers(node, { header, scope, offset = 0, limit = 3, signal,
    creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal);
    const parent = checkedHistoryRootOpenHeader(header), metadata = checkedDescriptor(node, this.identity);
    const expected = scope === 'canonical' ? parent.durableMetadata : parent.sourceMetadata;
    const total = scope === 'canonical' ? parent.canonicalEntryCount : parent.sourceEntryCount;
    if (this.pending || typeof invoke !== 'function' || !validCredit(creditBytes)
      || !['canonical', 'prepared'].includes(scope) || !integer(offset) || !integer(limit) || limit < 1 || limit > 3
      || !integer(total) || offset > total || !sameIdentity(parent, this.identity)
      || parent.readProfile !== 'history-primary-v1' || parent.metadataSchema !== 1 || parent.semanticSnapshotComplete !== true
      || !checkedHistoryPrimaryReuseHeader(parent) || parent.viewRevisionToken !== this.identity.revision
      || parent.canonicalConsumers?.profile !== PRIMARY_CANONICAL_CONSUMERS || parent.canonicalConsumers.maxItems !== 3
      || parent.root.nodeToken !== this.root.nodeToken || parent.root.kind !== this.root.kind || parent.root.length !== this.root.length
      || metadata.kind !== 'array' || !expected || metadata.nodeToken !== expected.nodeToken || metadata.length !== total
      || !integer(parent.canonicalEntryCount) || !integer(parent.sourceEntryCount)) {
      throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_INVALID');
    }
    const request = { ...this.identity, nodeToken: metadata.nodeToken, parentNodeToken: this.root.nodeToken,
      kind: 'primary-canonical-consumers', profile: PRIMARY_CANONICAL_CONSUMERS, scope, offset, limit,
      semanticIdentity: parent.semanticIdentity, metadataIdentity: parent.metadataIdentity, metadataSchema: 1,
      semanticRevisionToken: parent.semanticRevisionToken, viewRevisionToken: parent.viewRevisionToken,
      canonicalEntryCount: parent.canonicalEntryCount, sourceEntryCount: parent.sourceEntryCount, creditBytes };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_CREDIT_BYTES) {
      throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_INVALID');
    }
    this.pending = true;
    try {
      const result = await invoke(this.pageChannel, request);
      this.assertOpen(signal);
      if (result?.success !== true) {
        const keys = ['success', 'error', 'minimumCreditBytes', ...IDENTITY];
        if (!record(result) || result.success !== false || typeof result.error !== 'string'
          || !/^[A-Z][A-Z0-9_]{0,159}$/.test(result.error) || Object.keys(result).some(key => !keys.includes(key))
          || IDENTITY.some(key => own(result, key) && result[key] !== this.identity[key])) {
          throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_PROTOCOL');
        }
        const error = failure(result.error);
        if (integer(result.minimumCreditBytes) && result.minimumCreditBytes > creditBytes
          && result.minimumCreditBytes <= MAX_CREDIT_BYTES) error.minimumCreditBytes = result.minimumCreditBytes;
        throw error;
      }
      const keys = ['success', ...IDENTITY, 'kind', 'profile', 'scope', 'nodeToken', 'parentNodeToken',
        'semanticIdentity', 'metadataIdentity', 'metadataSchema', 'semanticRevisionToken', 'viewRevisionToken',
        'canonicalEntryCount', 'sourceEntryCount', 'root', 'total', 'offset', 'nextOffset', 'done', 'items', 'creditBytesUsed'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(key => own(result, key))
        || !sameIdentity(result, this.identity) || result.kind !== request.kind || result.profile !== PRIMARY_CANONICAL_CONSUMERS
        || result.scope !== scope || result.nodeToken !== metadata.nodeToken || result.parentNodeToken !== this.root.nodeToken
        || result.semanticIdentity !== parent.semanticIdentity || result.metadataIdentity !== parent.metadataIdentity
        || result.metadataSchema !== 1 || result.semanticRevisionToken !== parent.semanticRevisionToken
        || result.viewRevisionToken !== parent.viewRevisionToken || result.canonicalEntryCount !== parent.canonicalEntryCount
        || result.sourceEntryCount !== parent.sourceEntryCount || result.total !== total || result.offset !== offset
        || !integer(result.nextOffset) || result.nextOffset > total || typeof result.done !== 'boolean'
        || !Array.isArray(result.items) || result.items.length > limit || result.nextOffset !== offset + result.items.length
        || result.done !== (result.nextOffset === total) || (!result.done && !result.items.length)) {
        throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_PROTOCOL');
      }
      checkWireCredit(result, creditBytes);
      const root = checkedDescriptor(result.root, this.identity);
      if (root.kind !== 'array' || root.length !== total) throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_PROTOCOL');
      const items = result.items.map((item, index) => {
        if (!record(item) || Object.keys(item).length !== 2 || !own(item, 'ordinal') || !own(item, 'row')
          || item.ordinal !== offset + index) throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_PROTOCOL');
        const row = checkedDescriptor(item.row, this.identity);
        if (row.kind !== 'object') throw failure('HISTORY_PRIMARY_CANONICAL_CONSUMERS_QUERY_PROTOCOL');
        return Object.freeze({ ordinal: item.ordinal, row });
      });
      this.assertOpen(signal);
      return Object.freeze({ scope, root, total, offset, nextOffset: result.nextOffset, done: result.done,
        items: Object.freeze(items) });
    } finally { this.pending = false; }
  }
  // Dedicated producer proof is mandatory even for an empty result. An older
  // worker's generic field scan must never become canonical prompt absence.
  // Both modes use COMPLETE pre-overlay fields; returned matches stay thin
  // metadata descriptors. Scan mode is a proved cursor, not a negative result.
  async primaryPromptIdentity(node, { header, mode = 'point', value = null, signal,
    creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal);
    const parent=checkedHistoryRootOpenHeader(header),canonicalMetadata=checkedDescriptor(node,this.identity);
    if(this.pending||typeof invoke!=='function'||!validCredit(creditBytes)||!sameIdentity(parent,this.identity)
      ||parent.readProfile!=='history-primary-v1'||parent.metadataSchema!==1||parent.semanticSnapshotComplete!==true
      ||!checkedHistoryPrimaryReuseHeader(parent)||parent.viewRevisionToken!==this.identity.revision
      ||parent.root.nodeToken!==this.root.nodeToken||parent.root.kind!==this.root.kind||parent.root.length!==this.root.length
      ||canonicalMetadata.kind!=='array'||canonicalMetadata.nodeToken!==parent.durableMetadata.nodeToken
      ||canonicalMetadata.length!==parent.canonicalEntryCount||canonicalMetadata.length!==parent.durableMetadata.length
      ||!['point','scan'].includes(mode)||(mode==='scan'?value!==null:
        typeof value!=='string'||value.length>2048||new TextEncoder().encode(value).byteLength>4096)) {
      throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_INVALID');
    }
    this.pending=true;
    try {
      const result=await invoke(this.pageChannel,{...this.identity,nodeToken:canonicalMetadata.nodeToken,
        parentNodeToken:this.root.nodeToken,kind:'primary-prompt-identity',mode,value,
        semanticIdentity:parent.semanticIdentity,metadataIdentity:parent.metadataIdentity,metadataSchema:1,
        semanticRevisionToken:parent.semanticRevisionToken,viewRevisionToken:parent.viewRevisionToken,
        canonicalEntryCount:parent.canonicalEntryCount,creditBytes});
      this.assertOpen(signal);
      if(result?.success!==true) {
        const keys=['success','error','minimumCreditBytes',...IDENTITY];
        if(!record(result)||result.success!==false||typeof result.error!=='string'||!/^[A-Z][A-Z0-9_]{0,159}$/.test(result.error)
          ||Object.keys(result).some(k=>!keys.includes(k))||IDENTITY.some(k=>own(result,k)&&result[k]!==this.identity[k])) {
          throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_PROTOCOL');
        }
        const error=failure(result.error);
        if(integer(result.minimumCreditBytes)&&result.minimumCreditBytes>creditBytes&&result.minimumCreditBytes<=MAX_CREDIT_BYTES)error.minimumCreditBytes=result.minimumCreditBytes;
        throw error;
      }
      const keys=['success',...IDENTITY,'kind','mode','proof','nodeToken','parentNodeToken','semanticIdentity','metadataIdentity',
        'metadataSchema','semanticRevisionToken','viewRevisionToken','canonicalEntryCount','value','canonical','match','creditBytesUsed'];
      if(!record(result)||Object.keys(result).length!==keys.length||!keys.every(k=>own(result,k))
        ||!sameIdentity(result,this.identity)||result.kind!=='primary-prompt-identity'||result.mode!==mode
        ||result.proof!=='canonical-prompt-identity-v1'||result.nodeToken!==canonicalMetadata.nodeToken
        ||result.parentNodeToken!==this.root.nodeToken||result.semanticIdentity!==parent.semanticIdentity
        ||result.metadataIdentity!==parent.metadataIdentity||result.metadataSchema!==1
        ||result.semanticRevisionToken!==parent.semanticRevisionToken||result.viewRevisionToken!==parent.viewRevisionToken
        ||result.canonicalEntryCount!==parent.canonicalEntryCount||result.value!==value
        ||mode==='scan'&&result.match!==null)throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_PROTOCOL');
      checkWireCredit(result,creditBytes);
      const canonical=checkedDescriptor(result.canonical,this.identity);
      if(canonical.kind!=='array'||canonical.length!==parent.canonicalEntryCount)throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_PROTOCOL');
      let match=null;
      if(result.match!==null) {
        const item=result.match;
        if(!record(item)||Object.keys(item).length!==2||!own(item,'ordinal')||!own(item,'row')
          ||!integer(item.ordinal)||item.ordinal>=parent.canonicalEntryCount)throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_PROTOCOL');
        const row=checkedDescriptor(item.row,this.identity);
        if(row.kind!=='object')throw failure('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_PROTOCOL');
        match=Object.freeze({ordinal:item.ordinal,row});
      }
      this.assertOpen(signal);return Object.freeze({canonical,match});
    } finally { this.pending=false; }
  }
  // Complete historical slash-field selection from THIS held semantic cut.
  // Resolve each non-null field with ordinary forkText + the existing settings
  // utility; these are slash contents, not naked values. The scalar proofAt
  // includes earlier matched timestamps not present in the selected fields.
  // Supply the existing demand-aware invoke for server-side cancellation. This
  // observation never closes the shared parent, retries or writes settings.
  async primaryEffectiveSettings(node, { header, signal, creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal);
    const parent = checkedHistoryRootOpenHeader(header), canonical = checkedDescriptor(node, this.identity);
    if (this.pending || typeof invoke !== 'function' || !validCredit(creditBytes)
      || !sameIdentity(parent, this.identity) || parent.readProfile !== 'history-primary-v1'
      || parent.metadataSchema !== 1 || parent.semanticSnapshotComplete !== true
      || !checkedHistoryPrimaryReuseHeader(parent) || parent.viewRevisionToken !== this.identity.revision
      || parent.root.nodeToken !== this.root.nodeToken || parent.root.kind !== this.root.kind
      || parent.root.length !== this.root.length || canonical.kind !== 'array'
      || canonical.nodeToken !== parent.durableMetadata.nodeToken
      || canonical.length !== parent.canonicalEntryCount || canonical.length !== parent.durableMetadata.length) {
      throw failure('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_INVALID');
    }
    this.pending = true;
    try {
      const result = await invoke(this.pageChannel, { ...this.identity, nodeToken: canonical.nodeToken,
        parentNodeToken: this.root.nodeToken, kind: 'primary-effective-settings',
        semanticIdentity: parent.semanticIdentity, metadataIdentity: parent.metadataIdentity, metadataSchema: 1,
        semanticRevisionToken: parent.semanticRevisionToken, viewRevisionToken: parent.viewRevisionToken,
        canonicalEntryCount: parent.canonicalEntryCount, creditBytes });
      this.assertOpen(signal);
      if (result?.success !== true) {
        const refusalKeys = ['success', 'error', 'minimumCreditBytes', ...IDENTITY];
        if (!record(result) || result.success !== false || typeof result.error !== 'string'
          || !/^[A-Z][A-Z0-9_]{0,159}$/.test(result.error) || Object.keys(result).some(key => !refusalKeys.includes(key))
          || IDENTITY.some(key => own(result, key) && result[key] !== this.identity[key])) {
          throw failure('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_PROTOCOL');
        }
        const error = failure(result.error);
        if (integer(result.minimumCreditBytes) && result.minimumCreditBytes > creditBytes
          && result.minimumCreditBytes <= MAX_CREDIT_BYTES) error.minimumCreditBytes = result.minimumCreditBytes;
        throw error;
      }
      const keys = ['success', ...IDENTITY, 'nodeToken', 'parentNodeToken', 'kind', 'semanticIdentity',
        'metadataIdentity', 'metadataSchema', 'semanticRevisionToken', 'viewRevisionToken', 'canonicalEntryCount',
        'valueEncoding', 'model', 'effort', 'proofAt', 'proof', 'producerBounded', 'nativeMemoryMeasured', 'creditBytesUsed'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(key => own(result, key))
        || !sameIdentity(result, this.identity) || result.nodeToken !== canonical.nodeToken
        || result.parentNodeToken !== this.root.nodeToken || result.kind !== 'primary-effective-settings'
        || result.semanticIdentity !== parent.semanticIdentity || result.metadataIdentity !== parent.metadataIdentity
        || result.metadataSchema !== 1 || result.semanticRevisionToken !== parent.semanticRevisionToken
        || result.viewRevisionToken !== parent.viewRevisionToken || result.canonicalEntryCount !== canonical.length
        || result.valueEncoding !== 'slash-content-fields-v1' || !integer(result.proofAt)
        || result.producerBounded !== false || result.nativeMemoryMeasured !== false
        || (result.model === null && result.effort === null
          ? result.proof !== null || result.proofAt !== 0 : result.proof !== 'rollout-turn-context')) {
        throw failure('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_PROTOCOL');
      }
      checkWireCredit(result, creditBytes);
      const field = value => {
        if (value === null) return null;
        const allowed = ['protocol', ...IDENTITY, 'kind', 'nodeToken', 'length', 'digest', 'encoding'];
        if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))
          || own(value, 'encoding') && value.encoding !== 'utf16le') {
          throw failure('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_PROTOCOL');
        }
        const descriptor = checkedDescriptor(value, this.identity);
        if (descriptor.kind !== 'text' || !descriptor.length) throw failure('HISTORY_PRIMARY_EFFECTIVE_SETTINGS_QUERY_PROTOCOL');
        return descriptor;
      };
      const model = field(result.model), effort = field(result.effort);
      this.assertOpen(signal);
      return Object.freeze({ model, effort, proofAt: result.proofAt, proof: result.proof,
        valueEncoding: result.valueEncoding, semanticIdentity: parent.semanticIdentity, metadataIdentity: parent.metadataIdentity });
    } finally { this.pending = false; }
  }
  // Direct presentation addresses are independently proved by the producer.
  // In particular, an old generic find packet cannot prove absence or grant a
  // physical key. Long inputs use scan + source-rank under the same held cut.
  async primaryPresentationAddresses(node, { header, mode = 'range', offset = 0, limit = 3,
    value = null, tool = null, signal, creditBytes = this.pageBytes, invoke = this.invoke } = {}) {
    this.assertOpen(signal);
    const parent = checkedHistoryRootOpenHeader(header), root = checkedDescriptor(node, this.identity);
    const modes = ['range', 'uuid', 'group', 'key', 'target', 'scan', 'source-rank'];
    const input = v => typeof v === 'string' && v.length <= 2048 && new TextEncoder().encode(v).byteLength <= 4096;
    const validTool = tool === null || record(tool)
      && Object.keys(tool).every(k => ['toolUseId', 'messageReference'].includes(k))
      && (tool.messageReference !== undefined ? record(tool.messageReference)
        && Object.keys(tool.messageReference).every(k => ['physicalSessionId', 'sessionId', 'transcriptSegmentId', 'rawUuid'].includes(k)
          && input(tool.messageReference[k])) && (tool.toolUseId === undefined || input(tool.toolUseId)) : input(tool.toolUseId));
    if (this.pending || typeof invoke !== 'function' || !validCredit(creditBytes)
      || !sameIdentity(parent, this.identity) || parent.readProfile !== 'history-primary-v1'
      || parent.semanticSnapshotComplete !== true || !checkedHistoryPrimaryReuseHeader(parent)
      || parent.presentationAddresses?.profile !== PRIMARY_PRESENTATION_ADDRESSES
      || parent.presentationAddresses.maxItems !== 3 || parent.viewRevisionToken !== this.identity.revision
      || root.nodeToken !== this.root.nodeToken || root.nodeToken !== parent.root.nodeToken
      || root.kind !== 'array' || root.length !== parent.totalEntries || root.length !== this.root.length
      || !modes.includes(mode) || !integer(offset) || !integer(limit) || limit < 1 || limit > Math.min(this.pageItems, 3)
      || !validTool || mode !== 'target' && tool !== null
      || (['range', 'scan', 'source-rank'].includes(mode) ? value !== null : !input(value))
      || !['range', 'source-rank'].includes(mode) && offset !== 0) throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
    const capturedTool = tool === null ? null : Object.freeze({
      ...(tool.toolUseId !== undefined ? { toolUseId: tool.toolUseId } : {}),
      ...(tool.messageReference !== undefined ? { messageReference: Object.freeze({ ...tool.messageReference }) } : {}),
    });
    this.pending = true;
    try {
      const request = { ...this.identity, nodeToken: root.nodeToken,
        kind: 'primary-presentation-address', profile: PRIMARY_PRESENTATION_ADDRESSES, mode,
        semanticIdentity: parent.semanticIdentity, metadataIdentity: parent.metadataIdentity,
        semanticRevisionToken: parent.semanticRevisionToken, viewRevisionToken: parent.viewRevisionToken,
        offset, limit, value, tool: capturedTool, creditBytes };
      if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_CREDIT_BYTES) {
        throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
      }
      const result = await invoke(this.pageChannel, request);
      this.assertOpen(signal);
      if (result?.success !== true) {
        const keys = ['success', 'error', 'minimumCreditBytes', ...IDENTITY];
        if (!record(result) || result.success !== false || typeof result.error !== 'string'
          || !/^[A-Z][A-Z0-9_]{0,159}$/.test(result.error) || Object.keys(result).some(k => !keys.includes(k))
          || IDENTITY.some(k => own(result, k) && result[k] !== this.identity[k])) throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
        const error = failure(result.error);
        if (integer(result.minimumCreditBytes) && result.minimumCreditBytes > creditBytes
          && result.minimumCreditBytes <= MAX_CREDIT_BYTES) error.minimumCreditBytes = result.minimumCreditBytes;
        throw error;
      }
      const keys = ['success', ...IDENTITY, 'nodeToken', 'kind', 'profile', 'mode', 'semanticIdentity', 'metadataIdentity',
        'semanticRevisionToken', 'viewRevisionToken', 'totalCount', 'sourceCount', 'offset', 'nextOffset', 'done',
        'status', 'items', 'source', 'creditBytesUsed'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(k => own(result, k))
        || !sameIdentity(result, this.identity) || result.nodeToken !== root.nodeToken
        || result.kind !== 'primary-presentation-address' || result.profile !== PRIMARY_PRESENTATION_ADDRESSES || result.mode !== mode
        || result.semanticIdentity !== parent.semanticIdentity || result.metadataIdentity !== parent.metadataIdentity
        || result.semanticRevisionToken !== parent.semanticRevisionToken || result.viewRevisionToken !== parent.viewRevisionToken
        || result.totalCount !== root.length || !integer(result.sourceCount) || result.sourceCount !== parent.sourceEntryCount
        || result.offset !== offset || !integer(result.nextOffset) || typeof result.done !== 'boolean'
        || !Array.isArray(result.items) || result.items.length > limit) throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
      checkWireCredit(result, creditBytes);
      const point = !['range', 'scan'].includes(mode);
      if (mode === 'range' ? result.status !== 'range' || result.source !== null
        || result.nextOffset !== offset + result.items.length || result.nextOffset > root.length
        || result.done !== (result.nextOffset === root.length) || !result.done && !result.items.length
        : mode === 'scan' ? result.status !== 'scan' || result.items.length !== 0 || result.nextOffset !== offset || result.done !== true
        : !['found', 'absent', 'ambiguous'].includes(result.status) || result.source !== null || result.done !== true
          || result.nextOffset !== offset || result.items.length !== (result.status === 'found' ? 1 : 0)
          || result.status === 'ambiguous' && !['target', 'key'].includes(mode)) throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
      const source = mode === 'scan' ? checkedDescriptor(result.source, this.identity) : null;
      if (source && (source.kind !== 'array' || source.length !== result.sourceCount)) throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
      const sourcePoint = point && ['uuid', 'target', 'source-rank'].includes(mode);
      const items = result.items.map((item, index) => {
        if (!record(item) || Object.keys(item).length !== 4 || !['rank', 'header', 'sourceOrdinal', 'entry'].every(k => own(item, k))
          || !integer(item.rank) || item.rank >= root.length || mode === 'range' && item.rank !== offset + index
          || (sourcePoint ? !integer(item.sourceOrdinal) || item.sourceOrdinal >= result.sourceCount
            || mode === 'source-rank' && item.sourceOrdinal !== offset : item.sourceOrdinal !== null || item.entry !== null)) {
          throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
        }
        const descriptor = checkedDescriptor(item.header, this.identity);
        const entry = sourcePoint ? checkedDescriptor(item.entry, this.identity) : null;
        if (descriptor.kind !== 'object' || entry && entry.kind !== 'object') throw failure('HISTORY_PRIMARY_ADDRESS_QUERY_PROTOCOL');
        return Object.freeze({ rank: item.rank, header: descriptor, sourceOrdinal: item.sourceOrdinal, entry });
      });
      return Object.freeze({ mode, status: result.status, totalCount: result.totalCount, sourceCount: result.sourceCount,
        offset, nextOffset: result.nextOffset, done: result.done, items: Object.freeze(items), source });
    } finally { this.pending = false; }
  }
  range(node = this.root, options) { return this.page(node, 'range', options); }
  rowWindow(node = this.root, options) { return this.page(node, 'rowWindow', options); }
  fields(node = this.root, options) { return this.page(node, 'fields', options); }
  project(node, fields, options = {}) { return this.page(node, 'projection', { ...options, fields }); }
  find(node, field, value, options = {}) { return this.page(node, 'find', { ...options, field, value }); }
  text(node) { return new HistoryTextDocument(this, checkedDescriptor(node, this.identity)); }
  async forkCanonicalConsumerValue(node, options = {}) {
    this.assertOpen(options.signal);
    const descriptor = checkedDescriptor(node, this.identity), operation = options.operation;
    const field = options.field, index = options.index, memberField = options.memberField;
    const fields = ['role', 'content', 'recordByteOffset', 'sourceIdentity', 'sourceIdentityAliases', 'uuid', 'sessionId', 'timestamp',
      'sourceUuidAliases', 'semanticTags', 'liveProjection', 'promptChips', 'imagePaths'];
    const invoke = options.invoke ?? this.invoke;
    if (!['string-falsy', 'number', 'queue-identity', 'kind', 'array-length',
      'truthy', 'live-setting-kind', 'live-setting-value', 'prompt-identity', 'prompt-selected-identity', 'graph-identity', 'array-some-check'].includes(operation) || typeof invoke !== 'function'
      || (['queue-identity', 'live-setting-kind', 'live-setting-value', 'prompt-selected-identity'].includes(operation)
        && (descriptor.kind !== 'object' || field !== undefined || index !== undefined))
      || field !== undefined && (!fields.includes(field) || descriptor.kind !== 'object')
      || index !== undefined && (!integer(index) || field === undefined && descriptor.kind !== 'array')
      || memberField !== undefined && (field !== 'semanticTags' || index === undefined
        || !['kind', 'runId', 'phase'].includes(memberField))) {
      throw failure('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY_INVALID');
    }
    const request = { ...this.identity, nodeToken: descriptor.nodeToken,
      encoding: PRIMARY_CANONICAL_VALUE_ENCODING, operation,
      ...(field !== undefined ? { field } : {}), ...(index !== undefined ? { index } : {}),
      ...(memberField !== undefined ? { memberField } : {}) };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_CREDIT_BYTES) {
      throw failure('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY_INVALID');
    }
    let response, child, abandoned = false, discarded = false, rejectAbort;
    const discard = result => {
      if (discarded || child || !result?.success) return;
      let identity;
      // Prefer the independent admission receipt. A corrupt nested descriptor
      // must not orphan the child, and no alternate parent/foreign owner may
      // be released while rejecting that malformed reply.
      for (const candidate of [result, result.payloadDocument]) {
        try {
          const value = historyRootIdentity(candidate);
          if (value.leaseId !== this.identity.leaseId
            && ['ownerKey', 'revision', 'generation'].every(key => value[key] === this.identity[key])) { identity = value; break; }
        } catch {}
      }
      if (!identity) return;
      discarded = true;
      try { Promise.resolve(this.invoke(this.releaseChannel, identity)).catch(() => {}); } catch {}
    };
    const cancelled = new Promise((_resolve, reject) => { rejectAbort = reject; });
    cancelled.catch(() => {});
    const onAbort = () => { abandoned = true; discard(response); rejectAbort(failure('HISTORY_READ_CANCELLED')); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.assertOpen(options.signal);
      const pending = Promise.resolve(invoke(this.forkChannel, request));
      pending.then(result => { response = result; if (abandoned || this.closed || options.signal?.aborted) discard(result); }, () => {});
      const result = await Promise.race([pending, this.closedPromise, cancelled]);
      this.assertOpen(options.signal);
      if (result?.success !== true) throw failure(result?.error || 'HISTORY_PRIMARY_CANONICAL_VALUE_FAILED');
      const keys = ['success', '__notedHistoryTransport', ...IDENTITY, 'payloadDocument', 'totalChars', 'encoding', 'operation'];
      if (!record(result) || Object.keys(result).length !== keys.length || !keys.every(key => own(result, key))
        || result.__notedHistoryTransport !== 'root-v1' || result.encoding !== PRIMARY_CANONICAL_VALUE_ENCODING
        || result.operation !== operation || new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CREDIT_BYTES) {
        throw failure('HISTORY_PRIMARY_CANONICAL_VALUE_PROTOCOL');
      }
      const identity = historyRootIdentity(result), document = checkedDescriptor(result.payloadDocument, identity);
      if (identity.leaseId === this.identity.leaseId
        || ['ownerKey', 'revision', 'generation'].some(key => identity[key] !== this.identity[key])
        || document.kind !== 'text' || result.totalChars !== document.length) {
        throw failure('HISTORY_PRIMARY_CANONICAL_VALUE_PROTOCOL');
      }
      child = new HistoryRootClient(this.invoke, document, { pageBytes: this.pageBytes, pageItems: this.pageItems,
        pageChannel: this.pageChannel, releaseChannel: this.releaseChannel, forkChannel: this.forkChannel });
      return child.text(child.root);
    } catch (error) { if (!child) discard(response); throw error; }
    finally { options.signal?.removeEventListener('abort', onAbort); }
  }
  // Independent selected-body owner; a request ID is also release authority.
  // Unsupported is an authenticated branch decision, never error fallback.
  async borrowEntryBody(node, { signal } = {}) {
    this.assertOpen(signal);
    const header = checkedDescriptor(node, this.identity);
    if (header.kind !== 'object') throw failure('HISTORY_ROOT_UNIT_HEADER');
    const bodyRequestId = globalThis.crypto.randomUUID(), encoding = 'history-entry-body-borrow-v1';
    let response, child, abandoned = false, discarded = false, rejectCancel;
    const discard = result => {
      if (discarded || child || result?.success !== true || result.kind === 'unsupported') return;
      for (const candidate of [result, result.root]) {
        let identity; try { identity = historyRootIdentity(candidate); } catch { continue; }
        if (identity.leaseId === this.identity.leaseId
          || ['ownerKey','revision','generation'].some(key => identity[key] !== this.identity[key])) continue;
        discarded = true;
        // Use OUR captured ID even for malformed/late/wrong-ID replies. A
        // sibling's returned request ID is never authority to release it.
        try { Promise.resolve(this.invoke(this.releaseChannel, { ...identity, bodyRequestId })).catch(() => {}); } catch {}
        break;
      }
    };
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; }); cancelled.catch(() => {});
    const onAbort = () => { abandoned = true; discard(response); rejectCancel(failure('HISTORY_READ_CANCELLED')); };
    const unsubscribe = this.subscribeClose(onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.assertOpen(signal);
      const pending = Promise.resolve(this.invoke(this.forkChannel,
        { ...this.identity, nodeToken: header.nodeToken, encoding, bodyRequestId }));
      pending.then(result => { response = result; if (abandoned || this.closed || signal?.aborted) discard(result); }, () => {});
      const result = await Promise.race([pending, cancelled]); this.assertOpen(signal);
      if (result?.success !== true) throw failure(result?.error || 'HISTORY_BODY_FORK_FAILED');
      if (result.bodyRequestId !== bodyRequestId || result.encoding !== encoding
        || new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CREDIT_BYTES) throw failure('HISTORY_BODY_BINDING');
      const identity = historyRootIdentity(result);
      if (result.kind === 'unsupported') {
        if (!sameIdentity(identity, this.identity) || Object.keys(result).length !== 8) throw failure('HISTORY_BODY_BINDING');
        return null;
      }
      const root = checkedDescriptor(result.root, identity);
      if (result.kind !== 'entry-body' || result.__notedHistoryTransport !== 'root-v1'
        || Object.keys(result).length !== 10 || root.kind !== 'object'
        || identity.leaseId === this.identity.leaseId
        || ['ownerKey','revision','generation'].some(key => identity[key] !== this.identity[key])) throw failure('HISTORY_BODY_BINDING');
      const invoke = async (channel, payload) => {
        if (!sameIdentity(payload, identity)) throw failure('HISTORY_BODY_BINDING');
        const reply = await this.invoke(channel, { ...payload, bodyRequestId });
        if (channel === this.pageChannel && reply?.success === true && reply.bodyRequestId !== bodyRequestId) throw failure('HISTORY_BODY_BINDING');
        return reply;
      };
      child = new HistoryRootClient(invoke, root, { pageBytes: this.pageBytes, pageItems: this.pageItems,
        pageChannel: this.pageChannel, releaseChannel: this.releaseChannel, forkChannel: this.forkChannel });
      child.bodyBorrow = true;
      return child;
    } catch (error) { abandoned = true; if (!child) discard(response); throw error; }
    finally { signal?.removeEventListener('abort', onAbort); unsubscribe(); }
  }
  async forkViewUnit(node, options = {}) {
    this.assertOpen(options.signal);
    const header = checkedDescriptor(node, this.identity);
    if(header.kind !== 'object')throw failure('HISTORY_ROOT_UNIT_HEADER');
    let response, child, abandoned=false, discarded=false, rejectAbort;
    const discard = result => {
      if(discarded || child || !result?.success)return;
      let identity;try{identity=historyRootIdentity(result);}catch{
        try{identity=historyRootIdentity(result.payloadDocument);}catch{return;}
      }
      if(identity.leaseId===this.identity.leaseId)return;
      discarded=true;
      try{Promise.resolve(this.invoke(this.releaseChannel,identity)).catch(()=>{});}catch{}
    };
    const cancelled=new Promise((_resolve,reject)=>{rejectAbort=reject;});cancelled.catch(()=>{});
    const onAbort=()=>{abandoned=true;discard(response);rejectAbort(failure('HISTORY_READ_CANCELLED'));};
    options.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      this.assertOpen(options.signal);
      const pending=Promise.resolve(this.invoke(this.forkChannel,{...this.identity,nodeToken:header.nodeToken,encoding:'history-display-unit-v8-v1'}));
      pending.then(result=>{response=result;if(abandoned||this.closed||options.signal?.aborted)discard(result);},()=>{});
      const result=await Promise.race([pending,this.closedPromise,cancelled]);this.assertOpen(options.signal);
      if(!result?.success)throw failure(result?.error||'HISTORY_ROOT_FORK_FAILED');
      const identity=historyRootIdentity(result),document=checkedDescriptor(result.payloadDocument,identity);
      if(identity.leaseId===this.identity.leaseId||['ownerKey','revision','generation'].some(key=>identity[key]!==this.identity[key])
        ||document.kind!=='text'||result.totalChars!==document.length||result.encoding!=='history-display-unit-v8-v1') {
        throw failure('HISTORY_ROOT_FORK_IDENTITY');
      }
      child=new HistoryRootClient(this.invoke,document,{...options,pageBytes:this.pageBytes,pageItems:this.pageItems,
        pageChannel:this.pageChannel,releaseChannel:this.releaseChannel,forkChannel:this.forkChannel});
      return child.text(child.root);
    }catch(error){if(!child)discard(response);throw error;}
    finally{options.signal?.removeEventListener('abort',onAbort);}
  }
  async forkText(node, options = {}) {
    this.assertOpen(options.signal);
    const descriptor = checkedDescriptor(node, this.identity);
    if (descriptor.kind !== 'text') throw failure('HISTORY_ROOT_NOT_TEXT');
    let response, abandoned = false, released = false, child, rejectAbort;
    const discard = result => {
      if (released || child || !result?.payloadDocument) return;
      try {
        const identity = historyRootIdentity(result.payloadDocument);
        if (identity.leaseId === this.identity.leaseId) return;
        released = true;
        Promise.resolve(this.invoke(this.releaseChannel, identity)).catch(() => {});
      } catch { /* Lost cleanup ACK does not permit a new lease/open. */ }
    };
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const onAbort = () => {
      abandoned = true; discard(response); rejectAbort(failure('HISTORY_READ_CANCELLED'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.assertOpen(options.signal);
      const pending = Promise.resolve(this.invoke(this.forkChannel, { ...this.identity, nodeToken: descriptor.nodeToken }));
      pending.then(result => {
        response = result;
        if (abandoned || this.closed || options.signal?.aborted) discard(result);
      }, () => {});
      const result = await Promise.race([pending, this.closedPromise, aborted]);
      this.assertOpen(options.signal);
      const opened = result?.payloadDocument;
      if (!result?.success || !opened) throw failure(result?.error || 'HISTORY_ROOT_FORK_FAILED');
      // Forking keeps exactly this immutable leaf; a new lease must not
      // silently select another owner, revision, generation or text value.
      if (opened.leaseId === this.identity.leaseId
        || ['ownerKey', 'revision', 'generation'].some(key => opened[key] !== this.identity[key])
        || opened.length !== descriptor.length || opened.digest !== descriptor.digest) throw failure('HISTORY_ROOT_FORK_IDENTITY');
      child = new HistoryRootClient(this.invoke, opened, { ...options, pageBytes: this.pageBytes,
        pageItems: this.pageItems, pageChannel: this.pageChannel, releaseChannel: this.releaseChannel, forkChannel: this.forkChannel });
      return child.text(child.root);
    } catch (error) {
      abandoned = true;
      if (child) void child.close().catch(() => {}); else discard(response);
      throw error;
    } finally { options.signal?.removeEventListener('abort', onAbort); }
  }
  // A malformed open may echo an already retained lease. Retire only this
  // duplicate local consumer (including its abort listener), never that lease.
  abandon() { return this.finishClose(false); }
  close() { return this.finishClose(true); }
  finishClose(releaseLease) {
    if (this.releasePromise) return this.releasePromise;
    this.closed = true; this.signal?.removeEventListener('abort', this.abort);
    this.rejectClosed(failure('HISTORY_READ_CANCELLED'));
    // Mark before invoking even a synchronous adapter: cleanup is exactly one
    // attempt. A lost release ACK is not permission to reopen/replay a read.
    this.releasePromise = releaseLease
      ? Promise.resolve().then(() => this.invoke(this.releaseChannel, this.identity)) : Promise.resolve();
    const listeners = this.closeListeners;
    this.closeListeners = null;
    if (listeners) {
      for (const listener of listeners) { try { listener(); } catch {} }
      listeners.clear();
    }
    return this.releasePromise;
  }
}

export class HistoryTextDocument {
  constructor(reader, descriptor) {
    if (descriptor.kind !== 'text') throw failure('HISTORY_ROOT_NOT_TEXT');
    this.reader = reader; this.descriptor = descriptor;
    this.length = descriptor.length; this.digest = descriptor.digest;
    Object.freeze(this);
  }
  read(offset = 0, limit, options = {}) {
    return this.reader.page(this.descriptor, 'leaf', { ...options, offset,
      limit: limit === undefined ? Math.floor((options.creditBytes ?? this.reader.pageBytes) / 2) : limit });
  }
  /** @param {{offset?: number, end?: number, signal?: AbortSignal}} [options] */
  async *chunks({ offset = 0, end = this.length, signal } = {}) {
    if (!integer(offset) || !integer(end) || end < offset || end > this.length) throw failure('HISTORY_ROOT_RANGE_INVALID');
    while (offset < end) {
      const page = await this.read(offset, Math.min(end - offset, Math.floor(this.reader.pageBytes / 2)), { signal });
      yield page.text;
      offset += page.text.length;
    }
  }
  // Deliberately no String coercion or implicit JSON representation. Full
  // Copy/Input must choose an explicit streamed sink and retain its receipt.
  toString() { throw failure('HISTORY_ROOT_EXPLICIT_TEXT_SINK_REQUIRED'); }
  close() { return this.reader.close(); }
}

// Retained/current presentation coordinates have an independent read-only
// lifetime. They deliberately do not pass canonical Root header validation.
export { openHistoryPresentationPosition, HistoryPresentationPositionClient } from './history-presentation-position-client.mjs';
