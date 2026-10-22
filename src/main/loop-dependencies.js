'use strict';

// Owns Loop waiting, never provider lifecycle, input or Research state.
const crypto = require('node:crypto');
const { loopEpoch, loopPromptMode, normalizeLoopDependencies, sameLoopTurn } = require('../shared/loop-dependencies.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), { code, statusCode: 409 });
const ENDED = new Set(['released', 'cancelled', 'superseded']);

function createLoopDependencies({ read, write, readQueue, readState, readInspection,
  readDependency, readLoopReceipt, readResult, changed = () => {}, now = Date.now }) {
  let saved = null, poisoned = false, disposed = false;
  const inflight = new Map(), trailing = new Set();
  function load() {
    if (disposed) throw fail('loop_wait_owner_stopped');
    if (poisoned) throw fail('loop_wait_persistence_unknown');
    if (!saved) {
      try {
        const value = read();
        if (value != null && (value.version !== 1 || !Array.isArray(value.entries)
          || !Number.isSafeInteger(value.revision) || value.revision < 0)) throw fail('loop_wait_journal_invalid');
        saved = value ? copy(value) : { version: 1, revision: 0, entries: [] };
      } catch (error) { poisoned = true; throw error; }
    }
    return saved;
  }
  function commit(entry, patch) {
    if (readInspection && entry.source && patch.state !== 'superseded') {
      const owner = readInspection(entry.source.tabId);
      if (owner?.known !== true || owner.sessionId !== entry.source.sessionId || owner.toolType !== entry.source.provider) {
        throw fail('loop_wait_source_changed');
      }
      if (patch.state === 'intent') {
        const actual = owner.executionContext || owner.currentSubject?.targetExecutionContext;
        const expected = entry.subject.targetExecutionContext;
        if (owner.busy !== true || !sameLoopTurn(actual, expected)
          || ['generation', 'processId'].some(key => (actual[key] ?? null) !== (expected[key] ?? null))) throw fail('loop_wait_source_changed');
      }
    }
    const next = copy(load()), row = next.entries.find(value => value.id === entry.id);
    if (row) Object.assign(row, copy(patch)); else next.entries.push(copy({ ...entry, ...patch }));
    next.revision++;
    try {
      const receipt = write(next);
      if (receipt?.success === false || receipt?.then) throw fail('loop_wait_persistence_unknown');
    } catch (error) { poisoned = true; throw error; }
    saved = next;
    const current = next.entries.find(value => value.id === entry.id);
    changed(copy(current), next.revision); return current;
  }
  const find = id => load().entries.find(entry => entry.id === id);
  function current(entry) {
    const q = readQueue(entry.source.tabId);
    return q?.loopPromptEnabled === true && loopPromptMode(q) === 'own-turn' && loopEpoch(q) === entry.epoch;
  }
  async function request({ tabId, dependencies, reason, reviewToken }) {
    const refs = normalizeLoopDependencies(dependencies);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw fail('loop_wait_reason_required');
    if (typeof reviewToken !== 'string' || !reviewToken || reviewToken.length > 4096) throw fail('loop_review_token_required');
    const q = readQueue(tabId), state = await readState(tabId), subject = state?.currentSubject;
    if (!q?.loopPromptEnabled || loopPromptMode(q) !== 'own-turn' || !loopEpoch(q) || state?.known !== true || state.busy !== true
      || state.processStatus !== 'found' || state.transitioning || !subject
      || state.loopTaskProtocol?.eligible !== true || state.loopTaskProtocol.intentId) throw fail('completion_protocol_not_active');
    const context = subject.targetExecutionContext;
    if (!context || context.sessionId !== state.sessionId || context.provider !== state.toolType) throw fail('loop_wait_source_unknown');
    const id = 'loop-wait:' + hash([tabId, loopEpoch(q), subject]);
    const existing = find(id), signature = hash([refs, reason.trim()]);
    if (existing) {
      if (existing.receipt.reviewToken !== reviewToken) throw fail('loop_review_token_mismatch');
      if (existing.signature !== signature) throw fail('loop_wait_intent_conflict');
      return copy(existing);
    }
    const facts = [];
    for (const ref of refs) {
      const fact = await readDependency(ref, { tabId, sessionId: state.sessionId, provider: state.toolType });
      if (fact?.known !== true || !fact.identity) throw fail(fact?.code || 'loop_dependency_unknown');
      facts.push({ ...ref, identity: fact.identity });
    }
    const after = await readState(tabId);
    if (after?.known !== true || after.busy !== true || after.loopTaskProtocol?.eligible !== true
      || after.loopTaskProtocol.intentId || !after.currentSubject || hash(after.currentSubject) !== hash(subject)
      || loopPromptMode(readQueue(tabId)) !== 'own-turn' || loopEpoch(readQueue(tabId)) !== loopEpoch(q)) throw fail('loop_wait_source_changed');
    const receipt = await readLoopReceipt({ tabId, subject });
    if (!receipt?.operationKey || !receipt.attemptId || (!receipt.userUuid && !receipt.sourceIdentity)
      || receipt.sessionId !== state.sessionId || receipt.provider !== state.toolType
      || !sameLoopTurn(receipt.executionContext, context)
      || ['generation', 'processId'].some(key => receipt.executionContext[key] !== context[key])) throw fail('loop_wait_loop_receipt_unproven');
    if (receipt.reviewToken !== reviewToken) throw fail('loop_review_token_mismatch');
    const finalSource = await readState(tabId);
    if (finalSource?.known !== true || finalSource.busy !== true || finalSource.loopTaskProtocol?.eligible !== true
      || finalSource.loopTaskProtocol.intentId || !finalSource.currentSubject || hash(finalSource.currentSubject) !== hash(subject)
      || loopPromptMode(readQueue(tabId)) !== 'own-turn' || loopEpoch(readQueue(tabId)) !== loopEpoch(q)) throw fail('loop_wait_source_changed');
    const raced = find(id);
    if (raced) {
      if (raced.signature !== signature) throw fail('loop_wait_intent_conflict');
      return copy(raced);
    }
    // New Loop work supersedes its old waits, retaining their exact references.
    for (const old of [...load().entries]) if (old.source.tabId === tabId && !ENDED.has(old.state)) {
      commit(old, { state: 'superseded', supersededBy: id });
    }
    return copy(commit({ id, signature, epoch: loopEpoch(q), source: { tabId,
      sessionId: state.sessionId, provider: state.toolType, cwd: state.cwd }, subject,
      receipt, dependencies: facts, reason: reason.trim(), createdAt: now() }, { state: 'intent' }));
  }

  function exactNatural(result, receipt, context) {
    return result?.found === true && result.complete === true && result.sourceVerified === true
      && !result.error && (!result.terminalOutcomeReason
        || ['task_complete', 'done', 'completed', 'end_turn'].includes(result.terminalOutcomeReason))
      && (receipt.userUuid ? result.userUuid === receipt.userUuid : receipt.sourceIdentity
        && (result.sourceIdentity === receipt.sourceIdentity || result.sourceIdentityAliases?.includes(receipt.sourceIdentity)))
      && (context?.provider !== 'codex' || sameLoopTurn(result.executionContext, context));
  }
  async function reconcileEntry(id) {
    let entry = find(id);
    if (!entry || ENDED.has(entry.state)) return;
    if (!current(entry)) { commit(entry, { state: 'superseded' }); return; }
    const owner = await readState(entry.source.tabId);
    if (owner?.known !== true || owner.sessionId !== entry.source.sessionId || owner.toolType !== entry.source.provider) return;
    if (entry.state === 'intent') {
      const result = await readResult(entry.source, entry.receipt, entry.subject.targetExecutionContext);
      entry = find(id);
      if (!entry || entry.state !== 'intent' || !current(entry)) return;
      if (!exactNatural(result, entry.receipt, entry.subject.targetExecutionContext)) {
        if (result?.sourceVerified === true && result.proofDefinitive === true && result.complete !== true) {
          commit(entry, { state: 'cancelled', disposition: result.errorCode || result.terminalOutcomeReason || 'abnormal-turn' });
        }
        return;
      }
      entry = commit(entry, { state: 'waiting', naturalProof: { userUuid: result.userUuid,
        executionContext: result.executionContext || entry.subject.targetExecutionContext } });
    }
    for (const dependency of entry.dependencies) {
      const fact = await readDependency(dependency, entry.source);
      const latest = find(id);
      if (!latest || ENDED.has(latest.state) || !current(latest)) return;
      entry = latest;
      if (fact?.known !== true || fact.identity !== dependency.identity || fact.actionable !== true) continue;
      // Ordinary callback wins. A receipt is not a completed continuation.
      if (fact.delivery === 'callback') {
        if (!fact.receipt) return;
        const result = await readResult(entry.source, fact.receipt, fact.receipt.executionContext);
        const final = find(id);
        if (!final || ENDED.has(final.state) || !current(final)) return;
        if (exactNatural(result, fact.receipt, fact.receipt.executionContext)) {
          commit(final, { state: 'released', dependency: { kind: dependency.kind, id: dependency.id },
            continuationProof: { userUuid: result.userUuid, executionContext: result.executionContext,
              attemptId: fact.receipt.attemptId, operationKey: fact.receipt.operationKey } });
        }
        return;
      }
      // Non-notifying/cancelled dependency: one normal Loop message carries
      // the exact ready reference. No fake natural completion is published.
      if (entry.state !== 'ready') commit(entry, { state: 'ready', readyDependency: {
        kind: dependency.kind, id: dependency.id, disposition: fact.disposition || 'ready' } });
      return;
    }
  }
  async function reconcile(tabId) {
    const key = tabId || '*';
    if (inflight.has(key)) { trailing.add(key); return inflight.get(key); }
    const task = (async () => {
      for (const entry of [...load().entries]) if (!tabId || entry.source.tabId === tabId) await reconcileEntry(entry.id);
    })().finally(() => {
      inflight.delete(key);
      if (trailing.delete(key)) void reconcile(tabId).catch(() => {});
    });
    inflight.set(key, task); return task;
  }
  function snapshot() { return { ...copy(load()), known: true }; }
  function blocks(tabId, cause = null) {
    return load().entries.some(entry => entry.source.tabId === tabId && current(entry) && !ENDED.has(entry.state)
      && entry.state !== 'ready' && (!cause || sameLoopTurn(entry.subject.targetExecutionContext, cause)));
  }
  function completionBlocked(tabId) {
    return load().entries.some(entry => entry.source.tabId === tabId && current(entry)
      && !ENDED.has(entry.state) && entry.state !== 'ready');
  }
  function readyWake(tabId) {
    const entry = [...load().entries].reverse().find(value => value.source.tabId === tabId
      && current(value) && value.state === 'ready' && value.naturalProof);
    return entry ? copy(entry) : null;
  }
  return { request, reconcile, snapshot, blocks, completionBlocked, readyWake,
    dispose() { disposed = true; trailing.clear(); } };
}

module.exports = { createLoopDependencies };
