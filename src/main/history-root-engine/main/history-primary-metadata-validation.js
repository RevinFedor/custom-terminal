'use strict';

// The canonical metadata owner validates the SAME decoded vocabulary as the
// prepared compatibility reader. It never reconstructs a native canonical
// graph. Cycles/aliases and pending work live in the existing quota-accounted
// SQLite backing; only one cursor, bounded scalar, fixed field set and at most
// 64 pending fixed-size addresses are live. Flushes never span an await.
const { createHash, randomUUID } = require('node:crypto');
const { historyPagedCursorAddress, historyPagedCursorFromAddress } = require('./history-paged-store');
const { HISTORY_PRIMARY_METADATA_CONTAINER_KINDS, isThinHistoryMetadataRow } = require('../../../shared/history-primary-metadata-rules.cjs');
const PROFILE = 'primary-canonical-metadata-v1';
const PREPARED_PROFILE = 'primary-prepared-metadata-v1';
const SCHEMA = 1;
const DIAGNOSTIC_FIELDS = Object.freeze(['uuid', 'sourceIdentity', 'contentRevision', 'recordByteOffset',
  'sessionId', 'liveProjection', 'sourceSequence']);
const SOURCE_FIELDS = Object.freeze(['filePath', 'sessionId', 'size', 'mtimeMs', 'ctimeMs', 'fileIdentity', 'linkKind', 'sourceGeneration']);
const THIN_FIELDS = Object.freeze(['uuid', 'rowStub', 'content', 'captionTextComplete', 'thinking', 'compactSummary', 'actions']);
const fail = code => Object.assign(new Error(code), { code });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const tick = () => new Promise(resolve => setImmediate(resolve));
const digestJSON = value => createHash('sha256').update(Buffer.from(JSON.stringify(value), 'utf16le')).digest('hex');
const scalarKinds = new Set(['scalar', 'scalar-root', 'number', 'bigint', 'undefined']);

function sourceProjection(source) {
  const result = {};
  for (const key of SOURCE_FIELDS) if (own(source, key)) {
    const value = source[key];
    // Source fields are checked header scalars. This disjoint tag keeps -0
    // lossless through JSON hashing without duplicating the snapshot on wire.
    result[key] = Object.is(value, -0) ? { kind: 'negative-zero' } : value;
  }
  return result;
}
function checkedScalar(cursor) {
  const value = cursor.scalar();
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string' && value.length <= 64) return value;
  if (typeof value === 'bigint' && /^-?\d{1,64}$/.test(String(value))) return value;
  throw fail('HISTORY_ROOT_VALUE_INVALID');
}
function scalarHashValue(value) {
  return value === undefined ? ['undefined'] : value === null ? ['null']
    : typeof value === 'number' ? ['number', Object.is(value, -0) ? '-0' : String(value)]
      : [typeof value, String(value)];
}
function truthy(cursor) {
  if (!cursor) return false;
  const kind = cursor.kind;
  if (kind === 'text') return cursor.length !== 0;
  if (kind === 'object' || kind === 'array') return true;
  return !!checkedScalar(cursor);
}
function nullish(cursor) {
  if (!cursor) return true;
  return scalarKinds.has(cursor.kind) && checkedScalar(cursor) == null;
}
function booleanTrue(cursor) {
  return !!cursor && scalarKinds.has(cursor.kind) && checkedScalar(cursor) === true;
}

