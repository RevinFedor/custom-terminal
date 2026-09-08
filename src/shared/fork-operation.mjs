// Browser-safe twin of fork-operation.cjs. Vite serves local CJS source raw
// in dev; importing its synthetic default only works in the production bundle.
const FORK_OPERATIONS = new Set(['fork', 'rewind', 'edit', 'delete', 'provider']);

export function normalizeForkOperation(value) {
  return typeof value === 'string' && FORK_OPERATIONS.has(value) ? value : null;
}

export function historyRewriteOperation(mode) {
  return ({ history_edit: 'edit', history_delete: 'delete', history_rewind: 'rewind' })[mode] || null;
}

export function resolveForkOperation(record) {
  const raw = record?.operationKind ?? record?.operation_kind;
  const explicit = normalizeForkOperation(raw);
  if (explicit) return explicit;
  if (raw != null && raw !== '') return 'provider';
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

export function isVisibleAppFork(record) {
  return !!record && record.hidden !== true && record.hidden !== 1
    && resolveForkOperation(record) === 'fork';
}
