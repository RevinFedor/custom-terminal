'use strict';

// Receipt/authorization adapter, NOT a second Stop -> rewrite -> Resume flow.
// The sole executor remains historyRewriteRewind.ts (desktop/Queue/Inbox).
const crypto = require('node:crypto');
const { historyEntryHasExactIdentity } = require('../shared/history-entry-identity.cjs');
const { saveAuditedPromptPresentation } = require('./history-prompt-presentations');
const PREFIX = 'saved-history-operation.v1:';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const text = value => typeof value === 'string' ? value : '';
const terminal = record => ['completed', 'failed'].includes(record?.state);

function normalizeSavedHistoryRequest(tabId, body = {}) {
  if (!text(tabId) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(text(body.operationId))) fail('history_operation_identity_required');
  if (!['rewind', 'delete'].includes(body.kind)) fail('history_operation_kind_required');
  if (!text(body.expectedSessionId) || !text(body.targetUuid)) fail('history_target_identity_required');
  const toolType = body.toolType || body.provider || 'codex';
  if (!['codex', 'claude'].includes(toolType) || body.provider && body.toolType && body.provider !== body.toolType) fail('history_operation_provider_unsupported');
  if (body.expectedContentRevision != null && typeof body.expectedContentRevision !== 'string') fail('history_revision_invalid');
  if (toolType === 'claude' && !text(body.expectedContentRevision)) fail('history_revision_required');
  if (body.targetEntryRef && (!text(body.targetEntryRef.physicalSessionId)
    || !text(body.targetEntryRef.rawUuid) || !text(body.expectedContentRevision))) {
    fail('history_target_partial_identity');
  }
  if (body.targetEntryRef?.viewOwnerSessionId
    && body.targetEntryRef.viewOwnerSessionId !== body.expectedSessionId) fail('history_operation_session_changed');
  if (body.targetEntryRef?.contentRevision !== undefined
    && (typeof body.targetEntryRef.contentRevision !== 'string'
      || body.targetEntryRef.contentRevision !== body.expectedContentRevision)) fail('history_revision_invalid');
  if (body.repairOfOperationId !== undefined && (!/^[A-Za-z0-9_.:-]{1,160}$/.test(text(body.repairOfOperationId))
    || body.repairOfOperationId === body.operationId || body.kind !== 'rewind' || toolType !== 'codex')) {
    fail('history_repair_selector_invalid');
  }
  return { tabId, operationId: body.operationId, kind: body.kind, toolType,
    expectedSessionId: body.expectedSessionId, targetUuid: body.targetUuid,
    targetSourceIdentity: text(body.targetSourceIdentity) || null,
    targetEntryRef: body.targetEntryRef ? {
      physicalSessionId: body.targetEntryRef.physicalSessionId,
      rawUuid: body.targetEntryRef.rawUuid,
      sourceIdentity: text(body.targetEntryRef.sourceIdentity) || null,
      segmentId: text(body.targetEntryRef.segmentId) || null,
    } : null,
    expectedContentRevision: text(body.expectedContentRevision) || null,
    ...(body.repairOfOperationId !== undefined ? { repairOfOperationId: body.repairOfOperationId } : {}) };
}

function selectSavedHistoryTarget(timeline, request, checkRevision = true) {
  if (timeline?.success !== true) fail(timeline?.lineageReason || timeline?.error || 'history_read_failed');
  const ref = request.targetEntryRef;
  const revision = timeline.contentRevision?.token || timeline.contentRevision || timeline.revision?.token || null;
  if (timeline.composite && (!ref || !request.expectedContentRevision)) fail('history_target_partial_identity');
  if (checkRevision && request.expectedContentRevision && revision !== request.expectedContentRevision) fail('stale_transcript_revision');
  const matches = (timeline.entries || []).filter(entry => entry.uuid === request.targetUuid
    && (!ref || (entry.entryRef?.physicalSessionId || entry.physicalSessionId || entry.sessionId) === ref.physicalSessionId
      && (entry.entryRef?.rawUuid || entry.uuid) === ref.rawUuid
      && (!ref.segmentId || !entry.entryRef || entry.entryRef.segmentId === ref.segmentId)
      && (!ref.sourceIdentity || entry.sourceIdentity === ref.sourceIdentity))
    && (!request.targetSourceIdentity || entry.sourceIdentity === request.targetSourceIdentity));
  if (matches.length !== 1) fail('history_target_not_unique');
  const entry = matches[0];
  if (entry.type !== 'user' || entry.serviceCarrier || entry.isCompactSummary) fail('history_target_not_user_iteration');
  return entry;
}

