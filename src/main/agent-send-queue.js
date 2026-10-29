'use strict';

// The application backlog owns admission only. Existing scenarios still own
// readiness/settings/composer/PTY and the receipt store owns delivery proof.
// No timed readiness, text matching, turn-completion heuristic or second Enter.
// A retained active-HEAD deadline can only end proven-unwritten preparation.
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { attachmentOwnershipReceipt, validateOwnedAttachmentSnapshot } = require('./owned-mobile-attachments');
const { isAutomaticPromptQueueRequest, isAutomaticNoWriteWait, isAutomaticReadinessWaitReceipt } = require('../shared/prompt-queue-send-intent.cjs');
const { mergeableQueuedSend, queuedSendMergeCompatible, composeQueuedSendMerge } = require('./queued-send-merge');
const { protectQueueAssets, releaseQueueTransferPin, adoptCompletedQueueTransfers, adoptRunAfterItemAssets } = require('./replay-asset-ownership');
const { classifyInputSlotRetirement, sendInputSlot } = require('./agent-send-input-slot');
const { hiddenSendPresentation, isTabMessageNoInputReceipt, isExternalCompletionNoInputReceipt, isExternalOperationalNoInputReceipt } = require('../shared/agent-send-receipt-control.cjs');
const { historySendReturnControl } = require('./history-send-return');
const { capacityRecoveryDeferredReceipt } = require('../shared/run-after-capacity-recovery.cjs');
const { isSendPreparationDeferred, activeHeadPreparation, PREPARATION_MS, COLD_PREPARATION_MS } = require('./agent-send-preparation');
const OPEN = "('waiting','dispatching','awaiting-receipt')";
const ORDER = 'COALESCE(queue_position,id),id';
const FAILED = new Set(['not-submitted', 'provider-not-accepted']);
// Web stop/start reuses the Main receipt DB while an old asynchronous
// executor can still be unwinding. This is the SAME FIFO owner across queue
// instances, not another PTY mutex or permission to repeat an input.
const dispatchOwnersByDatabase = new WeakMap();
const consumed = record => record?.state === 'confirmed'
  && record.auditIdentity?.attemptId === record.attemptId
  && !!record.auditIdentity?.sessionId
  && !!(record.auditIdentity?.entryUuid || record.auditIdentity?.sourceIdentity);

function exactUnattemptedDispatch(record, item) {
  if (!record || !item || item.state !== 'dispatching' || record.operationKey !== item.operation_key
    || record.tabId !== item.tab_id || record.attemptId || Number(record.attempt || 0) !== 0
    || !['reserved', 'preparing'].includes(record.state) || record.deliveryControl?.cancelledAt
    || record.receipt?.submitted === true || record.receipt?.pasteWritten === true
    || record.receipt?.enterWritten === true || record.receipt?.deliveryUnknown === true) return false;
  try { return item.request_hash === fingerprintAgentSendRequest(JSON.parse(item.request_json)); }
  catch { return false; }
}

function unattemptedHeadPreparation(record, item) {
  if (!record || record.attemptId || Number(record.attempt || 0) !== 0
    || !['reserved', 'preparing'].includes(record.state) || record.receipt?.submitted === true
    || record.receipt?.pasteWritten === true || record.receipt?.enterWritten === true
    || record.receipt?.deliveryUnknown === true || !item || item.operation_key !== record.operationKey
    || item.tab_id !== record.tabId) return null;
  try { if (item.request_hash !== fingerprintAgentSendRequest(JSON.parse(item.request_json))) return null; }
  catch { return null; }
  const retained = activeHeadPreparation(record);
  if (retained) return retained;
  // Dispatch birth is committed BEFORE Web preparation; a SQLite refusal
  // before the receipt copy cannot erase this already-running deadline.
  if (!Number.isFinite(item.preparation_started_at) || !['warm', 'cold-codex'].includes(item.preparation_mode)
    || item.preparation_mode === 'cold-codex' && record.provider !== 'codex') return null;
  return { version: 1, operationKey: record.operationKey, tabId: record.tabId, handoffId: record.handoffId,
    requestFingerprint: record.requestFingerprint, mode: item.preparation_mode, startedAt: item.preparation_started_at,
    deadlineAt: item.preparation_started_at + (item.preparation_mode === 'cold-codex' ? COLD_PREPARATION_MS : PREPARATION_MS) };
}

function waitingBeforeInput(record, item, request) {
  return item?.state === 'waiting' && (isAutomaticNoWriteWait(record, request)
    || isTabMessageNoInputReceipt(record) || isExternalCompletionNoInputReceipt(record, request)
    || isExternalOperationalNoInputReceipt(record, request));
}

function applicationQueueReceipt(record, item) {
  if (record?.deliveryControl?.cancelledAt) return null;
  const retryWaiting = item && waitingBeforeInput(record, item, JSON.parse(item.request_json));
  if (!record || !item || !['waiting','dispatching'].includes(item.state)
    || (!retryWaiting && (record.attemptId || !['reserved','preparing'].includes(record.state)))) return null;
  return {
    success: true, accepted: true, submitted: false, pasteWritten: false, enterWritten: false,
    status: 'application-queued', queued: true, applicationQueued: true,
    providerQueueAccepted: false, exactAuditConfirmed: false, auditPending: false,
    handoffId: record.handoffId, tabId: record.tabId, operationKey: record.operationKey, provider: record.provider,
    sendOperationKey: record.operationKey, attemptId: null, sendAttemptId: null,
    receiptState: record.state,
    applicationQueue: { version: 1, id: item.id, state: item.state, queuedAt: item.created_at,
      position: item.queue_position ?? item.id,
      ...(retryWaiting ? { waitingBeforeInput: true, lastNoWriteAttemptId: record.attemptId } : {}) },
    ...(record.receipt?.ownedAttachments ? { attachmentOwnership: attachmentOwnershipReceipt(record.receipt.ownedAttachments) } : {}),
  };
}

class AgentSendQueue {
  constructor({ store, execute, publish = () => {}, publishMerge = null, transferMergedContext = null,
    ready = () => true, cancelAttempt = () => {}, admit = null, reconcile = null,
    readInputSlot = null, projectPresentation = null, claimDispatch = null, readRecoveryRelease = null, captureRecoveryOwner = null,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, capturePreparationMode = null }) {
    this.store = store;
    this.db = store.db;
    this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.capturePreparationMode = capturePreparationMode;
    this.preparationExpiries = new Map();
    this.dispatchOwners = dispatchOwnersByDatabase.get(this.db) || new Map();
    dispatchOwnersByDatabase.set(this.db, this.dispatchOwners);
    this.execute = execute;
    this.publish = publish;
    this.publishMerge = publishMerge;
    this.transferMergedContext = transferMergedContext;
    this.ready = ready;
    this.cancelAttempt = cancelAttempt;
    this.admit = admit;
    this.reconcile = reconcile;
    this.readInputSlot = readInputSlot;
    this.projectPresentation = projectPresentation;
    this.claimDispatch = claimDispatch;
    this.readRecoveryRelease = readRecoveryRelease;
    this.captureRecoveryOwner = captureRecoveryOwner;
    this.slotObservations = new Map();
    this.slotWakeSignatures = new Map();
    this.runtimeWakeRevisions = new Map();
    this.slotDirty = new Set();
    this.disposed = false;
    this.running = new Set();
    this.scheduled = new Set();
    this.parked = new Set();
    this.rerun = new Set();
    this.executors = new Map();
    this.waiters = new Map();
    this.admitting = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_send_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL UNIQUE,
      tab_id TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
      asset_ids_json TEXT NOT NULL DEFAULT '[]',
      predecessor_key TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_agent_send_queue_tab_state
      ON agent_send_queue(tab_id, state, id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_send_queue_assets (
      operation_key TEXT NOT NULL, occurrence INTEGER NOT NULL, source_key TEXT NOT NULL,
      source_path TEXT NOT NULL, asset_id TEXT NOT NULL, ref_json TEXT NOT NULL, PRIMARY KEY(operation_key, occurrence)
    ); CREATE INDEX IF NOT EXISTS idx_agent_send_queue_assets_source
      ON agent_send_queue_assets(source_key);`);
    const assetColumns = new Set(this.db.prepare('PRAGMA table_info(agent_send_queue_assets)').all().map(row => row.name));
    if (!assetColumns.has('source_path')) this.db.exec("ALTER TABLE agent_send_queue_assets ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_send_queue_assets_path ON agent_send_queue_assets(source_path)');
    const columns = new Set(this.db.prepare('PRAGMA table_info(agent_send_queue)').all().map(row => row.name));
    if (!columns.has('asset_ids_json')) this.db.exec("ALTER TABLE agent_send_queue ADD COLUMN asset_ids_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('predecessor_key')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN predecessor_key TEXT');
    if (!columns.has('release_json')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN release_json TEXT');
    if (!columns.has('slot_release_json')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN slot_release_json TEXT');
    if (!columns.has('queue_position')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN queue_position INTEGER');
    if (!columns.has('merge_json')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN merge_json TEXT');
    if (!columns.has('asset_transfer_ids_json')) this.db.exec("ALTER TABLE agent_send_queue ADD COLUMN asset_transfer_ids_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('recovery_defer_json')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN recovery_defer_json TEXT');
    if (!columns.has('recovery_owner_json')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN recovery_owner_json TEXT');
    if (!columns.has('preparation_started_at')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN preparation_started_at INTEGER');
    if (!columns.has('preparation_mode')) this.db.exec('ALTER TABLE agent_send_queue ADD COLUMN preparation_mode TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_send_queue_merges(request_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,response_json TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_send_queue_merge_sources(operation_key TEXT PRIMARY KEY,
      replacement_key TEXT NOT NULL,request_hash TEXT NOT NULL);`);
    this.unsubscribe = store.subscribe(record => this.observe(record));
  }

