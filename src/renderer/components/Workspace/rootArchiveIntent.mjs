import { GLOBAL_EXECUTION_NAMESPACE } from '../../utils/workflowMembership.mjs';
import { tabNavigationLocation } from '../../utils/tabNavigationLocation.mjs';

// Main owns the metadata hash. The renderer only copies its exact read scope.
export function archiveServiceScopes(snapshot, retained = []) {
  const scopes = new Map(retained.map(scope => [scope.namespace, {...scope, cwds:[...scope.cwds], count:0, historyIds:[], rowsHash:null}]));
  if (!scopes.has(GLOBAL_EXECUTION_NAMESPACE)) scopes.set(GLOBAL_EXECUTION_NAMESPACE, {
    namespace:GLOBAL_EXECUTION_NAMESPACE, cwds:[], count:0, historyIds:[], rowsHash:null,
  });
  const rows = [...(snapshot?.history || []), ...(snapshot?.favorites || [])];
  for (const row of rows) {
    if (!scopes.has(row.namespace)) scopes.set(row.namespace, {namespace:row.namespace, cwds:[], count:0, historyIds:[], rowsHash:null});
    const scope = scopes.get(row.namespace);
    if (row.cwd && !scope.cwds.includes(row.cwd)) scope.cwds.push(row.cwd);
  }
  for (const row of snapshot?.history || []) {
    const scope = scopes.get(row.namespace);
    scope.historyIds.push(row.id); scope.count++;
  }
  for (const scope of snapshot?.clearScopes || []) scopes.set(scope.namespace, {
    ...scope, cwds:[...scope.cwds], historyIds:[...scope.historyIds],
  });
  return [...scopes.values()].sort((a,b) => a.namespace === GLOBAL_EXECUTION_NAMESPACE ? -1 : b.namespace === GLOBAL_EXECUTION_NAMESPACE ? 1 : 0);
}

export function archiveScopeLabel(scope) {
  const title = scope.namespace === GLOBAL_EXECUTION_NAMESPACE ? 'Общий архив'
    : 'Архив: ' + (scope.cwds.length ? scope.cwds.map(cwd => cwd || 'Каталог не указан').join(', ') : 'без записей');
  return `${title} · Все каталоги (${scope.cwds.length}) · записей: ${scope.count}`;
}

export function freezeArchiveClearIntent(kind, scope, dateFrom, requestId) {
  if (!scope?.namespace) throw new Error('Выберите архив');
  const history = kind === 'clear-history' || kind === 'clear-except-notes';
  if (history && (typeof scope.rowsHash !== 'string' || !scope.rowsHash || !Array.isArray(scope.historyIds)))
    throw new Error('Не удалось проверить состав архива. Обновите архив и откройте подтверждение заново.');
  return Object.freeze({kind, namespace:scope.namespace, dateFrom:dateFrom || null, requestId,
    historyIds:Object.freeze([...scope.historyIds]), expectedMetadataHash:scope.rowsHash,
    scopeSummary:Object.freeze({label:archiveScopeLabel(scope), count:scope.count, notesCount:scope.notesCount ?? null,
      cwds:Object.freeze([...scope.cwds])})});
}

export function archiveClearRequest(intent) {
  return {version:1, requestId:intent.requestId, namespace:intent.namespace, kind:intent.kind,
    historyIds:[...intent.historyIds], expectedRowsHash:intent.expectedMetadataHash};
}

export function archiveClearAcknowledged(receipt, request) {
  return receipt?.success === true && receipt.version === request.version && receipt.requestId === request.requestId
    && receipt.namespace === request.namespace && receipt.kind === request.kind
    && receipt.expectedRowsHash === request.expectedRowsHash && Array.isArray(receipt.historyIds)
    && receipt.historyIds.length === request.historyIds.length
    && receipt.historyIds.every((id,index) => id === request.historyIds[index]) && Array.isArray(receipt.deletedIds)
    && new Set(receipt.deletedIds).size === receipt.deletedIds.length
    && receipt.deletedIds.every(id => request.historyIds.includes(id))
    && (request.kind !== 'clear-history' || receipt.deletedIds.length === request.historyIds.length);
}

export function archiveClearFailure(error) {
  const message = error?.message || String(error);
  if (message.includes('archive_clear_scope_changed'))
    return 'Состав архива изменился. Очистка не применена. Отмените подтверждение, обновите архив и проверьте новый состав.';
  if (message.includes('archive_restore_busy'))
    return 'В этом архиве ещё выполняется восстановление вкладки. Очистка не применена. Повторите после завершения восстановления.';
  return message;
}

// A sticky lease: away/back and cancellation never revive an old callback.
// Only direct, synchronous mutations made by this intent may advance its location.
export function createArchiveNavigationIntent(initial, ownerId) {
  let key = tabNavigationLocation(initial), revision = initial.navigationRevision || 0;
  let activeId = initial.activeTabNavigationIntent?.id || null, ownedId = null;
  let valid = true, applying = false;
  const observe = next => {
    if (!valid) return;
    const nextKey = tabNavigationLocation(next), nextRevision = next.navigationRevision || 0;
    const nextId = next.activeTabNavigationIntent?.id || null;
    const changed = nextKey !== key || nextRevision !== revision || nextId !== activeId;
    if (!changed) return;
    if (applying || (next.navigationMutationOwner === (ownedId || ownerId)
      && next.navigationKey === nextKey && nextRevision > revision && nextId === activeId)) {
      if (applying && nextId !== activeId) ownedId = nextId;
      key = nextKey; revision = nextRevision; activeId = nextId;
    } else valid = false;
  };
  return {
    observe,
    isCurrent(next) {observe(next); return valid;},
    cancel() {valid = false;},
    get ownedNavigationId() {return ownedId;},
    applyOwnedNavMutations(operation) {
      applying = true;
      try {return operation();} finally {applying = false;}
    },
  };
}
