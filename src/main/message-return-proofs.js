'use strict';

const fs = require('node:fs');
const { sameLoopTurn } = require('../shared/loop-dependencies.cjs');
const { MessageReturnVerifier } = require('./message-return-verifier');
const TABLE = 'tab_message_return_facts';
const statKey = stat => stat && [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const clone = value => JSON.parse(JSON.stringify(value));
const physicalBasis = basis => JSON.stringify([basis?.provider, basis?.sessionId, basis?.filePath, basis?.revision, basis?.inode]);
const referenceKey = receipt => JSON.stringify([receipt.operationKey, receipt.attemptId, receipt.handoffId,
  receipt.provider, receipt.sessionId, receipt.userUuid, receipt.sourceIdentity,
  receipt.userUuidAliases || [], receipt.sourceIdentityAliases || []]);
const mergeRows = (...groups) => [...new Map(groups.flat().map(row => [row.offset, row])).values()].sort((a, b) => a.offset - b.offset);
const BOUNDARIES = new Set(['task_started', 'task_complete', 'turn_aborted', 'thread_rolled_back']);
const boundary = row => row.thin.type === 'event_msg' && BOUNDARIES.has(row.thin.payload.type);
const MAX_PROOF_BYTES = 2 * 1024 * 1024;

// Bounded metadata from the existing admitted append/hook path, not a History
// reader. Canonical delivery is still checked independently by the FIFO owner.
class MessageReturnProofs {
  constructor({ db, findExecutionContext, readRevision, readReferences = () => null, changed = () => {}, maxRecords = 128,
    verifierOptions }) {
    Object.assign(this, { db, findExecutionContext, readRevision, readReferences, changed, maxRecords });
    this.boundaries = new Map();
    this.verifier = new MessageReturnVerifier(verifierOptions);
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(tabId TEXT PRIMARY KEY,value TEXT NOT NULL)`);
  }
  get(tabId) {
    const row = this.db.prepare(`SELECT value FROM ${TABLE} WHERE tabId=?`).get(tabId);
    return row ? JSON.parse(row.value) : null;
  }
  save(tabId, value) {
    this.db.prepare(`INSERT INTO ${TABLE}(tabId,value) VALUES(?,?)
      ON CONFLICT(tabId) DO UPDATE SET value=excluded.value`).run(tabId, JSON.stringify(value));
    this.changed(tabId);
  }
  selectCodexRows(rows, receipt) {
    const primary = rows.filter(row => row.identity && (
      receipt.sourceIdentity && row.identity.sourceIdentity === receipt.sourceIdentity
      || receipt.userUuid && row.identity.userUuid === receipt.userUuid));
    if (primary.length !== 1) return { reason: 'return_user_unproven' };
    const aliases = rows.filter(row => row.identity && ((receipt.userUuidAliases || []).includes(row.identity.userUuid)
      || (receipt.sourceIdentityAliases || []).includes(row.identity.sourceIdentity)));
    let context;
    for (const row of [...primary, ...aliases]) {
      const actual = this.findExecutionContext(rows.map(row => row.thin), receipt.sessionId,
        'codex-user-' + receipt.sessionId + '-' + row.offset);
      if (!actual || context && !sameLoopTurn(context, actual)) return { reason: 'return_carrier_turn_unproven', selected: rows };
      context = actual;
    }
    const starts = rows.filter(row => row.thin.payload.type === 'task_started' && row.thin.payload.turn_id === context.turnId);
    const ends = rows.filter(row => row.thin.payload.type === 'task_complete' && row.thin.payload.turn_id === context.turnId);
    const firstUser = Math.min(...primary.map(row => row.offset), ...aliases.map(row => row.offset));
    let begin = starts.length === 1 ? Math.min(firstUser, starts[0].offset) : firstUser;
    if (starts.length === 1 && firstUser < starts[0].offset) {
      const predecessor = rows.filter(row => boundary(row) && row.offset < firstUser
        && ['task_complete', 'turn_aborted'].includes(row.thin.payload.type)).at(-1);
      // Never turn a missing canonical boundary into a scan from byte zero.
      if (!predecessor) return { reason: 'return_structural_boundary_unproven' };
      begin = predecessor.offset;
    }
    const end = ends.length === 1 ? ends[0].offset : rows.at(-1)?.offset;
    const witnesses = rows.filter(row => boundary(row) && row.offset >= begin && row.offset <= end);
    const selected = mergeRows(primary, aliases, witnesses);
    const firstClose = starts.length === 1 ? witnesses.find(row => row.offset > starts[0].offset) : null;
    const natural = starts.length === 1 && ends.length === 1 && ends[0].natural && firstClose === ends[0]
      && [...primary, ...aliases].every(row => row.offset < ends[0].offset);
    return { selected, context, begin, ...(natural ? { outcomeTs: ends[0].outcomeTs,
      end: ends[0].span.start + ends[0].span.length } : { reason: 'return_natural_unproven' }) };
  }
  retain(tabId, window) {
    const references = this.readReferences(tabId);
    if (!Array.isArray(references)) return;
    const retained = [];
    for (const receipt of references) {
      if (receipt.state !== 'confirmed' || receipt.provider !== 'codex' || receipt.sessionId !== window.basis.sessionId
        || !receipt.operationKey || !receipt.attemptId || !receipt.handoffId) continue;
      const key = referenceKey(receipt), old = window.retained?.find(item => item.key === key);
      // Completed evidence belongs to this exact active return, not to the
      // moving per-tab window. It remains independently point-verifiable.
      if (old?.complete) { retained.push(old); continue; }
      const result = this.selectCodexRows(mergeRows(old?.rows || [], window.records), receipt);
      if (!result.selected || result.selected.reduce((sum, row) => sum + (row.span?.length || Infinity), 0) > 2 * 1024 * 1024) continue;
      retained.push({ key, rows: result.selected, complete: !result.reason });
    }
    window.retained = retained;
  }
  observeCodex({ tabId, sessionId, record, recordSpan, outcome, source, currentWatcher, currentTerminal,
    lifecycleGeneration, watcherGeneration, runSeq, watcherRunSeq, boundaryOffset, liveAfterOffset,
    suppressed, deferred, sourceObservation, manualConflict, observing = true }) {
    if (!currentWatcher || !currentTerminal || !lifecycleGeneration || lifecycleGeneration !== watcherGeneration
      || runSeq !== watcherRunSeq || suppressed || deferred || sourceObservation || manualConflict
      || !sessionId || !source?.filePath || !source.stat || !source.revision
      || !Number.isSafeInteger(record?.__eventSequence) || record.__eventSequence < 1
      || !Number.isSafeInteger(boundaryOffset) || !Number.isSafeInteger(liveAfterOffset)
      || !Number.isSafeInteger(record.__byteOffset) || record.__byteOffset < Math.max(boundaryOffset, liveAfterOffset)
      || recordSpan?.start !== record.__byteOffset || !Number.isSafeInteger(recordSpan.length)
      || recordSpan.length < 1 || recordSpan.length > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(recordSpan.digest)) return;
    const type = record.type === 'event_msg' ? record.payload?.type : null;
    const user = type === 'user_message' || record.type === 'response_item'
      && record.payload?.type === 'message' && record.payload?.role === 'user';
    if (!user && !['task_started', 'task_complete', 'turn_aborted', 'thread_rolled_back'].includes(type)) return;
    const basis = { provider: 'codex', sessionId, filePath: source.filePath, revision: source.revision,
      inode: source.stat.dev + ':' + source.stat.ino, lifecycleGeneration };
    const basisKey = JSON.stringify(basis), previousBoundary = this.boundaries.get(tabId);
    const offset = record.__byteOffset;
    const p = record.payload || {};
    const identity = user ? { userUuid: Number.isSafeInteger(record.__line) ? 'codex-user-' + sessionId + '-' + record.__line : null,
      sourceIdentity: 'codex-user-source-' + sessionId + '-' + offset } : null;
    // The private resolver needs only a unique physical carrier coordinate.
    // This surrogate never becomes a receipt UUID or a public source identity.
    const thin = { type: user ? 'event_msg' : record.type, timestamp: record.timestamp,
      __line: offset, __byteOffset: offset, __physicalSessionId: sessionId,
      payload: user ? { type: 'user_message', message: '' }
        : { type, turn_id: p.turn_id, started_at: p.started_at } };
    const natural = outcome?.busy === false && outcome.reason === 'task_complete'
      && outcome.hasFinalResult === true && outcome.completionKind !== 'compact';
    // This proves one input's processing turn, not whole-work completion.
    // The existing Main/runner Goal guard independently holds ordinary Loop.
    const item = { offset, thin, identity, span: recordSpan,
      ...(natural ? { natural: true, outcomeTs: Date.parse(record.timestamp) } : {}) };
    if (['task_started', 'task_complete', 'turn_aborted', 'thread_rolled_back'].includes(type)) {
      this.boundaries.delete(tabId); this.boundaries.set(tabId, { basisKey, item });
      while (this.boundaries.size > 64) this.boundaries.delete(this.boundaries.keys().next().value);
    }
    if (!observing) return;
    let window = this.get(tabId);
    if (!window || JSON.stringify(window.basis) !== basisKey || type === 'thread_rolled_back') {
      window = { basis, retained: type !== 'thread_rolled_back' && physicalBasis(window?.basis) === physicalBasis(basis)
        ? window.retained || [] : [], records: previousBoundary?.basisKey === basisKey && previousBoundary.item.offset < offset
        ? [previousBoundary.item] : [] };
    }
    if (previousBoundary?.basisKey === basisKey && previousBoundary.item.offset < offset
      && previousBoundary.item.offset > (window.records.at(-1)?.offset ?? -1)) {
      window.records = previousBoundary.item.thin.payload.type === 'thread_rolled_back' ? [] : window.records;
      window.records.push(previousBoundary.item);
    }
    if (window.records.some(row => row.offset >= offset)) return;
    window.records.push(item);
    this.retain(tabId, window);
    window.records = window.records.slice(-this.maxRecords);
    window.statKey = statKey(source.stat);
    this.save(tabId, window);
  }
  observeClaude({ tabId, sessionId, transcriptPath, event, admitted, matched, context, audit, promptId,
    outcomeTs, hasFinalResult }) {
    if (!admitted || !sessionId || !promptId || !context?.turnId || context.sessionId !== sessionId || context.provider !== 'claude') return;
    let value = this.get(tabId);
    if (event === 'UserPromptSubmit') {
      if (!audit?.handoffId || !audit.sendOperationKey || !audit.sendAttemptId || !transcriptPath) return;
      // Unique staged audit and the admitted native hook bind this operation,
      // even if its canonical transcript audit is published after Stop.
      value = { basis: { provider: 'claude', sessionId, filePath: transcriptPath },
        handoffId: audit.handoffId, operationKey: audit.sendOperationKey, attemptId: audit.sendAttemptId,
        promptId, context: clone(context), natural: false };
      this.save(tabId, value); return;
    }
    if (event !== 'Stop' || !matched || !hasFinalResult || !value || value.promptId !== promptId
      || !sameLoopTurn(value.context, context) || value.context.generation !== context.generation
      || String(value.context.processId) !== String(context.processId) || !Number.isFinite(outcomeTs)) return;
    // This path is rare (one completed message return); no prompt/body read.
    return fs.promises.stat(value.basis.filePath).then(stat => {
      const current = this.get(tabId);
      if (JSON.stringify(current) !== JSON.stringify(value)) return;
      this.save(tabId, { ...value, natural: true, outcomeTs, statKey: statKey(stat) });
    });
  }
  async read(source, receipt, { signal } = {}) {
    source = { ...source }; receipt = clone(receipt);
    const unavailable = reason => ({ known: false, reason });
    const value = this.get(source.tabId), basis = value?.basis;
    if (!basis || basis.provider !== source.provider || basis.sessionId !== receipt.sessionId
      || receipt.provider !== source.provider || receipt.sessionId !== source.sessionId) return unavailable('return_facts_missing');
    const referenceCurrent = () => {
      const references = this.readReferences(source.tabId);
      return !Array.isArray(references) || references.some(item => referenceKey(item) === referenceKey(receipt));
    };
    if (!referenceCurrent()) return unavailable('return_reference_unproven');
    const retained = basis.provider === 'codex' && value.retained?.find(item => item.key === referenceKey(receipt));
    const rows = retained?.rows || value.records;
    const metadataCurrent = () => {
      const current = this.get(source.tabId);
      return referenceCurrent() && physicalBasis(current?.basis) === physicalBasis(basis) && (retained
        ? JSON.stringify(current.retained?.find(item => item.key === retained.key)) === JSON.stringify(retained)
        : JSON.stringify(current.records) === JSON.stringify(value.records));
    };
    const validSource = async () => {
      if (basis.provider === 'codex' && basis.revision !== this.readRevision(basis.sessionId)) return false;
      const stat = await fs.promises.stat(basis.filePath);
      return basis.provider === 'codex'
        ? stat.dev + ':' + stat.ino === basis.inode
          && rows.every(row => stat.size >= row.span.start + row.span.length) && metadataCurrent()
        : statKey(stat) === value.statKey && JSON.stringify(this.get(source.tabId)) === JSON.stringify(value);
    };
    try {
      // Codex's full source checks (including stat) belong to the cancellable
      // verifier operation; do not put an untimed file lookup in front of it.
      if (basis.provider !== 'codex' && !await validSource()) return unavailable('return_source_changed');
      let context, outcomeTs;
      if (source.provider === 'claude') {
        if (!value.natural || ['operationKey', 'attemptId', 'handoffId'].some(key => value[key] !== receipt[key])) return unavailable('return_hook_unproven');
        context = value.context; outcomeTs = value.outcomeTs;
      } else {
        const result = this.selectCodexRows(rows, receipt);
        if (result.reason) return unavailable(result.reason);
        const { selected } = result;
        context = result.context;
        if (selected.reduce((sum, row) => sum + (row.span?.length || Infinity), 0) > MAX_PROOF_BYTES) return unavailable('return_proof_byte_limit');
        const failure = await this.verifier.verify({ basis, selection: result, signal,
          reference: referenceKey(receipt), trace: { tabId: source.tabId, operationKey: receipt.operationKey,
            handoffId: receipt.handoffId, attemptId: receipt.attemptId },
          minimumSize: Math.max(...rows.map(row => row.span.start + row.span.length)),
          isCurrent: () => metadataCurrent() && basis.revision === this.readRevision(basis.sessionId) });
        if (failure) return unavailable(failure);
        outcomeTs = result.outcomeTs;
      }
      if (!Number.isFinite(outcomeTs)) return unavailable('return_source_changed');
      if (source.provider === 'codex') {
        // No new I/O after the physical end bookend. Logical/ref fences are
        // synchronous and cannot open a second unchecked async commit window.
        if (!metadataCurrent() || basis.revision !== this.readRevision(basis.sessionId)) return unavailable('return_source_changed');
      } else if (!await validSource()) return unavailable('return_source_changed');
      return { known: true, natural: true, operationKey: receipt.operationKey, attemptId: receipt.attemptId,
        handoffId: receipt.handoffId, provider: receipt.provider, sessionId: receipt.sessionId,
        userUuid: receipt.userUuid || null, sourceIdentity: receipt.sourceIdentity || null,
        executionContext: context, outcomeTs };
    } catch { return unavailable('return_source_unavailable'); }
  }
}
module.exports = { MessageReturnProofs };