function targetSnapshot(entry) {
  return { uuid: entry.uuid, text: entry.fullText || entry.text || entry.content || '',
    promptChips: entry.promptChips || [], imagePaths: entry.imagePaths || [],
    sourceIdentity: entry.sourceIdentity || null,
    physicalSessionId: entry.entryRef?.physicalSessionId || entry.physicalSessionId || entry.sessionId || null };
}

class SavedHistoryOperations {
  constructor({ db, transcript, runtime, resolveSession, dispatch, deleteRange, buildTimeline, inspectRepair = null, hashRecords = null, claude = null, broadcast = () => {} }) {
    Object.assign(this, { db, transcript, runtime, resolveSession, dispatch, deleteRange, buildTimeline, inspectRepair, hashRecords, claude, broadcast });
    this.leases = new Map();
  }

  key(tabId, operationId) { return PREFIX + hash([tabId, operationId]); }
  lockKey(tabId) { return PREFIX + 'tab:' + tabId; }
  read(tabId, operationId) {
    const record = this.db.getAppState(this.key(tabId, operationId));
    if (!record) return null;
    return !terminal(record) && !this.leases.has(this.key(tabId, operationId))
      ? { ...record, state: 'outcome-unknown', pending: true, error: record.error || 'history_operation_interrupted' }
      : record;
  }

  save(lease, patch, commitBinding = null) {
    const previousCheckpoint = lease.record.ownerCheckpoint;
    const next = { ...lease.record, ...patch, revision: lease.record.revision + 1, updatedAt: Date.now() };
    const commit = () => {
      commitBinding?.();
      if (patch.bindingCommitted === true && !lease.record.ownerCheckpoint && this.runtime?.owner) {
        next.ownerCheckpoint = this.runtime.owner.checkpoint(next.tabId, next, this.runtime.owner.observation(next.tabId));
      }
      this.db.setAppState(lease.key, next);
    };
    if (commitBinding) {
      if (!this.db.db?.transaction) fail('history_binding_transaction_unavailable');
      this.db.db.transaction(commit)();
    } else commit(); // Persist BEFORE publishing or the next side effect.
    lease.record = next;
    if (next.ownerCheckpoint && next.ownerCheckpoint !== previousCheckpoint) this.runtime?.owner?.announce(next.tabId);
    if (terminal(next)) {
      this.runtime?.owner?.finishOperation(next.tabId, next.operationId);
      if (lease.historyInput) this.runtime.finishInput?.(lease.historyInput);
      this.leases.delete(lease.key);
      // The ingress may release its own cleanup lease. It never executes any
      // provider action here, and a publication error cannot undo the receipt.
      try { lease.onSettled?.(next); } catch (error) {
        console.warn('[SavedHistoryOperation] ingress settlement:', error.message);
      }
    }
    const { tabId, operationId, state, phase, pending, success, historyMutated,
      bindingCommitted, newSessionId, revision, error, resume, toolType, binding, fileDeleted, mutationSessionId, origin } = next;
    this.broadcast(next.tabId, { type: 'saved-history-operation', operation: {
      tabId, operationId, state, phase, pending, success, historyMutated,
      bindingCommitted, newSessionId, revision, error, resume, toolType, binding, fileDeleted, mutationSessionId, origin,
    } });
    console.log('[SavedHistoryOperation] tab=' + String(tabId).slice(-12)
      + ' operation=' + operationId + ' phase=' + phase + ' state=' + state
      + ' mutated=' + !!historyMutated + ' bound=' + !!bindingCommitted);
    return next;
  }

