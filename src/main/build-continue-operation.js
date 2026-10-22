'use strict';

// One explicit restart operation. Runtime, provider input, run continuation and
// message delivery retain their existing owners; this journal never replays them.
const crypto = require('node:crypto');
const { canSubmitContinuationInput } = require('./orchestration-continuation-input');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(Error(code), { code,
  statusCode: /persistence|journal|write_unconfirmed/.test(code) ? 503 : 409 });
const END = new Set(['confirmed', 'already-working', 'result-ready', 'superseded', 'paused', 'unresolved']);
const sameTurn = (a, b) => !!a?.turnId && a.turnId === b?.turnId && a.sessionId === b.sessionId && a.provider === b.provider;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{7,119}$/.test(value);

function restartReceiptBinding(operation, target, record, queued, prepared) {
  const audit = record?.auditIdentity;
  if (record?.state !== 'confirmed' || record.tabId !== target.source.tabId || record.provider !== target.source.provider
    || record.handoffId !== target.handoffId || record.operationKey !== target.operationKey || !record.attemptId
    || audit?.attemptId !== record.attemptId || audit.provider !== record.provider
    || audit.sessionId !== record.sessionId || audit.promptHash !== record.promptHash
    || (!audit.entryUuid && !audit.sourceIdentity) || record.receipt?.exactAuditConfirmed !== true
    || record.receipt?.actualHash !== record.promptHash || Date.parse(audit.auditTimestamp) < operation.capturedAt) return null;
  let request; try { request = JSON.parse(queued?.request_json); } catch { return null; }
  const expectedSource = target.route.kind === 'agent' ? 'orchestration-continue:' + target.route.runId : 'build-install-continue:' + operation.id;
  if (!request || queued.operation_key !== record.operationKey || queued.tab_id !== target.source.tabId
    || queued.request_hash !== fingerprintAgentSendRequest(request) || request.tabId !== record.tabId
    || request.handoffId !== record.handoffId || request.source !== expectedSource || request.provider !== record.provider
    || request.expectedTarget?.sessionId !== target.source.sessionId || request.expectedTarget?.toolType !== record.provider) return null;
  if (request.prompt !== 'continue') {
    if (!prepared || prepared.tab_id !== record.tabId || prepared.handoff_id !== record.handoffId
      || !['preparing', 'delivered'].includes(prepared.status) || prepared.base_hash !== hash('continue')
      || prepared.prepared_prompt !== request.prompt || prepared.payload_hash !== promptAuditFingerprint(request.prompt)) return null;
  }
  if (promptAuditFingerprint(request.prompt) !== record.promptHash || !Number.isFinite(Date.parse(audit.auditTimestamp))) return null;
  return { operationId: operation.id, tabId: record.tabId, provider: record.provider,
    fromSessionId: target.source.sessionId, sessionId: record.sessionId, operationKey: record.operationKey,
    handoffId: record.handoffId, attemptId: record.attemptId, promptHash: record.promptHash,
    requestFingerprint: queued.request_hash, logicalHash: hash('continue'), transportHash: hash(request.prompt),
    userUuid: audit.entryUuid || null, sourceIdentity: audit.sourceIdentity || null,
    executionContext: record.receipt.auditExecutionContext || null, auditTimestamp: audit.auditTimestamp };
}

