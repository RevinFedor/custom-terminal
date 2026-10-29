'use strict';

// The user's operation is independent of the provider's physical branch mode.
// New CLI branch modes must never opt themselves into a visible Fork stripe.
const FORK_OPERATIONS = new Set(['fork', 'rewind', 'edit', 'delete', 'provider']);

function normalizeForkOperation(value) {
  return typeof value === 'string' && FORK_OPERATIONS.has(value) ? value : null;
}

function historyRewriteOperation(mode) {
  return ({ history_edit: 'edit', history_delete: 'delete', history_rewind: 'rewind' })[mode] || null;
}

function resolveForkOperation(record) {
  const raw = record?.operationKind ?? record?.operation_kind;
  const explicit = normalizeForkOperation(raw);
  if (explicit) return explicit;
  if (raw != null && raw !== '') return 'provider';
  // Compatibility for old, known materialized app operations only. A technical
  // direct-virtual/unknown/future provider mode does not prove a user Fork.
  const mode = record?.forkMode ?? record?.fork_mode;
  const rewrite = historyRewriteOperation(mode);
  if (rewrite) return rewrite;
  if ((mode === 'full' || mode === 'latest_compact')
    && (!record?.origin || ['app', 'terminal-mcp', 'orchestration', 'legacy-fork-marker'].includes(record.origin))) {
    return 'fork';
  }
  if (!mode && record?.origin === 'legacy-fork-marker') return 'fork';
  return 'provider';
}

function isVisibleAppFork(record) {
  return !!record && record.hidden !== true && record.hidden !== 1
    && resolveForkOperation(record) === 'fork';
}

module.exports = { normalizeForkOperation, historyRewriteOperation, resolveForkOperation, isVisibleAppFork };
