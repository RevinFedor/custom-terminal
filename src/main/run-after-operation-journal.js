'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { runAfterError } = require('../shared/run-after-api.cjs');

// No pump, timer, provider writer or second queue. This receipt is the atomic
// persistence boundary for ONE remote call into the existing renderer owner.
class RunAfterOperationJournal {
  constructor({ db, epoch = randomUUID(), now = Date.now, commitState, scopeCurrent }) {
    Object.assign(this, { db, epoch, now, commitState, scopeCurrent });
    db.exec(`CREATE TABLE IF NOT EXISTS run_after_operations (
      operation_id TEXT PRIMARY KEY, target TEXT NOT NULL, request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL, main_epoch TEXT NOT NULL, nonce TEXT NOT NULL,
      phase TEXT NOT NULL, result_json TEXT, error TEXT, assets_json TEXT NOT NULL DEFAULT '[]',
      released_at INTEGER, execution_admitted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    if (!db.prepare('PRAGMA table_info(run_after_operations)').all().some(column => column.name === 'execution_admitted_at')) {
      db.exec('ALTER TABLE run_after_operations ADD COLUMN execution_admitted_at INTEGER');
    }
    db.prepare("UPDATE run_after_operations SET phase='unknown', error='run_after_restart_unknown', updated_at=? WHERE phase='pending'").run(now());
  }
  record(operationId) { return this.db.prepare('SELECT * FROM run_after_operations WHERE operation_id=?').get(operationId) || null; }
  read(operationId, target) {
    const row = this.record(operationId);
    if (!row || target && row.target !== target) return null;
    return { version: 1, operationId: row.operation_id, target: row.target, phase: row.phase,
      committed: row.phase === 'applied', retryable: false, error: row.error,
      executionAdmittedAt: row.execution_admitted_at ?? null,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      createdAt: row.created_at, updatedAt: row.updated_at, released: row.released_at != null };
  }
  reserve(operationId, target, request, scope) {
    const hash = fingerprintAgentSendRequest({ target, request });
    const previous = this.record(operationId);
    if (previous) {
      if (previous.target !== target || previous.request_hash !== hash) throw runAfterError('run_after_operation_conflict');
      return { replay: true, receipt: this.read(operationId, target) };
    }
    const nonce = randomUUID(), at = this.now();
    this.db.prepare(`INSERT INTO run_after_operations
      (operation_id,target,request_hash,request_json,main_epoch,nonce,phase,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`).run(operationId, target, hash,
      JSON.stringify({ request, scope }), this.epoch, nonce, at, at);
    return { replay: false, ticket: { operationId, nonce, mainEpoch: this.epoch, target }, receipt: this.read(operationId, target) };
  }
  authorize(ticket) {
    const row = this.record(ticket?.operationId);
    if (!row || row.nonce !== ticket?.nonce || row.main_epoch !== this.epoch || ticket?.mainEpoch !== this.epoch
      || row.target !== ticket.target || !['pending', 'unknown'].includes(row.phase)) throw runAfterError('run_after_operation_stale');
    return row;
  }
  holdAssets(ticket, ids) {
    const row = this.authorize(ticket);
    const held = new Set(JSON.parse(row.assets_json));
    for (const id of ids) if (typeof id === 'string') held.add(id);
    this.db.prepare('UPDATE run_after_operations SET assets_json=?, updated_at=? WHERE operation_id=?')
      .run(JSON.stringify([...held]), this.now(), row.operation_id);
  }
  admitExecution(ticket) {
    const row = this.authorize(ticket), request = JSON.parse(row.request_json).request;
    if (!['sendNow', 'requestNow', 'cancel'].includes(request.op)) return;
    // This records a checked application-command admission, NOT provider input
    // or success. Its eventual result is historical even if its own Resume or
    // first Send changes the current conversation before completion.
    this.db.prepare('UPDATE run_after_operations SET execution_admitted_at=COALESCE(execution_admitted_at,?),updated_at=? WHERE operation_id=?')
      .run(this.now(), this.now(), row.operation_id);
  }
  stage(ticket, result) {
    const row = this.authorize(ticket);
    this.db.prepare('UPDATE run_after_operations SET result_json=?,updated_at=? WHERE operation_id=?')
      .run(JSON.stringify({ prepared: true, ...result }), this.now(), row.operation_id);
    return this.read(row.operation_id, row.target);
  }
  finish(ticket, { result = null, writes = null, error = null, rejected = false, retainAssets = false } = {}) {
    return this.db.transaction(() => {
      const row = this.authorize(ticket), saved = JSON.parse(row.request_json);
      if (!rejected && row.execution_admitted_at == null && this.scopeCurrent && !this.scopeCurrent(row.target, saved.scope)) throw runAfterError('run_after_scope_changed');
      if (writes) this.commitState(writes, row);
      this.db.prepare(`UPDATE run_after_operations SET phase=?,result_json=?,error=?,updated_at=?,
        assets_json=CASE WHEN ? THEN assets_json ELSE '[]' END WHERE operation_id=?`)
        .run(rejected ? 'rejected' : 'applied', result == null ? null : JSON.stringify(result), error,
          this.now(), retainAssets || rejected ? 1 : 0, row.operation_id);
      return this.read(row.operation_id, row.target);
    }).immediate();
  }
  unknown(operationId, error = 'run_after_outcome_unknown') {
    this.db.prepare("UPDATE run_after_operations SET phase='unknown',error=?,updated_at=? WHERE operation_id=? AND phase='pending'")
      .run(error, this.now(), operationId);
    return this.read(operationId);
  }
  release(operationId, target) {
    const row = this.record(operationId);
    if (!row || row.target !== target || !['applied', 'rejected'].includes(row.phase)) throw runAfterError('run_after_draft_release_invalid');
    this.db.prepare("UPDATE run_after_operations SET released_at=COALESCE(released_at,?),assets_json='[]',updated_at=? WHERE operation_id=?")
      .run(this.now(), this.now(), operationId);
    return this.read(operationId, target);
  }
  referencedAssetIds() {
    return readRunAfterAssetIds(this.db);
  }
}
function readRunAfterAssetIds(db) {
  const ids = new Set();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_after_operations'").get()) return ids;
  for (const row of db.prepare("SELECT assets_json FROM run_after_operations WHERE released_at IS NULL AND assets_json!='[]'").iterate()) {
    for (const id of JSON.parse(row.assets_json)) ids.add(id);
  }
  return ids;
}
module.exports = { RunAfterOperationJournal, readRunAfterAssetIds };