  item(operationKey) {
    return this.db.prepare('SELECT * FROM agent_send_queue WHERE operation_key = ?').get(operationKey) || null;
  }

  inputReservation(operationKey) {
    // Admission metadata only: never decode a follower's prompt/assets here.
    const row = this.db.prepare(`SELECT q.tab_id AS tabId,q.state,r.handoff_id AS handoffId,
      r.attempt_id AS attemptId,r.state AS receiptState,r.delivery_control_json AS control
      FROM agent_send_queue q JOIN agent_send_receipts r ON r.operation_key=q.operation_key
      WHERE q.operation_key=?`).get(operationKey);
    return row ? { ...row, cancelled: !!(row.control && JSON.parse(row.control).cancelledAt), control: undefined } : null;
  }

  authoringSnapshot(tabId, handoffId) {
    const rows = this.db.prepare(`SELECT q.request_json FROM agent_send_queue q
      JOIN agent_send_receipts r ON r.operation_key=q.operation_key WHERE q.tab_id=? AND r.handoff_id=?`).all(tabId, handoffId);
    if (rows.length > 1) throw new Error('history_return_authoring_ambiguous');
    return rows.length ? JSON.parse(rows[0].request_json).authoringSnapshot || null : null;
  }

  hasUnsettledInput(tabId) {
    return this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ('dispatching','awaiting-receipt')`).all(tabId)
      .some(item => sendInputSlot(this.store.get(item.operation_key), item).state === 'held');
  }

  installBlockers() {
    const blockers = [...this.running].map(tabId => ({ tabId, kind: 'input', status: 'preparing' }));
    // Read only control columns, never every historical prompt/attachment.
    // Startup can retain an old delivery outcome without restoring any FIFO or
    // physical-input owner. That legacy outcome is not an executor in this Main.
    // Keep every current/leased/queued attempt and the independent Main physical
    // input guards; neither delivery nor its no-replay/asset ownership is changed.
    const rows = this.db.prepare(`SELECT r.operation_key, r.tab_id, r.state, r.handoff_id, r.attempt_id, r.provider, r.session_id,
      q.slot_release_json, q.release_json FROM agent_send_receipts r
      LEFT JOIN agent_send_queue q ON q.operation_key=r.operation_key
      WHERE q.state IN ('dispatching','awaiting-receipt') OR
        (r.attempt_id IS NOT NULL AND r.state IN
          ('preparing','in-flight','enter-armed','audit-pending','delivery-unknown','evicted-unknown')
          AND NOT (q.operation_key IS NULL AND r.state='delivery-unknown'
            AND r.input_lease_json IS NULL
            AND CASE WHEN json_valid(r.receipt_json) THEN
              COALESCE(json_extract(r.receipt_json,'$.startupReconciliation.source'),'')='startup'
              AND COALESCE(json_extract(r.receipt_json,'$.startupReconciliation.decision'),'')='unknown'
              AND json_type(r.receipt_json,'$.providerQueue.evidence.lifecycleGeneration') IS NULL
            ELSE 0 END))`).all();
    for (const row of rows) {
      if (sendInputSlot(null, row).state === 'retired') continue;
      blockers.push({ tabId: row.tab_id, kind: 'input', status: row.state, operationKey: row.operation_key,
        handoffId: row.handoff_id, attemptId: row.attempt_id, provider: row.provider, sessionId: row.session_id });
    }
    return blockers;
  }

  receipt(operationKey) {
    const item = this.item(operationKey), record = this.store.get(operationKey);
    if (item?.state === 'recovery-deferred') return capacityRecoveryDeferredReceipt(this.projectRecord(record));
    return applicationQueueReceipt(record, item);
  }

  // Called only by the Main typed-outcome consumer, with a fresh exact owner
  // bookend. Never skip a manual request or an attempted/UNKNOWN physical slot.
  deferUnattemptedForRecovery(tabId, recovery, isCurrent) {
    if (this.disposed || recovery?.kind !== 'model-capacity' || recovery.tabId !== tabId
      || !recovery.sessionId || !recovery.lifecycleGeneration || !recovery.failedTurnId
      || !Number.isFinite(recovery.failedAt) || isCurrent?.() !== true) return false;
    const deferred = this.db.transaction(() => {
      if (isCurrent() !== true) return null;
      const item = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id=? AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(tabId);
      const record = item && this.store.get(item.operation_key);
      const refuse = reason => { if (item) console.log('[RunAfterCapacity] order wait tab=' + tabId
        + ' operation=' + item.operation_key + ' reason=' + reason); return null; };
      if (!item || item.state !== 'waiting' || !record || record.attemptId || record.deliveryControl?.cancelledAt
        || !['reserved', 'preparing'].includes(record.state) || record.receipt?.submitted === true
        || record.receipt?.pasteWritten === true || record.receipt?.enterWritten === true
        || record.receipt?.deliveryUnknown === true || record.receipt?.auditPending === true) return refuse('head-not-proven-unattempted');
      const request = JSON.parse(item.request_json);
      const bornOwner = JSON.parse(item.recovery_owner_json || 'null');
      const pinnedGeneration = request.expectedTarget?.lifecycleGeneration
        || (bornOwner?.version === 1 && bornOwner.sessionId === recovery.sessionId
          && bornOwner.requestHash === item.request_hash ? bornOwner.lifecycleGeneration : null);
      const source = require('./prompt-queue-source');
      if (!(isAutomaticPromptQueueRequest(request) || source.isPromptLoopAutomationSource(request.source))
        || request.provider !== 'codex' || record.provider !== 'codex') return refuse('head-not-automatic-codex');
      if (request.expectedTarget?.sessionId !== recovery.sessionId
        || pinnedGeneration !== recovery.lifecycleGeneration
        || item.request_hash !== fingerprintAgentSendRequest(request)) return refuse('head-owner-pin-or-fingerprint-mismatch');
      const proof = { version: 1, ...recovery, operationKey: record.operationKey, handoffId: record.handoffId, requestHash: item.request_hash };
      const changed = this.db.prepare("UPDATE agent_send_queue SET state='recovery-deferred', recovery_defer_json=?, updated_at=? WHERE operation_key=? AND state='waiting'")
        .run(JSON.stringify(proof), Date.now(), item.operation_key);
      return changed.changes === 1 ? record : null;
    })();
    if (!deferred) return false;
    console.log('[RunAfterCapacity] order deferred tab=' + tabId + ' operation=' + deferred.operationKey
      + ' turn=' + recovery.failedTurnId + ' generation=' + recovery.lifecycleGeneration);
    this.resolveWaiters(deferred.operationKey);
    this.publishRecord(deferred);
    this.wake(tabId);
    return true;
  }

  observeRecoveryRelease(tabId) {
    if (this.disposed || !this.readRecoveryRelease) return;
    for (const item of this.db.prepare("SELECT * FROM agent_send_queue WHERE tab_id=? AND state='recovery-deferred'").all(tabId)) {
      const proof = JSON.parse(item.recovery_defer_json || 'null');
      if (!proof || proof.releasedBy) continue;
      const releasedBy = this.readRecoveryRelease(proof);
      if (!releasedBy) continue;
      this.db.prepare("UPDATE agent_send_queue SET recovery_defer_json=? WHERE operation_key=? AND state='recovery-deferred' AND recovery_defer_json=?")
        .run(JSON.stringify({ ...proof, releasedBy }), item.operation_key, item.recovery_defer_json);
    }
  }

  queueInfo(operationKey) {
    const item = this.item(operationKey), record = this.store.get(operationKey);
    if (!item || !record) return null;
    const retryWaiting = waitingBeforeInput(record, item, JSON.parse(item.request_json));
    return { version: 1, id: item.id, state: item.state, queuedAt: item.created_at,
      inputSlot: sendInputSlot(record, item),
      position: item.queue_position ?? item.id, mergePrevious: this.mergeGuard(operationKey),
      ...(retryWaiting ? { waitingBeforeInput: true, lastNoWriteAttemptId: record.attemptId } : {}),
      ...(item.merge_json ? { merge: JSON.parse(item.merge_json) } : {}),
      ...(item.release_json ? { release: JSON.parse(item.release_json) } : {}),
    };
  }

  mergePair(operationKey) {
    const item = this.item(operationKey), record = this.store.get(operationKey);
    if (!item) return null;
    const current = JSON.parse(item.request_json);
    if (!mergeableQueuedSend(item, record, current)) return null;
    const before = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id=? AND state IN ${OPEN}
      AND (COALESCE(queue_position,id) < ? OR (COALESCE(queue_position,id)=? AND id<?))
      ORDER BY COALESCE(queue_position,id) DESC,id DESC LIMIT 1`)
      .get(item.tab_id, item.queue_position ?? item.id, item.queue_position ?? item.id, item.id);
    const prior = before && this.store.get(before.operation_key);
    const previous = before && JSON.parse(before.request_json);
    if (!before || !mergeableQueuedSend(before, prior, previous) || prior.provider !== record.provider
      || prior.sessionId !== record.sessionId || !queuedSendMergeCompatible(previous, current)) return null;
    // The head may still be awaiting asynchronous admission with state=waiting.
    // It is owned by the current pump even before beginAttempt.
    const head = this.db.prepare(`SELECT operation_key FROM agent_send_queue WHERE tab_id=? AND state IN ${OPEN}
      ORDER BY ${ORDER} LIMIT 1`).get(item.tab_id);
    if (this.running.has(item.tab_id) && [item.operation_key, before.operation_key].includes(head?.operation_key)) return null;
    return { item, before, record, prior, current, previous };
  }

  mergeGuard(operationKey) {
    const pair = this.mergePair(operationKey);
    return pair ? { version: 1, tabId: pair.item.tab_id,
      operationKey: pair.item.operation_key, queueId: pair.item.id, requestHash: pair.item.request_hash,
      previousOperationKey: pair.before.operation_key, previousQueueId: pair.before.id, previousRequestHash: pair.before.request_hash } : null;
  }

  readMerge(requestId, tabId) {
    const row = this.db.prepare('SELECT response_json FROM agent_send_queue_merges WHERE request_id=?').get(requestId);
    if (!row) return null;
    const receipt = JSON.parse(row.response_json);
    if (receipt.tabId !== tabId) return null;
    const record = this.projectRecord(this.store.get(receipt.operationKey));
    return { ...receipt, record: record || null, ...(!record ? { receiptRetired: true } : {}) };
  }

  async mergeWaiting(request) {
    const reject = code => ({ success: false, disposition: 'not-applied', code, requestId: request?.requestId });
    const allowed = ['version', 'requestId', 'tabId', 'operationKey', 'queueId', 'requestHash',
      'previousOperationKey', 'previousQueueId', 'previousRequestHash'];
    if (!request || request.version !== 1 || Object.keys(request).some(key => !allowed.includes(key))
      || ['requestId', 'tabId', 'operationKey', 'requestHash', 'previousOperationKey', 'previousRequestHash']
        .some(key => typeof request[key] !== 'string' || !request[key] || request[key].length > 8192)
      || !Number.isSafeInteger(request.queueId) || !Number.isSafeInteger(request.previousQueueId)) return reject('send_queue_merge_identity_required');
    const signature = fingerprintAgentSendRequest(request);
    const replay = () => {
      const old = this.db.prepare('SELECT * FROM agent_send_queue_merges WHERE request_id=?').get(request.requestId);
      if (!old) return null;
      return old.request_hash === signature ? this.readMerge(request.requestId, request.tabId)
        : reject('send_queue_merge_request_conflict');
    };
    const saved = replay(); if (saved) return saved;
    const matches = () => fingerprintAgentSendRequest(this.mergeGuard(request.operationKey))
      === fingerprintAgentSendRequest(Object.fromEntries(allowed.filter(key => key !== 'requestId').map(key => [key, request[key]])));
    if (this.disposed || !matches()) return reject('send_queue_merge_no_longer_waiting');
    const pair = this.mergePair(request.operationKey);
    let composed;
    try { composed = await composeQueuedSendMerge({ left: pair.previous, right: pair.current,
      leftRecord: pair.prior, rightRecord: pair.record, requestId: request.requestId }); }
    catch (error) { return reject(error.code || 'send_queue_merge_authoring_unavailable'); }
    let result;
    this.admitting++;
    try {
      result = this.db.transaction(() => {
        const existing = replay(); if (existing) return existing;
        if (this.disposed || !matches()) return reject('send_queue_merge_no_longer_waiting');
        const originalKeys = [pair.before.operation_key, pair.item.operation_key];
        // Reserve the replacement at the predecessor's position. Originals
        // keep their immutable requests and truthful no-input receipts.
        this.db.prepare(`UPDATE agent_send_queue SET state='merged',updated_at=? WHERE operation_key IN (?,?)`)
          .run(Date.now(), ...originalKeys);
        const admitted = this.enqueue({ identity: composed.identity, request: composed.request });
        if (!admitted.ok || !admitted.item) throw Object.assign(new Error('merge admission failed'), { code: admitted.code });
        const key = composed.identity.operationKey;
        // The replacement owns these bytes before either old presentation is
        // dismissed. Keep the same atomic FIFO/immutable merge boundary.
        protectQueueAssets(this.db, key, [...new Set([pair.before, pair.item]
          .flatMap(item => JSON.parse(item.asset_transfer_ids_json || '[]')))]);
        this.db.prepare('UPDATE agent_send_queue SET queue_position=?,created_at=?,predecessor_key=?,merge_json=? WHERE operation_key=?')
          .run(pair.before.queue_position ?? pair.before.id, pair.before.created_at, pair.before.predecessor_key,
            JSON.stringify({ version: 1, requestId: request.requestId, sourceOperationKeys: originalKeys,
              presentationHandoffId: pair.before.merge_json ? JSON.parse(pair.before.merge_json).presentationHandoffId : pair.prior.handoffId }), key);
        if (admitted.item.predecessor_key) this.store.unpinForOwner(admitted.item.predecessor_key, 'send-queue-successor:' + key);
        if (pair.before.predecessor_key) this.store.pinForOwner(pair.before.predecessor_key, 'send-queue-successor:' + key);
        const followers = this.db.prepare(`SELECT * FROM agent_send_queue WHERE state IN ${OPEN} AND predecessor_key IN (?,?)`).all(...originalKeys);
        for (const follower of followers) {
          this.store.unpinForOwner(follower.predecessor_key, 'send-queue-successor:' + follower.operation_key);
          this.store.pinForOwner(key, 'send-queue-successor:' + follower.operation_key);
          this.db.prepare('UPDATE agent_send_queue SET predecessor_key=? WHERE operation_key=?').run(key, follower.operation_key);
        }
        this.transferMergedContext?.({ tabId: request.tabId, requests: [pair.previous, pair.current], request: composed.request });
        for (const item of [pair.before, pair.item]) {
          this.db.prepare('INSERT INTO agent_send_queue_merge_sources VALUES(?,?,?)')
            .run(item.operation_key, key, item.request_hash);
          const settled = this.store.settleQueuedNoWrite(item.operation_key, { cancelled: true,
            code: 'send_queue_merged', mergedIntoOperationKey: key,
            presentationDismissedAt: Date.now(), presentationDismissedSurface: 'desktop-history' });
          if (!settled.ok) throw new Error('merge source changed');
          if (item.predecessor_key) this.store.unpinForOwner(item.predecessor_key, 'send-queue-successor:' + item.operation_key);
          this.releasePresentation(item.operation_key);
        }
        const receipt = { success: true, version: 1, requestId: request.requestId, tabId: request.tabId,
          operationKey: key, handoffId: composed.identity.handoffId, sourceOperationKeys: originalKeys,
          sourceHandoffIds: [pair.prior.handoffId, pair.record.handoffId] };
        this.db.prepare('INSERT INTO agent_send_queue_merges VALUES(?,?,?)')
          .run(request.requestId, signature, JSON.stringify(receipt));
        return receipt;
      })();
    } catch (error) { result = reject(error.code || 'send_queue_merge_storage_failed'); }
    finally { this.admitting--; }
    if (!result.success) return result;
    for (const key of result.sourceOperationKeys) { this.executors.delete(key); this.resolveWaiters(key); }
    const full = this.readMerge(result.requestId, result.tabId);
    if (this.publishMerge) this.publishMerge(full);
    else { for (const key of result.sourceOperationKeys) this.publishRecord(this.store.get(key)); this.publishRecord(full.record); }
    this.publishNextWaiting(this.item(result.operationKey));
    this.wake(request.tabId);
    return full;
  }

  // Main's pre-paste gate calls this only after proving that this invocation
  // wrote nothing. Never infer this permission from a renderer error/timeout.
  certifyAutomaticReadinessWait({ tabId, handoffId, operationKey, attemptId }, receipt) {
    const item = this.item(operationKey), record = this.store.get(operationKey);
    if (!item || item.state !== 'dispatching' || (!this.running.has(tabId) && !this.dispatchOwners.has(tabId))
      || record?.state !== 'in-flight' || record.provider !== 'codex' || !attemptId || record.attemptId !== attemptId
      || record.tabId !== tabId || record.handoffId !== handoffId
      || !isAutomaticPromptQueueRequest(JSON.parse(item.request_json))) return receipt;
    const certified = { ...receipt, enterWritten: false, automaticReadinessWait: 1 };
    if (!isAutomaticReadinessWaitReceipt(certified) || receipt.enterWritten === true) return receipt;
    const settled = this.store.settleAttempt(operationKey, attemptId, certified);
    return settled.applied ? certified : receipt;
  }

  async releaseUnknownHead(request) {
    const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
    if (!request || Object.keys(request).some(key => !['tabId', 'operationKey', 'attemptId', 'requestId', 'acknowledgeDeliveryUnknown'].includes(key))
      || ['tabId', 'operationKey', 'attemptId', 'requestId'].some(key => typeof request[key] !== 'string' || !request[key].trim())
      || request.acknowledgeDeliveryUnknown !== true) fail('send_queue_release_identity_required', 400);
    const replay = () => {
      const item = this.item(request.operationKey);
      const record = this.store.get(request.operationKey);
      if (!item || item.tab_id !== request.tabId || record?.tabId !== request.tabId) fail('send_queue_release_not_found', 404);
      if (record.attemptId !== request.attemptId) fail('send_queue_release_attempt_changed');
      if (!item.release_json) return null;
      const release = JSON.parse(item.release_json);
      if (release.requestId !== request.requestId || release.attemptId !== request.attemptId) fail('send_queue_release_request_conflict');
      return { released: true, idempotent: true, release, record };
    };
    const prior = replay();
    if (prior) return prior;
    if (this.disposed || typeof this.reconcile !== 'function') fail('send_queue_release_unavailable', 503);
    const audited = await this.reconcile({ tabId: request.tabId, operationKey: request.operationKey, attemptId: request.attemptId });
    const result = this.db.transaction(() => {
      const repeated = replay();
      if (repeated) return repeated;
      const record = this.store.get(request.operationKey);
      if (consumed(record)) return { released: false, confirmed: true, record };
      const unresolvedNativeQueue = record.state === 'audit-pending' && record.receipt?.submitted === true
        && ['unknown', 'absent'].includes(audited?.reconciliation?.decision)
        && audited.reconciliation.confirmed !== true;
      if (record.state !== 'delivery-unknown' && !unresolvedNativeQueue) fail('send_queue_release_requires_unknown');
      if (this.running.has(request.tabId) || this.dispatchOwners.has(request.tabId)) fail('send_queue_release_executor_running');
      const head = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ? AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(request.tabId);
      if (head?.operation_key !== request.operationKey || head.state !== 'awaiting-receipt') fail('send_queue_release_not_head');
      const release = { requestId: request.requestId, operationKey: request.operationKey, attemptId: request.attemptId,
        kind: 'continue-despite-delivery-unknown', releasedAt: Date.now(), deliveryState: record.state,
        submitted: record.receipt?.submitted ?? null };
      const changed = this.db.prepare(`UPDATE agent_send_queue SET state = 'released-unknown', release_json = ?, updated_at = ?
        WHERE operation_key = ? AND state = 'awaiting-receipt' AND release_json IS NULL`)
        .run(JSON.stringify(release), release.releasedAt, request.operationKey);
      if (changed.changes !== 1) fail('send_queue_release_state_changed');
      return { released: true, idempotent: false, release, record };
    })();
    this.resolveWaiters(request.operationKey);
    this.publishRecord(result.record);
    this.wake(request.tabId);
    return result;
  }

  enqueue({ identity, request, execute, retryNoInputAttemptId = null, retryCompletionNoInput = false, retryOperationalNoInput = false }) {
    // A function is only a current-process preparation callback. The immutable
    // JSON request is the recovery source; it contains no live UI references.
    const snapshot = JSON.parse(JSON.stringify(request));
    if (snapshot.ownedAttachments && !validateOwnedAttachmentSnapshot(snapshot.ownedAttachments, snapshot.prompt, identity)) {
      return { ok: false, code: 'attachment_snapshot_invalid' };
    }
    const requestHash = fingerprintAgentSendRequest(snapshot);
    let admitted;
    this.admitting += 1;
    try { admitted = this.db.transaction(() => {
      const existing = this.item(identity.operationKey);
      if (existing) {
        if (existing.request_hash !== requestHash) return { ok: false, action: 'conflict', code: 'agent_send_handoff_conflict' };
        const record = this.store.get(identity.operationKey);
        if (existing.state === 'recovery-deferred') {
          const proof = JSON.parse(existing.recovery_defer_json || 'null');
          const released = proof && this.readRecoveryRelease?.(proof);
          if (!record?.attemptId && !record?.deliveryControl?.cancelledAt
            && ['reserved', 'preparing'].includes(record?.state) && proof?.requestHash === requestHash && released) {
            const position = this.db.prepare('SELECT MAX(COALESCE(queue_position,id)) n FROM agent_send_queue WHERE tab_id=?').get(existing.tab_id).n + 1;
            // Re-admit the SAME immutable request only after Main's natural
            // proof and a new current Root demand; never auto-rearm on release.
            this.db.prepare("UPDATE agent_send_queue SET state='waiting',queue_position=?,updated_at=? WHERE operation_key=? AND state='recovery-deferred'")
              .run(position, Date.now(), identity.operationKey);
            return { ok: true, item: this.item(identity.operationKey), record, replayed: true, retryQueued: true };
          }
          return { ok: true, item: existing, record, replayed: true };
        }
        if (existing.state === 'failed' && (retryNoInputAttemptId
          && record?.attemptId === retryNoInputAttemptId && isTabMessageNoInputReceipt(record)
          || retryCompletionNoInput === true && isExternalCompletionNoInputReceipt(record, snapshot)
          || retryOperationalNoInput === true && isExternalOperationalNoInputReceipt(record, snapshot))) {
          const reservation = this.store.reserveOrGet(identity, { queuedAdmission: true });
          if (!reservation.ok) return reservation;
          // The message owner requested recovery after a proven no-input
          // refusal. Keep its immutable request/ID; join behind current work.
          const predecessor = this.db.prepare(`SELECT operation_key FROM agent_send_queue
            WHERE tab_id=? AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(existing.tab_id);
          const position = this.db.prepare('SELECT MAX(COALESCE(queue_position,id)) n FROM agent_send_queue WHERE tab_id=?')
            .get(existing.tab_id).n + 1;
          this.db.prepare("UPDATE agent_send_queue SET state='waiting',queue_position=?,predecessor_key=?,updated_at=? WHERE operation_key=? AND state='failed'")
            .run(position, predecessor?.operation_key || null, Date.now(), identity.operationKey);
          if (predecessor) this.store.pinForOwner(predecessor.operation_key, 'send-queue-successor:' + identity.operationKey);
          return { ok: true, item: this.item(identity.operationKey), record, replayed: true, retryQueued: true };
        }
        return { ok: true, item: existing, record: this.store.get(identity.operationKey), replayed: true };
      }
      const mergedSource = this.db.prepare('SELECT * FROM agent_send_queue_merge_sources WHERE operation_key=?').get(identity.operationKey);
      if (mergedSource) return { ok: false, code: mergedSource.request_hash === requestHash
        ? 'send_queue_merged' : 'agent_send_handoff_conflict', action: 'merged' };
      if (isAutomaticPromptQueueRequest(snapshot) && snapshot.promptQueueIntent.baseHandoffId) {
        const base = snapshot.promptQueueIntent.baseHandoffId;
        const priors = this.db.prepare(`SELECT operation_key FROM agent_send_queue WHERE tab_id = ?
          AND (operation_key = ? OR json_extract(request_json, '$.promptQueueIntent.baseHandoffId') = ?)`).all(
          identity.tabId, `history:${identity.tabId}:${base}`, base);
        for (const prior of priors) {
          const receipt = this.store.get(prior.operation_key);
          if (!receipt || receipt.state !== 'not-submitted' || receipt.receipt?.submitted !== false
            || receipt.receipt?.pasteWritten === true || receipt.receipt?.enterWritten === true) {
            return { ok: false, code: 'automatic_previous_delivery_unresolved' };
          }
        }
      }
      const reserved = this.store.reserveOrGet(identity, { queuedAdmission: true });
      if (!reserved.ok) return reserved;
      // Only discard completed presentation payloads after the canonical
      // receipt retention policy has already removed their owner. Failed
      // application drafts stay pinned until explicit dismissal.
      this.db.prepare(`DELETE FROM agent_send_queue WHERE state NOT IN ${OPEN}
        AND NOT EXISTS (SELECT 1 FROM agent_send_receipts r WHERE r.operation_key = agent_send_queue.operation_key)`).run();
      // Source aliases may still be used by canonical History after the send
      // receipt retires. They do not pin bytes; the asset owner's GC removes
      // unreferenced bytes and then retires these read-only aliases.
      // An already crossed operation is a receipt replay, never a new queue item.
      if (reserved.record.deliveryControl?.cancelledAt || reserved.record.attemptId || !['reserved','preparing'].includes(reserved.record.state)) {
        return { ok: true, record: reserved.record, replayed: true, item: null };
      }
      const now = Date.now();
      const assetIds = [...new Set([...(snapshot.presentationSnapshot?.imagePaths || []),
        ...(snapshot.authoringSnapshot?.imagePaths || []), ...(snapshot.ownedAttachments?.refs || [])]
        .map(image => image.assetId).filter(Boolean))];
      const predecessor = this.db.prepare(`SELECT operation_key FROM agent_send_queue
        WHERE tab_id = ? AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(identity.tabId);
      this.db.prepare(`INSERT INTO agent_send_queue
        (operation_key,tab_id,request_hash,request_json,asset_ids_json,predecessor_key,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?, 'waiting',?,?)`).run(identity.operationKey, identity.tabId,
        requestHash, JSON.stringify(snapshot), JSON.stringify(assetIds), predecessor?.operation_key || null, now, now);
      // A warm Loop/queue may carry only a session expectation. Capture its
      // original physical owner ONCE at admission, never by retargeting replay.
      // This read-side pin grants no write/readiness/Stop authority.
      let recoveryOwner = null;
      if (identity.provider === 'codex' && (isAutomaticPromptQueueRequest(snapshot)
        || require('./prompt-queue-source').isPromptLoopAutomationSource(snapshot.source))) {
        try { recoveryOwner = this.captureRecoveryOwner?.(snapshot); }
        catch (error) { console.warn('[AgentSendQueue] recovery birth pin unavailable tab='
          + String(identity.tabId).slice(-12) + ' reason=' + String(error?.code || error?.message)); }
      }
      if (recoveryOwner?.known === true && recoveryOwner.toolType === identity.provider
        && recoveryOwner.sessionId === snapshot.expectedTarget?.sessionId
        && recoveryOwner.runtime?.writerConfirmed === true && recoveryOwner.runtime.liveLifecycle === true
        && recoveryOwner.runtime.lifecycleGeneration) {
        this.db.prepare('UPDATE agent_send_queue SET recovery_owner_json=? WHERE operation_key=?')
          .run(JSON.stringify({ version: 1, sessionId: recoveryOwner.sessionId,
            lifecycleGeneration: recoveryOwner.runtime.lifecycleGeneration, requestHash }), identity.operationKey);
      }
      const insertAsset = this.db.prepare('INSERT INTO agent_send_queue_assets '
        + '(operation_key, occurrence, source_key, source_path, asset_id, ref_json) VALUES (?,?,?,?,?,?)');
      for (const [index, ref] of (snapshot.ownedAttachments?.refs || []).entries()) {
        insertAsset.run(identity.operationKey, index, ref.sourceKey, ref.sourcePath, ref.assetId, JSON.stringify(ref));
      }
      this.store.pinForOwner(identity.operationKey, 'application-send-queue');
      if (predecessor) this.store.pinForOwner(predecessor.operation_key, 'send-queue-successor:' + identity.operationKey);
      this.store.stageQueuedRequest(identity.operationKey, {
        promptText: snapshot.prompt, presentationSnapshot: snapshot.presentationSnapshot || null,
        authoringSnapshot: snapshot.authoringSnapshot || null,
        ...(snapshot.ownedAttachments ? { ownedAttachments: snapshot.ownedAttachments } : {}),
      });
      adoptRunAfterItemAssets(this.db, identity, snapshot);
      return { ok: true, item: this.item(identity.operationKey), record: this.store.get(identity.operationKey) };
    })(); } catch (error) {
      console.warn('[AgentSendQueue] admission storage failed tab=' + String(identity.tabId).slice(-12)
        + ' operation=' + String(identity.operationKey).slice(0, 90)
        + ' sqliteCode=' + String(error?.code || 'unknown').slice(0, 80)
        + ' inTransaction=' + (this.db.inTransaction === true)
        + ' reason=' + String(error?.message || error).slice(0, 220));
      throw Object.assign(new Error('Application send queue could not persist admission'), {
        code: 'agent_send_queue_storage_failed', statusCode: 503,
        submitted: false, pasteWritten: false, enterWritten: false, cause: error,
      });
    } finally { this.admitting -= 1; }
    if (!admitted.ok || !admitted.item) return admitted;
    if (execute && admitted.item.state === 'waiting') this.executors.set(identity.operationKey, execute);
    this.publishRecord(admitted.record);
    this.wake(identity.tabId);
    return { ...admitted, receipt: applicationQueueReceipt(admitted.record, admitted.item) };
  }

  publishNextWaiting(item) {
    if (!item) return;
    const next = this.db.prepare(`SELECT operation_key FROM agent_send_queue WHERE tab_id=? AND state IN ${OPEN}
      AND (COALESCE(queue_position,id)>? OR (COALESCE(queue_position,id)=? AND id>?)) ORDER BY ${ORDER} LIMIT 1`)
      .get(item.tab_id, item.queue_position ?? item.id, item.queue_position ?? item.id, item.id);
    if (next) this.publishRecord(this.store.get(next.operation_key), false);
  }

  publishRecord(record, includeNext = true) {
    if (this.admitting > 0) return;
    const projection = this.projectRecord(record);
    if (projection?.applicationQueue) {
      try { this.publish(projection); }
      catch (error) { console.warn('[AgentSendQueue] publication failed operation='
        + record.operationKey.slice(0, 90) + ' error=' + error.message); }
    }
    if (includeNext) this.publishNextWaiting(this.item(record.operationKey));
  }

  projectRecord(record) {
    if (!record) return;
    const item = this.item(record.operationKey);
    if (!item) return record;
    const request = JSON.parse(item.request_json);
    const returnControl = historySendReturnControl(this.store);
    if (!record.attemptId && item.state === 'waiting' && request.source === 'history-panel'
      && request.authoringSnapshot && !returnControl.read(record.tabId, record.handoffId)) {
      returnControl.register({ tabId: record.tabId, handoffId: record.handoffId, provider: record.provider,
        token: require('node:crypto').randomUUID() }, { allowUnattemptedQueue: true });
    }
    return { ...record, historyReturn: returnControl.read(record.tabId, record.handoffId),
      inputSlot: sendInputSlot(record, item), receipt: { promptText: request.prompt,
      presentationSnapshot: request.presentationSnapshot, authoringSnapshot: request.authoringSnapshot,
      ...(request.ownedAttachments ? { ownedAttachments: request.ownedAttachments,
        attachmentOwnership: attachmentOwnershipReceipt(request.ownedAttachments) } : {}),
      source: request.source, ...(record.receipt || {}), ...(this.projectPresentation?.(record) || {}) }, applicationQueue: {
      version: 1, id: item.id, state: item.state, queuedAt: item.created_at,
      position: item.queue_position ?? item.id, mergePrevious: this.mergeGuard(item.operation_key),
      ...(item.merge_json ? { merge: JSON.parse(item.merge_json) } : {}),
      ...(waitingBeforeInput(record, item, request)
        ? { waitingBeforeInput: true, lastNoWriteAttemptId: record.attemptId } : {}),
      ...(item.release_json ? { release: JSON.parse(item.release_json) } : {}),
      ...(item.recovery_defer_json ? { capacityRecovery: JSON.parse(item.recovery_defer_json) } : {}),
    } };
  }

  armPreparationExpiry(item, record, clock = unattemptedHeadPreparation(record, item)) {
    if (!clock || record.attemptId || !['reserved', 'preparing'].includes(record.state)
      || !['waiting', 'dispatching'].includes(item?.state) || record.deliveryControl?.cancelledAt) return;
    const key = record.operationKey, existing = this.preparationExpiries.get(key);
    if (existing?.deadlineAt === clock.deadlineAt) return;
    if (existing) this.clearTimer(existing.timer);
    const entry = { deadlineAt: clock.deadlineAt, timer: null };
    entry.timer = this.setTimer(() => {
      if (this.disposed || this.preparationExpiries.get(key) !== entry) return;
      this.preparationExpiries.delete(key);
      try {
        const current = this.store.get(key), queued = this.item(key), currentClock = unattemptedHeadPreparation(current, queued);
        if (!current || current.attemptId || !['reserved', 'preparing'].includes(current.state)
          || current.deliveryControl?.cancelledAt || !['waiting', 'dispatching'].includes(queued?.state)
          || !currentClock || currentClock.deadlineAt !== entry.deadlineAt || this.now() < entry.deadlineAt) return;
        // Failure-only deadline. It cannot call a producer or grant ready;
        // later store publication merely releases the terminal no-input row.
        this.store.settleQueuedNoWrite(key, { success: false, submitted: false,
          pasteWritten: false, enterWritten: false, code: 'agent_send_preparation_expired', error: 'agent_send_preparation_expired' });
      } catch (error) {
        this.parked.add(item.tab_id);
        console.warn('[AgentSendQueue] preparation expiry storage unavailable tab=' + String(item.tab_id).slice(-12)
          + ' code=' + (error.code || 'unknown'));
      }
    }, Math.max(0, clock.deadlineAt - this.now()));
    entry.timer?.unref?.();
    this.preparationExpiries.set(key, entry);
  }

  observe(record) {
    if (!record || this.admitting > 0 || this.disposed) return;
    const item = this.item(record.operationKey);
    if (!item) return;
    this.armPreparationExpiry(item, record);
    const request = JSON.parse(item.request_json);
    if (!record.deliveryControl?.cancelledAt
      && (waitingBeforeInput(record, item, request)
        || item.state === 'dispatching' && isAutomaticNoWriteWait(record, request)
        || ['dispatching', 'awaiting-receipt'].includes(item.state) && isExternalOperationalNoInputReceipt(record, request))) {
      this.db.prepare("UPDATE agent_send_queue SET state = 'waiting', updated_at = ? WHERE operation_key = ?")
        .run(Date.now(), item.operation_key);
      this.parked.add(item.tab_id);
      this.publishRecord(record);
      return; // only a later runtime/queue wake can release this no-input wait
    }
    // A receipt can complete before the bridge returns. Running still holds
    // the physical scenario until its finally, even after this exact promotion.
    if (consumed(record) || FAILED.has(record.state)) {
      this.finish(item, consumed(record) ? 'completed' : record.deliveryControl?.cancelledAt ? 'cancelled' : 'failed');
      if (historySendReturnControl(this.store).read(record.tabId, record.handoffId)?.state === 'restored') {
        this.store.dismissPresentation({ operationKey: record.operationKey, attemptId: record.attemptId,
          tabId: record.tabId, handoffId: record.handoffId, surface: 'desktop-history' });
        this.releasePresentation(record.operationKey);
      }
    }
    this.publishRecord(record);
    this.wake(item.tab_id);
  }

  result(operationKey) {
    const item = this.item(operationKey);
    const record = this.store.get(operationKey);
    if (!item || item.state !== 'waiting' && !this.running.has(item.tab_id)) {
      return Promise.resolve(record);
    }
    return new Promise(resolve => {
      const waiters = this.waiters.get(operationKey) || [];
      waiters.push(resolve);
      this.waiters.set(operationKey, waiters);
    });
  }

  resolveWaiters(operationKey) {
    const record = this.store.get(operationKey);
    for (const resolve of this.waiters.get(operationKey) || []) resolve(record);
    this.waiters.delete(operationKey);
  }

  finish(item, state) {
    const expiry = this.preparationExpiries.get(item.operation_key);
    if (expiry) { this.clearTimer(expiry.timer); this.preparationExpiries.delete(item.operation_key); }
    this.db.prepare(`UPDATE agent_send_queue SET state = ?, updated_at = ? WHERE operation_key = ?
      AND (state IN ${OPEN} OR state='recovery-deferred'${state === 'completed' ? " OR state = 'released-unknown'" : ''})`)
      .run(state, Date.now(), item.operation_key);
    this.executors.delete(item.operation_key);
    // Failed/Stop-cancelled drafts remain recoverable until explicit dismissal.
    if (state === 'completed') this.store.unpinForOwner(item.operation_key, 'application-send-queue');
    if (state === 'completed') adoptCompletedQueueTransfers(this.db, item.operation_key);
    if (item.predecessor_key) this.store.unpinForOwner(item.predecessor_key, 'send-queue-successor:' + item.operation_key);
    const record = this.store.get(item.operation_key);
    if (hiddenSendPresentation(record)) this.releasePresentation(item.operation_key);
    if (consumed(record) || FAILED.has(record?.state)) this.resolveWaiters(item.operation_key);
  }

  wake(tabId) {
    if (this.disposed || this.scheduled.has(tabId)) return;
    if (this.running.has(tabId)) { this.rerun.add(tabId); return; }
    this.scheduled.add(tabId);
    queueMicrotask(() => {
      this.scheduled.delete(tabId);
      void this.pump(tabId).catch(error => console.warn('[AgentSendQueue] pump failed tab='
        + String(tabId).slice(-12) + ' error=' + error.message));
    });
  }

  retireObsoleteInputSlot(tabId) {
    if (this.disposed || this.running.has(tabId) || this.dispatchOwners.has(tabId)) return Promise.resolve(false);
    const existing = this.slotObservations.get(tabId);
    if (existing) return existing;
    const item = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(tabId);
    const record = item && this.store.get(item.operation_key);
    const cancellationRetires = classifyInputSlotRetirement(record, null).retire;
    if (!record?.attemptId || !['dispatching', 'awaiting-receipt'].includes(item.state)
      || (!cancellationRetires && typeof this.readInputSlot !== 'function')) return Promise.resolve(false);
    let retired = false;
    const work = Promise.resolve().then(async () => {
      const observation = cancellationRetires ? null : await this.readInputSlot(record);
      if (this.disposed || this.running.has(tabId) || this.dispatchOwners.has(tabId)) return false;
      const result = this.db.transaction(() => {
        const current = this.store.get(item.operation_key);
        const head = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
          AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(tabId);
        if (head?.operation_key !== item.operation_key || current?.attemptId !== record.attemptId
          || consumed(current) || this.running.has(tabId) || this.dispatchOwners.has(tabId)) return false;
        if (!classifyInputSlotRetirement(current, null).retire
          && (typeof observation?.isCurrent !== 'function' || observation.isCurrent() !== true)) return false;
        const decision = classifyInputSlotRetirement(current, observation);
        if (!decision.retire) return false;
        const release = { version: 1, kind: 'input-slot-retired', reason: decision.reason,
          operationKey: current.operationKey, attemptId: current.attemptId, retiredAt: Date.now(),
          deliveryState: current.state, submitted: current.receipt?.submitted ?? null,
          observedOwner: observation?.owner || null, processStatus: observation?.processStatus || null };
        const changed = this.db.prepare(`UPDATE agent_send_queue SET state='released-unknown',
          slot_release_json=?,updated_at=? WHERE operation_key=? AND state IN ${OPEN}`)
          .run(JSON.stringify(release), release.retiredAt, item.operation_key);
        return changed.changes === 1 ? current : false;
      })();
      if (!result) return false;
      retired = true;
      this.executors.delete(item.operation_key);
      this.resolveWaiters(item.operation_key);
      this.publishRecord(result);
      console.log('[AgentSendQueue] input-slot retired tab=' + String(tabId).slice(-12)
        + ' operation=' + item.operation_key.slice(0, 90) + ' delivery=' + result.state
        + ' reason=' + JSON.parse(this.item(item.operation_key).slot_release_json).reason);
      return true;
    }).catch(error => {
      console.warn('[AgentSendQueue] input-slot observation unknown tab=' + String(tabId).slice(-12)
        + ' operation=' + item.operation_key.slice(0, 90) + ' error=' + error.message);
      return false;
    }).finally(() => {
      if (this.slotObservations.get(tabId) === work) this.slotObservations.delete(tabId);
      const changedWhileReading = this.slotDirty.delete(tabId);
      if (retired) this.slotWakeSignatures.delete(tabId);
      if ((retired || changedWhileReading) && !this.disposed) this.wake(tabId);
    });
    this.slotObservations.set(tabId, work);
    return work;
  }

  notifyRuntime(tabId, slotSignature = null) {
    if (this.disposed) return;
    if (this.running.has(tabId) || this.parked.has(tabId)) {
      this.runtimeWakeRevisions.set(tabId, (this.runtimeWakeRevisions.get(tabId) || 0) + 1);
    }
    // Only tabs with an unresolved physical head require this bounded read.
    // It is event driven and coalesced; runtime events never retry old input.
    const changed = slotSignature === null || this.slotWakeSignatures.get(tabId) !== slotSignature;
    if (changed) {
      if (slotSignature !== null) {
        this.slotWakeSignatures.set(tabId, slotSignature);
        if (this.slotWakeSignatures.size > 4096) this.slotWakeSignatures.delete(this.slotWakeSignatures.keys().next().value);
      }
      if (this.slotObservations.has(tabId)) this.slotDirty.add(tabId);
      else void this.retireObsoleteInputSlot(tabId);
    }
    for (const owner of this.parked) {
      if (owner === tabId) { this.wake(owner); continue; }
      const item = this.db.prepare(`SELECT request_json FROM agent_send_queue WHERE tab_id = ?
        AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(owner);
      if (item && JSON.parse(item.request_json).promptQueueIntent?.triggerTabId === tabId) this.wake(owner);
    }
  }

  resume() {
    if (this.disposed) return;
    // Older versions terminalized a proven pre-input operational refusal.
    // Restore only that exact immutable request to the existing FIFO; the
    // operational owner is checked again by the real executor before input.
    for (const row of this.db.prepare("SELECT operation_key,request_json FROM agent_send_queue WHERE state='failed' AND json_type(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.operationalNoticeRef')='object'").all()) {
      const request = JSON.parse(row.request_json), record = this.store.get(row.operation_key);
      if (!isExternalOperationalNoInputReceipt(record, request)) continue;
      this.enqueue({ request, retryOperationalNoInput: true, identity: {
        operationKey: record.operationKey, surface: record.surface, runId: record.runId, tabId: record.tabId,
        handoffId: record.handoffId, provider: record.provider, sessionId: record.sessionId,
        requestFingerprint: record.requestFingerprint, promptHash: record.promptHash, promptLength: record.promptLength,
      } });
    }
    for (const row of this.db.prepare(`SELECT DISTINCT tab_id FROM agent_send_queue WHERE state IN ${OPEN}`).all()) {
      this.wake(row.tab_id);
    }
  }

  async pump(tabId) {
    if (this.disposed || this.running.has(tabId) || !this.ready()) return;
    let item = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ${OPEN} ORDER BY ${ORDER} LIMIT 1`).get(tabId);
    if (!item) return;
    const record = this.store.get(item.operation_key);
    if (!record) return; // Losing a receipt is not proof that input was untouched.
    const oldDispatch = this.dispatchOwners.get(tabId);
    if (oldDispatch) { oldDispatch.waiters.add(this); this.parked.add(tabId); return; }
    if (record.deliveryControl?.cancelledAt && !record.attemptId) {
      try {
        this.finish(item, 'cancelled');
        this.store.settleQueuedNoWrite(item.operation_key, { cancelled: true,
          code: 'agent_send_queue_cancelled', error: 'Send cancelled before terminal input' });
      } catch (error) {
        if (!/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(String(error.code || ''))) throw error;
        this.parked.add(tabId); return;
      }
      this.wake(tabId);
      return;
    }
    // A terminated Main or a failed parking CAS may leave only pre-attempt
    // preparation dispatching. With no live executor and no possible input,
    // restore its original waiting position; never touch attempted/UNKNOWN.
    if (item.state === 'dispatching' && !record.attemptId && ['reserved', 'preparing'].includes(record.state)) {
      if (!exactUnattemptedDispatch(record, item)) { this.parked.add(tabId); return; }
      try {
        const changed = this.db.transaction(() => {
          if (!exactUnattemptedDispatch(this.store.get(item.operation_key), this.item(item.operation_key))) return false;
          return this.db.prepare("UPDATE agent_send_queue SET state='waiting',updated_at=? WHERE operation_key=? AND state='dispatching' AND request_hash=?")
            .run(Date.now(), item.operation_key, item.request_hash).changes === 1;
        })();
        if (!changed) return;
        item = this.item(item.operation_key);
      } catch (error) {
        if (!/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(String(error.code || ''))) throw error;
        this.parked.add(tabId);
        console.warn('[AgentSendQueue] pre-attempt parking storage unavailable tab=' + String(tabId).slice(-12));
        return; // Existing runtime wake retries only this guarded storage cut.
      }
    }
    const request = JSON.parse(item.request_json);
    const headClock = unattemptedHeadPreparation(record, item);
    if (headClock && this.now() >= headClock.deadlineAt) {
      try { this.store.settleQueuedNoWrite(item.operation_key, { success: false, submitted: false,
        pasteWritten: false, enterWritten: false, code: 'agent_send_preparation_expired', error: 'agent_send_preparation_expired' }); }
      catch (error) {
        if (!/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(String(error.code || ''))) throw error;
        this.parked.add(tabId); return;
      }
      this.wake(tabId); return;
    }
    this.armPreparationExpiry(item, record, headClock);
    const retryWaiting = !record.deliveryControl?.cancelledAt && waitingBeforeInput(record, item, request);
    if (consumed(record) || (FAILED.has(record.state) && !retryWaiting)) {
      this.observe(record);
      return;
    }
    if (!retryWaiting && (record.attemptId || !['reserved','preparing'].includes(record.state))) {
      await this.retireObsoleteInputSlot(tabId);
      return;
    }
    // Claim synchronously before calling any asynchronous scenario. An event or
    // a second client cannot launch another physical sender in this tab.
    this.running.add(tabId);
    const dispatchOwner = { queue: this, waiters: new Set() };
    this.dispatchOwners.set(tabId, dispatchOwner);
    const runtimeRevisionAtStart = this.runtimeWakeRevisions.get(tabId) || 0;
    let parked = false;
    let executorInvoked = false, storageBlockedBeforeExecutor = false, preparationDeferredBeforeAttempt = false;
    let releaseDispatch = null;
    try {
      const predecessor = item.predecessor_key ? this.store.get(item.predecessor_key) : null;
      const pinnedLaunch = !!request.expectedTarget?.terminalInstanceId && !!request.expectedTarget?.launchId;
      const inheritedSession = !request.expectedTarget?.sessionId && !pinnedLaunch && consumed(predecessor)
        ? predecessor.auditIdentity.sessionId : null;
      const executionScope = { requestFingerprint: record.requestFingerprint,
        ...(inheritedSession ? { expectedTarget: { ...request.expectedTarget,
          toolType: record.provider, sessionId: inheritedSession } } : {}) };
      if (this.admit) {
        this.parked.add(tabId);
        const admission = await this.admit(request);
        if (admission?.cancel === true) {
          this.cancelWaiting(tabId, record.handoffId, {
            reason: typeof admission.reason === 'string' && admission.reason
              ? admission.reason : 'automatic-admission-cancelled',
          });
          return;
        }
        if (!admission) { parked = true; return; }
        this.parked.delete(tabId);
      }
      if (this.disposed || !this.ready()) { parked = true; return; }
      // A typed capacity event can park this proven-unwritten item while the
      // admission await is in flight. Its old positive result cannot revive it.
      if (this.item(item.operation_key)?.state !== 'waiting') return;
      // Recheck synchronously AFTER asynchronous admission. A History intent
      // can reserve this tab while that await is pending. Keep this SAME item
      // waiting, with no attempt/PTY input, instead of failing or re-enqueuing.
      if (this.claimDispatch) {
        releaseDispatch = this.claimDispatch(request);
        if (!releaseDispatch) { this.parked.add(tabId); parked = true; return; }
      }
      let preparationMode = item.preparation_mode;
      if (!preparationMode) {
        // The budget choice and start have the same durable birth. A write
        // failure inside Web must not let a later inspection upgrade warm
        // to cold (or shorten an already selected cold preparation).
        preparationMode = 'warm';
        if (item.preparation_started_at == null) try {
          if (request.provider === 'codex' && this.capturePreparationMode?.(request) === 'cold-codex') {
            preparationMode = 'cold-codex';
          }
        } catch (error) {
          console.warn('[AgentSendPreparation] HEAD classification unavailable tab='
            + String(tabId).slice(-12) + ' code=' + String(error?.code || 'inspection-unavailable'));
        }
      }
      this.db.prepare('UPDATE agent_send_queue SET state = ?, updated_at = ?, preparation_started_at = COALESCE(preparation_started_at, ?), preparation_mode = COALESCE(preparation_mode, ?) WHERE operation_key = ?')
        .run('dispatching', Date.now(), this.now(), preparationMode, item.operation_key);
      this.armPreparationExpiry(this.item(item.operation_key), record);
      this.publishRecord(record);
      console.log('[AgentSendQueue] dispatch tab=' + String(tabId).slice(-12)
        + ' id=' + item.id + ' operation=' + item.operation_key.slice(0, 90));
      const executor = this.executors.get(item.operation_key);
      executorInvoked = true;
      const result = await (executor ? executor(executionScope) : this.execute(request, executionScope));
      preparationDeferredBeforeAttempt = isSendPreparationDeferred(result);
      const current = this.store.get(item.operation_key);
      if (preparationDeferredBeforeAttempt && exactUnattemptedDispatch(current, this.item(item.operation_key))) {
        const changed = this.db.prepare("UPDATE agent_send_queue SET state='waiting',updated_at=? WHERE operation_key=? AND state='dispatching' AND request_hash=?")
          .run(Date.now(), item.operation_key, item.request_hash);
        if (changed.changes === 1) {
          parked = true;
          this.parked.add(tabId);
          this.publishRecord(current, false);
          this.rerun.delete(tabId); // own publication is not a readiness wake
          if ((this.runtimeWakeRevisions.get(tabId) || 0) !== runtimeRevisionAtStart) this.rerun.add(tabId);
          console.log('[AgentSendQueue] preparation deferred tab=' + String(tabId).slice(-12)
            + ' id=' + item.id + ' reason=' + result.reason + ' attempt=none');
          return;
        }
      }
      if (!current?.attemptId && result?.submitted === false) {
        this.store.settleQueuedNoWrite(item.operation_key, result);
      }
      if (this.item(item.operation_key)?.state === 'dispatching') {
        this.db.prepare('UPDATE agent_send_queue SET state = ?, updated_at = ? WHERE operation_key = ?')
          .run('awaiting-receipt', Date.now(), item.operation_key);
      }
      this.observe(this.store.get(item.operation_key));
      const afterAttempt = this.store.get(item.operation_key);
      const automaticWait = isAutomaticNoWriteWait(afterAttempt, request);
      if (this.item(item.operation_key)?.state === 'waiting'
        && (automaticWait || isExternalOperationalNoInputReceipt(afterAttempt, request))) {
        parked = true;
        if (automaticWait || (this.runtimeWakeRevisions.get(tabId) || 0) === runtimeRevisionAtStart) {
          this.rerun.delete(tabId); // receipt publication is not readiness evidence
        } else this.rerun.add(tabId); // a real runtime wake arrived while preparation was still in flight
      } else if (waitingBeforeInput(this.store.get(item.operation_key), this.item(item.operation_key), request)) {
        // A message wake may have requeued the refused attempt before this
        // callback returned. Keep its executor/waiters and the explicit wake.
        parked = true;
      }
    } catch (error) {
      if (/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(String(error.code || ''))) {
        // Storage uncertainty is never a no-input receipt. Retain the item;
        // only a fresh zero-attempt CAS may later return it to admission.
        storageBlockedBeforeExecutor = true;
        console.warn('[AgentSendQueue] storage blocked tab=' + String(tabId).slice(-12)
          + ' id=' + item.id + ' executorInvoked=' + executorInvoked);
        return;
      }
      // No attempt was begun: the existing executor has not crossed its durable
      // write boundary. Otherwise retain the receipt's uncertainty, never retry.
      const current = this.store.get(item.operation_key);
      if (current && !current.attemptId) this.store.settleQueuedNoWrite(item.operation_key,
        { error: error.message, code: error.code || 'agent_send_queue_prepare_failed' });
      else if (current) this.publishRecord(current);
      console.warn('[AgentSendQueue] dispatch failed tab=' + String(tabId).slice(-12)
        + ' id=' + item.id + ' error=' + error.message);
    } finally {
      try {
        releaseDispatch?.();
        this.running.delete(tabId);
        const rerun = this.rerun.delete(tabId);
        if (storageBlockedBeforeExecutor) {
          this.parked.add(tabId); // No timer, SQL retry loop or global ready gate.
          if ((this.runtimeWakeRevisions.get(tabId) || 0) !== runtimeRevisionAtStart) this.wake(tabId);
        } else if (!parked || this.item(item.operation_key)?.state !== 'waiting') {
          this.parked.delete(tabId);
          this.runtimeWakeRevisions.delete(tabId);
          this.executors.delete(item.operation_key);
          this.resolveWaiters(item.operation_key);
          this.wake(tabId);
        } else if (rerun) this.wake(tabId);
      } finally {
        this.running.delete(tabId);
        if (this.dispatchOwners.get(tabId) === dispatchOwner) {
          this.dispatchOwners.delete(tabId);
          for (const waiter of dispatchOwner.waiters) if (!waiter.disposed) waiter.wake(tabId);
          dispatchOwner.waiters.clear();
        }
      }
    }
  }

  cancelWaiting(tabId, handoffId = null, { dismiss = false, reason = 'user-cancel' } = {}) {
    const items = this.db.prepare(`SELECT q.* FROM agent_send_queue q
      JOIN agent_send_receipts r ON r.operation_key = q.operation_key
      WHERE q.tab_id = ? AND q.state IN ('waiting','recovery-deferred')`
      + (handoffId ? ' AND r.handoff_id = ?' : '')).all(...(handoffId ? [tabId, handoffId] : [tabId]))
      .map(item => ({ item, record: this.store.get(item.operation_key) }))
      .filter(({ item, record }) => record && (!record.attemptId
        || waitingBeforeInput(record, item, JSON.parse(item.request_json))));
    const results = items.map(({ item, record }) => {
      try { return this.cancelDelivery(tabId, record.handoffId, { dismiss, reason }); }
      catch (error) { return { cancelled: false, durable: false, complete: false,
        operationKey: item.operation_key, reason: error.code || 'agent_send_cancel_storage_failed' }; }
    });
    const count = results.filter(result => result.cancelled === true).length;
    return { cancelled: count > 0, count, complete: results.every(result => result.complete === true), results };
  }

  // One user cancellation boundary for queued and already-started sends. It
  // revokes future writes, but cannot rewrite an earlier Enter as not-submitted.
  cancelDelivery(tabId, handoffId, { dismiss = true, reason = 'user-cancel' } = {}) {
    const item = this.db.prepare(`SELECT q.* FROM agent_send_queue q
      JOIN agent_send_receipts r ON r.operation_key=q.operation_key
      WHERE q.tab_id=? AND r.handoff_id=?`).get(tabId, handoffId);
    if (!item) return { cancelled: false, durable: false, complete: false, reason: 'queue-item-not-found' };
    const before = this.store.get(item.operation_key);
    if (!before) return { cancelled: false, durable: false, complete: false, reason: 'receipt-unavailable' };
    let cancellation;
    try {
      // Commit the cancellation before retiring presentation/queue state. A
      // later projection failure must not roll back this future-write fence.
      cancellation = this.store.cancelDelivery({ operationKey: item.operation_key,
        tabId, handoffId, attemptId: before.attemptId, reason, presentationDismissed: dismiss });
    } catch (error) {
      return { cancelled: false, durable: false, complete: false, operationKey: item.operation_key,
        reason: error.code || 'agent_send_cancel_storage_failed' };
    }
    if (!cancellation.ok) return { cancelled: false, durable: false, complete: false,
      operationKey: item.operation_key, reason: cancellation.reason };
    const result = { cancelled: true, durable: true, complete: true, deliveryIntentCancelled: true,
      deliveryCancelled: !before.attemptId || before.state === 'not-submitted'
        && before.receipt?.submitted === false && before.receipt?.enterWritten === false,
      deliveryOutcome: before.attemptId ? before.state : 'not-submitted',
      operationKey: item.operation_key, tabId, handoffId, provider: before.provider,
      attemptId: before.attemptId, deliveryControl: cancellation.record?.deliveryControl || null,
      idempotent: cancellation.idempotent === true };
    this.admitting += 1;
    try {
      // The final PTY guard also reads the durable marker if no memory waiter
      // is present. No late Enter/audit receipt is replaced by cancellation.
      this.cancelAttempt(cancellation.record);
      if (!before.attemptId) {
        const settled = this.store.settleQueuedNoWrite(item.operation_key, { cancelled: true,
          code: 'agent_send_queue_cancelled', error: 'Send cancelled before terminal input' });
        if (!settled.ok) throw Object.assign(new Error(settled.reason), { code: settled.reason });
        this.finish(item, 'cancelled');
      } else if (FAILED.has(before.state)) this.finish(item, 'cancelled');
      if (dismiss) this.releasePresentation(item.operation_key);
    } catch (error) {
      result.complete = false;
      result.reason = error.code || 'agent_send_cancel_projection_failed';
    } finally { this.admitting -= 1; }
    try {
      this.publishRecord(this.store.get(item.operation_key));
      this.resolveWaiters(item.operation_key);
      this.wake(tabId);
    } catch (error) {
      result.complete = false;
      result.reason = error.code || 'agent_send_cancel_projection_failed';
    }
    return result;
  }

  dismissUnwritten(tabId, handoffId) {
    const row = this.db.prepare(`SELECT q.operation_key FROM agent_send_queue q
      JOIN agent_send_receipts r ON r.operation_key = q.operation_key
      WHERE q.tab_id = ? AND r.handoff_id = ? AND r.attempt_id IS NULL AND r.state = 'not-submitted'`).get(tabId, handoffId);
    if (!row) return { cancelled: false, count: 0 };
    this.store.settleQueuedNoWrite(row.operation_key, { presentationDismissedAt: Date.now(),
      presentationDismissedSurface: 'desktop-history', cancelled: true });
    this.releasePresentation(row.operation_key);
    return { cancelled: true, count: 1 };
  }

  releasePresentation(operationKey) {
    const record = this.store.get(operationKey);
    if (!record || (!consumed(record) && !FAILED.has(record.state))
      || (!record.presentation && !hiddenSendPresentation(record))) return;
    this.store.unpinForOwner(operationKey, 'application-send-queue');
    this.db.prepare("UPDATE agent_send_queue SET asset_ids_json = '[]' WHERE operation_key = ?").run(operationKey);
    if (!consumed(record)) releaseQueueTransferPin(this.db, operationKey); // explicit dismissal of a failed/cancelled draft
    else adoptCompletedQueueTransfers(this.db, operationKey); // canonical ACK alone is not a bytes owner
  }

  referencedAssetIds() {
    return readQueuedSendAssetIds(this.db);
  }

  ownedUploadRef(sourcePath, assetId = null, sourceKey = null) {
    const refs = this.db.prepare('SELECT a.ref_json FROM agent_send_queue_assets a '
      + (sourceKey ? 'WHERE a.source_key = ? ' : 'WHERE a.source_path = ? ')
      + (assetId ? 'AND a.asset_id = ? ' : '')).all(...(assetId ? [sourceKey || sourcePath, assetId] : [sourceKey || sourcePath]))
      .map(row => JSON.parse(row.ref_json));
    if (!refs.length) return null;
    if (new Set(refs.map(ref => ref.assetId)).size !== 1) return { ambiguous: true };
    return refs[0];
  }

  stop(tabId) {
    const waiting = this.cancelWaiting(tabId, null, { reason: 'manual-stop' });
    const results = [...waiting.results];
    const head = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ('dispatching','awaiting-receipt') ORDER BY ${ORDER} LIMIT 1`).get(tabId);
    if (head && !results.some(result => result.operationKey === head.operation_key)) {
      try {
        const record = this.store.get(head.operation_key);
        results.push(record
          ? this.cancelDelivery(tabId, record.handoffId, { dismiss: false, reason: 'manual-stop' })
          : { cancelled: false, durable: false, complete: false,
            operationKey: head.operation_key, reason: 'receipt-unavailable' });
      } catch (error) {
        results.push({ cancelled: false, durable: false, complete: false,
          operationKey: head.operation_key, reason: error.code || 'agent_send_cancel_storage_failed' });
      }
    }
    // Include an active-head-only cancellation and expose per-item partial
    // persistence/projection failure separately from the physical Stop result.
    const count = results.filter(result => result.cancelled === true).length;
    return { cancelled: count > 0, count, complete: results.every(result => result.complete === true), results };
  }

  dispose() {
    this.disposed = true; this.unsubscribe(); this.executors.clear();
    for (const owner of this.dispatchOwners.values()) owner.waiters.delete(this);
    for (const expiry of this.preparationExpiries.values()) this.clearTimer(expiry.timer);
    this.preparationExpiries.clear();
    this.runtimeWakeRevisions.clear();
    for (const operationKey of this.waiters.keys()) this.resolveWaiters(operationKey);
  }
}

// Startup GC runs before the web executor exists. The durable inventory, not
// the lifetime of its in-memory queue instance, owns retained file references.
function readQueuedSendAssetIds(db) {
  const result = new Set();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_send_queue'").get()) return result;
  const protectedColumn = db.prepare('PRAGMA table_info(agent_send_queue)').all().some(column => column.name === 'asset_transfer_ids_json');
  for (const row of db.prepare("SELECT state,asset_ids_json" + (protectedColumn ? ',asset_transfer_ids_json' : '')
    + " FROM agent_send_queue WHERE state != 'completed'" + (protectedColumn ? " OR asset_transfer_ids_json!='[]'" : '')).iterate()) {
    if (row.state !== 'completed') for (const id of JSON.parse(row.asset_ids_json)) result.add(id);
    for (const id of JSON.parse(row.asset_transfer_ids_json || '[]')) result.add(id);
  }
  return result;
}

function forgetCollectedUploadAliases(db, assetIds) {
  if (!assetIds?.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_send_queue_assets'").get()) return;
  const remove = db.prepare('DELETE FROM agent_send_queue_assets WHERE asset_id = ? '
    + 'AND NOT EXISTS (SELECT 1 FROM agent_send_queue q WHERE q.operation_key = agent_send_queue_assets.operation_key '
    + "AND q.state != 'completed' AND q.asset_ids_json != '[]')");
  db.transaction(() => { for (const id of assetIds) remove.run(id); })();
}

module.exports = { AgentSendQueue, applicationQueueReceipt, readQueuedSendAssetIds, forgetCollectedUploadAliases,
  hasCanonicalSendConsumption: consumed };
