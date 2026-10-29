// Selected primary addresses are read capabilities, never mutation authority.
// These helpers are used by HistoryPanel's real input/paint, initial-position,
// navigation and mounted-search callbacks. They do not own a historical index.
import { historyPrimaryMetadataSubject } from './historyPrimaryMetadataOrigin.mjs';
const cancelled = () => Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' });
const settingsCachePublications = new WeakSet();

// One first-render cache write may remember default keys without changing a
// single row. Only the original frozen prepared rows qualify: CURRENT clones,
// hidden-owner snapshots and a changed merge stay on the existing refresh path.
// There is no N-sized index or retained array; this short-lived receipt has weak
// references and is consumed once by the original full caller witness below.
export function captureHistoryPrimarySettingsCachePublication(root, entries, output, scope) {
  if (!scope?.cacheWasEmpty || !Number.isSafeInteger(scope.ownerGeneration)
    || !root || root.closed || entries !== output || !Array.isArray(entries)) return null;
  const view = root.view, prepared = view?.serverMetadata?.entries;
  if (!view || root.header !== view.header || !Array.isArray(prepared) || !Object.isFrozen(prepared)
    || !historyPrimaryMetadataSubject(prepared) || !view.prepared?.ownsCompatibilityMetadata(prepared)
    || entries.length !== prepared.length) return null;
  for (let index = 0; index < entries.length; index++) if (entries[index] !== prepared[index]) return null;
  const receipt = Object.freeze({ root: new WeakRef(root), view: new WeakRef(view), header: view.header,
    entries: new WeakRef(entries), prepared: new WeakRef(prepared), ownerKey: scope.ownerKey,
    ownerGeneration: scope.ownerGeneration, dataSubject: root.getReceiptDataSubject() });
  settingsCachePublications.add(receipt);
  return receipt;
}

export function historyPrimaryPanelInputFingerprint(presentation, suppressions, captions, fingerprint) {
  if (!presentation) return null;
  // settingsPresentationKeys is already an immutable panel-owned array of
  // primitive pairs. Compare its reference separately; walking it here would
  // import the OPEN all-settings compatibility owner into every scroll commit.
  return fingerprint({ localEntries: presentation.localEntries, liveEntries: presentation.liveEntries,
    liveToolResults: presentation.liveToolResults, rewindPreview: presentation.rewindPreview,
    grouping: presentation.grouping, captionSelections: presentation.captionSelections,
    suppressions: Array.from(suppressions || []), captions: Array.from(captions || []) });
}

export function captureHistoryPrimaryPanelWitness({ root, header, ownerKey, entries, rewind,
  presentation, fingerprint }) {
  return Object.freeze({ root, header, ownerKey, entries: new WeakRef(entries), rewind, fingerprint,
    settingsKeys: new WeakRef(presentation.settingsPresentationKeys) });
}

export function historyPrimaryPanelWitnessCurrent(witness, current, fingerprint) {
  if (!witness || !current.root || current.root.closed || current.root !== witness.root
    || current.root.header !== witness.header || witness.header !== current.header
    || witness.ownerKey !== current.ownerKey || current.live?.ownerKey !== current.ownerKey
    || current.results?.ownerKey !== current.ownerKey || !Array.isArray(current.live?.entries)
    || !(current.results?.results instanceof Map) || witness.entries.deref() !== current.entries
    || witness.rewind !== current.rewind
    || witness.settingsKeys.deref() !== current.presentation?.settingsPresentationKeys) return false;
  // Tool retirement publishes an equivalent working Map before its await.
  // Wrapper identity is not a semantic change; CURRENT map contents are.
  // Reading the imperative refs also catches input newer than React's render.
  return witness.fingerprint === historyPrimaryPanelInputFingerprint({ ...current.presentation,
    liveEntries: current.live.entries,
    liveToolResults: current.results.results.size ? current.results.results : null },
    current.suppressions, current.captions, fingerprint);
}

