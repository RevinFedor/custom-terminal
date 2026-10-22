import activity from '../../shared/build-install-activity.cjs';
export function mergeBuildInstallJobs(previous = [], incoming = [], tabId) {
  const values = new Map(previous.filter(job => job.returnTo?.tabId === tabId).map(job => [job.id, job]));
  for (const job of incoming) {
    if (!job?.id || job.returnTo?.tabId !== tabId) continue;
    const old = values.get(job.id);
    if (old && (old.requestId !== job.requestId || old.returnTo.sessionId !== job.returnTo.sessionId
      || activity.olderProjection(old, job)
      || !job.projection && Number(old.revision || 0) >= Number(job.revision || 0)
      || job.projection && old.projection?.epoch === job.projection.epoch
        && old.projection.revision === job.projection.revision)) continue;
    values.set(job.id, job);
  }
  const rows = [...values.values()].sort((a, b) => b.startedAt - a.startedAt);
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
export function buildInstallPresentation(job, stale = false) {
  if (stale) return { label: 'Связь не подтверждена', color: '#fbbf24', spinning: false };
  if (activity.pending(job.continuation) && job.continuation.inheritedActive === false) {
    return { label: 'Ожидание подтверждения продолжения', color: '#fbbf24', spinning: false };
  }
  if (job.installOutcomeUnknown) return { label: 'Исход установки неизвестен', color: '#fbbf24', spinning: false };
  if (job.cancelled) return { label: job.running ? 'Отмена…' : 'Отменено', color: '#a3a3a3', spinning: false };
  if (job.running) {
    const labels = { preparing: 'Сборка', validating: 'Проверка', 'awaiting-owner': 'Перед обновлением',
      quitting: 'Закрытие приложения', installing: 'Установка', launching: 'Запуск', verifying: 'Проверка связи' };
    return { label: job.phase === 'observing' ? 'Ожидание' : labels[job.stage] || (job.phase === 'building' ? 'Сборка' : 'Подготовка'),
      color: '#a78bfa', spinning: true };
  }
  if (job.ok === false) return { label: 'Ошибка установки', color: '#f87171', spinning: false };
  if (['failed', 'blocked'].includes(job.callback?.status)) return { label: 'Возврат не подтверждён', color: '#fbbf24', spinning: false };
  if (['pending', 'waiting', 'sending', 'confirming', 'sent_unverified'].includes(job.callback?.status)) {
    return { label: 'Возврат в сессию', color: '#60a5fa', spinning: true };
  }
  return { label: job.ok ? 'Установлено' : 'Остановлено', color: job.ok ? '#4ade80' : '#a3a3a3', spinning: false };
}
export function buildInstallVisibleInDock(job) {
  return activity.pending(job.continuation) || job.running || job.ok === false || job.installOutcomeUnknown
    || ['pending', 'waiting', 'sending', 'confirming', 'sent_unverified', 'failed', 'blocked'].includes(job.callback?.status);
}