  accept(tabId, body, { origin = null, validateOwner = null, onReserve = null, onSettled = null } = {}) {
    const request = normalizeSavedHistoryRequest(tabId, body);
    if (request.toolType === 'claude' && !this.claude?.loadOperationSource) fail('history_operation_provider_unavailable');
    const key = this.key(tabId, request.operationId);
    const existing = this.read(tabId, request.operationId);
    if (existing) {
      if (hash(existing.request) !== hash(request) || hash(existing.origin || null) !== hash(origin)) fail('history_operation_request_mismatch');
      return { ...existing, idempotent: true };
    }
    if (request.repairOfOperationId) {
      const previous = this.read(tabId, request.repairOfOperationId);
      if (!this.inspectRepair || !this.hashRecords) fail('history_repair_unsupported');
      if (previous?.state !== 'completed' || previous.newSessionId !== request.expectedSessionId
        || previous.targetUuid !== request.targetUuid || previous.toolType !== 'codex' || previous.kind !== 'rewind'
        || previous.historyMutated !== true || previous.bindingCommitted !== true) fail('history_repair_previous_operation_unproven');
    }
    const previousId = this.db.getAppState(this.lockKey(tabId));
    if (previousId && !terminal(this.read(tabId, previousId))) fail('history_operation_pending');
    const record = { ...request, request, ...(origin ? { origin } : {}), state: 'running', phase: 'accepted', pending: true,
      success: false, historyMutated: false, bindingCommitted: false, draft: null,
      revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
    const reserve = () => {
      validateOwner?.();
      this.db.setAppState(key, record);
      this.db.setAppState(this.lockKey(tabId), request.operationId);
      onReserve?.(record);
    };
    const historyInput = this.runtime?.reserveInput?.({ tabId, operationId: request.operationId,
      sessionId: request.expectedSessionId, toolType: request.toolType }) || null;
    try {
      if (onReserve) {
        if (!this.db.db?.transaction) fail('history_binding_transaction_unavailable');
        this.db.db.transaction(reserve)();
      } else reserve();
    } catch (error) {
      if (historyInput) this.runtime.finishInput?.(historyInput);
      throw error;
    }
    // A different accepted history intent owns the next transition already;
    // a late result of the preceding operation must not repopulate its draft.
    // Idempotent reads/replays returned above never enter this path.
    this.runtime?.owner?.noteInput(tabId);
    const lease = { key, record, executing: false, scope: null, mutation: null, validateOwner, onSettled, historyInput };
    this.leases.set(key, lease);
    // Request acceptance never awaits a UI component or a long-lived HTTP POST.
    Promise.resolve().then(() => this.dispatch('savedHistoryOperationScenario', { tabId, operationId: request.operationId }))
      .catch(error => {
        if (terminal(lease.record)) return;
        this.save(lease, { state: error.dispatched === false ? 'failed' : 'outcome-unknown',
          pending: error.dispatched !== false, error: error.code || error.message });
      });
    return record;
  }

  lease(request) {
    const lease = this.leases.get(this.key(request.tabId, request.operationId));
    if (!lease || terminal(lease.record)) fail('history_operation_lease_unavailable');
    return lease;
  }

  assertScope(lease, { afterStop = false, sessionId = lease.record.expectedSessionId, launch = false } = {}) {
    lease.validateOwner?.();
    if (lease.historyInput) this.runtime.assertInput?.(lease.historyInput);
    const now = this.runtime.capture(lease.record.tabId);
    const old = lease.scope;
    if (!old || !now.terminalToken || now.terminalToken !== old.terminalToken
      || now.projectId !== old.projectId || now.cwd !== old.cwd
      || now.inputRevision !== old.inputRevision || now.sessionId !== sessionId
      || now.runSeq !== old.runSeq || now.lifecycleGeneration !== old.lifecycleGeneration
      || (!afterStop && now.launchId !== old.launchId)) fail('history_operation_owner_changed');
    if (!launch && afterStop) {
      if (now.isRunning === true || now.stopping === true) fail('history_operation_process_not_stopped');
      if (now.isRunning !== false || now.processLookupUnknown === true) fail('history_operation_process_state_unknown');
    }
    return now;
  }

  validateStop(request) {
    const lease = this.lease(request);
    if (lease.record.phase !== 'stopping') fail('history_operation_phase_mismatch');
    const now = this.assertScope(lease);
    // This is called again synchronously at the actual Stop signal boundary.
    if (now.isRunning) {
      const draft = this.runtime.inspectDraft(request.tabId);
      if (draft?.hasDraft !== false) fail(draft?.hasDraft ? 'terminal_draft_conflict' : 'terminal_draft_unknown');
    }
    return { allowed: true };
  }

  validateResume(request, event, detail = {}) {
    const lease = this.lease(request);
    if (lease.record.phase !== 'resuming') fail('history_operation_phase_mismatch');
    const sessionId = this.boundSessionId(lease);
    if (!sessionId) fail('history_operation_removed_session');
    if (detail.sessionId !== sessionId) fail('history_operation_resume_target_changed');
    if (event === 'claim') {
      this.assertScope(lease, { afterStop: true, sessionId });
      if (lease.record.ownerCheckpoint) this.runtime?.owner?.prepareResume(request.tabId, lease.record.operationId, lease.record.ownerCheckpoint);
      lease.claimExpected = true;
    } else if (event === 'claimed') {
      if (!lease.claimExpected) fail('history_operation_launch_unowned');
      const now = this.runtime.capture(request.tabId);
      if (now.terminalToken !== lease.scope.terminalToken || now.inputRevision !== lease.scope.inputRevision
        || now.sessionId !== sessionId || now.runSeq !== lease.scope.runSeq + 1) fail('history_operation_owner_changed');
      lease.scope = now;
      lease.launchId = detail.launchId;
      if (lease.record.ownerCheckpoint) this.runtime?.owner?.carryResume(request.tabId, lease.record.operationId, lease.record.ownerCheckpoint,
        this.runtime.owner.observation(request.tabId));
    } else if (event === 'write') {
      const now = this.assertScope(lease, { sessionId, launch: true });
      if (now.launchId !== detail.launchId || detail.launchId !== lease.launchId) fail('history_operation_launch_unowned');
      this.save(lease, { resume: { status: 'write-pending', launchId: detail.launchId } });
    }
    return { allowed: true };
  }

  boundSessionId(lease) {
    if (!lease.record.bindingCommitted) return lease.record.expectedSessionId;
    return lease.record.toolType === 'claude'
      ? (lease.mutation?.fileDeleted ? null : lease.mutationSessionId)
      : lease.mutation?.newSessionId;
  }

  applicability(tabId, operationId, expectedRevision) {
    const operation = this.read(tabId, operationId);
    if (!operation) return null;
    if (!this.runtime?.owner) fail('history_owner_unavailable');
    return this.runtime.owner.applicability(tabId, operation, expectedRevision);
  }

  commitCodexBinding(request, commitBinding) {
    const lease = this.lease(request);
    if (lease.record.toolType !== 'codex' || lease.record.phase !== 'adopting'
      || lease.mutation?.newSessionId !== request.sessionId) fail('history_operation_binding_unowned');
    this.assertScope(lease, { afterStop: true });
    this.save(lease, { bindingCommitted: true, activeSessionId: request.sessionId }, commitBinding);
    if (lease.historyInput) this.runtime.bindInput?.(lease.historyInput, request.sessionId);
    lease.scope = this.runtime.capture(request.tabId);
  }

  // Provider adapter: physical UUID/address proof only. The existing Claude
  // deleteRange remains the sole planner/relinker/writer. Session IDs embedded
  // in copied records are not file boundaries and are not rewritten here.
  async claudeSource(lease, timeline, { initial = false } = {}) {
    const spec = lease.record.request;
    const target = selectSavedHistoryTarget(timeline, spec, initial);
    const sessionId = timeline.latestSessionId || spec.expectedSessionId;
    if (lease.mutationSessionId && lease.mutationSessionId !== sessionId) fail('history_operation_chain_changed');
    const loaded = await this.claude.loadOperationSource({ sessionId, cwd: lease.cwd });
    this.assertScope(lease, { afterStop: !initial });
    if (!loaded?.success || !loaded.revision?.token) fail(loaded?.error || 'history_read_failed');
    if (initial) {
      // The public revision authorizes the chain as read, not just its selected
      // UUID. The internal source snapshot is a separate read; prove they still
      // describe the same chain before Stop. Busy flush AFTER admission remains
      // supported and is revalidated by the existing stopped writer.
      const fresh = await this.transcript.getTimeline({ tabId: spec.tabId, toolType: 'claude',
        sessionId: spec.expectedSessionId, cwd: lease.cwd });
      this.assertScope(lease);
      selectSavedHistoryTarget(fresh, spec);
      if ((fresh.latestSessionId || spec.expectedSessionId) !== sessionId) fail('history_operation_chain_changed');
    }
    const matches = loaded.records.filter(record => record?.uuid === target.uuid);
    if (matches.length !== 1) fail('history_target_not_in_current_physical_file');
    if (matches[0].type !== 'user' || matches[0].isMeta || matches[0].isCompactSummary
      || Array.isArray(matches[0].message?.content) && matches[0].message.content.some(part => part.type === 'tool_result')) fail('history_target_not_user_iteration');
    if (spec.targetEntryRef && (spec.targetEntryRef.physicalSessionId !== sessionId || spec.targetEntryRef.rawUuid !== target.uuid)) fail('history_target_partial_identity');
    if (initial) { lease.mutationSessionId = sessionId; lease.rawTargetHash = hash(matches[0]); }
    else if (hash(matches[0]) !== lease.rawTargetHash) fail('history_target_changed');
    return { loaded, target, sessionId };
  }

  async step(request) {
    const lease = this.lease(request);
    const { phase, data = {} } = request;
    const spec = lease.record.request;
    if (phase === 'prepare') {
      if (lease.executing) fail('history_operation_already_executing');
      lease.executing = true;
      const info = await this.resolveSession(spec.tabId);
      if (info?.tabType === 'claude-sdk') fail('history_operation_provider_unsupported');
      if (info?.toolType !== spec.toolType || info.sessionId !== spec.expectedSessionId) fail('history_operation_session_changed');
      lease.cwd = info.cwd;
      lease.scope = this.runtime.capture(spec.tabId);
      if (lease.scope.sessionId !== spec.expectedSessionId || lease.scope.toolType !== spec.toolType
        || lease.scope.stopping) fail('history_operation_owner_changed');
      const timeline = await this.transcript.getTimeline({ tabId: spec.tabId, toolType: spec.toolType, sessionId: spec.expectedSessionId, cwd: info.cwd });
      this.assertScope(lease);
      let mutationSpec = spec;
      if (spec.repairOfOperationId) {
        if (timeline.composite && (!spec.targetEntryRef || !spec.expectedContentRevision)) fail('history_target_partial_identity');
        const currentRevision = timeline.contentRevision?.token || timeline.contentRevision || timeline.revision?.token || null;
        if (!timeline.success || spec.expectedContentRevision && spec.expectedContentRevision !== currentRevision) fail('stale_transcript_revision');
        const previous = this.read(spec.tabId, spec.repairOfOperationId);
        const repair = await this.inspectRepair({ previous, currentSessionId: spec.expectedSessionId, cwd: info.cwd });
        this.assertScope(lease);
        if (!repair.success) fail(repair.code || 'history_repair_unproven');
        lease.repair = repair;
        lease.mutationSessionId = repair.sourceSessionId;
        mutationSpec = { ...previous.request, expectedContentRevision: null };
        lease.mutationSpec = mutationSpec;
        this.save(lease, { repair: repair.proof });
      }
      const sourceTimeline = spec.repairOfOperationId
        ? { success: true, entries: this.buildTimeline(lease.repair.sourceRecords, lease.mutationSessionId) } : timeline;
      lease.target = targetSnapshot(selectSavedHistoryTarget(sourceTimeline, mutationSpec, !spec.repairOfOperationId));
      if (spec.toolType === 'claude') {
        const physical = await this.claudeSource(lease, timeline, { initial: true });
        lease.claudeTargetRecord = physical.loaded.records.find(record => record?.uuid === spec.targetUuid);
      } else {
        const raw = await this.transcript.loadCodexOperationSource({ sessionId: lease.mutationSessionId || spec.expectedSessionId, cwd: info.cwd });
        if (!raw?.success) fail(raw?.error || 'history_read_failed');
        this.assertScope(lease);
        lease.rawTargetHash = hash(targetSnapshot(selectSavedHistoryTarget({ success: true,
          entries: this.buildTimeline(raw.records, lease.mutationSessionId || spec.expectedSessionId) }, mutationSpec, false)));
      }
      const history = await this.transcript.getHistory({ ...(spec.repairOfOperationId ? {} : { tabId: spec.tabId }), toolType: spec.toolType,
        sessionId: lease.mutationSessionId || spec.expectedSessionId, cwd: info.cwd, bounds: { aroundUuid: spec.targetUuid, radius: 1 } });
      this.assertScope(lease);
      if (!history?.success) fail(history?.lineageReason || history?.error || 'history_read_failed');
      const authors = (history.entries || []).filter(entry => (entry.role === 'user' || entry.type === 'user')
        && !entry.serviceCarrier && historyEntryHasExactIdentity(entry, spec.targetUuid));
      if (authors.length !== 1) fail('history_authoring_identity_unresolved');
      if (spec.repairOfOperationId) {
        const previous = this.read(spec.tabId, spec.repairOfOperationId);
        const { endUuid: _previousEnd, ...previousTarget } = previous.target || {};
        if (hash(targetSnapshot(authors[0])) !== hash(previousTarget)) fail('history_repair_original_target_changed');
      }
      const draftTarget = { ...targetSnapshot(authors[0]), uuid: spec.targetUuid,
        endUuid: spec.kind === 'delete' ? spec.targetUuid : sourceTimeline.entries.at(-1)?.uuid };
      if (spec.toolType === 'claude' && this.claude.materializeImages) {
        draftTarget.imagePaths = await this.claude.materializeImages(lease.claudeTargetRecord, draftTarget.imagePaths);
        this.assertScope(lease);
        if (draftTarget.imagePaths.length) saveAuditedPromptPresentation(this.db, {
          toolType: 'claude', sessionId: authors[0].sessionId || spec.expectedSessionId,
          entryUuid: authors[0].uuid, auditTimestamp: authors[0].timestamp,
          actualText: authors[0].content, snapshot: { promptChips: draftTarget.promptChips, imagePaths: draftTarget.imagePaths },
        });
      }
      this.save(lease, { phase: 'preparing', target: draftTarget, contentRevision: timeline.contentRevision || null });
      return { sessionId: spec.expectedSessionId, mutationSessionId: lease.mutationSessionId || spec.expectedSessionId,
        toolType: spec.toolType, cwd: info.cwd, target: draftTarget,
        ...(lease.historyInput ? { historyInput: lease.historyInput } : {}),
        ...(lease.repair ? { incumbentCodexSettingsProof: lease.repair.childSettingsProof } : {}) };
    }
    if (phase === 'stopping') {
      if (lease.record.phase !== 'preparing') fail('history_operation_phase_mismatch');
      const scope = this.assertScope(lease);
      if (scope.isRunning) await this.runtime.waitForDraft?.(spec.tabId);
      this.assertScope(lease);
      this.save(lease, { phase });
      this.validateStop(request);
      return { authority: { kind: 'saved-history', tabId: spec.tabId, operationId: spec.operationId } };
    }
    if (phase === 'stopped') {
      if (lease.record.phase !== 'stopping') fail('history_operation_phase_mismatch');
      this.assertScope(lease, { afterStop: true });
      lease.scope = this.runtime.capture(spec.tabId);
      this.save(lease, { phase });
      return {};
    }
    if (phase === 'rewrite') {
      if (lease.record.phase !== 'stopped') fail('history_operation_phase_mismatch');
      this.assertScope(lease, { afterStop: true });
      // The busy turn may have flushed before Stop. Resolve the tail again,
      // but never borrow another target or reinterpret a stale source prefix.
      if (lease.repair) {
        const refreshed = await this.inspectRepair({ previous: this.read(spec.tabId, spec.repairOfOperationId),
          currentSessionId: spec.expectedSessionId, cwd: lease.cwd });
        this.assertScope(lease, { afterStop: true });
        if (!refreshed.success) fail(refreshed.code || 'history_repair_child_changed');
        if (refreshed.sourceHash !== lease.repair.sourceHash) fail('history_repair_source_changed');
        lease.repair = refreshed;
      }
      const mutationSpec = lease.mutationSpec || spec;
      const timeline = await this.transcript.getTimeline({ ...(lease.repair ? {} : { tabId: spec.tabId }), toolType: spec.toolType,
        sessionId: lease.mutationSessionId || spec.expectedSessionId, cwd: lease.cwd });
      this.assertScope(lease, { afterStop: true });
      const target = selectSavedHistoryTarget(timeline, mutationSpec, false);
      // Claude's exact raw record hash is checked by claudeSource below. Its
      // presentation may legitimately gain managed image refs during our own
      // preparation; those refs do not mean that the authored record changed.
      if (spec.toolType !== 'claude' && hash(targetSnapshot(target)) !== hash(lease.target)) fail('history_target_changed');
      const endUuid = spec.kind === 'delete' ? target.uuid : timeline.entries.at(-1)?.uuid;
      this.save(lease, { phase: 'rewriting', endUuid, draft: spec.kind === 'rewind' ? data.draft : null });
      if (spec.toolType === 'claude') {
        const { loaded, sessionId } = await this.claudeSource(lease, timeline);
        const result = await this.claude.deleteRange({ sessionId, cwd: lease.cwd, startUuid: target.uuid, endUuid,
          expectedRevision: loaded.revision,
          validateSource: current => {
            this.assertScope(lease, { afterStop: true });
            if (current.revision.token !== loaded.revision.token
              || hash(current.records.find(record => record?.uuid === target.uuid)) !== lease.rawTargetHash) fail('history_target_changed');
          }, beforeCommit: () => this.assertScope(lease, { afterStop: true }),
        });
        if (result?.committed === true) {
          lease.mutation = result;
          try {
            this.save(lease, { phase: 'rewritten', historyMutated: true, mutationSessionId: sessionId,
              fileDeleted: result.fileDeleted === true, removedCount: result.removedCount, removedUsers: result.removedUsers });
          } catch (error) {
            // IPC exceptions lose custom fields. Return the already-committed
            // mutation as DATA so the executor cannot attempt source recovery.
            return { ...result, success: false, committed: true, mutationSessionId: sessionId,
              error: error.message, code: error.code || 'history_operation_receipt_persist_failed' };
          }
        }
        if (!result?.success || result.committed !== true) fail(result?.code || result?.error || 'history_rewrite_unproven');
        return { ...result, mutationSessionId: sessionId };
      }
      const performRewrite = () => this.deleteRange({ sessionId: lease.mutationSessionId || spec.expectedSessionId, cwd: lease.cwd,
        diagnosticOperationId: spec.operationId,
        startUuid: target.uuid, endUuid, toPhysicalEnd: spec.kind === 'rewind', codexSettingsProof: data.codexSettingsProof || null,
        validateSource: loaded => {
          this.assertScope(lease, { afterStop: true });
          if (lease.repair && this.hashRecords(loaded.records) !== lease.repair.sourceHash) fail('history_repair_source_changed');
          const entries = this.buildTimeline(loaded.records, lease.mutationSessionId || spec.expectedSessionId);
          const actual = selectSavedHistoryTarget({ success: true, entries }, mutationSpec, false);
          if (hash(targetSnapshot(actual)) !== lease.rawTargetHash) fail('history_target_changed');
        },
        beforeWrite: () => { this.assertScope(lease, { afterStop: true }); lease.repair?.validateChild(); },
      });
      const result = lease.historyInput && this.runtime.runInput
        ? await this.runtime.runInput(lease.historyInput, performRewrite) : await performRewrite();
      if (!result?.success) fail(result?.code || result?.error || 'history_rewrite_failed');
      lease.mutation = result;
      try {
        this.save(lease, { phase: 'rewritten', historyMutated: true, newSessionId: result.newSessionId,
          removedCount: result.removedCount, removedUsers: result.removedUsers, suffixProof: result.suffixProof || null });
      } catch (error) {
        // The rollout and its lineage committed BEFORE this receipt write.
        // Never turn its failed bookkeeping into permission to Resume/rewrite
        // the source. Keep lease.mutation for the existing failed/read path.
        return { ...result, success: false, committed: true,
          error: error.message, code: error.code || 'history_operation_receipt_persist_failed' };
      }
      return result;
    }
    if (phase === 'adopting') {
      if (lease.record.phase !== 'rewritten') fail('history_operation_phase_mismatch');
      this.assertScope(lease, { afterStop: true });
      if (spec.toolType === 'claude' ? lease.mutation?.committed !== true : !lease.mutation?.newSessionId) fail('history_mutation_receipt_missing');
      this.save(lease, { phase });
      return {};
    }
    if (phase === 'adopted') {
      if (lease.record.phase !== 'adopting') fail('history_operation_phase_mismatch');
      if (spec.toolType === 'claude') {
        this.assertScope(lease, { afterStop: true });
        const nextSid = lease.mutation.fileDeleted ? null : lease.mutationSessionId;
        const binding = { applied: true, mode: nextSid ? 'retained' : 'cleared',
          previousSessionId: spec.expectedSessionId, sessionId: nextSid,
          removedSessionId: lease.mutation.fileDeleted ? lease.mutationSessionId : null };
        this.save(lease, { phase, bindingCommitted: true, activeSessionId: nextSid, binding }, () => {
          if (!this.db.compareAndSetTabClaudeSessionId(lease.scope.projectId, spec.tabId, spec.expectedSessionId, nextSid)) fail('history_binding_changed');
        });
        if (lease.historyInput) this.runtime.bindInput?.(lease.historyInput, nextSid);
        lease.scope = this.runtime.capture(spec.tabId);
        return { binding };
      }
      this.assertScope(lease, { afterStop: true, sessionId: lease.mutation?.newSessionId });
      lease.scope = this.runtime.capture(spec.tabId);
      this.save(lease, { phase, bindingCommitted: true, activeSessionId: lease.mutation.newSessionId });
      return {};
    }
    if (phase === 'resuming') {
      const sessionId = this.boundSessionId(lease);
      if (!sessionId) fail('history_operation_removed_session');
      this.assertScope(lease, { afterStop: true, sessionId });
      this.save(lease, { phase });
      return { historyOperation: { tabId: spec.tabId, operationId: spec.operationId } };
    }
    if (phase === 'completed' || phase === 'failed') {
      const cleared = spec.toolType === 'claude' && lease.mutation?.fileDeleted === true
        && lease.record.binding?.mode === 'cleared' && lease.record.bindingCommitted;
      if (phase === 'completed' && cleared) {
        this.assertScope(lease, { afterStop: true, sessionId: null });
        if (data.resume?.launchWritten || data.resume?.skipped !== true) fail('history_operation_result_unproven');
      } else if (phase === 'completed' && (!lease.record.bindingCommitted || !data.resume?.launchWritten
        || lease.record.resume?.status !== 'write-pending' || data.resume.launchId !== lease.launchId)) fail('history_operation_result_unproven');
      const currentBinding = lease.mutation?.newSessionId && this.runtime.capture(spec.tabId).sessionId === lease.mutation.newSessionId;
      return this.save(lease, { phase, state: phase, pending: false, success: phase === 'completed',
        ...(lease.mutation ? { historyMutated: true, ...(spec.toolType === 'codex' ? { newSessionId: lease.mutation.newSessionId } : {}) } : {}),
        ...(currentBinding ? { bindingCommitted: true, activeSessionId: lease.mutation.newSessionId } : {}),
        ...(data.resume ? { resume: data.resume } : {}),
        ...(phase === 'completed' ? { error: null } : data.error ? { error: data.error } : {}) });
    }
    fail('history_operation_phase_unknown');
  }
}

module.exports = { SavedHistoryOperations, normalizeSavedHistoryRequest, selectSavedHistoryTarget };
