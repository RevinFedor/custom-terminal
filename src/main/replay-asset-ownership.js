'use strict';

// Joins existing owners. No retention table, provider writer, pump or timer.
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { normalizeStoredAssetId } = require('./prompt-queue-assets');
const { validOperationId, runAfterError: error } = require('../shared/run-after-api.cjs');
const { isAutomaticPromptQueueRequest } = require('../shared/prompt-queue-send-intent.cjs');
const json = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const ids = value => Array.isArray(value) && value.length <= 128
  && value.every(id => typeof id === 'string' && normalizeStoredAssetId(id) === id)
  && new Set(value).size === value.length;
const sameIds = (a, b) => a.length === b.length && a.every(id => b.includes(id));
const explicitIds = refs => [...new Set((Array.isArray(refs) ? refs : [])
  .map(ref => ref?.assetId).filter(id => typeof id === 'string' && normalizeStoredAssetId(id) === id))];
const inventoryIds = request => explicitIds([...(request?.presentationSnapshot?.imagePaths || []),
  ...(request?.authoringSnapshot?.imagePaths || []), ...(request?.ownedAttachments?.refs || [])]);

function validateAssetDisposition(sourceOperationId, input) {
  if (!validOperationId(sourceOperationId) || !keys(input, ['version', 'requestId', 'tabId', 'source',
    'expectedAssetIds', 'discardAssetIds', 'transferAssetIds', 'replacement']) || input.version !== 1
    || !validOperationId(input.requestId) || input.requestId === sourceOperationId || !text(input.tabId)
    || !keys(input.source, ['mainEpoch', 'mainScopeKey']) || !text(input.source.mainEpoch) || !text(input.source.mainScopeKey)
    || !ids(input.expectedAssetIds) || !ids(input.discardAssetIds) || !ids(input.transferAssetIds)
    || input.expectedAssetIds.length && !input.discardAssetIds.length && !input.transferAssetIds.length
    || [...input.discardAssetIds, ...input.transferAssetIds].some(id => !input.expectedAssetIds.includes(id))
    || input.discardAssetIds.some(id => input.transferAssetIds.includes(id))) throw error('run_after_asset_request_invalid', 400);
  const replacement = input.replacement;
  if (input.transferAssetIds.length) {
    if (replacement?.kind === 'project-send') {
      if (!keys(replacement, ['kind', 'tabId', 'handoffId', 'operationKey', 'provider', 'attemptId'])
        || !text(replacement.tabId) || !text(replacement.handoffId) || !text(replacement.operationKey)
        || !['codex', 'claude'].includes(replacement.provider)
        || replacement.attemptId !== null && !text(replacement.attemptId)
        || replacement.operationKey !== `project:${replacement.tabId}:${replacement.handoffId}`) throw error('run_after_asset_replacement_invalid', 400);
    } else if (replacement?.kind === 'run-after-item') {
      if (!keys(replacement, ['kind', 'tabId', 'operationId', 'mainEpoch', 'mainScopeKey', 'itemId'])
        || !text(replacement.tabId) || !validOperationId(replacement.operationId)
        || replacement.operationId === sourceOperationId || replacement.operationId === input.requestId
        || !text(replacement.mainEpoch) || !text(replacement.mainScopeKey) || !text(replacement.itemId)) throw error('run_after_asset_replacement_invalid', 400);
    } else throw error('run_after_asset_replacement_invalid', 400);
    if (replacement.tabId !== input.tabId) throw error('run_after_asset_replacement_target_mismatch', 409);
  } else if (replacement != null) throw error('run_after_asset_replacement_invalid', 400);
  return input;
}

// Exact source lease descriptor, not the current renderer/service UUID. An
// original Replay remains readable/disposable after the journal is reopened.
function assetLease(row, saved = json(row.request_json, {})) {
  const owned = json(row.asset_owner_json);
  if (saved.request?.op !== 'replay' && !owned) return null;
  return { version: 1, sourceOperationId: row.operation_id, tabId: row.target,
    mainEpoch: row.main_epoch, mainScopeKey: saved.scope?.scopeKey || null,
    assetIds: json(row.assets_json, []), released: row.released_at != null,
    ...(owned ? { owner: owned } : {}) };
}

