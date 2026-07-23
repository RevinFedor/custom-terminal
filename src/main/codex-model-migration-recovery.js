'use strict';

const crypto = require('node:crypto');
const {
  normalizeCodexMigrationModelLabel,
} = require('./codex-model-picker');

function hashCodexConfigSnapshot(configText) {
  return crypto
    .createHash('sha256')
    .update(String(configText || ''))
    .digest('hex');
}

function classifyCodexModelMigrationRecovery(configText, {
  sourceModel,
  sourceEffort = null,
} = {}) {
  // Codex's TUI uses display labels (for example, "GPT-5.6 Luna") while
  // SQLite and the CLI contract use IDs. Recovery must never persist the
  // display label just because it was the only durable evidence after restart.
  const normalizedSourceModel = normalizeCodexMigrationModelLabel(sourceModel);
  const normalizedSourceEffort = typeof sourceEffort === 'string'
    ? sourceEffort.trim().toLowerCase()
    : '';
  if (!normalizedSourceModel) {
    return { action: 'block', reason: 'migration-journal-incomplete' };
  }

  const text = String(configText || '');
  const currentFingerprint = hashCodexConfigSnapshot(text);
  // An intact journal after restart has no durable acknowledgement tying a
  // shared config write to this tab's Enter. Another tab can produce the same
  // exact target config, so config contents may describe a change but never
  // prove its owner. Settle the journal to its known source instead of either
  // committing a possibly foreign target or blocking recovery indefinitely.
  // A later live launch will get a fresh, tab-specific acknowledgement.
  return {
    action: 'rollback-source',
    model: normalizedSourceModel,
    effort: normalizedSourceEffort || null,
    currentFingerprint,
  };
}

module.exports = {
  classifyCodexModelMigrationRecovery,
  hashCodexConfigSnapshot,
};