// All ordinary object fields are traversed by the old decoder; array custom
// fields/prototypes are deliberately NOT. Last duplicate field wins exactly as
// Object.defineProperty in the decoder. No arbitrary property name is retained.
async function selectedFields(cursor, names, work) {
  const result = Object.create(null);
  if (cursor.kind !== 'object') return result;
  for (const [key, value] of cursor.fields()) {
    let name = null;
    if (key.kind === 'text') {
      if (key.length <= 32) {
        name = '';
        for (const part of key.textChunks()) { name += part; await work(); }
      }
    } else if (scalarKinds.has(key.kind)) {
      const scalar = checkedScalar(key);
      if (typeof scalar !== 'string') throw fail('HISTORY_PRIMARY_METADATA_FIELD');
      name = scalar;
    } else throw fail('HISTORY_PRIMARY_METADATA_FIELD');
    if (names.includes(name)) result[name] = value;
    await work();
  }
  return result;
}
async function assertThinRow(row, work) {
  const values = await selectedFields(row, THIN_FIELDS, work);
  let actionLength = false;
  const actions = values.actions;
  if (actions) {
    if (actions.kind === 'text' || actions.kind === 'array') actionLength = actions.length !== 0;
    else if (actions.kind === 'object') actionLength = truthy((await selectedFields(actions, ['length'], work)).length);
    else { const value = checkedScalar(actions); actionLength = typeof value === 'string' && value.length !== 0; }
  }
  if (!isThinHistoryMetadataRow((key, observation) => {
    const cursor = values[key];
    if (observation === 'truthy') return truthy(cursor);
    if (observation === 'true') return booleanTrue(cursor);
    if (observation === 'nullish') return nullish(cursor);
    if (observation === 'lengthTruthy') return actionLength;
    if (observation === 'string') return !!cursor && (cursor.kind === 'text'
      || scalarKinds.has(cursor.kind) && typeof checkedScalar(cursor) === 'string');
    throw fail('HISTORY_PRIMARY_METADATA_OBSERVATION');
  })) {
    throw fail('HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN');
  }
}
async function diagnosticField(name, cursor, work) {
  if (!cursor || cursor.kind === 'undefined') return { name, kind: 'missing' };
  if (cursor.kind === 'text') {
    if (cursor.length > 512) return { name, kind: 'invalid' };
    let value = '';
    for (const part of cursor.textChunks()) { value += part; await work(); }
    return { name, kind: 'value', value };
  }
  if (!scalarKinds.has(cursor.kind)) return { name, kind: 'invalid' };
  const value = checkedScalar(cursor);
  if (value === undefined) return { name, kind: 'missing' };
  // JSON number encoding otherwise collapses -0 to 0 before the selected
  // tail digest. The real diagnostic helper accepts and retains signed zero.
  if (Object.is(value, -0)) return { name, kind: 'negative-zero' };
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)) return { name, kind: 'value', value };
  return { name, kind: 'invalid' };
}

