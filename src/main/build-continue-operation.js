'use strict';

// One explicit restart operation. Runtime, provider input, run continuation and
// message delivery retain their existing owners; this journal never replays them.
const crypto = require('node:crypto');
const { canSubmitContinuationInput, continuationInputTransitionPending, continuationTargetExpectation,
  continuationTargetScopeMatches, continuationInputPreparation } = require('./orchestration-continuation-input');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { voiceInstallBinding, sameVoiceInstallBinding } = require('./voice-install-binding');
const { restartPromptForView, continuationPrompt } = require('./build-continue-prompt');
const { deferSendPreparation } = require('./agent-send-preparation');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(Error(code), { code,
  statusCode: /persistence|journal|write_unconfirmed/.test(code) ? 503 : 409 });
const END = new Set(['confirmed', 'already-working', 'result-ready', 'not-needed', 'superseded', 'paused', 'unresolved', 'cancelled']);
const active = target => !END.has(target.state) && !target.cancellation?.requestedAt;
const sameTurn = (a, b) => !!a?.turnId && a.turnId === b?.turnId && a.sessionId === b.sessionId && a.provider === b.provider;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{7,119}$/.test(value);

function restartReceiptBinding(operation, target, record, queued, prepared) {
  const logical = continuationPrompt(target);
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
  if (request.prompt !== logical) {
    if (!prepared || prepared.tab_id !== record.tabId || prepared.handoff_id !== record.handoffId
      || !['preparing', 'delivered'].includes(prepared.status) || prepared.base_hash !== hash(logical)
      || prepared.prepared_prompt !== request.prompt || prepared.payload_hash !== promptAuditFingerprint(request.prompt)) return null;
  }
  if (promptAuditFingerprint(request.prompt) !== record.promptHash || !Number.isFinite(Date.parse(audit.auditTimestamp))) return null;
  return { operationId: operation.id, tabId: record.tabId, provider: record.provider,
    fromSessionId: target.source.sessionId, sessionId: record.sessionId, operationKey: record.operationKey,
    handoffId: record.handoffId, attemptId: record.attemptId, promptHash: record.promptHash,
    requestFingerprint: queued.request_hash, logicalHash: hash(logical), transportHash: hash(request.prompt),
    userUuid: audit.entryUuid || null, sourceIdentity: audit.sourceIdentity || null,
    executionContext: record.receipt.auditExecutionContext || null, auditTimestamp: audit.auditTimestamp };
}

