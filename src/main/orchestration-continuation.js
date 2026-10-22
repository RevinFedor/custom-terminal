'use strict';

const crypto = require('node:crypto');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { agentPromptAuditMatchesHash } = require('./agent-prompt-audit-identity');
const { canSubmitContinuationInput, continuationTargetExpectation, continuationTargetScopeMatches } = require('./orchestration-continuation-input');

const CONTINUATION_SOURCE = 'orchestration-continue:';
const OWNER = 'orchestration-continuation';
const terminal = run => ['completed', 'failed', 'cancelled'].includes(run?.status);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function continuationOwnerKey(run) {
  return JSON.stringify([run?.runId, run?.status, run?.outcome, run?.recoveryAttempt || 0,
    run?.sessionId, run?.targetExecutionContext, run?.resultPromptProofUserUuid,
    run?.sourceSendTarget, run?.notificationSuppressed, run?.sourceFollowupStartedAt]);
}

function continuationRunIdFromAudit(detail = {}) {
  const source = String(detail.source || '').replace(/^codex-/, '');
  return source.startsWith(CONTINUATION_SOURCE) ? source.slice(CONTINUATION_SOURCE.length) || null : null;
}

function continuationReceiptProof(run, record) {
  const intent = run?.continuationIntent, audit = record?.auditIdentity, receipt = record?.receipt;
  if (!intent || intent.cancelledAt || record?.state !== 'confirmed'
    || record.operationKey !== intent.operationKey || record.tabId !== run.targetTabId
    || record.handoffId !== intent.handoffId || !record.attemptId || audit?.attemptId !== record.attemptId
    || audit.provider !== run.targetToolType || !audit.sessionId || (!audit.entryUuid && !audit.sourceIdentity)
    || receipt?.historyOnly || receipt?.exactAuditConfirmed !== true || receipt.actualHash !== audit.promptHash
    || !agentPromptAuditMatchesHash(intent.auditHash, { ...receipt, provider: audit.provider }).matches) return null;
  return { executionContext: receipt.auditExecutionContext || null, sessionId: audit.sessionId,
    userUuid: audit.entryUuid, sourceIdentity: audit.sourceIdentity, auditTimestamp: audit.auditTimestamp,
    handoffId: intent.handoffId, operationKey: intent.operationKey, attemptId: record.attemptId };
}

function partyMatches(state, expected) {
  return state?.known === true && state.exists !== false && !!state.sessionId
    && state.toolType === expected?.toolType
    && (state.sessionId === expected?.sessionId || state.acceptedResumeSourceSessionId === expected?.sessionId);
}

function latestMatchesOriginal(latest, original, run) {
  if (latest?.result?.sourceVerified !== true || !latest.subject) return false;
  const context = latest.subject.targetExecutionContext || latest.result.executionContext;
  const expected = run.targetExecutionContext;
  if (context?.turnId && expected?.turnId) {
    return context.provider === expected.provider && context.sessionId === expected.sessionId
      && context.turnId === expected.turnId;
  }
  if (latest.subject.promptUserUuid && [original.userUuid, run.resultPromptProofUserUuid,
    run.targetPromptProofUserUuid].some(uuid => uuid && uuid === latest.subject.promptUserUuid)) return true;
  return Number.isSafeInteger(latest.result.turnIndex) && Number.isSafeInteger(original.startTurnIndex)
    && Number.isSafeInteger(original.endTurnIndex) && latest.result.turnIndex >= original.startTurnIndex
    && latest.result.turnIndex <= original.endTurnIndex;
}

