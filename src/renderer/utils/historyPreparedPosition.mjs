import { openHistoryPresentationPosition } from '../../shared/history-presentation-position-client.mjs';
import { historyPrimarySparseCompatibilityOrdinal, selectHistoryPrimarySparsePreparedRow } from './historyPrimaryPromptAdoption.mjs';

const fail = code => Object.assign(new Error(code), { code });
const cancelled = () => fail('HISTORY_READ_CANCELLED');
const scalar = value => value == null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
const sameValue = (a, b) => a === b || Number.isNaN(a) && Number.isNaN(b);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const validOrdinal = value => Number.isSafeInteger(value) && value >= 0;
const check = (owns, signal) => { if (signal?.aborted || owns() !== true || signal?.aborted) throw cancelled(); };
const retirement = client => {
  if (typeof client?.retirement !== 'function') return null;
  const value = client.retirement();
  if (value && typeof value.then === 'function') return value;
  if (value?.promise && typeof value.promise.then === 'function') return value.promise;
  throw fail('HISTORY_READER_TRANSPORT_UNKNOWN');
};
function closedPromise(client) {
  if (!client) return Promise.resolve();
  try { const result = client.close(); Promise.resolve(result).catch(() => {}); return retirement(client) || Promise.resolve(result); }
  catch (error) { return Promise.reject(error); }
}

function retirementRecord() {
  let resolve, reject;
  const state = { status: 'pending', error: null };
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
  return { promise, resolve() { state.status = 'released'; resolve(); },
    reject(error) { state.status = 'unknown'; state.error = error; reject(error); },
    handle: Object.freeze({ promise, get status() { return state.status; }, get error() { return state.error; } }) };
}

/** Read-only admission for the selected adapter before any allocation. A
 * false result chooses the existing, explicitly named native compatibility
 * owner; it never manufactures an empty history or retries an unknown open.
 * The boolean is not itself authority: registration repeats original identity
 * checks with its captured frame/owner, and a changed input is cancellation. */
export async function canBindHistoryPreparedPositionFrame({
  prepared = null, metadata = null, sparse = null, currentRows = [], units,
  owns = () => true,
} = {}, { signal } = {}) {
  if (!Array.isArray(units) || !Array.isArray(currentRows) || typeof owns !== 'function') return false;
  check(owns, signal);
  if (prepared && (!Array.isArray(metadata) || typeof prepared.ownsCompatibilityMetadata !== 'function'
    || prepared.ownsCompatibilityMetadata(metadata) !== true)) return false;
  const sourceCount = metadata?.length || 0;
  let work = 0, nextOrdinal = 0, previousGroup = null;
  const checkpoint = async () => { check(owns, signal); if (++work % 64 === 0) { await tick(); check(owns, signal); } };
  async function locate(row) {
    if (currentRows.includes(row)) return -1;
    const enriched = sparse && historyPrimarySparseCompatibilityOrdinal(sparse, row);
    if (validOrdinal(enriched)) return prepared && enriched < sourceCount ? enriched : null;
    if (!prepared) return null;
    const scan = async (start, end) => {
      for (let at = start; at < end; at++) {
        check(owns, signal); const matches = metadata[at] === row; await checkpoint();
        if (matches) { nextOrdinal = at + 1; return at; }
      }
      return null;
    };
    if (nextOrdinal < sourceCount && metadata[nextOrdinal] === row) { const at = nextOrdinal++; await checkpoint(); return at; }
    let at = previousGroup ? await scan(previousGroup.start, previousGroup.end) : null;
    if (at === null) at = await scan(nextOrdinal, sourceCount);
    return at === null ? scan(0, sourceCount) : at;
  }
  for (const unit of units) {
    check(owns, signal);
    if (unit?.kind === 'entry') { if (await locate(unit.entry) === null) return false; }
    else {
      if (!unit || !Array.isArray(unit.entries)) return false;
      let start = Infinity, end = -1;
      for (const row of unit.entries) {
        const at = await locate(row); if (at === null) return false;
        if (at >= 0) { start = Math.min(start, at); end = Math.max(end, at + 1); }
      }
      if (end >= 0) previousGroup = { start, end };
    }
    await checkpoint();
  }
  check(owns, signal); return true;
}

/**
 * V52 compatibility registration adapter. The real existing Np graph and Nu
 * topology remain a declared cost, borrowed ONLY until this one registration
 * finishes. No source-array closure, row Map or copied historical inventory is
 * retained by the opened selected source. UUIDs do not identify a source row:
 * only original decoded row identity or an authenticated sparse origin does.
 *
 * The existing paged position index owns exact actual-frame coordinates/keys.
 * A separate retained prepared child owns selected historical metadata. Full
 * body matching stays in the prepared/sparse planner's selected protocols.
 */
