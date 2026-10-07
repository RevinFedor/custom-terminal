'use strict';
const { RunAfterOperationJournal } = require('./run-after-operation-journal');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { frameKey } = require('./workspace-switcher-api');
const { RUN_AFTER_CAPABILITY, QUEUE_OPS, AUTO_COMPACT_OPS, validateRunAfterEnvelope,
  validOperationId, runAfterError: error } = require('../shared/run-after-api.cjs');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

class RunAfterApplicationAPI {
  constructor({ manager, bridge, frame, scope, commitState, afterCommit = () => {}, prepareAuthoring = async value => value }) {
    Object.assign(this, { manager, bridge, frame, scope, afterCommit, prepareAuthoring });
    this.journal = new RunAfterOperationJournal({ db: manager.db, commitState,
      scopeCurrent: (target, saved) => this.scopeIsCurrent(target, saved) });
    this.capability = RUN_AFTER_CAPABILITY;
  }
  scopeKey(target) { return fingerprintAgentSendRequest({ target, scope: this.scope(target) }); }
  scopeIsCurrent(target, saved) {
    return saved.scopeKey === this.scopeKey(target) && this.frameIsCurrent(saved.frame)
      && (!saved.actionTarget || saved.actionTarget.scopeKey === this.scopeKey(saved.actionTarget.tabId));
  }
  frameSnapshot() {
    const sender = this.frame();
    if (!sender || sender.isDestroyed() || !frameKey(sender.mainFrame)) throw error('run_after_renderer_unavailable', 503);
    return { webContentsId: sender.id, frame: frameKey(sender.mainFrame) };
  }
  frameIsCurrent(snapshot) {
    try { const current = this.frameSnapshot(); return current.webContentsId === snapshot.webContentsId && current.frame === snapshot.frame; }
    catch { return false; }
  }
  async read(target, kind = 'queue', options = {}) {
    const frame = this.frameSnapshot(), scopeKey = this.scopeKey(target);
    let value;
    try {
      value = await this.bridge('readRunAfter', { target, kind, mainEpoch: this.journal.epoch,
        includeActions: options.includeActions === true });
    } catch (failure) {
      if (failure?.bridgeData?.code) throw error(failure.bridgeData.code, failure.bridgeData.statusCode || 503);
      throw failure;
    }
    if (!this.frameIsCurrent(frame) || scopeKey !== this.scopeKey(target)) throw error('run_after_scope_changed');
    const metadata = kind === 'queue' ? value?.runAfter : value;
    if (metadata?.version !== 1 || metadata.known !== true || !metadata.epoch?.startsWith(this.journal.epoch + ':')) {
      throw error(value?.error || 'run_after_snapshot_unavailable', value?.statusCode || 503);
    }
    const scope = this.scope(target);
    if (kind === 'queue' && scope?.loopTextHash
      && fingerprintAgentSendRequest(value.queue?.loopPromptText) !== scope.loopTextHash) {
      throw error('run_after_loop_sync_pending', 503);
    }
    const result = copy(value), projected = kind === 'queue' ? result.runAfter : result;
    if (projected.guard) projected.guard.mainScopeKey = scopeKey;
    projected.mainScopeKey = scopeKey;
    projected.mainEpoch = this.journal.epoch;
    return result;
  }
  async mutate(target, input, kind = 'queue') {
    const envelope = validateRunAfterEnvelope(input, kind === 'queue' ? QUEUE_OPS : AUTO_COMPACT_OPS);
    const existing = this.journal.record(envelope.operationId);
    if (existing) return this.journal.reserve(envelope.operationId, target, input, null).receipt;
    const frame = this.frameSnapshot(), scopeKey = this.scopeKey(target);
    if (envelope.expected.mainScopeKey !== scopeKey || !envelope.expected.epoch.startsWith(this.journal.epoch + ':')) {
      throw error('run_after_scope_changed');
    }
    let actionTarget = null;
    if (kind === 'auto-compact' && ['requestNow', 'cancel'].includes(input.op)) {
      const guard = input.args.targetGuard, tabId = input.args.tabId;
      if (typeof tabId !== 'string' || !tabId || tabId.startsWith('@') || !guard
        || guard.epoch !== envelope.expected.epoch || guard.mainScopeKey !== this.scopeKey(tabId)) {
        throw error('run_after_target_scope_changed');
      }
      actionTarget = { tabId, scopeKey: guard.mainScopeKey };
    }
    const admitted = this.journal.reserve(envelope.operationId, target, input, { frame, scopeKey, actionTarget });
    const ticket = admitted.ticket;
    let dispatched = false;
    let reply;
    try {
    try {
      const prepared = kind === 'queue' && ['add', 'update'].includes(input.op)
        ? await this.prepareAuthoring(input.args, ticket, this.journal) : input.args;
      if (!this.scopeIsCurrent(target, { frame, scopeKey, actionTarget })) throw error('run_after_scope_changed');
      dispatched = true;
      reply = await this.bridge('mutateRunAfter', { target, kind, mainEpoch: this.journal.epoch, ticket,
        input: { ...input, args: prepared } });
    } catch (failure) {
      const current = this.journal.read(envelope.operationId, target);
      if (current?.phase === 'applied' || current?.phase === 'rejected') return current;
      // Only preparation/not-dispatched failure is a proven rejection. A
      // bridge timeout is an observation deadline, not another mutation.
      if (!dispatched || failure?.dispatched === false || failure?.runAfterNotDispatched === true) {
        return this.journal.finish(ticket, { rejected: true, error: failure.code || 'run_after_prepare_failed',
          result: { error: failure.code || 'run_after_prepare_failed', statusCode: failure.statusCode || 503 } });
      }
      return this.journal.unknown(envelope.operationId, failure.code || 'run_after_outcome_unknown');
    }
    const receipt = this.journal.read(envelope.operationId, target);
    if (reply?.current && this.frameIsCurrent(frame) && scopeKey === this.scopeKey(target)) {
      const current = copy(reply.current), metadata = kind === 'queue' ? current.runAfter : current;
      if (metadata?.guard) metadata.guard.mainScopeKey = scopeKey;
      if (metadata) metadata.mainScopeKey = scopeKey;
      if (metadata) metadata.mainEpoch = this.journal.epoch;
      return { ...receipt, currentSnapshot: current };
    }
    return receipt;
    } catch (failure) {
      failure.operationId = envelope.operationId;
      failure.mutationMayHaveApplied = dispatched;
      throw failure;
    }
  }
  authorize(event, ticket) {
    const row = this.journal.authorize(ticket), saved = JSON.parse(row.request_json).scope;
    if (event?.sender?.id !== saved.frame.webContentsId || frameKey(event?.senderFrame) !== saved.frame.frame
      || !this.frameIsCurrent(saved.frame)) throw error('run_after_renderer_changed');
    return row;
  }
  commit(event, { ticket, result, writes, rejected = false, retainAssets = false } = {}) {
    this.authorize(event, ticket);
    const receipt = this.journal.finish(ticket, { result, writes, rejected,
      error: rejected ? result?.error || 'run_after_rejected' : null, retainAssets });
    try { this.afterCommit(writes); } catch (failure) { console.warn('[RunAfterAPI] publication failed: ' + failure.message); }
    return receipt;
  }
  validateScope(event, ticket) {
    const row = this.authorize(event, ticket), saved = JSON.parse(row.request_json).scope;
    if (!this.scopeIsCurrent(row.target, saved)) throw error('run_after_scope_changed');
    this.journal.admitExecution(ticket);
    return { ok: true };
  }
  stage(event, { ticket, result, assetIds = [] } = {}) {
    this.authorize(event, ticket); this.journal.holdAssets(ticket, assetIds);
    return this.journal.stage(ticket, result);
  }
  receipt(operationId) {
    if (!validOperationId(operationId)) throw error('run_after_operation_id_invalid', 400);
    const result = this.journal.read(operationId);
    if (!result) throw error('run_after_operation_missing', 404);
    return result;
  }
}
module.exports = { RunAfterApplicationAPI };