function createOrchestrationContinuationService({ store, receipts, readState, readOriginal, readLatest,
  send, reconcile, deliver, emit = () => {}, now = Date.now, createReplacement, readInfo, reaudit, resumeReplacement,
  readRestartHistoryProof = async () => null, log = console } = {}) {
  const inflight = new Map();
  const reject = async (runId, code, error, reason = code) => {
    const run = await store.get(runId);
    log.warn('[OrchestrationContinuation] refused ' + JSON.stringify({ run: runId,
      operation: run?.continuation?.operationId || null, reason }));
    return { ok: false, code, error,
      canCreateNewRequest: ['continuation_history_changed', 'continuation_request_closed'].includes(code), run };
  };
  const emitResult = result => { emit(result?.changed || (result?.run ? [result.run] : [])); return result; };

  async function prepareRequest(runId, operationId) {
    const run = clone(await store.getInternal(runId)), intent = run?.continuationIntent;
    if (terminal(run) || !intent || intent.operationId !== operationId || intent.cancelledAt
      || receipts.isDeliveryCancelled(intent.operationKey)) throw new Error('continuation_cancelled');
    const source = await readState(run.sourceTabId), target = await readState(run.targetTabId);
    if (!partyMatches(source, intent.sourceExpected) || !partyMatches(target, intent.targetExpected)) throw new Error('continuation_history_changed');
    if (run.targetCwd && target.cwd && require('node:path').resolve(run.targetCwd) !== require('node:path').resolve(target.cwd)) throw new Error('continuation_history_changed');
    if (!canSubmitContinuationInput(target) || !continuationTargetScopeMatches(intent.targetExpected, target)
      || target.backgroundWorkCount > 0 || ['active', 'attention', 'attention_required'].includes(target.goalWork?.status)) throw new Error('continuation_target_not_idle');
    const baseRun = { ...run, targetExecutionContext: intent.baseExecutionContext };
    const original = await readOriginal(baseRun, { target, baseLookup: intent.baseLookup });
    const latest = await readLatest(baseRun, target);
    const restart = await readRestartHistoryProof({ run: baseRun, state: target, original, latest });
    if (original?.found !== true || original.sourceVerified !== true || restart?.required && restart.covered !== true
      || !latestMatchesOriginal(latest, original, baseRun) && restart?.covered !== true) throw new Error('continuation_history_changed');
    const sourceAfter = await readState(run.sourceTabId), targetAfter = await readState(run.targetTabId);
    const current = await store.getInternal(runId);
    if (terminal(current) || current?.continuationIntent?.operationId !== operationId
      || current.continuationIntent.cancelledAt || receipts.isDeliveryCancelled(intent.operationKey)
      || !partyMatches(sourceAfter, intent.sourceExpected) || !partyMatches(targetAfter, intent.targetExpected)
      || sourceAfter.revision !== source.revision || targetAfter.revision !== target.revision
      || !canSubmitContinuationInput(targetAfter) || !continuationTargetScopeMatches(intent.targetExpected, targetAfter)) throw new Error('continuation_state_changed');
  }

  async function confirm(runId) {
    const run = await store.getInternal(runId);
    if (!run?.continuationIntent || terminal(run)) return { confirmed: false };
    const intent = run.continuationIntent;
    if (receipts.isDeliveryCancelled(intent.operationKey)) return { confirmed: false, cancelled: true };
    let record = receipts.get(intent.operationKey);
    if (record?.provider === 'codex' && record.attemptId && ['delivery-unknown', 'audit-pending'].includes(record.state) && typeof reaudit === 'function') {
      await reaudit(record);
      record = receipts.get(intent.operationKey);
    }
    let proof = continuationReceiptProof(run, record);
    if (proof && !proof.executionContext) {
      const read = await readOriginal(run, { continuation: intent, record });
      if (read?.found === true && read.sourceVerified === true && read.executionContext) proof = { ...proof, executionContext: read.executionContext };
    }
    if (!proof?.executionContext) return { confirmed: false };
    const state = await readState(run.targetTabId);
    const info = typeof readInfo === 'function' ? await readInfo(run.targetTabId) : null;
    const current = state?.executionContext, recorded = proof.executionContext;
    if (current?.provider === recorded.provider && current.sessionId === proof.sessionId && current.turnId === recorded.turnId
      && (recorded.processId == null || String(recorded.processId) === String(current.processId))
      && (recorded.generation == null || recorded.generation === current.generation)) {
      proof = { ...proof, executionContext: { ...recorded,
        processId: recorded.processId ?? current.processId, generation: recorded.generation ?? current.generation,
        startedAt: recorded.startedAt ?? current.startedAt } };
      if (info?.sessionId === proof.sessionId) proof.lifecycleGeneration = info.lifecycleGeneration || null;
    }
    const result = emitResult(await store.confirmRequestContinuation(runId, proof));
    if (result.confirmed || result.deliveryConfirmed) {
      receipts.unpinForOwner(intent.operationKey, OWNER);
      if (result.confirmed) await reconcile(runId, 'continuation-exact-proof');
    }
    return result;
  }

  async function perform(runId) {
    let run = clone(await store.getInternal(runId));
    if (!run || run.runKind && run.runKind !== 'agent') return reject(runId, 'continuation_not_agent', 'Это действие относится к поручению AI-вкладке.');
    if (run.status === 'completed' && run.resultComplete === true) {
      await deliver(runId); return { ok: true, resultReady: true, run: await store.get(runId) };
    }
    if (terminal(run) || run.notificationSuppressed) return reject(runId, 'continuation_request_closed', 'Запрос уже закрыт. Создайте новое поручение.');
    if (run.status !== 'waiting_recovery') {
      await reconcile(runId, 'continuation-already-active');
      return { ok: true, alreadyActive: true, run: await store.get(runId) };
    }
    if (run.outcome === 'paused') return reject(runId, 'continuation_paused', 'Сначала возобновите связь с паузы.');
    if (!['bound', 'delivered-paused'].includes(run.continuationIntent?.state)) {
      const confirmed = await confirm(runId);
      if (confirmed.confirmed) return { ok: true, resumed: true, run: await store.get(runId) };
      if (confirmed.deliveryConfirmed) return { ok: true, paused: true, run: await store.get(runId) };
      run = clone(await store.getInternal(runId));
      const intent = run.continuationIntent;
      const record = intent && receipts.get(intent.operationKey);
      if (intent?.cancelledAt || intent && receipts.isDeliveryCancelled(intent.operationKey)) {
        return reject(runId, 'continuation_cancelled', 'Продолжение отменено; прежняя доставка не повторяется.');
      }
      if (intent?.sendStartedAt && (!record || !['reserved', 'preparing', 'not-submitted', 'provider-not-accepted'].includes(record.state))) {
        return reject(runId, 'continuation_delivery_unknown', 'Продолжение уже могло быть отправлено. Ожидается точное подтверждение; повторный continue не отправлен.');
      }
    }
    const sourceExpected = run.sourceSendTarget || { toolType: run.sourceToolType || run.sourceExecutionContext?.provider,
      sessionId: run.sourceExecutionContext?.sessionId || run.sourceSessionId };
    let targetExpected = { toolType: run.targetToolType, sessionId: run.sessionId || run.targetPromptProofSessionId };
    const source = await readState(run.sourceTabId);
    const target = await readState(run.targetTabId);
    if ([source, target].some(state => state?.continuationInput?.reason === 'continuation_runtime_changed')) {
      return reject(runId, 'continuation_runtime_unknown', 'Состояние изменилось во время проверки; повторите действие.',
        'continuation_runtime_changed');
    }
    if (!partyMatches(source, sourceExpected) || !partyMatches(target, targetExpected)) {
      return reject(runId, 'continuation_history_changed', 'Источник или исполнитель теперь относятся к другой либо недоступной истории. Создайте новый запрос явно.');
    }
    if (run.targetCwd && target.cwd && require('node:path').resolve(run.targetCwd) !== require('node:path').resolve(target.cwd)) {
      return reject(runId, 'continuation_history_changed', 'Рабочая директория исполнителя изменилась. Создайте новый запрос явно.');
    }
    const original = await readOriginal(run, { target });
    if (original?.found !== true || original.sourceVerified !== true) return reject(runId, 'continuation_history_changed', 'Исходное поручение не подтверждено в текущей истории. Создайте новый запрос.');
    if (target.backgroundWorkCount > 0 || ['active', 'attention', 'attention_required'].includes(target.goalWork?.status)) {
      return reject(runId, 'continuation_background_work', 'Сохраняется фоновая работа или Goal; новое продолжение не требуется. Проверьте её в самой вкладке.');
    }
    if (original.complete === true) {
      const sourceNow = await readState(run.sourceTabId), targetNow = await readState(run.targetTabId);
      if (!partyMatches(sourceNow, sourceExpected) || !partyMatches(targetNow, targetExpected)
        || sourceNow.revision !== source.revision || targetNow.revision !== target.revision
        || targetNow.backgroundWorkCount > 0 || ['active', 'attention', 'attention_required'].includes(targetNow.goalWork?.status)) {
        return reject(runId, 'continuation_state_changed', 'Состояние изменилось во время проверки результата; повторите проверку.');
      }
      const accepted = emitResult(await store.acceptContinuationReadyResult(runId, continuationOwnerKey(run), original));
      if (!accepted.accepted) return reject(runId, 'continuation_state_changed', 'Запрос изменился во время проверки результата.');
      await reconcile(runId, 'continuation-ready-result');
      await deliver(runId);
      return { ok: true, resultReady: true, run: await store.get(runId) };
    }
    if (!['found', 'absent'].includes(target.processStatus)) return reject(runId, 'continuation_runtime_unknown',
      'Состояние процесса исполнителя пока не подтверждено; повторите проверку.', 'continuation_process_unknown');
    if (target.busy === true) {
      const context = target.executionContext, expected = run.targetExecutionContext;
      if (!context || context.provider !== expected?.provider || context.sessionId !== expected?.sessionId || context.turnId !== expected?.turnId) {
        return reject(runId, 'continuation_target_busy', 'Исполнитель занят другим или ещё не подтверждённым ходом. Новый continue не отправлен.');
      }
      const adopted = emitResult(await store.adoptWorkingContinuation(runId, continuationOwnerKey(run), context));
      if (!adopted.accepted) return reject(runId, 'continuation_state_changed', 'Запрос изменился во время проверки исполнения.');
      await reconcile(runId, 'continuation-already-working');
      return { ok: true, alreadyActive: true, run: await store.get(runId) };
    }
    if (!canSubmitContinuationInput(target)) return reject(runId, 'continuation_runtime_unknown',
      'Состояние исполнителя пока не подтверждено. Повторите проверку, не отправляя continue вручную.',
      target.continuationInput?.reason || 'continuation_input_unproven');
    targetExpected = continuationTargetExpectation(targetExpected, target);
    const latest = await readLatest(run, target);
    const restart = await readRestartHistoryProof({ run, state: target, original, latest });
    if (restart?.required && restart.covered !== true || !latestMatchesOriginal(latest, original, run) && restart?.covered !== true) {
      return reject(runId, 'continuation_history_changed', 'Последний ход не относится к выбранному поручению. Создайте новый запрос, не продолжая чужую задачу.', latest?.code || 'continuation_history_changed');
    }
    const afterSource = await readState(run.sourceTabId), afterTarget = await readState(run.targetTabId);
    if (!partyMatches(afterSource, sourceExpected) || !partyMatches(afterTarget, targetExpected)
      || afterSource.revision !== source.revision || afterTarget.revision !== target.revision
      || !canSubmitContinuationInput(afterTarget) || !continuationTargetScopeMatches(targetExpected, afterTarget)) {
      return reject(runId, 'continuation_state_changed', 'Вкладки изменились во время проверки. Continue не отправлен; повторите действие.');
    }
    const claimed = emitResult(await store.beginRequestContinuation(runId, {
      ownerKey: continuationOwnerKey(run), sourceExpected, targetExpected,
      promptHash: promptFingerprint('continue'), auditHash: promptAuditFingerprint('continue'), now: now(),
      replaceProvenNoSubmit: run.continuationIntent?.state === 'blocked'
        && ['not-submitted', 'provider-not-accepted'].includes(receipts.get(run.continuationIntent.operationKey)?.state),
    }));
    if (!claimed.accepted) return reject(runId, claimed.reason || 'continuation_state_changed',
      claimed.reason === 'continuation-target-claimed' ? 'Для исполнителя уже принято другое поручение. Порядок очереди не изменён.' : 'Состояние запроса изменилось; ввод не выполнен.');
    const intent = claimed.intent;
    // Reuse the persisted target on an idempotent claim. A stopped -> ready
    // transition must not change the fingerprint of an already-reserved send.
    const sendExpectedTarget = intent.targetExpected;
    if (run.continuationIntent && run.continuationIntent.operationKey !== intent.operationKey) {
      receipts.unpinForOwner(run.continuationIntent.operationKey, OWNER);
    }
    receipts.pinForOwner(intent.operationKey, OWNER);
    let senderInvoked = false;
    try {
      await store.markRequestContinuationSending(runId, intent.operationId);
      senderInvoked = true;
      const result = await send({ tabId: run.targetTabId, prompt: 'continue', workContextPrepared: true,
        handoffId: intent.handoffId, sendOperationKey: intent.operationKey, sendSurface: 'desktop-history',
        source: CONTINUATION_SOURCE + runId, ownership: 'project', queue: false,
        provider: sendExpectedTarget.toolType, sessionId: sendExpectedTarget.sessionId, expectedTarget: sendExpectedTarget,
        statusAtSend: afterTarget.processStatus === 'absent' ? 'inactive' : 'active',
        prepareSend: () => prepareRequest(runId, intent.operationId),
      }, run);
      const confirmed = await confirm(runId);
      if (confirmed.confirmed) return { ok: true, resumed: true, run: await store.get(runId) };
      if (confirmed.deliveryConfirmed) return { ok: true, paused: true, run: await store.get(runId) };
      const record = receipts.get(intent.operationKey);
      const noSubmit = ['not-submitted', 'provider-not-accepted'].includes(record?.state);
      emitResult(await store.setRequestContinuationOutcome(runId, intent.operationId,
        noSubmit ? 'blocked' : 'unconfirmed', result?.error || result?.code || null));
      return { ok: !noSubmit, pending: !noSubmit, error: noSubmit ? result?.error || 'Продолжение не отправлено; проверьте готовность вкладки.' : null,
        run: await store.get(runId) };
    } catch (error) {
      if (!senderInvoked) {
        await store.resetRequestContinuationBeforeAdmission(runId, intent.operationId, error.message);
        return reject(runId, 'continuation_checkpoint_failed', 'Продолжение не началось: не удалось сохранить его состояние. Ввод не выполнен.');
      }
      const record = receipts.get(intent.operationKey);
      const noSubmit = ['not-submitted', 'provider-not-accepted'].includes(record?.state);
      emitResult(await store.setRequestContinuationOutcome(runId, intent.operationId, noSubmit ? 'blocked' : 'unconfirmed', error.message));
      return reject(runId, noSubmit ? 'continuation_not_submitted' : 'continuation_delivery_unknown', error.message);
    }
  }

  return {
    continueRequest(runId) {
      if (inflight.has(runId)) return inflight.get(runId);
      const work = perform(runId).finally(() => { if (inflight.get(runId) === work) inflight.delete(runId); });
      inflight.set(runId, work); return work;
    },
    reconcile: confirm,
    prepareRequest,
    async reconcilePins() {
      const pinned = receipts.listOwnerPins(OWNER);
      if (!pinned.length) return;
      const keep = new Set();
      for (const item of await store.listAll()) {
        const run = await store.getInternal(item.runId), intent = run?.continuationIntent;
        if (intent && !terminal(run) && ['prepared', 'sending', 'unconfirmed', 'blocked'].includes(intent.state)) keep.add(intent.operationKey);
      }
      await store.persistStrict();
      for (const key of pinned) if (!keep.has(key)) receipts.unpinForOwner(key, OWNER);
    },
    async newRequest(runId) {
      const run = clone(await store.getInternal(runId));
      if (!run || run.runKind && run.runKind !== 'agent') return reject(runId, 'continuation_not_agent', 'Нужно поручение AI-вкладке.');
      if (run.replacementRunId) return { ok: true, replacementRunId: run.replacementRunId,
        run: typeof resumeReplacement === 'function' ? await resumeReplacement(run.replacementRunId) : await store.get(run.replacementRunId) };
      const source = await readState(run.sourceTabId), target = await readState(run.targetTabId);
      if (!source?.known || source.exists === false || !source.sessionId || !target?.known || target.exists === false || !target.sessionId) {
        return reject(runId, 'continuation_new_address_required', 'Для нового запроса нужны живые источник и исполнитель. Создайте его из нужной вкладки через Terminal MCP.');
      }
      const record = receipts.get('orchestration-target:' + runId);
      const prompt = record?.receipt?.promptText || run.deliveryIntent?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) return reject(runId, 'continuation_original_payload_missing', 'Текст прежнего поручения недоступен. Создайте новое поручение с нужным текстом; старые данные сохранены.');
      const replacementId = 'orchestration-new-' + crypto.createHash('sha256').update(runId).digest('hex').slice(0, 32);
      return createReplacement({ previous: run, runId: replacementId, prompt,
        sourceExpected: { toolType: source.toolType, sessionId: source.sessionId },
        targetExpected: { toolType: target.toolType, sessionId: target.sessionId } });
    },
  };
}

module.exports = { createOrchestrationContinuationService, continuationOwnerKey,
  continuationRunIdFromAudit, continuationReceiptProof, CONTINUATION_SOURCE, OWNER };
