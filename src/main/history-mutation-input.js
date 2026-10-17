'use strict';

// One Main admission fence shared by desktop History, saved-history and the
// existing Send FIFO. This is NOT a delivery receipt, process/readiness proof,
// second queue, or the (non-reentrant) launch mutex.
const { randomUUID } = require('node:crypto');
const refuse = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };

function createHistoryMutationInputGate({ capture, readSendBusy = () => false, wake = () => {},
  readInputBoundary = null, journal = null, log = console } = {}) {
  const mutations = new Map(), sends = new Map();
  // Persist only the existence of the admission hold, NEVER a token, process
  // proof, prompt, queue item or permission to resume an interrupted mutation.
  const persist = (rows = mutations.values()) => journal?.write({ version: 1,
    reservations: [...rows].map(({ tabId, operationId, toolType, sessionId }) => ({
      tabId, operationId, toolType, sessionId,
    })) });
  const saved = journal?.read();
  if (saved != null) {
    if (saved.version !== 1 || !Array.isArray(saved.reservations)) refuse('history_input_journal_invalid');
    for (const row of saved.reservations) {
      if (!row?.tabId || !row.operationId || !['claude', 'codex'].includes(row.toolType)
        || mutations.has(row.tabId)) refuse('history_input_journal_invalid');
      mutations.set(row.tabId, { ...row, token: null, owner: null, pending: 0,
        closing: true, recovered: true });
    }
  }
  const release = (lease, reason) => {
    if (mutations.get(lease.tabId) !== lease || lease.pending) return false;
    // A storage error leaves the hold intact, including on a subsequent boot.
    persist([...mutations.values()].filter(item => item !== lease));
    mutations.delete(lease.tabId);
    log.log('[HistoryInput] released tab=' + String(lease.tabId).slice(-12)
      + ' operation=' + lease.operationId + ' reason=' + reason);
    // Wake/publication failure cannot turn a completed rewrite into failure.
    try { wake(lease.tabId); }
    catch (error) { log.warn?.('[HistoryInput] FIFO wake failed: ' + error.message); }
    return true;
  };
  const waitingForInput = lease => lease.closing && !lease.pending && !lease.cancelled
    && (typeof readInputBoundary === 'function' || lease.resuming || lease.recovered);
  const notify = tabId => {
    const lease = mutations.get(tabId);
    if (!lease || !waitingForInput(lease) || typeof readInputBoundary !== 'function') return Promise.resolve(false);
    // A wake is not a revocation. Repeated busy/bridge traffic must not require
    // a quiet event window before steering. The reader's isCurrent predicate
    // validates owner AND readiness; dirty only requests another read on miss.
    if (lease.observation) { lease.observationDirty = true; return lease.observation; }
    let observedBoundary;
    const work = Promise.resolve().then(() => readInputBoundary(tabId)).then(boundary => {
      observedBoundary = boundary;
      if (mutations.get(tabId) !== lease || !waitingForInput(lease)
        || boundary?.known !== true
        || boundary.ownerStable !== true || typeof boundary.isCurrent !== 'function'
        || boundary.isCurrent() !== true) return false;
      // Input readiness is NOT turn-idle: a busy process may accept steering.
      // Proven inactive is a separate release reason, preserving ordinary
      // auto-start/first Send. Starting/unknown/failed lookup grant neither.
      const ready = boundary.processStatus === 'found' && boundary.inputReady === true;
      const inactive = boundary.processStatus === 'absent' && boundary.status === 'inactive';
      if (!ready && !inactive) return false;
      return release(lease, ready ? 'current-input-ready' : 'current-process-absent');
    }).catch(error => {
      log.warn?.('[HistoryInput] input observation retained tab=' + String(tabId).slice(-12)
        + ' reason=' + (error.code || error.message));
      return false;
    }).finally(() => {
      if (lease.observation === work) lease.observation = null;
      if (lease.observationDirty) {
        lease.observationDirty = false;
        // A coherent read can itself publish unchanged not-ready status. That
        // is not a new observation request: recursively rereading would spin
        // the process reader while startup is pending. Recheck only an actual
        // supersession of the returned boundary. Errors stay unknown until a
        // fresh authority event; they do not create a polling loop.
        if (mutations.get(tabId) === lease && waitingForInput(lease)
          && typeof observedBoundary?.isCurrent === 'function'
          && observedBoundary.isCurrent() !== true) void notify(tabId);
      }
    });
    lease.observation = work;
    return work;
  };
  const scope = lease => {
    const now = capture?.(lease.tabId);
    const ownWriter = lease.resuming && lease.launchId && now?.inputOwnerLaunchId === lease.launchId
      && now.runSeq === lease.launchRunSeq;
    if (!now?.terminalToken || now.terminalToken !== lease.scope.terminalToken
      || now.projectId !== lease.scope.projectId || now.cwd !== lease.scope.cwd
      || now.toolType !== lease.toolType || now.sessionId !== lease.sessionId && !ownWriter
      || lease.launchId && (now.runSeq !== lease.launchRunSeq || now.inputOwnerLaunchId !== lease.launchId)
      || !lease.resuming && (now.runSeq !== lease.scope.runSeq
        || now.lifecycleGeneration !== lease.scope.lifecycleGeneration)
      || !lease.launchId && now.inputRevision !== lease.scope.inputRevision) {
      refuse('history_input_owner_changed');
    }
    return now;
  };
  const match = proof => {
    const lease = mutations.get(proof?.tabId);
    if (!lease || !lease.token || !proof?.token || proof.token !== lease.token || proof?.operationId !== lease.operationId) {
      refuse('history_input_reservation_changed');
    }
    return lease;
  };
  const drain = lease => {
    if (!lease.closing || lease.pending || mutations.get(lease.tabId) !== lease) return;
    if (waitingForInput(lease)) { void notify(lease.tabId); return; }
    try { release(lease, lease.cancelled ? 'manual-stop' : 'mutation-settled-without-resume'); }
    catch (error) { log.warn?.('[HistoryInput] release retained: ' + error.message); }
  };
  const proofOf = lease => ({ version: 1, tabId: lease.tabId, operationId: lease.operationId, token: lease.token });
  return {
    reserve({ tabId, operationId, toolType, sessionId, owner = null }) {
      if (!tabId || !operationId || !['claude', 'codex'].includes(toolType) || !sessionId) refuse('history_input_identity_required');
      const old = mutations.get(tabId);
      if (old) {
        if (old.operationId !== operationId || old.owner !== owner || old.closing) refuse('history_input_mutation_pending');
        scope(old);
        return proofOf(old);
      }
      // An executing Send or unresolved physical slot is not no-write proof.
      // Refuse BEFORE Stop, without cancelling/releasing its existing receipt.
      if (sends.has(tabId) || readSendBusy(tabId) !== false) refuse('history_input_send_pending');
      const initial = capture?.(tabId);
      if (!initial?.terminalToken || initial.toolType !== toolType || initial.sessionId !== sessionId
        || !initial.projectId || !initial.cwd || initial.stopping) refuse('history_input_owner_changed');
      const lease = { tabId, operationId, toolType, sessionId, owner, scope: initial,
        token: randomUUID(), pending: 0, closing: false };
      persist([...mutations.values(), lease]);
      mutations.set(tabId, lease); // Synchronous, durable before the first read/Stop await.
      log.log('[HistoryInput] reserved tab=' + String(tabId).slice(-12) + ' operation=' + operationId);
      return proofOf(lease);
    },
    held: tabId => mutations.has(tabId),
    notify,
    read(tabId) {
      const lease = mutations.get(tabId);
      return lease ? { pending: true, operationId: lease.operationId, toolType: lease.toolType,
        phase: waitingForInput(lease) ? 'awaiting-input' : lease.closing ? 'draining' : 'mutation' } : null;
    },
    claimSend(tabId) {
      if (mutations.has(tabId)) return null;
      const token = {};
      const owners = sends.get(tabId) || new Set();
      owners.add(token); sends.set(tabId, owners);
      let done = false;
      return () => {
        if (done) return;
        done = true; owners.delete(token);
        if (!owners.size && sends.get(tabId) === owners) sends.delete(tabId);
      };
    },
    assert(tabId, proof, { toolType, sessionId, action = 'resume' } = {}) {
      if (!mutations.has(tabId)) {
        if (proof) refuse('history_input_reservation_changed');
        return;
      }
      // A settled hold is passive. Explicit manual Resume may use the existing
      // launch/shell guards; queued Sends still cannot claim a dispatch slot.
      const current = mutations.get(tabId);
      if (!proof && current.closing && !current.pending && action === 'resume') return;
      if (!proof) refuse('history_input_mutation_pending');
      const lease = match(proof);
      if (tabId !== lease.tabId || lease.closing) refuse('history_input_reservation_changed');
      scope(lease);
      if (toolType && toolType !== lease.toolType) refuse('history_input_owner_changed');
      if (action === 'send' || action === 'resume' && sessionId !== lease.sessionId) refuse('history_input_resume_target_changed');
    },
    bound(proof, sessionId) {
      const lease = match(proof);
      if (lease.closing) refuse('history_input_reservation_changed');
      // Called only inside the existing successful binding CAS callback.
      lease.sessionId = sessionId || null;
      scope(lease);
    },
    authorizeResume(proof, request = {}) {
      if (!proof) return;
      const lease = match(proof);
      if (lease.closing || lease.resuming) refuse('history_input_resume_already_claimed');
      if (lease.pending) refuse('history_input_io_pending');
      scope(lease);
      if (request.command !== lease.toolType + '-c' || request.sessionId !== lease.sessionId
        || request.prompt || request.contextFork || request.sendOperationKey || request.sendAttemptId) {
        refuse('history_input_resume_target_changed');
      }
      // From here the SAME launch's ordinary physical/run/input/fence guards
      // validate every awaited step. A changed input before this claim fails.
      lease.resuming = true;
    },
    claimLaunch(proof, launchId, runSeq) {
      if (!proof) return;
      const lease = match(proof);
      if (!lease.resuming || lease.closing || !launchId || !Number.isSafeInteger(runSeq)
        || lease.launchId && (lease.launchId !== launchId || lease.launchRunSeq !== runSeq)) refuse('history_input_launch_changed');
      scope(lease); lease.launchId = launchId; lease.launchRunSeq = runSeq;
    },
    async run(proof, body) {
      if (!proof) return body();
      const lease = match(proof);
      if (lease.closing) refuse('history_input_reservation_changed');
      scope(lease); lease.pending++;
      try { return await body(); }
      finally { lease.pending--; drain(lease); }
    },
    finish(proof, owner) {
      const lease = match(proof);
      if (owner !== undefined && owner !== lease.owner) refuse('history_input_reservation_owner_changed');
      lease.closing = true; drain(lease);
    },
    revokeOwner(owner) {
      for (const lease of mutations.values()) if (lease.owner === owner) {
        lease.closing = true; drain(lease);
      }
    },
    cancel(tabId) {
      const lease = mutations.get(tabId);
      if (lease) { lease.cancelled = true; lease.closing = true; drain(lease); }
    },
  };
}

module.exports = { createHistoryMutationInputGate };
