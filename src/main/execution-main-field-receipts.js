'use strict';

// These columns already belong to point writers: an existing native tab's
// renderer snapshot cannot write them (_executionRecordColumns, creating=false).
// Everything else, including future/extension columns, stays behind strict CAS.
const MAIN_OWNED_COLUMNS = Object.freeze([
  'claude_session_id', 'gemini_session_id', 'codex_session_id',
  'provider_state', 'external_run', 'claude_session_history',
  'context_pct', 'cache_stats', 'was_interrupted', 'overlay_dismissed',
  'codex_model', 'codex_effort', 'codex_settings_proof_at', 'codex_settings_proof_session_id',
  'codex_model_migration_pending', 'codex_model_migration_restore_default_model',
  'codex_model_migration_restore_default_effort', 'codex_model_migration_source_model',
  'codex_model_migration_source_effort', 'codex_model_migration_target_model',
  'codex_model_migration_config_path', 'codex_model_migration_config_fingerprint',
  'codex_model_migration_config_already_target',
]);
const TABLE = 'workflow_execution_main_field_receipts';
const TRIGGER = 'workflow_tabs_main_field_receipt';
const INVALIDATE = 'workflow_tabs_metadata_receipt_invalidate';
const REMOVE = 'workflow_tabs_main_field_receipt_delete';
const quote = value => '"' + value.replaceAll('"', '""') + '"';

function ensureMainFieldReceipts(db) {
  const columns = db.prepare('PRAGMA table_xinfo(tabs)').all().map(column => column.name);
  const owned = MAIN_OWNED_COLUMNS.filter(name => columns.includes(name));
  const protectedColumns = columns.filter(name => !owned.includes(name) && name !== 'execution_storage_revision');
  // OLD/NEW belong to this very UPDATE. The existing revision trigger supplies
  // its one step; its nested revision-only UPDATE does not enter UPDATE OF below.
  // The receipt rolls back with the row and survives an ACK loss/reopen. A foreign
  // metadata step breaks the interval even if another point writer runs later.
  const sql = `CREATE TRIGGER ${TRIGGER} AFTER UPDATE OF ${owned.map(quote).join(',')} ON tabs
    WHEN OLD.execution_subject_version=2 AND NEW.execution_subject_version=2
      AND NEW.execution_storage_revision=OLD.execution_storage_revision
      AND OLD.execution_archived=0
      AND ${protectedColumns.map(name => `NEW.${quote(name)} IS OLD.${quote(name)} COLLATE BINARY`).join(' AND ')}
      AND EXISTS(SELECT 1 FROM tabs AS current WHERE current.id=OLD.id
        AND ${protectedColumns.map(name => `current.${quote(name)} IS OLD.${quote(name)} COLLATE BINARY`).join(' AND ')})
    BEGIN
      INSERT INTO ${TABLE}(tab_storage_id,namespace,tab_id,subject_id,from_revision,to_revision,field_mask)
      VALUES(OLD.id,OLD.execution_namespace,OLD.tab_id,OLD.execution_subject_id,
        OLD.execution_storage_revision,OLD.execution_storage_revision+1,
        ${owned.map(name => `(CASE WHEN NEW.${quote(name)} IS NOT OLD.${quote(name)} THEN ${2**MAIN_OWNED_COLUMNS.indexOf(name)} ELSE 0 END)`).join(' | ')})
      ON CONFLICT(tab_storage_id) DO UPDATE SET
        field_mask=CASE WHEN namespace=excluded.namespace AND tab_id=excluded.tab_id
          AND subject_id=excluded.subject_id AND to_revision=excluded.from_revision
          THEN field_mask | excluded.field_mask ELSE excluded.field_mask END,
        from_revision=CASE WHEN namespace=excluded.namespace AND tab_id=excluded.tab_id
          AND subject_id=excluded.subject_id AND to_revision=excluded.from_revision
          THEN from_revision ELSE excluded.from_revision END,
        to_revision=excluded.to_revision,namespace=excluded.namespace,
        tab_id=excluded.tab_id,subject_id=excluded.subject_id;
    END`;
  // Other AFTER UPDATE triggers may change metadata in this same transaction.
  // If they run first, the current-row comparison above refuses certification;
  // if they run later, this invalidation removes it. Trigger order is immaterial.
  const invalidateSql = `CREATE TRIGGER ${INVALIDATE} AFTER UPDATE OF ${protectedColumns.map(quote).join(',')} ON tabs
    WHEN OLD.execution_subject_version=2 AND (${protectedColumns.map(name => `NEW.${quote(name)} IS NOT OLD.${quote(name)} COLLATE BINARY`).join(' OR ')})
    BEGIN DELETE FROM ${TABLE} WHERE tab_storage_id=OLD.id; END`;
  const deleteSql = `CREATE TRIGGER ${REMOVE} AFTER DELETE ON tabs
    BEGIN DELETE FROM ${TABLE} WHERE tab_storage_id=OLD.id; END`;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(
      tab_storage_id INTEGER PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,tab_id TEXT NOT NULL,subject_id TEXT NOT NULL,
      from_revision INTEGER NOT NULL,to_revision INTEGER NOT NULL,field_mask INTEGER NOT NULL DEFAULT 0)`);
    if (!db.prepare(`PRAGMA table_info(${TABLE})`).all().some(column => column.name === 'field_mask')) {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN field_mask INTEGER NOT NULL DEFAULT 0`);
    }
    const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(TRIGGER)?.sql;
    const previousInvalidate = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(INVALIDATE)?.sql;
    const previousDelete = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(REMOVE)?.sql;
    if (previous === sql && previousInvalidate === invalidateSql && previousDelete === deleteSql) return;
    // A changed column contract cannot retroactively certify an older interval.
    db.exec(`DELETE FROM ${TABLE}; DROP TRIGGER IF EXISTS ${TRIGGER}; DROP TRIGGER IF EXISTS ${INVALIDATE}; DROP TRIGGER IF EXISTS ${REMOVE}; ${sql}; ${invalidateSql}; ${deleteSql}`);
  }).immediate();
}

function reconcileMainFieldRevision(db, current, expectedRevision, record) {
  const scope = current.executionSubject, supplied = record?.executionSubject;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= current.revision
    || current.archived || supplied?.version !== 2 || supplied.tabId !== scope.tabId
    || supplied.subjectId !== scope.subjectId || supplied.executionNamespace !== scope.executionNamespace
    || supplied.cwd !== scope.cwd || record.tabId !== scope.tabId
    || record.executionStorageRevision !== expectedRevision) return null;
  const receipt = db.prepare(`SELECT * FROM ${TABLE} WHERE tab_storage_id=?`).get(current.row.id);
  if (!receipt || receipt.namespace !== scope.executionNamespace || receipt.tab_id !== scope.tabId
    || receipt.subject_id !== scope.subjectId || receipt.from_revision > expectedRevision
    || receipt.to_revision !== current.revision) return null;
  return {version:1,kind:'main-owned-fields',namespace:scope.executionNamespace,
    tabId:scope.tabId,subjectId:scope.subjectId,fromRevision:expectedRevision,toRevision:current.revision,
    proofFromRevision:receipt.from_revision,
    fields:MAIN_OWNED_COLUMNS.filter((_field,index) => (receipt.field_mask & 2**index) !== 0)};
}

module.exports = {MAIN_OWNED_COLUMNS,ensureMainFieldReceipts,reconcileMainFieldRevision};
