'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const PHASES = new Set(['waiting_capacity', 'opening', 'configuring', 'uploading', 'submitting', 'observing', 'delivering']);
const REASONS = new Set(['no_meaningful_progress', 'phase_stalled', 'capacity_wait', 'final_delivery_unconfirmed',
  'observation_unavailable', 'account_changed', 'delivery_blocked', 'turn_ambiguous', 'executor_update_required',
  'browser_unavailable', 'configuration_unavailable', 'transport_unavailable', 'reader_recovery_unavailable']);
const terminal = run => ['completed', 'failed', 'cancelled'].includes(run.status);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
function validAttention(a, jobId, epoch) {
  return a?.version === 2 && a.jobId === jobId && a.controlEpoch === epoch && bounded(a.episodeId)
    && Number.isSafeInteger(a.updateSeq) && a.updateSeq > 0 && Number.isSafeInteger(a.wakeSeq) && a.wakeSeq > 0
    && ['open', 'cleared'].includes(a.state) && PHASES.has(a.phase) && REASONS.has(a.reason)
    && a.terminal === false && a.wakeModel === true && Array.isArray(a.audience) && a.audience.includes('source_agent');
}
function sourceTarget(run) {
  return clone(run.sourceSendTarget || { toolType: run.sourceToolType || run.sourceExecutionContext?.provider || null,
    sessionId: run.sourceSessionId || run.sourceExecutionContext?.sessionId || null });
}
function rearmOwner(run) {
  return hash(JSON.stringify([run.runId, run.createdAt, run.externalResearchJobId, run.requestFingerprint || null,
    run.externalResearchDeliveryBirth?.id || null, run.sourceTabId, run.sourceProjectId || null, sourceTarget(run)]));
}
const rearmEligible = run => run?.runKind === 'external-research' && !terminal(run) && run.resultComplete !== true
  && run.notifySource !== false && !run.notificationSuppressed && !run.notificationCancelRequestedAt
  && run.externalResearchOperationalPrompts !== false;
