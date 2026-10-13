'use strict';

const crypto = require('crypto');

const HOUR_MS = 60 * 60 * 1000;
const TABLE = 'storage_retention_grace';

function graceApplies(item) {
  return item.section === 'sessions' || item.group === 'app-backup';
}

function graceFingerprint(item) {
  return crypto.createHash('sha256').update(JSON.stringify([
    item.path, item.fileIdentity || null, item.provider || null,
    item.sessionId || null, item.group, item.recoveryCopy === true,
    item.sizeBytes, item.modifiedAt || null, item.closedAt || null,
  ])).digest('hex');
}

// This clock begins when the item is first proven unprotected, not at its old
// JSONL mtime. Never and protected items do not have a deletion clock.
function reconcileStorageGrace(items, settings, nowMs, previous = new Map()) {
  const clocks = new Map();
  const decorated = items.map((item) => {
    if (!graceApplies(item)) return { ...item };
    if (item.protected || !item.deletable || item.deleteAfter == null) {
      return { ...item, eligible: false, unprotectedSince: null, graceDeleteAfter: null };
    }
    const fingerprint = graceFingerprint(item);
    const old = previous.get(item.id);
    const unprotectedSince = old?.fingerprint === fingerprint
      && Number.isFinite(old.since) && old.since > 0 && old.since <= nowMs
      ? old.since : nowMs;
    clocks.set(item.id, {
      id: item.id, fingerprint, since: unprotectedSince,
      provider: item.provider || null, sessionId: item.sessionId || null,
      recoveryCopy: item.recoveryCopy === true,
    });
    const graceDeleteAfter = unprotectedSince + settings.gracePeriodHours * HOUR_MS;
    const deleteAfter = Math.max(item.deleteAfter, graceDeleteAfter);
    return {
      ...item, unprotectedSince, graceDeleteAfter, deleteAfter,
      eligible: settings.enabled === true && deleteAfter <= nowMs,
    };
  });
  return { items: decorated, clocks };
}

// Used by isolated service fixtures without a native SQLite owner. Production
// always uses the durable store below; losing a clock grants a fresh full wait.
class MemoryStorageGraceStore {
  constructor() { this.clocks = new Map(); }
  reconcile(update) {
    const result = update(this.clocks);
    this.clocks = result.clocks;
    return result.items;
  }
  get(id) { return this.clocks.get(id); }
}

class SqliteStorageGraceStore {
  constructor(sqlite) {
    this.sqlite = sqlite;
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      item_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      unprotected_since INTEGER NOT NULL, provider TEXT, session_id TEXT,
      recovery_copy INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS storage_retention_grace_session
      ON ${TABLE}(provider, session_id);`);
    const columns = new Set(sqlite.prepare('PRAGMA table_info(tabs)').all().map((row) => row.name));
    if (!columns.has('codex_session_id') || !columns.has('claude_session_id')) {
      throw new Error('storage_retention_binding_authority_unavailable');
    }
    // A restore followed by another close can happen between two six-hour
    // scans. Invalidate within the actual binding transaction, not via a UI
    // close event or a new background transcript scan.
    const invalidateBindings = `DELETE FROM ${TABLE} WHERE recovery_copy=0 AND (
      (provider='codex' AND session_id=NEW.codex_session_id) OR
      (provider='claude' AND session_id=NEW.claude_session_id)
    );`;
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS storage_grace_tab_insert
      AFTER INSERT ON tabs BEGIN ${invalidateBindings} END;
    CREATE TRIGGER IF NOT EXISTS storage_grace_tab_binding
      AFTER UPDATE OF codex_session_id, claude_session_id ON tabs
      WHEN NEW.codex_session_id IS NOT OLD.codex_session_id
        OR NEW.claude_session_id IS NOT OLD.claude_session_id
      BEGIN ${invalidateBindings} END;`);
    const eventColumns = new Set(sqlite.prepare('PRAGMA table_info(session_history_events)').all().map((row) => row.name));
    if (['provider', 'source_session_id', 'lineage_manifest_json'].every((field) => eventColumns.has(field))) {
      const invalidateSources = `DELETE FROM ${TABLE}
        WHERE recovery_copy=0 AND provider=NEW.provider AND (
          session_id=NEW.source_session_id OR session_id IN (
            SELECT COALESCE(
              json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.physicalSessionId'),
              json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.sessionId'))
            FROM json_each(CASE WHEN json_valid(NEW.lineage_manifest_json)
              THEN NEW.lineage_manifest_json ELSE '{}' END, '$.sourceSegments')
          )
        );`;
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS storage_grace_lineage_insert
        AFTER INSERT ON session_history_events BEGIN ${invalidateSources} END;
      CREATE TRIGGER IF NOT EXISTS storage_grace_lineage_update
        AFTER UPDATE OF source_session_id, lineage_manifest_json ON session_history_events
        BEGIN ${invalidateSources} END;`);
    }
    this.readAll = sqlite.prepare(`SELECT * FROM ${TABLE}`);
    this.readOne = sqlite.prepare(`SELECT * FROM ${TABLE} WHERE item_id=?`);
    this.remove = sqlite.prepare(`DELETE FROM ${TABLE} WHERE item_id=?`);
    this.write = sqlite.prepare(`INSERT INTO ${TABLE}
      (item_id,fingerprint,unprotected_since,provider,session_id,recovery_copy)
      VALUES (?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
      fingerprint=excluded.fingerprint,unprotected_since=excluded.unprotected_since,
      provider=excluded.provider,session_id=excluded.session_id,recovery_copy=excluded.recovery_copy`);
    this.transaction = sqlite.transaction((update) => {
      const previous = new Map(this.readAll.all().map((row) => [row.item_id, this.decode(row)]));
      const result = update(previous);
      for (const id of previous.keys()) if (!result.clocks.has(id)) this.remove.run(id);
      for (const [id, clock] of result.clocks) {
        const old = previous.get(id);
        if (old?.fingerprint === clock.fingerprint && old.since === clock.since) continue;
        this.write.run(id, clock.fingerprint, clock.since, clock.provider, clock.sessionId, clock.recoveryCopy ? 1 : 0);
      }
      return result.items;
    });
  }
  decode(row) {
    return row ? {
      id: row.item_id, fingerprint: row.fingerprint, since: row.unprotected_since,
      provider: row.provider, sessionId: row.session_id, recoveryCopy: row.recovery_copy === 1,
    } : undefined;
  }
  reconcile(update) { return this.transaction.immediate(update); }
  get(id) { return this.decode(this.readOne.get(id)); }
}

module.exports = {
  HOUR_MS, MemoryStorageGraceStore, SqliteStorageGraceStore,
  graceApplies, graceFingerprint, reconcileStorageGrace,
};
