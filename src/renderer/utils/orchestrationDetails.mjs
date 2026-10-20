import { isOrchestrationResultProofPending } from './orchestrationRunProjection.mjs';

const OUTCOMES = {
  success: 'Выполнено',
  failed: 'Не выполнено',
  interrupted: 'Остановлено вручную',
  paused: 'На паузе',
  target_closed: 'Вкладка исполнителя закрыта',
  startup_failed: 'Не удалось запустить исполнителя',
  process_exited: 'Процесс исполнителя завершился',
  process_replaced: 'Процесс исполнителя сменился',
  result_unavailable: 'Результат недоступен',
  detached: 'Связь с запросом закрыта',
  unknown: 'Исход неизвестен',
};

const REASONS = {
  task_complete: 'задача завершена',
  'turn-complete': 'ход завершён',
  'turn-complete-without-prompt-proof': 'ход завершён без подтверждения исходного запроса',
  'external-research-done': 'внешнее исследование завершено',
  'external-research-error': 'ошибка внешнего исследования',
  'external-research-start-failed': 'не удалось запустить внешнее исследование',
  'recovered-from-transcript': 'результат восстановлен из истории',
  'codex-background-work-complete': 'фоновая работа завершена',
};

const text = value => typeof value === 'string' ? value.trim() : '';
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0
  && Number.isFinite(new Date(value).getTime());

const RESEARCH_PROVIDERS = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity' };
const RESEARCH_EFFORTS = {
  pro: 'Pro', xhigh: 'X High', high: 'High', medium: 'Medium', low: 'Low',
  instant: 'Instant', max: 'Max', standard: 'Standard', extended: 'Extended', light: 'Light',
};

export function orchestrationLinkedName(run, tabId) {
  if (run.sourceTabId !== tabId) return run.sourceTabName;
  if (run.runKind !== 'external-research') return run.targetTabName;
  const provider = Object.hasOwn(RESEARCH_PROVIDERS, run.externalResearchProvider)
    ? RESEARCH_PROVIDERS[run.externalResearchProvider] : '';
  const model = text(run.externalResearchModel);
  const effort = text(run.externalResearchEffort);
  if (!provider || !model) return run.targetTabName;
  // Old names may contain a mode missing from the saved fields; never guess Pro.
  if (!effort) return run.targetTabName || `${provider} · ${model}`;
  const modelLabel = run.externalResearchProvider === 'chatgpt' && model === '6-astra' ? '6' : model;
  const effortLabel = Object.hasOwn(RESEARCH_EFFORTS, effort.toLowerCase())
    ? RESEARCH_EFFORTS[effort.toLowerCase()] : effort;
  return `${provider} · ${modelLabel} ${effortLabel}`;
}

export function orchestrationDateTime(value) {
  if (!validTime(value)) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

export function orchestrationRequestTime(run) {
  let label = 'Создан', value = run.createdAt;
  // SC job acceptance is not browser submission. Native delivery needs prompt proof.
  if (run.runKind !== 'external-research' && validTime(run.targetPromptProofAt)) {
    label = validTime(run.deliveryAcceptedAt) ? 'Отправлен' : 'Подтверждён';
    value = validTime(run.deliveryAcceptedAt) ? run.deliveryAcceptedAt : run.targetPromptProofAt;
  }
  return { key: 'time', label, value: orchestrationDateTime(value),
    dateTime: validTime(value) ? new Date(value).toISOString() : undefined };
}

export function orchestrationOutcomeText(run) {
  if (isOrchestrationResultProofPending(run)) return 'Работа завершена; результат ещё проверяется';
  const outcome = text(run.outcome);
  const reason = text(run.completionReason);
  const label = Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : outcome;
  if (!reason || reason === outcome) return label;
  if (outcome === 'interrupted' && reason === 'turn_aborted') return label;
  if (outcome === 'success' && ['task_complete', 'turn-complete', 'external-research-done'].includes(reason)) return label;
  return [label, Object.hasOwn(REASONS, reason) ? REASONS[reason] : reason].filter(Boolean).join(': ');
}

export function orchestrationNotificationText(run, tabId) {
  if (run.sourceTabId !== tabId || run.notifySource === false || !run.notificationStatus) return '';
  const status = run.notificationStatus;
  if (status === 'pending' && isOrchestrationResultProofPending(run)) return 'Ожидает проверки результата';
  // New runs start with pending before any result or notification exists.
  if (status === 'pending' && !run.completedAt && !run.notificationAttemptedAt
    && !['failed', 'cancelled', 'completed'].includes(run.status)) return '';
  const subject = run.outcome === 'failed' || run.status === 'failed' ? 'Об ошибке'
    : run.outcome === 'success' || run.status === 'completed' ? 'С результатом' : 'О завершении';
  const labels = {
    pending: 'Ожидает отправки',
    sending: 'Отправляется',
    'audit-pending': 'Проверяется доставка уведомления',
    sent: `${subject} доставлено`,
    queued: 'В очереди исходной вкладки',
    'waiting-for-input': 'Не доставлено: занят ввод исходной вкладки',
    unconfirmed: 'Доставка уведомления не подтверждена',
    failed: `${subject} не доставлено`,
    suppressed: 'Отправка отменена',
    'source-closed': 'Не доставлено: исходная вкладка закрыта',
  };
  return Object.hasOwn(labels, status) ? labels[status] : `Неизвестный статус: ${status}`;
}

export function orchestrationDetailRows(run, tabId) {
  const rows = [orchestrationRequestTime(run)];
  const outcome = orchestrationOutcomeText(run);
  if (outcome) rows.push({ key: 'outcome', label: 'Итог', value: outcome });
  const notification = orchestrationNotificationText(run, tabId);
  if (notification) rows.push({ key: 'notification', label: 'Уведомление', value: notification });
  if (run.status === 'queued' && run.deliveryDeferredReason === 'waiting-for-browser'
    && run.externalResearchBrowserWait?.notSubmitted === true) {
    const browser = run.externalResearchRequestedBrowserId === 'chrome' ? 'Chrome'
      : run.externalResearchRequestedBrowserId === 'yandex' ? 'Яндекс'
        : run.externalResearchBrowserWait.browserInstanceId;
    rows.push({ key: 'browser-wait', label: 'Браузер', value: `${browser}: не в сети. Не отправлен` });
  }
  const issues = new Map();
  for (const [label, value] of [
    ['Выполнение', run.error], ['Результат', run.resultError],
    ['Уведомление', run.notificationError],
    ['Связь с SC Desktop', run.externalResearchTransportError],
    ['Telegram', run.externalResearchBrowserNoticeError],
  ]) {
    const message = text(value);
    if (['Выполнение', 'Результат'].includes(label) && message === 'turn_aborted'
      && run.outcome === 'interrupted' && run.completionReason === 'turn_aborted') continue;
    if (!message || issues.has(message)) continue;
    issues.set(message, label);
  }
  if (issues.size) rows.push({ key: 'error', label: issues.size === 1 ? 'Ошибка' : 'Ошибки', error: true,
    value: [...issues].map(([message, label]) => issues.size === 1 && label !== 'Уведомление'
      ? message : `${label}: ${message}`).join('\n\n') });
  return rows;
}
