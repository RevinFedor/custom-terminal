'use strict';

// Current applicability is NOT a property of an immutable history receipt.
// This small durable checkpoint follows the existing main input/launch owners;
// it does not launch, stop, read transcripts, or execute a send.
const crypto = require('node:crypto');
const { sameExecutionScope } = require('../shared/workflow-organization.cjs');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409,
  success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false }); };
const key = tabId => 'conversation-owner.v1:' + tabId;

class ConversationOwners {
  constructor({ db, capture, publish = () => {}, instanceId = crypto.randomUUID() }) {
    Object.assign(this, { db, capture, publish, instanceId });
  }

  stored(tabId) { return this.db.getAppState(key(tabId)); }
  observation(tabId) {
    try {
      const value = this.capture(tabId);
      if (!value || value.known !== true || !['claude', 'codex'].includes(value.provider)) return null;
      return clone(value);
    } catch { return null; }
  }
  write(tabId, record, { publish = true } = {}) {
    const old = this.stored(tabId);
    const next = { ...record, epoch: old?.epoch || crypto.randomUUID(),
      revision: Number(old?.revision || 0) + 1 };
    this.db.setAppState(key(tabId), next);
    console.log('[ConversationOwner] tab=' + String(tabId).slice(-12) + ' revision=' + next.revision
      + ' binding=' + (next.binding?.state || 'unknown') + ' reason=' + (next.reason || '-')
      + ' checkpoint=' + (next.checkpoint?.operationId || '-'));
    if (publish) this.announce(tabId, next);
    return next;
  }
  announce(tabId, record = this.stored(tabId)) {
    if (!record) return;
    try { this.publish(tabId, this.public(record)); }
    catch (error) { console.warn('[ConversationOwner] publication failed:', error.message); }
  }
  public(record, known = record?.observationKnown === true) {
    return { version: 1, ownerToken: record?.token || null,
      ownerOrder: record ? { epoch: record.epoch, revision: record.revision } : null,
      currentBinding: known && !record?.transition && record?.binding ? clone(record.binding) : { state: 'unknown' } };
  }
  binding(observation, previous = null) {
    if (observation.sessionId) return { state: 'bound', provider: observation.provider, sessionId: observation.sessionId };
    // Null is only a negative observation. Only an exact committed clear makes
    // it a durable known-empty conversation, never an inactive process.
    return previous?.state === 'none' && previous.provider === observation.provider
      ? previous : { state: 'unknown' };
  }
  invalidate(tabId, reason, observation = this.observation(tabId)) {
    const old = this.stored(tabId);
    if (!old) return null;
    const binding = observation ? this.binding(observation, reason === 'owner-changed' ? null : old.binding) : old.binding;
    return this.write(tabId, { ...old, token: crypto.randomUUID(), checkpoint: null, send: null, transition: null,
      binding, scope: observation, observationKnown: !!observation, reason });
  }
  noteInput(tabId, request = null) {
    const old = this.stored(tabId);
    if (!old?.checkpoint && !old?.send) return; // One tombstone, not one SQL write per key.
    if (request && this.matchesSend(old, request)) return;
    this.invalidate(tabId, 'later-input');
  }
  matchesSend(record, request) {
    return !!record?.send && record.send.instanceId === this.instanceId
      && record.send.operationKey === request?.sendOperationKey
      && record.send.attemptId === request?.sendAttemptId;
  }
  sameLaunch(a, b) {
    return !!a?.launchId && a.launchId === b?.launchId && a.instanceId === b?.instanceId
      && a.terminalId === b?.terminalId && a.runSeq === b?.runSeq;
  }
  current(tabId) {
    let record = this.stored(tabId);
    const now = this.observation(tabId);
    if (!record) {
      record = this.write(tabId, { token: crypto.randomUUID(), checkpoint: null, send: null, basisKnown: false,
        binding: now ? this.binding(now) : { state: 'unknown' }, scope: now,
        observationKnown: !!now, reason: 'first-observation' }, { publish: false });
    } else if (now) {
      // A synchronous own launch reservation is not yet a proved new owner.
      // Expose unknown during that gap; only the owner's claimed/written hook
      // may carry the checkpoint across it.
      if (record.transition?.instanceId === this.instanceId) return this.public(record, false);
      const bindingChanged = record.binding?.provider && (now.provider !== record.binding.provider
        || (record.binding.sessionId || null) !== (now.sessionId || null));
      const independent = record.scope?.executionScope?.version === 2 || now.executionScope?.version === 2;
      const locationChanged = record.scope && (independent
        ? !sameExecutionScope(record.scope.executionScope,now.executionScope)
        : record.scope.projectId !== now.projectId || record.scope.cwd !== now.cwd);
      const foreignLaunch = !!now.launchId && !this.sameLaunch(record.scope, now);
      // Own Resume may discover a child writer. Main supplies this ONLY from
      // its existing exact current-launch/source proof, never lineage alone.
      const ownAdoption = bindingChanged && !foreignLaunch && !!now.acceptedSourceSessionId
        && now.acceptedSourceSessionId === record.binding?.sessionId;
      const ownFirstBinding = bindingChanged && !foreignLaunch && record.send?.launchWritten === true
        && record.binding?.state === 'none' && record.send.instanceId === this.instanceId;
      if (locationChanged || foreignLaunch || (bindingChanged && !ownAdoption && !ownFirstBinding)) {
        record = this.invalidate(tabId, 'owner-changed', now);
      } else {
        const binding = this.binding(now, record.binding);
        if (!equal(binding, record.binding) || record.observationKnown !== true) {
          record = this.write(tabId, { ...record, binding, scope: now, observationKnown: true,
            reason: ownAdoption ? 'own-resume-adoption' : ownFirstBinding ? 'own-first-binding' : 'observation-known' });
        }
      }
    } else if (record.observationKnown !== false) {
      record = this.write(tabId, { ...record, observationKnown: false, reason: 'observation-unknown' });
    }
    return this.public(record, !!now);
  }

