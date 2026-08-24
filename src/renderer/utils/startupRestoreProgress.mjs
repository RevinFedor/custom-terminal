const initialProgress = () => ({
  phase: 'projects',
  label: 'Загружаем проекты…',
  detail: '',
  current: 0,
  total: 0,
  failed: 0,
  blocking: true,
});

let progress = initialProgress();
let completionTimer = null;
const listeners = new Set();

const notify = () => {
  for (const listener of listeners) listener(progress);
};

export function getStartupRestoreProgress() {
  return progress;
}

export function subscribeStartupRestoreProgress(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  listener(progress);
  return () => listeners.delete(listener);
}

export function setStartupRestoreProgress(patch) {
  if (completionTimer !== null) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
  progress = { ...progress, ...(patch || {}), blocking: true };
  console.warn('[StartupRestoreUI] phase=' + progress.phase
    + ' current=' + progress.current + '/' + progress.total
    + ' failed=' + progress.failed
    + ' label=' + progress.label
    + ' detail=' + (progress.detail || '-'));
  notify();
}

export function completeStartupRestore({ failed = 0, delayMs } = {}) {
  const failureCount = Math.max(
    Math.max(0, Number(progress.failed) || 0),
    Math.max(0, Number(failed) || 0),
  );
  progress = {
    ...progress,
    phase: 'complete',
    label: failureCount > 0
      ? 'Рабочая область восстановлена с ошибками'
      : 'Рабочая область готова',
    detail: failureCount > 0
      ? `Не запущено AI-сессий: ${failureCount}. Ошибки останутся на соответствующих вкладках.`
      : 'Все этапы запуска завершены.',
    current: progress.total,
    failed: failureCount,
    blocking: true,
  };
  console.warn('[StartupRestoreUI] phase=complete failed=' + failureCount);
  notify();

  const holdMs = Number.isFinite(Number(delayMs))
    ? Math.max(0, Number(delayMs))
    : failureCount > 0 ? 1400 : 350;
  completionTimer = setTimeout(() => {
    completionTimer = null;
    progress = { ...progress, phase: 'idle', blocking: false };
    console.warn('[StartupRestoreUI] phase=idle');
    notify();
  }, holdMs);
}

export function resetStartupRestoreProgressForTests() {
  if (completionTimer !== null) clearTimeout(completionTimer);
  completionTimer = null;
  progress = initialProgress();
  notify();
}
