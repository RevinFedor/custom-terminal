'use strict';

// One reader-owned immutable capability plane. The existing reader/cache owns
// the store, its disk budget and source admission. Opening a root feeds the
// original rooted reducer directly; no getHistory/DTO/captureLegacy conversion
// is allowed here. Public legacy calls keep their separately named contract.
const crypto = require('node:crypto');
const bodyBorrow = require('./history-root-body-borrow');
const v8 = require('node:v8');
const { beginUnitReadDiagnostic } = require('./history-unit-read-diagnostic');
const { CodexRootProjectionOwner } = require('./codex-root-projection-owner');
const { isHistoryPagedCursor, historyPagedCursorAddress,
  historyPagedCursorFromAddress, materializeHistoryCursor } = require('./history-paged-store');
const { encodeHistoryStream } = require('./history-stream-codec');
const { StringDecoder } = require('node:string_decoder');
const { HistoryProjectionArena } = require('./history-projection-arena');
const rootText = require('./history-paged-text');
const { forkFrozenCanonical } = require('./history-frozen-canonical');
const { primaryDependencyScope, primaryDependencyOutcome } = require('./history-primary-dependency-change');
const {readTimelineRootQuery}=require('./timeline-root-queries');
const {readPrimaryToolCoverage}=require('./history-primary-tool-coverage');
const {readPrimaryEffectiveSettings}=require('./history-primary-effective-settings');
const {readPrimaryPromptIdentity}=require('./history-primary-prompt-identity');
const { readPrimaryPresentationAddresses, HISTORY_PRIMARY_ADDRESS_PROFILE } = require('./history-primary-presentation-address');
const { readPrimaryCanonicalConsumers, HISTORY_PRIMARY_CANONICAL_CONSUMERS_PROFILE } = require('./history-primary-canonical-consumers');
const { HistoryPresentationPosition, HistoryPresentationPositionQuery, HISTORY_PRESENTATION_POSITION_PROFILE: POSITION_PROFILE,
  HISTORY_PRESENTATION_POSITION_QUERY_ENCODING: POSITION_QUERY_ENCODING } = require('./history-presentation-position');
const { forkPrimaryCanonicalConsumerValue } = require('./history-primary-canonical-value');
const { PROFILE: CANONICAL_METADATA_PROFILE, SCHEMA: CANONICAL_METADATA_SCHEMA,
  sourceProjection: metadataSourceProjection, digestJSON: metadataDigestJSON } = require('./history-primary-metadata-validation');

const { preparedPresentationCapability, forkPreparedPresentation } = require('./history-primary-prepared-presentation');
const { forkAgentCatalog, advanceAgentCatalog, assertAgentCatalogRead, readAgentCatalogMembership } = require('./history-primary-agent-catalog');

