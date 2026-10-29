'use strict';

const crypto = require('node:crypto');
const { activeStorageTabsSql, classifySessionItem } = require('./storage-inventory');

const TABLE = 'storage_expired_tab_history';
const HOUR = 3_600_000;
const signature = row => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
const epoch = value => {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const text = String(value).trim();
  // SQLite CURRENT_TIMESTAMP is UTC without a suffix; don't reinterpret it
  // in the Mac's timezone and expire a legacy row several hours early.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text);
  if (!sqliteUtc && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return 0;
  const timestamp = sqliteUtc ? text.replace(' ', 'T') + 'Z' : text;
  return Date.parse(timestamp) || 0;
};
const sessions = row => ['codex', 'claude', 'gemini'].flatMap(provider =>
  row[provider + '_session_id'] ? [{ provider, sessionId: row[provider + '_session_id'] }] : []);

// RAG indexes have ON DELETE CASCADE references to tab_history. Expiration
// consumes the restorable archive, not the user's independent search corpus.
// Keep its small source row and foreign keys; never copy embeddings or JSONL.
function ensureExpiredHistoryTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    history_id INTEGER PRIMARY KEY REFERENCES tab_history(id) ON DELETE CASCADE,
    expired_at INTEGER NOT NULL, operation_id TEXT NOT NULL,
    tab_id TEXT, session_ids_json TEXT NOT NULL, source_hash TEXT NOT NULL
  )`);
}

function visibleHistorySql(alias = 'tab_history') {
  return `NOT EXISTS (SELECT 1 FROM ${TABLE} expired WHERE expired.history_id=${alias}.id)`;
}

class ClosedTabRetention {
  constructor({ db, getRuntimeSessionIds = () => [], getRuntimeTabIds = () => [],
    isRestoreInProgress = () => false, getSettings = null, currentEnvironment = 'production', audit, now = Date.now, logger = console, onExpired = () => {} }) {
    Object.assign(this, { db, getRuntimeSessionIds, getRuntimeTabIds, isRestoreInProgress, getSettings, audit, now, logger, onExpired });
    this.currentEnvironment = currentEnvironment;
    ensureExpiredHistoryTable(db);
  }

  hasTable(name) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }

  protection(row) {
    if (row.execution_subject_version != null && ![1,2].includes(Number(row.execution_subject_version))) return 'execution-subject-version-unknown';
    if (this.isRestoreInProgress(row.id)) return 'restore-in-progress';
    if (this.getRuntimeTabIds().includes(row.tab_id)) return 'runtime-tab';
    // A stopped/reserve tab is just as current as a running/visible tab. V2
    // retains archived execution rows, so the existence of a tabs row alone
    // must NOT mean that it is open.
    const active = activeStorageTabsSql(this.db);
    const conditions = ['tab_id=?'];
    const values = [row.tab_id || ''];
    if (this.hasTable('workflow_archive_restore_owners')) {
      const claim = this.db.prepare('SELECT target_tab_id FROM workflow_archive_restore_owners WHERE history_id=?').get(row.id);
      if (claim?.target_tab_id) { conditions.push('tab_id=?'); values.push(claim.target_tab_id); }
    }
    // Another tab may intentionally use the same SID. Its conversation stays
    // protected by Storage, but that must not keep this old, fully closed tab
    // in History forever. Archive expiration is exact-tab/restore-owner scoped.
    if (this.db.prepare(`SELECT 1 FROM tabs WHERE (${conditions.join(' OR ')}) AND ${active} LIMIT 1`).get(...values)) return 'current-tab';
    return null;
  }

  plan({ settings, items = [], sessionCoverage = null, maxItems = 250 } = {}) {
    if (settings?.enabled !== true) return { candidates: [], skipped: { disabled: 1 } };
    const bySession = new Map();
    for (const item of items) {
      if (item.section !== 'sessions' || item.recoveryCopy) continue;
      const key = item.provider + ':' + item.sessionId;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(item);
    }
    const skipped = {}, candidates = [];
    const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const columns = new Set(this.db.prepare('PRAGMA table_info(tab_history)').all().map(column => column.name));
    const metadata = ['id', 'tab_id', 'project_id', 'execution_namespace', 'execution_subject_version', 'closed_at', 'codex_session_id', 'claude_session_id', 'gemini_session_id']
      .map(field => columns.has(field) ? field : `NULL AS ${field}`).join(',');
    const rows = this.db.prepare(`SELECT ${metadata} FROM tab_history WHERE ${visibleHistorySql()}
      ORDER BY closed_at, id`).all();
    for (const row of rows) {
      const protectedReason = this.protection(row);
      if (protectedReason) { skip(protectedReason); continue; }
      const related = sessions(row).flatMap(({ provider, sessionId }) => bySession.get(provider + ':' + sessionId) || []);
      let fork = null;
      if (row.codex_session_id && this.hasTable('session_history_events')) {
        fork = this.db.prepare(`SELECT fork_mode,source_session_id FROM session_history_events
          WHERE provider='codex' AND event_type='fork' AND child_session_id=? ORDER BY id DESC LIMIT 1`).get(row.codex_session_id);
      }
      if (this.currentEnvironment !== 'development' && !related.length && !fork && sessions(row).length
        && ['regular','fork','rewrite','subagent'].some(key => settings.retentionDays?.[key] === null)) { skip('retention-group-unknown'); continue; }
      const primary = related[0];
      const group = primary?.group && primary.group !== 'open' ? primary.group : classifySessionItem(
        {...primary,protected:false}, {notedTerminal:true,environments:[this.currentEnvironment]},
        fork ? {forkMode:fork.fork_mode,sourceSessionId:fork.source_session_id} : null);
      const days = Object.hasOwn(settings.retentionDays || {}, group) ? settings.retentionDays[group] : 1;
      if (days == null) { skip('never'); continue; }
      const closedAt = epoch(row.closed_at);
      const deleteAfter = closedAt + Math.max(Number(settings.gracePeriodHours) || 24, days * 24) * HOUR;
      if (!closedAt) { skip('close-time-unknown'); continue; }
      if (deleteAfter > this.now()) { skip('waiting'); continue; }
      // Full Close has a known timestamp independent of provider availability.
      // Expire the restorable archive on time even if a provider refuses its
      // separate file deletion. Retain exact source IDs for that retry/RAG.
      // A required prefix survives under the other open fork's ownership.
      const conversationsPending = sessions(row).filter(({ provider, sessionId }) =>
        related.some(item => item.provider === provider && item.sessionId === sessionId)
        || sessionCoverage?.[provider] !== true);
      if (candidates.length < maxItems) candidates.push({ historyId: row.id,
        tabId: row.tab_id || null, namespace: row.project_id || row.execution_namespace,
        sessionIds: sessions(row), conversationsPending, closedAt, deleteAfter,
        sourceHash: signature(this.db.prepare('SELECT * FROM tab_history WHERE id=?').get(row.id)) });
      else skip('batch-limit');
    }
    return { candidates, skipped };
  }

  async run({ inventory, dryRun = false, maxItems = 250, operationId = crypto.randomUUID() } = {}) {
    const plan = this.plan({ ...inventory, maxItems });
    if (dryRun) return { success: true, dryRun: true, ...plan, expiredHistoryIds: [] };
    const expiredHistoryIds = [], failures = [];
    for (const item of plan.candidates) {
      try {
        // Required durable attempt precedes mutation. A concurrent restore can
        // happen during this await, hence the transaction repeats every guard.
        if (!this.audit) throw new Error('storage_deletion_audit_unavailable');
        await this.audit.record({ operationId, source: 'closed-tab-retention', status: 'attempt',
          itemId: 'history:' + item.historyId, ...item });
        const expired = this.db.transaction(() => {
          const row = this.db.prepare(`SELECT * FROM tab_history WHERE id=? AND ${visibleHistorySql()}`).get(item.historyId);
          if (!row || signature(row) !== item.sourceHash || this.protection(row)) return false;
          const fresh = this.getSettings?.() || inventory.settings;
          if (JSON.stringify(fresh) !== JSON.stringify(inventory.settings)) return false;
          this.db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?,?,?)`).run(row.id, this.now(), operationId,
            row.tab_id, JSON.stringify(item.sessionIds), item.sourceHash);
          // Search source identity/name/session references stay intact. These
          // are no longer restore metadata; do not retain large plans/notes.
          const columns = new Set(this.db.prepare('PRAGMA table_info(tab_history)').all().map(c => c.name));
          const fields = ['notes', 'task_plan', 'restore_placement', 'execution_record_json', 'execution_snapshot_json', 'external_run', 'workflow_context_json']
            .filter(field => columns.has(field)).map(field => field + '=NULL');
          if (fields.length) this.db.prepare(`UPDATE tab_history SET ${fields.join(',')} WHERE id=?`).run(row.id);
          if (this.hasTable('workflow_archived_file_links')) this.db.prepare('DELETE FROM workflow_archived_file_links WHERE history_id=?').run(row.id);
          return true;
        }).immediate();
        if (!expired) { failures.push({ historyId: item.historyId, error: 'archive-changed-or-restored' }); continue; }
        expiredHistoryIds.push(item.historyId);
        await this.audit.record({ operationId, source: 'closed-tab-retention', status: 'removed',
          itemId: 'history:' + item.historyId, ...item, ragPreserved: true });
      } catch (error) { failures.push({ historyId: item.historyId, error: error.message }); }
    }
    if (expiredHistoryIds.length) {
      this.logger.log?.('[StorageCleanup:ClosedTabs] ' + JSON.stringify({ operationId, expiredHistoryIds, ragPreserved: true }));
      try { this.onExpired(expiredHistoryIds); }
      catch (error) { this.logger.warn?.('[StorageCleanup:ClosedTabs] notification failed: ' + error.message); }
    }
    return { success: failures.length === 0, expiredHistoryIds, failures, skipped: plan.skipped,
      retainedSessionSources: plan.candidates.filter(item => expiredHistoryIds.includes(item.historyId))
        .flatMap(item => item.conversationsPending) };
  }
}

module.exports = { ClosedTabRetention, ensureExpiredHistoryTable, visibleHistorySql, epoch };
