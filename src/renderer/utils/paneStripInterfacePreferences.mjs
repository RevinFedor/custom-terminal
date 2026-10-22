// The existing app:getState/app:setState SQLite owner is the only persistence
// path. These settings have no localStorage cache/mirror or shutdown writer.
export const PANE_STRIP_INTERFACE_PREFERENCE_KEYS = Object.freeze([
  'paneStripSelectedFirst', 'paneStripCloseOnClick', 'paneStripInstantHover',
]);

export function initialPaneStripInterfacePreferences() {
  return {
    paneStripSelectedFirst: false,
    paneStripCloseOnClick: false,
    paneStripInstantHover: false,
    paneStripPreferenceStatus: Object.fromEntries(PANE_STRIP_INTERFACE_PREFERENCE_KEYS.map(key=>[key,'loading'])),
  };
}

/**
 * A local edit counter fences asynchronous hydration/feedback, not the DB.
 * Main's existing synchronous app:setState handler writes in IPC arrival order.
 * A newer click is sent immediately; an older ACK cannot mark it saved or undo it.
 * Only success:true confirms persistence. A rejection/transport error never
 * rolls back a local edit or claims that an unobserved write did not happen.
 */
export function createPaneStripInterfacePreferences({ getState, setState, invoke, reportError = (_key, _status, _error) => {} }) {
  const edits = new Map(PANE_STRIP_INTERFACE_PREFERENCE_KEYS.map(key => [key, 0]));
  const reads = new Map(PANE_STRIP_INTERFACE_PREFERENCE_KEYS.map(key => [key, 0]));
  const assertKey = key => {
    if (!edits.has(key)) throw new TypeError('Unknown pane-strip preference');
  };
  const publish = (key, status, value) => setState(state => ({
    ...(typeof value === 'boolean' ? { [key]: value } : {}),
    paneStripPreferenceStatus: { ...state.paneStripPreferenceStatus, [key]: status },
  }));
  const report = (key, status, error) => { try { reportError(key, status, error); } catch {} };
  async function hydrate(key) {
    assertKey(key);
    // Startup hydration (including a retry) never overwrites an explicit edit.
    if (edits.get(key) !== 0) return false;
    const request = reads.get(key) + 1;
    reads.set(key, request);
    publish(key, 'loading');
    const current = () => edits.get(key) === 0 && reads.get(key) === request;
    try {
      const value = await invoke('app:getState', key);
      if (!current()) return false;
      if (value != null && typeof value !== 'boolean') throw new TypeError('Invalid pane-strip preference');
      publish(key, 'ready', value === true); // Missing key means default OFF; no seed write.
      return true;
    } catch (error) {
      if (current()) { publish(key, 'load-error'); report(key, 'load-error', error); }
      return false;
    }
  }
  async function write(key, value) {
    assertKey(key);
    if (typeof value !== 'boolean') throw new TypeError('Pane-strip preference must be boolean');
    const state = getState();
    if (state[key] === value && state.paneStripPreferenceStatus[key] === 'ready') return true;
    const edit = edits.get(key) + 1;
    edits.set(key, edit);
    publish(key, 'saving', value);
    try {
      const result = await invoke('app:setState', {
        key, value, reason: 'interface-preference', source: 'useUIStore',
      });
      const accepted = result?.success === true;
      if (edits.get(key) === edit) {
        const status = accepted ? 'ready' : result?.success === false ? 'save-error' : 'save-unknown';
        publish(key, status);
        if (!accepted) report(key, status, result?.error || 'Missing persistence ACK');
      }
      return accepted;
    } catch (error) {
      if (edits.get(key) === edit) { publish(key, 'save-unknown'); report(key, 'save-unknown', error); }
      return false;
    }
  }
  return {
    hydrate: () => Promise.all(PANE_STRIP_INTERFACE_PREFERENCE_KEYS.map(hydrate)),
    write,
    retry: key => {
      assertKey(key);
      return getState().paneStripPreferenceStatus[key] === 'load-error'
        ? hydrate(key) : write(key, getState()[key]);
    },
  };
}
