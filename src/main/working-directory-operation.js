'use strict';

// Main-owned scenario over the existing Stop/cwd/Resume owners. Never writes a
// prompt, edits a rollout, chooses a native picker, or replays a persisted job.
const { createHash } = require('node:crypto');
const path = require('node:path');
const PREFIX = 'working-directory-operation.v1:';
const copy = value => value == null ? value : structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const terminal = record => ['completed', 'failed', 'interrupted'].includes(record?.state);

function normalizeWorkingDirectoryRequest(tabId, body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['operationId', 'expectedSessionId', 'targetCwd', 'expectedCwd', 'resume'].includes(key))) {
    fail('cwd_operation_invalid_request', 400);
  }
  if (typeof tabId !== 'string' || !tabId || tabId.length > 1024
    || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.operationId || '')
    || typeof body.expectedSessionId !== 'string' || !body.expectedSessionId
    || body.expectedSessionId.length > 160) fail('cwd_operation_identity_required', 400);
  const directory = value => {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096
      || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)) fail('cwd_operation_path_invalid', 400);
    return path.resolve(value);
  };
  if (body.resume !== undefined && typeof body.resume !== 'boolean') fail('cwd_operation_invalid_request', 400);
  return { tabId, operationId: body.operationId, expectedSessionId: body.expectedSessionId,
    targetCwd: directory(body.targetCwd), expectedCwd: body.expectedCwd === undefined ? null : directory(body.expectedCwd),
    resume: body.resume !== false };
}