const PROTOCOL = 'root-v1';
const MAX_CREDIT_BYTES = 64 * 1024;
const DEFAULT_CREDIT_BYTES = 16 * 1024;
const MAX_ITEMS = 3;
const PRIMARY_METADATA_WINDOW = 'primary-metadata-fields-v1';
const MAX_TOKEN_BYTES = 1536;
const GROUP_DOCUMENT_SLOTS = 2;
const GROUP_DOCUMENT_BYTES = 64 * 1024;
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const integer = (value, name, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw fail(name);
  return value;
};
const shortString = (value, name, max = 4096) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw fail(name);
  return value;
};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const signature = (key, value) => crypto.createHmac('sha256', key).update(value).digest('base64url');
const wireBytes = value => Buffer.byteLength(JSON.stringify(value));
const releaseOnce = release => {
  let attempted = false;
  return () => { if (!attempted) { attempted = true; return release(); } };
};
const packetBytes = packet => {
  // Solve the byte-count field's own width before making a credit decision.
  let previous;
  do { previous = packet.creditBytesUsed; packet.creditBytesUsed = wireBytes(packet); }
  while (previous !== packet.creditBytesUsed);
  return packet.creditBytesUsed;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function equalsText(cursor, text) {
  if (cursor.kind !== 'text' || cursor.length !== text.length) return false;
  let at = 0;
  for (const part of cursor.textChunks()) {
    if (part !== text.slice(at, at + part.length)) return false;
    at += part.length;
  }
  return at === text.length;
}
async function payloadDigest(cursor, control) {
  const hash = crypto.createHash('sha256'); let high = '', steps = 0;
  // UTF8 hash matches existing historyPayloadHash, including a surrogate pair
  // straddling two stored UTF16 pages and replacement of lone surrogates.
  for (const part of cursor.textChunks()) {
    control?.assertCurrent();
    let chunk = high + part; high = '';
    if (/[\uD800-\uDBFF]/.test(chunk.at(-1) || '')) { high = chunk.at(-1); chunk = chunk.slice(0, -1); }
    if (chunk) hash.update(chunk, 'utf8');
    if (++steps % 64 === 0) { if (control?.checkpoint) await control.checkpoint(); else await tick(); }
  }
  if (high) hash.update(high, 'utf8');
  control?.assertCurrent(); return hash.digest('hex');
}

class HistoryRootReadPlane {
  constructor({ store, projectHistory, rootedOwner, projectTimeline = null, timelineOwner = null,
    prepareResult = null, forkPrimaryResult = null, forkTimelineResult = null, createTimelineDocument = null, maxRoots = 64,
    maxItems = MAX_ITEMS, inlineChars = 64 } = {}) {
    if (!store?.open || store.closed || typeof projectHistory !== 'function') throw fail('HISTORY_ROOT_CONFIGURATION');
    this.store = store;
    this.projectHistory = projectHistory;
    this.projectTimeline = projectTimeline;
    this.timelineOwner = timelineOwner;
    this.owner = rootedOwner || new CodexRootProjectionOwner(store);
    if (this.owner.store !== store) throw fail('HISTORY_ROOT_CONFIGURATION');
    if(timelineOwner && timelineOwner.store!==store)throw fail('HISTORY_ROOT_CONFIGURATION');
    this.prepareResult = prepareResult;
    this.forkPrimaryResult = forkPrimaryResult;
    this.forkTimelineResult = forkTimelineResult;
    this.createTimelineDocument=createTimelineDocument;
    this.maxRoots = integer(maxRoots, 'HISTORY_ROOT_LIMIT', 4096);
    this.maxItems = integer(maxItems, 'HISTORY_ROOT_ITEMS', 128);
    this.inlineChars = integer(inlineChars, 'HISTORY_ROOT_INLINE', 512);
    if (!this.maxRoots || !this.maxItems) throw fail('HISTORY_ROOT_CONFIGURATION');
    this.generation = crypto.randomUUID();
    this.secret = crypto.randomBytes(32);
    this.roots = new Map();
    this.opening = 0;
    this.closed = false;
    this.metrics = { opens: 0, closes: 0, pages: 0, textChars: 0, maxPacketBytes: 0,
      maxReturnedItems: 0, maxReturnedTextChars: 0, maxRoots: 0, producerBounded: false,
      nativeMemoryMeasured: false };
  }
  assertOpen() { if (this.closed) throw fail('HISTORY_ROOT_PLANE_CLOSED'); this.store.assertOpen(); }
  assertCapacity() {
    this.assertOpen();
    if (this.roots.size + this.opening >= this.maxRoots) throw fail('HISTORY_ROOT_LEASE_LIMIT');
  }
  identity(state) {
    return { leaseId: state.leaseId, ownerKey: state.ownerKey,
      revision: state.revision, generation: this.generation };
  }
  nodeToken(state, cursor) {
    const body = Buffer.from(JSON.stringify([state.leaseId, historyPagedCursorAddress(cursor)])).toString('base64url');
    const token = body + '.' + signature(this.secret, body);
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw fail('HISTORY_ROOT_ADDRESS_TOO_LARGE');
    return token;
  }
  cursor(state, token) {
    shortString(token, 'HISTORY_ROOT_NODE_TOKEN', MAX_TOKEN_BYTES);
    const separator = token.lastIndexOf('.');
    const body = token.slice(0, separator), digest = token.slice(separator + 1);
    const expected = signature(this.secret, body);
    if (separator < 1 || digest.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expected))) throw fail('HISTORY_ROOT_NODE_TOKEN');
    let address;
    try {
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== state.leaseId) throw new Error();
      address = decoded[1];
    } catch { throw fail('HISTORY_ROOT_NODE_TOKEN'); }
    return historyPagedCursorFromAddress(this.store, state.lease, address);
  }
  describe(state, cursor, { inline = true } = {}) {
    if (!isHistoryPagedCursor(cursor)) throw fail('HISTORY_ROOT_CURSOR_REQUIRED');
    const kind = cursor.kind;
    if (kind === 'text') {
      const info = cursor.textInfo();
      if (inline && info.length <= this.inlineChars) {
        let value = ''; for (const part of cursor.textChunks()) value += part;
        return { kind: 'scalar', type: 'string', value };
      }
      return { protocol: 'history-text-v1', ...this.identity(state), kind: 'text',
        nodeToken: this.nodeToken(state, cursor), ...info };
    }
    if (['scalar', 'number', 'bigint', 'undefined', 'scalar-root'].includes(kind)) {
      const value = cursor.scalar(), type = value === null ? 'null' : typeof value;
      if (type === 'bigint') return { kind: 'scalar', type, value: value.toString() };
      if (type === 'number') return { kind: 'scalar', type,
        value: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
      return { kind: 'scalar', type, ...(value === undefined ? {} : { value }) };
    }
    return { protocol: 'history-root-v1', ...this.identity(state), kind,
      nodeToken: this.nodeToken(state, cursor), ...(kind === 'array' ? { length: cursor.length } : {}) };
  }
  // Cursor addresses are fixed ref/owners/imported records, not graph paths.
  // Bound their wire size with maximum safe page/vector coordinates. Long text
  // (including property names) stays a signed descriptor, never inline content.
  metadataWindowBounds(state) {
    const n = Number.MAX_SAFE_INTEGER, vector = { page: n, depth: n, length: n };
    const address = { ref: { type: 'page', id: n }, owners: vector, imported: vector };
    const body = Buffer.from(JSON.stringify([state.leaseId, address])).toString('base64url');
    const token = body + '.' + signature(this.secret, body);
    const descriptor = wireBytes({ protocol: 'history-text-v1', ...this.identity(state), kind: 'text',
      nodeToken: token, length: n, digest: '0'.repeat(64) });
    const scalar = wireBytes({ kind: 'scalar', type: 'string', value: '\u0000'.repeat(this.inlineChars) });
    const ordinaryBytes = Math.max(descriptor, scalar, 128);
    // Scalar refs are stored inside a bounded field/array/scalar-root page.
    // A decimal BIGINT may therefore be almost pageBytes long even when
    // inlineChars is zero. Bound the persisted decimal plus its wire wrapper,
    // without reading any fields. Root entry/control overhead is a descriptor,
    // independent of that scalar bound (large pages simply make rows ineligible).
    const bigintBytes = this.store.pageBytes + wireBytes({ kind: 'scalar', type: 'bigint', value: '' });
    const valueBytes = Math.max(ordinaryBytes, bigintBytes);
    // Covers packet/row syntax, ordinals/counts and the signed row descriptor.
    const overhead = wireBytes(this.identity(state)) + ordinaryBytes + 1024;
    return { valueBytes, overhead };
  }
  metadataRowCredit(state, row) {
    const count = row.fieldCountUpperBound;
    if (count === null) return null;
    const { valueBytes, overhead } = this.metadataWindowBounds(state);
    const bytes = overhead + count * (valueBytes * 2 + 32);
    return Number.isSafeInteger(bytes) ? bytes : null;
  }
  metadataWindowRoot(state, cursor) {
    const p = state.primaryPresentation;
    return p?.metadataSchema === 1 && [p.sourceMetadataCursor, p.durableMetadataCursor]
      .some(root => root && this.nodeToken(state, root) === this.nodeToken(state, cursor));
  }
  canonicalMetadataBinding(state, validation = state.primaryPresentation?.canonicalMetadataValidation) {
    const p = state.primaryPresentation;
    if (!p || !validation || !['validated', 'refused'].includes(validation.kind)
      || validation.schema !== CANONICAL_METADATA_SCHEMA || !p.sourceMetadataCursor || !p.durableMetadataCursor
      || typeof p.validateCanonicalMetadata !== 'function') throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REQUIRED');
    const raw = validation.diagnosticTail;
    const diagnosticTail = validation.kind === 'refused' ? { kind: 'unavailable' }
      : raw?.kind === 'empty' ? { kind: 'empty' }
        : raw?.kind === 'row' ? { kind: 'row', ordinal: raw.ordinal, fields: raw.fields } : null;
    if (!diagnosticTail || validation.kind === 'validated' && (!/^[a-f0-9]{64}$/.test(validation.digest)
      || validation.canonicalEntryCount !== p.canonicalEntryCount
      || p.durableMetadataCursor.length !== p.canonicalEntryCount
      || (p.canonicalEntryCount === 0 ? diagnosticTail.kind !== 'empty'
        : diagnosticTail.kind !== 'row' || diagnosticTail.ordinal !== p.canonicalEntryCount - 1))) {
      throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REQUIRED');
    }
    const binding = { ...this.identity(state), profile: CANONICAL_METADATA_PROFILE, schema: CANONICAL_METADATA_SCHEMA,
      parentNodeToken: this.nodeToken(state, p.headerCursor),
      nodeToken: this.nodeToken(state, p.durableMetadataCursor), sourceNodeToken: this.nodeToken(state, p.sourceMetadataCursor),
      metadataIdentity: p.metadataIdentity, metadataSchema: p.metadataSchema, semanticIdentity: p.semanticIdentity,
      semanticRevisionToken: p.semanticRevisionToken, viewRevisionToken: p.viewRevisionToken,
      canonicalEntryCount: p.canonicalEntryCount, sourceEntryCount: p.sourceMetadataCursor.length,
      sourceProof: metadataDigestJSON(metadataSourceProjection(state.source)),
      validationDigest: validation.kind === 'validated' ? validation.digest : null,
      diagnosticTailDigest: metadataDigestJSON(diagnosticTail) };
    const validationToken = crypto.createHmac('sha256', this.secret).update(JSON.stringify(binding)).digest('hex');
    return { binding: { ...binding, validationToken }, diagnosticTail };
  }
  canonicalMetadataCapability(state) {
    const { binding } = this.canonicalMetadataBinding(state);
    return { profile: binding.profile, schema: binding.schema, sourceProof: binding.sourceProof,
      validationDigest: binding.validationDigest, diagnosticTailDigest: binding.diagnosticTailDigest,
      validationToken: binding.validationToken };
  }
  canonicalMetadataReceipt(binding) {
    // Unlike the header token, this receipt is issued only after an actual
    // cold validation demand, or a verified same-bundle view rebind. It is
    // bounded proof of that work, never a registry of rows or graph nodes.
    return crypto.createHmac('sha256', this.secret)
      .update('history-primary-canonical-metadata-checked-v1:').update(JSON.stringify(binding)).digest('hex');
  }
  checkedCanonicalMetadataReuse(state, binding, witness) {
    const keys = Object.keys(binding), stable = ['ownerKey', 'generation', 'metadataIdentity', 'metadataSchema',
      'semanticIdentity', 'semanticRevisionToken', 'canonicalEntryCount', 'sourceEntryCount',
      'sourceProof', 'validationDigest', 'diagnosticTailDigest', 'profile', 'schema'];
    if (state.primaryPresentation.primaryRequestClass !== 'view' || !witness || typeof witness !== 'object'
      || Array.isArray(witness) || Object.keys(witness).length !== keys.length + 1
      || !keys.every(key => Object.hasOwn(witness, key)) || !Object.hasOwn(witness, 'validationReceipt')
      || typeof witness.validationReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(witness.validationReceipt)
      || !/^[a-f0-9]{64}$/.test(binding.validationDigest) || wireBytes(witness) > MAX_CREDIT_BYTES
      || stable.some(key => witness[key] !== binding[key])) throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REUSE');
    // Copy the exact fixed key order used when issuing the prior receipt.
    // Metadata/semantic identities are private immutable-bundle identities;
    // they cannot be rebound by a caller-supplied revision or source header.
    const previous = Object.fromEntries(keys.map(key => [key, witness[key]]));
    if (this.canonicalMetadataReceipt(previous) !== witness.validationReceipt) {
      throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REUSE');
    }
  }
  async readCanonicalMetadataValidation(state, request, { consumerKey, control }) {
    const original = state, p = original.primaryPresentation;
    const assert = () => {
      control?.assertCurrent();
      if (this.state(request, consumerKey) !== original || original.primaryPresentation !== p) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    };
    assert();
    const expected = this.canonicalMetadataBinding(original);
    for (const [key, value] of Object.entries(expected.binding)) {
      if (request[key] !== value) throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_BINDING');
    }
    // Exact source is bound by the independently recomputed lossless proof
    // above. Duplicating the legal full header snapshot could exceed the
    // unchanged 64 KiB request bound. Do not silently accept an ignored copy.
    if (Object.hasOwn(request, 'sourceSnapshot')) {
      throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_SOURCE');
    }
    const credit = request.creditBytes ?? DEFAULT_CREDIT_BYTES;
    integer(credit, 'HISTORY_ROOT_CREDIT', MAX_CREDIT_BYTES);
    if (credit < 512) throw fail('HISTORY_ROOT_CREDIT');
    let validation;
    if (Object.hasOwn(request, 'reuseValidation')) {
      this.checkedCanonicalMetadataReuse(original, expected.binding, request.reuseValidation);
      // Preserve the existing passive same-data view path. A fresh owner or
      // a header without a prior completed-demand receipt must take the cold
      // path. Rebind has its own original-owner checkpoint before publication.
      if (control?.checkpoint) await control.checkpoint(); else await tick();
      assert(); validation = p.canonicalMetadataValidation;
    } else {
      // A header/old attestation is not a cold proof. Repeat exact supported
      // shape/scalar/leaf/page checks against the held immutable owner NOW.
      validation = await p.validateCanonicalMetadata({ control: {
        assertCurrent: assert,
        async checkpoint() { assert(); if (control?.checkpoint) await control.checkpoint(); else await tick(); assert(); },
      } });
    }
    assert();
    const checked = this.canonicalMetadataBinding(original, validation);
    for (const [key, value] of Object.entries(expected.binding)) if (checked.binding[key] !== value) {
      throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_CHANGED');
    }
    const packet = { success: true, kind: 'primary-canonical-metadata', ...checked.binding,
      validationReceipt: this.canonicalMetadataReceipt(checked.binding), diagnosticTail: checked.diagnosticTail, creditBytesUsed: 0 };
    packetBytes(packet);
    if (packet.creditBytesUsed > credit) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
    assert();
    this.metrics.pages++; this.metrics.maxPacketBytes = Math.max(this.metrics.maxPacketBytes, packet.creditBytesUsed);
    return packet;
  }
  state(request, consumerKey) {
    this.assertOpen(); shortString(consumerKey, 'HISTORY_ROOT_CONSUMER');
    const state = this.roots.get(request?.leaseId);
    if (!state || state.released) throw fail('HISTORY_ROOT_RELEASED');
    if (state.consumerKey !== consumerKey || request.ownerKey !== state.ownerKey
      || request.revision !== state.revision || request.generation !== this.generation) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    return state;
  }
  primaryViewParent(payload, consumerKey) {
    if (payload.primaryRequestClass !== 'view' || payload.readProfile !== 'history-primary-v1'
      || !payload.localRootLease) throw fail('HISTORY_PRIMARY_VIEW_PARENT_REQUIRED');
    if (['primaryPresentation','suppressions','localEntries','liveEntries','liveToolResults','rewindPreview','settingsPresentationKeys']
      .some(key => Object.hasOwn(payload, key))) throw fail('HISTORY_PRIMARY_VIEW_PAYLOAD');
    const parent = this.state(payload.localRootLease, consumerKey);
    const owner = sha(JSON.stringify(['codex',payload.sessionId,payload.cwd || '',payload.tabId || '',consumerKey]));
    if (!parent.primaryPresentation || parent.ownerKey !== owner) throw fail('HISTORY_ROOT_COMPOSITION_OWNER');
    if (payload.expectedSemanticIdentity !== parent.primaryPresentation.semanticIdentity) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    return parent;
  }
  timelineViewParent(payload,consumerKey){
    if(payload.readProfile!=='timeline-view-v1'||!payload.timelineParentLease)throw fail('TIMELINE_VIEW_PARENT_REQUIRED');
    const parent=this.state(payload.timelineParentLease,consumerKey);
    const ownerKey=sha(JSON.stringify(['codex',payload.sessionId,payload.cwd||'',payload.tabId||'',consumerKey]));
    if(parent.ownerKey!==ownerKey||!parent.timelinePresentation||!parent.canonicalSource
      ||parent.canonicalSource.representation!=='codex-timeline-root-v1')throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    return parent;
  }
  install(result, cursor, { consumerKey, ownerKey, revision, source, release, canonicalSource = null }) {
    const state = { leaseId: crypto.randomUUID(), consumerKey, ownerKey, revision,
      source, lease: result.root, indexes: result.semanticIndexes || result.timelineIndexes || null,
      primaryPresentation: result.primaryPresentation || null,
      timelinePresentation:result.timelinePresentation || null,
      searchPresentation:result.searchPresentation||null,
      // Private completed text-leaf pins, oldest first. Every newly installed
      // parent (including a pure-view fork) starts empty; never inherit by ID.
      groupDocuments: [],
      canonicalSource,
      release: release || (() => result.release()), released: false };
    this.roots.set(state.leaseId, state);
    this.metrics.opens++; this.metrics.maxRoots = Math.max(this.metrics.maxRoots, this.roots.size);
    try { return { state, descriptor: this.describe(state, cursor, { inline: false }) }; }
    catch (error) { this.drop(state); throw error; }
  }
  async verifyPhysicalScope(scope,source){
    if(!scope)return;
    if(scope.success!==true||scope.kind!=='physical'||typeof scope.verify!=='function')throw fail('HISTORY_ROOT_PHYSICAL_SCOPE_REQUIRED');
    await scope.verify();
    const authority=scope.sourceAuthority;
    for(const key of ['filePath','sessionId','fileIdentity','sourceGeneration'])
      if(authority?.[key]===undefined||authority[key]!==source?.[key])throw fail('HISTORY_ROOT_PHYSICAL_SOURCE_CHANGED');
    // Classify and fence the actual canonical cut before prompt/timing
    // preparation performs its own legitimate sidecar writes.
    scope.release();
  }
  async open(payload, { consumerKey, control, sourceOptions = {}, revision = null,physicalScope=null } = {}) {
    this.assertCapacity(); shortString(consumerKey, 'HISTORY_ROOT_CONSUMER');
    if (payload?.toolType !== 'codex') throw fail('HISTORY_ROOT_PROVIDER_UNSUPPORTED');
    shortString(payload.sessionId, 'HISTORY_ROOT_SESSION');
    if (payload.cwd != null && typeof payload.cwd !== 'string') throw fail('HISTORY_ROOT_CWD');
    if (payload.tabId != null && typeof payload.tabId !== 'string') throw fail('HISTORY_ROOT_TAB');
    control?.assertCurrent();
    const timeline=['timeline-primary-v1','timeline-view-v1'].includes(payload.readProfile);
    const timelineView=payload.readProfile==='timeline-view-v1';
    if(payload.timelineReadClass!==undefined&&(!timelineView||!['source','metadata','view'].includes(payload.timelineReadClass)))
      throw fail('TIMELINE_VIEW_READ_CLASS');
    const timelineParent=payload.timelineParentLease?this.timelineViewParent(payload,consumerKey):null;
    if(timelineView&&['view','metadata'].includes(payload.timelineReadClass)&&!timelineParent)throw fail('TIMELINE_VIEW_PARENT_REQUIRED');
    if(timeline && (typeof this.projectTimeline!=='function'||!this.timelineOwner))
      throw fail('TIMELINE_ROOT_PRODUCER_UNAVAILABLE');
    const requestClass=payload.primaryRequestClass;
    if(requestClass!==undefined&&(!['view','semantic','source'].includes(requestClass)||payload.readProfile!=='history-primary-v1'))
      throw fail('HISTORY_PRIMARY_REQUEST_CLASS');
    if(requestClass==='source'&&payload.localRootLease)throw fail('HISTORY_PRIMARY_SOURCE_MUST_NOT_BORROW');
    const admittedScope=primaryDependencyScope(payload), admittedGeneration=this.generation;
    this.opening++;
    let result, installed, canonicalSource, heldTimeline, transferred = false;
    const release = releaseOnce(() => result?.release?.());
    try {
      const {_timelinePreferencesRoot:_untrustedPreferences,_timelinePresentationRoot:_untrustedProjection,...publicPayload}=payload;
      let preparedPayload=publicPayload;
      if(timelineParent){heldTimeline=timelineParent.timelinePresentation.view.fork();
        preparedPayload={...publicPayload,_timelinePreferencesRoot:heldTimeline.root.field('preferences')};}
      if(timelineView&&payload.timelineReadClass==='view'){
        result=forkFrozenCanonical(this.store,timelineParent.canonicalSource);canonicalSource=result;
        if(typeof this.forkTimelineResult!=='function')throw fail('TIMELINE_VIEW_FORK_UNAVAILABLE');
        const forked=await this.forkTimelineResult(timelineParent.timelinePresentation,preparedPayload,control,result);
        if(forked?.kind==='miss')return{success:false,error:'TIMELINE_VIEW_RECOMPOSE_REQUIRED',requiredClass:forked.requiredClass,reason:forked.reason};
        if(forked?.kind!=='hit'||!forked.result)throw fail('TIMELINE_VIEW_FORK_CONTRACT');result=forked.result;
      }else if(timelineView&&payload.timelineReadClass==='metadata'){
        result=forkFrozenCanonical(this.store,timelineParent.canonicalSource);
      }else if(requestClass==='view'){
        const parent=this.primaryViewParent(payload,consumerKey);
        if(typeof this.forkPrimaryResult!=='function')return {success:false,error:'HISTORY_PRIMARY_VIEW_RECOMPOSE_REQUIRED',reason:'view-fork-unavailable',requiredClass:'semantic'};
        const forked=await this.forkPrimaryResult(parent.primaryPresentation,payload,control);
        if(forked?.kind==='miss')return {success:false,error:'HISTORY_PRIMARY_VIEW_RECOMPOSE_REQUIRED',reason:forked.reason,requiredClass:forked.requiredClass};
        if(forked?.kind!=='hit'||!forked.primary||!forked.canonical)throw fail('HISTORY_PRIMARY_VIEW_CONTRACT');
        const primary=forked.primary;let raw;
        try{
          raw=forkFrozenCanonical(this.store,forked.canonical);canonicalSource=raw;
          result={...raw,root:primary.root,entries:primary.headerCursor,primaryPresentation:primary,
            readProfile:'history-primary-v1',canonicalEntryCount:primary.canonicalEntryCount,semanticSnapshotComplete:true,
            semanticRevisionToken:primary.semanticRevisionToken,viewRevisionToken:primary.viewRevisionToken,
            release:releaseOnce(()=>{let error;try{primary.close();}catch(e){error=e;}try{raw.release();}catch(e){error||=e;}if(error)throw error;})};
        }catch(error){try{primary.close();}finally{raw?.release();}throw error;}
      } else if (payload.localRootLease) {
        const parent = this.state(payload.localRootLease, consumerKey);
        const ownerKey = sha(JSON.stringify(['codex', payload.sessionId, payload.cwd || '', payload.tabId || '', consumerKey]));
        if (payload.readProfile !== 'history-primary-v1' || !parent.primaryPresentation
          || !parent.canonicalSource || parent.ownerKey !== ownerKey) throw fail('HISTORY_ROOT_COMPOSITION_OWNER');
        result = forkFrozenCanonical(this.store, parent.canonicalSource);
      } else {
        result = await (timeline?this.projectTimeline:this.projectHistory)(payload.sessionId, payload.cwd, {
          ...sourceOptions, rootedOwner: timeline?this.timelineOwner:this.owner, _readControl: control,
          includeTurnCoordinates: payload.includeTurnCoordinates === true, tabId: payload.tabId,
        });
      }
      control?.assertCurrent(); this.assertOpen();
      if (!result?.success) return result;
      if (result.representation !== (timeline?'codex-timeline-root-v1':'codex-canonical-root-v1') || !isHistoryPagedCursor(result.entries)
        || !result.root?.cursor || typeof result.release !== 'function') throw fail('HISTORY_ROOT_PRODUCER_CONTRACT');
      canonicalSource ||= result;
      await this.verifyPhysicalScope(physicalScope,canonicalSource.sourceSnapshot);
      const searching=payload.readProfile==='history-search-v1';
      if(searching){
        if(payload.localRootLease||payload.timelineParentLease||requestClass)throw fail('HISTORY_SEARCH_SOURCE_OPEN_REQUIRED');
        const raw=result;
        result=await require('./history-root-search-paged').preparePagedHistorySearchRoot(this.store,raw,{options:payload,control});
        canonicalSource=result.searchPresentation.frozen;raw.release();
      }
      // Existing sidecar/revision owners may install paged postprocessors here.
      // A preparation failure publishes no capability and preserves old roots.
      if (this.prepareResult&&!searching&&requestClass!=='view'&&!(timelineView&&payload.timelineReadClass==='view')) {
        const prepared = await this.prepareResult(result, preparedPayload, control);
        if (prepared !== undefined) result = prepared;
      }
      control?.assertCurrent(); this.assertOpen();
      const source = Object.freeze({ ...result.sourceSnapshot });
      const selectedRevision = result.viewRevisionToken || result.semanticRevisionToken || (revision == null ? sha(JSON.stringify(['history-root-v1', source]))
        : typeof revision === 'string' ? revision : revision.token);
      shortString(selectedRevision, 'HISTORY_ROOT_REVISION');
      const ownerKey = sha(JSON.stringify(['codex', payload.sessionId, payload.cwd || '', payload.tabId || '', consumerKey]));
      installed = this.install(result, result.entries, { consumerKey, ownerKey,
        revision: selectedRevision, source, release, canonicalSource });
      const { state, descriptor } = installed;
      let readMetrics = result.readMetrics;
      if (result.primaryPresentation) {
        // Metrics describe THIS request, not the canonical work inherited by
        // a borrowed snapshot. Logical totals are carried separately above.
        readMetrics = Object.fromEntries(Object.entries(result.readMetrics || {}).map(([key,value]) =>
          [key,payload.localRootLease ? typeof value === 'boolean' ? false : 0 : value]));
        const work = result.primaryPresentation.stats().work;
        for (const key of ['semanticPreparations','promptPasses','timingPasses','indexBuilds','metadataRows','semanticOverlayHashes']) {
          readMetrics['primary' + key[0].toUpperCase() + key.slice(1)] = work[key];
        }
      }
      const response = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(state),
        root: descriptor, totalEntries: result.entries.length,
        sessionMeta: this.describe(state, result.sessionMeta, { inline: false }),
        sourceSnapshot: source, mode: result.mode, readMetrics,
        ...(timeline ? {readProfile:result.readProfile||'timeline-primary-v1',semanticSnapshotComplete:result.semanticSnapshotComplete===true,
          semanticRevisionToken:result.semanticRevisionToken} : {}),
        ...(result.timelineViewHeader||{}),
        ...(result.searchHeader||{}),
        ...(result.primaryPresentation ? {readProfile:'history-primary-v1',
          semanticSnapshotComplete:result.semanticSnapshotComplete===true,canonicalEntryCount:result.canonicalEntryCount,
          semanticIdentity:result.primaryPresentation.semanticIdentity,metadataIdentity:result.primaryPresentation.metadataIdentity,
          metadataSchema:result.primaryPresentation.metadataSchema,semanticRevisionToken:result.primaryPresentation.semanticRevisionToken,
          viewRevisionToken:result.primaryPresentation.viewRevisionToken,primaryRequestClass:result.primaryPresentation.primaryRequestClass,
          // Only this optional profile authorizes descriptor-only row fields.
          ...(result.primaryPresentation.metadataSchema === 1 ? { metadataRowWindow: { profile: PRIMARY_METADATA_WINDOW,
            minimumCreditBytes: this.metadataWindowBounds(state).overhead } } : {}),
          ...(result.primaryPresentation.presentationSource ? { presentationAddresses: { profile: HISTORY_PRIMARY_ADDRESS_PROFILE, maxItems: 3 } } : {}),
          ...(result.primaryPresentation.presentationSource && result.primaryPresentation.toolCoverageInputs
            ? { canonicalConsumers: { profile: HISTORY_PRIMARY_CANONICAL_CONSUMERS_PROFILE, maxItems: 3,
              valueEncoding: 'history-canonical-consumer-text-v1' } } : {}),
          ...(result.primaryPresentation.canonicalMetadataValidation
            ? { canonicalMetadataValidation: this.canonicalMetadataCapability(state) } : {}),
          ...(result.primaryPresentation.preparedMetadataValidation
            ? { preparedPresentation: preparedPresentationCapability(this, state) } : {}),
          displayUnitCount:result.entries.length,
          sourceEntryCount:result.primaryPresentation.sourceMetadataCursor?.length ?? result.canonicalEntryCount,
          ...(result.primaryPresentation.sourceMetadataCursor ? {sourceMetadata:this.describe(state,result.primaryPresentation.sourceMetadataCursor,{inline:false})}:{}),
          ...(result.primaryPresentation.durableMetadataCursor ? {durableMetadata:this.describe(state,result.primaryPresentation.durableMetadataCursor,{inline:false})}:{}),
        } : {}),
        ...(result.semanticIndexes ? { readProfile: result.readProfile,
          semanticSnapshotComplete: result.semanticSnapshotComplete === true,
          settingsBefore: this.describe(state, result.semanticIndexes.root.field('settingsBefore'), { inline: false }) } : {}),
        producerBounded: false, nativeMemoryMeasured: false };
      control?.assertCurrent(); this.state(response, consumerKey);
      transferred = true;
      return response;
    } catch (error) {
      const ownerKey=admittedScope && sha(JSON.stringify(['codex',admittedScope.sessionId,admittedScope.cwd,admittedScope.tabId,consumerKey]));
      const outcome=primaryDependencyOutcome(error,payload,admittedScope,admittedGeneration,ownerKey);
      if (!outcome || installed || this.generation!==admittedGeneration) throw error;
      // The producer has disposed its candidate. Release the provisional
      // canonical result too BEFORE returning any supersession to the caller.
      // Cleanup/quota/cancel/closed-plane failures retain their original errors.
      release();
      control?.assertCurrent(); this.assertOpen();
      return outcome;
    } finally {
      this.opening--;
      try{if (!transferred) { if (installed) this.drop(installed.state); else release(); }}finally{heldTimeline?.release();}
    }
  }
  drop(state) {
    if (state.released) return;
    state.released = true; this.roots.delete(state.leaseId);
    try { this.releaseGroupDocuments(state); state.release(); } finally { this.metrics.closes++; }
  }
  releaseGroupDocuments(state) {
    const slots = state.groupDocuments.splice(0);
    for (const slot of slots) {
      try { slot.lease.release(); }
      catch { this.metrics.cleanupErrors = (this.metrics.cleanupErrors || 0) + 1; }
    }
  }
  releaseGroupDocumentMemos() {
    for (const state of this.roots.values()) this.releaseGroupDocuments(state);
  }
  retainGroupDocument(parent, document, { rank, headerIdentity, encoding, bytes }, diagnostic) {
    if (bytes > GROUP_DOCUMENT_BYTES) { diagnostic?.memo('skip-budget'); return; }
    let pin;
    try {
      // A failed optional pin must not turn an already completed public
      // document into a failed read. Preserve a handle even on commit failure.
      this.store.transaction(() => { pin = document.fork(); });
    } catch (error) {
      try { pin?.release(); } catch { this.metrics.cleanupErrors = (this.metrics.cleanupErrors || 0) + 1; }
      diagnostic?.memo(error.code === 'HISTORY_BACKING_FULL' || error.code === 'SQLITE_FULL' || error.errcode === 13
        ? 'skip-quota' : 'skip-retention');
      return;
    }
    const slots = parent.groupDocuments;
    // No await between admission and replacement. Deterministic LRU2, with
    // the original V8 bytes (not base64 length) as the retention budget.
    while (slots.length && (slots.length >= GROUP_DOCUMENT_SLOTS
      || slots.reduce((sum, slot) => sum + slot.bytes, 0) + bytes > GROUP_DOCUMENT_BYTES)) {
      const oldest = slots.shift();
      try { oldest.lease.release(); }
      catch { this.metrics.cleanupErrors = (this.metrics.cleanupErrors || 0) + 1; }
    }
    slots.push({ rank, headerIdentity, encoding, bytes, lease: pin });
  }
  release(request, { consumerKey } = {}) {
    const state = this.state(request, consumerKey);
    bodyBorrow.assertBodyChild(state, request);
    // Per-request child provenance is release authority, not header discovery.
    // A late/malformed fork reply cannot substitute a shared parent or sibling.
    if (state.preparedPresentationRequestId !== undefined || Object.hasOwn(request, 'preparedRequestId')) {
      if (state.preparedPresentationRequestId === undefined
        || request.preparedRequestId !== state.preparedPresentationRequestId) throw fail('HISTORY_PRIMARY_PREPARED_RELEASE_BINDING');
    }
    if (state.agentCatalogRequestId !== undefined || Object.hasOwn(request, 'catalogRequestId')) {
      if (state.agentCatalogRequestId === undefined || request.catalogRequestId !== state.agentCatalogRequestId)
        throw fail('HISTORY_AGENT_CATALOG_RELEASE_BINDING');
    }
    this.drop(state);
    return { success: true, ...this.identity(state), released: true,
      ...(state.agentCatalogRequestId ? { catalogRequestId: state.agentCatalogRequestId } : {}),
      ...(state.preparedPresentationRequestId ? { preparedRequestId: state.preparedPresentationRequestId } : {}) };
  }
  releaseConsumer(consumerKey) {
    for (const state of this.roots.values()) if (state.consumerKey === consumerKey) this.drop(state);
  }
  // Early primary UI uses an explicitly selected UNIT compatibility sink.
  // It is not a whole-history DTO, and its native row/metadata memory is not
  // claimed bounded. The independent document keeps V8 value semantics.
  async forkViewUnit(request, { consumerKey, control, onUnitDiagnostic } = {}) {
    const diagnostic = beginUnitReadDiagnostic(onUnitDiagnostic);
    let terminalError, completed = false;
    diagnostic?.begin('validation');
    try {
      this.assertCapacity(); control?.assertCurrent();
      if (request.encoding !== 'history-display-unit-v8-v1') throw fail('HISTORY_ROOT_UNIT_ENCODING');
      const parent = this.state(request, consumerKey), primary = parent.primaryPresentation;
      if (!primary?.unitForRenderer || !primary?.headerAt) throw fail('HISTORY_ROOT_PRIMARY_VIEW_REQUIRED');
      const header = this.cursor(parent, request.nodeToken), rank = header.field('rank').scalar();
      integer(rank, 'HISTORY_ROOT_UNIT_RANK');
      const expected = primary.headerAt(rank);
      if (!expected || expected.identity() !== header.identity()) throw fail('HISTORY_ROOT_UNIT_HEADER');
      diagnostic?.parent(parent, this.generation, rank);
      diagnostic?.end('validation');
      const headerIdentity = header.identity();
      const memoIndex = parent.groupDocuments.findIndex(slot => slot.rank === rank
        && slot.headerIdentity === headerIdentity && slot.encoding === request.encoding);
      const memo = memoIndex < 0 ? null : parent.groupDocuments[memoIndex];
      diagnostic?.memo(memo ? 'hit' : 'miss');
      this.opening++;
      let unit, document, installed, transferred = false, endBuild, primaryError, unitReleased = false, chunks = 0;
      const releaseUnit = () => { if(unitReleased)return;unitReleased=true;unit?.release?.(); };
      const release = releaseOnce(() => document?.release());
      const current = () => { control?.assertCurrent(); this.state(request, consumerKey); };
      try {
        let kind, serializedBytes;
        if (memo) {
          diagnostic?.begin('install');
          current();
          // Only immutable pages are shared. install below creates a fresh
          // descriptor/token/lease; no old response or decoded value survives.
          this.store.transaction(() => { document = memo.lease.fork(); });
          current();
          parent.groupDocuments.splice(memoIndex, 1); parent.groupDocuments.push(memo);
          kind = 'group'; serializedBytes = memo.bytes;
          diagnostic?.kind(kind); diagnostic?.bytes(serializedBytes);
        } else {
          diagnostic?.begin('projection');
          unit = await primary.unitForRenderer(rank, { control }); current();
          if (!unit?.cursor || typeof unit.release !== 'function') throw fail('HISTORY_ROOT_UNIT_CONTRACT');
          const projected = unit.cursor();
          kind = projected.kind !== 'object' ? null : equalsText(projected.field('kind'),'entry') ? 'entry'
            : equalsText(projected.field('kind'),'group') ? 'group' : null;
          if (!kind) throw fail('HISTORY_ROOT_UNIT_CONTRACT');
          diagnostic?.kind(kind); diagnostic?.end('projection');
          diagnostic?.begin('materialize');
          let dto = await materializeHistoryCursor(projected, { control }); current();
          diagnostic?.end('materialize'); diagnostic?.begin('serialize');
          const bytes = v8.serialize(dto); dto = null; current();
          diagnostic?.bytes(bytes.length); diagnostic?.end('serialize');
          diagnostic?.begin('release');
          releaseUnit(); current();
          diagnostic?.end('release');
          diagnostic?.begin('write');
          endBuild = this.store.beginBuild(); const writer = this.store.leafWriter();
          const width = Math.max(3, Math.floor(this.store.pageBytes / 8) * 3);
          for (let offset = 0; offset < bytes.length; offset += width) {
            current(); this.store.transaction(() => writer.write(bytes.subarray(offset,offset+width).toString('base64')));
            if (++chunks % 32 === 0) { if(control?.checkpoint)await control.checkpoint();else await tick();current(); }
          }
          this.store.transaction(() => { document = this.store.lease(writer.finish()); });
          current();
          diagnostic?.end('write');
          serializedBytes = bytes.length;
        }
        if (!memo) diagnostic?.begin('install');
        installed = this.install({ root: document }, document.cursor(), { consumerKey,
          ownerKey: parent.ownerKey, revision: parent.revision, source: parent.source, release });
        const response = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(installed.state),
          payloadDocument: installed.descriptor, totalChars: installed.descriptor.length,
          encoding: request.encoding, compatibilityNativeUnitSink: true, nativeMemoryMeasured: false };
        const finishBuild=endBuild;endBuild=null;finishBuild?.();
        current(); this.state(response,consumerKey);
        if (!memo && kind === 'group') this.retainGroupDocument(parent, document,
          { rank, headerIdentity, encoding: request.encoding, bytes: serializedBytes }, diagnostic);
        transferred = true;
        diagnostic?.end('install'); completed = true; return response;
      } catch(error) { primaryError=error;throw error;
      } finally {
        diagnostic?.chunks(chunks);
        diagnostic?.begin('cleanup');
        let secondary;
        try { if(!transferred){if(installed)this.drop(installed.state);else release();} }catch(error){secondary=error;}
        try { releaseUnit(); }catch(error){secondary ||= error;}
        try { endBuild?.(); }catch(error){secondary ||= error;}finally{this.opening--;}
        diagnostic?.end('cleanup');
        if(secondary){if(!primaryError)throw secondary;this.metrics.cleanupErrors=(this.metrics.cleanupErrors||0)+1;}
      }
    } catch (error) { terminalError = error; throw error; }
    finally { diagnostic?.finish(terminalError, completed); }
  }
  // A selected text document has its own lease. Closing Full/Copy/Input cannot
  // release the panel root, and releasing the panel cannot invalidate Full.
  inspectBodyBorrow(request, consumerKey) { return bodyBorrow.inspectBodyBorrow(this, request, consumerKey); }
  forkBodyBorrow(request, options = {}) { return bodyBorrow.forkBodyBorrow(this, request, options); }
  forkPreparedPresentation(request, options = {}) {
    return forkPreparedPresentation(this, request, options);
  }
  forkAgentCatalog(request, options = {}) { return forkAgentCatalog(this, request, options); }
  assertAgentCatalogRead(request, consumerKey) { return assertAgentCatalogRead(this, request, consumerKey); }
  forkCanonicalConsumerValue(request, options = {}) {
    return forkPrimaryCanonicalConsumerValue(this, request, options);
  }
  assertTextPinFork(request, consumerKey) {
    this.assertCapacity();
    const parent = this.state(request, consumerKey), cursor = this.cursor(parent, request.nodeToken);
    if (cursor.kind !== 'text') throw fail('HISTORY_ROOT_NOT_TEXT');
    return { parent, cursor };
  }
  forkLeaf(request, { consumerKey, control } = {}) {
    this.assertCapacity(); control?.assertCurrent();
    const { parent, cursor } = this.assertTextPinFork(request, consumerKey);
    // A text leaf contains no logical child owners. Pin its immutable page
    // directly so Full does not retain the complete old owner index after the
    // panel/cache releases that revision. Container forks still need owners.
    let lease, installed, transferred = false, primary;
    const release = releaseOnce(() => lease?.release());
    try {
      // Keep a handle even if the transaction's final disk/journal check rolls
      // back the pin. Its local lease accounting still needs exactly one drop.
      this.store.transaction(() => { lease = this.store.lease(historyPagedCursorAddress(cursor).ref); });
      control?.assertCurrent();
      installed = this.install({ root: lease }, lease.cursor(), {
        consumerKey, ownerKey: parent.ownerKey, revision: parent.revision,
        source: parent.source, release });
      const { state, descriptor } = installed;
      const response = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(state),
        payloadDocument: descriptor, totalChars: descriptor.length };
      control?.assertCurrent(); this.state(request, consumerKey); this.state(response, consumerKey);
      transferred = true;
      return response;
    } catch (error) { primary = error; throw error; }
    finally {
      if (!transferred) {
        try { if (installed) this.drop(installed.state); else release(); }
        catch (error) {
          if (!primary) throw error;
          this.metrics.cleanupErrors = (this.metrics.cleanupErrors || 0) + 1;
        }
      }
    }
  }
  async openPayload(payload, { consumerKey, control, sourceOptions = {},physicalScope=null } = {}) {
    this.assertCapacity(); shortString(consumerKey, 'HISTORY_ROOT_CONSUMER');
    if (payload?.toolType !== 'codex') throw fail('HISTORY_ROOT_PROVIDER_UNSUPPORTED');
    shortString(payload.sessionId, 'HISTORY_ROOT_SESSION');
    const payloadId = shortString(payload.payloadId, 'HISTORY_ROOT_PAYLOAD_ID', 8192);
    const expectedHash = payload.contentHash || payload.expectedContentHash;
    if (expectedHash != null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw fail('HISTORY_ROOT_PAYLOAD_HASH');
    const expectedLength = payload.expectedTotalChars ?? payload.totalChars;
    if (expectedLength != null) integer(expectedLength, 'HISTORY_ROOT_PAYLOAD_LENGTH');
    const rowUuid = payload.entryUuid || payload.rowUuid || null;
    if (rowUuid != null) shortString(rowUuid, 'HISTORY_ROOT_ROW_UUID', 8192);
    const prefix = payloadId.slice(0, payloadId.indexOf(':'));
    if (!['result', 'thinking', 'compact', 'action'].includes(prefix)) return { success: false, error: 'payload not found', payloadId };
    this.opening++; let result, installed, releaseSelected, transferred = false;
    let selected = null, selectedHash = null, ownedText = null;
    const releaseResult = releaseOnce(() => result?.release?.());
    try {
      control?.assertCurrent();
      result = await this.projectHistory(payload.sessionId, payload.cwd, { ...sourceOptions,
        rootedOwner: this.owner, _readControl: control, tabId: payload.tabId });
      control?.assertCurrent(); this.assertOpen();
      if (!result?.success) return result;
      if (result.representation !== 'codex-canonical-root-v1' || !isHistoryPagedCursor(result.entries)) throw fail('HISTORY_ROOT_PRODUCER_CONTRACT');
      await this.verifyPhysicalScope(physicalScope,result.sourceSnapshot);
      const source = result.sourceSnapshot;
      if (payload.payloadGeneration && payload.payloadGeneration !== source.sourceGeneration
        && payload.payloadGeneration !== source.fileIdentity) return { success: false, error: 'history_payload_generation_changed', payloadId };
      let idMatches = 0, candidates = 0, steps = 0;
      const accept = async (cursor, temporary = null) => {
        if (cursor.kind !== 'text') { temporary?.release(); return; }
        idMatches++;
        if (expectedLength != null && cursor.length !== expectedLength) { temporary?.release(); return; }
        const hash = await payloadDigest(cursor, control);
        if (expectedHash && hash !== expectedHash) { temporary?.release(); return; }
        // Old payload IDs name the final matching write in projection order.
        // A supplied row UUID/hash constrains that old rule; no raw record is
        // substituted for a transformed canonical result.
        ownedText?.release(); ownedText = temporary; selected = cursor; selectedHash = hash; candidates++;
      };
      for (const row of result.entries.rows()) {
        control?.assertCurrent();
        const uuid = row.field('uuid');
        if (rowUuid && !equalsText(uuid, rowUuid)) continue;
        if (prefix === 'thinking' || prefix === 'compact') {
          if (equalsText(uuid, payloadId.slice(prefix.length + 1))) await accept(row.field(prefix === 'thinking' ? 'thinking' : 'compactSummary'));
        } else {
          const actions = row.field('actions');
          if (actions.kind === 'array') for (let index = 0; index < actions.length; index++) {
            control?.assertCurrent();
            const action = actions.at(index);
            if (prefix === 'action') {
              const suffix = ':' + index;
              if (!payloadId.endsWith(suffix) || !equalsText(uuid, payloadId.slice(7, -suffix.length))) continue;
              // action: is the on-demand action JSON contract. Apply exactly
              // its prior result dehydration on a private CoW action first;
              // the original canonical result and held roots stay immutable.
              if (!expectedHash) return { success: false, error: 'history_payload_hash_required', payloadId };
              let actionLease = null, actionCursor = action;
              const raw = action.field('rawTool');
              if (equalsText(action.field('tool'), '__raw__') && raw.kind === 'object') {
                const value = raw.field('result');
                if (value.kind === 'text' && value.length > 16 * 1024 && raw.field('resultRef').kind === 'undefined') {
                  const hash = await payloadDigest(value, control);
                  let preview = ''; for (const part of value.textRange(0, 2049)) preview += part;
                  let end = Math.min(2048, preview.length);
                  if (/[\uD800-\uDBFF]/.test(preview[end - 1] || '') && /[\uDC00-\uDFFF]/.test(preview[end] || '')) end--;
                  preview = preview.slice(0, end) + '\n… (+' + Math.max(1, Math.round((value.length - end) / 1024))
                    + ' KB — полный вывод загрузится при раскрытии)';
                  // Fork the published owner index. A cursor's raw node page
                  // still contains logical child references from that index;
                  // importing it into a fresh arena would orphan those refs.
                  const arena = new HistoryProjectionArena(this.store, result.root);
                  try {
                    actionLease = arena.step(() => {
                      const copy = arena.decode(historyPagedCursorAddress(action).ref), projectedRaw = copy.rawTool;
                      const id = projectedRaw.toolUseId || rootText.concat([
                        arena.decode(historyPagedCursorAddress(uuid).ref), ':', String(index)], '', arena);
                      projectedRaw.resultRef = { payloadId: rootText.concat(['result:', rootText.coerce(id)], '', arena),
                        totalChars: value.length, contentHash: hash,
                        ...(Number.isInteger(projectedRaw.resultSourceLine) ? { recordLine: projectedRaw.resultSourceLine } : {}) };
                      projectedRaw.result = preview;
                      return arena.publish(copy);
                    });
                  } finally { arena.close(); }
                  actionCursor = actionLease.cursor();
                }
              }
              const end = this.store.beginBuild(), writer = this.store.leafWriter(); let lease;
              try {
                const decoder = new StringDecoder('utf8');
                for await (const chunk of encodeHistoryStream(actionCursor, { frameBytes: 1024, control })) {
                  control?.assertCurrent(); this.store.transaction(() => writer.write(decoder.write(chunk)));
                }
                this.store.transaction(() => { writer.write(decoder.end()); lease = this.store.lease(writer.finish()); });
                await accept(lease.cursor(), lease); lease = null;
              } finally { lease?.release(); actionLease?.release(); end(); }
              continue;
            }
            if (!equalsText(action.field('tool'), '__raw__')) continue;
            const raw = action.field('rawTool');
            if (raw.kind !== 'object') continue;
            const id = raw.field('toolUseId'); let matches = false;
            if (id.kind === 'text' && id.length) matches = equalsText(id, payloadId.slice(7));
            else if (['number', 'scalar'].includes(id.kind) && id.scalar()) matches = String(id.scalar()) === payloadId.slice(7);
            else {
              const suffix = ':' + index;
              matches = payloadId.endsWith(suffix) && equalsText(uuid, payloadId.slice(7, -suffix.length));
            }
            if (matches) await accept(raw.field('result'));
          }
        }
        if (++steps % 32 === 0) { if (control?.checkpoint) await control.checkpoint(); else await tick(); }
      }
      if (!selected) return { success: false, error: idMatches ? 'history_payload_changed' : 'payload not found', payloadId };
      control?.assertCurrent(); this.assertOpen();
      const lease = ownedText || this.store.transaction(() => this.store.lease(historyPagedCursorAddress(selected).ref));
      releaseSelected = releaseOnce(() => lease.release());
      ownedText = null;
      const revision = sha(JSON.stringify(['history-root-v1', source]));
      const ownerKey = sha(JSON.stringify(['codex', payload.sessionId, payload.cwd || '', payload.tabId || '', consumerKey]));
      installed = this.install({ root: lease }, lease.cursor(), { consumerKey, ownerKey, revision,
        source: Object.freeze({ ...source }), release: releaseSelected });
      const response = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(installed.state),
        payloadDocument: installed.descriptor, payloadId, contentHash: selectedHash,
        totalChars: installed.descriptor.length, payloadGeneration: source.sourceGeneration || source.fileIdentity,
        ...(rowUuid ? { entryUuid: rowUuid } : {}), matchedCandidates: candidates, encoding: prefix === 'action' ? 'json' : 'text' };
      // Releasing the producer can fail too: do it before publishing the leaf.
      releaseResult();
      control?.assertCurrent(); this.state(response, consumerKey);
      transferred = true;
      return response;
    } finally {
      this.opening--;
      try {
        if (!transferred) { if (installed) this.drop(installed.state); else releaseSelected?.(); }
      } finally { try { ownedText?.release(); } finally { releaseResult(); } }
    }
  }
  // Independent coordinates of a renderer-captured current projection. This
  // capability has no canonical sourceSnapshot and cannot authorize Full/Input,
  // a source read, layout, paint, or a writer. Existing store/capacity owns it.
  openPosition(payload, { consumerKey, control } = {}) {
    this.assertCapacity(); shortString(consumerKey, 'HISTORY_ROOT_CONSUMER'); control?.assertCurrent();
    if (payload.readProfile !== POSITION_PROFILE || wireBytes(payload) > MAX_CREDIT_BYTES) throw fail('HISTORY_POSITION_PROFILE');
    let position, installed, transferred = false;
    try {
      position = new HistoryPresentationPosition(this.store, payload);
      const ownerKey = sha(JSON.stringify([POSITION_PROFILE, consumerKey, payload.projectionId]));
      installed = this.install({ root: position.pin }, position.cursor(), { consumerKey, ownerKey,
        revision: sha(JSON.stringify([POSITION_PROFILE, payload.projectionId, payload.unitCount])),
        source: null, release: () => position.close() });
      installed.state.positionProjection = position;
      const response = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(installed.state),
        readProfile: POSITION_PROFILE, projectionId: position.projectionId, unitCount: position.unitCount,
        ...position.status() };
      control?.assertCurrent(); this.state(response, consumerKey); transferred = true; return response;
    } finally { if (!transferred) { if (installed) this.drop(installed.state); else position?.close(); } }
  }
  forkPositionQuery(request, { consumerKey, control } = {}) {
    this.assertCapacity(); control?.assertCurrent();
    const parent = this.state(request, consumerKey), position = parent.positionProjection;
    if (request.encoding !== POSITION_QUERY_ENCODING || !position || request.projectionId !== position.projectionId) {
      throw fail('HISTORY_POSITION_PROFILE');
    }
    let query, installed, transferred = false;
    try {
      query = position.forkQuery();
      installed = this.install({ root: query.pin }, query.cursor(), { consumerKey,
        ownerKey: parent.ownerKey, revision: parent.revision, source: null, release: () => query.close() });
      installed.state.positionQuery = query;
      const result = { success: true, __notedHistoryTransport: PROTOCOL, ...this.identity(installed.state),
        readProfile: POSITION_PROFILE, projectionId: position.projectionId, unitCount: position.unitCount,
        phase: 'querying', sequence: 0, pass: 0 };
      control?.assertCurrent(); this.state(request, consumerKey); this.state(result, consumerKey);
      transferred = true; return result;
    } finally { if (!transferred) { if (installed) this.drop(installed.state); else query?.close(); } }
  }
  assertPositionRead(method, request, consumerKey) {
    // Routing/admission proof uses installed native capabilities only. No new
    // plane, token decoding, source read, SQL mutation or GC state is needed.
    const state = this.state(request, consumerKey);
    if (method === 'forkHistoryRootLeaf' && request.encoding === POSITION_QUERY_ENCODING
      && state.positionProjection instanceof HistoryPresentationPosition
      && request.projectionId === state.positionProjection.projectionId) {
      state.positionProjection.assertReadOnlyFork(); return state;
    }
    if (method === 'readHistoryRootPage' && request.kind === POSITION_PROFILE && ['target', 'selection'].includes(request.operation)
      && state.positionQuery instanceof HistoryPresentationPositionQuery
      && request.projectionId === state.positionQuery.projectionId) {
      state.positionQuery.assertOpen(); return state;
    }
    throw fail('HISTORY_POSITION_READ_ONLY_REQUIRED');
  }
  async readPosition(state, request, { consumerKey, control }) {
    const original = state, position = state.positionProjection || state.positionQuery;
    const assert = () => { control?.assertCurrent();
      if (this.state(request, consumerKey) !== original || position !== (original.positionProjection || original.positionQuery)) {
        throw fail('HISTORY_ROOT_OWNER_MISMATCH');
      }
    };
    assert();
    if (!position || request.kind !== POSITION_PROFILE || request.projectionId !== position.projectionId
      || wireBytes(request) > MAX_CREDIT_BYTES) throw fail('HISTORY_POSITION_PROFILE');
    const credit = request.creditBytes ?? DEFAULT_CREDIT_BYTES;
    integer(credit, 'HISTORY_ROOT_CREDIT', MAX_CREDIT_BYTES);
    if (credit < 512) throw fail('HISTORY_ROOT_CREDIT');
    let status;
    try {
      if (state.positionProjection && request.operation === 'append') status = await position.append(request.sequence, request.events, { control, assert });
      else if (state.positionProjection && request.operation === 'seal') { assert(); status = position.seal(request.sequence); }
      else if (state.positionQuery && request.operation === 'target') {
        integer(request.pass, 'HISTORY_POSITION_QUERY_PASS');
        status = await position.append(request.sequence, request.events, { control, assert, pass: request.pass });
      } else if (state.positionQuery && request.operation === 'selection') {
        status = await position.readSelection(request.sequence, request.offset, { control, assert });
      }
      else throw fail('HISTORY_POSITION_OPERATION');
      assert(); state.lease = position.pin;
      const packet = { success: true, ...this.identity(state), kind: POSITION_PROFILE,
        projectionId: position.projectionId, unitCount: position.unitCount, ...status, creditBytesUsed: 0 };
      packetBytes(packet);
      if (packet.creditBytesUsed > credit) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
      assert(); this.metrics.pages++; this.metrics.maxPacketBytes = Math.max(this.metrics.maxPacketBytes, packet.creditBytesUsed);
      return packet;
    } catch (error) {
      // A failed partial import/target is never a complete missing inventory.
      // Retire only that independently owned candidate, never its parent.
      this.drop(state); throw error;
    }
  }
  async readPage(request, { consumerKey, control } = {}) {
    const state = this.state(request, consumerKey); control?.assertCurrent();
    bodyBorrow.assertBodyChild(state, request);
    if (request.kind === 'primary-agent-catalog-step') return advanceAgentCatalog(this, state, request, { consumerKey, control });
    if (request.kind === 'primary-agent-catalog-membership') return readAgentCatalogMembership(this, state, request, { consumerKey, control });
    if (state.agentCatalog || Object.hasOwn(request, 'catalogRequestId')) assertAgentCatalogRead(this, request, consumerKey, false);
    if (state.positionProjection || state.positionQuery || request.kind === POSITION_PROFILE) {
      return this.readPosition(state, request, { consumerKey, control });
    }
    if(request.kind==='primary-canonical-metadata')return this.readCanonicalMetadataValidation(state,request,{consumerKey,control});
    if(request.kind==='primary-tool-coverage')return readPrimaryToolCoverage(this,state,request,{consumerKey,control});
    if(request.kind==='primary-effective-settings')return readPrimaryEffectiveSettings(this,state,request,{consumerKey,control});
    if(request.kind==='primary-prompt-identity')return readPrimaryPromptIdentity(this,state,request,{consumerKey,control});
    if(request.kind==='primary-presentation-address')return readPrimaryPresentationAddresses(this,state,request,{consumerKey,control});
    if(request.kind==='primary-canonical-consumers')return readPrimaryCanonicalConsumers(this,state,request,{consumerKey,control});
    if(request.kind==='timeline-query')return readTimelineRootQuery(this,state,request,{consumerKey,control,createDocument:this.createTimelineDocument});
    if(request.kind==='search-flags'){
      const p=state.searchPresentation;
      if(!p||this.cursor(state,request.nodeToken).identity()!==p.root.cursor().field('matches').identity())throw fail('HISTORY_SEARCH_ROOT_REQUIRED');
      const ids=request.entryUuids;
      if(!Array.isArray(ids)||ids.length<1||ids.length>3||ids.some(id=>typeof id!=='string'||!id||id.length>8192))throw fail('HISTORY_SEARCH_IDS');
      const credit=request.creditBytes??DEFAULT_CREDIT_BYTES;integer(credit,'HISTORY_ROOT_CREDIT',MAX_CREDIT_BYTES);
      if(credit<512)throw fail('HISTORY_ROOT_CREDIT');control?.assertCurrent();p.assertOpen();
      const packet={success:true,...this.identity(state),nodeToken:request.nodeToken,kind:'search-flags',
        items:ids.map(entryUuid=>({entryUuid,match:p.hasEntryKey(entryUuid)})),creditBytesUsed:0};
      if(packetBytes(packet)>credit)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:packet.creditBytesUsed});
      control?.assertCurrent();this.state(request,consumerKey);return packet;
    }
    const cursor = this.cursor(state, request.nodeToken);
    const metadataWindow = request.profile === PRIMARY_METADATA_WINDOW;
    if (request.profile !== undefined && (!metadataWindow || !['range', 'rowWindow'].includes(request.kind)
      || !this.metadataWindowRoot(state, cursor))) throw fail('HISTORY_ROOT_METADATA_PROFILE');
    const creditBytes = request.creditBytes ?? DEFAULT_CREDIT_BYTES;
    integer(creditBytes, 'HISTORY_ROOT_CREDIT', MAX_CREDIT_BYTES);
    if (creditBytes < 512) throw fail('HISTORY_ROOT_CREDIT');
    const offset = integer(request.offset ?? 0, 'HISTORY_ROOT_OFFSET');
    const limit = integer(request.limit ?? this.maxItems, 'HISTORY_ROOT_PAGE_LIMIT');
    const packet = { success: true, ...this.identity(state), nodeToken: request.nodeToken,
      kind: request.kind, offset, nextOffset: offset, done: false, creditBytesUsed: 0,
      ...(state.bodyRequestId ? { bodyRequestId: state.bodyRequestId } : {}),
      ...(state.agentCatalog ? { catalogRequestId: state.agentCatalog.requestId, catalogSequence: state.agentCatalog.sequence } : {}) };
    if (metadataWindow) packet.profile = PRIMARY_METADATA_WINDOW;
    const finish = () => {
      // Count the exact packet, including metadata, escapes and the byte count
      // itself. The renderer also checks the same credit before retaining it.
      packetBytes(packet);
      if (packet.creditBytesUsed > creditBytes) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: packet.creditBytesUsed });
      control?.assertCurrent(); this.state(request, consumerKey);
      this.metrics.pages++; this.metrics.maxPacketBytes = Math.max(this.metrics.maxPacketBytes, packet.creditBytesUsed);
      return packet;
    };
    if (request.kind === 'rowWindow') {
      if (cursor.kind !== 'array') throw fail('HISTORY_ROOT_NOT_ARRAY');
      if (!limit || limit > this.maxItems) throw fail('HISTORY_ROOT_PAGE_LIMIT');
      if (metadataWindow) {
        // One complete row per pull. The range profile advertises this bound
        // BEFORE the caller elects the pull; no error-triggered fallback.
        if (limit !== 1 || request.fields !== undefined) throw fail('HISTORY_ROOT_FIELDS');
        packet.totalLength = cursor.length;
        if (offset >= cursor.length) throw fail('HISTORY_ROOT_OFFSET');
        const row = cursor.at(offset), required = this.metadataRowCredit(state, row);
        if (required === null || required > creditBytes) throw fail('HISTORY_ROOT_METADATA_INELIGIBLE');
        const { valueBytes } = this.metadataWindowBounds(state), fields = [], fieldCount = row.fieldCountUpperBound;
        for (const [key, value] of row.fields()) {
          control?.assertCurrent();
          const name = this.describe(state, key), descriptor = this.describe(state, value);
          if (wireBytes(name) > valueBytes || wireBytes(descriptor) > valueBytes
            || fields.length >= fieldCount) throw fail('HISTORY_ROOT_METADATA_BOUND');
          fields.push({ name: name.kind === 'scalar' ? name.value : name, value: descriptor });
        }
        packet.start = offset; packet.next = packet.nextOffset = offset + 1;
        packet.done = packet.next === cursor.length;
        packet.rows = [{ ordinal: offset, entry: this.describe(state, row, { inline: false }), fields }];
        this.metrics.maxReturnedItems = Math.max(this.metrics.maxReturnedItems, 1);
        return finish();
      }
      if (!Array.isArray(request.fields) || request.fields.length > 16) throw fail('HISTORY_ROOT_FIELDS');
      const fields = new Set();
      for (const field of request.fields) {
        shortString(field, 'HISTORY_ROOT_FIELD', 128);
        if (fields.has(field)) throw fail('HISTORY_ROOT_FIELDS');
        fields.add(field);
      }
      packet.totalLength = cursor.length;
      if (offset > packet.totalLength) throw fail('HISTORY_ROOT_OFFSET');
      packet.start = offset; packet.next = offset; packet.rows = [];
      packet.done = offset === packet.totalLength;
      for (let at = offset; at < packet.totalLength && packet.rows.length < limit; at++) {
        control?.assertCurrent();
        const row = cursor.at(at), selected = Object.create(null);
        for (const field of fields) {
          control?.assertCurrent();
          Object.defineProperty(selected, field, { enumerable: true,
            value: this.describe(state, row.field(field)) });
        }
        const item = { ordinal: at, entry: this.describe(state, row, { inline: false }), fields: selected };
        packet.rows.push(item); packet.next = packet.nextOffset = at + 1;
        packet.done = packet.next === packet.totalLength;
        const required = packetBytes(packet);
        if (required > creditBytes) {
          packet.rows.pop(); packet.next = packet.nextOffset = at;
          packet.done = at === packet.totalLength;
          if (!packet.rows.length) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: required });
          break;
        }
      }
      this.metrics.maxReturnedItems = Math.max(this.metrics.maxReturnedItems, packet.rows.length);
      return finish();
    }
    if (request.kind === 'leaf') {
      if (cursor.kind !== 'text') throw fail('HISTORY_ROOT_NOT_TEXT');
      packet.text = ''; packet.length = cursor.length;
      const available = creditBytes - wireBytes(packet) - 64;
      if (available < 6 && offset < cursor.length && limit) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: wireBytes(packet) + 70 });
      if (offset > cursor.length) throw fail('HISTORY_ROOT_TEXT_RANGE');
      if (offset > 0 && offset < cursor.length) {
        let edge = ''; for (const part of cursor.textRange(offset - 1, 2)) edge += part;
        if (/[\uD800-\uDBFF]/.test(edge[0] || '') && /[\uDC00-\uDFFF]/.test(edge[1] || '')) throw fail('HISTORY_ROOT_TEXT_RANGE');
      }
      let count = Math.min(limit, Math.max(0, Math.floor(available / 6)), Math.max(0, cursor.length - offset));
      if (count && offset + count < cursor.length) {
        let edge = ''; for (const part of cursor.textRange(offset + count - 1, 2)) edge += part;
        if (/[\uD800-\uDBFF]/.test(edge[0] || '') && /[\uDC00-\uDFFF]/.test(edge[1] || '')) count--;
        if (!count && offset < cursor.length) throw fail('HISTORY_ROOT_TEXT_RANGE');
      }
      for (const part of cursor.textRange(offset, count)) packet.text += part;
      packet.nextOffset = offset + packet.text.length; packet.done = packet.nextOffset >= cursor.length;
      this.metrics.textChars += packet.text.length;
      this.metrics.maxReturnedTextChars = Math.max(this.metrics.maxReturnedTextChars, packet.text.length);
      return finish();
    }
    if (request.kind === 'find') {
      if (cursor.kind !== 'array') throw fail('HISTORY_ROOT_NOT_ARRAY');
      const field = shortString(request.field || 'uuid', 'HISTORY_ROOT_FIELD', 128);
      const value = shortString(request.value, 'HISTORY_ROOT_FIND_VALUE', 4096);
      packet.items = [];
      if (field === 'prompt-identity') throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_REQUIRED');
      if (field === 'navigation' && state.primaryPresentation) {
        if(offset!==0)throw fail('HISTORY_ROOT_OFFSET');
        const primary=state.primaryPresentation;
        if(cursor.identity()!==primary.headerCursor.identity())throw fail('HISTORY_ROOT_UNIT_HEADER');
        const target=primary.resolveUUID(value);
        if(target){
          const rank=integer(target.index,'HISTORY_ROOT_UNIT_RANK');
          const header=primary.headerAt(rank);if(!header)throw fail('HISTORY_ROOT_UNIT_RANK');
          packet.items.push({ordinal:rank,value:this.describe(state,header,{inline:false})});packet.nextOffset=rank+1;
        }else packet.nextOffset=cursor.length;
        packet.done=true;return finish();
      }
      const uuidIndexes = field === 'uuid' && (state.primaryPresentation?.settingsIndexes
        && cursor.identity() === state.primaryPresentation.durableMetadataCursor.identity()
        ? state.primaryPresentation.settingsIndexes
        : state.indexes && cursor.identity() === state.indexes.entries.identity() ? state.indexes : null);
      if (uuidIndexes && offset <= cursor.length) {
        const match = uuidIndexes.lookup(value, { offset, limit: 1, aliases: false });
        if (match.ordinals.length) {
          const ordinal = match.ordinals[0];
          packet.items.push({ ordinal, value: this.describe(state, cursor.at(ordinal)) });
          packet.nextOffset = ordinal + 1;
        } else packet.nextOffset = cursor.length;
        packet.done = true;
        return finish();
      }
      for (let at = offset; at < cursor.length; at++) {
        control?.assertCurrent();
        const row = cursor.at(at), selected = row.field(field);
        let equal = selected.kind === 'text' && selected.length === value.length, compared = 0;
        if (equal) for (const chunk of selected.textChunks()) {
          if (chunk !== value.slice(compared, compared + chunk.length)) { equal = false; break; }
          compared += chunk.length;
        }
        if (equal) { packet.items.push({ ordinal: at, value: this.describe(state, row) }); packet.nextOffset = at + 1; break; }
        packet.nextOffset = at + 1;
        if (at % 64 === 63) { if (control?.checkpoint) await control.checkpoint(); else await tick(); this.state(request, consumerKey); }
      }
      packet.done = packet.items.length > 0 || packet.nextOffset >= cursor.length;
      return finish();
    }
    packet.items = [];
    const add = item => {
      packet.items.push(item); packet.nextOffset++;
      if (wireBytes(packet) + 16 > creditBytes) {
        packet.items.pop(); packet.nextOffset--;
        if (!packet.items.length) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL', { minimumCreditBytes: wireBytes({ ...packet, items: [item] }) + 16 });
        return false;
      }
      return true;
    };
    const count = Math.min(limit, this.maxItems);
    if (request.kind === 'range') {
      if (cursor.kind !== 'array') throw fail('HISTORY_ROOT_NOT_ARRAY');
      for (let at = offset; at < cursor.length && packet.items.length < count; at++) {
        control?.assertCurrent();
        const row = cursor.at(at);
        if (!add({ ordinal: at, present: cursor.hasAt(at), value: this.describe(state, row),
          ...(metadataWindow ? { rowWindowCreditBytes: this.metadataRowCredit(state, row) } : {}) })) break;
      }
      packet.length = cursor.length; packet.done = packet.nextOffset >= cursor.length;
    } else if (request.kind === 'body-items') {
      if (!state.bodyRequestId) throw fail('HISTORY_BODY_BINDING');
      let at = 0, exhausted = true;
      for (const { ordinal, value } of bodyBorrow.bodyItems(this.store, cursor)) {
        control?.assertCurrent();
        if (at++ < offset) continue;
        if (packet.items.length >= count) { exhausted = false; break; }
        if (!add({ ordinal, value: this.describe(state, value) })) { exhausted = false; break; }
      }
      packet.length = cursor.length; packet.done = exhausted;
    } else if (request.kind === 'body-pairs') {
      if (!state.bodyRequestId) throw fail('HISTORY_BODY_BINDING');
      let at = 0, exhausted = true;
      for (const [key, value] of bodyBorrow.bodyPairs(this.store, cursor)) {
        control?.assertCurrent();
        if (at++ < offset) continue;
        if (packet.items.length >= count) { exhausted = false; break; }
        if (!add({ ordinal: at - 1, key: this.describe(state, key), value: this.describe(state, value) })) {
          exhausted = false; break;
        }
      }
      packet.done = exhausted;
    } else if (request.kind === 'fields') {
      let at = 0, exhausted = true;
      for (const [key, value] of cursor.fields()) {
        control?.assertCurrent();
        if (at++ < offset) continue;
        if (packet.items.length >= count) { exhausted = false; break; }
        const descriptor = this.describe(state, key);
        if (!add({ name: descriptor.kind === 'scalar' ? descriptor.value : descriptor,
          value: this.describe(state, value) })) { exhausted = false; break; }
      }
      packet.done = exhausted;
    } else if (request.kind === 'projection') {
      if (!Array.isArray(request.fields) || request.fields.length > 64) throw fail('HISTORY_ROOT_FIELDS');
      for (const field of request.fields) shortString(field, 'HISTORY_ROOT_FIELD', 128);
      for (let at = offset; at < request.fields.length && packet.items.length < count; at++) {
        const name = request.fields[at]; control?.assertCurrent();
        if (!add({ name, value: this.describe(state, cursor.field(name)) })) break;
      }
      packet.length = request.fields.length; packet.done = packet.nextOffset >= request.fields.length;
    } else throw fail('HISTORY_ROOT_PAGE_KIND');
    this.metrics.maxReturnedItems = Math.max(this.metrics.maxReturnedItems, packet.items.length);
    return finish();
  }
  stats() { return { ...this.metrics, roots: this.roots.size, opening: this.opening, store: this.store.stats() }; }
  close() {
    if (this.closed) return;
    for (const state of this.roots.values()) this.drop(state);
    this.closed = true; this.secret.fill(0);
    // The reader/cache, not this capability plane, owns store.close().
  }
}

module.exports = { HistoryRootReadPlane, HISTORY_ROOT_PROTOCOL: PROTOCOL,
  HISTORY_ROOT_MAX_CREDIT_BYTES: MAX_CREDIT_BYTES, HISTORY_ROOT_DEFAULT_CREDIT_BYTES: DEFAULT_CREDIT_BYTES };
