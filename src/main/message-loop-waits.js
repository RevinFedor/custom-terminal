'use strict';

const { createHash } = require('node:crypto');
const { exactMessageDelivery, messageWaitBlocks } = require('../shared/message-loop-waits.cjs');
const TABLE = 'tab_message_loop_waits';
const DEFAULT_WAIT_MS = 30 * 60_000;
const CONTRACT = 'reply-delivery-v1';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), { code, submitted: false });
const terminal = entry => ['cancelled', 'source-replaced'].includes(entry.state);
const safeCode = (value, fallback) => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value) ? value : fallback;
const receiptKey = receipt => JSON.stringify([receipt?.state, receipt?.operationKey, receipt?.attemptId, receipt?.handoffId,
  receipt?.messageId, receipt?.tabId, receipt?.promptHash, receipt?.requestHash,
  receipt?.provider, receipt?.sessionId, receipt?.userUuid || null, receipt?.sourceIdentity || null,
  receipt?.userUuidAliases || [], receipt?.sourceIdentityAliases || []]);
const episodeKey = entry => digest([entry.id, entry.source, entry.returnOrdinal || 0,
  entry.notice && [entry.notice.id, entry.notice.operationKey, entry.notice.handoffId, entry.notice.promptHash, entry.notice.destination]]);

function noticePrompt(question, reason) {
  const summary = reason === 'reply_processing_timeout'
    ? question.reply?.deliveryState === 'sent'
      ? 'A reply was saved and its delivery was confirmed. Noted could not confirm that the source agent finished processing it before the wait deadline. This does not mean the target failed to answer.'
      : 'A reply was saved, but its delivery or processing was not confirmed before the wait deadline.'
    : reason === 'reply_timeout' ? 'No reply was saved before the wait deadline. The original question remains open for a late reply.'
      : reason === 'reply_delivery_timeout' ? 'A reply was saved, but its delivery back to your tab was not confirmed before the wait deadline.'
        : reason === 'reply_delivery_failed' ? 'A reply was saved, but Noted recorded a failure returning it to your tab.'
        : reason === 'question_delivery_failed' ? 'Noted recorded a failure delivering your question.'
          : 'Noted could not confirm the outcome of your outgoing question.';
  return '[Tab message: waiting outcome]'
    + '\nOrigin: Noted Terminal (application, not another tab).'
    + '\nStatus: ' + summary
    + '\nQuestion ID: ' + question.messageId
    + '\nTarget: ' + String(question.targetTabName || question.targetTabId).replace(/\s+/g, ' ').slice(0, 180)
    + ' (' + question.targetTabId + ')'
    + '\nOutcome: ' + reason
    + '\nRecorded delivery code: ' + (question.reply?.code || question.code || 'none')
    + '\nThis is an application-owned outcome of your outgoing question, not a reply from its target.'
    + '\nDelivery and a reply are separate. A timeout does not prove no Send or cancel the question.'
    + '\nDo not resend it or change messageId/requestId. A late reply still belongs to this question.'
    + '\nUse get_message({messageId:' + JSON.stringify(question.messageId)
    + '}) only if the exact saved question/reply is needed. Continue your original work after handling this outcome.';
}

