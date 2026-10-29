// Synchronous admission for the *current bounded* primary presentation window.
// A missing address/body is a loading state, never a manufactured row identity.
// The producer/model validates semantic keys and cut membership; the caller
// additionally owns local composition, which can move without a root response.
export function createHistoryPrimaryItemAdmission(root, snapshot, matches) {
  const admit = index => {
    if (!root || !snapshot || !Number.isSafeInteger(index) || index < 0
      || index >= snapshot.totalCount) return false;
    const address = snapshot.addresses?.get(index), unit = snapshot.window.get(index);
    if (!address || !unit || typeof address.physicalKey !== 'string' || !address.physicalKey
      || typeof root.matchesSnapshotUnit !== 'function'
      || root.matchesSnapshotUnit(snapshot, index, unit) !== true) return false;
    // An async predicate is not a synchronous admission proof.
    return typeof matches === 'function' && matches(index, unit) === true;
  };
  const key = index => {
    if (!admit(index)) throw Object.assign(new Error('HISTORY_PRIMARY_KEY_NOT_ADMITTED'),
      { code: 'HISTORY_PRIMARY_KEY_NOT_ADMITTED' });
    return snapshot.addresses.get(index).physicalKey;
  };
  return Object.freeze({ admit, key });
}
