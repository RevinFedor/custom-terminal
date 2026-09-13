import { autoCompactIncludesTarget, autoCompactContextDecision, isAutoCompactTurnEligible } from './autoCompactPolicy.mjs';

// One event-driven coordinator, independent of every menu and window. Ports
// supply the existing runtime readiness, send scenario and exact compact proof.
export function createAutoCompactCoordinator(ports) {
  const tasks = new Map();
  const consumed = new Map();
  let sequence = 0;
  const ownerMatches = (task) => {
    const target = ports.target(task.tabId);
    if (task.expectedResumedSessionId && target?.provider === task.target.provider
      && target.sessionId === task.expectedResumedSessionId) task.target = target;
    return target?.provider === task.target.provider && target?.sessionId === task.target.sessionId;
  };
  const publish = (task, phase, message) => ports.activity(task.tabId, { phase, message });
  const finish = (task, result, release = true) => {
    if (tasks.get(task.tabId) !== task) return;
    tasks.delete(task.tabId);
    ports.trace?.('settled', { tabId: task.tabId, handoffId: task.id, ...result });
    if (result.error) {
      publish(task, 'error', result.error);
      ports.failure(task.tabId, result.error);
    } else ports.activity(task.tabId, null);
    task.resolve?.(result);
    if (release && !result.error && ownerMatches(task)) task.continue?.();
    if (release && !result.error) ports.release?.(task.tabId);
  };
  const stillAllowed = (task) => {
    const policy = ports.policy();
    return tasks.get(task.tabId) === task && ownerMatches(task) && autoCompactIncludesTarget(policy, ports.target(task.tabId))
      && (task.manual || policy.enabled && policy.armedAt === task.armedAt);
  };
  async function kick(tabId) {
    const task = tasks.get(tabId);
    if (!task) return;
    if (task.executing) { task.wakeAgain = true; return; }
    if (!stillAllowed(task)) { finish(task, { skipped: 'policy-or-owner-changed' }); return; }
    if (ports.blocked(tabId)) { publish(task, 'waiting', 'Ждём завершения действия или редактирования'); return; }
    task.executing = true;
    try {
      let readiness = await ports.readiness(tabId);
      if (!stillAllowed(task)) { finish(task, { skipped: 'policy-or-owner-changed' }); return; }
      if (!readiness.ready && readiness.status === 'inactive' && task.resume && !task.resumed) {
        task.resumed = true;
        publish(task, 'resuming', 'Запускаем выбранную сессию');
        const resumed = await ports.resume(task.target);
        task.expectedResumedSessionId = resumed?.sessionId || task.target.sessionId;
        if (!ownerMatches(task)) { finish(task, { error: 'Сессия изменилась при запуске' }, false); return; }
        readiness = await ports.readiness(tabId);
      }
      if (!readiness.ready) {
        if (readiness.status === 'inactive' && !task.resume) {
          finish(task, { skipped: 'session-stopped' }, false);
        } else publish(task, 'waiting', 'Ждём готовности сессии');
        return;
      }
      if (task.completed) {
        if (ports.blocked(tabId)) publish(task, 'waiting', 'Сжатие завершено, ждём завершения текущего действия');
        else finish(task, { completed: true });
        return;
      }
      publish(task, 'checking', 'Проверяем заполнение контекста');
      const snapshot = await ports.context(task.target);
      if (!stillAllowed(task)) { finish(task, { skipped: 'policy-or-owner-changed' }); return; }
      if (ports.blocked(tabId)) { publish(task, 'waiting', 'Ждём завершения действия или редактирования'); return; }
      const decision = autoCompactContextDecision(snapshot, {
        sessionId: task.target.sessionId, notBefore: task.notBefore, percent: ports.policy().percent,
      });
      ports.trace?.('context', { tabId, handoffId: task.id, decision, pct: snapshot?.pct ?? null,
        observedAt: snapshot?.observedAt ?? null, notBefore: task.notBefore, percent: ports.policy().percent });
      if (decision === 'wait') { publish(task, 'waiting', 'Ждём актуального процента этой сессии'); return; }
      if (decision === 'skip') { finish(task, { skipped: 'below-threshold' }); return; }
      task.submitting = true;
      publish(task, 'compacting', 'Автокомпакт выполняется');
      await ports.compact(task.target, task.id);
      // This promise resolves only on the matching main-owned operation's
      // completed outcome, never on Enter, a timeout or an idle snapshot.
      task.completed = true;
      const after = await ports.readiness(tabId);
      if (after.ready && !ports.blocked(tabId)) finish(task, { completed: true });
      else publish(task, 'waiting', 'Сжатие завершено, ждём готовности ввода');
    } catch (error) {
      finish(task, { error: String(error?.message || error) }, false);
    } finally {
      task.executing = false;
      if (task.wakeAgain && tasks.get(tabId) === task) {
        task.wakeAgain = false;
        queueMicrotask(() => { void kick(tabId); });
      }
    }
  }
  function enqueue(tabId, target, options) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const policy = ports.policy();
    const task = { tabId, target, ...options, id: `auto-compact:${tabId}:${Date.now()}:${++sequence}`,
      armedAt: policy.armedAt, executing: false, submitting: false, resolve, promise };
    tasks.set(tabId, task);
    ports.trace?.('scheduled', { tabId, handoffId: task.id, provider: target.provider,
      sessionId: target.sessionId, workflowId: target.workflowId, manual: task.manual, armedAt: task.armedAt });
    publish(task, 'waiting', 'Автокомпакт ожидает проверки');
    void kick(tabId);
    return promise;
  }
  return {
    has: (tabId) => tasks.has(tabId),
    intercept(tabId, outcome, continuation) {
      const existing = tasks.get(tabId);
      if (existing) {
        if (!existing.submitting && outcome.live && outcome.natural && !outcome.compact
          && outcome.at > (existing.outcomeAt || 0)) {
          existing.outcomeAt = outcome.at;
          existing.notBefore = outcome.turnStartedAt || 0;
          existing.continue = continuation;
          consumed.set(tabId, outcome.at);
        }
        // A manually requested compact has no earlier response to resume.
        // Keep its exact successful lifecycle as the continuation instead.
        if (!existing.continue) existing.continue = continuation;
        return true;
      }
      const target = ports.target(tabId);
      if (!isAutoCompactTurnEligible({ policy: ports.policy(), target, outcome, startedAt: ports.startedAt })) return false;
      if (consumed.get(tabId) >= outcome.at) return false;
      consumed.set(tabId, outcome.at);
      void enqueue(tabId, target, { manual: false, resume: false, outcomeAt: outcome.at,
        notBefore: outcome.turnStartedAt || 0, continue: continuation });
      return true;
    },
    request(tabId, { resume = false } = {}) {
      if (tasks.has(tabId)) return tasks.get(tabId).promise;
      const target = ports.target(tabId);
      if (!target?.sessionId || !autoCompactIncludesTarget(ports.policy(), target)) return Promise.resolve({ skipped: 'out-of-scope' });
      return enqueue(tabId, target, { manual: true, resume, notBefore: 0 });
    },
    wake: (tabId) => { void kick(tabId); },
    policyChanged: () => { for (const tabId of tasks.keys()) void kick(tabId); },
    targetsChanged() {
      // Workspace publishes keystrokes and unrelated tab changes too. Only an
      // ownership/scope change can wake this path; context/readiness have their
      // own authoritative events and must not become an IPC polling loop.
      for (const task of tasks.values()) {
        const previousSession = task.target.sessionId;
        if (!stillAllowed(task) && !task.submitting) finish(task, { skipped: 'policy-or-owner-changed' });
        else if (previousSession !== task.target.sessionId) void kick(task.tabId);
      }
    },
    cancel(tabId, release = true) {
      const task = tasks.get(tabId);
      if (task && !task.submitting) finish(task, { skipped: 'cancelled' }, release);
    },
    dispose() {
      for (const task of tasks.values()) finish(task, { skipped: 'shutdown' }, false);
    },
  };
}