async function validateThinMetadataGraph(store, lease, { control, prepared = false } = {}) {
  const job = randomUUID(), hash = createHash('sha256');
  let root;
  let sequence = 0, at = 1, steps = 0, primaryError;
  const pending = [], pendingKeys = new Set();
  const flushPending = () => {
    if (!pending.length) return;
    assert();
    let committedSequence = sequence;
    store.transaction(() => {
      for (const key of pending) {
        const added = store.sql('INSERT OR IGNORE INTO hp_primary_metadata_work(job,node_key,sequence) VALUES (?,?,?)')
          .run(job, key, committedSequence + 1);
        if (added.changes) committedSequence++;
      }
    });
    // Quota and all inserts must commit before publishing the new frontier.
    // On rollback sequence still describes only the previous committed rows.
    sequence = committedSequence;
    pending.length = 0; pendingKeys.clear();
  };
  const assert = () => { control?.assertCurrent(); store.assertOpen(); lease.cursor(); };
  const work = async () => {
    assert();
    if (++steps % 64 === 0) {
      if (control?.checkpoint) await control.checkpoint(); else await tick();
      assert();
    }
  };
  const tag = value => {
    const body = Buffer.from(JSON.stringify(value), 'utf16le');
    hash.update(String(body.length) + ':'); hash.update(body);
  };
  const enqueue = cursor => {
    // Inline scalars have no decoder identity and need no visited entry. In
    // particular, reject a wide bigint with the original wire scalar rule
    // before treating its decimal payload as a purported cursor address.
    if (scalarKinds.has(cursor.kind)) return JSON.stringify(['scalar', scalarHashValue(checkedScalar(cursor))]);
    const address = historyPagedCursorAddress(cursor), key = JSON.stringify(address);
    // This is a fixed address/ref record, never a path or native graph node.
    if (Buffer.byteLength(key) > 4096) throw fail('HISTORY_PRIMARY_METADATA_ADDRESS');
    if (!pendingKeys.has(key)) { pending.push(key); pendingKeys.add(key); }
    if (pending.length === 64) flushPending();
    return key;
  };
  try {
    assert();
    // The table is in the SAME backing file: original SQLite/page/journal disk
    // quotas and small SQL cache still apply. No tempfile outside that budget.
    store.transaction(() => store.db.exec('CREATE TABLE IF NOT EXISTS hp_primary_metadata_work(job TEXT NOT NULL,node_key TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(job,node_key),UNIQUE(job,sequence));'));
    // A new validation demand is a cold read. Bounded cache entries cannot
    // conceal a modified backing page behind a previous successful check.
    store.cache.clear(); store.cacheBytes = 0;
    // Resolve the owner envelope only after cache invalidation as well. A
    // previously cached envelope cannot select an old graph for a cold check.
    root = lease.cursor();
    if (root.kind !== 'array') throw fail('HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN');
    enqueue(root);
    while (at <= sequence || pending.length) {
      if (at > sequence) flushPending();
      // The final batch may contain only aliases to already visited nodes.
      if (at > sequence) break;
      assert();
      const record = store.sql('SELECT node_key FROM hp_primary_metadata_work WHERE job=? AND sequence=?').get(job, at++);
      if (!record) throw fail('HISTORY_PRIMARY_METADATA_WORK_MISSING');
      const cursor = historyPagedCursorFromAddress(store, lease, JSON.parse(record.node_key)), kind = cursor.kind;
      tag(['node', record.node_key, kind]);
      if (kind === 'text') {
        const info = cursor.textInfo();
        if (!Number.isSafeInteger(info.length) || info.length < 0 || !/^[a-f0-9]{64}$/.test(info.digest)) throw fail('HISTORY_ROOT_DESCRIPTOR_INVALID');
        tag(['text', info.length, info.digest]);
        // textChunks validates all page digests AND the complete UTF16 leaf
        // digest/length, including hidden metadata and lone surrogates.
        for (const part of cursor.textChunks()) { hash.update(Buffer.from(part, 'utf16le')); await work(); }
      } else if (scalarKinds.has(kind)) {
        tag(scalarHashValue(checkedScalar(cursor)));
      } else if (kind === 'array') {
        const length = cursor.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) throw fail('HISTORY_ROOT_DESCRIPTOR_INVALID');
        tag(['length', length]);
        for (let index = 0; index < length; index++) {
          const present = cursor.hasAt(index);
          tag(['index', index, present]);
          if (present) tag(['value', enqueue(cursor.at(index))]);
          await work();
        }
      } else if (kind === 'object') {
        for (const [name, value] of cursor.fields()) {
          if (name.kind !== 'text' && (!scalarKinds.has(name.kind) || typeof checkedScalar(name) !== 'string')) {
            throw fail('HISTORY_PRIMARY_METADATA_FIELD');
          }
          tag(['field', enqueue(name), enqueue(value)]);
          await work();
        }
      } else if (!HISTORY_PRIMARY_METADATA_CONTAINER_KINDS.includes(kind)) throw fail('HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED');
      tag(['end']); await work();
    }
    // As with the native decoder, thin checks happen only after the complete
    // reachable graph; every hidden canonical row remains in this scope.
    for (let index = 0; index < root.length; index++) { await assertThinRow(root.at(index), work); await work(); }
    let diagnosticTail = { kind: 'empty' };
    if (!prepared && root.length) {
      const tail = root.at(root.length - 1), selected = await selectedFields(tail, DIAGNOSTIC_FIELDS, work), fields = [];
      for (const name of DIAGNOSTIC_FIELDS) fields.push(Object.freeze(await diagnosticField(name, selected[name], work)));
      const selectedAddress = historyPagedCursorAddress(tail);
      const address = Object.freeze({ ref: Object.freeze({ ...selectedAddress.ref }),
        owners: selectedAddress.owners && Object.freeze({ ...selectedAddress.owners }),
        imported: selectedAddress.imported && Object.freeze({ ...selectedAddress.imported }) });
      diagnosticTail = { kind: 'row', ordinal: root.length - 1, address, fields: Object.freeze(fields) };
    }
    assert();
    return Object.freeze({ kind: 'validated', schema: SCHEMA, digest: hash.digest('hex'),
      ...(prepared ? { preparedEntryCount: root.length } : { canonicalEntryCount: root.length,
        diagnosticTail: Object.freeze(diagnosticTail) }), steps });
  } catch (error) { primaryError = error; throw error; }
  finally {
    // Uncommitted discoveries never become validation or cleanup authority.
    pending.length = 0; pendingKeys.clear();
    // Cleanup is bounded too, including cancellation. It cannot transfer a
    // capability. The caller rechecks its ORIGINAL owner after this await.
    try {
      for (let start = 1; start <= sequence; start += 64) {
        store.transaction(() => {
          for (let index = start; index < Math.min(start + 64, sequence + 1); index++) {
            store.sql('DELETE FROM hp_primary_metadata_work WHERE job=? AND sequence=?').run(job, index);
          }
        });
        if (start + 64 <= sequence) await tick();
      }
    } catch (error) { if (!primaryError) throw error; primaryError.metadataCleanupError = error.code || 'HISTORY_PRIMARY_METADATA_CLEANUP'; }
  }
}

