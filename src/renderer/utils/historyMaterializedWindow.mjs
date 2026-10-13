import { resolveHistoryGroupCaption } from './historyGroupCaption.mjs';

const exactRevisionToken = (entry) => {
  if (!entry || typeof entry !== 'object') return '';
  const entryRef = entry.entryRef;
  const entryRefToken = entryRef && typeof entryRef === 'object'
    ? [
        entryRef.viewOwnerSessionId,
        entryRef.segmentId,
        entryRef.physicalSessionId,
        entryRef.rawUuid,
        entryRef.contentRevision,
      ].map((value) => String(value ?? '')).join(':')
    : String(entryRef ?? '');
  const fields = [
    entry.sourceIdentity,
    entry.recordByteOffset,
    entry.contentRevision,
    entryRefToken,
  ];
  return fields.some((value) => value !== undefined && value !== null && String(value) !== '')
    ? fields.map((value) => String(value ?? '')).join('|')
    : '';
};

/**
 * A full row may replace an incoming identity stub only when both describe
 * the exact same physical record revision. UUID equality alone is not proof:
 * rewind/edit can preserve a logical address while changing the raw record.
 */
export function historyRowsSharePhysicalRevision(full, stub) {
  if (!full || !stub || full.rowStub === true || stub.rowStub !== true) return false;
  if (!full.uuid || full.uuid !== stub.uuid) return false;
  for (const field of ['physicalSessionId', 'transcriptSegmentId', 'rawUuid']) {
    const left = full[field];
    const right = stub[field];
    if (left !== undefined && right !== undefined && left !== right) return false;
  }
  const fullRevision = exactRevisionToken(full);
  const stubRevision = exactRevisionToken(stub);
  return !!fullRevision && fullRevision === stubRevision;
}

/**
 * Keep only rows that the already presented viewport physically depends on.
 * Incoming full rows always win; an incoming stub may reuse the old full row
 * only under exact physical-revision proof. The result cannot grow beyond the
 * incoming positional list and therefore needs no second unbounded cache.
 */
export function retainHistoryMaterializedWindow(previous, incoming, protectedUuids) {
  const oldRows = Array.isArray(previous) ? previous : [];
  const nextRows = Array.isArray(incoming) ? incoming : [];
  const protectedSet = protectedUuids instanceof Set
    ? protectedUuids
    : new Set(Array.isArray(protectedUuids) ? protectedUuids : []);
  if (protectedSet.size === 0 || oldRows.length === 0) {
    return { entries: nextRows, retained: 0, rejected: 0 };
  }
  const previousByUuid = new Map(oldRows.map((entry) => [entry?.uuid, entry]));
  let retained = 0;
  let rejected = 0;
  const entries = nextRows.map((entry) => {
    if (!entry?.rowStub || !protectedSet.has(entry.uuid)) return entry;
    const previousEntry = previousByUuid.get(entry.uuid);
    if (historyRowsSharePhysicalRevision(previousEntry, entry)) {
      retained += 1;
      return previousEntry;
    }
    rejected += 1;
    return entry;
  });
  return { entries, retained, rejected };
}

const unitPresentationUuids = (unit, captionSelections = null) => {
  if (!unit) return [];
  if (unit.kind !== 'group') return unit.entry?.uuid ? [unit.entry.uuid] : [];
  // A collapsed group's expensive members are not DOM rows. Its height only
  // depends on stub-safe header facts plus the optional caption text.
  const choice = captionSelections?.get(unit.key);
  const captionUuid = (choice ? resolveHistoryGroupCaption(unit.captionEntries, choice).entry : unit.captionEntry)?.uuid;
  return captionUuid ? [captionUuid] : [];
};

/** Physical rows whose already visible presentation must not dehydrate. */
export function collectHistoryMaterializedWindowUuids(
  units,
  range,
  { overscanUnits = 8, maxUuids = 512, captionSelections = null } = {},
) {
  if (!Array.isArray(units) || units.length === 0) return new Set();
  const start = Math.max(0, Math.min(units.length - 1, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(units.length - 1, Number(range?.end) || 0));
  const from = Math.max(0, start - Math.max(0, Number(overscanUnits) || 0));
  const to = Math.min(units.length - 1, end + Math.max(0, Number(overscanUnits) || 0));
  const result = new Set();
  const centre = (start + end) / 2;
  const indices = Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
    .sort((left, right) => Math.abs(left - centre) - Math.abs(right - centre));
  for (const index of indices) {
    for (const uuid of unitPresentationUuids(units[index], captionSelections)) {
      if (!uuid) continue;
      result.add(uuid);
      if (result.size >= maxUuids) return result;
    }
  }
  return result;
}

/**
 * One stable hydration centre for the settled viewport. Unlike choosing the
 * first stub on either flank, this identity does not alternate when the same
 * viewport publishes measurement-driven range changes.
 */
export function historyHydrationCenterForRange(units, range, fallbackUuid = null) {
  if (!Array.isArray(units) || units.length === 0) return fallbackUuid || null;
  const start = Math.max(0, Math.min(units.length - 1, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(units.length - 1, Number(range?.end) || 0));
  const centre = (start + end) / 2;
  const indices = Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
    .sort((left, right) => Math.abs(left - centre) - Math.abs(right - centre));
  for (const index of indices) {
    const unit = units[index];
    if (!unit) continue;
    if (unit.kind !== 'group') {
      if (unit.entry?.uuid) return unit.entry.uuid;
      continue;
    }
    if (unit.captionEntry?.uuid) return unit.captionEntry.uuid;
    const members = Array.isArray(unit.entries) ? unit.entries : [];
    const middle = members[Math.floor(members.length / 2)];
    if (middle?.uuid) return middle.uuid;
  }
  return fallbackUuid || null;
}