class WorkingDirectoryOperations {
  constructor({ db, runtime, broadcast = () => {}, log = console }) {
    Object.assign(this, { db, runtime, broadcast, log });
    this.leases = new Map();
  }
  key(tabId, operationId) { return PREFIX + hash([tabId, operationId]); }
  lockKey(tabId) { return PREFIX + 'tab:' + tabId; }
  read(tabId, operationId) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(operationId)) fail('cwd_operation_identity_required', 400);
    const key = this.key(tabId, operationId), live = this.leases.get(key);
    const saved = live?.record || this.db.getAppState(key);
    if (!saved) return null;
    // A receipt survives restart; its former token/Stop/cd/launch do NOT.
    return copy(!terminal(saved) && !live ? { ...saved, state: 'interrupted', phase: 'interrupted',
      pending: false, success: false, outcomeUnknown: true, error: 'cwd_operation_interrupted' } : saved);
  }
  save(lease, patch) {
    const next = { ...lease.record, ...lease.effects, ...patch, revision: lease.record.revision + 1, updatedAt: Date.now() };
    const result = this.db.setAppState(lease.key, next);
    if (result?.success === false) fail('cwd_operation_receipt_write_failed', 503);
    lease.record = next;
    try { this.broadcast(next.tabId, { type: 'working-directory-operation', operation: copy(next) }); }
    catch (error) { this.log.warn?.('[WorkingDirectoryOperation] broadcast failed: ' + error.message); }
    this.log.log?.('[WorkingDirectoryOperation] tab=' + next.tabId + ' operation=' + next.operationId
      + ' phase=' + next.phase + ' cwdChanged=' + next.cwdChanged + ' launchWritten=' + next.launchWritten
      + ' elapsedMs=' + (next.updatedAt - next.createdAt) + ' error=' + (next.error || '-'));
    return next;
  }
  accept(tabId, body) {
    const request = normalizeWorkingDirectoryRequest(tabId, body), key = this.key(tabId, request.operationId);
    const existing = this.read(tabId, request.operationId);
    if (existing) {
      if (hash(existing.request) !== hash(request)) fail('cwd_operation_request_mismatch');
      return { ...existing, idempotent: true };
    }
    const oldId = this.db.getAppState(this.lockKey(tabId));
    if (oldId && !terminal(this.read(tabId, oldId))) fail('cwd_operation_pending');
    const scope = this.runtime.capture(tabId);
    if (!scope?.terminalToken || scope.toolType !== 'codex' || !scope.projectId || !scope.cwd
      || scope.sessionId !== request.expectedSessionId || scope.stopping || scope.nativeRewindPending
      || request.expectedCwd && request.expectedCwd !== scope.cwd) fail('cwd_operation_owner_changed');
    const input = this.runtime.reserveInput({ tabId, operationId: request.operationId,
      toolType: 'codex', sessionId: request.expectedSessionId, purpose: 'working-directory' });
    const record = { ...request, request, sourceCwd: scope.cwd, resolvedTargetCwd: null,
      state: 'running', phase: 'accepted', pending: true, success: false,
      cwdChangeAttempted: false, cwdChanged: false, processStopAttempted: false, processStopped: false,
      launchAttempted: false, launchWritten: false, inputReady: false, sessionId: scope.sessionId,
      revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
    const lease = { key, record, scope, input, effects: {}, executing: false };
    try {
      this.db.db.transaction(() => {
        if (this.db.setAppState(key, record)?.success === false
          || this.db.setAppState(this.lockKey(tabId), request.operationId)?.success === false) fail('cwd_operation_receipt_write_failed', 503);
      })();
    } catch (error) { this.runtime.finishInput(input); throw error; }
    this.leases.set(key, lease);
    this.runtime.noteIntent?.(tabId);
    void this.drive(lease);
    return copy(record); // Accepted before async filesystem/process/native work.
  }
  assertCurrent(lease, { allowStopping = false } = {}) {
    this.runtime.assertInput(lease.input);
    const now = this.runtime.capture(lease.record.tabId), before = lease.scope;
    if (now.terminalToken !== before.terminalToken || now.projectId !== before.projectId
      || now.subjectId !== before.subjectId || now.toolType !== 'codex'
      || now.sessionId !== before.sessionId || now.cwd !== before.cwd
      || now.inputRevision !== before.inputRevision || now.stopping && !allowStopping) fail('cwd_operation_owner_changed');
    return now;
  }
  notify(tabId) {
    for (const lease of this.leases.values()) if (lease.record.tabId === tabId
      && !lease.executing && lease.record.phase === 'waiting-for-idle') void this.drive(lease);
  }
  waiting(tabId) {
    for (const lease of this.leases.values()) if (lease.record.tabId === tabId
      && !lease.executing && lease.record.phase === 'waiting-for-idle') return true;
    return false;
  }
  noteResumeSource(request, input, snapshot) {
    const lease = this.leases.get(this.key(request.tabId, request.operationId));
    if (!lease || lease.input?.token !== input?.token || lease.record.phase !== 'resume-write-pending'
      || snapshot?.sessionId !== lease.record.expectedSessionId || !snapshot.filePath
      || !Number.isSafeInteger(snapshot.size)) fail('cwd_operation_resume_source_changed');
    lease.resumeSource = copy(snapshot); // Private append boundary; never in a public DTO.
  }
  resumeSource(tabId, operationId) { return this.leases.get(this.key(tabId, operationId))?.resumeSource || null; }
  async drive(lease) {
    if (lease.executing || terminal(lease.record)) return;
    lease.executing = true;
    try {
      this.assertCurrent(lease);
      const target = lease.record.resolvedTargetCwd || await this.runtime.resolveTarget(lease.record.targetCwd);
      this.assertCurrent(lease);
      if (!lease.record.resolvedTargetCwd) this.save(lease, { resolvedTargetCwd: target });
      const current = await this.runtime.readCurrent(lease.record.tabId);
      this.assertCurrent(lease);
      if (!current || current.coherent !== true || !['found', 'absent'].includes(current.processStatus)
        || current.processLookupUnknown || current.stopping) fail('cwd_operation_runtime_unknown', 503);
      if (current.manualActionRequired === true) fail('cwd_operation_manual_action_required');
      if (current.busy === true || current.turnBusy === true || current.goalWork?.pending === true || current.backgroundWorkCount > 0
        || current.processStatus === 'found' && current.writerConfirmed !== true
        || current.status === 'busy' || current.starting === true || current.status === 'starting') {
        this.save(lease, { phase: 'waiting-for-idle' });
        return; // Only existing runtime/input/turn events may wake this intent.
      }
      if (current.processStatus === 'found') {
        if (current.sessionId !== lease.scope.sessionId) fail('cwd_operation_live_session_changed');
        const draft = await this.runtime.inspectDraft(lease.record.tabId);
        this.assertCurrent(lease);
        if (draft?.success !== true || draft.hasDraft !== false) fail(draft?.code || (draft?.hasDraft === true
          ? 'cwd_operation_draft_present' : 'cwd_operation_draft_unknown'));
        // Same directory is a read-only no-op for an already ready process.
        if (target === lease.scope.cwd && current.inputReady === true && lease.record.resume) {
          const native = await this.runtime.verifyExistingCwd(lease.record.tabId, current, target);
          this.assertCurrent(lease);
          const fresh = await this.runtime.readCurrent(lease.record.tabId);
          this.assertCurrent(lease);
          if (native?.known === true && native.cwd === target && native.sessionId === current.sessionId
            && fresh.coherent === true && fresh.writerConfirmed === true && fresh.inputReady === true
            && fresh.sessionId === current.sessionId && fresh.processStatus === 'found') {
            this.save(lease, { state: 'completed', phase: 'completed', pending: false,
              success: true, unchanged: true, inputReady: true, nativeCwd: native.cwd });
            return;
          }
          // A matching host/sidebar path alone cannot attest the native cwd.
          // The original explicit operation still owns its guarded cold Resume.
        }
        this.save(lease, { phase: 'stop-pending', processStopAttempted: true, processStopped: null });
        const stopped = await this.runtime.stop(lease.record.tabId, lease.input,
          () => this.assertCurrent(lease, { allowStopping: true }));
        this.assertCurrent(lease);
        if (stopped?.success !== true) fail(stopped?.error || stopped?.code || 'cwd_operation_stop_failed');
        lease.effects.processStopped = true;
        this.save(lease, { processStopped: true, phase: 'stopped' });
      }
      if (target !== lease.scope.cwd) {
        this.save(lease, { phase: 'cwd-write-pending', cwdChangeAttempted: true, cwdChanged: null });
        const changed = await this.runtime.changeCwd({ tabId: lease.record.tabId, targetCwd: target, historyInput: lease.input });
        if (changed?.success !== true || changed.accepted !== true || changed.persisted !== true || changed.cwd !== target) {
          fail(changed?.error || 'cwd_operation_cwd_unproven');
        }
        lease.effects.cwdChanged = true;
        // The cwd owner has already checkpointed the exact persisted OSC7+run
        // transition WITHOUT releasing the shared input reservation.
        lease.scope = this.runtime.capture(lease.record.tabId);
        this.assertCurrent(lease);
        this.save(lease, { phase: 'cwd-committed', cwdChanged: true, cwdProofOperationId: changed.operationId });
      }
      if (!lease.record.resume) {
        this.save(lease, { state: 'completed', phase: 'completed', pending: false, success: true });
        return;
      }
      this.assertCurrent(lease);
      this.save(lease, { phase: 'resume-write-pending', launchAttempted: true, launchWritten: null });
      const launch = await this.runtime.resume({ tabId: lease.record.tabId, sessionId: lease.record.expectedSessionId,
        cwd: target, historyInput: lease.input, operationId: lease.record.operationId });
      if (typeof launch?.launchWritten === 'boolean') lease.effects.launchWritten = launch.launchWritten;
      if (launch?.launchWritten === false) this.save(lease, { launchWritten: false });
      if (launch?.success !== true || launch.accepted === false || !launch.launchId) fail(launch?.error || 'cwd_operation_resume_unproven');
      this.save(lease, { phase: 'awaiting-input', launchWritten: typeof launch.launchWritten === 'boolean' ? launch.launchWritten : null,
        launchId: launch.launchId });
      const ready = await this.runtime.waitReady(lease.record.tabId, launch);
      this.runtime.assertInput(lease.input);
      if (ready?.coherent !== true || ready.inputReady !== true || ready.writerConfirmed !== true
        || ready.processStatus !== 'found' || ready.cwd !== target || !ready.sessionId
        || ready.launchId !== launch.launchId && ready.writerLaunchId !== launch.launchId) fail('cwd_operation_ready_unproven');
      this.save(lease, { phase: 'native-cwd-proof' });
      const native = await this.runtime.verifyNativeCwd(lease.record.tabId, ready, lease.record);
      this.runtime.assertInput(lease.input);
      if (native?.known !== true || native.cwd !== target || native.sessionId !== ready.sessionId) {
        fail(native?.reason || 'cwd_operation_native_cwd_unproven');
      }
      const confirmed = await this.runtime.readCurrent(lease.record.tabId);
      this.runtime.assertInput(lease.input);
      if (confirmed?.coherent !== true || confirmed.inputReady !== true || confirmed.writerConfirmed !== true
        || confirmed.processStatus !== 'found' || confirmed.cwd !== target || confirmed.sessionId !== ready.sessionId
        || confirmed.launchId !== launch.launchId && confirmed.writerLaunchId !== launch.launchId) fail('cwd_operation_ready_changed');
      Object.assign(lease.effects, { inputReady: true, sessionId: ready.sessionId, nativeCwd: native.cwd });
      this.save(lease, { state: 'completed', phase: 'completed', pending: false, success: true,
        inputReady: true, sessionId: ready.sessionId, nativeCwd: native.cwd });
    } catch (error) {
      try { this.save(lease, { state: 'failed', phase: 'failed', pending: false, success: false,
        error: error.code || error.message,
        partial: (lease.effects.cwdChanged ?? lease.record.cwdChanged) !== false
          || (lease.effects.processStopped ?? lease.record.processStopped) !== false
          || (lease.effects.launchWritten ?? lease.record.launchWritten) !== false }); }
      catch (storageError) {
        // Preserve known physical effects in RAM even if bookkeeping failed
        // AFTER them. Durable pre-write phase remains unknown after restart.
        lease.record = { ...lease.record, ...lease.effects, state: 'failed', phase: 'failed', pending: false,
          success: false, outcomeUnknown: true, partial: true,
          error: 'cwd_operation_receipt_write_failed', receiptPersistenceError: true };
        this.log.error?.('[WorkingDirectoryOperation] receipt write failed: ' + storageError.message);
      }
    } finally {
      lease.executing = false;
      if (lease.record.phase !== 'waiting-for-idle') {
        try { this.runtime.finishInput(lease.input); }
        catch (error) { this.log.warn?.('[WorkingDirectoryOperation] input hold retained: ' + error.message); }
        if (terminal(lease.record) && !lease.record.receiptPersistenceError) this.leases.delete(lease.key);
      }
    }
  }
}

module.exports = { WorkingDirectoryOperations, normalizeWorkingDirectoryRequest };