function createBuildContinueOperations({ read, write, readRuns, captureTabs, readMessages = () => [],
  readMcp = () => ({ known: false }), readStartup, readState, readOriginal, readLatest,
  readCaptureSubject = async view => view.subject, readInputInterval = async () => ({ known: false }), readMessage = () => null,
  readCallbackExecution = async record => record.receipt?.auditExecutionContext || null,
  readInputFence = null,
  readLoopCause = () => null,
  send, continueRun, reconcileRunContinuation = async () => {}, getRun, readReceipt, readQueued, readPrepared = () => null,
  captureOne = null, changed = () => {}, now = Date.now, pid = process.pid, instanceId }) {
  let saved, poisoned = false, disposed = false;
  const inflight = new Map(), trailing = new Set();
  let captureWork = null, captureId = null;
  const capturingTargets = new Set();
  function load() {
    if (disposed || poisoned) throw failure('build_continue_persistence_unavailable');
    if (!saved) {
      let value;
      try { value = read(); } catch (error) { throw failure('build_continue_journal_unavailable'); }
      if (value != null && (value.version !== 1 || !Array.isArray(value.operations)
        || !value.operations.every(op => op.version === 1 && validId(op.id) && Number.isInteger(op.sourceMainPid)
          && Number.isFinite(op.capturedAt) && Array.isArray(op.targets) && Array.isArray(op.participants)
          && Array.isArray(op.references?.runs) && Array.isArray(op.references?.messages)))) throw failure('build_continue_journal_invalid');
      saved = copy(value || { version: 1, operations: [] });
    }
    return saved;
  }
  const find = id => load().operations.find(op => op.id === id);
  function commit(operation) {
    const value = copy(load()), index = value.operations.findIndex(op => op.id === operation.id);
    if (index < 0) value.operations.push(copy(operation)); else value.operations[index] = copy(operation);
    try {
      const ack = write(value);
      if (ack === false || ack?.success === false || ack?.then) throw failure('build_continue_write_unconfirmed');
    } catch (error) { poisoned = true; throw error; }
    saved = value; changed(copy(operation)); return find(operation.id);
  }
  function row(id, tabId) {
    const op = find(id), target = op?.targets.find(t => t.source.tabId === tabId);
    if (!op || !target) throw failure('build_continue_target_unknown');
    return { op, target };
  }
  async function captureOnce(id, expectedMainPid) {
    if (!validId(id) || Number(expectedMainPid) !== pid) throw failure('build_continue_source_changed');
    const existing = find(id);
    if (existing) {
      if (existing.sourceMainPid !== pid || existing.sourceInstanceId !== instanceId) throw failure('build_continue_source_changed');
      return copy(existing);
    }
    const pending = load().operations.find(op => op.phase !== 'settled');
    if (pending) throw Object.assign(failure('build_continue_operation_pending'), { operationId: pending.id });
    // Freeze existing Main facts before any asynchronous authority checks.
    const views = copy(captureTabs()), capturedAt = now();
    for (const view of views) if (view.busy === true) capturingTargets.add(view.tabId);
    let timer;
    const [runs, subjects] = await Promise.race([Promise.all([Promise.resolve().then(readRuns),
      Promise.all(views.map(view => view.busy === true ? readCaptureSubject(view) : null))]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('build_continue_capture_deadline')), 5000);
    })]).finally(() => clearTimeout(timer));
    const messages = readMessages();
    let mcp;
    try { const value = readMcp(); mcp = value?.then ? { known: false, error: 'async_mcp_status_unavailable' } : value; }
    catch (error) { mcp = { known: false, error: String(error.code || error.message) }; }
    const op = { version: 1, id, phase: 'captured', capturedAt, sourceMainPid: pid,
      sourceInstanceId: instanceId, participants: [], targets: [], unresolved: [],
      references: { runs: runs.map(run => ({ runId: run.runId, runKind: run.runKind || 'agent', status: run.status,
        sourceTabId: run.sourceTabId, targetTabId: run.targetTabId, targetExecutionContext: run.targetExecutionContext || null,
        parentRunId: run.parentRunId || null,
        sourceSendTarget: run.sourceSendTarget || null, sourceSessionId: run.sourceSessionId || run.sourceExecutionContext?.sessionId || null,
        createdAt: run.createdAt || null,
        observationTarget: run.observationTarget || null, observationCurrentTurnSubject: run.observationCurrentTurnSubject || null,
        waitForDescendants: run.waitForDescendants !== false,
        externalResearchJobId: run.externalResearchJobId || null, notificationHandoffId: run.notificationHandoffId || null })),
      messages: copy(messages), mcp: copy(mcp) } };
    const seen = new Set();
    for (const [viewIndex, capturedView] of views.entries()) {
      const view = { ...capturedView, subject: subjects[viewIndex] || null };
      if (!view?.tabId || seen.has(view.tabId)) throw failure('build_continue_catalog_ambiguous');
      seen.add(view.tabId);
      const source = { tabId: view.tabId, provider: view.toolType || null, sessionId: view.sessionId || null,
        projectId: view.projectId || null, cwd: view.cwd || null, name: view.name || view.tabId };
      const participant = { source, busy: view.busy === true ? true : view.busy === false ? false : null,
        revision: view.revision, subject: view.subject || null };
      op.participants.push(participant);
      if (view.busy !== true) continue;
      if (view.known !== true || !['claude', 'codex'].includes(source.provider) || !source.sessionId
        || !view.subject || !sameTurn(view.subject.targetExecutionContext, view.executionContext)) {
        op.unresolved.push({ tabId: view.tabId, reason: 'own-turn-proof-unavailable' }); continue;
      }
      const incoming = runs.filter(run => (!run.runKind || run.runKind === 'agent') && run.targetTabId === view.tabId
        && !['completed', 'failed', 'cancelled'].includes(run.status)
        && sameTurn(run.targetExecutionContext, view.executionContext));
      if (incoming.length > 1) { op.unresolved.push({ tabId: view.tabId, reason: 'multiple-own-run-owners' }); continue; }
      const suffix = hash(view.tabId).slice(0, 24), handoffId = 'build-continue:' + id + ':' + suffix;
      op.targets.push({ source, subject: copy(view.subject), capturedRevision: view.revision,
        route: incoming.length ? { kind: 'agent', runId: incoming[0].runId } : { kind: 'local' },
        handoffId, operationKey: 'history:' + view.tabId + ':' + handoffId, state: 'pending' });
    }
    return copy(commit(op));
  }
  function capture(id, expectedMainPid) {
    if (!validId(id) || Number(expectedMainPid) !== pid) return Promise.reject(failure('build_continue_source_changed'));
    if (captureWork) return captureId === id ? captureWork : Promise.reject(
      Object.assign(failure('build_continue_operation_pending'), { operationId: captureId }));
    captureId = id;
    captureWork = captureOnce(id, expectedMainPid).finally(() => {
      captureWork = null; captureId = null; capturingTargets.clear();
    });
    return captureWork;
  }
  function startupProof(op) {
    if (op.startupProof) return;
    const snapshot = readStartup();
    if (snapshot?.source !== 'exact-shutdown-snapshot' || snapshot.shutdownPid !== op.sourceMainPid
      || snapshot.capturedAt < op.capturedAt || !Array.isArray(snapshot.targets)) throw failure('build_continue_shutdown_unproven');
    for (const target of op.targets) {
      if (!snapshot.targets.some(t => t.tabId === target.source.tabId && t.provider === target.source.provider
        && t.sessionId === target.source.sessionId)) {
        target.state = 'unresolved'; target.reason = 'not-in-exact-shutdown';
      }
    }
    op.startupProof = copy(snapshot);
  }
  const party = (state, source) => state?.known === true && state.exists !== false && state.toolType === source.provider
    && (state.sessionId === source.sessionId || state.acceptedResumeSourceSessionId === source.sessionId)
    && (!source.cwd || !state.cwd || require('node:path').resolve(source.cwd) === require('node:path').resolve(state.cwd));
  function inputFence(op, target) {
    if (!readInputFence) return true;
    const current = readInputFence(target.source.tabId), old = target.inputFence;
    if (!current) return !old || old.mainPid !== pid;
    if (!current.terminalInstanceId || !Number.isSafeInteger(current.stopRevision)) return false;
    if (old?.mainPid === pid) return old.terminalInstanceId === current.terminalInstanceId && old.stopRevision === current.stopRevision;
    if (current.stopRevision !== 0) return false; // Stop after boot precedes admission.
    saveTarget(op.id, target.source.tabId, { inputFence: { ...current, mainPid: pid } });
    return true;
  }
  async function callbackProof(op, target, key, handoffId, source, state) {
    const record = readReceipt(key), audit = record?.auditIdentity, queued = readQueued(key);
    if (record?.state !== 'confirmed' || record.tabId !== target.source.tabId || record.provider !== target.source.provider
      || record.operationKey !== key || record.handoffId !== handoffId || !record.attemptId
      || audit?.attemptId !== record.attemptId || audit.provider !== record.provider || audit.sessionId !== record.sessionId
      || audit.promptHash !== record.promptHash || !audit.entryUuid && !audit.sourceIdentity
      || record.receipt?.exactAuditConfirmed !== true || record.receipt.actualHash !== record.promptHash
      || !Number.isFinite(Date.parse(audit.auditTimestamp)) || Date.parse(audit.auditTimestamp) < op.capturedAt) return null;
    let request; try { request = JSON.parse(queued?.request_json); } catch { return null; }
    if (queued?.operation_key !== key || queued.tab_id !== record.tabId
      || queued.request_hash !== fingerprintAgentSendRequest(request) || request.tabId !== record.tabId
      || request.handoffId !== handoffId || request.source !== source || request.provider !== record.provider
      || request.expectedTarget?.sessionId !== target.source.sessionId
      || request.expectedTarget?.toolType !== target.source.provider || promptAuditFingerprint(request.prompt) !== record.promptHash
      || ![target.source.sessionId, state.sessionId].includes(record.sessionId)) return null;
    const context = await readCallbackExecution(record, request);
    return { operationKey: key, handoffId, attemptId: record.attemptId, userUuid: audit.entryUuid,
      sourceIdentity: audit.sourceIdentity, sessionId: record.sessionId, executionContext: context,
      auditTimestamp: audit.auditTimestamp,
      payloadHash: require('./claude-prompt-carriers').promptFingerprint(request.prompt), requestFingerprint: queued.request_hash };
  }
  async function restartHistory(op, target, state, original, latest) {
    const latestContext = latest?.subject?.targetExecutionContext || latest?.result?.executionContext;
    const interval = await readInputInterval(target, state, original, latest);
    if (interval?.known !== true || interval.complete !== true || !interval.users?.length) return { covered: false, unknown: true,
      reason: interval?.reason || 'restart-input-interval-unavailable' };
    const matches = (user, proof) => user.aliases?.some(alias => alias.sessionId === proof.sessionId
      && (proof.userUuid && alias.userUuid === proof.userUuid || proof.sourceIdentity && alias.sourceIdentity === proof.sourceIdentity)
      && (!proof.payloadHash || !alias.auditHash || alias.auditHash === proof.payloadHash));
    if (!matches(interval.users[0], { sessionId: target.source.sessionId,
      userUuid: original.userUuid, sourceIdentity: original.sourceIdentity })) return { covered: false, reason: 'restart-original-edge-changed' };
    const allowed = [];
    for (const ref of op.references.runs.filter(ref => ref.sourceTabId === target.source.tabId)) {
      const sourceSession = ref.sourceSendTarget?.sessionId || ref.sourceSessionId;
      if (sourceSession !== target.source.sessionId) continue;
      const run = await getRun(ref.runId);
      if (!run || (run.createdAt || null) !== ref.createdAt || run.sourceTabId !== ref.sourceTabId
        || (run.externalResearchJobId || null) !== ref.externalResearchJobId
        || run.notifySource === false || run.notificationSuppressed || run.notificationCancelRequestedAt) continue;
      const handoffId = 'orchestration-complete:' + ref.runId, key = 'history:' + target.source.tabId + ':' + handoffId;
      const proof = await callbackProof(op, target, key, handoffId, 'orchestration-completion:' + ref.runId, state);
      if (proof) allowed.push(proof);
    }
    for (const ref of op.references.messages) {
      let message = readMessage(ref.messageId);
      if (!message || message.cancelledAt || message.requestFingerprint !== ref.requestFingerprint) continue;
      if (ref.kind === 'question' && ref.sourceTabId === target.source.tabId && ref.sourceSessionId === target.source.sessionId) {
        if (!message.replyMessageId) continue;
        message = readMessage(message.replyMessageId);
        if (!message || message.replyTo !== ref.messageId || message.kind !== 'reply' || message.cancelledAt) continue;
      } else if (ref.kind !== 'reply' || ref.targetTabId !== target.source.tabId || ref.targetSessionId !== target.source.sessionId) continue;
      if (message.targetTabId !== target.source.tabId || message.targetSessionId !== target.source.sessionId
        || message.targetProvider !== target.source.provider || message.targetProjectId !== target.source.projectId) continue;
      const proof = await callbackProof(op, target, message.operationKey, message.handoffId, 'tab-message:' + message.messageId, state);
      if (proof) allowed.push(proof);
    }
    const inputs = [];
    for (const user of interval.users.slice(1)) {
      const matchesInput = allowed.filter(proof => matches(user, proof));
      if (matchesInput.length !== 1) return { covered: false, reason: 'restart-unrelated-or-unknown-input' };
      inputs.push(matchesInput[0]);
    }
    if (target.source.provider === 'codex' && (interval.executions.length !== inputs.length + 1
      || !sameTurn(interval.executions[0], target.subject.targetExecutionContext)
      || !sameTurn(interval.executions.at(-1), latestContext)
      || interval.executions.slice(1).some((context, index) => !sameTurn(context, inputs[index].executionContext)))) {
      return { covered: false, reason: 'restart-unaccounted-execution' };
    }
    const current = row(op.id, target.source.tabId);
    if (current.op.phase !== 'restoring' || END.has(current.target.state)) return { covered: false, reason: 'restart-operation-changed' };
    const proof = { covered: true, operationId: op.id, sourceRevision: interval.sourceRevision,
      fromExecutionContext: copy(target.subject.targetExecutionContext), throughExecutionContext: latestContext || null,
      inputs, ranges: interval.ranges };
    saveTarget(op.id, target.source.tabId, { historyProof: proof });
    return proof;
  }
  async function sourceFollowupBinding({ run, parent, proof }) {
    for (const op of [...load().operations].reverse()) {
      const target = op.targets.find(target => target.route.kind === 'agent' && target.route.runId === parent.runId
        && target.source.tabId === run.sourceTabId);
      const ref = op.references.runs.find(ref => ref.runId === run.runId && ref.parentRunId === parent.runId);
      if (!target || !ref || ref.sourceTabId !== target.source.tabId || (ref.sourceSendTarget?.sessionId || ref.sourceSessionId) !== target.source.sessionId
        || (run.createdAt || null) !== ref.createdAt) continue;
      const originalParent = exactContext(parent.targetExecutionContext, target.subject.targetExecutionContext) && !END.has(target.state);
      const continuedParent = target.binding && sameTurn(parent.targetExecutionContext, target.binding.executionContext);
      if (!originalParent && !continuedParent) continue;
      const handoffId = 'orchestration-complete:' + run.runId, key = 'history:' + run.sourceTabId + ':' + handoffId;
      const native = await callbackProof(op, target, key, handoffId, 'orchestration-completion:' + run.runId, { sessionId: proof.sessionId });
      if (!native || !sameTurn(native.executionContext, proof.executionContext) || native.sessionId !== proof.sessionId
        || proof.userUuid && proof.userUuid !== native.userUuid || proof.sourceIdentity && proof.sourceIdentity !== native.sourceIdentity
        || native.executionContext?.provider !== proof.toolType) continue;
      if (continuedParent && !target.historyProof?.inputs.some(input => input.operationKey === key
        && input.attemptId === native.attemptId && input.userUuid === native.userUuid)) continue;
      return { operationId: op.id, context: native.executionContext, preserveParent: true };
    }
    return null;
  }
  async function restartHistoryForRun({ run, state, original, latest }) {
    for (const op of load().operations) {
      if (op.phase !== 'restoring') continue;
      const target = op.targets.find(target => target.route.kind === 'agent' && target.route.runId === run.runId
        && target.source.tabId === run.targetTabId && exactContext(target.subject.targetExecutionContext, run.targetExecutionContext)
        && !END.has(target.state));
      if (target && party(state, target.source)) {
        if (!inputFence(op, target)) return { required: true, covered: false, reason: 'restart-stopped-or-replaced' };
        const context = latest?.subject?.targetExecutionContext || latest?.result?.executionContext;
        if (latest?.result?.sourceVerified === true && sameTurn(context, target.subject.targetExecutionContext)) return { required: true, covered: true, operationId: op.id };
        return { required: true, ...await restartHistory(op, target, state, original, latest) };
      }
    }
    return { covered: false };
  }
  async function validate(id, tabId) {
    const { op, target } = row(id, tabId);
    if (op.phase !== 'restoring' || target.route.kind !== 'local' || END.has(target.state)) throw failure('build_continue_not_active');
    const state = await readState(tabId);
    if (!party(state, target.source)) throw failure('build_continue_owner_changed');
    if (!inputFence(op, target)) throw failure('build_continue_owner_changed');
    if (!canSubmitContinuationInput(state) || state.transitioning || state.backgroundWorkCount > 0
      || state.goalWork?.pending || ['active', 'attention', 'attention_required'].includes(state.goalWork?.status)) return false;
    const original = await readOriginal(target, state), latest = await readLatest(target, state);
    if (original?.found !== true || original.sourceVerified !== true) return false;
    if (target.source.provider === 'codex' && !sameTurn(original.executionContext, target.subject.targetExecutionContext)) return false;
    if (target.source.provider === 'claude' && target.subject.providerPromptId
      && original.userUuid !== target.subject.providerPromptId) return false;
    if (original.complete === true) return { resultReady: true };
    const latestContext = latest?.subject?.targetExecutionContext || latest?.result?.executionContext;
    if (latest?.result?.sourceVerified !== true || !sameTurn(latestContext, target.subject.targetExecutionContext)) {
      const history = await restartHistory(op, target, state, original, latest);
      if (history.covered !== true) {
        if (history.unknown) return false;
        throw failure('build_continue_newer_input');
      }
    }
    const after = await readState(tabId);
    if (!party(after, target.source) || !state.revision || after.revision !== state.revision
      || !canSubmitContinuationInput(after) || !inputFence(row(id, tabId).op, row(id, tabId).target)) return false;
    return true;
  }
  function saveTarget(id, tabId, patch) {
    const { op, target } = row(id, tabId);
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(target[key]) === JSON.stringify(value))) return op;
    Object.assign(target, copy(patch)); return commit(op);
  }
  async function reconcileTarget(id, tabId) {
    let { op, target } = row(id, tabId);
    if (END.has(target.state)) return;
    const record = readReceipt(target.operationKey);
    const binding = record && restartReceiptBinding(op, target, record, readQueued(target.operationKey), readPrepared(tabId, target.handoffId));
    if (binding) { saveTarget(id, tabId, { state: 'confirmed', binding }); return; }
    if (target.route.kind === 'agent') {
      let result;
      if (target.runIntentId) {
        await reconcileRunContinuation(target.route.runId); result = { ok: true };
      } else result = await continueRun(target.route.runId);
      const current = await getRun(target.route.runId);
      const intent = current?.continuationIntent;
      const ownsIntent = intent && intent.createdAt >= op.capturedAt
        && exactContext(intent.baseExecutionContext, target.subject.targetExecutionContext);
      if (ownsIntent) saveTarget(id, tabId, { handoffId: intent.handoffId, operationKey: intent.operationKey,
        runIntentId: intent.operationId || intent.operationKey });
      if (result.resultReady) saveTarget(id, tabId, { state: 'result-ready' });
      else if (result.alreadyActive && !ownsIntent) {
        const state = await readState(tabId);
        saveTarget(id, tabId, state?.known === true && state.busy === true
          && exactContext(state.executionContext, current?.targetExecutionContext)
          ? { state: 'already-working', reason: null } : { state: 'pending', reason: 'awaiting-original-run-recovery' });
      }
      else if (result.ok) saveTarget(id, tabId, { state: 'accepted' });
      else saveTarget(id, tabId, { state: ['continuation_paused', 'continuation_background_work'].includes(result.code) ? 'paused'
        : ['continuation_history_changed', 'continuation_request_closed', 'continuation_cancelled', 'continuation_not_agent'].includes(result.code)
          ? 'superseded' : 'pending', reason: result.code || 'run-continuation-pending' });
      // The run owner owns its one H/O/attempt and final-to-original-source.
      ({ op, target } = row(id, tabId));
      const settled = readReceipt(target.operationKey);
      const proof = settled && restartReceiptBinding(op, target, settled, readQueued(target.operationKey), readPrepared(tabId, target.handoffId));
      if (proof && ownsIntent) saveTarget(id, tabId, { state: 'confirmed', binding: proof });
      else if (ownsIntent && (settled?.deliveryControl?.cancelledAt
        || ['cancelled', 'not-submitted', 'provider-not-accepted'].includes(settled?.state))) {
        saveTarget(id, tabId, { state: 'unresolved', reason: 'continue-not-delivered' });
      }
      return;
    }
    if (['sending', 'accepted', 'unknown'].includes(target.state)) {
      if (!record) {
        if (target.state !== 'unknown') saveTarget(id, tabId, { state: 'unknown', reason: 'send-receipt-unavailable' });
        return;
      }
      if (record.deliveryControl?.cancelledAt || ['cancelled', 'not-submitted', 'provider-not-accepted'].includes(record.state)) {
        saveTarget(id, tabId, { state: 'unresolved', reason: 'continue-not-delivered' });
      }
      return; // No second sender call after a lost ACK/Enter/audit.
    }
    let admission;
    try { admission = await validate(id, tabId); }
    catch (error) { saveTarget(id, tabId, { state: ['build_continue_owner_changed', 'build_continue_newer_input', 'build_continue_not_active'].includes(error.code)
      ? 'superseded' : 'pending', reason: error.code || error.message }); return; }
    if (admission?.resultReady) { saveTarget(id, tabId, { state: 'result-ready' }); return; }
    if (admission !== true) return;
    const destination = await readState(tabId);
    saveTarget(id, tabId, { state: 'sending' }); // Commit before any input producer.
    try {
      const result = await send({ tabId, provider: target.source.provider, sessionId: target.source.sessionId,
        expectedTarget: { toolType: target.source.provider, sessionId: target.source.sessionId },
        cwd: target.source.cwd, prompt: 'continue', source: 'build-install-continue:' + id,
        handoffId: target.handoffId, sendOperationKey: target.operationKey, sendSurface: 'desktop-history',
        ownership: 'project', queue: false, applicationQueueAcceptedResponse: true,
        statusAtSend: destination.processStatus === 'absent' ? 'inactive' : 'active', prepareSend: async () => {
          if (await validate(id, tabId) !== true) throw failure('build_continue_admission_changed');
        } });
      saveTarget(id, tabId, { state: result?.success === false && result?.submitted === false ? 'unresolved' : 'accepted',
        reason: result?.error || result?.status || null });
    } catch (error) { saveTarget(id, tabId, { state: 'unknown', reason: error.code || error.message }); }
  }
  async function reconcile(id) {
    if (inflight.has(id)) { trailing.add(id); return inflight.get(id); }
    const work = (async () => {
      do {
        trailing.delete(id);
        const op = find(id); if (!op || op.phase !== 'restoring') return;
        for (const target of op.targets) await reconcileTarget(id, target.source.tabId);
        const current = find(id);
        if (current.targets.every(target => END.has(target.state))) commit({ ...current, phase: 'settled', settledAt: now() });
      } while (trailing.delete(id));
    })().finally(() => inflight.delete(id));
    inflight.set(id, work); return work;
  }
  function activate(id) {
    const op = find(id);
    if (!op || op.sourceMainPid === pid) throw failure('build_continue_replacement_required');
    if (op.phase === 'captured') { startupProof(op); commit({ ...op, phase: 'restoring', activatedAt: now() }); }
    void reconcile(id).catch(() => {}); return copy(find(id));
  }
  async function admit(request) {
    const id = String(request.source || '').slice('build-install-continue:'.length);
    const { op, target } = row(id, request.tabId);
    const prepared = readPrepared(request.tabId, request.handoffId);
    if (request.handoffId !== target.handoffId || request.sendOperationKey !== target.operationKey
      || request.provider !== target.source.provider || request.expectedTarget?.sessionId !== target.source.sessionId
      || request.expectedTarget?.toolType !== target.source.provider || op.phase !== 'restoring'
      || (request.prompt !== 'continue' && (!prepared || prepared.base_hash !== hash('continue')
        || prepared.prepared_prompt !== request.prompt || prepared.payload_hash !== promptAuditFingerprint(request.prompt)))) {
      return { cancel: true, reason: 'build-continue-request-changed' };
    }
    const result = await validate(id, request.tabId);
    if (result?.resultReady) {
      saveTarget(id, request.tabId, { state: 'result-ready' });
      return { cancel: true, reason: 'build-continue-original-result-ready' };
    }
    return result;
  }
  function wake() {
    for (const op of load().operations) if (op.phase === 'restoring') void reconcile(op.id).catch(() => {});
  }
  function restore() {
    for (const op of load().operations) {
      if (op.phase === 'captured' && op.sourceMainPid !== pid) activate(op.id);
      else if (op.phase === 'restoring') void reconcile(op.id).catch(() => {});
    }
  }
  async function messageBinding({ phase, role, message, expected, live }) {
    if (!['reply', 'delivery'].includes(phase) || !expected?.sessionId || expected.tabId !== live?.tabId
      || expected.projectId !== live.projectId || expected.provider !== live.provider
      || live.sessionId === expected.sessionId) return null;
    const state = await readState(live.tabId);
    if (state?.known !== true || state.sessionId !== live.sessionId || state.toolType !== live.provider) return null;
    for (const operation of [...load().operations].reverse()) {
      if (!operation.startupProof || !operation.activatedAt) continue;
      const reference = operation.references.messages.find(ref => ref.messageId === message.messageId
        && ref.requestFingerprint === message.requestFingerprint
        && ref[role + 'TabId'] === expected.tabId && ref[role + 'SessionId'] === expected.sessionId
        && ref[role + 'ProjectId'] === expected.projectId && ref[role + 'Provider'] === expected.provider);
      if (!reference) continue;
      const participant = operation.participants.find(p => p.source.tabId === expected.tabId
        && p.source.sessionId === expected.sessionId && p.source.provider === expected.provider
        && p.source.projectId === expected.projectId);
      if (!participant) continue;
      const previous = operation.messageBindings?.find(binding => binding.messageId === message.messageId
        && binding.phase === phase && binding.role === role && binding.sessionId === live.sessionId
        && binding.fromSessionId === expected.sessionId && binding.requestFingerprint === message.requestFingerprint);
      const native = operation.targets.find(t => t.source.tabId === expected.tabId)?.binding;
      const nativeRecord = native && readReceipt(native.operationKey);
      if (nativeRecord && (nativeRecord.state !== 'confirmed' || nativeRecord.tabId !== native.tabId
        || nativeRecord.provider !== native.provider || nativeRecord.sessionId !== native.sessionId
        || nativeRecord.handoffId !== native.handoffId || nativeRecord.attemptId !== native.attemptId
        || nativeRecord.promptHash !== native.promptHash || nativeRecord.auditIdentity?.attemptId !== native.attemptId
        || nativeRecord.auditIdentity?.promptHash !== native.promptHash)) continue;
      const nativeMatches = native?.fromSessionId === expected.sessionId && native.sessionId === live.sessionId
        && native.provider === live.provider && native.tabId === live.tabId;
      if (phase === 'reply' && (message.kind !== 'question' || reference.deliveryState !== 'sent'
        || reference.deliverySessionId !== expected.sessionId || !(reference.attemptCount > 0) || !nativeMatches && !previous)) continue;
      if (phase === 'delivery' && !nativeMatches && !previous && state.acceptedResumeSourceSessionId !== expected.sessionId) continue;
      const current = captureOne?.(live.tabId);
      if (current?.known !== true || current.sessionId !== live.sessionId || current.toolType !== live.provider) return null;
      const binding = previous || { bindingId: 'restart-message:' + hash(JSON.stringify([operation.id, message.messageId,
        phase, role, expected.sessionId, live.sessionId, message.requestFingerprint])), operationId: operation.id,
        messageId: message.messageId, phase, role, fromSessionId: expected.sessionId, sessionId: live.sessionId,
        requestFingerprint: message.requestFingerprint, native: nativeMatches ? native : null };
      if (!previous) {
        operation.messageBindings ||= []; operation.messageBindings.push(copy(binding)); commit(operation);
      }
      return { ...copy(binding), isCurrent: () => {
        const actual = captureOne?.(live.tabId);
        return actual?.known === true && actual.sessionId === live.sessionId && actual.toolType === live.provider
          && actual.revision === current.revision;
      } };
    }
    return null;
  }
  const exactContext = (a, b) => sameTurn(a, b) && ['generation', 'processId'].every(key => (a[key] ?? null) === (b[key] ?? null));
  function recoveryHold(run) {
    if (run.runKind && run.runKind !== 'agent' || ['completed', 'failed', 'cancelled'].includes(run.status)
      || run.outcome === 'paused' || run.notificationSuppressed) return null;
    for (const op of load().operations) {
      if (!['captured', 'restoring'].includes(op.phase)) continue;
      const target = op.targets.find(t => t.route.kind === 'agent' && t.route.runId === run.runId
        && t.source.tabId === run.targetTabId && !END.has(t.state));
      const ref = op.references.runs.find(ref => ref.runId === run.runId && ref.runKind === 'agent');
      if (target && ref && exactContext(ref.targetExecutionContext, run.targetExecutionContext)
        && exactContext(target.subject.targetExecutionContext, run.targetExecutionContext)) return { operationId: op.id };
    }
    return null;
  }
  function staleLoopAdmission(request) {
    if (!require('./prompt-queue-source').isPromptLoopAutomationSource(request.source)) return null;
    const queued = readQueued(request.sendOperationKey), record = readReceipt(request.sendOperationKey);
    if (!queued || !record || record.attemptId || queued.state !== 'waiting'
      || !['reserved', 'preparing'].includes(record.state) || record.receipt?.submitted === true
      || record.receipt?.pasteWritten === true || record.receipt?.enterWritten === true || record.receipt?.deliveryUnknown === true
      || queued.tab_id !== request.tabId || record.tabId !== request.tabId || record.handoffId !== request.handoffId
      || queued.request_hash !== fingerprintAgentSendRequest(JSON.parse(queued.request_json))
      || queued.request_hash !== fingerprintAgentSendRequest(request)) return null;
    for (const op of load().operations) {
      if (!['captured', 'restoring'].includes(op.phase)) continue;
      const target = op.targets.find(target => target.source.tabId === request.tabId && !END.has(target.state));
      if (!target || request.provider !== target.source.provider || request.expectedTarget?.sessionId !== target.source.sessionId) continue;
      const capturedBeforeCut = queued.created_at <= op.capturedAt;
      const cause = readLoopCause(request.tabId, request.handoffId);
      const priorCallback = cause && target.historyProof?.inputs.some(input => sameTurn(cause, input.executionContext));
      // A new Loop is deferred before enqueue. An older, never-attempted cause
      // may be retired without changing any card, ON flag, native input or FIFO.
      if (capturedBeforeCut || priorCallback) return { cancel: true,
        reason: require('../shared/build-continue-automation.cjs').PREFIX + op.id };
    }
    return null;
  }
  function observationBinding(run) {
    for (const op of [...load().operations].reverse()) {
      const ref = op.references.runs.find(ref => ref.runId === run.runId && ref.runKind === 'response-observation'
        && !['completed', 'failed', 'cancelled'].includes(ref.status));
      if (!ref || ref.targetTabId !== run.targetTabId || ref.observationTarget?.sessionId !== run.observationTarget?.sessionId
        || ref.observationTarget?.toolType !== run.observationTarget?.toolType
        || ref.waitForDescendants !== (run.waitForDescendants !== false)) continue;
      const target = op.targets.find(t => t.source.tabId === run.targetTabId
        && t.source.sessionId === ref.observationTarget.sessionId && t.source.provider === ref.observationTarget.toolType);
      if (!target || ref.observationCurrentTurnSubject && !exactContext(ref.observationCurrentTurnSubject.targetExecutionContext,
        target.subject.targetExecutionContext)) continue;
      if (['result-ready', 'superseded', 'paused', 'unresolved'].includes(target.state)) return null;
      const base = { operationId: op.id, evidenceKey: 'build-continue-evidence:' + hash(JSON.stringify([run.runId, op.id])),
        originalTarget: copy(ref.observationTarget), originalSubject: copy(ref.observationCurrentTurnSubject || target.subject) };
      if (!target.binding) return { ...base, pending: true };
      const native = target.binding;
      const subject = { kind: 'transcript', toolType: native.provider, sessionId: native.sessionId,
        ...(native.userUuid ? { promptUserUuid: native.userUuid } : { promptSourceIdentity: native.sourceIdentity }) };
      return { ...base, pending: false, subject,
        target: { ...copy(ref.observationTarget), sessionId: native.sessionId, toolType: native.provider },
        provenance: { kind: 'build-continue', operationId: op.id, originalSubject: base.originalSubject,
          continuedSubject: subject, input: copy(native) } };
    }
    return null;
  }
  return { capture, activate, restore, reconcile, wake, validate, admit, messageBinding, recoveryHold, observationBinding, restartHistoryForRun, sourceFollowupBinding, staleLoopAdmission,
    get: id => { const op = find(id); return op ? copy(op) : null; },
    pending: tabId => load().operations.some(op => ['captured', 'restoring'].includes(op.phase)
      && op.targets.some(target => target.source.tabId === tabId && !END.has(target.state))) || capturingTargets.has(tabId),
    // Capture→Quit belongs to the whole old Main, including idle/late tabs.
    // Existing physical attempts keep their separate native receipts/guards.
    capturing: () => !!captureWork || load().operations.some(op => op.phase === 'captured' && op.sourceMainPid === pid),
    list: () => copy(load().operations), dispose() { disposed = true; trailing.clear(); } };
}

module.exports = { createBuildContinueOperations, restartReceiptBinding, validId };
