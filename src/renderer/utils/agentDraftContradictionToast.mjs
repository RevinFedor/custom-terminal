export function showAgentDraftScreenContradictionToast(store, {
  tabId,
  label,
  screenProof = null,
  exactCapture = null,
  occurredAt = Date.now(),
} = {}) {
  const exactTabId = String(tabId || '');
  const agentLabel = String(label || 'Agent');
  if (!store || !exactTabId || typeof store.showToast !== 'function') {
    return { shown: false, reason: 'toast-store-unavailable' };
  }

  const message = agentLabel + ': расхождение при проверке поля ввода';
  const utc = new Date(occurredAt).toISOString();
  const moscow = new Date(Number(occurredAt) + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', ' MSK');
  const captureId = exactCapture?.captureRequestId || exactCapture?.captureOperationId || '-';
  const report = [
    'Noted Terminal input diagnostic',
    'Result: exact empty input confirmed; send preflight may continue (not delivery confirmation)',
    'Tool: ' + agentLabel.toLowerCase(),
    'Tab ID: ' + exactTabId,
    'Time (Moscow): ' + moscow,
    'Time (UTC): ' + utc,
    'Capture request ID: ' + captureId,
    'Screen source: ' + (screenProof?.source || '-'),
    'Screen verdict: ' + (screenProof?.proofOutcome || String(screenProof?.hasDraft ?? 'unknown')),
    'Exact verdict: ' + (exactCapture?.proofOutcome || 'absent'),
    'Exact reason: ' + (exactCapture?.proofReason || '-'),
    'Lifecycle: ' + (exactCapture?.terminalLifecycleGeneration || screenProof?.terminalLifecycleGeneration || '-'),
    'Mirror: ' + (exactCapture?.mirrorGeneration || screenProof?.mirrorGeneration || '-'),
    'Run: ' + (exactCapture?.terminalRunSeq ?? screenProof?.terminalRunSeq ?? '-'),
    'Input revision: ' + (screenProof?.inputRevision ?? '-') + ' → ' + (exactCapture?.inputRevision ?? '-'),
    'Log lookup: [AgentDraftProof:CONTRADICTION] tab=' + exactTabId.slice(-12),
    'Artifacts: see matching [AgentDraftProof:FORENSIC_ARTIFACT] and [AgentDraftProof:SCREEN_ARTIFACT] log records',
  ].join('\n');
  const alreadyVisible = Array.isArray(store.toasts)
    && store.toasts.some((toast) => (
      toast?.tabId === exactTabId
      && toast?.message === message
      && (captureId === '-' || toast?.copyText?.includes('Capture request ID: ' + captureId + '\n'))
    ));
  if (alreadyVisible) return { shown: false, reason: 'already-visible', message };

  store.showToast(
    message,
    'warning',
    0,
    true,
    report,
    undefined,
    undefined,
    exactTabId,
    undefined,
    'Экран показывал возможный черновик, но точное чтение подтвердило пустое поле. Отправка может продолжиться. Это диагностика проверки ввода, а не ошибка доставки; данные для расследования — в «Копировать».',
  );
  return { shown: true, reason: 'screen-contradiction', message };
}