// Prepared Np and canonical Nc use the same wire grammar, but receive disjoint
// validation facts. A canonical receipt cannot attest prepared visibility.
const validateCanonicalMetadata = (store, lease, options = {}) => validateThinMetadataGraph(store, lease, { ...options, prepared: false });
const validatePreparedMetadata = (store, lease, options = {}) => validateThinMetadataGraph(store, lease, { ...options, prepared: true });

const REFUSALS = new Set(['HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN', 'HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED',
  'HISTORY_PRIMARY_METADATA_FIELD', 'HISTORY_ROOT_VALUE_INVALID', 'HISTORY_ROOT_DESCRIPTOR_INVALID']);
async function establishCanonicalMetadataValidation(store, lease, options) {
  try { return await validateCanonicalMetadata(store, lease, options); }
  catch (error) {
    // Independent selected full-value readers admit a broader graph grammar.
    // A metadata refusal is recorded, never turned into a successful fact and
    // never used to narrow those already-owned capabilities.
    if (!REFUSALS.has(error.code) || error.metadataCleanupError) throw error;
    options?.control?.assertCurrent(); lease.cursor();
    return Object.freeze({ kind: 'refused', schema: SCHEMA, error: error.code, digest: null });
  }
}

async function establishPreparedMetadataValidation(store, lease, options) {
  try { return await validatePreparedMetadata(store, lease, options); }
  catch (error) {
    if (!REFUSALS.has(error.code) || error.metadataCleanupError) throw error;
    options?.control?.assertCurrent(); lease.cursor();
    return Object.freeze({ kind: 'refused', schema: SCHEMA, error: error.code, digest: null });
  }
}

module.exports = { PROFILE, PREPARED_PROFILE, SCHEMA, DIAGNOSTIC_FIELDS, SOURCE_FIELDS, sourceProjection, digestJSON,
  validateCanonicalMetadata, establishCanonicalMetadataValidation, validatePreparedMetadata, establishPreparedMetadataValidation };