function createBuildContinueOperations({ read, write, readRuns, captureTabs, readMessages = () => [],
  readMcp = () => ({ known: false }), readStartup, readState, readOriginal, readLatest,
  readCaptureSubject = async view => view.subject, readInputInterval = async () => ({ known: false }), readMessage = () => null,
  readCallbackExecution = async record => record.receipt?.auditExecutionContext || null,
  readInputFence = null,
  readLaterInput = async () => ({ proven: false, reason: 'later_input_reader_unavailable' }),
  cancelInput = target => !readReceipt(target.operationKey) && !readQueued(target.operationKey), released = () => {},
  readLoopCause = () => null,
  readInputBlockers = () => [],
  verifyInstallJob = async () => { throw failure('voice_install_owner_unavailable'); },
  readInstallCallback = async () => null, adoptInstallCallback = async () => false,
  prepareReturns = async () => ({ ready: true }), cancelQueued = () => false,
  send, continueRun, reconcileRunContinuation = async () => {}, getRun, readReceipt, readQueued, readPrepared = () => null,
  captureOne = null, changed = () => {}, now = Date.now, pid = process.pid, instanceId }) {
  let saved, poisoned = false, disposed = false;
  const inflight = new Map(), trailing = new Set(), validationWaitReasons = new Map();
  let captureWork = null, captureId = null;
  const capturingTargets = new Set();
  function load() {
    if (disposed || poisoned) throw failure('build_continue_persistence_unavailable');
    if (!saved) {
      let value;
      try { value = read(); } catch (error) { throw failure('build_continue_journal_unavailable'); }
      if (value != null && (![1, 2, 3, 4].includes(value.version) || !Array.isArray(value.operations)
        || !value.operations.every(op => [1, 2].includes(op.version) && validId(op.id) && Number.isInteger(op.sourceMainPid)
          && (Number.isFinite(op.capturedAt) || op.version === 2 && Number.isFinite(op.registeredAt)
            && op.capturedAt === null && ['registered', 'settled'].includes(op.phase))
          && Array.isArray(op.targets) && Array.isArray(op.participants)
          && Array.isArray(op.references?.runs) && Array.isArray(op.references?.messages)))) throw failure('build_continue_journal_invalid');
      for (const op of value?.operations || []) if (op.version === 2) {
        if (!sameVoiceInstallBinding(op.installBinding, op.installBinding)
          || op.installBinding.operationId !== op.id) throw failure('build_continue_journal_invalid');
      }
      saved = copy(value || { version: 1, operations: [] });
    }
    return saved;
  }
  const find = id => load().operations.find(op => op.id === id);
  function commit(operation) {
    const value = copy(load()), index = value.operations.findIndex(op => op.id === operation.id);
    if (operation.version === 2) value.version = Math.max(value.version, 2); // Keep a prior cancellation envelope.
    if (operation.targets.some(target => target.cancellation?.requestedAt)) value.version = Math.max(value.version, 3);
    if (value.version > 3 || operation.targets.some(target => target.continuationPrompt)) value.version = 4;
    // Older readers must reject cancellation they cannot enforce, rather than
    // resurrect an UNKNOWN/pending target after rollback.
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
  async function registerInstall(raw) {
    const binding = voiceInstallBinding({ ...raw, sourceMainPid: pid, sourceInstanceId: instanceId });
    if (raw.sourceMainPid != null && raw.sourceMainPid !== pid || raw.sourceInstanceId != null && raw.sourceInstanceId !== instanceId) {
      throw failure('build_continue_source_changed');
    }
    const old = find(binding.operationId);
    if (old) {
      if (!sameVoiceInstallBinding(binding, old.installBinding)) throw failure('voice_install_binding_changed');
      return copy(old);
    }
    await verifyInstallJob(binding, 'register');
    if (find(binding.operationId)) return registerInstall(raw);
    return copy(commit({ version: 2, id: binding.operationId, phase: 'registered', registeredAt: now(),
      capturedAt: null, sourceMainPid: pid, sourceInstanceId: instanceId, installBinding: binding,
      participants: [], targets: [], carriedTargets: [], unresolved: [], references: { runs: [], messages: [] } }));
  }
  async function captureOnce(id, expectedMainPid, installBinding = null) {
    if (!validId(id) || Number(expectedMainPid) !== pid) throw failure('build_continue_source_changed');
    const existing = find(id);
    if (existing) {
      if (existing.sourceMainPid !== pid || existing.sourceInstanceId !== instanceId) throw failure('build_continue_source_changed');
      if (existing.version === 2 && !sameVoiceInstallBinding(installBinding, existing.installBinding)) throw failure('voice_install_binding_changed');
      if (existing.version === 2 && (existing.recoveryCancelledAt || existing.phase === 'settled')) throw failure('voice_install_cancelled');
      if (existing.phase !== 'registered') return copy(existing);
    }
    if (installBinding && (!existing || existing.phase !== 'registered')) throw failure('voice_install_registration_required');
    // A captured old Main is still an install in progress. After activation,
    // restoration can outlive the build: its per-target H/O remain independent
    // owners and must not globally prevent the user's next explicit install.
    const pending = load().operations.find(op => op.id !== id && !['settled', 'registered'].includes(op.phase)
      && (op.phase !== 'restoring' || !op.startupProof || !op.activatedAt || op.sourceMainPid === pid));
    if (pending) throw Object.assign(failure('build_continue_operation_pending'), { operationId: pending.id });
    // Freeze existing Main facts before any asynchronous authority checks.
    const views = copy(captureTabs()), capturedAt = now();
    for (const view of views) if (view.busy === true) capturingTargets.add(view.tabId);
    let timer;
    const [runs, subjects] = await Promise.race([Promise.all([Promise.resolve().then(readRuns),
      Promise.all(views.map(view => view.busy === true ? readCaptureSubject(view) : null))]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('build_continue_capture_deadline')), 5000);
    })]).finally(() => clearTimeout(timer));
    if (installBinding) {
      await verifyInstallJob(installBinding, 'capture');
      const current = find(id);
      if (current?.phase !== 'registered' || current.recoveryCancelledAt
        || !sameVoiceInstallBinding(installBinding, current.installBinding)) throw failure('voice_install_capture_revoked');
    }
    const messages = readMessages();
    const inputBlockers = installBinding ? copy(readInputBlockers()) : [];
    let mcp;
    try { const value = readMcp(); mcp = value?.then ? { known: false, error: 'async_mcp_status_unavailable' } : value; }
    catch (error) { mcp = { known: false, error: String(error.code || error.message) }; }
    const op = { version: installBinding ? 2 : 1, id, phase: 'captured', capturedAt, sourceMainPid: pid,
      ...(installBinding ? { installBinding: copy(installBinding), registeredAt: existing.registeredAt } : {}),
      sourceInstanceId: instanceId, participants: [], targets: [], carriedTargets: [], unresolved: [],
      references: { runs: runs.map(run => ({ runId: run.runId, runKind: run.runKind || 'agent', status: run.status,
        sourceTabId: run.sourceTabId, targetTabId: run.targetTabId, targetExecutionContext: run.targetExecutionContext || null,
        parentRunId: run.parentRunId || null,
        sourceSendTarget: run.sourceSendTarget || null, sourceSessionId: run.sourceSessionId || run.sourceExecutionContext?.sessionId || null,
        createdAt: run.createdAt || null,
        observationTarget: run.observationTarget || null, observationCurrentTurnSubject: run.observationCurrentTurnSubject || null,
        waitForDescendants: run.waitForDescendants !== false,
        externalResearchJobId: run.externalResearchJobId || null, notificationHandoffId: run.notificationHandoffId || null })),
      messages: copy(messages), mcp: copy(mcp), ...(installBinding ? { input: inputBlockers } : {}) } };
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
      const callbackSource = installBinding?.source;
      if (callbackSource?.tabId === view.tabId) {
        if (source.sessionId !== callbackSource.sessionId || source.provider !== callbackSource.toolType
          || source.projectId !== callbackSource.projectId) throw failure('voice_install_callback_source_changed');
        const incoming = runs.filter(run => view.busy === true && view.subject
          && (!run.runKind || run.runKind === 'agent') && run.targetTabId === view.tabId
          && !['completed', 'failed', 'cancelled'].includes(run.status)
          && sameTurn(run.targetExecutionContext, view.executionContext));
        if (incoming.length > 1) throw failure('voice_install_callback_run_ambiguous');
        const ownedIncoming = incoming.filter(run => exactContext(run.targetExecutionContext, view.executionContext));
        if (incoming.length && !ownedIncoming.length) op.unresolved.push({ tabId: view.tabId,
          runId: incoming[0].runId, reason: 'incoming-generation-unproven' });
        op.targets.push({ source, subject: copy(view.subject), capturedRevision: view.revision,
          route: { kind: 'install-callback', ...(ownedIncoming.length ? { runId: ownedIncoming[0].runId } : {}) },
          handoffId: installBinding.callbackHandoffId,
          operationKey: 'project:' + source.tabId + ':' + installBinding.callbackHandoffId, state: 'pending' });
        continue;
      }
      if (view.busy !== true) continue;
      if (view.known !== true || !['claude', 'codex'].includes(source.provider) || !source.sessionId
        || !view.subject || !sameTurn(view.subject.targetExecutionContext, view.executionContext)) {
        op.unresolved.push({ tabId: view.tabId, reason: 'own-turn-proof-unavailable' }); continue;
      }
      const incoming = runs.filter(run => (!run.runKind || run.runKind === 'agent') && run.targetTabId === view.tabId
        && !['completed', 'failed', 'cancelled'].includes(run.status)
        && sameTurn(run.targetExecutionContext, view.executionContext));
      if (incoming.length > 1) { op.unresolved.push({ tabId: view.tabId, reason: 'multiple-own-run-owners' }); continue; }
      if (installBinding && incoming.some(run => !exactContext(run.targetExecutionContext, view.executionContext))) {
        op.unresolved.push({ tabId: view.tabId, runId: incoming[0].runId, reason: 'incoming-generation-unproven' }); continue;
      }
      const prior = load().operations.flatMap(previous => previous.phase === 'restoring'
        ? previous.targets.filter(target => target.source.tabId === source.tabId && active(target))
          .map(target => ({ operationId: previous.id, target })) : []);
      const same = prior.filter(({ target }) => target.source.provider === source.provider
        && target.source.sessionId === source.sessionId && (installBinding
          ? exactContext(target.subject?.targetExecutionContext, view.executionContext)
          : sameTurn(target.subject?.targetExecutionContext, view.executionContext)));
      if (same.length) {
        // Reference the original producer instead of creating another continue.
        // No receipt/state/binding of that older operation is rewritten.
        for (const { operationId, target } of same) op.carriedTargets.push({ operationId,
          tabId: source.tabId, handoffId: target.handoffId, operationKey: target.operationKey });
        continue;
      }
      const suffix = hash(view.tabId).slice(0, 24), handoffId = 'build-continue:' + id + ':' + suffix;
      op.targets.push({ source, subject: copy(view.subject), capturedRevision: view.revision,
        route: incoming.length ? { kind: 'agent', runId: incoming[0].runId } : { kind: 'local' },
        continuationPrompt: restartPromptForView(view), continuationPromptVersion: 1,
        nativeChildren: view.ownBackground?.known === true ? { known: true, count: view.ownBackground.agentCount,
          items: (view.ownBackground.items || []).filter(item => item.kind === 'agent').slice(0, 24),
          truncated: view.ownBackground.truncated === true } : { known: false },
        handoffId, operationKey: 'history:' + view.tabId + ':' + handoffId, state: 'pending',
        ...(prior.length ? { priorOperationIds: [...new Set(prior.map(previous => previous.operationId))] } : {}) });
      const uncertain = inputBlockers.filter(input => input.tabId === source.tabId
        && ['delivery-unknown', 'audit-pending', 'enter-armed', 'submitted-unverified', 'unconfirmed'].includes(input.status || input.state));
      if (uncertain.length) Object.assign(op.targets.at(-1), { state: 'unresolved', reason: 'existing-input-unknown',
        originalInput: uncertain.map(input => ({ operationKey: input.operationKey || null, handoffId: input.handoffId || null,
          attemptId: input.attemptId || null, status: input.status || input.state })) });
    }
    if (installBinding && !op.targets.some(target => target.route.kind === 'install-callback')) throw failure('voice_install_callback_source_missing');
    // Async subject readers cannot turn a changed namespace/input owner into the cut.
    if (installBinding && captureOne) for (const participant of op.participants) {
      const current = captureOne(participant.source.tabId);
      if (current?.known !== true || current.revision !== participant.revision) {
        const target = op.targets.find(target => target.source.tabId === participant.source.tabId);
        if (target?.route.kind === 'install-callback') throw failure('voice_install_callback_source_changed');
        if (target) { target.state = 'unresolved'; target.reason = 'capture-owner-changed'; }
      }
    }
    return copy(commit(op));
  }
  function capture(id, expectedMainPid, binding = null) {
    if (!validId(id) || Number(expectedMainPid) !== pid) return Promise.reject(failure('build_continue_source_changed'));
    if (captureWork) return captureId === id ? captureWork : Promise.reject(
      Object.assign(failure('build_continue_operation_pending'), { operationId: captureId }));
    captureId = id;
    captureWork = (async () => {
      if (binding) await verifyInstallJob(voiceInstallBinding(binding), 'capture');
      return captureOnce(id, expectedMainPid, binding);
    })().finally(() => {
      captureWork = null; captureId = null; capturingTargets.clear();
    });
    return captureWork;
  }
  function startupProof(op) {
    if (op.startupProof) return;
    const snapshot = readStartup();
    if (snapshot?.source !== 'exact-shutdown-snapshot' || snapshot.shutdownPid !== op.sourceMainPid
      || snapshot.capturedAt < op.capturedAt || !Array.isArray(snapshot.targets)) throw failure('build_continue_shutdown_unproven');
    if (op.installBinding && (!op.shutdownEvidence || !snapshot.installBindings?.some(binding =>
      binding.operationId === op.id && binding.bindingDigest === op.installBinding.bindingDigest
      && binding.evidenceDigest === digestShutdown(op.shutdownEvidence)))) throw failure('voice_install_shutdown_unproven');
    for (const target of op.targets) {
      if (target.route.kind === 'install-callback') continue;
      if (op.installBinding && active(target)) {
        const evidence = op.shutdownEvidence.targets.find(row => row.tabId === target.source.tabId);
        if (evidence?.disposition !== 'own-turn-interrupted') {
          target.state = evidence?.disposition === 'own-turn-ended' ? 'not-needed' : 'superseded';
          target.reason = evidence?.disposition || 'shutdown-own-turn-unproven';
          continue;
        }
      }
      if (!snapshot.targets.some(t => t.tabId === target.source.tabId && t.provider === target.source.provider
        && t.sessionId === target.source.sessionId)) {
        target.state = 'unresolved'; target.reason = 'not-in-exact-shutdown';
      }
    }
    op.startupProof = copy(snapshot);
  }
  const digestShutdown = value => hash(JSON.stringify(value));
  function shutdownEvidence(views) {
    const bindings = [];
    for (const op of load().operations) {
      if (op.phase !== 'captured' || !op.installBinding || op.sourceMainPid !== pid) continue;
      if (!op.shutdownEvidence) {
        const targets = op.targets.map(target => {
          const current = views.find(view => view.tabId === target.source.tabId);
          const sameOwner = current?.known === true && current.sessionId === target.source.sessionId && current.toolType === target.source.provider;
          const same = sameOwner && current.revision === target.capturedRevision;
          const own = same && current.busy === true
            && sameTurn(current.executionContext, target.subject?.targetExecutionContext);
          const ended = sameOwner && current.busy === false && current.turn?.known === true
            && current.turn.turnId === target.subject?.targetExecutionContext?.turnId
            && ['task_complete', 'done', 'completed', 'end_turn'].includes(current.turn.outcome);
          return { tabId: target.source.tabId, source: target.source,
            executionContext: target.subject?.targetExecutionContext || null,
            disposition: target.route.kind === 'install-callback' ? 'install-callback'
              : own ? 'own-turn-interrupted' : ended ? 'own-turn-ended' : 'owner-or-input-changed' };
        });
        op.shutdownEvidence = { version: 1, operationId: op.id, bindingDigest: op.installBinding.bindingDigest,
          sourceMainPid: pid, capturedAt: now(), targets };
        commit(op); // Strict storage failure propagates before the existing shutdown producer may stop a PTY.
      }
      bindings.push({ operationId: op.id, bindingDigest: op.installBinding.bindingDigest,
        evidenceDigest: digestShutdown(op.shutdownEvidence) });
    }
    return copy(bindings);
  }
  function shutdownBindings() {
    return load().operations.filter(op => op.phase === 'captured' && op.installBinding && op.sourceMainPid === pid)
      .map(op => {
        if (!op.shutdownEvidence) throw failure('voice_install_shutdown_unsealed');
        return { operationId: op.id, bindingDigest: op.installBinding.bindingDigest,
          evidenceDigest: digestShutdown(op.shutdownEvidence) };
      });
  }
  function prepareShutdown() { return shutdownEvidence(copy(captureTabs())); }
  const party = (state, source) => state?.known === true && state.exists !== false && state.toolType === source.provider
    && (state.sessionId === source.sessionId || state.acceptedResumeSourceSessionId === source.sessionId)
    && (!source.cwd || !state.cwd || require('node:path').resolve(source.cwd) === require('node:path').resolve(state.cwd));
  function restoreOwnerProof(op, target) {
    if (!op.installBinding) return true;
    const previousPid = target.restoreMainPid || op.activationProof?.mainPid;
    if (previousPid === pid) return true;
    const snapshot = readStartup();
    if (snapshot?.source !== 'exact-shutdown-snapshot' || snapshot.shutdownPid !== previousPid) return null;
    const expectedSession = target.restoreOwner?.sessionId || target.source.sessionId;
    if (snapshot.targets?.some(row => row.tabId === target.source.tabId && row.provider === target.source.provider
      && row.sessionId === expectedSession)) {
      saveTarget(op.id, target.source.tabId, { restoreMainPid: pid,
        restoreProvenance: [...(target.restoreProvenance || []), { fromMainPid: previousPid, mainPid: pid,
          shutdownCapturedAt: snapshot.capturedAt, sessionId: expectedSession }] });
      return true;
    }
    return snapshot.unresolved?.some(row => row.tabId === target.source.tabId) ? null : false;
  }
  function rememberRestoreOwner(op, target, state) {
    if (op.installBinding && (target.restoreOwner?.sessionId !== state.sessionId || target.restoreOwner?.mainPid !== pid)) {
      saveTarget(op.id, target.source.tabId, { restoreOwner: { sessionId: state.sessionId, mainPid: pid } });
    }
  }
  function priorContinuationPending(target) {
    return target.priorOperationIds?.some(id => {
      const previous = find(id)?.targets.filter(old => old.source.tabId === target.source.tabId);
      return !previous?.length || previous.some(active);
    }) === true;
  }
  function inputFenceState(op, target) {
    if (!readInputFence) return true;
    const current = readInputFence(target.source.tabId), old = target.inputFence;
    if (!current) return !old || old.mainPid !== pid ? true : null;
    if (!current.terminalInstanceId || !Number.isSafeInteger(current.stopRevision)) return null;
    if (old?.mainPid === pid) return old.terminalInstanceId === current.terminalInstanceId && old.stopRevision === current.stopRevision;
    if (current.stopRevision !== 0) return false; // Stop after boot precedes admission.
    saveTarget(op.id, target.source.tabId, { inputFence: { ...current, mainPid: pid } });
    return true;
  }
  function inputFence(op, target) { return inputFenceState(op, target) === true; }
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
    // Several captured questions may refer to the same shared callback.
    // Deduplicate complete proofs, never only O/H or a user-text match.
    const allowed = new Map();
    for (const ref of op.references.runs.filter(ref => ref.sourceTabId === target.source.tabId)) {
      const sourceSession = ref.sourceSendTarget?.sessionId || ref.sourceSessionId;
      if (sourceSession !== target.source.sessionId) continue;
      const run = await getRun(ref.runId);
      if (!run || (run.createdAt || null) !== ref.createdAt || run.sourceTabId !== ref.sourceTabId
        || (run.externalResearchJobId || null) !== ref.externalResearchJobId
        || run.notifySource === false || run.notificationSuppressed || run.notificationCancelRequestedAt) continue;
      const handoffId = 'orchestration-complete:' + ref.runId, key = 'history:' + target.source.tabId + ':' + handoffId;
      const proof = await callbackProof(op, target, key, handoffId, 'orchestration-completion:' + ref.runId, state);
      if (proof) allowed.set(JSON.stringify(proof), proof);
    }
    for (const ref of op.references.messages) {
      let message = readMessage(ref.messageId);
      if (!message || message.cancelledAt || message.requestFingerprint !== ref.requestFingerprint) continue;
      if (ref.kind === 'question' && ref.sourceTabId === target.source.tabId && ref.sourceSessionId === target.source.sessionId) {
        if (!message.replyMessageId) continue;
        message = readMessage(message.replyMessageId);
        if (!message || !(message.replyToIds || [message.replyTo]).includes(ref.messageId)
          || message.kind !== 'reply' || message.cancelledAt) continue;
      } else if (ref.kind !== 'reply' || ref.targetTabId !== target.source.tabId || ref.targetSessionId !== target.source.sessionId) continue;
      if (message.targetTabId !== target.source.tabId || message.targetSessionId !== target.source.sessionId
        || message.targetProvider !== target.source.provider || message.targetProjectId !== target.source.projectId) continue;
      const proof = await callbackProof(op, target, message.operationKey, message.handoffId, 'tab-message:' + message.messageId, state);
      if (proof) allowed.set(JSON.stringify(proof), proof);
    }
    const inputs = [];
    for (const user of interval.users.slice(1)) {
      const matchesInput = [...allowed.values()].filter(proof => matches(user, proof));
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
    if (current.op.phase !== 'restoring' || !active(current.target)) return { covered: false, reason: 'restart-operation-changed' };
    const proof = { covered: true, operationId: op.id, sourceRevision: interval.sourceRevision,
      fromExecutionContext: copy(target.subject.targetExecutionContext), throughExecutionContext: latestContext || null,
      inputs, ranges: interval.ranges };
    saveTarget(op.id, target.source.tabId, { historyProof: proof });
    return proof;
  }
  async function sourceFollowupBinding({ run, parent, proof }) {
    for (const op of [...load().operations].reverse()) {
      const target = op.targets.find(target => ['agent', 'install-callback'].includes(target.route.kind) && target.route.runId === parent.runId
        && target.source.tabId === run.sourceTabId);
      const ref = op.references.runs.find(ref => ref.runId === run.runId && ref.parentRunId === parent.runId);
      if (!target || !ref || ref.sourceTabId !== target.source.tabId || (ref.sourceSendTarget?.sessionId || ref.sourceSessionId) !== target.source.sessionId
        || (run.createdAt || null) !== ref.createdAt) continue;
      const originalParent = exactContext(parent.targetExecutionContext, target.subject.targetExecutionContext) && active(target);
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
        && active(target));
      if (target && party(state, target.source)) {
        if (op.recoveryCancelledAt) return { required: true, covered: false, reason: 'restart-cancelled' };
        if (!inputFence(op, target)) return { required: true, covered: false, reason: 'restart-stopped-or-replaced' };
        const context = latest?.subject?.targetExecutionContext || latest?.result?.executionContext;
        if (latest?.result?.sourceVerified === true && sameTurn(context, target.subject.targetExecutionContext)) return { required: true, covered: true, operationId: op.id };
        return { required: true, ...await restartHistory(op, target, state, original, latest) };
      }
    }
    return { covered: false };
  }
  async function validate(id, tabId, { preparation = false, expectedTarget = null } = {}) {
    const waitKey = JSON.stringify([id, tabId]);
    validationWaitReasons.delete(waitKey);
    const wait = (reason, detail = null) => { validationWaitReasons.set(waitKey, { reason, detail }); return false; };
    const { op, target } = row(id, tabId);
    if (op.phase !== 'restoring' || op.recoveryCancelledAt || target.route.kind !== 'local' || !active(target)) throw failure('build_continue_not_active');
    if (priorContinuationPending(target)) return false;
    const state = await readState(tabId);
    const ownerChanged = kind => Object.assign(failure('build_continue_owner_changed'), {
      observation: { kind, known: state?.known === true, exists: state?.exists ?? null,
        provider: state?.toolType || null, sessionId: state?.sessionId || null,
        processStatus: state?.processStatus || 'unknown', transitioning: state?.transitioning ?? null,
        error: typeof state?.error === 'string' ? state.error.slice(0, 160) : null, observedAt: now() },
    });
    // A physical provider mismatch is explicit negative evidence even when
    // response observation reports known:false. Other missing/coherence facts
    // during AutoResume are not evidence that the saved owner was replaced.
    if (state?.error === 'response_owner_changed' || state?.known === true && state.exists === false) {
      throw ownerChanged(state?.error === 'response_owner_changed' ? 'physical-provider-mismatch' : 'tab-missing');
    }
    const fence = inputFenceState(op, target);
    if (fence === false) throw ownerChanged('stop-or-pinned-terminal-changed');
    if (state?.known !== true || !state.toolType || !state.sessionId) return wait('runtime-owner-pending');
    if (!party(state, target.source)) throw ownerChanged('confirmed-source-mismatch');
    rememberRestoreOwner(op, target, state);
    if (fence === null) return wait('input-fence-pending');
    if (!canSubmitContinuationInput(state) || continuationInputTransitionPending(state) || state.backgroundWorkCount > 0
      || state.goalWork?.pending || ['active', 'attention', 'attention_required'].includes(state.goalWork?.status)) return wait('runtime-input-pending');
    const later = await readLaterInput(copy(op), copy(target), state);
    if (later?.proven === true) {
      const after = await readState(tabId), current = row(id, tabId);
      if (current.op.phase !== 'restoring' || current.op.recoveryCancelledAt || !active(current.target)) throw failure('build_continue_not_active');
      if (!state.revision || state.revision !== after.revision || !party(after, target.source)
        || inputFenceState(current.op, current.target) !== true || later.isCurrent?.() !== true) {
        return wait('later-input-proof-changed');
      }
      return { superseded: true, proof: later.proof, isCurrent: later.isCurrent };
    }
    const original = await readOriginal(target, state);
    if (!active(row(id, tabId).target)) throw failure('build_continue_not_active');
    if (original?.found !== true || original.sourceVerified !== true) return wait('original-proof-pending', {
      stage: 'original', reason: original?.errorCode || original?.error || 'original_source_unverified',
      laterInput: later?.reason });
    if (target.source.provider === 'codex' && !sameTurn(original.executionContext, target.subject.targetExecutionContext)) return false;
    if (target.source.provider === 'claude' && target.subject.providerPromptId
      && original.userUuid !== target.subject.providerPromptId) return false;
    if (original.complete === true) return { resultReady: true };
    const latest = await readLatest(target, state);
    const latestContext = latest?.subject?.targetExecutionContext || latest?.result?.executionContext;
    if (latest?.result?.sourceVerified !== true || !sameTurn(latestContext, target.subject.targetExecutionContext)) {
      const history = await restartHistory(op, target, state, original, latest);
      if (history.covered !== true) {
        if (history.unknown) return wait('input-history-proof-pending', {
          stage: 'input-interval', reason: history.reason, laterInput: later?.reason,
          latest: latest?.result?.sourceVerified === true ? null
            : latest?.code || latest?.error || latest?.result?.errorCode || 'latest_source_unverified' });
        throw failure('build_continue_newer_input');
      }
    }
    const after = await readState(tabId);
    if (!party(after, target.source) || !state.revision || after.revision !== state.revision
      || !canSubmitContinuationInput(after) || continuationInputTransitionPending(after)
      || !continuationTargetScopeMatches(expectedTarget, after)
      || !inputFence(row(id, tabId).op, row(id, tabId).target)) return wait('runtime-input-changed');
    return preparation ? continuationInputPreparation(after, expectedTarget) : true;
  }
  async function prepareInput(id, tabId, expectedTarget) {
    const proof = await validate(id, tabId, { preparation: true, expectedTarget });
    if (proof?.resultReady) {
      saveTarget(id, tabId, { state: 'result-ready' });
      throw failure('build_continue_original_result_ready');
    }
    if (proof?.superseded) {
      await supersede(id, tabId, proof);
      throw failure('build_continue_newer_input');
    }
    if (!proof) {
      const waiting = validationWaitReasons.get(JSON.stringify([id, tabId]));
      saveTarget(id, tabId, { reason: waiting?.reason || 'build_continue_admission_changed' });
      throw deferSendPreparation('build_continue_admission_changed', waiting?.reason);
    }
    return proof;
  }
  function saveTarget(id, tabId, patch) {
    const { op, target } = row(id, tabId);
    // A cancelled automatic intent can receive late audit information at its
    // original receipt owner; it must never regain active journal state.
    if (target.cancellation?.requestedAt && !patch.cancellation) return op;
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(target[key]) === JSON.stringify(value))) return op;
    const wasActive = active(target);
    Object.assign(target, copy(patch)); const saved = commit(op);
    if (wasActive && !active(target)) released({ version: 1, operationId: id, tabId,
      handoffId: target.handoffId, state: target.state, reason: target.reason || null });
    return saved;
  }
  async function supersede(id, tabId, admission) {
    let current = row(id, tabId);
    const receipt = readReceipt(current.target.operationKey);
    if (receipt && !['reserved', 'preparing'].includes(receipt.state)
      || receipt?.attemptId || receipt?.receipt?.deliveryUnknown || receipt?.receipt?.submitted === true
      || receipt?.receipt?.pasteWritten === true || receipt?.receipt?.enterWritten === true) return false;
    // This owner port is synchronous (same receipt/FIFO transactions), so no
    // new input/Stop can overtake the final positive-proof/cancellation cut.
    if (admission.isCurrent?.() !== true || cancelInput(copy(current.target), 'build-continue-superseded') !== true) return false;
    current = row(id, tabId);
    if (!active(current.target) || current.op.recoveryCancelledAt || admission.isCurrent?.() !== true) return false;
    saveTarget(id, tabId, { state: 'superseded', reason: 'build_continue_newer_input',
      supersessionProof: admission.proof });
    return true;
  }
  async function cancelTarget(id, request) {
    const { op, target } = row(id, request.tabId);
    if (!validId(request.requestId) || request.handoffId !== target.handoffId || request.operationKey !== target.operationKey) {
      throw failure('build_continue_cancel_identity_changed');
    }
    const fingerprint = hash(JSON.stringify([id, request.tabId, request.handoffId, request.operationKey, request.requestId]));
    if (target.cancellation && target.cancellation.fingerprint !== fingerprint) throw failure('build_continue_cancel_request_changed');
    // Failed/paused attention remains visible after execution has ended. Its
    // exact X still needs a durable acknowledgement, not a successful no-op.
    if (END.has(target.state) && !['unresolved', 'paused'].includes(target.state) && !target.cancellation) return copy(op);
    if (!target.cancellation) saveTarget(id, request.tabId, { cancellation: { requestId: request.requestId, fingerprint,
      requestedAt: now(), acknowledgedAt: null }, ...(target.state === 'pending' ? { state: 'cancelled' } : {}),
      ...(!END.has(target.state) ? { reason: 'user-cancelled-auto-continue' } : {}) });
    const current = row(id, request.tabId);
    if (!current.target.cancellation.acknowledgedAt) {
      if (await cancelInput(copy(current.target), 'user-cancelled-auto-continue') !== true) throw failure('build_continue_cancel_unconfirmed');
      saveTarget(id, request.tabId, { cancellation: { ...row(id, request.tabId).target.cancellation, acknowledgedAt: now() } });
    }
    // Do not call reconcile/restore here: cancellation never starts another
    // target or dispatches a pending continuation in a different tab.
    const final = find(id);
    if (final.targets.every(target => !active(target)) && !(final.carriedTargets || []).length && final.phase === 'restoring') {
      commit({ ...final, phase: 'settled', settledAt: now() });
    }
    return copy(find(id));
  }
  async function reconcileTarget(id, tabId) {
    let { op, target } = row(id, tabId);
    if (!active(target)) return;
    if (target.route.kind === 'install-callback') {
      const callback = await readInstallCallback(op.installBinding);
      ({ op, target } = row(id, tabId));
      if (op.phase === 'restoring' && active(target) && callback?.disposition === 'ended-without-callback') {
        saveTarget(id, tabId, { state: 'cancelled', reason: 'install-ended-without-callback' }); return;
      }
      if (op.phase !== 'restoring' || !active(target)) return;
      if (!callback?.binding) { saveTarget(id, tabId, { reason: 'callback-proof-pending' }); return; }
      if (target.route.runId && !await adoptInstallCallback({ operation: copy(op), target: copy(target), callback })) {
        saveTarget(id, tabId, { continuationDelivery: 'exact-native-confirmed', reason: 'callback-run-binding-pending' }); return;
      }
      ({ op, target } = row(id, tabId));
      if (op.phase === 'restoring' && active(target)) saveTarget(id, tabId, {
        state: 'confirmed', reason: null, binding: { ...callback.binding, kind: 'install-callback', operationId: id,
          fromSessionId: target.source.sessionId, tabId, provider: target.source.provider },
        continuationDelivery: 'exact-native-confirmed', naturalFinal: callback.naturalFinal === true ? 'verified' : 'not-observed' });
      return;
    }
    if (op.recoveryCancelledAt && !['sending', 'accepted', 'unknown'].includes(target.state)) {
      const prior = readReceipt(target.operationKey);
      if (prior?.attemptId || prior?.receipt?.deliveryUnknown) {
        saveTarget(id, tabId, { state: 'unknown', reason: 'cancel-after-input-attempt' }); return;
      }
      if (readQueued(target.operationKey) && !await cancelQueued(target)) return;
      saveTarget(id, tabId, { state: 'cancelled', reason: 'install-auto-continue-cancelled' }); return;
    }
    if (target.state === 'pending' && op.installBinding) {
      const proof = restoreOwnerProof(op, target);
      if (proof !== true) {
        saveTarget(id, tabId, proof === false ? { state: 'superseded', reason: 'subsequent-shutdown-target-not-interrupted' }
          : { reason: 'subsequent-restore-proof-pending' });
        return;
      }
    }
    if (priorContinuationPending(target)) {
      if (target.state === 'pending') saveTarget(id, tabId, { reason: 'prior-continuation-pending' });
      return;
    }
    const record = readReceipt(target.operationKey);
    const binding = record && restartReceiptBinding(op, target, record, readQueued(target.operationKey), readPrepared(tabId, target.handoffId));
    if (binding) { saveTarget(id, tabId, { state: 'confirmed', binding }); return; }
    if (target.state === 'pending' && target.route.kind === 'local' && record
      && (record.deliveryControl?.cancelledAt || ['cancelled', 'not-submitted', 'provider-not-accepted'].includes(record.state))) {
      saveTarget(id, tabId, { state: 'unresolved', reason: 'continue-not-delivered' }); return;
    }
    if (target.state === 'pending' && target.route.kind === 'local' && record
      && (!['reserved', 'preparing'].includes(record.state) || record.attemptId || record.receipt?.deliveryUnknown
      || record?.receipt?.submitted === true || record?.receipt?.pasteWritten === true || record?.receipt?.enterWritten === true)) {
      saveTarget(id, tabId, { state: 'unknown', reason: 'existing-continuation-attempt-unconfirmed' }); return;
    }
    if (target.state === 'pending') {
      const returns = await prepareReturns(copy(op), copy(target));
      ({ op, target } = row(id, tabId));
      if (op.phase !== 'restoring' || !active(target) || op.recoveryCancelledAt) return;
      if (returns?.ready !== true) { saveTarget(id, tabId, { reason: returns?.reason || 'ready-returns-pending' }); return; }
    }
    if (target.route.kind === 'agent') {
      const state = await readState(tabId), fence = inputFenceState(op, target);
      if (state?.error === 'response_owner_changed' || state?.known === true && state.exists === false || fence === false) {
        saveTarget(id, tabId, { state: 'superseded', reason: 'build_continue_owner_changed' }); return;
      }
      if (state?.known !== true || !state.sessionId || !state.toolType || fence === null
        || continuationInputTransitionPending(state)) { saveTarget(id, tabId, { reason: 'runtime-owner-pending' }); return; }
      if (!party(state, target.source)) { saveTarget(id, tabId, { state: 'superseded', reason: 'build_continue_owner_changed' }); return; }
      rememberRestoreOwner(op, target, state);
      let result;
      const beforeRun = target.runIntentId ? await getRun(target.route.runId) : null;
      if (target.runIntentId && !(beforeRun?.continuationIntent?.state === 'prepared'
        && !beforeRun.continuationIntent.sendStartedAt)) {
        await reconcileRunContinuation(target.route.runId); result = { ok: true };
      } else result = await continueRun(target.route.runId, { restartPrompt: continuationPrompt(target), applicationQueueAcceptedResponse: true });
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
      else if (result.deferred === true) saveTarget(id, tabId, { state: 'pending', reason: result.code || 'ready-returns-pending' });
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
      ? 'superseded' : 'pending', reason: error.code || error.message,
      ...(error.observation ? { refusalObservation: error.observation } : {}) }); return; }
    if (admission?.superseded) { await supersede(id, tabId, admission); return; }
    if (admission?.resultReady) { saveTarget(id, tabId, { state: 'result-ready' }); return; }
    if (admission !== true) {
      const key = JSON.stringify([id, tabId]), waiting = validationWaitReasons.get(key);
      validationWaitReasons.delete(key);
      if (waiting) saveTarget(id, tabId, { reason: waiting.reason,
        proofWait: waiting.detail ? { stage: waiting.detail.stage, reason: String(waiting.detail.reason || 'unavailable').slice(0, 120),
          laterInput: String(waiting.detail.laterInput || 'unavailable').slice(0, 120),
          ...(waiting.detail.latest ? { latest: String(waiting.detail.latest).slice(0, 120) } : {}) } : null });
      return;
    }
    const destination = await readState(tabId);
    if (!party(destination, target.source) || !canSubmitContinuationInput(destination)
      || continuationInputTransitionPending(destination) || !inputFence(row(id, tabId).op, row(id, tabId).target)) return;
    const expectedTarget = continuationTargetExpectation({ toolType: target.source.provider, sessionId: target.source.sessionId }, destination);
    saveTarget(id, tabId, { state: 'sending' }); // Commit before any input producer.
    try {
      const result = await send({ tabId, provider: target.source.provider, sessionId: target.source.sessionId,
        expectedTarget,
        cwd: target.source.cwd, prompt: continuationPrompt(target), source: 'build-install-continue:' + id,
        handoffId: target.handoffId, sendOperationKey: target.operationKey, sendSurface: 'desktop-history',
        ownership: 'project', queue: false, applicationQueueAcceptedResponse: true,
        statusAtSend: destination.processStatus === 'absent' ? 'inactive' : 'active', prepareSend: async () => {
          return prepareInput(id, tabId, expectedTarget);
        } });
      if (result?.deferred === true && result.success === false && result.submitted === false
        && !result.deliveryUnknown && !result.pasteWritten && !result.enterWritten
        && !readQueued(target.operationKey) && !readReceipt(target.operationKey)?.attemptId) {
        saveTarget(id, tabId, { state: 'pending', reason: result.code || 'ready-returns-pending' }); return;
      }
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
        const carriedSettled = (current.carriedTargets || []).every(ref => {
          const original = find(ref.operationId)?.targets.find(target => target.source.tabId === ref.tabId
            && target.handoffId === ref.handoffId && target.operationKey === ref.operationKey);
          return original && !active(original);
        });
        if (current.targets.every(target => !active(target)) && carriedSettled) {
          commit({ ...current, phase: 'settled', settledAt: now() });
          for (const next of load().operations) if (next.phase === 'restoring'
            && (next.targets.some(target => target.priorOperationIds?.includes(id))
              || next.carriedTargets?.some(ref => ref.operationId === id))) {
            void reconcile(next.id).catch(() => {});
          }
        }
      } while (trailing.delete(id));
    })().finally(() => inflight.delete(id));
    inflight.set(id, work); return work;
  }
  function activate(id) {
    const op = find(id);
    if (!op || op.sourceMainPid === pid) throw failure('build_continue_replacement_required');
    if (op.installBinding && !op.activationProof) throw failure('voice_install_activation_required');
    if (op.phase === 'captured') { startupProof(op); commit({ ...op, phase: 'restoring', activatedAt: now() }); }
    void reconcile(id).catch(() => {}); return copy(find(id));
  }
  async function activateInstall(id, raw) {
    let op = find(id);
    if (!op?.installBinding || !sameVoiceInstallBinding(raw, op.installBinding)) throw failure('voice_install_binding_changed');
    if (op.phase === 'settled') return copy(op);
    const job = await verifyInstallJob(op.installBinding, 'activate');
    op = find(id);
    if (!op || !sameVoiceInstallBinding(raw, op.installBinding) || op.sourceMainPid === pid) throw failure('build_continue_replacement_required');
    if (!op.activationProof) {
      startupProof(op);
      op.activationProof = { bindingDigest: op.installBinding.bindingDigest, permittedAt: now(),
        mainPid: pid, maintenanceOperationId: op.installBinding.maintenanceOperationId,
        outcome: job?.installResult?.installed === true ? 'installed' : 'previous-app-reopened' };
      commit(op);
    }
    return activate(id);
  }
  async function cancelInstall(id, raw) {
    const op = find(id);
    if (!op?.installBinding || !sameVoiceInstallBinding(raw, op.installBinding)) throw failure('voice_install_binding_changed');
    if (!op.recoveryCancelledAt) commit({ ...op, recoveryCancelledAt: now() });
    if (find(id).phase === 'registered') commit({ ...find(id), phase: 'settled', settledAt: now(), disposition: 'cancelled-before-capture' });
    else for (const target of find(id).targets) if (active(target) || target.cancellation) {
      await cancelTarget(id, { tabId: target.source.tabId, handoffId: target.handoffId, operationKey: target.operationKey,
        requestId: 'install-cancel-' + hash(JSON.stringify([id, raw.bindingDigest, target.source.tabId])).slice(0, 32) });
    }
    return copy(find(id));
  }
  async function admit(request) {
    const id = String(request.source || '').slice('build-install-continue:'.length);
    const { op, target } = row(id, request.tabId);
    const prepared = readPrepared(request.tabId, request.handoffId);
    if (request.handoffId !== target.handoffId || request.sendOperationKey !== target.operationKey
      || request.provider !== target.source.provider || request.expectedTarget?.sessionId !== target.source.sessionId
      || request.expectedTarget?.toolType !== target.source.provider || op.phase !== 'restoring'
      || (request.prompt !== continuationPrompt(target) && (!prepared || prepared.base_hash !== hash(continuationPrompt(target))
        || prepared.prepared_prompt !== request.prompt || prepared.payload_hash !== promptAuditFingerprint(request.prompt)))) {
      return { cancel: true, reason: 'build-continue-request-changed' };
    }
    const result = await validate(id, request.tabId);
    if (result?.superseded) {
      await supersede(id, request.tabId, result);
      return { cancel: true, reason: 'build-continue-superseded-by-independent-input' };
    }
    if (result?.resultReady) {
      saveTarget(id, request.tabId, { state: 'result-ready' });
      return { cancel: true, reason: 'build-continue-original-result-ready' };
    }
    return result;
  }
  async function prepareReservation(request) {
    for (const operation of load().operations) {
      if (operation.phase !== 'restoring') continue;
      const target = operation.targets.find(target => target.source.tabId === request.tabId
        && target.handoffId === request.handoffId && target.operationKey === request.sendOperationKey);
      if (!target || target.route.kind === 'install-callback') continue;
      if (operation.recoveryCancelledAt || !active(target)) return { ready: false, reason: 'restart-input-revoked' };
      const gate = await prepareReturns(copy(operation), copy(target));
      const current = row(operation.id, target.source.tabId);
      if (current.op.recoveryCancelledAt || !active(current.target)) return { ready: false, reason: 'restart-input-revoked' };
      return gate;
    }
    return { ready: true };
  }
  function wake(tabId = null) {
    for (const op of load().operations) if (op.phase === 'restoring'
      && (!tabId || op.targets.some(target => target.source.tabId === tabId))) void reconcile(op.id).catch(() => {});
  }
  function restore() {
    for (const op of load().operations) {
      if (op.phase === 'captured' && op.sourceMainPid !== pid && !op.installBinding) activate(op.id);
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
      const target = op.targets.find(t => ['agent', 'install-callback'].includes(t.route.kind) && t.route.runId === run.runId
        && t.source.tabId === run.targetTabId && active(t));
      const ref = op.references.runs.find(ref => ref.runId === run.runId && ref.runKind === 'agent');
      if (target && ref && exactContext(ref.targetExecutionContext, run.targetExecutionContext)
        && exactContext(target.subject?.targetExecutionContext, run.targetExecutionContext)) return { operationId: op.id };
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
      const target = op.targets.find(target => target.source.tabId === request.tabId && active(target));
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
      if (!target?.subject || ref.observationCurrentTurnSubject && !exactContext(ref.observationCurrentTurnSubject.targetExecutionContext,
        target.subject.targetExecutionContext)) continue;
      if (target.cancellation?.requestedAt) return null;
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
  return { capture, activate, registerInstall, activateInstall, cancelInstall, shutdownEvidence, prepareShutdown, shutdownBindings, prepareReservation,
    restore, reconcile, wake, validate, prepareInput, admit, cancelTarget, messageBinding, recoveryHold, observationBinding, restartHistoryForRun, sourceFollowupBinding, staleLoopAdmission,
    get: id => { const op = find(id); return op ? copy(op) : null; },
    forTab: tabId => {
      const targets = load().operations.flatMap(op => op.targets.filter(target => target.source.tabId === tabId).map(target => ({
        operationId: op.id, capturedAt: op.capturedAt, phase: op.phase, ...copy(target), active: active(target),
        relatedRequests: op.references.runs.filter(ref => ref.sourceTabId === tabId || ref.targetTabId === tabId).map(ref => ({
          runId: ref.runId, runKind: ref.runKind, externalResearchJobId: ref.externalResearchJobId || null,
        })),
      })));
      const recentHistory = new Set(targets.filter(target => !target.active).slice(-32));
      return targets.filter(target => target.active || recentHistory.has(target)).reverse();
    },
    pending: tabId => load().operations.some(op => ['captured', 'restoring'].includes(op.phase)
      && op.targets.some(target => target.source.tabId === tabId && active(target))) || capturingTargets.has(tabId),
    // Capture→Quit belongs to the whole old Main, including idle/late tabs.
    // Existing physical attempts keep their separate native receipts/guards.
    capturing: () => !!captureWork || load().operations.some(op => op.phase === 'captured' && op.sourceMainPid === pid),
    list: () => copy(load().operations), dispose() { disposed = true; trailing.clear(); validationWaitReasons.clear(); } };
}

module.exports = { createBuildContinueOperations, restartReceiptBinding, validId };
