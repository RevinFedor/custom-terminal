'use strict';

const { verifyCanonicalSourceSpan, canonicalRecordFingerprint } = require('./codex-canonical-source-proof');
const MAX_CANONICAL_PRESENTATION_ENTRIES = 32;
const MAX_CANONICAL_PRESENTATION_BYTES = 2 * 1024 * 1024;
const keys = ['watcher', 'terminalToken', 'runSeq', 'lifecycleGeneration', 'sourceId',
  'launchId', 'turnId', 'threadId', 'stopRevision', 'sessionId', 'filePath'];
const sameScope = (a, b) => !!a && !!b && keys.every(key => a[key] === b[key]);

function createCodexCanonicalPresentation({ getScope, getController, publish,
  verify = verifyCanonicalSourceSpan, log = () => {},
  maxEntries = MAX_CANONICAL_PRESENTATION_ENTRIES, maxBytes = MAX_CANONICAL_PRESENTATION_BYTES,
} = {}) {
  const windows = new Map();
  const receiptScope = scope => ({ instanceId: scope.sourceId, turnId: scope.turnId,
    threadId: scope.threadId, lifecycleGeneration: scope.lifecycleGeneration });
  const note = (action, window, extra = {}) => log(action, { tabId: window.scope.tabId,
    source: window.scope.sourceId, turn: window.scope.turnId, session: window.scope.sessionId,
    run: window.scope.runSeq, lifecycle: window.scope.lifecycleGeneration, generation: window.generation,
    entries: window.entries.size, bytes: window.bytes, ...extra });
  const invalidate = (tabId, reason = 'owner-replaced') => {
    const window = windows.get(tabId);
    if (!window) return;
    window.invalidated = true;
    windows.delete(tabId);
    note('INVALIDATE', window, { reason });
    window.entries.clear(); window.bytes = 0;
  };
  const windowFor = (scope, create = false) => {
    if (scope?.conflict || scope?.deferred) { invalidate(scope.tabId, 'conflict-or-deferred'); return null; }
    if (!scope?.watcher || !scope.sourceId || !scope.turnId) return null;
    let window = windows.get(scope.tabId);
    if (window && (!sameScope(window.scope, scope) || window.generation !== scope.generation)) {
      invalidate(scope.tabId); window = null;
    }
    if (!window && create) {
      window = { scope, token: {}, generation: scope.generation, entries: new Map(),
        bytes: 0, released: false, failed: false, invalidated: false, flight: null,
        needsAdmission: false, dirty: false };
      windows.set(scope.tabId, window);
    }
    return window;
  };
  const valid = window => {
    const scope = getScope(window.scope.tabId);
    if (window.invalidated || windows.get(window.scope.tabId) !== window) return false;
    if (!sameScope(window.scope, scope) || scope.conflict || scope.deferred
      || window.generation !== scope.generation) {
      invalidate(window.scope.tabId, 'scope-invalidated'); return false;
    }
    return true;
  };
  const canPublish = window => {
    const scope = getScope(window.scope.tabId);
    return valid(window) && window.released && !window.failed && scope?.publicAllowed === true
      && !scope.held && !scope.conflict && !scope.deferred && !scope.scanning;
  };
  const freePublishedPayload = (window, entry) => {
    if (entry.state !== 'published' || !entry.admission || entry.admission === 'no-state') return;
    window.bytes -= entry.bytes; entry.bytes = 0; entry.record = null;
    entry.receipt.canonicalText = null;
  };
  const deliver = (window, entry) => {
    if (!valid(window) || entry.admission && entry.admission !== 'no-state') return;
    const result = getController().admitCodexCanonicalReceipt({ ...entry.receipt,
      receiptToken: entry.token, presentationHeld: entry.state !== 'published', scope: receiptScope(window.scope) });
    entry.admission = result.status;
    if (result.status === 'no-state') window.needsAdmission = true;
    freePublishedPayload(window, entry);
  };
  const capture = (state, detail, boundary) => {
    const scope = getScope(state.tabId);
    if (scope?.conflict || scope?.deferred) invalidate(state.tabId, 'conflict-or-deferred');
    if (scope?.watcher !== state || !scope.held || scope.conflict || scope.deferred) return null;
    const window = windowFor(scope, true);
    if (!window) return null;
    const ticket = detail.sourceTicket;
    if (ticket && ticket.recordDigest !== canonicalRecordFingerprint(detail.message)) {
      note('HOLD', window, { reason: 'raw-record-ticket-mismatch', identity: boundary.identity });
      return { handled: true, status: 'wrong-source' };
    }
    const identity = boundary.identity;
    const receipt = { tabId: state.tabId, sessionId: boundary.sessionId,
      sourceEndOffset: boundary.recordEndByteOffset, identity, semanticItemId: boundary.itemId,
      canonicalText: boundary.text };
    const existing = window.entries.get(identity);
    if (existing) {
      if (ticket?.digest !== existing.ticket.digest) return { handled: true, status: 'wrong-source' };
      if (!existing.receipt.canonicalText && existing.admission === 'no-state') existing.receipt = receipt;
      deliver(window, existing); return { handled: true, status: existing.admission };
    }
    const byteCount = ticket ? ticket.end - ticket.start : 0;
    const candidateBytes = boundary.recordEndByteOffset - boundary.recordByteOffset;
    const holdReason = !boundary.itemId ? 'item-id-missing'
      : !ticket ? (candidateBytes > MAX_CANONICAL_PRESENTATION_BYTES ? 'record-too-large' : 'source-ticket-missing')
      : ticket.start !== boundary.recordByteOffset || ticket.end !== boundary.recordEndByteOffset
        || ticket.filePath !== scope.filePath || byteCount <= 0 ? 'record-boundary-mismatch'
      : ticket.isCurrent() !== true ? 'source-ticket-revoked'
      : window.entries.size >= maxEntries ? 'entry-budget'
      : window.bytes + byteCount > maxBytes ? 'byte-budget' : null;
    if (holdReason) {
      // No emergency payload list/LRU/truncation. Existing semantic item owns
      // its text; ACK and presentation retirement remain separate facts.
      const result = getController().admitCodexCanonicalReceipt({ ...receipt,
        receiptToken: {}, presentationHeld: true, scope: receiptScope(scope) });
      note('HOLD', window, { reason: holdReason, identity, item: boundary.itemId,
        candidateBytes, entryLimit: maxEntries, byteLimit: maxBytes });
      return { handled: true, status: result.status };
    }
    const entry = { identity, token: {}, ticket, bytes: byteCount, receipt,
      record: structuredClone(detail.message), admission: null, ack: null, state: 'pending' };
    window.entries.set(identity, entry); window.bytes += byteCount;
    note('CAPTURE', window, { identity, item: boundary.itemId,
      range: `${ticket.start}..${ticket.end}`, sourceFile: ticket.fileIdentity });
    deliver(window, entry);
    return { handled: true, status: entry.admission };
  };
  const ack = detail => {
    const window = windows.get(detail.tabId);
    if (!window || !valid(window)) return;
    for (const entry of window.entries.values()) {
      if (entry.token !== detail.receiptToken || entry.identity !== detail.identity
        || detail.itemId !== entry.receipt.semanticItemId || detail.turnId !== window.scope.turnId
        || detail.instanceId !== window.scope.sourceId
        || detail.lifecycleGeneration !== window.scope.lifecycleGeneration) continue;
      entry.ack = detail; entry.admission = 'acked';
      window.dirty = true;
      if (detail.presentationPublished) entry.state = 'published';
      freePublishedPayload(window, entry);
      note('ACK', window, { identity: entry.identity, item: detail.itemId, preview: detail.previewId });
    }
  };
  const drain = tabId => {
    const window = windows.get(tabId);
    if (!window || !canPublish(window)) return Promise.resolve(false);
    if (window.flight) return window.flight;
    window.dirty = false;
    window.flight = (async () => {
      let published = false;
      for (const entry of window.entries.values()) {
        if (!canPublish(window)) break;
        if (entry.state !== 'pending') continue;
        if (entry.ticket.isCurrent() !== true) {
          note('HOLD', window, { identity: entry.identity, reason: 'source-ticket-revoked' }); continue;
        }
        if (!entry.ack || entry.state !== 'pending') continue;
        let proof;
        try { proof = await verify(entry.ticket, () => canPublish(window)); }
        catch (error) { proof = { ok: false, reason: error.code || 'point-verification-failed' }; }
        if (!canPublish(window)) break;
        if (entry.ticket.isCurrent() !== true) {
          note('HOLD', window, { identity: entry.identity, reason: 'source-ticket-revoked' }); continue;
        }
        if (!proof.ok) { note('HOLD', window, { identity: entry.identity, reason: proof.reason }); continue; }
        if (entry.state !== 'pending') continue; // normal publication won during verification
        entry.state = 'publishing';
        entry.dispatchToken = {};
        try {
          const dispatched = publish(window.scope.watcher, entry.record, entry.identity, entry.ticket.digest, entry.dispatchToken);
          if (dispatched === false) throw new Error('dispatch-not-applied');
          entry.state = 'published'; published = true;
          getController().releaseCodexCanonicalPresentation({ tabId, identity: entry.identity,
            itemId: entry.receipt.semanticItemId, scope: receiptScope(window.scope) });
          freePublishedPayload(window, entry);
          note('PUBLISH', window, { identity: entry.identity });
        } catch (error) {
          // Dispatch outcome is unknown; don't automatically send a second
          // row. The retained text remains at the original semantic owner.
          note('HOLD', window, { identity: entry.identity, reason: 'dispatch-unknown' });
        }
      }
      return published;
    })().finally(() => {
      window.flight = null;
      // A real ACK arrived during this flight. Coalesce that signal; do not
      // turn a held proof failure into a timer/polling retry.
      if (window.dirty && canPublish(window)) void drain(tabId);
    });
    return window.flight;
  };
  const afterMutation = (tabId, signal = '') => {
    const window = windows.get(tabId);
    if (!window) return;
    const boundary = ['turn_started', 'canonical', 'scope'].includes(signal);
    if (!boundary && !window.needsAdmission && (!window.released || !window.dirty)) return;
    if (!valid(window)) return;
    if (window.needsAdmission) {
      for (const entry of window.entries.values()) if (entry.admission === 'no-state') deliver(window, entry);
      window.needsAdmission = [...window.entries.values()].some(entry => entry.admission === 'no-state');
    }
    if (window.released && window.dirty) void drain(tabId);
  };
  const bindRelease = state => {
    const window = windows.get(state.tabId), scope = getScope(state.tabId);
    // Only the existing prepareSourceProofReplay transition gets to rebind
    // this capture window; arbitrary later suppression generations do not.
    if (!window || !sameScope(window.scope, scope) || window.invalidated) return;
    if (window.bound || scope.generation !== window.generation + 1) {
      invalidate(state.tabId, 'release-generation-mismatch'); return;
    }
    window.bound = true;
    window.generation = scope.generation;
  };
  const release = async (state, releaseProof) => {
    const window = windowFor(getScope(state.tabId));
    if (!window || !releaseProof?.released) return false;
    window.released = true;
    const scope = getScope(state.tabId);
    note('RELEASE', window, { kind: releaseProof.kind, targetOffset: releaseProof.targetOffset,
      publicAllowed: scope?.publicAllowed === true, held: scope?.held === true,
      scanning: scope?.scanning === true, failed: window.failed });
    afterMutation(state.tabId);
    return drain(state.tabId);
  };
  const scanFailed = state => {
    const window = windows.get(state.tabId);
    if (window?.scope.watcher === state) { window.failed = true; note('HOLD', window, { reason: 'scan-failed' }); }
  };
  const scanCommitted = (state, read) => {
    const window = windows.get(state.tabId);
    if (window?.scope.watcher !== state || !read?.sourceProof || !(read.stats?.bytes > 0)) return;
    // An empty retry is NOT recovery from a prior failed final validation.
    // A later real read plus point verification may establish a fresh proof.
    window.failed = false;
    window.dirty = true; // coalesce an actual source wake that arrives during point verification
  };
  const beforePublication = (state, record, identity, dispatchToken = null) => {
    const window = windowFor(getScope(state.tabId));
    const entry = window?.entries.get(identity);
    if (!entry) return true;
    const hash = record.__canonicalRawDigest;
    if (!dispatchToken && (!entry.ticket.isCurrent() || hash !== entry.ticket.digest)) {
      // A fresh ordinary source publication does not inherit an older source's
      // tombstone. Its existing reader/publisher still owns its own admission.
      invalidate(state.tabId, 'ordinary-source-replaced'); return true;
    }
    if (!hash || hash !== entry.ticket.digest) return false;
    if (entry.state === 'published' || entry.dispatchStarted) return false;
    // The continuation itself reserved publishing before entering the shared
    // fanout. No recursive controller callback runs a drain during mutation.
    if (entry.state === 'publishing' && entry.dispatchToken !== dispatchToken) return false;
    entry.state = 'publishing'; entry.dispatchStarted = true;
    return true;
  };
  const didPublish = (state, record, identity) => {
    const window = windowFor(getScope(state.tabId));
    const entry = window?.entries.get(identity);
    if (entry) {
      entry.state = 'published'; freePublishedPayload(window, entry);
    }
    const scope = getScope(state.tabId);
    getController().releaseCodexCanonicalPresentation({ tabId: state.tabId, identity,
      itemId: record?.payload?.id, scope: receiptScope(scope || {}) });
  };
  return { capture, ack, afterMutation, drain, release, bindRelease, scanFailed, scanCommitted, invalidate,
    beforePublication, didPublish,
    snapshot: tabId => { const w = windows.get(tabId); return w ? { entries: w.entries.size,
      bytes: w.bytes, failed: w.failed, released: w.released } : null; } };
}

module.exports = { createCodexCanonicalPresentation, MAX_CANONICAL_PRESENTATION_ENTRIES,
  MAX_CANONICAL_PRESENTATION_BYTES };