function queueRecord(db, operationKey) {
  if (!table(db, 'agent_send_queue') || !table(db, 'agent_send_receipts')) return null;
  const item = db.prepare('SELECT * FROM agent_send_queue WHERE operation_key=?').get(operationKey);
  const row = db.prepare('SELECT * FROM agent_send_receipts WHERE operation_key=?').get(operationKey);
  if (!item || !row) return null;
  const request = json(item.request_json);
  if (!request || fingerprintAgentSendRequest(request) !== item.request_hash) return null;
  return { item, request, row, provider: row.provider, tabId: row.tab_id, handoffId: row.handoff_id,
    operationKey: row.operation_key, attemptId: row.attempt_id };
}

// A current canonical SIDE-CAR pin, not a visible row or a historical mobile
// ownership receipt. The exact common audit supplies the physical address.
function historyAssetOwner(db, record) {
  if (!record || !table(db, 'history_prompt_presentations')) return null;
  const r = record.row;
  if (r.state !== 'confirmed' || !r.attempt_id || r.audit_attempt_id !== r.attempt_id
    || r.audit_provider !== r.provider || !r.audit_session_id || !r.audit_timestamp || !r.audit_prompt_hash
    || !r.audit_entry_uuid && !r.audit_source_identity) return null;
  const row = db.prepare(`SELECT * FROM history_prompt_presentations WHERE tool_type=? AND session_id=?
    AND audit_timestamp=? AND transport_hash=? AND schema_version>=3`)
    .get(r.provider, r.audit_session_id, r.audit_timestamp, r.audit_prompt_hash);
  if (!row || r.audit_entry_uuid && row.entry_uuid !== r.audit_entry_uuid) return null;
  const chips = json(row.chips_json, []);
  if (!r.audit_entry_uuid) {
    // Source-only audits may later learn a UUID. Until then a same-time/hash
    // legacy row is not an address proof: require the existing trusted sidecar
    // projection's exact immutable origin + physical source binding.
    const { normalizeHistoryAuthoringProjection } = require('./history-authoring-projection');
    const { normalizeClaudeRequestPresentation } = require('./history-prompt-presentations');
    const candidates = chips.filter(part => part?.kind === (r.provider === 'codex' ? 'authoring-projection' : 'claude-request-presentation'));
    const bound = candidates.length === 1 && candidates.some(part => {
      const proof = part?.kind === 'authoring-projection' ? normalizeHistoryAuthoringProjection(part)
        : part?.kind === 'claude-request-presentation' ? normalizeClaudeRequestPresentation(part) : null;
      return proof?.origin.operationKey === r.operation_key && proof.origin.tabId === r.tab_id
        && proof.origin.handoffId === r.handoff_id && proof.origin.attemptId === r.attempt_id
        && proof.binding.sessionId === r.audit_session_id && proof.binding.sourceIdentity === r.audit_source_identity
        && proof.binding.auditTimestamp === r.audit_timestamp && proof.binding.transportHash === r.audit_prompt_hash;
    });
    if (!bound) return null;
  }
  const refs = chips.flatMap(part => part?.kind === 'image-ref' ? [part]
    : part?.kind === 'authoring-projection' ? (part.parts || []).filter(p => p?.kind === 'file')
      : part?.kind === 'claude-request-presentation' ? (part.ownedAttachments?.refs || []).filter(p => p.kind === 'file') : []);
  return { kind: 'canonical-history', assetIds: explicitIds(refs), provider: r.provider,
    sessionId: row.session_id, entryUuid: row.entry_uuid || null, sourceIdentity: r.audit_source_identity || null,
    auditTimestamp: row.audit_timestamp, transportHash: row.transport_hash };
}

function protectQueueAssets(db, operationKey, assetIds) {
  if (!assetIds.length) return;
  const item = db.prepare('SELECT * FROM agent_send_queue WHERE operation_key=?').get(operationKey);
  const held = [...new Set([...json(item.asset_transfer_ids_json, []), ...assetIds])];
  db.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=? WHERE operation_key=?').run(JSON.stringify(held), operationKey);
  db.prepare('INSERT OR IGNORE INTO agent_send_receipt_pins(operation_key,owner) VALUES(?,?)')
    .run(operationKey, 'replay-asset-transfer');
}

