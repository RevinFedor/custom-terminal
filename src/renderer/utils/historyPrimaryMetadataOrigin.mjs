const fail = code => Object.assign(new Error(code), { code });
const ORIGIN = Symbol('history-primary-thin-metadata-origin');
// One weak array key owns only an empty subject. No rows, UUIDs, compiler,
// decoded graph or original model are retained by this lookup.
const subjects = new WeakMap();
const rowObject = row => row !== null && typeof row === 'object' && !Array.isArray(row);
function storedOrigin(row) {
  if (!rowObject(row)) return null;
  const marker = Object.getOwnPropertyDescriptor(row, ORIGIN)?.value;
  return marker?.witness?.deref() === row ? marker : null;
}
function mark(row, subject, ordinal, native) {
  const fact = Object.freeze({ subject, ordinal, native });
  Object.defineProperty(row, ORIGIN, { value: Object.freeze({ fact, witness: new WeakRef(row) }),
    enumerable: false, configurable: false, writable: false });
}

/** Register only the already decoded, validated server metadata array before
 * its existing freeze. This annotates the remaining Np compatibility owner;
 * it is not decoder retirement or a new all-agent registry. Repeated identical
 * row objects refer to their first equivalent source ordinal. */
export function registerHistoryPrimaryMetadataOrigin(entries) {
  if (!Array.isArray(entries)) throw fail('HISTORY_PRIMARY_METADATA_ORIGIN');
  const existing = subjects.get(entries);
  if (existing) return existing;
  const subject = Object.freeze({});
  for (let ordinal = 0; ordinal < entries.length; ordinal++) {
    const row = entries[ordinal];
    if (!rowObject(row)) throw fail('HISTORY_PRIMARY_METADATA_ORIGIN');
    const previous = storedOrigin(row);
    if (previous) {
      if (previous.fact.subject !== subject) throw fail('HISTORY_PRIMARY_METADATA_ORIGIN');
      continue;
    }
    if (!Object.isExtensible(row)) throw fail('HISTORY_PRIMARY_METADATA_ORIGIN_FROZEN');
    mark(row, subject, ordinal, false);
  }
  subjects.set(entries, subject);
  return subject;
}
export function historyPrimaryMetadataSubject(entries) {
  return Array.isArray(entries) ? subjects.get(entries) || null : null;
}
export function historyPrimaryMetadataOrigin(row) {
  return storedOrigin(row)?.fact || null;
}
/** Existing sidecar/compatibility clones keep source provenance but remain
 * native mutable CURRENT values. An ordinal never certifies their payload. */
export function copyHistoryPrimaryMetadataOrigin(from, to) {
  const origin = storedOrigin(from)?.fact;
  if (!origin) return to;
  if (!rowObject(to) || !Object.isExtensible(to) || storedOrigin(to)) throw fail('HISTORY_PRIMARY_METADATA_ORIGIN_CLONE');
  mark(to, origin.subject, origin.ordinal, true);
  return to;
}
