import { historyPrimaryMetadataOrigin } from './historyPrimaryMetadataOrigin.mjs';

const failure = code => Object.assign(new Error(code), { code });
const sameScope = (left, right) => left?.ownerKey === right?.ownerKey && left?.generation === right?.generation;

/** Exact chip-domain registration beside the retained Np compatibility
 * publisher. It keeps ordinal RUNS and genuine CURRENT rows, never a native
 * historical row/UUID/agent registry. Registration still traverses the
 * existing compatibility array; subsequent catalog work does not read it.
 * The source lease is independent of the original model and writer scope. */
export function createHistoryAgentCatalogSourceOwner({ isLocal, onReleaseError = () => {} } = {}) {
  if (typeof isLocal !== 'function') throw failure('HISTORY_AGENT_CATALOG_LOCAL_PREDICATE');
  let current = null, closed = false, sequence = 0;
  const release = held => {
    if (held) Promise.resolve().then(() => held.close()).catch(error => { try { onReleaseError(error); } catch {} });
  };
  const sourceFor = (subject, prepared, hint) => [prepared, hint?.prepared, current?.prepared]
    .find(value => value && !value.closed && value.metadataSubject === subject) || null;
  const classify = (entries, prepared, hint) => {
    const segments = [], rows = [], nativeRows = [];
    let source = null, historicalCount = 0;
    for (const row of entries) {
      if (isLocal(row)) {
        rows.push(row); nativeRows.push(row); segments.push(Object.freeze({ row })); continue;
      }
      const origin = historyPrimaryMetadataOrigin(row);
      if (!origin) throw failure('HISTORY_AGENT_CATALOG_UNREGISTERED_SOURCE');
      const nextSource = sourceFor(origin.subject, prepared, hint);
      if (!nextSource || source && source.metadataSubject !== origin.subject
        || !Number.isSafeInteger(origin.ordinal) || origin.ordinal < 0
        || origin.ordinal >= nextSource.header.sourceEntryCount) throw failure('HISTORY_AGENT_CATALOG_SOURCE_IDENTITY');
      source = nextSource; historicalCount++;
      // Existing sidecar decoration makes a mutable native clone. Its
      // original provenance authenticates the source, but cannot certify
      // later native field values: keep it under the full CURRENT witness.
      if (origin.native === true) { nativeRows.push(row); segments.push(Object.freeze({ row })); continue; }
      const last = segments[segments.length - 1];
      if (last && 'start' in last && last.end === origin.ordinal) last.end++;
      else segments.push({ start: origin.ordinal, end: origin.ordinal + 1 });
    }
    // With zero historical rows a held source is still a usable read-only
    // backing for the exact empty historical range. It grants no authority
    // over the new writer or owner. Before ANY source has opened, absence of
    // a lease is UNKNOWN; synchronous CURRENT UI remains available.
    source ||= prepared && !prepared.closed ? prepared
      : hint?.prepared && !hint.prepared.closed ? hint.prepared
        : current?.prepared && !current.prepared.closed ? current.prepared : null;
    return { source, historicalCount, segments: Object.freeze(segments.map(Object.freeze)),
      rows: Object.freeze(rows), nativeRows: Object.freeze(nativeRows) };
  };
  return Object.freeze({
    prepare(entries, scope, { prepared = null, hint = null, enabled = true } = {}) {
      if (closed || !Array.isArray(entries) || typeof scope?.ownerKey !== 'string'
        || !Number.isSafeInteger(scope?.generation)) throw failure('HISTORY_AGENT_CATALOG_PUBLICATION');
      const before = current, beforeSequence = sequence;
      const ownerKey = scope.ownerKey, generation = scope.generation;
      if (enabled && current?.entries.deref() === entries && sameScope(current, scope)
        && (!prepared || prepared.metadataSubject === current.prepared?.metadataSubject)) {
        return Object.freeze({ rows: current.localRows, commit() {
          if (closed || current !== before || sequence !== beforeSequence) throw failure('HISTORY_READ_CANCELLED');
          return current;
        }, discard() {} });
      }
      let classified = null, sourceError = null;
      if (enabled) {
        try { classified = classify(entries, prepared, hint); }
        catch (error) {
          if (!['HISTORY_AGENT_CATALOG_UNREGISTERED_SOURCE', 'HISTORY_AGENT_CATALOG_SOURCE_IDENTITY'].includes(error?.code)) throw error;
          sourceError = error;
        }
      }
      const reused = classified?.source && current?.prepared
        && classified.source.metadataSubject === current.prepared.metadataSubject && !current.prepared.closed;
      const held = classified?.source ? reused ? current.prepared : classified.source.retain() : null;
      let finished = false;
      return Object.freeze({
        rows: classified?.rows,
        commit() {
          if (finished || closed || current !== before || sequence !== beforeSequence || held?.closed)
            throw failure('HISTORY_READ_CANCELLED');
          finished = true;
          const old = current?.prepared;
          current = sourceError ? Object.freeze({ kind: 'chip-source-error', error: sourceError,
            ownerKey, generation, sequence: ++sequence, prepared: null, metadataSubject: null,
            sourceHeader: null, sourceOriginHeader: null, historicalCount: null,
            segments: null, rows: null, localRows: null, entries: new WeakRef(entries), dataSubject: Object.freeze({}) })
            : classified ? Object.freeze({ kind: held ? 'held-chip-source' : 'unestablished-chip-source',
            ownerKey, generation, sequence: ++sequence,
            prepared: held, metadataSubject: held?.metadataSubject || null,
            sourceHeader: held?.header || null, sourceOriginHeader: held?.originHeader || null,
            historicalCount: classified.historicalCount, segments: classified.segments, rows: classified.nativeRows,
            localRows: classified.rows,
            entries: new WeakRef(entries), dataSubject: Object.freeze({}) }) : null;
          if (!classified && !sourceError) ++sequence;
          if (old && old !== held) release(old);
          return current;
        },
        discard() { if (finished) return; finished = true; if (held && !reused) release(held); },
      });
    },
    // A proven delayed Rewind prefix can outlive subsequent model opens.
    // The caller owns this one handoff and releases it on consume/replace.
    capture(entries) {
      if (closed || !current?.prepared) return null;
      const before = current, beforeSequence = sequence;
      const unchanged = () => !closed && current === before && sequence === beforeSequence && !before.prepared.closed;
      const classified = classify(entries, before.prepared, null);
      if (!unchanged()) throw failure('HISTORY_READ_CANCELLED');
      if (classified.historicalCount !== entries.length || !classified.source)
        throw failure('HISTORY_AGENT_CATALOG_PREFIX_SOURCE');
      const held = classified.source.retain();
      if (!unchanged() || held.closed) { release(held); throw failure('HISTORY_READ_CANCELLED'); }
      let released = false;
      return Object.freeze({ prepared: held,
        close() { if (!released) { released = true; release(held); } },
      });
    },
    current() { return closed ? null : current; },
    matches(publication, entries, scope) { return !closed && publication === current && sameScope(publication, scope)
      && publication?.entries.deref() === entries && !publication.prepared?.closed; },
    clear() { const old = current?.prepared; current = null; ++sequence; release(old); },
    close() { if (closed) return; closed = true; const old = current?.prepared; current = null; ++sequence; release(old); },
  });
}