// One synchronous row-render/measurement transaction. No proof survives a
// return, throw, await, nested transaction, or changed imperative binding.
// Same-reference content is hashed afresh at EVERY transaction boundary.
// During the stack, async producers cannot run; per-row checks compare this
// transaction's version and constant-size current bindings, never payload text.
export function createHistoryPrimaryPanelInputTransaction(readCurrent, fingerprint) {
  let active = null, version = 0;
  const binding = value => [
    value.witness, value.root, value.header, value.ownerKey, value.entries,
    value.live, value.live?.entries, value.results, value.results?.results,
    value.rewind, value.presentation, value.presentation?.localEntries,
    value.presentation?.liveEntries, value.presentation?.liveToolResults,
    value.presentation?.rewindPreview, value.presentation?.grouping,
    value.presentation?.captionSelections, value.presentation?.settingsPresentationKeys,
    value.suppressions, value.suppressions?.size, value.captions, value.captions?.size,
    value.ownerGeneration,
  ];
  const invalidate = () => { ++version; if (active) active.valid = false; };
  const current = () => {
    const value = readCurrent();
    if (!active) return historyPrimaryPanelWitnessCurrent(value.witness, value, fingerprint);
    if (!active.valid || active.version !== version || value.root?.closed) return false;
    const next = binding(value);
    if (!next.every((field, index) => field === active.binding[index])
      || value.root?.header !== value.header) {
      invalidate(); return false;
    }
    return active.proved;
  };
  const run = callback => {
    const previous = active;
    invalidate(); // A nested transaction can never revive its parent's proof.
    const value = readCurrent();
    const transaction = active = { version, binding: binding(value), valid: true,
      proved: historyPrimaryPanelWitnessCurrent(value.witness, value, fingerprint) };
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        throw Object.assign(new Error('HISTORY_PRIMARY_INPUT_TRANSACTION_ASYNC'),
          { code: 'HISTORY_PRIMARY_INPUT_TRANSACTION_ASYNC' });
      }
      return result;
    } finally {
      transaction.valid = false;
      active = previous;
    }
  };
  const rebaseSettingsCache = (receipt, applied, presentation) => {
    if (!receipt || !settingsCachePublications.delete(receipt)) return null;
    const value = readCurrent(), witness = value.witness, before = binding(value), atVersion = version;
    const root = receipt.root.deref(), view = receipt.view.deref(), prepared = receipt.prepared.deref();
    if (!root || root.closed || value.root !== root || root.view !== view || value.header !== receipt.header
      || root.header !== receipt.header || root.getReceiptDataSubject() !== receipt.dataSubject
      || value.ownerKey !== receipt.ownerKey || value.ownerGeneration !== receipt.ownerGeneration
      || value.entries !== receipt.entries.deref() || view?.serverMetadata?.entries !== prepared
      || !view.prepared?.ownsCompatibilityMetadata(prepared) || view.presentation !== applied
      || !witness || witness.root !== root || witness.header !== receipt.header
      || witness.settingsKeys.deref() !== applied?.settingsPresentationKeys
      || !Array.isArray(applied.settingsPresentationKeys) || applied.settingsPresentationKeys.length !== 0
      || value.presentation !== presentation || value.suppressions?.size !== 0 || value.rewind
      || applied.localEntries !== presentation.localEntries || presentation.localEntries?.length !== 0
      || applied.liveEntries !== presentation.liveEntries || presentation.liveEntries?.length !== 0
      || applied.liveToolResults || presentation.liveToolResults || applied.rewindPreview || presentation.rewindPreview
      || !Array.isArray(presentation.settingsPresentationKeys) || !presentation.settingsPresentationKeys.length) return null;
    // A new alias/remapping is a real semantic input, never a cache-only hit.
    for (const pair of presentation.settingsPresentationKeys) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
        || pair[1] !== 'source:' + pair[0]) return null;
    }
    const rebased = Object.freeze({ ...witness, settingsKeys: new WeakRef(presentation.settingsPresentationKeys) });
    // Preserve the original FULL caller predicate, then recheck cheap owner /
    // input identity after possible native reentry. This grants no read/write
    // capability and does not replace the prepared subject or data commit.
    if (!historyPrimaryPanelWitnessCurrent(rebased, value, fingerprint)) return null;
    const after = readCurrent();
    if (version !== atVersion || !binding(after).every((field, index) => field === before[index])
      || root.closed || root.view !== view || root.header !== receipt.header
      || root.getReceiptDataSubject() !== receipt.dataSubject) return null;
    return rebased;
  };
  return Object.freeze({ current, run, invalidate, rebaseSettingsCache });
}

// One selected request. Every await preserves the exact view and caller's
// owner/gesture/request guard. A rejected/UNKNOWN read never becomes a miss.
export async function readHistoryPrimaryPanelAddress(root, kind, identity, { tool, signal, owns = () => true } = {}) {
  const header = root?.header;
  const current = () => !signal?.aborted && !!header && !root.closed && root.header === header && owns() === true;
  if (!current()) throw cancelled();
  const options = { signal, owns: current, tool };
  const address = kind === 'group' ? await root.resolveGroup(identity, options)
    : kind === 'key' ? await root.resolveKey(identity, options)
      : kind === 'entry' ? await root.resolveUuid(identity, options)
      : await root.resolvePresentationTarget(identity, tool || null, options);
  if (!current()) throw cancelled();
  if (address && (!Number.isSafeInteger(address.index) || address.index < 0 || address.index >= root.totalCount)) {
    throw Object.assign(new Error('HISTORY_PRIMARY_ADDRESS_INVALID'), { code: 'HISTORY_PRIMARY_ADDRESS_INVALID' });
  }
  return Object.freeze({ root, header, address });
}

// Mounts are bounded DOM subjects. Their current wrapper rank is certified by
// the adopted root address/body, rather than looked up in an N-UUID map.
export function collectHistoryPrimaryMountedSearchSubjects(scroller, ownerDomId, root, keysForEntry) {
  const subjects = new Map(), keys = new Set();
  if (!scroller || !root?.header || root.closed) return { subjects, keys };
  const snapshot = root.renderSnapshot();
  for (const row of scroller.querySelectorAll('[data-uuid]')) {
    const uuid = row.dataset.uuid;
    if (!uuid || row.dataset.historyRowOwner !== ownerDomId || subjects.has(uuid)) continue;
    const wrapper = row.closest('[data-item-index]');
    const index = Number(wrapper?.getAttribute('data-item-index'));
    if (!wrapper || !Number.isSafeInteger(index) || index < 0) continue;
    const unit = snapshot.window.get(index), address = root.addressAt(index);
    if (!unit || !address || !root.matchesSnapshotUnit(snapshot, index, unit)
      || row.getAttribute('data-history-unit-key') !== address.physicalKey) continue;
    const entry = unit.kind === 'entry' ? unit.entry : unit.entries?.find(item => item.uuid === uuid);
    if (!entry || entry.uuid !== uuid) continue;
    const aliases = keysForEntry(entry);
    subjects.set(uuid, aliases);
    for (const key of aliases) keys.add(key);
  }
  return { subjects, keys };
}