// The question journal owns this dependency. No provider state, fake run or
// renderer spinner is created, and all return input uses the ordinary FIFO.
class MessageLoopWaits {
  constructor({ db, messages, readSource, readDelivery, sendNotice,
    cancelNotice = () => {}, changed = () => {}, log = () => {}, now = Date.now,
    waitMs = DEFAULT_WAIT_MS, setDeadline = setTimeout, clearDeadline = clearTimeout }) {
    Object.assign(this, { db, messages, readSource, readDelivery, sendNotice,
      cancelNotice, changed, log, now, waitMs, setDeadline, clearDeadline });
    this.entries = new Map(); this.entryRevisions = new Map(); this.lanes = new Map(); this.trailing = new Set();
    this.revisionValue = 0; this.stopped = false; this.poisoned = false;
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (questionId TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)`);
    for (const row of db.prepare(`SELECT questionId,revision,value FROM ${TABLE} ORDER BY revision`).all()) {
      const entry = JSON.parse(row.value);
      if (entry.version !== 1 || entry.id !== row.questionId || entry.question?.messageId !== entry.id
        || !entry.source?.tabId || !entry.source?.projectId || !['claude', 'codex'].includes(entry.source.provider)
        || !['waiting', 'returning', 'settled', 'cancelled', 'source-replaced'].includes(entry.state)
        || !Number.isSafeInteger(row.revision) || row.revision < 1) throw fail('message_wait_journal_invalid');
      this.entries.set(entry.id, entry); this.entryRevisions.set(entry.id, row.revision);
      this.revisionValue = Math.max(this.revisionValue, row.revision);
    }
  }
  assertReady() {
    if (this.stopped || this.poisoned) throw fail(this.stopped ? 'message_wait_stopped' : 'message_wait_persistence_unknown');
  }
  save(entry, patch) {
    this.assertReady();
    const current = this.entries.get(entry.id);
    if (current && current !== entry) return null;
    const next = copy({ ...entry, ...patch }), revision = this.revisionValue + 1;
    try {
      const result = this.db.prepare(`INSERT INTO ${TABLE}(questionId,revision,value) VALUES(?,?,?)
        ON CONFLICT(questionId) DO UPDATE SET revision=excluded.revision,value=excluded.value WHERE ${TABLE}.revision=?`)
        .run(next.id, revision, JSON.stringify(next), this.entryRevisions.get(entry.id) || 0);
      if (result.changes !== 1) throw fail('message_wait_persistence_conflict');
    } catch (error) { this.poisoned = true; throw error; }
    this.entries.set(next.id, next); this.entryRevisions.set(next.id, revision); this.revisionValue = revision;
    this.changed(this.project(next), revision); this.scheduleDeadline(); return next;
  }
  isCurrent(entry) {
    this.observe({ kind: 'question', messageId: entry.id });
    return this.entries.get(entry.id) === entry && !terminal(entry);
  }
  project(entry) {
    const { question, notice, pastNotices, ...metadata } = entry;
    return copy({ ...metadata, targetTabId: question.targetTabId, targetTabName: question.targetTabName,
      questionDeliveryState: question.deliveryState, replyMessageId: question.reply?.messageId || null,
      replyDeliveryState: question.reply?.deliveryState || null,
      ...(pastNotices ? { pastNoticeIds: pastNotices.map(value => value.id) } : {}),
      ...(notice ? { notice: { id: notice.id, handoffId: notice.handoffId, operationKey: notice.operationKey,
        state: notice.state, code: notice.code || null } } : {}) });
  }
  snapshot() {
    this.assertReady();
    return { version: 1, known: true, revision: this.revisionValue,
      entries: [...this.entries.values()].map(entry => this.project(entry)) };
  }
  entrySnapshot(id) { this.assertReady(); const entry = this.entries.get(id); return entry ? this.project(entry) : null; }
  deliveryReferences(id) {
    const row = this.db.prepare(`SELECT value FROM ${TABLE} WHERE questionId=?`).get(id);
    const entry = row ? JSON.parse(row.value) : null;
    return entry?.notice ? [entry.notice] : [];
  }
  returnReferences(tabId) {
    this.assertReady();
    return []; // No consuming-turn proof is required for addressed transport.
  }
  deliveryPending(operationKey) {
    return [...this.entries.values()].some(entry => !terminal(entry) && entry.state !== 'settled'
      && entry.question.reply?.operationKey === operationKey);
  }
  observe(message) {
    this.assertReady();
    const id = message.kind === 'reply' ? message.replyTo : message.messageId;
    const question = this.messages.questionWaitReference(id);
    if (!question) return;
    const old = this.entries.get(id);
    if (!old) {
      // Existing answered history is not a backlog of fresh notifications.
      if (question.cancelledAt || question.reply?.deliveryState === 'sent' && !question.waitRequiredAt) return;
      this.save({ version: 1, contract: CONTRACT, id, source: question.source, createdAt: this.now(),
        question, state: question.reply ? 'returning' : 'waiting',
        deadlineAt: (Number(question.waitRequiredAt) > 0 ? Number(question.waitRequiredAt) : this.now()) + this.waitMs }, {});
    } else if (digest(old.question) !== digest(question)) {
      const newReply = question.reply && old.question.reply?.messageId !== question.reply.messageId;
      this.save(old, { question,
        ...(!old.source.sessionId && question.source.sessionId ? { source: question.source } : {}),
        ...(newReply && !terminal(old) && !question.sourceDismissedAt ? { state: 'returning', deadlineAt: this.now() + this.waitMs,
          settlement: null, disposition: 'reply-return',
          ...(old.notice && !old.notice.retiredAt ? { notice: { ...old.notice, retiredAt: this.now(),
            retirementReason: 'reply-saved' } } : {}) } : {}) });
    }
    let entry = this.entries.get(id);
    if (question.sourceDismissedAt && !terminal(entry) && !entry.waitReleasedAt) {
      entry = this.save(entry, { state: 'settled', disposition: 'local-dismissed', deadlineAt: null,
        waitReleasedAt: question.sourceDismissedAt, pendingReturn: null,
        ...(entry.notice && !entry.notice.retiredAt ? { notice: { ...entry.notice, retiredAt: this.now(), retirementReason: 'local-dismissed' } } : {}) });
    }
    if (question.cancelledAt && entry.state !== 'cancelled') {
      // Synchronous revocation precedes any await or future FIFO preparation.
      this.save(entry, { state: 'cancelled', disposition: 'cancelled', deadlineAt: null });
      if (entry.notice) this.cancelNotice(entry.notice, 'question-cancelled');
    }
    return id;
  }
  async restore() {
    for (const question of this.messages.questionWaitReferences()) this.observe(question);
    return this.reconcile();
  }
  blocks(tabId, cause = null) {
    this.assertReady();
    return [...this.entries.values()].some(entry => messageWaitBlocks(entry, tabId, cause));
  }
  admission(tabId, cause) { return !this.blocks(tabId, cause); }
  revision() { this.assertReady(); return this.revisionValue; }
  observing(tabId) {
    this.assertReady();
    return false;
  }
  async source(entry) {
    // The private restored-FIFO resolver holds an immutable assertNotice copy.
    // Fence its source/episode across lookup; mutations separately require the
    // exact current object/revision, so harmless receipt metadata is not a rebind.
    const captured = this.entries.get(entry.id);
    if (!captured || terminal(captured) || captured.notice?.retiredAt || episodeKey(captured) !== episodeKey(entry)) return null;
    entry = captured;
    const expectedEpisode = episodeKey(entry);
    const live = await this.readSource(entry.question);
    this.observe({ kind: 'question', messageId: entry.id });
    const current = this.entries.get(entry.id);
    if (!current || terminal(current) || current.notice?.retiredAt || episodeKey(current) !== expectedEpisode) return null;
    if (live?.known !== true) return null;
    const expected = entry.source;
    if (live.tabId !== expected.tabId || live.projectId !== expected.projectId || live.provider !== expected.provider
      || expected.sessionId && live.sessionId !== expected.sessionId && live.restartBinding?.isCurrent?.() !== true) {
      this.save(current, { state: 'source-replaced', disposition: 'source-replaced', deadlineAt: null });
      if (current.notice) this.cancelNotice(current.notice, 'source-replaced');
      return null;
    }
    return live.sessionId ? live : null;
  }
  retireNotice(entry, reason) {
    if (!entry.notice || entry.notice.retiredAt) return entry;
    // Durable revocation precedes FIFO cleanup. A failed cleanup cannot grant
    // a restored executor permission to send the old processing notification.
    return this.save(entry, { notice: { ...entry.notice, retiredAt: this.now(), retirementReason: reason } });
  }
  async cleanupNotice(entry) {
    if (!entry?.notice?.retiredAt || entry.notice.retirementApplied) return;
    await this.cancelNotice(entry.notice, entry.notice.retirementReason);
    if (this.isCurrent(entry)) this.save(entry, { notice: { ...entry.notice, retirementApplied: true } });
  }
  async settle(id) {
    const entry = this.entries.get(id), reply = entry?.question.reply;
    if (!entry || terminal(entry) || !reply || entry.settlement?.kind === 'reply-delivered') return false;
    const receipt = copy(await this.readDelivery(reply));
    if (!this.isCurrent(entry)) return false;
    if (!exactMessageDelivery(receipt, reply, entry.source)) return false;
    const latest = await this.readDelivery(reply);
    if (!this.isCurrent(entry) || receiptKey(latest) !== receiptKey(receipt)) return false;
    const retired = this.retireNotice(entry, 'reply-delivered');
    if (!retired || !this.isCurrent(retired)) return false;
    // Old natural proofs remain historical evidence, never invented or reused
    // as authority for this delivery-only settlement.
    const saved = this.save(retired, { contract: CONTRACT, state: 'settled', disposition: 'reply',
      deadlineAt: null, pendingReturn: null,
      settlement: { kind: 'reply-delivered', messageId: reply.messageId, at: this.now(), receipt } });
    if (saved) await this.cleanupNotice(saved);
    return !!saved;
  }
  makeNotice(entry, reason, nativeReceipt = null) {
    const id = 'tab-message-outcome:' + entry.id + (entry.question.reply ? ':reply' : '')
      + (entry.returnOrdinal ? ':return:' + entry.returnOrdinal : '');
    const prompt = noticePrompt(entry.question, reason);
    return { id, operationKey: id, handoffId: id, reason, prompt,
      promptHash: digest(prompt), state: 'pending', attempted: false, source: copy(entry.source), createdAt: this.now(),
      ...(entry.question.reply ? { replyAtCreation: { ...copy(entry.question.reply),
        ...(nativeReceipt?.state === 'confirmed' && nativeReceipt.operationKey === entry.question.reply.operationKey
          && nativeReceipt.handoffId === entry.question.reply.handoffId ? { deliveryState: 'sent', nativeReceipt: copy(nativeReceipt) } : {}) } } : {}) };
  }
  assertNotice(request) {
    this.assertReady();
    const entry = this.entries.get(request.questionId), notice = entry?.notice;
    const fresh = entry && this.messages.questionWaitReference(entry.id);
    if (!notice || notice.retiredAt || terminal(entry) || fresh?.cancelledAt || !fresh
      || notice.id !== request.noticeId || notice.operationKey !== request.operationKey
      || notice.handoffId !== request.handoffId || digest(request.logicalPrompt) !== notice.promptHash) throw fail('message_outcome_revoked');
    return copy({ entry, notice });
  }
  async reconcileEntry(id) {
    this.observe({ kind: 'question', messageId: id });
    let entry = this.entries.get(id);
    if (!entry || terminal(entry)) return;
    if (entry.waitReleasedAt) { await this.cleanupNotice(entry); return; }
    if (entry.settlement?.kind === 'reply-delivered') { await this.cleanupNotice(entry); return; }
    if (await this.settle(id)) return;
    entry = this.entries.get(id);
    if (!entry || terminal(entry)) return;
    await this.cleanupNotice(entry);
    if (!this.isCurrent(entry)) return;
    if (entry.notice?.reason === 'reply_processing_timeout') {
      entry = this.retireNotice(entry, 'processing-contract-retired');
      entry = this.finishOutcome(entry, 'reply_delivery_timeout');
      await this.cleanupNotice(entry); return;
    }
    if (entry.state !== 'settled') entry = await this.recordOutcome(entry);
    if (!entry || !this.isCurrent(entry)) return;
    if (!entry.notice) return;
    if (entry.notice.retiredAt) {
      if (!Number.isFinite(entry.deadlineAt)) this.finishOutcome(entry);
      return;
    }
    const delivery = await this.readDelivery(entry.notice);
    if (!this.isCurrent(entry)) return;
    // The status is a one-way outbox operation, not another mandatory answer.
    // Keep its exact FIFO/UNKNOWN evidence even after the message wait ends.
    if (delivery?.state === 'confirmed') {
      if (entry.notice.state !== 'sent') entry = this.save(entry, { notice: { ...entry.notice, state: 'sent' } });
      this.finishOutcome(entry); return;
    }
    const destinationSource = await this.source(entry);
    if (!this.isCurrent(entry)) return;
    if (!destinationSource) {
      this.finishOutcome(entry); return;
    }
    const retry = delivery?.provenNoInput === true && delivery.attemptId
      && destinationSource.recoveryReady === true && destinationSource.readinessKey
      && destinationSource.readinessKey !== entry.notice.lastAttemptReadiness;
    if (delivery && delivery.state !== 'absent' && !retry) {
      const state = delivery.state === 'not-submitted' ? 'failed' : delivery.state;
      if (state !== entry.notice.state || (delivery.code || null) !== (entry.notice.code || null)) {
        entry = this.save(entry, { notice: { ...entry.notice, state, code: delivery.code || null } });
      }
      this.finishOutcome(entry); return;
    }
    if (entry.notice.attempted && delivery?.provenNoInput !== true) { this.finishOutcome(entry); return; }
    const destination = entry.notice.destination || { tabId: destinationSource.tabId, projectId: destinationSource.projectId,
      provider: destinationSource.provider, sessionId: destinationSource.sessionId,
      expectedTarget: destinationSource.sendTarget || { toolType: destinationSource.provider, sessionId: destinationSource.sessionId } };
    const notice = { ...entry.notice, destination, attempted: true, lastAttemptReadiness: destinationSource.readinessKey || null,
      ...(retry ? { retryNoInputAttemptId: delivery.attemptId } : {}) };
    const saved = this.save(entry, { notice }); // durable intent before calling the FIFO
    if (!saved || !this.isCurrent(saved)) return;
    const ref = { questionId: id, noticeId: notice.id, operationKey: notice.operationKey,
      handoffId: notice.handoffId, logicalPrompt: notice.prompt };
    this.assertNotice(ref);
    try { await this.sendNotice(copy(notice), destinationSource, ref); }
    catch (error) {
      if (this.isCurrent(saved)) this.save(saved, { notice: { ...saved.notice,
        state: 'unconfirmed', code: safeCode(error.code, 'message_outcome_delivery_unknown') } });
    }
    const current = this.entries.get(id);
    if (current?.notice?.id === notice.id && this.isCurrent(current)) this.finishOutcome(current);
  }
  finishOutcome(entry, reason = entry?.disposition) {
    if (!entry || !this.isCurrent(entry) || entry.settlement?.kind === 'reply-delivered') return entry;
    if (entry.contract === CONTRACT && entry.state === 'settled' && entry.disposition === reason) return entry;
    return this.save(entry, { contract: CONTRACT, state: 'settled', deadlineAt: null, pendingReturn: null,
      disposition: reason, settlement: { kind: 'outcome', reason, at: this.now(),
        replyMessageId: entry.question.reply?.messageId || null } });
  }
  async recordOutcome(entry) {
    if (!this.isCurrent(entry)) return null;
    const delivery = entry.question.reply || entry.question;
    const expired = () => Number.isFinite(entry.deadlineAt) && entry.deadlineAt <= this.now();
    if (delivery.deliveryState !== 'failed' && !expired()) return entry;
    const receipt = copy(await this.readDelivery(delivery));
    if (!this.isCurrent(entry)) return null;
    // Preparing/reserved is not a failed delivery. The reason and native cut
    // belong to this same owner revision, never a question from before await.
    const failed = delivery.deliveryState === 'failed' && (['not-submitted', 'provider-not-accepted'].includes(receipt?.state)
      || receipt?.state === 'absent' && receipt.provenNoInput === true);
    const reason = failed ? entry.question.reply ? 'reply_delivery_failed' : 'question_delivery_failed'
      : expired() ? entry.question.reply ? 'reply_delivery_timeout' : 'reply_timeout' : null;
    return reason ? this.save(entry, { state: 'returning', disposition: reason, deadlineAt: null,
      notice: entry.notice || this.makeNotice(entry, reason, entry.question.reply ? receipt : null) }) : entry;
  }
  reconcile(tabId = null) {
    this.assertReady();
    const key = '*';
    if (this.lanes.has(key)) { this.trailing.add(key); return this.lanes.get(key); }
    const task = Promise.resolve().then(async () => {
      for (const entry of [...this.entries.values()]) {
        if (this.stopped) return;
        if (!tabId || entry.source.tabId === tabId) await this.reconcileEntry(entry.id);
      }
    }).finally(() => {
      this.lanes.delete(key); this.scheduleDeadline();
      if (!this.stopped && this.trailing.delete(key)) void this.reconcile().catch(error => this.log(error.code || error.message));
    });
    this.lanes.set(key, task); return task;
  }
  scheduleDeadline() {
    if (this.timer) this.clearDeadline(this.timer);
    this.timer = null;
    if (this.stopped || this.poisoned) return;
    const deadlines = [...this.entries.values()].filter(entry => !terminal(entry) && entry.state !== 'settled'
      && Number.isFinite(entry.deadlineAt)).map(entry => entry.deadlineAt);
    if (!deadlines.length) return;
    // One absolute failure deadline, never a readiness poll/completion proof.
    this.timer = this.setDeadline(() => {
      this.timer = null;
      void this.reconcile().catch(error => this.log(error.code || error.message));
    }, Math.max(1, Math.min(2_147_483_647, Math.min(...deadlines) - this.now())));
    this.timer?.unref?.();
  }
  dispose() { this.stopped = true; if (this.timer) this.clearDeadline(this.timer); this.trailing.clear(); }
}
module.exports = { MessageLoopWaits, TABLE, DEFAULT_WAIT_MS, noticePrompt };
