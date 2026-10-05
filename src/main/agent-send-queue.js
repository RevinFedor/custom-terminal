'use strict';

// The application backlog owns admission only. Existing scenarios still own
// readiness/settings/composer/PTY and the receipt store owns delivery proof.
// No timers, text matching, provider turn-completion heuristic or second Enter.
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { attachmentOwnershipReceipt, validateOwnedAttachmentSnapshot } = require('./owned-mobile-attachments');
const OPEN = "('waiting','dispatching','awaiting-receipt')";
const FAILED = new Set(['not-submitted', 'provider-not-accepted']);
const consumed = record => record?.state === 'confirmed'
  && record.auditIdentity?.attemptId === record.attemptId
  && !!record.auditIdentity?.sessionId
  && !!(record.auditIdentity?.entryUuid || record.auditIdentity?.sourceIdentity);

function applicationQueueReceipt(record, item) {
  if (!record || !item || !['waiting','dispatching'].includes(item.state)
    || record.attemptId || !['reserved','preparing'].includes(record.state)) return null;
  return {
    success: true, accepted: true, submitted: false, pasteWritten: false, enterWritten: false,
    status: 'application-queued', queued: true, applicationQueued: true,
    providerQueueAccepted: false, exactAuditConfirmed: false, auditPending: false,
    handoffId: record.handoffId, tabId: record.tabId, operationKey: record.operationKey,
    sendOperationKey: record.operationKey, attemptId: null, sendAttemptId: null,
    receiptState: record.state,
    applicationQueue: { version: 1, id: item.id, state: item.state, queuedAt: item.created_at },
    ...(record.receipt?.ownedAttachments ? { attachmentOwnership: attachmentOwnershipReceipt(record.receipt.ownedAttachments) } : {}),
  };
}

class AgentSendQueue {
  constructor({ store, execute, publish = () => {}, ready = () => true, cancelAttempt = () => {}, admit = null }) {
    this.store = store;
    this.db = store.db;
    this.execute = execute;
    this.publish = publish;
    this.ready = ready;
    this.cancelAttempt = cancelAttempt;
    this.admit = admit;
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
    this.unsubscribe = store.subscribe(record => this.observe(record));
  }

  item(operationKey) {
    return this.db.prepare('SELECT * FROM agent_send_queue WHERE operation_key = ?').get(operationKey) || null;
  }

  receipt(operationKey) {
    return applicationQueueReceipt(this.store.get(operationKey), this.item(operationKey));
  }

