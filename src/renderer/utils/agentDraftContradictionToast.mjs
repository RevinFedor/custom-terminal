export function showAgentDraftScreenContradictionToast(store, {
  tabId,
  label,
} = {}) {
  const exactTabId = String(tabId || '');
  const agentLabel = String(label || 'Agent');
  if (!store || !exactTabId || typeof store.showToast !== 'function') {
    return { shown: false, reason: 'toast-store-unavailable' };
  }

  const message = agentLabel
    + ' terminal screen disagreed with the real input. Send continued after an exact empty-input check.';
  const alreadyVisible = Array.isArray(store.toasts)
    && store.toasts.some((toast) => (
      toast?.tabId === exactTabId
      && toast?.message === message
    ));
  if (alreadyVisible) return { shown: false, reason: 'already-visible', message };

  store.showToast(
    message,
    'error',
    0,
    true,
    undefined,
    undefined,
    undefined,
    exactTabId,
    undefined,
    'The screen copy contained ambiguous cells, while the exact editor read returned an empty input. Diagnostics were saved.',
  );
  return { shown: true, reason: 'screen-contradiction', message };
}
