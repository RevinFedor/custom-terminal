import contract from '../../shared/run-after-api.cjs';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { runAfterTargetInventory, automationInventory, selectRunAfterOverview, queueIsConfigured } from './runAfterInventory.mjs';
import { autoCompactIncludesTarget, UNPLACED_AUTOMATION_WORKFLOW } from './autoCompactPolicy.mjs';
import { collectQueueRelations } from './runAfterDependencyLayout.mjs';
const { runAfterError: error, validateRunAfterEnvelope, AUTO_COMPACT_OPS } = contract;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bool = value => { if (typeof value !== 'boolean') throw error('run_after_boolean_required', 400); return value; };
const string = value => { if (typeof value !== 'string') throw error('run_after_text_required', 400); return value; };

// A projection/command adapter around the existing owners supplied by App.
// It has no provider scheduler, timers, background worker or second queue.
export function createRunAfterRemote(ports) {
  const versions = new Map(); let epoch = null;
  const queue = () => ports.queue.getState();
  const auto = () => ports.autoCompact.getState();
  function currentEpoch() {
    const next = ports.epoch();
    if (!next || !ports.hydrated() || ports.workspace().isRestoring) throw error('run_after_unavailable', 503);
    if (next !== epoch) { epoch = next; versions.clear(); }
    return next;
  }
  function owner(tabId) {
    for (const [projectId, workspace] of ports.workspace().openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const provider = resolvePtyAgentOwner(tab);
      if (tab.tabType === 'file' || tab.tabType === 'claude-sdk') throw error('run_after_ineligible', 422);
      if (!provider) throw error(tab.claudeSessionId || tab.codexSessionId ? 'run_after_owner_unknown' : 'run_after_ineligible',
        tab.claudeSessionId || tab.codexSessionId ? 503 : 422);
      return { tabId, projectId, provider,
        // Configuration identity, NOT a writer proof. Execution still belongs
        // to the common scenario/Main; quick auto-arm requests that proof.
        configuredSessionId: (provider === 'codex' ? tab.codexSessionId : tab.claudeSessionId) || null };
    }
    throw error('run_after_tab_missing', 404);
  }
  function version(key, scope, value) {
    currentEpoch(); const fingerprint = JSON.stringify(value), before = versions.get(key);
    if (!before || before.fingerprint !== fingerprint) versions.set(key, { fingerprint, revision: (before?.revision || 0) + 1 });
    return { epoch, revision: versions.get(key).revision, scopeKey: JSON.stringify(scope) };
  }
  function read(tabId) {
    const scope = owner(tabId), q = queue().getQueue(tabId), core = ports.core(q), actualLock = ports.editorLock(tabId);
    const lock = actualLock?.token.startsWith('remote-run-after:operation:') ? null : actualLock;
    const order = q.items.map(item => item.id);
    const guard = { ...version(tabId, scope, { scope, core, lock, startedAt: q.firstDelayCountdownAt,
      workflowArmedAt: q.workflowArmedAt, workflowRestartPending: q.workflowRestartPending,
      loopPromptArmedAt: q.loopPromptArmedAt, loopRestartPending: q.loopRestartPending }), order };
    const now = ports.now?.() ?? Date.now();
    const countdown = ports.countdown(q, now);
    const runtime = ports.runtimeState(tabId);
    const viewRevision = version(tabId + ':view', scope, { guard, runtime }).revision;
    return { tabId, queue: clone(core), aiTabs: runAfterTargetInventory(ports.workspace(), ports.projects(), tabId),
      runAfter: { version: 1, known: true, ...guard, guard: clone(guard), scope,
        viewRevision,
        editor: lock ? { ...lock, source: lock.token.startsWith('remote-run-after:') ? 'remote' : 'desktop' } : null,
        countdown, runtime,
        restart: { workflowPending: q.workflowRestartPending, loopPending: q.loopRestartPending },
      } };
  }
  function policyRead() {
    if (!auto().hydrated) throw error('run_after_policy_unavailable', 503);
    const scope = { kind: 'auto-compact' }, policy = clone(auto().policy);
    const guard = version('@auto-compact', scope, policy);
    const activities = clone(auto().activities), workflows = automationInventory(ports.workspace(), ports.projects()).groups
      .map(group => ({ id: group.id, name: group.name, icon: group.icon, projectIds: group.projectIds }));
    const viewRevision = version('@auto-compact:view', scope, { guard, activities, workflows }).revision;
    return { version: 1, known: true, ...guard, guard: clone(guard), policy, activities, workflows, viewRevision,
      defaultWorkflowId: ports.workspace().activeSpaceId || null };
  }
  function overview() {
    const inventory = automationInventory(ports.workspace(), ports.projects());
    const state = queue(), graph = selectRunAfterOverview(inventory, state.queues, { hasPending: ports.hasPending });
    const nodes = graph.visible.map(tab => {
      const q = state.getQueue(tab.id);
      const { projectIcon: _icon, ...label } = tab;
      const active = ports.hasPending(q);
      return { ...label, kind: active ? 'active' : queueIsConfigured(q) ? 'staged' : 'dependency',
        section: graph.primary.has(tab.id) ? 'active' : 'staged', awaited: graph.awaitedTargets.has(tab.id),
        hasPendingContinuation: active,
        autoRun: q.autoRun, loop: ports.loopActive(q), enabledCount: q.items.filter(item => item.enabled !== false).length,
        itemCount: q.items.length, runtime: ports.runtimeState(tab.id),
        appliedAutoCompact: auto().hydrated ? autoCompactIncludesTarget(auto().policy, { ...tab, tabId: tab.id }) : null };
    });
    const dependencies = graph.visible.flatMap(tab => collectQueueRelations(tab.id, state.getQueue(tab.id)));
    const targetIds = new Set(dependencies.map(edge => edge.target));
    const dependencyTargets = runAfterTargetInventory(ports.workspace(), ports.projects(), '').filter(tab => targetIds.has(tab.id));
    const knownTargets = new Set(dependencyTargets.map(tab => tab.id));
    const data = { nodes, dependencies, dependencyTargets, missingDependencyIds: [...targetIds].filter(id => !knownTargets.has(id)),
      stagedTabIds: [...graph.disabled], workflows: inventory.groups.map(group => ({ id: group.id, name: group.name, icon: group.icon })) };
    return { version: 1, known: true, ...version('@overview', { kind: 'overview' }, data), ...data };
  }
  function check(tabId, expected) {
    const current = read(tabId), guard = current.runAfter.guard;
    if (expected.epoch !== guard.epoch || expected.revision !== guard.revision || expected.scopeKey !== guard.scopeKey
      || !same(expected.order, guard.order)) throw error('run_after_snapshot_conflict');
    return current;
  }
  function item(q, id) {
    const result = q.items.find(row => row.id === id);
    if (!result) throw error('run_after_item_missing');
    return result;
  }
  const snapshotKey = tabId => JSON.stringify({ scope: owner(tabId), queue: ports.core(queue().getQueue(tabId)),
    startedAt: queue().getQueue(tabId).firstDelayCountdownAt });
  async function mutate(tabId, input, ticket) {
    const envelope = validateRunAfterEnvelope(input), initial = check(tabId, envelope.expected);
    const initialKey = snapshotKey(tabId), scope = initial.runAfter.scope, q = queue().getQueue(tabId);
    const a = input.args, op = input.op;
    const previousLock = ports.editorLock(tabId);
    if (envelope.editorToken && previousLock?.token !== envelope.editorToken) throw error('run_after_editor_token_mismatch');
    if (previousLock && previousLock.token !== envelope.editorToken) throw error('run_after_editor_locked', 423);
    const token = previousLock?.token || 'remote-run-after:' + (op === 'beginEdit' ? 'editor:' : 'operation:') + envelope.operationId;
    if (!ports.acquireEditor(tabId, token, typeof a.id === 'string' ? a.id : null)) throw error('run_after_editor_locked', 423);
    let keepLock = false, changed = false, sideEffectStarted = false;
    const fresh = () => {
      if (currentEpoch() !== envelope.expected.epoch || snapshotKey(tabId) !== initialKey) throw error('run_after_snapshot_conflict');
    };
    try {
      let prepared = null, action = null, armProof = null;
      if (op === 'add' || op === 'update') prepared = await ports.prepareAuthoring(a, ticket);
      if (op === 'addAction' || op === 'updateAction') action = await ports.validateAction(a.action || a, scope);
      if (op === 'replay' || op === 'sendNow') {
        const selected = item(q, a.id);
        if (selected.metaAction) throw error('run_after_action_not_replayable', 422);
        if (ports.runtimeState(tabId).pending) throw error('run_after_transfer_pending', 423);
        prepared = await ports.prepareTransfer(clone(selected), ticket);
      }
      if (op === 'quickCompact') armProof = await ports.ownerBusyProof(tabId, scope, ticket);
      let trigger = null;
      if (op === 'setTrigger') {
        const value = a.trigger;
        if (value?.kind === 'timer' && typeof value.seconds === 'number' && Number.isFinite(value.seconds) && value.seconds >= 0) trigger = value;
        else if (value?.kind === 'onTab' && initial.aiTabs.some(target => target.id === value.tabId)) trigger = value;
        else if (value?.kind === 'app-restart') trigger = { kind: 'app-restart', armedInstanceId: await ports.mainInstanceId() };
        else throw error('run_after_trigger_invalid', 400);
      }
      await ports.validateScope(ticket);
      fresh();
      const s = queue(); let result = {};
      switch (op) {
        case 'beginEdit':
          if (a.id != null) item(q, a.id);
          keepLock = true; sideEffectStarted = true; result = { editorToken: token }; break;
        case 'endEdit':
          if (!previousLock || previousLock.token !== envelope.editorToken) throw error('run_after_editor_token_mismatch');
          sideEffectStarted = true; ports.releaseEditor(tabId, token); break;
        case 'add': result = { itemId: s.addPrompt(tabId, prepared.text || '', prepared.images, prepared.imagePaths, a.title, prepared.chips) }; changed = true; break;
        case 'quickCompact': {
          const itemId = s.addPrompt(tabId, '/compact');
          const autoArmed = armProof.known === true && armProof.busy === true;
          if (autoArmed) s.setAutoRun(tabId, true);
          result = { itemId, autoArmed, ownerProof: armProof }; changed = true; break;
        }
        case 'addAction': result = { itemId: s.addMetaAction(tabId, action, a.title) }; changed = true; break;
        case 'updateAction':
          item(q, a.id); if (a.title !== undefined) string(a.title);
          if (!s.updateMetaAction(tabId, a.id, action)) throw error('run_after_item_conflict');
          if (a.title !== undefined) s.updatePrompt(tabId, a.id, { title: a.title }); changed = true; break;
        case 'update':
          if (item(q, a.id).metaAction && (a.text !== undefined || a.chips !== undefined || a.imagePaths !== undefined || a.images !== undefined)) throw error('run_after_action_authoring_invalid', 422);
          if (!s.updatePrompt(tabId, a.id, { ...prepared,
            ...(a.title !== undefined ? { title: string(a.title) } : {}),
            ...(a.titleManual !== undefined ? { titleManual: bool(a.titleManual) } : {}),
            ...(a.enabled !== undefined ? { enabled: bool(a.enabled) } : {}) })) throw error('run_after_item_conflict');
          changed = true; break;
        case 'remove': item(q, a.id); if (!s.removePrompt(tabId, a.id)) throw error('run_after_item_conflict'); changed = true; break;
        case 'clear': for (const entry of q.items) s.removePrompt(tabId, entry.id); changed = true; break;
        case 'reorder': {
          if (!Number.isInteger(a.fromIndex) || !Number.isInteger(a.toIndex)
            || a.fromIndex < 0 || a.toIndex < 0 || a.fromIndex >= q.items.length || a.toIndex >= q.items.length) throw error('run_after_order_invalid', 400);
          s.reorderPrompt(tabId, a.fromIndex, a.toIndex); changed = true; break;
        }
        case 'setAutoRun':
          if (bool(a.value) && !q.items.some(row => row.enabled !== false)) throw error('run_after_empty', 409);
          s.setAutoRun(tabId, a.value); changed = true; break;
        case 'setStopAfter': s.setStopAfter(tabId, bool(a.value)); changed = true; break;
        case 'setCloseAfter': s.setCloseAfter(tabId, bool(a.value)); changed = true; break;
        case 'setRunAfterTab':
          if (a.value !== null && !initial.aiTabs.some(target => target.id === a.value)) throw error('run_after_target_invalid', 400);
          if (!s.setRunAfterTab(tabId, a.value)) throw error('run_after_dependency_cycle'); changed = true; break;
        case 'setTrigger': {
          item(q, a.id); s.setPromptTrigger(tabId, a.id, trigger);
          if (ports.armForTrigger({ trigger, isHead: q.items.find(row => row.enabled !== false)?.id === a.id })) s.setAutoRun(tabId, true);
          changed = true; break;
        }
        case 'clearTrigger':
          item(q, a.id); s.clearPromptTrigger(tabId, a.id);
          changed = true; break;
        case 'setCondition':
          item(q, a.id);
          if (a.value !== null && (!['gte', 'lte'].includes(a.operator) || typeof a.value !== 'number' || !Number.isFinite(a.value))) throw error('run_after_condition_invalid', 400);
          s.setPromptCondition(tabId, a.id, a.value === null ? null : { kind: 'context-used', operator: a.operator, percent: a.value }); changed = true; break;
        case 'setFirstDelaySeconds':
          if (typeof a.value !== 'number' || !Number.isFinite(a.value) || a.value < 0) throw error('run_after_delay_invalid', 400);
          s.setFirstDelaySeconds(tabId, a.value); changed = true; break;
        case 'setPostPromptEnabled': s.setPostPromptEnabled(tabId, bool(a.value)); changed = true; break;
        case 'setPostPromptText': s.setPostPromptText(tabId, string(a.value)); changed = true; break;
        case 'setLoopPromptEnabled': s.setLoopPromptEnabled(tabId, bool(a.value)); changed = true; break;
        case 'setLoopPromptText': {
          // The shared body is a canonical System Prompt, not a second queue
          // preference. Commit it with the receipt first; the existing prompt
          // changed event projects/rearms every Loop only after that commit.
          const text = string(a.value); sideEffectStarted = true;
          return await ports.commit(ticket, { sharedLoopPromptText: text, publication: 'system-prompt-event' },
            { loopPromptText: text });
        }
        case 'replay':
          result = { draft: prepared, draftMode: 'append', submitted: false };
          if (!s.removePrompt(tabId, a.id)) throw error('run_after_item_conflict'); changed = true; break;
        case 'sendNow': {
          sideEffectStarted = true;
          result = { send: await ports.sendNow(tabId, prepared, scope, ticket) };
          if (result.send?.submitted === true && ports.transferred(result.send)) {
            if (!s.removePrompt(tabId, a.id, { expected: item(q, a.id) })) throw error('run_after_item_conflict_after_send'); changed = true;
          }
          break;
        }
        default: throw error('run_after_op_unsupported', 400);
      }
      const snapshot = read(tabId);
      const receipt = await ports.commit(ticket, { ...result, applied: snapshot.runAfter }, changed ? ports.queuePersistence(false) : null,
        op === 'replay');
      if (receipt?.committed !== true) throw error('run_after_persistence_unknown', 503);
      if (!keepLock && !previousLock) ports.releaseEditor(tabId, token);
      return { ...receipt, current: read(tabId) };
    } catch (reason) {
      if (changed || sideEffectStarted) reason.mutationMayHaveApplied = true;
      throw reason;
    } finally {
      if (!keepLock && !previousLock) ports.releaseEditor(tabId, token);
    }
  }
  async function mutatePolicy(input, ticket) {
    const envelope = validateRunAfterEnvelope(input, AUTO_COMPACT_OPS), before = policyRead();
    if (envelope.expected.epoch !== before.guard.epoch || envelope.expected.revision !== before.guard.revision
      || envelope.expected.scopeKey !== before.guard.scopeKey) throw error('run_after_policy_conflict');
    await ports.validateScope(ticket);
    const freshPolicy = policyRead();
    if (freshPolicy.guard.epoch !== before.guard.epoch || freshPolicy.guard.revision !== before.guard.revision
      || freshPolicy.guard.scopeKey !== before.guard.scopeKey) throw error('run_after_policy_conflict');
    if (['requestNow', 'cancel'].includes(input.op)) check(input.args.tabId, input.args.targetGuard || {});
    const a = input.args; let result = {}, changed = false, sideEffectStarted = false;
    try { switch (input.op) {
      case 'updatePolicy': {
        const patch = a.patch;
        if (!patch || Object.keys(patch).some(key => !['enabled', 'percent', 'scopeInitialized', 'allWorkflows', 'workflowIds', 'includeUnplaced'].includes(key))) throw error('run_after_policy_invalid', 400);
        for (const key of ['enabled', 'scopeInitialized', 'allWorkflows', 'includeUnplaced']) if (key in patch) bool(patch[key]);
        if ('percent' in patch && (typeof patch.percent !== 'number' || !Number.isFinite(patch.percent) || patch.percent < 1 || patch.percent > 100)) throw error('run_after_policy_invalid', 400);
        if ('workflowIds' in patch && (!Array.isArray(patch.workflowIds) || patch.workflowIds.some(id => id === UNPLACED_AUTOMATION_WORKFLOW
          || !before.workflows.some(group => group.id === id)))) throw error('run_after_workflow_missing');
        const next = { ...before.policy, ...patch };
        if (next.enabled && (!next.scopeInitialized || !next.allWorkflows && !next.includeUnplaced && next.workflowIds.length === 0)) throw error('run_after_policy_scope_required', 400);
        auto().updatePolicy(patch); changed = true; break;
      }
      case 'setExcluded': owner(a.tabId); auto().setExcluded(a.tabId, bool(a.excluded)); changed = true; break;
      case 'cancel':
        owner(a.tabId);
        if (typeof a.activityId !== 'string' || !a.activityId || auto().activities[a.tabId]?.handoffId !== a.activityId) throw error('run_after_activity_changed');
        sideEffectStarted = true; result = { cancelled: ports.cancelAutoCompact(a.tabId) }; break;
      case 'requestNow': {
        owner(a.tabId); const resume = a.resume === undefined ? false : bool(a.resume);
        sideEffectStarted = true; result = { outcome: await ports.requestAutoCompact(a.tabId, resume) }; break;
      }
      default: throw error('run_after_op_unsupported', 400);
    }
    const current = policyRead();
    const receipt = await ports.commit(ticket, { ...result, applied: current }, changed ? { globalAutoCompact: ports.policyPersistence() } : null);
    return { ...receipt, current: policyRead() };
    } catch (reason) {
      if (changed || sideEffectStarted) reason.mutationMayHaveApplied = true;
      throw reason;
    }
  }
  return { read, overview, policyRead, mutate, mutatePolicy };
}