function rearmCurrent(run) {
  const r = run?.externalResearchOperationalRearm;
  return r?.version === 1 && r.state === 'active' && rearmEligible(run)
    && !run.externalResearchMaintenanceOperationId && r.sourcePin === rearmOwner(run);
}
function suppressionReason(run, origin) {
  return run.externalResearchMaintenanceOperationId ? 'planned_maintenance'
    : run.externalResearchOperationalPrompts === false ? 'operational_prompts_disabled'
      : rearmCurrent(run) && run.externalResearchOperationalRearm.lanes[origin]?.state === 'awaiting_fresh'
        ? 'post_maintenance_recheck' : null;
}
function synchronizeRearmRevocation(run, now = Date.now()) {
  const r = run.externalResearchOperationalRearm;
  if (!r || r.state !== 'active') return;
  if (!rearmEligible(run) || r.sourcePin !== rearmOwner(run)
    || run.externalResearchMaintenanceOperationId && run.externalResearchMaintenanceOperationId !== r.operationId) {
    r.state = 'revoked'; r.revokedAt = now;
    if (run.externalResearchOperational?.recheck) run.externalResearchOperational.recheck.state = 'cleared';
  }
}
function beginPostMaintenanceRearm(run, operationId, now = Date.now()) {
  if (!rearmEligible(run)) return;
  const old = run.externalResearchOperationalRearm;
  if (old?.operationId === operationId) return;
  run.externalResearchOperationalRearm = { version: 1, operationId, generation: Number(old?.generation || 0) + 1,
    state: 'active', sourcePin: rearmOwner(run), createdAt: now,
    controlEpoch: run.externalResearchOperational?.sc?.controlEpoch || null,
    browserInstanceId: run.externalResearchBrowserInstanceId || run.externalResearchExpectedBrowserInstanceId || null,
    lanes: { sc: { state: 'awaiting_fresh' }, noted: { state: 'awaiting_fresh' } },
    checkSequence: 0, checks: {}, currentCheckId: null, probeFailure: null };
}
function rearmNoticeAllowed(run, notice) {
  if (!notice.rearm) return true;
  const r = run.externalResearchOperationalRearm, n = notice.rearm;
  const lane = notice.origin === 'noted-recheck' ? r?.probeFailure : r?.lanes[notice.origin];
  return rearmCurrent(run) && n.operationId === r.operationId && n.generation === r.generation
    && lane?.noticeId === notice.id && lane.state === 'verified'
    && (notice.origin !== 'sc' || isDeepStrictEqual(run.externalResearchOperational?.sc?.readerPin || null,
      r.checks[n.checkId]?.receipt?.reader || null));
}
function canDeliver(run, notice, { humanOnly = false } = {}) {
  const o = run?.externalResearchOperational;
  const localDelivery = notice.origin === 'noted-delivery';
  const episodeAllowed = localDelivery
    ? o?.delivery?.state === 'open' && o.delivery.episodeId === notice.localEpisodeId && o.delivery.wakeSeq === notice.wakeSeq
    : notice.origin === 'noted-recheck'
    ? o?.recheck?.state === 'open' && o.recheck.episodeId === notice.localEpisodeId && o.recheck.wakeSeq === notice.wakeSeq
    : notice.origin === 'noted'
    ? o?.local?.state === 'open' && o.local.episodeId === notice.localEpisodeId && o.local.wakeSeq === notice.wakeSeq
    : notice.origin === 'sc' && o?.sc?.controlEpoch === notice.scControlEpoch
      && o.sc.latestAttention?.state === 'open' && o.sc.latestAttention.episodeId === notice.episodeId
      && o.sc.latestAttention.wakeSeq === notice.wakeSeq;
  return !!run && run.runKind === 'external-research' && (localDelivery ? !run.sourceFollowupStartedAt
      && require('./external-research-completion-delivery').authorized(run)
      && !['delivered', 'observing'].includes(run.externalResearchDelivery.phase) : !terminal(run)) && run.notifySource !== false
    && !run.notificationSuppressed && !run.notificationCancelRequestedAt
    && (humanOnly || !suppressionReason(run, notice.origin)) && rearmNoticeAllowed(run, notice)
    && run.externalResearchJobId === notice.jobId && run.sourceTabId === notice.sourceTabId
    && run.createdAt === notice.runCreatedAt && episodeAllowed
    && isDeepStrictEqual(sourceTarget(run), notice.sourceTarget)
    && notice.delivery !== 'sent' && (notice.delivery !== 'suppressed'
      || humanOnly && ['operational_prompts_disabled', 'planned_maintenance'].includes(notice.suppressionReason));
}
const canReport = (run, notice) => canDeliver(run, notice, { humanOnly: true });
function synchronizeRevocations(run, revoke, now = Date.now()) {
  synchronizeRearmRevocation(run, now);
  let failure = null;
  for (const notice of Object.values(run.externalResearchOperational?.notices || {})) {
    if (notice.delivery === 'sent' || canDeliver(run, notice)) continue;
    if (notice.delivery !== 'suppressed') {
      notice.suppressionReason = suppressionReason(run, notice.origin) && canReport(run, notice)
        ? suppressionReason(run, notice.origin) : 'authority_revoked';
      if (notice.suppressionReason === 'planned_maintenance') notice.maintenanceOperationId = run.externalResearchMaintenanceOperationId;
      notice.delivery = 'suppressed'; notice.cancelRevision++; notice.updatedAt = now;
    }
    // Repeat an unconfirmed exact cancellation after a write error/restart.
    if (notice.cancellationConfirmed || typeof revoke !== 'function') continue;
    try {
      const result = revoke(run, notice);
      if (result?.then || result?.ok !== true) throw Object.assign(new Error('Operational input cancellation is not durable'),
        { code: 'external_research_operational_cancel_unconfirmed' });
      notice.cancellationConfirmed = true; notice.cancellationError = null;
    } catch (error) {
      notice.cancellationError = String(error.code || 'operational_cancel_unavailable'); failure ||= error;
    }
  }
  return failure;
}
function noticeBody(run, attention, execution, origin, rearm) {
  const recovery = execution.uiRecovery;
  if (recovery?.reportedAt && ['exhausted', 'blocked', 'unknown'].includes(recovery.status)) {
    const exhausted = recovery.outcome === 'ui_recovery_exhausted';
    return '[External Research: восстановление UI завершено]\n'
      + JSON.stringify({ runId: run.runId, jobId: run.externalResearchJobId, controlEpoch: attention.controlEpoch,
        conversationId: execution.turn?.conversationId, userMessageId: execution.turn?.userMessageId,
        outcome: recovery.outcome, attempts: recovery.attempts?.length || 0, providerOutcome: 'unresolved' }) + '\n'
      + (exhausted ? 'Лимит двух попыток автоматического восстановления исчерпан. Полного ответа пока нет. Рекомендуется новый чат с полным контекстом; это отдельное решение, новая отправка не выполнена. '
        : 'Автоматическое восстановление остановлено: действие или его результат не подтверждены. Не повторяй неизвестную отправку. ')
      + 'Сохрани исходные квитанции. Это не экспертное заключение. Уже существующий поздний полный ответ остаётся доступен под исходным job; не закрывай его единственную копию. Сообщи известному владельцу SC только при необходимости адресного восстановления, без повторных опросов.';
  }
  return '[External Research: требуется восстановление]\n'
    + 'Это нетерминальное служебное событие существующей задачи, не новый запрос пользователя и не готовый ответ.\n'
    + JSON.stringify({ origin, runId: run.runId, jobId: run.externalResearchJobId, controlEpoch: attention.controlEpoch,
      episodeId: attention.episodeId, wakeSeq: attention.wakeSeq, phase: attention.phase, reason: attention.reason,
      browserInstanceId: run.externalResearchBrowserInstanceId, sendState: execution.send?.state || 'unknown',
      conversationId: execution.turn?.conversationId || null, userMessageId: execution.turn?.userMessageId || null,
      blockerCode: execution.operation?.blocker?.code || (['noted-delivery', 'noted-recheck'].includes(origin) ? attention.code : null) || null,
      ...(rearm ? { maintenanceRecheck: rearm } : {}) }) + '\n'
    + (rearm ? 'Это новая подтверждённая проверка после обслуживания, не повтор старого подавленного уведомления. ' : '')
    + 'В этом служебном ходе сохрани исходные run/job, ошибку и квитанции, один раз сообщи известному владельцу SC/Research через Terminal MCP send_message и жди его восстановления либо полного штатного ответа. '
    + 'Не восстанавливай канал самостоятельно новым Chat, сменой Chat/Work/модели/браузера, ручным Send/Stop/reload или заменяющим research. '
    + 'Исключение — текущая вкладка сама назначена владельцем этого инфраструктурного ремонта; тогда она восстанавливает только существующий intent/turn по журналу в разрешённых границах. '
    + 'Это не поручение продолжать продуктовую реализацию до консультации и не замена ответа Astra. '
    + 'Если исходная работа ждёт экспертного заключения, вернись к её реализации только после фактического полного результата. '
    + 'Не создавай новый research, не повторяй Send при неизвестном исходе, не меняй браузер/аккаунт '
    + 'и не закрывай единственную копию ответа. Не начинай независимые правки по этому уведомлению. '
    + 'Событие не завершает ожидание результата.';
}
function operationalState(run) {
  return run.externalResearchOperational ||= { version: 1,
    sc: { controlEpoch: null, lastRevision: 0, latestAttention: null },
    local: { episodeId: null, state: 'healthy', firstObservedAt: null, lastObservedAt: null, wakeSeq: 0 }, notices: {} };
}
function addNotice(run, attention, execution, origin, now, rearm = null) {
  const o = operationalState(run);
  const id = 'research-operational:' + hash(JSON.stringify([origin, run.runId, run.externalResearchJobId,
    attention.controlEpoch || null, attention.episodeId, attention.wakeSeq,
    ...(rearm ? [rearm.operationId, rearm.generation] : [])]));
  if (o.notices[id]) return { changed: true, created: false };
  const body = noticeBody(run, attention, execution, origin, rearm);
  let suppression = suppressionReason(run, origin);
  if (rearm && suppression === 'post_maintenance_recheck') suppression = null;
  o.notices[id] = { version: 1, id, origin, runId: run.runId, runCreatedAt: run.createdAt,
    jobId: run.externalResearchJobId, ...(origin === 'sc' ? { scControlEpoch: attention.controlEpoch, episodeId: attention.episodeId }
      : { localEpisodeId: attention.episodeId }), wakeSeq: attention.wakeSeq, body, bodyHash: hash(body),
    sourceTabId: run.sourceTabId, sourceTarget: sourceTarget(run), handoffId: id,
    operationKey: `history:${run.sourceTabId}:${id}`, cancelRevision: 0,
    delivery: suppression ? 'suppressed' : 'pending',
    ...(suppression ? { suppressionReason: suppression } : {}), ...(rearm ? { rearm: clone(rearm) } : {}),
    ...(run.externalResearchMaintenanceOperationId ? { maintenanceOperationId: run.externalResearchMaintenanceOperationId } : {}),
    createdAt: now, updatedAt: now, attemptId: null, receipt: null };
  return { changed: true, created: true, noticeId: id };
}
function recordLocalOperationalFailure(run, { phase = 'opening', reason = 'transport_unavailable', code, retryAt = null,
  notificationGraceMs = 0 }, now = Date.now()) {
  const delivery = phase === 'delivering' && terminal(run);
  if (run.runKind !== 'external-research' || (terminal(run) && (!delivery
    || !require('./external-research-completion-delivery').authorized(run) || run.sourceFollowupStartedAt))) return { changed: false, created: false };
  const o = operationalState(run), key = delivery ? 'delivery' : 'local';
  const old = o[key] || { state: 'healthy' };
  const first = old.state !== 'open';
  const sequence = first ? Number(old.sequence || 0) + 1 : old.sequence;
  o[key] = { episodeId: first ? (delivery ? hash(JSON.stringify([run.externalResearchDelivery.id, sequence])) : crypto.randomUUID()) : old.episodeId,
    ...(delivery ? { sequence } : {}), state: 'open',
    firstObservedAt: first ? now : old.firstObservedAt, lastObservedAt: now, wakeSeq: first ? 1 : old.wakeSeq,
    phase: PHASES.has(phase) ? phase : 'opening', reason: REASONS.has(reason) ? reason : 'transport_unavailable',
    code: bounded(code) && /^[a-zA-Z0-9_.:-]+$/.test(code) ? code : 'transport_unavailable',
    retryAt: Number.isFinite(retryAt) ? retryAt : null };
  if (run.notifySource === false || run.notificationSuppressed) return { changed: true, created: false };
  // Only retrying owners request a grace window; blocked/unknown input owners
  // keep their immediate explicit decision path. The durable first failure
  // survives restart, so successive retries cannot extend this window forever.
  const grace = Number.isFinite(notificationGraceMs) ? Math.max(0, Math.min(60000, notificationGraceMs)) : 0;
  if (grace) o[key].notificationNotBefore = o[key].firstObservedAt + grace;
  if (now < (o[key].notificationNotBefore || 0)) return { changed: true, created: false };
  return addNotice(run, { ...o[key], jobId: run.externalResearchJobId }, {}, delivery ? 'noted-delivery' : 'noted',
    delivery ? run.externalResearchDelivery.createdAt : now);
}
function clearDeliveryEpisode(run, now = Date.now()) {
  const local = run.externalResearchOperational?.delivery;
  if (!local || local.state !== 'open') return false;
  local.state = 'cleared'; local.lastObservedAt = now; local.retryAt = null; return true;
}
function clearLocalOperationalEpisode(run, now = Date.now()) {
  const local = run.externalResearchOperational?.local;
  if (!local || local.state !== 'open') return false;
  local.state = 'cleared'; local.lastObservedAt = now; local.retryAt = null; return true;
}
function ingestOperational(run, snapshot, now = Date.now()) {
  if (run.runKind !== 'external-research' || snapshot.id !== run.externalResearchJobId) return { changed: false, created: false };
  const e = snapshot.execution, a = e?.attention;
  if (e?.version !== 1 || !bounded(e.controlEpoch) || !Number.isInteger(e.controlRevision)) return { changed: false, created: false };
  if (run.externalResearchBrowserInstanceId && snapshot.browserInstanceId !== run.externalResearchBrowserInstanceId) {
    throw Object.assign(new Error('Operational snapshot changed the pinned browser'), { code: 'external_research_operational_owner_mismatch' });
  }
  const o = operationalState(run), sc = o.sc;
  if (sc.controlEpoch && sc.controlEpoch !== e.controlEpoch) throw Object.assign(new Error('Operational snapshot changed the control epoch'), { code: 'external_research_control_epoch_mismatch' });
  if (e.controlRevision < sc.lastRevision) return { changed: false, created: false };
  const structuralChange = sc.controlEpoch !== e.controlEpoch || sc.lastRevision !== e.controlRevision;
  sc.controlEpoch = e.controlEpoch; sc.lastRevision = e.controlRevision;
  if (Object.hasOwn(e, 'reader')) sc.readerPin = e.reader ? { readerId: e.reader.readerId,
    generation: e.reader.generation, document: clone(e.reader.document) } : null;
  if (!a) return { changed: structuralChange, created: false };
  if (!validAttention(a, snapshot.id, e.controlEpoch)) return { changed: structuralChange, created: false };
  if (sc.latestAttention?.episodeId === a.episodeId && a.updateSeq < sc.latestAttention.updateSeq) return { changed: structuralChange, created: false };
  sc.latestAttention = { version: 2, episodeId: a.episodeId, state: a.state, phase: a.phase, reason: a.reason,
    updateSeq: a.updateSeq, wakeSeq: a.wakeSeq, updatedAt: now };
  if (a.state !== 'open' || terminal(run) || run.notifySource === false || run.notificationSuppressed) return { changed: true, created: false };
  return addNotice(run, a, e, 'sc', now);
}
function rearmScope(run, check) {
  const r = run.externalResearchOperationalRearm;
  return { version: 1, runId: run.runId, jobId: run.externalResearchJobId, operationId: r.operationId,
    generation: r.generation, sourcePin: r.sourcePin, checkId: check.checkId,
    controlEpoch: r.controlEpoch, browserInstanceId: r.browserInstanceId };
}
function rearmCheckAuthorized(run, scope, { completed = false } = {}) {
  const r = run?.externalResearchOperationalRearm, check = r?.checks?.[scope?.checkId];
  return rearmCurrent(run) && scope?.version === 1 && scope.runId === run.runId
    && scope.jobId === run.externalResearchJobId && scope.operationId === r.operationId
    && scope.generation === r.generation && scope.sourcePin === r.sourcePin
    && scope.controlEpoch === r.controlEpoch && scope.browserInstanceId === r.browserInstanceId
    && r.currentCheckId === scope.checkId && !!check
    && (completed || check.state === 'reserved' && r.lanes.sc.state === 'awaiting_fresh');
}
function reserveRearmScCheck(run, now = Date.now()) {
  if (!rearmCurrent(run)) return null;
  const r = run.externalResearchOperationalRearm, sc = run.externalResearchOperational?.sc;
  if (r.lanes.sc.state !== 'awaiting_fresh' || !sc?.controlEpoch) return null;
  const browser = run.externalResearchBrowserInstanceId || run.externalResearchExpectedBrowserInstanceId;
  if (!browser || r.controlEpoch && r.controlEpoch !== sc.controlEpoch
    || r.browserInstanceId && r.browserInstanceId !== browser) return null;
  r.controlEpoch ||= sc.controlEpoch; r.browserInstanceId ||= browser;
  let check = r.checks[r.currentCheckId];
  if (!check || check.state !== 'reserved') {
    const sequence = ++r.checkSequence;
    const checkId = 'rearm:' + hash(JSON.stringify([run.runId, run.createdAt, r.operationId, r.generation, sequence]));
    check = { checkId, sequence, state: 'reserved', reservedAt: now };
    r.checks[checkId] = check; r.currentCheckId = checkId;
  }
  return rearmScope(run, check);
}
function settleRearmTransport(run, read, failure = null, now = Date.now()) {
  if (!rearmCurrent(run)) return { changed: false, created: false };
  const r = run.externalResearchOperationalRearm, lane = r.lanes.noted;
  if (lane.state !== 'awaiting_fresh') return { changed: false, created: false };
  if (failure && now < (run.externalResearchOperational?.local?.notificationNotBefore || 0)) {
    return { changed: true, created: false };
  }
  lane.state = 'verified'; lane.proof = { kind: 'local_transport', readId: read.id,
    startedAt: read.startedAt, completedAt: now, afterCompletionCommit: true, failureCode: failure?.code || null };
  if (!failure || run.externalResearchOperational?.local?.state !== 'open') return { changed: true, created: false };
  const a = run.externalResearchOperational.local;
  const result = addNotice(run, a, {}, 'noted', now,
    { operationId: r.operationId, generation: r.generation, checkId: read.id });
  lane.noticeId = result.noticeId || lane.noticeId;
  return result;
}
function completeRearmScCheck(run, scope, result, now = Date.now()) {
  if (!rearmCheckAuthorized(run, scope, { completed: true })) return { changed: false, created: false };
  const r = run.externalResearchOperationalRearm, check = r.checks[scope.checkId], receipt = result?.check, e = result?.execution;
  if (!receipt || receipt.version !== 1 || receipt.state !== 'complete' || receipt.checkId !== scope.checkId
    || receipt.jobId !== scope.jobId || receipt.controlEpoch !== scope.controlEpoch || receipt.browserInstanceId !== scope.browserInstanceId
    || e?.version !== 1 || e.controlEpoch !== scope.controlEpoch || !Number.isInteger(e.controlRevision)
    || !Number.isInteger(receipt.controlRevision) || receipt.controlRevision > e.controlRevision) return { changed: false, created: false };
  const receiptHash = hash(JSON.stringify(receipt));
  const previousRevision = run.externalResearchOperational?.sc?.lastRevision || 0;
  if (check.state === 'complete' && check.receiptHash !== receiptHash) return { changed: false, created: false, repeated: false };
  const attentionValid = e.attention == null || validAttention(e.attention, scope.jobId, scope.controlEpoch);
  if (attentionValid) ingestOperational(run, { id: scope.jobId, browserInstanceId: scope.browserInstanceId, execution: e }, now);
  if (check.state === 'complete') return { changed: false, created: false, repeated: check.receiptHash === receiptHash };
  check.receiptHash = receiptHash; check.completedAt = now;
  check.receipt = clone(receipt); check.current = result.current === true;
  if (run.externalResearchOperational?.recheck) run.externalResearchOperational.recheck.state = 'cleared';
  if (!attentionValid || result.current !== true || !['open', 'healthy', 'settled'].includes(receipt.verdict)
    || receipt.verdict === 'open' && e.attention?.state !== 'open'
    || receipt.verdict === 'healthy' && e.attention?.state === 'open'
    || e.controlRevision < previousRevision || !isDeepStrictEqual(receipt.attention, e.attention)
    || !isDeepStrictEqual(receipt.reader || null, e.reader ? { readerId: e.reader.readerId,
      generation: e.reader.generation, document: e.reader.document } : null)) {
    check.state = 'complete-unusable'; return { changed: true, created: false };
  }
  check.state = 'complete'; r.lanes.sc.state = 'verified'; r.lanes.sc.checkId = scope.checkId;
  if (receipt.verdict !== 'open' || e.attention?.state !== 'open') return { changed: true, created: false };
  const added = addNotice(run, e.attention, e, 'sc', now,
    { operationId: r.operationId, generation: r.generation, checkId: scope.checkId });
  r.lanes.sc.noticeId = added.noticeId || r.lanes.sc.noticeId;
  return added;
}
function recordRearmProbeFailure(run, scope, error, now = Date.now()) {
  if (!rearmCheckAuthorized(run, scope)) return { changed: false, created: false };
  const r = run.externalResearchOperationalRearm, o = operationalState(run), previous = o.recheck;
  if (previous?.state !== 'open') {
    const sequence = Number(previous?.sequence || 0) + 1;
    const code = bounded(error?.code) && /^[a-zA-Z0-9_.:-]+$/.test(error.code) ? error.code : 'sc_research_operational_recheck_unavailable';
    o.recheck = { episodeId: hash(JSON.stringify([r.operationId, r.generation, sequence, 'probe'])), sequence,
      state: 'open', wakeSeq: 1, phase: 'observing', reason: code.includes('recheck_unavailable')
        ? 'executor_update_required' : 'observation_unavailable', code, firstObservedAt: now, lastObservedAt: now };
  }
  const a = o.recheck;
  const added = addNotice(run, a, {}, 'noted-recheck', now,
    { operationId: r.operationId, generation: r.generation, checkId: scope.checkId });
  r.probeFailure = { state: 'verified', noticeId: added.noticeId || r.probeFailure?.noticeId };
  return added;
}
function publicOperational(value) {
  if (!value) return null;
  return { version: 1, sc: clone(value.sc), local: clone(value.local), delivery: clone(value.delivery),
    ...(value.recheck ? { recheck: clone(value.recheck) } : {}), notices: Object.values(value.notices || {}).map(n => ({ id: n.id, origin: n.origin,
      episodeId: n.episodeId, wakeSeq: n.wakeSeq, delivery: n.delivery,
      ...(n.suppressionReason ? { suppressionReason: n.suppressionReason } : {}),
      ...(n.maintenanceOperationId ? { maintenanceOperationId: n.maintenanceOperationId } : {}),
      createdAt: n.createdAt, updatedAt: n.updatedAt })) };
}
module.exports = { clearDeliveryEpisode, ingestOperational, recordLocalOperationalFailure, clearLocalOperationalEpisode,
  publicOperational, canDeliver, canReport, synchronizeRevocations, sourceTarget, hash,
  rearmOwner, rearmCurrent, beginPostMaintenanceRearm, reserveRearmScCheck, rearmCheckAuthorized,
  settleRearmTransport, completeRearmScCheck, recordRearmProbeFailure };
