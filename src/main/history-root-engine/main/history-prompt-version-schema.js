'use strict';
// One source for the installed trigger contract and its read-only witness proof.
const LEGACY_HISTORY_PROMPT_VERSION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS history_prompt_revision_versions (
        tool_type TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS history_prompt_revision_insert
      AFTER INSERT ON history_prompt_presentations BEGIN
        INSERT INTO history_prompt_revision_versions(tool_type, version) VALUES (NEW.tool_type, 1)
        ON CONFLICT(tool_type) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS history_prompt_revision_delete
      AFTER DELETE ON history_prompt_presentations BEGIN
        INSERT INTO history_prompt_revision_versions(tool_type, version) VALUES (OLD.tool_type, 1)
        ON CONFLICT(tool_type) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS history_prompt_revision_update
      AFTER UPDATE ON history_prompt_presentations
      WHEN OLD.tool_type IS NOT NEW.tool_type OR OLD.session_id IS NOT NEW.session_id
        OR OLD.audit_timestamp IS NOT NEW.audit_timestamp OR OLD.transport_hash IS NOT NEW.transport_hash
        OR OLD.entry_uuid IS NOT NEW.entry_uuid OR OLD.schema_version IS NOT NEW.schema_version
        OR OLD.chips_json IS NOT NEW.chips_json
      BEGIN
        INSERT INTO history_prompt_revision_versions(tool_type, version) VALUES (NEW.tool_type, 1)
        ON CONFLICT(tool_type) DO UPDATE SET version = version + 1;
        INSERT INTO history_prompt_revision_versions(tool_type, version)
        SELECT OLD.tool_type, 1 WHERE OLD.tool_type IS NOT NEW.tool_type
        ON CONFLICT(tool_type) DO UPDATE SET version = version + 1;
      END;
    `;
// updated_at participates in the session candidate ORDER BY, including
// duplicate entry_uuid rows. It is selection data, not only bookkeeping.
const HISTORY_PROMPT_VERSION_SCHEMA = LEGACY_HISTORY_PROMPT_VERSION_SCHEMA.replace(
  'OR OLD.chips_json IS NOT NEW.chips_json',
  'OR OLD.chips_json IS NOT NEW.chips_json OR OLD.updated_at IS NOT NEW.updated_at');
const normalizeHistoryVersionDDL = sql => sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');

// Main boot only. Replace exactly our known legacy DDL atomically; preserve
// unknown/custom triggers so read-only attestation stays conservative.
function installOwnedHistoryVersionTrigger(db, name, current, legacy) {
  const installed = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql;
  if (!installed) { db.exec(current); return; }
  if (normalizeHistoryVersionDDL(installed) === normalizeHistoryVersionDDL(current)) return;
  if (normalizeHistoryVersionDDL(installed) !== normalizeHistoryVersionDDL(legacy)) return;
  db.exec('DROP TRIGGER ' + name);
  db.exec(current);
}
function installHistoryPromptVersionSchema(db) {
  db.transaction(() => {
    db.exec(HISTORY_PROMPT_VERSION_SCHEMA.split('CREATE TRIGGER')[0]);
    const triggers = sql => [...sql.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)[\s\S]*?END;/g)];
    const legacy = new Map(triggers(LEGACY_HISTORY_PROMPT_VERSION_SCHEMA).map(m => [m[1], m[0]]));
    for (const match of triggers(HISTORY_PROMPT_VERSION_SCHEMA))
      installOwnedHistoryVersionTrigger(db,match[1],match[0],legacy.get(match[1]));
  })();
}
module.exports = { HISTORY_PROMPT_VERSION_SCHEMA, LEGACY_HISTORY_PROMPT_VERSION_SCHEMA,
  installHistoryPromptVersionSchema, installOwnedHistoryVersionTrigger };
