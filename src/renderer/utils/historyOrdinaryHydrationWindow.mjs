import { resolveHistoryGroupCaption } from './historyGroupCaption.mjs';

export const HISTORY_ORDINARY_BUFFER = 16;

function presentationEntry(unit, selections) {
  if (unit?.kind !== 'group') return unit?.entry;
  if (unit.expanded === true || unit.familyKey === 'research') return null;
  if (unit.familyKey === 'response-work') {
    const entry = unit.previewEntry;
    return entry?.previewTextComplete === true || (typeof entry?.content === 'string' && entry.content.length) ? null : entry;
  }
  const choice = selections?.get(unit.key);
  return choice ? resolveHistoryGroupCaption(unit.captionEntries, choice).entry : unit.captionEntry;
}

// The caller first bounds changedEntries. Walk only the current viewport's
// presentation units, including its selected caption; never the all-row graph.
export function ordinaryHistoryDeltaFillsViewport(units, range, selections, changedEntries) {
  if (!Array.isArray(units) || !units.length || !Array.isArray(changedEntries)) return false;
  const bodies = new Set(changedEntries.filter(e => e?.rowStub !== true && typeof e?.uuid === 'string').map(e => e.uuid));
  const start = Math.max(0, Math.min(units.length - 1, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(units.length - 1, Number(range?.end) || 0));
  for (let i = start; i <= end; i++) {
    const entry = presentationEntry(units[i], selections);
    if (entry?.rowStub === true && bodies.has(entry.uuid)) return true;
  }
  return false;
}

// Only bodies actually presented by the viewport are demand. Hidden members
// of a collapsed group must not pull a moving window back and forth.
export function ordinaryHistoryHydrationDemand(entries, units, range, selections) {
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(units) || !units.length) return null;
  const start = Math.max(0, Math.min(units.length - 1, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(units.length - 1, Number(range?.end) || 0));
  const visible = [];
  for (let i = start; i <= end; i++) {
    const entry = presentationEntry(units[i], selections);
    if (entry?.uuid) visible.push({ entry, index: undefined });
  }
  // A covered viewport must not rebuild an all-history UUID Map on every
  // scroll publication. Only a real miss needs raw-position translation;
  // retain keys for this viewport alone and stop once they are resolved.
  if (!visible.some(item => item.entry.rowStub === true)) return null;
  const positions = new Map(visible.map(item => [item.entry.uuid, undefined]));
  let unresolved = positions.size;
  for (let index = 0; index < entries.length && unresolved; index++) {
    const uuid = entries[index]?.uuid;
    if (positions.has(uuid) && positions.get(uuid) === undefined) {
      positions.set(uuid, index); unresolved--;
    }
  }
  for (let i = visible.length - 1; i >= 0; i--) {
    visible[i].index = positions.get(visible[i].entry.uuid);
    if (visible[i].index === undefined) visible.splice(i, 1);
  }
  const missing = visible.find(item => item.entry.rowStub === true);
  if (!missing) return null;
  let first = missing.index, last = missing.index;
  for (const item of visible) { first = Math.min(first, item.index); last = Math.max(last, item.index); }
  // Main's existing protocol caps radius at 20k. If a viewport spans more,
  // service the actual missing row rather than request an unreachable midpoint.
  const middle = Math.floor((first + last) / 2);
  const wide = Math.max(middle - first, last - middle) + HISTORY_ORDINARY_BUFFER > 20_000;
  const center = wide ? missing.index : middle;
  return { centerUuid: entries[center]?.uuid || missing.entry.uuid,
    radius: wide ? HISTORY_ORDINARY_BUFFER : Math.max(center - first, last - center) + HISTORY_ORDINARY_BUFFER,
    stubUuid: missing.entry.uuid };
}
