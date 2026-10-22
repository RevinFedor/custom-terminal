const ACTIONS = ['resume', 'leave-paused'];
const matchesSession = (state, sessionId) => !state?.owner?.sessionId || !sessionId
  || state.owner.sessionId === sessionId;
const isChoice = value => ACTIONS.includes(value);

/** Renderer memory is presentation/receipt tracking only. Main owns every choice.
 * One instance shared by all retained panels; rebinding never resubmits a request.
 */
export function createCodexGoalDesktopAdapter({ invoke, createRequestId = () => crypto.randomUUID(), log = () => {} }) {
  const tabs = new Map();
  function entry(tabId) {
    if (!tabs.has(tabId)) tabs.set(tabId, { current: null, receipts: new Map(), latest: new Map(),
      hidden: new Set(), listeners: new Set(), revision: 0, reading: null, dirty: false,
      writing: false, lastRequestId: null, error: null, logged: null });
    return tabs.get(tabId);
  }
  const notify = state => { for (const listener of state.listeners) listener(); };
  function snapshot(tabId, sessionId) {
    const state = entry(tabId);
    const retained = state.receipts.get(state.lastRequestId);
    const current = state.current?.operationId ? state.current : retained
      ? { ...retained, currentOperation: false, runtimeLive: false, availableActions: [] } : state.current;
    if (!current?.operationId || !matchesSession(current, sessionId)) return null;
    const requestId = state.latest.get(current.operationId) || current.requestId;
    const receipt = requestId ? state.receipts.get(requestId) : null;
    // A lost ACK/receipt cannot be replaced with an old available snapshot.
    const uncertain = receipt?.transportUnknown === true;
    const rejectedBeforeAction = receipt?.status === 'rejected' && receipt.accepted === false;
    const view = uncertain ? { ...current, ...receipt, status: 'unknown', availableActions: [] }
      : receipt && receipt.operationId === current.operationId ? receipt : current;
    const allowed = !state.writing && !state.error && !uncertain && current.currentOperation === true
      && current.runtimeLive === true && (view.status === 'available' || view.status === 'unknown' && view.recoveryAvailable === true
        || rejectedBeforeAction && current.status === 'available')
      ? ACTIONS.filter(action => current.availableActions?.includes(action)
        && (rejectedBeforeAction || view.availableActions?.includes(action))) : [];
    return { ...view, tabId, operationId: current.operationId, requestId: requestId || null,
      availableActions: allowed, pending: state.writing || view.status === 'pending',
      hidden: state.hidden.has(current.operationId), error: state.error,
      // Keep the last exact receipt available to diagnostics even when the
      // current dialog is replaced; no completion is inferred from replacement.
      receipt: receipt || null };
  }
  function remember(state, result, request) {
    if (result?.tabId !== request.tabId || result?.requestId !== request.requestId
      || result?.operationId !== request.operationId || result?.action !== request.action
      || result.reason === 'goal-request-not-found' || !result.status) return false;
    state.receipts.set(request.requestId, { ...result });
    return true;
  }
  async function refresh(tabId) {
    const state = entry(tabId);
    if (state.reading) { state.dirty = true; return state.reading; }
    const revision = state.revision;
    state.reading = (async () => {
      try {
        const current = await invoke('codex:read-goal-action', { tabId });
        if (revision !== state.revision || state.dirty) { state.dirty = true; return; }
        if (current?.tabId !== tabId || current?.ok !== true || !current.status) {
          throw new Error(current?.error || current?.code || 'Goal API unavailable');
        }
        state.current = current;
        state.error = null;
        // A remount/cold renderer can recover Main's exact active request too.
        if (current.operationId && current.requestId && isChoice(current.action)) {
          state.latest.set(current.operationId, current.requestId);
          state.lastRequestId = current.requestId;
          state.receipts.set(current.requestId, { ...current });
        }
        const requestId = current.operationId ? state.latest.get(current.operationId) : state.lastRequestId;
        const request = requestId && state.receipts.get(requestId);
        if (request) {
          const receipt = await invoke('codex:read-goal-action', { tabId, requestId });
          if (revision !== state.revision || state.dirty) { state.dirty = true; return; }
          if (!remember(state, receipt, request)) {
            state.receipts.set(requestId, { ...request, transportUnknown: true, availableActions: [] });
            state.error = receipt?.reason || receipt?.code || 'Goal receipt unavailable';
          }
        }
      } catch (error) {
        if (revision === state.revision) state.error = String(error?.message || error);
      }
    })().finally(() => {
      state.reading = null;
      const view = snapshot(tabId);
      const signature = [view?.operationId, view?.requestId, view?.status, view?.choiceConfirmed, state.error].join('|');
      if (signature !== state.logged) {
        state.logged = signature;
        log('[CodexGoalDesktop] read tab=' + tabId + ' operation=' + (view?.operationId || '-')
          + ' request=' + (view?.requestId || '-') + ' status=' + (view?.status || 'unavailable')
          + ' confirmed=' + (view?.choiceConfirmed === true) + ' error=' + (state.error || '-'));
      }
      notify(state);
      if (state.dirty) { state.dirty = false; void refresh(tabId); }
    });
    return state.reading;
  }
  async function choose(tabId, sessionId, operationId, action) {
    const state = entry(tabId), view = snapshot(tabId, sessionId);
    if (!view || view.hidden || view.operationId !== operationId || !view.availableActions.includes(action)) return false;
    const request = { tabId, operationId, requestId: createRequestId(), action };
    // Admission is synchronous, before the first await: other panes/double clicks
    // cannot create another request from the same old available snapshot.
    state.revision++;
    state.writing = true;
    state.error = null;
    state.latest.set(operationId, request.requestId);
    state.lastRequestId = request.requestId;
    state.receipts.set(request.requestId, { ...request, status: 'pending', availableActions: [] });
    log('[CodexGoalDesktop] apply tab=' + tabId + ' operation=' + operationId
      + ' request=' + request.requestId + ' action=' + action);
    notify(state);
    try {
      const result = await invoke('codex:apply-goal-action', request);
      if (!remember(state, result, request)) throw new Error(result?.error || result?.code || 'Goal action ACK unavailable');
    } catch (error) {
      state.receipts.set(request.requestId, { ...request, status: 'unknown', transportUnknown: true, availableActions: [] });
      state.error = String(error?.message || error);
    } finally {
      state.writing = false;
      state.revision++;
      notify(state);
      // One read after the action, never another POST. Later reads are event-
      // driven; no polling, duplicate key or user-facing refresh control.
      void refresh(tabId);
    }
    return true;
  }
  return { snapshot, refresh, choose,
    receipt: (tabId, requestId) => entry(tabId).receipts.get(requestId) || null,
    subscribe(tabId, listener) { const state = entry(tabId); state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
    dismiss(tabId, operationId) {
      const state = entry(tabId); state.hidden.add(operationId);
      log('[CodexGoalDesktop] hide tab=' + tabId + ' operation=' + operationId);
      notify(state);
    },
  };
}

// Existing lifecycle events are wakes, not action/ready/choice proof.
export function watchCodexGoalDesktop(adapter, ipcRenderer, tabId, sessionId, onChange) {
  const publish = () => onChange(adapter.snapshot(tabId, sessionId));
  const unsubscribe = adapter.subscribe(tabId, publish);
  const channels = ['agent:readiness-changed', 'codex:tui-manual-action-required', 'codex:tui-ready',
    'codex:tui-not-ready', 'codex:session-detected', 'codex:busy-state', 'terminal:command-finished',
    'terminal:command-started', 'agent:stopping-state'];
  const wake = (_event, data) => {
    if (data?.tabId === tabId && (!data.toolType || data.toolType === 'codex')) void adapter.refresh(tabId);
  };
  for (const channel of channels) ipcRenderer.on(channel, wake);
  publish();
  void adapter.refresh(tabId);
  return () => { unsubscribe(); for (const channel of channels) ipcRenderer.removeListener(channel, wake); };
}

export function projectCodexGoalLifecycle(base, goal, { onChoose, onDismiss } = {}) {
  if (!goal || base && (base.tabId !== goal.tabId || base.engine !== 'codex'
    || base.kind === 'stopping')) return base;
  // Other manual blockers (auth/usage) must retain their own explanation.
  const baseIsGoal = base?.goalOperationId === goal.operationId;
  if (base?.goalControlsBlocked || base?.goalStartupPending && !baseIsGoal
    || base && !baseIsGoal && base.kind !== 'starting') return base;
  // Operational-turn proof can handle the dialog without confirming the
  // choice. Retain its unknown request receipt, but do not resurrect the old
  // Goal banner that sessionStartingState has already cleared.
  if (goal.hidden || goal.phase === 'handled' || goal.status === 'confirmed' && goal.choiceConfirmed === true) return baseIsGoal ? null : base;
  const pendingAction = goal.pending && isChoice(goal.action) ? goal.action : null;
  const actionLabel = goal.action === 'leave-paused' ? 'Leave paused' : 'Resume Goal';
  const failed = !!goal.error || ['unknown', 'rejected', 'unavailable'].includes(goal.status);
  const description = failed ? `Не удалось завершить ${actionLabel}`
    : pendingAction ? '' : 'Выберите действие';
  return { tabId: goal.tabId, engine: 'codex', sessionId: goal.owner?.sessionId || null,
    kind: failed ? 'error' : 'info', title: 'CODEX GOAL', description, spinner: false,
    detail: [goal.error || goal.reason, goal.requestId && `Request ${goal.requestId}`,
      goal.recoveryAvailable ? 'Main подтвердил новое меню Goal; доступен новый явный выбор.' : null,
      failed ? 'Нет результата выбора от Codex. Повторная клавиша автоматически не отправляется; сообщение не переотправлено.' : null,
      'Resume Goal продолжает цель; Leave paused оставляет её на паузе. Сообщение повторно не отправляется.'].filter(Boolean).join('\n'),
    goalOperationId: goal.operationId,
    goalActions: { operationId: goal.operationId, availableActions: goal.availableActions,
      pendingAction, onChoose },
    dismissLabel: 'Скрыть сообщение', onDismiss };
}
