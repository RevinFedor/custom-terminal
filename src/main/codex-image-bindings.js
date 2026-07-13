const crypto = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');

const IMAGE_SLOT_RE = /\[Image(?:\s+#?(\d+))?\]/gi;

function collectImageSlotIds(text) {
  const ids = [];
  const seen = new Set();
  const input = String(text || '');
  let match;
  IMAGE_SLOT_RE.lastIndex = 0;
  while ((match = IMAGE_SLOT_RE.exec(input)) !== null) {
    const id = Number(match[1]);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function availableRef(ref) {
  return !!(ref && typeof ref.path === 'string' && ref.path && ref.availability !== 'missing');
}

class CodexImageBindingRegistry {
  constructor({
    now = () => Date.now(),
    retentionMs = 12 * 60 * 60 * 1000,
    limit = 96,
  } = {}) {
    this.now = now;
    this.retentionMs = retentionMs;
    this.limit = limit;
    this.tabs = new Map();
  }

  stateFor(tabId) {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = {
        bindings: new Map(),
        staged: [],
        pending: [],
        output: '',
      };
      this.tabs.set(tabId, state);
    }
    this.pruneState(state);
    return state;
  }

  pruneState(state) {
    const cutoff = this.now() - this.retentionMs;
    state.staged = state.staged.filter((entry) => entry.at >= cutoff).slice(-this.limit);
    state.pending = state.pending.filter((entry) => entry.at >= cutoff);
  }

  stage(tabId, refs) {
    const input = (Array.isArray(refs) ? refs : []).filter(availableRef);
    if (!tabId || input.length === 0) return null;
    const state = this.stateFor(tabId);
    const token = 'codex-image-' + this.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
    state.staged.push({ token, refs: input.map((ref) => ({ ...ref })), at: this.now() });
    state.staged = state.staged.slice(-this.limit);
    return token;
  }

  begin(tabId, token) {
    if (!tabId || !token) return false;
    const state = this.stateFor(tabId);
    const index = state.staged.findIndex((entry) => entry.token === token);
    if (index < 0) return false;
    const [entry] = state.staged.splice(index, 1);
    const pendingExpectedIds = state.pending.flatMap((pending) => pending.slots.map((slot) => slot.expectedId));
    let nextExpectedId = Math.max(0, ...state.bindings.keys(), ...pendingExpectedIds) + 1;
    const slots = entry.refs.map((ref) => {
      const expectedId = nextExpectedId++;
      const boundRef = { ...ref, id: expectedId };
      state.bindings.set(expectedId, boundRef);
      return { expectedId, ref: boundRef };
    });
    state.pending.push({ slots, at: this.now() });
    state.output = '';
    return true;
  }

  beginDirect(tabId, refs) {
    const token = this.stage(tabId, refs);
    if (!token) return false;
    return this.begin(tabId, token);
  }

  observe(tabId, data) {
    const state = this.tabs.get(tabId);
    if (!state || state.pending.length === 0 || !data) return [];
    state.output = (state.output + String(data)).slice(-64 * 1024);
    const clean = stripVTControlCharacters(state.output);
    const observedIds = collectImageSlotIds(clean).sort((a, b) => a - b);
    if (observedIds.length === 0) return [];

    const bound = [];
    const observedSet = new Set(observedIds);
    const remaining = [];
    for (const pending of state.pending) {
      const expectedIds = pending.slots.map((slot) => slot.expectedId);
      if (expectedIds.every((id) => observedSet.has(id))) {
        bound.push(...pending.slots.map((slot) => slot.ref));
        continue;
      }
      const unboundObserved = observedIds.filter((id) => !state.bindings.has(id));
      const expectedSeen = expectedIds.some((id) => observedSet.has(id));
      if (!expectedSeen && unboundObserved.length === pending.slots.length) {
        pending.slots.forEach((slot) => state.bindings.delete(slot.expectedId));
        pending.slots.forEach((slot, index) => {
          const id = unboundObserved[index];
          const ref = { ...slot.ref, id };
          state.bindings.set(id, ref);
          bound.push(ref);
        });
        continue;
      }
      remaining.push(pending);
    }
    state.pending = remaining;
    if (state.pending.length === 0) state.output = '';
    return bound;
  }

  resolveGrab(tabId, text) {
    const state = this.stateFor(tabId);
    const input = String(text || '');
    const orderedIds = collectImageSlotIds(input);
    const unresolved = orderedIds.filter((id) => !state.bindings.has(id));
    const orderedSet = new Set(orderedIds);
    const pendingSlots = state.pending
      .flatMap((entry) => entry.slots)
      .filter((slot) => !orderedSet.has(slot.expectedId));

    // A final exact-count reconciliation covers a very fast Grab that arrives
    // before the TUI redraw. Any count mismatch is ambiguous (usually an image
    // was deleted), so it must stay missing rather than attach the wrong file.
    if (unresolved.length > 0 && unresolved.length === pendingSlots.length) {
      unresolved.forEach((id, index) => {
        const slot = pendingSlots[index];
        state.bindings.delete(slot.expectedId);
        state.bindings.set(id, { ...slot.ref, id });
      });
      state.pending = [];
    }

    const refsById = new Map();
    let syntheticId = Math.max(0, ...state.bindings.keys(), ...orderedIds);
    let missing = 0;
    IMAGE_SLOT_RE.lastIndex = 0;
    const resolvedText = input.replace(IMAGE_SLOT_RE, (_match, rawId) => {
      const parsedId = Number(rawId);
      const id = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : ++syntheticId;
      const ref = state.bindings.get(id);
      if (!availableRef(ref)) {
        missing += 1;
        return '[imageError: codex_image_path_unavailable #' + id + ']';
      }
      refsById.set(id, { ...ref, id });
      return '[Image #' + id + ']';
    });
    const refs = Array.from(refsById.values());
    const result = {
      text: resolvedText,
      refs,
      missing,
      resolved: refs.length,
      slots: orderedIds.length,
    };
    this.resetComposer(tabId);
    return result;
  }

  handleTerminalInput(tabId, data) {
    // Ctrl+C can stop the active turn while Codex keeps a queued draft, including
    // its image chips. Only Enter proves that the current composer was submitted.
    if (data !== '\r') return false;
    this.resetComposer(tabId);
    return true;
  }

  resetComposer(tabId) {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.bindings.clear();
    state.pending = [];
    state.output = '';
    if (state.staged.length === 0) this.tabs.delete(tabId);
  }

  clear(tabId) {
    this.tabs.delete(tabId);
  }

  describe(tabId) {
    const state = this.tabs.get(tabId);
    if (!state) return 'staged=0 pending=0 bound=0';
    this.pruneState(state);
    const stagedRefs = state.staged.reduce((sum, entry) => sum + entry.refs.length, 0);
    const pendingRefs = state.pending.reduce((sum, entry) => sum + entry.slots.length, 0);
    return 'staged=' + stagedRefs + ' pending=' + pendingRefs + ' bound=' + state.bindings.size;
  }
}

module.exports = {
  CodexImageBindingRegistry,
  collectImageSlotIds,
};