  enqueue({ identity, request, execute }) {
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
        return { ok: true, item: existing, record: this.store.get(identity.operationKey), replayed: true };
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
      if (reserved.record.attemptId || !['reserved','preparing'].includes(reserved.record.state)) {
        return { ok: true, record: reserved.record, replayed: true, item: null };
      }
      const now = Date.now();
      const assetIds = [...new Set([...(snapshot.presentationSnapshot?.imagePaths || []),
        ...(snapshot.authoringSnapshot?.imagePaths || []), ...(snapshot.ownedAttachments?.refs || [])]
        .map(image => image.assetId).filter(Boolean))];
      const predecessor = this.db.prepare(`SELECT operation_key FROM agent_send_queue
        WHERE tab_id = ? AND state IN ${OPEN} ORDER BY id LIMIT 1`).get(identity.tabId);
      this.db.prepare(`INSERT INTO agent_send_queue
        (operation_key,tab_id,request_hash,request_json,asset_ids_json,predecessor_key,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?, 'waiting',?,?)`).run(identity.operationKey, identity.tabId,
        requestHash, JSON.stringify(snapshot), JSON.stringify(assetIds), predecessor?.operation_key || null, now, now);
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
      return { ok: true, item: this.item(identity.operationKey), record: this.store.get(identity.operationKey) };
    })(); } catch (error) {
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

  publishRecord(record) {
    const projection = this.projectRecord(record);
    if (projection?.applicationQueue) {
      try { this.publish(projection); }
      catch (error) { console.warn('[AgentSendQueue] publication failed operation='
        + record.operationKey.slice(0, 90) + ' error=' + error.message); }
    }
  }

  projectRecord(record) {
    if (!record) return;
    const item = this.item(record.operationKey);
    if (!item) return record;
    const request = JSON.parse(item.request_json);
    return { ...record, receipt: { promptText: request.prompt,
      presentationSnapshot: request.presentationSnapshot, authoringSnapshot: request.authoringSnapshot,
      ...(request.ownedAttachments ? { ownedAttachments: request.ownedAttachments,
        attachmentOwnership: attachmentOwnershipReceipt(request.ownedAttachments) } : {}),
      source: request.source, ...(record.receipt || {}) }, applicationQueue: {
      version: 1, id: item.id, state: item.state, queuedAt: item.created_at,
    } };
  }

  observe(record) {
    if (!record || this.admitting > 0 || this.disposed) return;
    const item = this.item(record.operationKey);
    if (!item) return;
    // A receipt can complete before the bridge returns. Running still holds
    // the physical scenario until its finally, even after this exact promotion.
    if (consumed(record) || FAILED.has(record.state)) {
      this.finish(item, consumed(record) ? 'completed' : 'failed');
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
    this.db.prepare(`UPDATE agent_send_queue SET state = ?, updated_at = ? WHERE operation_key = ?
      AND state IN ${OPEN}`).run(state, Date.now(), item.operation_key);
    this.executors.delete(item.operation_key);
    // Failed/Stop-cancelled drafts remain recoverable until explicit dismissal.
    if (state === 'completed') this.store.unpinForOwner(item.operation_key, 'application-send-queue');
    if (item.predecessor_key) this.store.unpinForOwner(item.predecessor_key, 'send-queue-successor:' + item.operation_key);
    const record = this.store.get(item.operation_key);
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

  notifyRuntime(tabId) { if (this.parked.has(tabId)) this.wake(tabId); }

  resume() {
    for (const row of this.db.prepare(`SELECT DISTINCT tab_id FROM agent_send_queue WHERE state IN ${OPEN}`).all()) {
      this.wake(row.tab_id);
    }
  }

  async pump(tabId) {
    if (this.disposed || this.running.has(tabId) || !this.ready()) return;
    const item = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ${OPEN} ORDER BY id LIMIT 1`).get(tabId);
    if (!item) return;
    const record = this.store.get(item.operation_key);
    if (!record) return; // Losing a receipt is not proof that input was untouched.
    if (consumed(record) || FAILED.has(record.state)) {
      this.observe(record);
      return;
    }
    if (record.attemptId || !['reserved','preparing'].includes(record.state)) return;
    // Claim synchronously before calling any asynchronous scenario. An event or
    // a second client cannot launch another physical sender in this tab.
    this.running.add(tabId);
    const request = JSON.parse(item.request_json);
    const predecessor = item.predecessor_key ? this.store.get(item.predecessor_key) : null;
    const inheritedSession = !request.expectedTarget?.sessionId && consumed(predecessor)
      ? predecessor.auditIdentity.sessionId : null;
    const executionScope = { requestFingerprint: record.requestFingerprint,
      ...(inheritedSession ? { expectedTarget: { ...request.expectedTarget,
        toolType: record.provider, sessionId: inheritedSession } } : {}),
    };
    let parked = false;
    try {
      if (this.admit) {
        this.parked.add(tabId);
        if (!await this.admit(request)) { parked = true; return; }
        this.parked.delete(tabId);
      }
      if (this.disposed || !this.ready()) { parked = true; return; }
      if (this.item(item.operation_key)?.state === 'cancelled') return;
      this.db.prepare('UPDATE agent_send_queue SET state = ?, updated_at = ? WHERE operation_key = ?')
        .run('dispatching', Date.now(), item.operation_key);
      this.publishRecord(record);
      console.log('[AgentSendQueue] dispatch tab=' + String(tabId).slice(-12)
        + ' id=' + item.id + ' operation=' + item.operation_key.slice(0, 90));
      const executor = this.executors.get(item.operation_key);
      const result = await (executor ? executor(executionScope) : this.execute(request, executionScope));
      const current = this.store.get(item.operation_key);
      if (!current?.attemptId && result?.submitted === false) {
        this.store.settleQueuedNoWrite(item.operation_key, result);
      }
      if (this.item(item.operation_key)?.state === 'dispatching') {
        this.db.prepare('UPDATE agent_send_queue SET state = ?, updated_at = ? WHERE operation_key = ?')
          .run('awaiting-receipt', Date.now(), item.operation_key);
      }
      this.observe(this.store.get(item.operation_key));
    } catch (error) {
      // No attempt was begun: the existing executor has not crossed its durable
      // write boundary. Otherwise retain the receipt's uncertainty, never retry.
      const current = this.store.get(item.operation_key);
      if (current && !current.attemptId) this.store.settleQueuedNoWrite(item.operation_key,
        { error: error.message, code: error.code || 'agent_send_queue_prepare_failed' });
      else if (current) this.publishRecord(current);
      console.warn('[AgentSendQueue] dispatch failed tab=' + String(tabId).slice(-12)
        + ' id=' + item.id + ' error=' + error.message);
    } finally {
      this.running.delete(tabId);
      const rerun = this.rerun.delete(tabId);
      if (!parked || this.item(item.operation_key)?.state !== 'waiting') {
        this.parked.delete(tabId);
        this.executors.delete(item.operation_key);
        this.resolveWaiters(item.operation_key);
        this.wake(tabId);
      } else if (rerun) this.wake(tabId);
    }
  }

  cancelWaiting(tabId, handoffId = null, { dismiss = false } = {}) {
    const items = this.db.prepare(`SELECT q.* FROM agent_send_queue q
      JOIN agent_send_receipts r ON r.operation_key = q.operation_key
      WHERE q.tab_id = ? AND q.state = 'waiting' AND r.attempt_id IS NULL`
      + (handoffId ? ' AND r.handoff_id = ?' : '')).all(...(handoffId ? [tabId, handoffId] : [tabId]));
    for (const item of items) {
      this.finish(item, 'cancelled');
      this.store.settleQueuedNoWrite(item.operation_key, {
        code: 'agent_send_queue_cancelled', error: 'Queued send cancelled before terminal input', cancelled: true,
        ...(dismiss ? { presentationDismissedAt: Date.now(), presentationDismissedSurface: 'desktop-history' } : {}),
      });
      if (dismiss) this.releasePresentation(item.operation_key);
    }
    return { cancelled: items.length > 0, count: items.length };
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
      || (!record.presentation && !record.receipt?.presentationDismissedAt)) return;
    this.store.unpinForOwner(operationKey, 'application-send-queue');
    this.db.prepare("UPDATE agent_send_queue SET asset_ids_json = '[]' WHERE operation_key = ?").run(operationKey);
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
    const result = this.cancelWaiting(tabId);
    const head = this.db.prepare(`SELECT * FROM agent_send_queue WHERE tab_id = ?
      AND state IN ('dispatching','awaiting-receipt') ORDER BY id LIMIT 1`).get(tabId);
    if (head) {
      const record = this.store.get(head.operation_key);
      // Cancels future work in the existing executor; never reverses an Enter
      // or reports the provider-owned item as an untouched application item.
      if (record) this.cancelAttempt(record);
      if (!record?.attemptId) {
        this.finish(head, 'cancelled');
        this.store.settleQueuedNoWrite(head.operation_key,
          { cancelled: true, code: 'agent_send_queue_cancelled', error: 'Send cancelled before terminal input' });
      }
    }
    return result;
  }

  dispose() {
    this.disposed = true; this.unsubscribe(); this.executors.clear();
    for (const operationKey of this.waiters.keys()) this.resolveWaiters(operationKey);
  }
}

// Startup GC runs before the web executor exists. The durable inventory, not
// the lifetime of its in-memory queue instance, owns retained file references.
function readQueuedSendAssetIds(db) {
  const result = new Set();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_send_queue'").get()) return result;
  for (const row of db.prepare("SELECT asset_ids_json FROM agent_send_queue WHERE state != 'completed'").iterate()) {
    for (const id of JSON.parse(row.asset_ids_json)) result.add(id);
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

module.exports = { AgentSendQueue, applicationQueueReceipt, readQueuedSendAssetIds, forgetCollectedUploadAliases };
