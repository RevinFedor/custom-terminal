'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { normalizeMiniReviewArchive } = require('./mini-orchestrator-archive');

// This controller has no readers, timers, or provider/PTY authority. Adapters own
// durable restoration and must enforce the same owner fence at the writer.
function createMiniOrchestrator({ review, sendCorrection, loadInstruction, isCurrent, automaticCorrections = false, persist = () => {}, loadLedger = () => [], loadPresentation = () => null, publish = () => {}, log = () => {}, uuid = randomUUID }) {
  const tabs = new Map();
  const LIMIT = 250000;
  const ROUND_LIMIT = 4;
  let disposed = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const terminalReceipt = r => r && ['sent', 'refused', 'no-input'].includes(r.status);
  function mergeReceipt(old, next) {
    if (!old) return next;
    if (terminalReceipt(old)) return old;
    if (terminalReceipt(next)) return next;
    if (old.status === 'queued' && next.status === 'unknown') return old;
    return next;
  }
  const validInputs = xs => Array.isArray(xs) && xs.length > 0 && xs.length <= 16 && xs.every(x => x && typeof x.inputId === 'string' && x.inputId && typeof x.text === 'string') && xs.reduce((n, x) => n + x.text.length, 0) <= LIMIT;
  const ownerKey = o => o && ['claude', 'codex'].includes(o.provider) && typeof o.sessionId === 'string' && o.sessionId && typeof o.generation === 'string' && o.generation ? JSON.stringify([o.provider, o.sessionId, o.generation]) : null;
  function state(tabId) {
    if (!tabs.has(tabId)) {
      let ledger; let ledgerError;
      try {
        ledger = loadLedger(tabId);
        if (!Array.isArray(ledger) || ledger.length > 64 || ledger.filter(x => x && x.rootInputs).length > 1 || ledger.some(x => !x || typeof x.identity !== 'string' || typeof x.jobId !== 'string' || typeof x.attempted !== 'boolean' || (x.rootInputs && !validInputs(x.rootInputs)))) throw new Error('invalid_ledger');
        ledger = clone(ledger);
      } catch (e) { ledger = []; ledgerError = String(e.message || e); }
      const initial = { tabId, enabled: false, revision: 0, phase: 'off', entries: [], round: 0, ledger, ledgerError, turn: null, pending: [], job: null, pendingSend: null };
      try {
        const prepared = normalizeMiniReviewArchive(loadPresentation(tabId), tabId);
        if (prepared) {
          initial.entries = prepared.entries;
          initial.reviewSource = prepared.reviewSource; initial.phase = 'complete';
          initial.roundSources = prepared.roundSources;
          initial.round = Math.max(...Object.keys(prepared.roundSources).map(Number));
        }
      } catch (error) { initial.phase = 'error'; initial.error = String(error.message || 'mini_archive_invalid'); }
      tabs.set(tabId, initial);
    }
    return tabs.get(tabId);
  }
  function snapshot(tabId) {
    const s = state(tabId);
    const result = { tabId, enabled: s.enabled, revision: s.revision, phase: s.phase, entries: s.entries };
    if (s.jobId) result.jobId = s.jobId;
    if (s.error) result.error = s.error;
    if (s.activeReview) result.activeReview = s.activeReview;
    if (s.reviewSource) result.reviewSource = s.reviewSource;
    if (s.roundSources) result.roundSources = s.roundSources;
    if (s.correctionState) result.correctionState = s.correctionState;
    return clone(result);
  }
  function changed(s) {
    s.revision++;
    try { log('state', { tabId: s.tabId, enabled: s.enabled, phase: s.phase, revision: s.revision,
      jobId: s.jobId || '', entryCount: s.entries.length }); } catch {}
    try { publish(s.tabId, snapshot(s.tabId)); } catch (e) { log('mini-orchestrator publish failed', String(e)); }
  }
  function fence(s, j) {
    if (disposed || !s.enabled || (s.job !== j && s.pendingSend !== j) || j.invalid || j.controller.signal.aborted) return false;
    try { return isCurrent({ tabId: s.tabId, owner: j.owner, turnId: j.turnId }) === true; } catch { return false; }
  }
  function invalidateJob(s) { for (const j of new Set([s.job, s.pendingSend].filter(Boolean))) { j.invalid = true; j.controller.abort(); const record = s.ledger.find(x => x.jobId === j.id); if (record && !record.attempted) { record.settled = true; try { persist(s.tabId, clone(s.ledger)); } catch (e) { s.ledgerError = 'persist_failed'; } } } s.job = null; s.pendingSend = null; delete s.activeReview; }
  function invalidate(tabId, reason = 'invalidated') {
    const s = state(tabId); invalidateJob(s); s.turn = null; s.pending = [];
    delete s.correctionState;
    s.phase = s.enabled ? 'idle' : 'off'; delete s.error;
    if (reason) { s.entries = s.entries.filter(x => x.type !== 'notice'); s.entries.push({ id: uuid(), type: 'notice', text: String(reason).slice(0, LIMIT) }); }
    changed(s);
  }
  function invalidateReview(tabId, reason = 'new input') {
    const s = state(tabId);
    if (!s.job && !s.pendingSend) return false;
    invalidateJob(s);
    s.phase = s.enabled ? (s.turn || s.pending.length ? 'collecting' : 'idle') : 'off';
    delete s.error;
    if (reason) { s.entries = s.entries.filter(x => x.type !== 'notice'); s.entries.push({ id: uuid(), type: 'notice', text: String(reason).slice(0, LIMIT) }); }
    changed(s); return true;
  }
  function setEnabled(tabId, enabled) {
    const s = state(tabId); if (disposed || s.enabled === !!enabled) return snapshot(tabId);
    delete s.correctionState;
    invalidateJob(s); s.turn = null; s.pending = []; s.enabled = !!enabled; s.phase = s.enabled ? 'idle' : 'off'; delete s.error; changed(s); return snapshot(tabId);
  }
  function observeInput({ tabId, owner, inputId, text, turnId, correctionHandoffId, inputAliases = [] }) {
    const s = state(tabId), key = ownerKey(owner);
    if (disposed || !s.enabled || !key || typeof inputId !== 'string' || !inputId || typeof text !== 'string') return false;
    const correction = correctionHandoffId && s.ledger.find(x => x.handoffId === correctionHandoffId && x.rootInputs && x.ownerKey === key);
    if (s.job || s.pendingSend) { invalidateJob(s); s.turn = null; s.pending = []; }
    if (correction && !s.turn && !s.pending.length) { s.pending = clone(correction.rootInputs).map(x => ({ ...x, historicalRoot: true })); s.pendingOwner = key; s.pendingRootHash = correction.rootHash; }
    const current = s.turn && s.turn.ownerKey === key && (!turnId || s.turn.turnId === turnId) ? s.turn : null;
    if (correction && current && !current.inputs.length) { current.inputs = clone(correction.rootInputs).map(x => ({ ...x, historicalRoot: true })); current.rootHash = correction.rootHash; }
    if (s.turn && !current) { s.turn = null; s.pending = []; }
    const list = current ? current.inputs : s.pending;
    // Aliases come only from the shared exact cross-carrier pairer. Never
    // collapse separate sends merely because their text happens to match.
    const aliases = Array.isArray(inputAliases) ? inputAliases.filter(x => typeof x === 'string').slice(0, 16) : [];
    const existing = list.find(x => x.inputId === inputId || aliases.includes(x.inputId));
    if (existing) {
      if (text.length > LIMIT || list.reduce((n, x) => n + (x === existing ? text.length : x.text.length), 0) > LIMIT) {
        if (current) current.invalid = true; else s.pendingInvalid = true;
        s.phase = 'unknown'; s.error = 'input_limit'; changed(s); return false;
      }
      existing.inputId = inputId; existing.text = text; return false;
    }
    if (list.length >= 16 || text.length > LIMIT || list.reduce((n, x) => n + x.text.length, 0) + text.length > LIMIT) {
      if (current) current.invalid = true; else s.pendingInvalid = true;
      s.phase = 'unknown'; s.error = 'input_limit'; changed(s); return false;
    }
    if (!current && s.pendingOwner && s.pendingOwner !== key) { s.pending = []; s.pendingInvalid = false; }
    const target = current ? current.inputs : s.pending;
    delete s.correctionState;
    if (!correction) { if (current) current.rootHash = null; else s.pendingRootHash = null; }
    target.push({ inputId, text, turnId: turnId || null }); s.pendingOwner = key; s.phase = 'collecting'; delete s.error; changed(s); return true;
  }
  function beginTurn({ tabId, owner, turnId }) {
    const s = state(tabId), key = ownerKey(owner);
    if (disposed || !s.enabled || !key || typeof turnId !== 'string' || !turnId) return false;
    if (s.turn && s.turn.ownerKey === key && s.turn.turnId === turnId) return true;
    invalidateJob(s);
    const matches = s.pendingOwner === key && s.pending.every(x => !x.turnId || x.turnId === turnId);
    s.turn = { owner: clone(owner), ownerKey: key, turnId, inputs: matches ? s.pending : [], invalid: matches && !!s.pendingInvalid, rootHash: matches ? s.pendingRootHash : null };
    s.pending = []; s.pendingInvalid = false; s.pendingOwner = null; s.pendingRootHash = null; s.phase = s.turn.invalid ? 'unknown' : 'collecting'; changed(s); return true;
  }
  async function complete({ tabId, owner, turnId, answer, answerId, complete: done, sourceVerified }) {
    const s = state(tabId), key = ownerKey(owner), t = s.turn;
    if (disposed || !s.enabled || !key || !t || t.ownerKey !== key || t.turnId !== turnId) return false;
    const identity = JSON.stringify([key, turnId, answerId]);
    if (s.ledger.some(x => x.identity === identity)) return false;
    if (s.ledgerError) { s.phase = 'unknown'; s.error = 'ledger_unavailable'; changed(s); return false; }
    if (s.ledger.length >= 64) {
      const evict = s.ledger.findIndex(x => x.settled === true && !(x.attempted && (!x.receipt || ['unknown', 'queued'].includes(x.receipt.status))));
      if (evict < 0) { s.phase = 'unknown'; s.error = 'ledger_full'; changed(s); return false; }
      const candidate = s.ledger.slice(); candidate.splice(evict, 1);
      try { persist(tabId, clone(candidate)); } catch { s.phase = 'error'; s.error = 'persist_failed'; changed(s); return false; }
      s.ledger = candidate;
    }
    if (done !== true || sourceVerified !== true || typeof answerId !== 'string' || !answerId || typeof answer !== 'string' || answer.length > LIMIT || t.invalid || !t.inputs.length) {
      s.phase = 'unknown'; s.error = 'incomplete_or_unverified'; changed(s); return false;
    }
    const j = { id: uuid(), owner: clone(owner), turnId, startedAt: Date.now(), controller: new AbortController(), invalid: false, attempted: false };
    const rootHash = t.rootHash || hash(JSON.stringify(t.inputs.map(({ inputId, text }) => ({ inputId, text }))));
    const answerHash = hash(answer);
    const record = { identity, jobId: j.id, attempted: false, settled: false, rootHash, answerHash, ownerKey: key };
    s.ledger.push(record); s.job = j; s.jobId = j.id; s.turn = null; s.phase = 'reviewing'; delete s.error; delete s.correctionState;
    // Each completed answer opens its own round. Older rounds' entries are
    // kept, never overwritten, so the full request/review chain stays visible.
    const round = ++s.round;
    s.entries = s.entries.filter(x => x.round === undefined || x.round > round - ROUND_LIMIT);
    s.entries.push(...t.inputs.map(x => ({ id: x.inputId, type: 'request', text: x.text, round })));
    s.reviewSource = { provider: owner.provider, sessionId: owner.sessionId, generation: owner.generation,
      turnId, answerId, jobId: j.id, requestIds: t.inputs.map(x => x.inputId),
      navigationRequestId: t.inputs.find(x => !x.historicalRoot)?.inputId || '' };
    s.roundSources = { ...Object.fromEntries(Object.entries(s.roundSources || {}).filter(([k]) => Number(k) > round - ROUND_LIMIT)), [round]: s.reviewSource };
    s.entries.push({ id: answerId, type: 'answer', text: answer, round }); changed(s);
    const onSendPrompt = async prompt => {
      if (j.attempted || !fence(s, j) || typeof prompt !== 'string' || !prompt || prompt.length > LIMIT) return { status: 'refused' };
      if (s.ledger.some(x => x !== record && x.rootHash === rootHash && x.answerHash === answerHash && x.attempted)) return { status: 'refused', error: 'no_review_progress' };
      const promptHash = hash(prompt);
      if (s.ledger.some(x => x !== record && x.rootHash === rootHash && x.promptHash === promptHash && x.attempted)) return { status: 'refused', error: 'duplicate_feedback' };
      j.attempted = true; record.attempted = true; record.handoffId = 'mini-orchestrator:' + j.id; record.feedback = prompt;
      record.promptHash = promptHash;
      for (const old of s.ledger) delete old.rootInputs;
      record.rootInputs = t.inputs.map(({ inputId, text }) => ({ inputId, text }));
      try { persist(tabId, clone(s.ledger)); j.persistedAttempt = true; } catch (e) { j.persistFailed = true; s.phase = 'error'; s.error = 'persist_failed'; changed(s); return { status: 'refused', error: 'persist_failed' }; }
      if (!fence(s, j)) return { status: 'refused', error: 'stale' };
      const entry = { id: uuid(), type: 'tool', text: prompt, name: 'send_prompt', handoffId: record.handoffId, status: 'sending', round }; s.entries.push(entry); s.phase = 'sending'; changed(s);
      let receipt;
      try { receipt = await sendCorrection({ tabId, owner: j.owner, turnId, jobId: j.id, prompt, handoffId: record.handoffId, isCurrent: () => fence(s, j) }); }
      catch (e) { receipt = { status: 'unknown', error: String(e) }; }
      // The attempted handoff remains real even when the review was invalidated.
      entry.receipt = clone(mergeReceipt(record.receipt, receipt === undefined ? { status: 'unknown' } : receipt)); entry.status = entry.receipt.status || 'unknown';
      record.receipt = entry.receipt; record.settled = !['queued', 'unknown'].includes(entry.status);
      if (['queued', 'unknown'].includes(entry.status) && fence(s, j)) s.pendingSend = j;
      try { persist(tabId, clone(s.ledger)); } catch (e) { log('mini-orchestrator receipt persist failed', String(e)); }
      if (!s.entries.includes(entry)) s.entries.push(entry);
      if (fence(s, j)) s.phase = entry.status === 'unknown' ? 'unknown' : 'reviewing';
      changed(s);
      return clone(entry.receipt);
    };
    try {
      if (!fence(s, j)) return false;
      const instruction = await loadInstruction({ tabId, owner: j.owner, turnId, jobId: j.id });
      if (!fence(s, j)) return false;
      if (!instruction || typeof instruction.text !== 'string' || instruction.text.length > LIMIT) throw new Error('invalid_instruction');
      const startedAt = j.startedAt;
      s.activeReview = { jobId: j.id, model: instruction.model || '', thinkingLevel: instruction.thinkingLevel || '', startedAt };
      const requestIndex = s.entries.findIndex(x => x.round === round);
      s.entries.splice(requestIndex, 0, { id: instruction.id || uuid(), type: 'instruction', text: instruction.text, name: instruction.name, promptRevision: instruction.revision, filePath: Array.isArray(instruction.filePaths) ? instruction.filePaths.join('\n') : undefined, round }); changed(s);
      const previousFeedback = s.ledger.filter(x => x !== record && x.rootHash === rootHash && x.ownerKey === key
        && x.feedback && x.receipt && x.receipt.status === 'sent').slice(-4).map(x => x.feedback);
      const onReadIteration = () => {
        if (!fence(s, j)) throw new Error('mini_review_stale');
        const entry = { id: uuid(), type: 'tool', name: 'read_review_iteration',
          text: 'Чтение закреплённой итерации', status: 'read',
          receipt: { status: 'read', sessionId: owner.sessionId, turnId, requestCount: t.inputs.length }, round };
        s.entries.push(entry); changed(s);
        log('read_iteration', { tabId, turnId, jobId: j.id, reason: 'captured-own-snapshot' });
        return { source: clone(s.reviewSource), request: t.inputs.map(({ inputId, text }) => ({ inputId, text })),
          completedAnswer: answer, previousReviewerFeedback: previousFeedback };
      };
      const result = await review({ instruction: clone(instruction), inputs: t.inputs.map(({ inputId, text }) => ({ inputId, text })), answer, owner: j.owner, turnId, jobId: j.id, signal: j.controller.signal, onSendPrompt, onReadIteration, previousFeedback });
      if (!fence(s, j)) return false;
      if (!result || typeof result.text !== 'string' || result.text.length > LIMIT) throw new Error('invalid_review');
      const auto = automaticCorrections === true && instruction.automaticCorrections === true;
      if (auto && (!['ok', 'needs_correction', 'unknown'].includes(result.verdict)
        || (result.verdict === 'needs_correction' ? typeof result.correctionPrompt !== 'string' || !result.correctionPrompt.trim() || result.correctionPrompt.length > 16000
          : result.correctionPrompt !== undefined && result.correctionPrompt !== ''))) throw new Error('invalid_automatic_review');
      // Publish the real critique before the application forwards it. The
      // model never gets a sender or recipient tool; the old writer fence owns
      // the one effect. Unknown delivery is never a reason to replay it.
      const finishedAt = Date.now();
      const reviewMeta = { ...s.activeReview, requestedModel: instruction.model || '',
        model: result.actualModel || instruction.model || '', modelSource: result.actualModel ? 'response' : 'request',
        finishedAt, durationMs: Math.max(0, finishedAt - startedAt) };
      s.entries.push({ id: uuid(), type: 'review', text: result.text, reviewMeta, round }); delete s.activeReview; changed(s);
      if (auto && result.verdict === 'needs_correction') {
        const prompt = 'Автоматическое замечание проверяющего к вашему предыдущему ответу; это не новое поручение пользователя. '
          + 'Продолжай исходную задачу в прежних границах. Проверь замечание по фактам; неподтверждённые пункты не выполняй слепо.\n\n'
          + result.correctionPrompt;
        const receipt = await onSendPrompt(prompt);
        if (!fence(s, j)) return false;
        if (['no_review_progress', 'duplicate_feedback'].includes(receipt.error)) s.correctionState = 'no-progress';
      }
      if (!record.attempted) record.settled = true;
      try { persist(tabId, clone(s.ledger)); } catch { j.persistFailed = true; s.error = 'persist_failed'; }
      s.phase = j.persistFailed ? 'error' : record.receipt && record.receipt.status === 'unknown' ? 'unknown' : 'complete'; s.job = null; changed(s); return !j.persistFailed;
    } catch (e) {
      if (fence(s, j)) { s.phase = 'error'; s.error = String(e.message || e); s.job = null; delete s.activeReview; changed(s); }
      return false;
    }
  }
  function clear(tabId) { const s = state(tabId); if (s.job || s.phase === 'sending' || s.phase === 'reviewing') return false; s.entries = []; delete s.reviewSource; delete s.jobId; delete s.error; delete s.correctionState; s.phase = s.enabled ? 'idle' : 'off'; changed(s); return true; }
  function validateSend({ tabId, handoffId }) { const s = state(tabId), j = s.pendingSend || s.job; return !!(j && j.attempted && j.persistedAttempt && handoffId === 'mini-orchestrator:' + j.id && fence(s, j)); }
  // Adapters supply canonical normalized status: queued, sent, or unknown.
  function observeSendReceipt({ tabId, handoffId, receipt }) {
    const s = state(tabId), record = s.ledger.find(x => x.handoffId === handoffId);
    if (!record || !receipt || !['queued', 'sent', 'unknown', 'refused', 'no-input'].includes(receipt.status)) return false;
    record.receipt = clone(mergeReceipt(record.receipt, receipt)); record.settled = !!terminalReceipt(record.receipt);
    if (terminalReceipt(record.receipt) && s.pendingSend && handoffId === 'mini-orchestrator:' + s.pendingSend.id) s.pendingSend = null;
    try { persist(tabId, clone(s.ledger)); } catch { s.ledgerError = 'persist_failed'; }
    const entry = s.entries.find(x => x.type === 'tool' && x.handoffId === handoffId);
    if (entry) { entry.receipt = clone(record.receipt); entry.status = record.receipt.status; }
    changed(s); return true;
  }
  function dispose() { disposed = true; for (const s of tabs.values()) invalidateJob(s); }
  return { snapshot, setEnabled, observeInput, beginTurn, complete, invalidate, invalidateReview, clear, validateSend, observeSendReceipt,
    refreshPresentation: tabId => changed(state(tabId)), dispose };
}

module.exports = { createMiniOrchestrator };