export function createHistoryPreparedPositionSource({
  invoke, prepared = null, metadata = null, sparse = null, currentRows = [],
  units, itemKeys, owns = () => true, open = openHistoryPresentationPosition,
} = {}) {
  if (typeof invoke !== 'function' || typeof open !== 'function' || typeof owns !== 'function'
    || !Array.isArray(units) || !Array.isArray(itemKeys) || units.length !== itemKeys.length
    || !Array.isArray(currentRows) || prepared && (!Array.isArray(metadata)
      || typeof prepared.retain !== 'function' || typeof prepared.ownsCompatibilityMetadata !== 'function'
      || prepared.ownsCompatibilityMetadata(metadata) !== true)) throw fail('HISTORY_PREPARED_POSITION_SOURCE');
  const unitCount = units.length, sourceCount = metadata?.length || 0;
  // This list owns genuine CURRENT objects, not historical row substitutes.
  // Enriched sparse clones are admitted below with their original ordinal.
  let locals = currentRows.slice(), capturedUnits = units, capturedKeys = itemKeys, capturedMetadata = metadata;
  units = itemKeys = metadata = currentRows = null;
  let opened = false, discarded = false;
  const stats = { compatibilityUnitVisits: 0, compatibilityMemberVisits: 0,
    metadataIdentityComparisons: 0, fallbackScans: 0, enrichedSelections: 0, nativeHistoricalEntries: 0 };
  const dropCompatibility = () => { capturedUnits = capturedKeys = capturedMetadata = null; };
  const source = Object.freeze({ unitCount,
    discard() { discarded = true; dropCompatibility(); if (!opened) locals = []; },
    stats() { return { ...stats, compatibilityBorrowed: capturedUnits ? 1 : 0, sparseNativeRows: locals.length }; },
    async open(options) {
      if (opened || discarded || !capturedUnits) throw fail('HISTORY_PREPARED_POSITION_ALREADY_OPENED');
      opened = true;
      let held = null, positions = null, closed = false, cleanup = null, work = 0;
      let sourceOrdinal = 0, previousGroup = null;
      const points = new WeakSet(), controller = new AbortController(), retired = retirementRecord();
      const valid = () => !closed && (!held || held.closed !== true) && owns() === true
        && !closed && options.owns() === true && !closed && (!held || held.closed !== true);
      const checkpoint = async () => {
        check(valid, options.signal);
        if (++work % 64 === 0) { await tick(); check(valid, options.signal); }
      };
      const close = () => {
        if (cleanup) return cleanup;
        // Reserve the graph-free receipt before abort/release can reenter.
        cleanup = retired.promise;
        closed = true;
        const position = positions, preparedChild = held; positions = held = null;
        dropCompatibility(); locals = []; prepared = sparse = null; owns = () => false;
        let abortError; try { controller.abort(); } catch (error) { abortError = error; }
        Promise.all([closedPromise(position), closedPromise(preparedChild)])
          .then(() => { if (abortError) retired.reject(abortError); else retired.resolve(); }, retired.reject);
        return cleanup;
      };
      async function locate(row) {
        const current = locals.indexOf(row);
        if (current >= 0) return { kind: 'current', ordinal: current };
        const decorated = sparse && historyPrimarySparseCompatibilityOrdinal(sparse, row);
        if (validOrdinal(decorated)) {
          if (!held || decorated >= sourceCount) throw fail('HISTORY_PREPARED_POSITION_UNBOUND_ROW');
          // The same enrichment may decorate N duplicate UUID occurrences.
          // Retain its sparse sidecars once; materialize ONLY the selected row
          // by original ordinal, never an N list of decorated native clones.
          stats.enrichedSelections++; return { kind: 'prepared', ordinal: decorated };
        }
        if (!held || !capturedMetadata) throw fail('HISTORY_PREPARED_POSITION_UNBOUND_ROW');
        const at = async (start, end) => {
          for (let index = start; index < end; index++) {
            check(valid, options.signal); stats.metadataIdentityComparisons++;
            const matches = capturedMetadata[index] === row; await checkpoint();
            if (matches) { sourceOrdinal = index + 1; return index; }
          }
          return null;
        };
        // Common source-order scan is linear. Expanded work/group members
        // replay their preceding bounded source range before any suffix scan.
        if (sourceOrdinal < sourceCount && capturedMetadata[sourceOrdinal] === row) {
          stats.metadataIdentityComparisons++; const ordinal = sourceOrdinal++; await checkpoint();
          return { kind: 'prepared', ordinal };
        }
        let ordinal = previousGroup ? await at(previousGroup.start, previousGroup.end) : null;
        if (ordinal === null) ordinal = await at(sourceOrdinal, sourceCount);
        if (ordinal === null) { stats.fallbackScans++; ordinal = await at(0, sourceCount); }
        if (ordinal === null) throw fail('HISTORY_PREPARED_POSITION_UNBOUND_ROW');
        return { kind: 'prepared', ordinal };
      }
      async function* records() {
        for (let index = 0; index < unitCount; index++) {
          check(valid, options.signal);
          const unit = capturedUnits[index], physicalKey = capturedKeys[index]; stats.compatibilityUnitVisits++;
          if (typeof physicalKey !== 'string') throw fail('HISTORY_POSITION_PHYSICAL_KEY');
          if (unit?.kind === 'entry') {
            const row = unit.entry, selection = await locate(row); stats.compatibilityMemberVisits++;
            const uuid = row?.uuid;
            yield { uuid: scalar(uuid) ? uuid : null, index, memberIndex: -1, memberCount: 1, physicalKey, selection };
            continue;
          }
          if (!unit || !Array.isArray(unit.entries)) throw fail('HISTORY_POSITION_UNIT_INVALID');
          const entries = unit.entries, count = entries.length;
          if (!count) { yield { uuid: null, index, memberIndex: -2, memberCount: 0, physicalKey, selection: null }; continue; }
          let start = Infinity, end = -1;
          for (let memberIndex = 0; memberIndex < count; memberIndex++) {
            check(valid, options.signal);
            if (unit.entries !== entries || entries.length !== count) throw fail('HISTORY_POSITION_INPUT_CHANGED');
            const row = entries[memberIndex], selection = await locate(row), uuid = row?.uuid;
            stats.compatibilityMemberVisits++;
            if (selection.kind === 'prepared') { start = Math.min(start, selection.ordinal); end = Math.max(end, selection.ordinal + 1); }
            yield { uuid: scalar(uuid) ? uuid : null, index, memberIndex, memberCount: count, physicalKey, selection };
          }
          if (end >= 0) previousGroup = { start, end };
        }
      }
      try {
        check(valid, options.signal);
        if (prepared) {
          held = await prepared.retain({ owns: valid, signal: options.signal });
          check(valid, options.signal);
          if (!held || typeof held.readMetadataOrdinal !== 'function' || typeof held.close !== 'function'
            || typeof held.ownsCompatibilityMetadata !== 'function'
            || held.ownsCompatibilityMetadata(capturedMetadata) !== true) throw fail('HISTORY_PREPARED_POSITION_CHILD');
        }
        positions = await open(invoke, { ...options, records: records(), owns: valid });
        check(valid, options.signal); dropCompatibility();
        return Object.freeze({
          async resolve(uuid, readOptions = {}) {
            check(valid, readOptions.signal);
            const originalPositions = positions, originalHeld = held;
            const readOwned = () => valid() && positions === originalPositions && held === originalHeld
              && (!readOptions.owns || readOptions.owns() === true) && !closed;
            const abort = new AbortController(), forward = () => abort.abort();
            controller.signal.addEventListener('abort', forward, { once: true });
            readOptions.signal?.addEventListener('abort', forward, { once: true });
            if (controller.signal.aborted || readOptions.signal?.aborted) abort.abort();
            try {
              const selected = await originalPositions.resolve(uuid, { ...readOptions, owns: readOwned, signal: abort.signal });
              check(readOwned, abort.signal);
              if (selected?.kind === 'missing') return selected;
              const locator = selected?.selection;
              if (selected?.kind !== 'found' || !locator || !validOrdinal(locator.ordinal)) throw fail('HISTORY_POSITION_RESULT_INVALID');
              let entry;
              if (locator.kind === 'current') entry = locals[locator.ordinal];
              else if (locator.kind === 'prepared' && originalHeld && locator.ordinal < sourceCount) {
                entry = await originalHeld.readMetadataOrdinal(locator.ordinal, { owns: readOwned, signal: abort.signal });
                if (sparse) entry = selectHistoryPrimarySparsePreparedRow(sparse, locator.ordinal, entry);
              } else throw fail('HISTORY_POSITION_RESULT_INVALID');
              check(readOwned, abort.signal);
              if (!entry || !entry.uuid || !sameValue(entry.uuid, uuid)) throw fail('HISTORY_POSITION_RESULT_INVALID');
              // Native CURRENT getters may revoke this original source.
              check(readOwned, abort.signal);
              const point = Object.freeze({ kind: 'found', index: selected.index, memberIndex: selected.memberIndex,
                memberCount: selected.memberCount, physicalKey: selected.physicalKey, entry,
                selection: locator, prepared: originalHeld });
              points.add(point); return point;
            } finally {
              controller.signal.removeEventListener('abort', forward);
              readOptions.signal?.removeEventListener('abort', forward);
            }
          },
          entryAt(point) {
            if (closed || !points.has(point) || !valid() || closed || point.prepared !== held) return null;
            if (point.selection.kind === 'current' && locals[point.selection.ordinal] !== point.entry) return null;
            return !closed ? point.entry : null;
          },
          close,
          retirement() { return retired.handle; },
        });
      } catch (error) {
        dropCompatibility();
        const ownCleanup = close(), raw = error?.positionRetirement?.promise || error?.preparedRetirement?.promise;
        const promise = raw ? Promise.all([ownCleanup, raw]).then(() => {}) : ownCleanup; promise.catch(() => {});
        const result = error instanceof Error ? error : Object.assign(fail('HISTORY_READER_TRANSPORT_UNKNOWN'), { cause: error });
        Object.defineProperty(result, 'positionRetirement', { value: { promise }, configurable: true });
        throw result;
      }
    },
  });
  return source;
}
