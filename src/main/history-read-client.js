'use strict';

const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const { SLOTS, registerSourceEpochSlot } = require('./history-worker-epochs');
const { historyPreparationActivity } = require('./history-preparation-activity');
const { publishHistoryResponseTimingBinding } = require('./history-response-timings');
const { observeCodexProcessActionOwnership, getCodexProcessActionOwnershipSnapshot } = require('./codex-process-action-ownership');

const DIAGNOSTIC_SCHEMA = 1;
const diagnosticIdentity = value => {
  if (value == null || value === '') return null;
  const text = String(value);
  return /^[\w.:-]{1,80}$/.test(text) ? text : 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0,24);
};
const stamp = () => { const perf = performance.now(); return { abs: performance.timeOrigin + perf, perf }; };
const errorReason = error => error?.code === 'CODEX_SOURCE_READ_INVALIDATED' ? 'source-epoch-invalidated'
  : error?.message?.startsWith('history_worker_exit:') ? 'worker-exit'
  : error?.message === 'history_reader_closed' ? 'client-closed'
  : error?.message === 'history_worker_read_proof_missing' ? 'read-proof-missing'
  : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'request-error';

function splitHistoryReadBudget(totalBytes) {
  const total = Math.max(64 * 1024 * 1024, Number(totalBytes) || 400 * 1024 * 1024);
  const mainGraphBytes = Math.min(64 * 1024 * 1024, Math.floor(total / 4));
  const indexBytes = Math.min(32 * 1024 * 1024, Math.floor(total / 8));
  return { mainGraphBytes, indexBytes, workerGraphBytes: total - mainGraphBytes - indexBytes };
}