  // Called inside the SAME transaction as binding + operation receipt. Publish
  // only after commit, so a failed SQLite commit cannot leak a positive proof.
  checkpoint(tabId, operation, observation) {
    if (!observation?.known || operation.bindingCommitted !== true) fail('history_owner_checkpoint_unproven');
    const cleared = operation.toolType === 'claude' && operation.fileDeleted === true
      && operation.binding?.applied === true && operation.binding.mode === 'cleared'
      && operation.binding.sessionId === null && operation.activeSessionId === null;
    if (!observation.sessionId && !cleared) fail('history_owner_binding_unproven');
    const token = crypto.randomUUID();
    const record = this.write(tabId, { token, checkpoint: { operationId: operation.operationId, token }, send: null, basisKnown: true,
      binding: observation.sessionId ? this.binding(observation)
        : { state: 'none', provider: operation.toolType }, scope: clone(observation),
      observationKnown: true, reason: 'history-binding-committed' }, { publish: false });
    return { version: 1, token, epoch: record.epoch };
  }
  carryResume(tabId, operationId, checkpoint, observation) {
    const old = this.stored(tabId);
    if (!observation?.known || old?.checkpoint?.operationId !== operationId
      || old.token !== checkpoint?.token || (checkpoint.epoch && checkpoint.epoch !== old.epoch)) fail('history_owner_checkpoint_superseded');
    this.write(tabId, { ...old, transition: null, scope: clone(observation), observationKnown: true });
  }
  prepareResume(tabId, operationId, checkpoint) {
    this.current(tabId);
    const old = this.stored(tabId);
    if (old?.checkpoint?.operationId !== operationId || old.token !== checkpoint?.token
      || (checkpoint.epoch && checkpoint.epoch !== old.epoch)
      || !old.observationKnown) fail('history_owner_checkpoint_superseded');
    this.write(tabId, { ...old, transition: { instanceId: this.instanceId, kind: 'history-resume' } });
  }
  finishOperation(tabId, operationId) {
    const old = this.stored(tabId);
    if (old?.checkpoint?.operationId !== operationId || old.transition?.kind !== 'history-resume') return;
    this.write(tabId, { ...old, transition: null }, { publish: false });
    this.current(tabId);
    this.announce(tabId);
  }
  applicability(tabId, operation, expectedRevision) {
    if (expectedRevision != null && String(operation.revision) !== String(expectedRevision)) fail('history_operation_revision_changed');
    const current = this.current(tabId);
    const record = this.stored(tabId);
    const checkpoint = operation.ownerCheckpoint;
    let verdict = 'unknown';
    // v1 token-only checkpoints remain valid historical facts. An explicitly
    // different epoch is NOT permission to reuse a checkpoint in a new store.
    const sameEpoch = !checkpoint?.epoch || checkpoint.epoch === record?.epoch;
    if (sameEpoch && checkpoint?.token && record?.basisKnown === true && record.token !== checkpoint.token) verdict = 'superseded';
    else if (sameEpoch && checkpoint?.token === record?.token && current.currentBinding.state !== 'unknown'
      && record.checkpoint?.token === checkpoint?.token
      && record.checkpoint?.operationId === operation.operationId) verdict = 'applicable';
    return { operationId: operation.operationId, operationRevision: operation.revision,
      applicability: { verdict, ...current } };
  }
  assertNone(tabId, expected, request = null) {
    this.current(tabId);
    const record = this.stored(tabId);
    if (request && this.matchesSend(record, request)
      && record.send.expectedOwnerToken === expected.ownerToken && record.observationKnown) return record;
    if (record?.token !== expected.ownerToken || record?.observationKnown !== true
      || record?.binding?.state !== 'none' || record.binding.provider !== expected.toolType) fail('agent_send_binding_changed');
    return record;
  }
  claimSend(tabId, expected, request) {
    const old = this.assertNone(tabId, expected, request);
    if (this.matchesSend(old, request)) return this.public(old);
    if (!request?.sendOperationKey || !request?.sendAttemptId) fail('agent_send_owner_attempt_required');
    const next = this.write(tabId, { ...old, token: crypto.randomUUID(), checkpoint: null,
      send: { operationKey: request.sendOperationKey, attemptId: request.sendAttemptId,
        expectedOwnerToken: expected.ownerToken, instanceId: this.instanceId, launchWritten: false },
      reason: 'explicit-send-claimed' });
    return this.public(next);
  }
  beforeLaunch(tabId, expected, request) {
    const old = this.assertNone(tabId, expected, request);
    if (!this.matchesSend(old, request) || old.send.launchWritten || old.send.launchClaimed) fail('agent_send_owner_launch_changed');
    this.write(tabId, { ...old, transition: { instanceId: this.instanceId, kind: 'send-launch' } });
  }
  claimLaunch(tabId, expected, request, observation) {
    const old = this.stored(tabId);
    if (!this.matchesSend(old, request) || old.send.expectedOwnerToken !== expected.ownerToken
      || old.send.launchClaimed || !observation?.known || !observation.launchId) fail('agent_send_owner_launch_changed');
    this.write(tabId, { ...old, transition: null, scope: clone(observation),
      send: { ...old.send, launchClaimed: true }, observationKnown: true });
  }
  launchWritten(tabId, expected, request, observation) {
    const old = this.stored(tabId);
    if (!this.matchesSend(old, request) || old.send.expectedOwnerToken !== expected.ownerToken
      || !old.send.launchClaimed || old.send.launchWritten || !observation?.known
      || !this.sameLaunch(old.scope, observation)) fail('agent_send_owner_launch_changed');
    this.write(tabId, { ...old, transition: null, send: { ...old.send, launchWritten: true }, scope: clone(observation),
      observationKnown: true });
  }
}

module.exports = { ConversationOwners };
