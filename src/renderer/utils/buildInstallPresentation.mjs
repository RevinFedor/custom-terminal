import activity from '../../shared/build-install-activity.cjs';
const isReservationRow = job => job?.id === 'continuation:' + job.requestId;
const sameContinuation = (a, b) => !!a?.fingerprint && a.fingerprint === b?.fingerprint
  && a.requestId === b.requestId && a.source?.tabId === b.source?.tabId
  && a.source?.sessionId === b.source?.sessionId
  && (!a.jobId || !b.jobId || a.jobId === b.jobId);
const rowOwnsContinuation = (job, entry) => !!entry && job.requestId === entry.requestId
  && job.returnTo?.tabId === entry.source?.tabId && job.returnTo?.sessionId === entry.source?.sessionId;
export function mergeBuildInstallJobs(previous = [], incoming = [], tabId, continuations = []) {
  const values = new Map(previous.filter(job => job.returnTo?.tabId === tabId).map(job => [job.id, job]));
  for (const job of incoming) {
    if (!job?.id || job.returnTo?.tabId !== tabId) continue;
    // The source reservation precedes Voice's Job ID. Its temporary row is
    // the same request, never a second installer or a permanent pending wait.
    if (isReservationRow(job) && rowOwnsContinuation(job, job.continuation)
      && [...values.values()].some(value => !isReservationRow(value) && activity.ownedJob(value.continuation, value)
        && sameContinuation(value.continuation, job.continuation))) continue;
    const old = values.get(job.id);
    if (old && (old.requestId !== job.requestId || old.returnTo.sessionId !== job.returnTo.sessionId
      || activity.olderProjection(old, job)
      || !job.projection && Number(old.revision || 0) >= Number(job.revision || 0)
      || job.projection && old.projection?.epoch === job.projection.epoch
        && old.projection.revision === job.projection.revision)) continue;
    values.set(job.id, job);
    if (activity.ownedJob(job.continuation, job)) for (const [id, value] of values) {
      if (isReservationRow(value) && rowOwnsContinuation(value, value.continuation)
        && sameContinuation(value.continuation, job.continuation)
        && !activity.olderProjection(value, job)) values.delete(id);
    }
  }
  // A settled wait may outlive the installer's bounded status cache. Apply
  // the exact Main continuation to retained History rows, without guessing a
  // job result, clearing running work, or touching any delivery receipt.
  for (const entry of continuations) {
    if (entry?.source?.tabId !== tabId || !entry.projection) continue;
    for (const [id, old] of values) {
      if (!rowOwnsContinuation(old, entry) || !sameContinuation(old.continuation, entry) || activity.olderProjection(old, entry)
        || old.projection?.epoch === entry.projection.epoch && old.projection.revision >= entry.projection.revision) continue;
      values.set(id, { ...old, projection: entry.projection, continuation: entry });
    }
  }
  const rows = [...values.values()].sort((a, b) => b.startedAt - a.startedAt);
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
export function buildInstallPresentation(job, stale = false) {
  if (stale) return { label: 'Связь не подтверждена', color: '#fbbf24', spinning: false };
  if (job.requestCancelledAt) return { label: job.running ? 'Отмена запроса…' : 'Запрос отменён', color: '#a3a3a3', spinning: false };
  if (job.installOutcomeUnknown) return { label: 'Исход установки неизвестен', color: '#fbbf24', spinning: false };
  if (job.cancelled) return { label: job.running ? 'Остановка установки…'
    : job.cancellation?.origin === 'user' ? 'Установка отменена пользователем' : 'Установка отменена',
    color: '#a3a3a3', spinning: job.running === true };
  if (job.running) {
    const labels = { preparing: 'Сборка', validating: 'Проверка', 'awaiting-owner': 'Перед обновлением',
      quitting: 'Закрытие приложения', installing: 'Установка', launching: 'Запуск', verifying: 'Проверка связи' };
    return { label: job.phase === 'observing' ? 'Ожидание' : labels[job.stage] || (job.phase === 'building' ? 'Сборка' : 'Подготовка'),
      color: '#60a5fa', spinning: true };
  }
  if (job.ok === false) return { label: 'Ошибка установки', color: '#f87171', spinning: false };
  if (['failed', 'blocked'].includes(job.callback?.status)) return { label: 'Ошибка доставки уведомления', color: '#f87171', spinning: false };
  if (['pending', 'waiting', 'sending', 'confirming', 'sent_unverified'].includes(job.callback?.status)) {
    return { label: 'Возврат в сессию', color: '#60a5fa', spinning: true };
  }
  if (activity.pending(job.continuation)) {
    if (job.callback?.status === 'sent') return { label: job.ok === true
      ? 'Установлено · уведомление доставлено' : 'Уведомление доставлено', color: '#4ade80', spinning: false };
    return { label: 'Возврат в сессию', color: '#60a5fa', spinning: true };
  }
  return { label: job.ok ? 'Установлено' : 'Остановлено', color: job.ok ? '#4ade80' : '#a3a3a3', spinning: false };
}
export function buildInstallVisibleInDock(job) {
  if (job.requestCancelledAt && !job.running) return false;
  return activity.pending(job.continuation) || job.running || job.ok === false || job.installOutcomeUnknown
    || ['pending', 'waiting', 'sending', 'confirming', 'sent_unverified', 'failed', 'blocked'].includes(job.callback?.status);
}