class HistoryReadClient {
  constructor({ codexData, getMemoryBudgetMb, onWindowEvent = () => {}, onAsset = () => {}, onDiagnostic = null, ...config }) {
    this.config = config; this.codexData = codexData; this.getMemoryBudgetMb = getMemoryBudgetMb;
    this.onWindowEvent = onWindowEvent; this.onAsset = onAsset;
    this.sequence = 0; this.pending = new Map(); this.leases = new Map();
    this.cacheMemory = { status: 'ready', graphBytes: 0, virtualBytes: 0, indexBytes: 0, generation: 0, reason: 'not-started' };
    this.clientId = randomUUID(); this.callSequence = 0; this.workerGeneration = 0;
    this.onDiagnostic = onDiagnostic;
    this.diagnosticSlowMs = Number.isFinite(config.diagnosticSlowMs) ? Math.max(0, config.diagnosticSlowMs) : 100;
    this.diagnosticCounters = { requests: 0, responses: 0, failures: 0, callErrors: 0, retries: 0, cancellations: 0, invalidations: 0, workerDeaths: 0 };
    this.sourceEpochs = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
    this.sourceEpochSlots = new Map();
    this.invalidations = []; this.invalidationSequence = 0;
    this.unsubscribe = codexData?._api?.observeCodexReadInvalidation?.(event => this.invalidate(event));
    this.unsubscribeOwnership = observeCodexProcessActionOwnership(payload => this.worker?.postMessage({ event: 'ownership', payload }));
  }
  count(name) { this.diagnosticCounters[name] = Math.min(Number.MAX_SAFE_INTEGER, this.diagnosticCounters[name] + 1); }
  diagnose(event, fields = {}) {
    const now = stamp();
    const diagnostic = { schema: DIAGNOSTIC_SCHEMA, side: 'main', event, clientId: this.clientId,
      workerGeneration: this.workerGeneration, emittedAbs: now.abs, emittedPerf: now.perf, ...fields };
    // Observers/logging are deliberately outside the read/proof contract.
    try { console.log('[HistoryRead] ' + JSON.stringify(diagnostic)); } catch {}
    try { this.onDiagnostic?.(diagnostic); } catch {}
  }
  start() {
    if (this.worker) return this.worker;
    const generation = ++this.workerGeneration;
    this.cacheMemory = { status: 'unknown', generation, reason: 'worker-starting' };
    const started = stamp();
    const worker = new Worker(path.join(__dirname, 'history-read-worker.js'), {
      workerData: { ...this.config, memoryBudgetMb: this.getMemoryBudgetMb?.() || this.config.memoryBudgetMb || 400,
        diagnosticClientId: this.clientId, diagnosticGeneration: generation, diagnosticSlowMs: this.diagnosticSlowMs,
        ownership: getCodexProcessActionOwnershipSnapshot(), sourceEpochBuffer: this.sourceEpochs.buffer },
    });
    this.worker = worker;
    this.diagnose('worker-start', { workerGeneration: generation, startAbs: started.abs, startPerf: started.perf,
      slowMs: this.diagnosticSlowMs, timing: 'elapsed-wall; worker phases nested in execution; never summed CPU',
      limits: { identityChars: 80, attempts: 3, invalidationHistory: 2048, phaseGroups: 16 },
      capabilities: ['request-correlation', 'session-queue', 'cold-admission', 'cache-phases', 'binary-byte-size', 'delivery'],
      structuredCloneBytes: 'unavailable-no-extra-serialization' });
    worker.on('message', message => {
      if (worker !== this.worker) return;
      if (message.event === 'cache-memory') {
        const snapshot = message.snapshot;
        const valid = ['graphBytes', 'virtualBytes', 'indexBytes'].every(key =>
          Number.isSafeInteger(snapshot?.[key]) && snapshot[key] >= 0);
        this.cacheMemory = valid ? { status: 'ready', graphBytes: snapshot.graphBytes,
          virtualBytes: snapshot.virtualBytes, indexBytes: snapshot.indexBytes, generation, reason: 'cache-counters' }
          : { status: 'unknown', generation, reason: 'invalid-counters' };
        return;
      }
      if (message.event === 'diagnostic') { this.diagnose(message.diagnostic.event, message.diagnostic); return; }
      if (message.event === 'source-epoch') {
        const slot = registerSourceEpochSlot(this.sourceEpochSlots, message.filePath);
        worker.postMessage({ event: 'source-epoch', filePath: message.filePath, slot }); return;
      }
      if (message.event === 'log') {
        const level = ['log', 'warn', 'error'].includes(message.level) ? message.level : 'log';
        const correlation = message.correlation ? ' correlation=' + JSON.stringify({ clientId: this.clientId, ...message.correlation }) : '';
        console[level]('[HistoryReadWorker] emitAbs=' + message.emittedAt + correlation + ' ' + message.text); return;
      }
      if (message.event === 'preparation') { this.updatePreparation(message.snapshot); return; }
      if (message.event === 'window') { this.onWindowEvent(message.channel, message.payload); return; }
      if (message.event === 'asset') { this.onAsset(message.ref); return; }
      if (message.event === 'assets') { for (const ref of message.refs) this.onAsset(ref); return; }
      if (message.event === 'timing-bound') { publishHistoryResponseTimingBinding(message.payload); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      const received = stamp();
      this.count('responses');
      if (message.error) this.count('failures');
      const diagnostic = message.diagnostic;
      const roundtripMs = received.perf - request.posted.perf;
      if (message.error || diagnostic?.exceptional || roundtripMs >= this.diagnosticSlowMs) {
        this.diagnose('rpc-response', { ...request.identity, outcome: message.error ? 'error' : 'received',
          reason: message.error ? errorReason(message.error) : undefined,
          postedAbs: request.posted.abs, postedPerf: request.posted.perf, receivedAbs: received.abs, receivedPerf: received.perf,
          roundtripMs, mainPostMessageMs: request.postMessageMs,
          inboundMs: diagnostic ? diagnostic.receivedAbs - request.posted.abs : null,
          sessionQueueMs: diagnostic?.sessionQueueMs ?? null, coldAdmissionMs: diagnostic?.coldAdmissionMs ?? null,
          workerExecutionMs: diagnostic?.executionMs ?? null, serializationMs: diagnostic?.serializationMs ?? null,
          // Starts BEFORE worker postMessage: includes cloning, transfer and main dispatch wait.
          deliveryMs: diagnostic ? received.abs - diagnostic.replyReadyAbs : null,
          resultBytes: diagnostic?.resultBytes ?? null, source: diagnostic?.source,
          counters: { ...this.diagnosticCounters } });
      }
      this.pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code,
        ...(typeof message.error.lineageReason === 'string' ? { lineageReason: message.error.lineageReason } : {}) }));
      else request.resolve({ value: message.result, readProof: message.readProof,
        reader: { clientId: this.clientId, generation: request.identity.workerGeneration } });
      if (!this.pending.size) worker.unref();
    });
    const fail = error => {
      if (worker !== this.worker) return;
      this.count('workerDeaths');
      this.diagnose('worker-death', { workerGeneration: generation, reason: errorReason(error), pending: this.pending.size });
      this.worker = null;
      this.cacheMemory = { status: 'unknown', generation, reason: 'worker-unavailable' };
      for (const request of this.pending.values()) {
        this.count('failures');
        this.diagnose('request-failed', { ...request.identity, reason: errorReason(error), roundtripMs: performance.now() - request.posted.perf });
        request.reject(error);
      }
      this.pending.clear(); this.updatePreparation({ operations: [] });
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error('history_worker_exit:' + code)));
    worker.unref();
    return worker;
  }
  updatePreparation(snapshot) {
    const current = new Set();
    for (const operation of snapshot.operations || []) {
      current.add(operation.id);
      if (!this.leases.has(operation.id)) this.leases.set(operation.id, historyPreparationActivity.begin({
        ...operation, bytes: operation.totalBytes,
      }));
      this.leases.get(operation.id).update({ completedBytes: operation.completedBytes, phase: operation.phase });
    }
    for (const [id, finish] of this.leases) if (!current.has(id)) { finish(); this.leases.delete(id); }
  }
  invalidate(event) {
    Atomics.add(this.sourceEpochs, 0, 1);
    const slot = this.sourceEpochSlots.get(event.filePath);
    if (slot) Atomics.add(this.sourceEpochs, slot, 1);
    this.invalidations.push({ ...event, sequence: ++this.invalidationSequence });
    if (this.invalidations.length > 2048) this.invalidations.shift();
    this.count('invalidations');
    this.diagnose('source-epoch-invalidation', { epoch: Atomics.load(this.sourceEpochs, 0), slot: slot || 0,
      reason: event.sourceAppend ? 'source-append' : event.readRefresh ? 'read-refresh' : 'source-change',
      sequence: this.invalidationSequence, pending: this.pending.size, counters: { ...this.diagnosticCounters } });
    this.worker?.postMessage({ event: 'invalidate', ...event });
  }
  lineageCommitted(sessionId) {
    // A new logical view can keep the same child bytes. Revoke an in-flight
    // reply in Main immediately; a queued worker cache notification alone is
    // not an admission fence. Do not invalidate unrelated owners' file caches.
    this.invalidations.push({ logicalSessionId: sessionId, sequence: ++this.invalidationSequence });
    if (this.invalidations.length > 2048) this.invalidations.shift();
    this.count('invalidations');
    this.diagnose('lineage-invalidation', { session: diagnosticIdentity(sessionId), sequence: this.invalidationSequence,
      pending: this.pending.size, reason: 'lineage-committed' });
    this.worker?.postMessage({ event: 'lineage', sessionId });
  }
  // Reuse the same bounded logical-admission journal for an already-built
  // Main graph. Physical fences remain with the actual Codex source reader.
  captureCodexLineageReadProof(sessionId) {
    return Object.freeze({ clientId: this.clientId, sessionId, sequence: this.invalidationSequence });
  }
  isCodexLineageReadProofCurrent(proof, sessionId) {
    return proof?.clientId === this.clientId && proof.sessionId === sessionId
      && Number.isSafeInteger(proof.sequence) && proof.sequence >= 0 && proof.sequence <= this.invalidationSequence
      && !(this.invalidations.length && proof.sequence < this.invalidations[0].sequence - 1)
      && !this.invalidations.some(event => event.sequence > proof.sequence && event.logicalSessionId === sessionId);
  }
  // Does not start a worker, enqueue RPC or read any transcript/cache file.
  getCacheMemorySnapshot() { return { ...this.cacheMemory }; }
  async call(method, payload = {}, binary = false) {
    const call = { callId: ++this.callSequence };
    const started = stamp();
    for (let attempt = 0; attempt < 3; attempt++) {
      call.attempt = attempt + 1;
      const before = this.invalidationSequence;
      let envelope;
      try { envelope = await this.request(method, payload, binary, call); }
      catch (error) {
        if (attempt < 2 && (error.code === 'CODEX_SOURCE_READ_INVALIDATED'
          || error.code === 'ERR_WORKER_OUT_OF_MEMORY' || error.message.startsWith('history_worker_exit:'))) {
          this.count('retries'); this.diagnose('request-retry', { ...call, reason: errorReason(error), nextAttempt: attempt + 2 }); continue;
        }
        this.count('callErrors');
        this.diagnose('call-complete', { ...call, outcome: 'error', reason: errorReason(error), elapsedMs: performance.now() - started.perf });
        throw error;
      }
      const result = envelope.value;
      const proof = result?.__notedHistoryTransport === 'v8-1' ? result.proof : result;
      if (proof?.error === 'history_source_changed_during_preparation') {
        if (attempt < 2) this.count('retries');
        this.diagnose(attempt < 2 ? 'request-retry' : 'request-revoked', { ...call,
          reason: 'source-changed-during-preparation', nextAttempt: attempt < 2 ? attempt + 2 : null }); continue;
      }
      const dependencies = envelope.readProof;
      if (!Array.isArray(dependencies)) {
        this.count('callErrors'); this.diagnose('call-complete', { ...call, outcome: 'error', reason: 'read-proof-missing' });
        throw new Error('history_worker_read_proof_missing');
      }
      const sources = new Set(dependencies.map(source => source.filePath));
      const admissionFailure = () => {
        if (dependencies.some(source => source.epoch !== Atomics.load(this.sourceEpochs, source.slot))) return 'source-epoch-invalidated';
        if (this.invalidations.length && before < this.invalidations[0].sequence - 1) return 'invalidation-history-overflow';
        if (this.invalidations.some(e => e.sequence > before && (e.logicalSessionId !== undefined
          ? e.logicalSessionId === payload.sessionId : !e.filePath || sources.has(e.filePath)))) return 'source-invalidation';
        return null;
      };
      let failure = admissionFailure();
      if (!failure) {
        const elapsedMs = performance.now() - started.perf;
        if (attempt || proof?.success === false || proof?.error || elapsedMs >= this.diagnosticSlowMs) this.diagnose('call-complete', {
          ...call, outcome: proof?.success === false || proof?.error ? 'result-error' : 'success', elapsedMs,
          admission: 'pending-final-check',
          startAbs: started.abs, startPerf: started.perf, counters: { ...this.diagnosticCounters } });
        // A diagnostic observer is synchronous application code. It may
        // revoke this source/owner, including by overflowing the bounded log.
        // No observer or await is permitted after this final admission.
        failure = admissionFailure();
        // Public freshness is bound to the reader that produced this result,
        // not whichever worker happens to exist when HTTP publishes it.
        if (!failure) return method === 'getHistory' && payload.freshnessProof === true && !binary && result?.success
          ? { ...result, freshnessReader: envelope.reader } : result;
      }
      if (attempt < 2) this.count('retries');
      this.diagnose(attempt < 2 ? 'request-retry' : 'request-revoked', { ...call,
        reason: failure,
        nextAttempt: attempt < 2 ? attempt + 2 : null, dependencies: dependencies.length });
    }
    this.count('callErrors');
    this.diagnose('call-complete', { ...call, outcome: 'retry-exhausted', reason: 'source-changed-during-preparation', elapsedMs: performance.now() - started.perf });
    return { success: false, error: 'history_source_changed_during_preparation', entries: [] };
  }
  request(method, payload, binary = false, call = { callId: ++this.callSequence, attempt: 1 }) {
    const worker = this.start(); const id = ++this.sequence;
    Object.assign(call, { requestId: id, workerGeneration: this.workerGeneration, method: diagnosticIdentity(method),
      tool: diagnosticIdentity(payload.toolType), tab: diagnosticIdentity(payload.tabId), session: diagnosticIdentity(payload.sessionId),
      diagnosticActionId: typeof payload.diagnosticActionId === 'string' && /^[a-z0-9-]{1,90}$/.test(payload.diagnosticActionId)
        ? payload.diagnosticActionId : undefined,
      diagnosticReadId: typeof payload.diagnosticReadId === 'string' && /^[a-z0-9-]{1,90}$/.test(payload.diagnosticReadId)
        ? payload.diagnosticReadId : undefined });
    const identity = { ...call };
    const rewriteReceipt = payload.rewriteFrom?.sessionId
      ? this.codexData?._api?.getCodexRewriteReceipt?.(payload.sessionId, payload.rewriteFrom.sessionId) : null;
    return new Promise((resolve, reject) => {
      const posted = stamp(); const request = { resolve, reject, identity, posted };
      this.count('requests');
      this.pending.set(id, request); worker.ref();
      try { worker.postMessage({ id, method, payload, rewriteReceipt, binary, diagnostic: identity });
        request.postMessageMs = performance.now() - posted.perf; }
      catch (error) {
        this.count('failures');
        this.diagnose('request-failed', { ...identity, reason: 'post-message-error', errorCode: errorReason(error) });
        this.pending.delete(id); reject(error);
      }
    });
  }
  async close() {
    this.unsubscribe?.(); this.unsubscribeOwnership?.();
    const worker = this.worker;
    this.worker = null;
    this.cacheMemory = { status: 'unknown', generation: this.workerGeneration, reason: 'client-closed' };
    for (const request of this.pending.values()) {
      this.count('cancellations'); this.diagnose('request-cancelled', { ...request.identity, reason: 'client-closed',
        roundtripMs: performance.now() - request.posted.perf });
      request.reject(new Error('history_reader_closed'));
    }
    this.pending.clear(); this.updatePreparation({ operations: [] });
    await worker?.terminate();
  }
}

module.exports = { HistoryReadClient, splitHistoryReadBudget };