function releaseQueueTransferPin(db, operationKey) {
  db.prepare("UPDATE agent_send_queue SET asset_transfer_ids_json='[]' WHERE operation_key=?").run(operationKey);
  db.prepare("DELETE FROM agent_send_receipt_pins WHERE operation_key=? AND owner='replay-asset-transfer'").run(operationKey);
}

// Run within an existing SQLite transaction or synchronously before building a
// GC inventory. Completion alone never drops a transferred pin. Only a current
// exact canonical sidecar can adopt it; a later explicit History deletion may
// then release that sidecar normally. No new History read/provider audit.
function adoptCompletedQueueTransfers(db, operationKey = null) {
  if (!table(db, 'agent_send_queue') || !db.prepare('PRAGMA table_info(agent_send_queue)').all()
    .some(column => column.name === 'asset_transfer_ids_json')) return;
  db.transaction(() => {
    const rows = db.prepare("SELECT operation_key,asset_transfer_ids_json FROM agent_send_queue WHERE state='completed'"
      + " AND asset_transfer_ids_json!='[]'" + (operationKey ? ' AND operation_key=?' : '')).all(...(operationKey ? [operationKey] : []));
    for (const row of rows) {
      const owner = historyAssetOwner(db, queueRecord(db, row.operation_key));
      if (!owner) continue;
      const remaining = json(row.asset_transfer_ids_json, []).filter(id => !owner.assetIds.includes(id));
      if (!remaining.length) releaseQueueTransferPin(db, row.operation_key);
      else db.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=? WHERE operation_key=?')
        .run(JSON.stringify(remaining), row.operation_key);
    }
  })();
}

function replacementOwner(journal, manager, input) {
  const db = journal.db, replacement = input.replacement, wanted = input.transferAssetIds;
  if (replacement.kind === 'project-send') {
    const record = queueRecord(db, replacement.operationKey);
    if (!record) throw error('run_after_asset_replacement_missing');
    const { item, row } = record;
    if (row.surface !== 'project-api' || row.tab_id !== replacement.tabId || item.tab_id !== replacement.tabId
      || row.handoff_id !== replacement.handoffId || row.provider !== replacement.provider
      || (row.attempt_id || null) !== replacement.attemptId) throw error('run_after_asset_replacement_identity_changed');
    if (!wanted.every(id => inventoryIds(record.request).includes(id))) throw error('run_after_asset_replacement_coverage');
    const held = new Set([...json(item.asset_ids_json, []), ...json(item.asset_transfer_ids_json, [])]);
    const current = !['completed', 'merged'].includes(item.state) && wanted.every(id => held.has(id))
      || wanted.every(id => json(item.asset_transfer_ids_json, []).includes(id));
    if (current) {
      protectQueueAssets(db, replacement.operationKey, wanted);
      return { ...replacement, owner: 'application-send-queue', state: item.state, assetIds: wanted };
    }
    const history = historyAssetOwner(db, record);
    if (!history || !wanted.every(id => history.assetIds.includes(id))) throw error('run_after_asset_replacement_not_retained');
    return { ...replacement, owner: 'canonical-history', assetIds: wanted, history };
  }
  const row = journal.record(replacement.operationId), saved = row && json(row.request_json);
  const request = saved?.request;
  if (!row || row.phase !== 'applied' || row.target !== replacement.tabId || !['add', 'update'].includes(request?.op)
    || row.main_epoch !== replacement.mainEpoch || saved.scope?.scopeKey !== replacement.mainScopeKey
    || (request.op === 'add' ? json(row.result_json)?.itemId : request.args?.id) !== replacement.itemId
    || row.released_at != null) throw error('run_after_asset_replacement_identity_changed');
  const savedQueues = manager.getAppState('promptQueueByTab');
  const queues = typeof savedQueues === 'string' ? json(savedQueues, {}) : savedQueues || {};
  const item = queues[replacement.tabId]?.items?.find(item => item.id === replacement.itemId);
  if (!item || item.metaAction || !wanted.every(id => explicitIds(item.imagePaths).includes(id))) throw error('run_after_asset_replacement_coverage');
  const held = [...new Set([...json(row.assets_json, []), ...wanted])];
  db.prepare('UPDATE run_after_operations SET assets_json=?,asset_owner_json=?,updated_at=? WHERE operation_id=?')
    .run(JSON.stringify(held), JSON.stringify({ kind: 'run-after-item', itemId: item.id }), journal.now(), row.operation_id);
  return { ...replacement, owner: 'run-after-item-journal', assetIds: wanted };
}

// Admission of the SAME automatic item moves its protected byte set into the
// existing immutable FIFO in the SAME enqueue transaction. Edits/subsets keep
// unmatched bytes in the prior lease; no claim about provider delivery.
function adoptRunAfterItemAssets(db, identity, request) {
  const itemId = request?.promptQueueIntent?.itemId;
  if (!isAutomaticPromptQueueRequest(request) || !text(itemId) || !table(db, 'run_after_operations') || !db.prepare('PRAGMA table_info(run_after_operations)').all()
    .some(column => column.name === 'asset_owner_json')) return;
  const covered = inventoryIds(request);
  for (const row of db.prepare("SELECT * FROM run_after_operations WHERE target=? AND released_at IS NULL"
    + " AND asset_owner_json IS NOT NULL AND assets_json!='[]'").all(identity.tabId)) {
    const owner = json(row.asset_owner_json);
    if (owner?.kind !== 'run-after-item' || owner.itemId !== itemId) continue;
    const held = json(row.assets_json, []), moved = held.filter(id => covered.includes(id));
    if (!moved.length) continue;
    protectQueueAssets(db, identity.operationKey, moved);
    const remaining = held.filter(id => !moved.includes(id));
    db.prepare('UPDATE run_after_operations SET assets_json=?,released_at=?,updated_at=? WHERE operation_id=?')
      .run(JSON.stringify(remaining), remaining.length ? null : Date.now(), Date.now(), row.operation_id);
  }
}

// The typed, already scope/CAS-validated mutation is an explicit authoring
// action. Remove/clear/edited refs are discard; Replay moves only bytes held by
// the new Replay ticket. An arbitrary state snapshot/unknown send is NOT such
// permission and deliberately does not call this function.
function settleRunAfterItemAssetMutation(db, row, writes, now) {
  if (typeof writes?.promptQueueByTab !== 'string') return;
  const request = json(row.request_json)?.request, op = request?.op;
  if (!['remove', 'clear', 'update', 'replay'].includes(op)) return;
  const queues = json(writes.promptQueueByTab, {}), selected = request.args?.id;
  if (op === 'update' && request.args?.imagePaths === undefined) return;
  for (const lease of db.prepare("SELECT * FROM run_after_operations WHERE target=? AND operation_id!=?"
    + " AND released_at IS NULL AND asset_owner_json IS NOT NULL AND assets_json!='[]'").all(row.target, row.operation_id)) {
    const owner = json(lease.asset_owner_json);
    if (owner?.kind !== 'run-after-item' || op !== 'clear' && owner.itemId !== selected) continue;
    const held = json(lease.assets_json, []), current = queues[row.target]?.items?.find(item => item.id === owner.itemId);
    const keep = op === 'replay' ? held.filter(id => !json(row.assets_json, []).includes(id))
      : current ? held.filter(id => explicitIds(current.imagePaths).includes(id)) : [];
    db.prepare('UPDATE run_after_operations SET assets_json=?,released_at=?,updated_at=? WHERE operation_id=?')
      .run(JSON.stringify(keep), keep.length ? null : now, now, lease.operation_id);
  }
}

async function disposeReplayAssets(journal, manager, assetStore, sourceOperationId, rawInput) {
  const input = validateAssetDisposition(sourceOperationId, rawInput);
  const request = { op: 'assetDisposition', sourceOperationId, input };
  const requestHash = fingerprintAgentSendRequest({ target: input.tabId, request });
  const previous = () => {
    const row = journal.record(input.requestId);
    if (!row) return null;
    if (row.target !== input.tabId || row.request_hash !== requestHash) throw error('run_after_asset_request_conflict');
    return journal.read(input.requestId, input.tabId);
  };
  const replay = previous();
  if (replay && replay.phase !== 'unknown') return replay;
  if (!assetStore && input.transferAssetIds.length) throw error('run_after_asset_owner_unavailable', 503);
  // Freeze the FIRST admitted body before any filesystem await. A second body
  // cannot win this request ID while hashing is suspended. After restart an
  // unknown byte-only disposition may resume only this exact frozen request:
  // its ownership writes and terminal receipt share one SQLite transaction,
  // and there is no external writer/Send to repeat. Generic RunAfter/FIFO
  // unknown operations do NOT gain this recovery permission.
  if (!replay) journal.db.transaction(() => journal.reserve(input.requestId, input.tabId, request, { assetDisposition: true })).immediate();
  const releases = []; let byteError = null;
  try {
    // Use the SAME async GC exclusion as imports. A collector with an older
    // snapshot either observes this lease/revision or finishes its exact unlink
    // before verification. No large synchronous hashing in Main.
    for (const id of input.transferAssetIds) {
      releases.push(await assetStore.lease(id));
      try {
        const fs = require('node:fs');
        const stat = await fs.promises.lstat(assetStore.assetPath(id));
        await assetStore.verifyOwnedRef({ assetId: id, size: stat.size });
      } catch { byteError = 'run_after_asset_bytes_unavailable'; }
    }
    const receipt = journal.db.transaction(() => {
      const replay = previous();
      if (replay && ['applied', 'rejected'].includes(replay.phase)) return replay;
      const source = journal.record(sourceOperationId), lease = source && assetLease(source);
      let refusal = byteError, owner = null;
      if (!lease || source.target !== input.tabId || source.phase !== 'applied'
        || source.main_epoch !== input.source.mainEpoch || lease.mainScopeKey !== input.source.mainScopeKey) refusal = 'run_after_asset_source_invalid';
      else if (source.released_at != null || !sameIds(lease.assetIds, input.expectedAssetIds)) refusal = 'run_after_asset_lease_changed';
      // Validate every member before touching any replacement inventory. A
      // refusal is itself an immutable journal receipt, not a retry directive.
      if (!refusal && input.transferAssetIds.length) {
        try { owner = replacementOwner(journal, manager, input); }
        catch (failure) { refusal = failure.code || 'run_after_asset_proof_unavailable'; }
      }
      const at = journal.now(), remaining = refusal ? lease?.assetIds || []
        : lease.assetIds.filter(id => !input.discardAssetIds.includes(id) && !input.transferAssetIds.includes(id));
      const result = { version: 1, requestId: input.requestId, sourceOperationId, tabId: input.tabId,
        disposition: refusal ? 'retained' : remaining.length ? 'partial' : 'released',
        sourceReleased: !refusal && !remaining.length, transferredAssetIds: refusal ? [] : input.transferAssetIds,
        discardedAssetIds: refusal ? [] : input.discardAssetIds, retainedAssetIds: remaining,
        replacement: refusal ? null : owner, committedAt: at, historical: true,
        ...(refusal ? { error: refusal, statusCode: 409 } : {}) };
      if (!refusal) journal.db.prepare('UPDATE run_after_operations SET assets_json=?,released_at=?,updated_at=? WHERE operation_id=?')
        .run(JSON.stringify(remaining), remaining.length ? null : at, at, sourceOperationId);
      journal.db.prepare('UPDATE run_after_operations SET phase=?,result_json=?,error=?,updated_at=? WHERE operation_id=?')
        .run(refusal ? 'rejected' : 'applied', JSON.stringify(result), refusal, at, input.requestId);
      return journal.read(input.requestId, input.tabId);
    }).immediate();
    const result = receipt.result;
    console.log('[RunAfterAssets] request=' + input.requestId.slice(0, 90) + ' source=' + sourceOperationId.slice(0, 90)
      + ' disposition=' + result.disposition + ' transferred=' + result.transferredAssetIds.length
      + ' discarded=' + result.discardedAssetIds.length + ' retained=' + result.retainedAssetIds.length
      + ' owner=' + (result.replacement?.owner || '-') + ' error=' + (result.error || '-'));
    return receipt;
  } catch (failure) {
    // The final immediate transaction rolls back every ownership write on
    // failure. Keep a recoverable SAME-ID journal, not a no-submit assertion.
    return journal.unknown(input.requestId, failure.code || 'run_after_asset_disposition_interrupted');
  } finally { for (const release of releases) release(); }
}

module.exports = { assetLease, disposeReplayAssets, historyAssetOwner, queueRecord, protectQueueAssets,
  releaseQueueTransferPin, adoptCompletedQueueTransfers, adoptRunAfterItemAssets, settleRunAfterItemAssetMutation, explicitIds };
