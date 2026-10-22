'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createHistoryProcessTransport } = require('./history-read-process-transport');
const { createProcessEpochOwner } = require('./history-process-epochs');
const { createReadControl, currentReadControl, historyReadCancelled, isHistoryReadCancelled, isHistoryReadUnavailable } = require('./history-read-control');
const { HistoryByteReceiver } = require('./history-byte-stream');
const { streamLimits } = require('./history-stream-codec');
const { httpReadCorrelation } = require('./http-read-diagnostics');
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
const readerClosed = () => Object.assign(historyReadCancelled('reader-client-closed'), { message: 'history_reader_closed' });
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
  constructor({ codexData, getMemoryBudgetMb, onWindowEvent = () => {}, onAsset = () => {}, onDiagnostic = null,
    createTransport = createHistoryProcessTransport, epochDirectory, ...config }) {
    this.config = config; this.codexData = codexData; this.getMemoryBudgetMb = getMemoryBudgetMb;
    this.onWindowEvent = onWindowEvent; this.onAsset = onAsset;
    this.createTransport = createTransport; this.epochDirectory = epochDirectory; this.closed = false;
    this.sequence = 0; this.pending = new Map(); this.leases = new Map();
    this.cacheMemory = { status: 'ready', graphBytes: 0, virtualBytes: 0, indexBytes: 0, generation: 0, reason: 'not-started' };
    this.clientId = randomUUID(); this.callSequence = 0; this.workerGeneration = 0;
    this.onDiagnostic = onDiagnostic;
    this.diagnosticSlowMs = Number.isFinite(config.diagnosticSlowMs) ? Math.max(0, config.diagnosticSlowMs) : 100;
    this.diagnosticCounters = { requests: 0, responses: 0, failures: 0, callErrors: 0, retries: 0, cancellations: 0, invalidations: 0, workerDeaths: 0 };
    this.readPhaseWindow = { at: -Infinity, count: 0, omitted: 0 };
    this.sourceEpochs = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
    this.sourceRewriteEpochs = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
    this.snapshotAdmissions = new WeakMap();
    this.sourceEpochSlots = new Map();
    this.invalidations = []; this.invalidationSequence = 0;
    this.unsubscribe = codexData?._api?.observeCodexReadInvalidation?.(event => this.invalidate(event));
    this.unsubscribeOwnership = observeCodexProcessActionOwnership(payload => this.postWorkerEvent({ event: 'ownership', payload }));
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
  readPhase(event, fields) {
    if (!fields?.httpRead && this.config.diagnosticReadPhases !== true) return;
    const window = this.readPhaseWindow, now = performance.now();
    if (now - window.at >= 60000) { window.at = now; window.count = 0; }
    if (window.count >= 240) { window.omitted++; return; }
    window.count++; this.diagnose(event, fields);
  }
  start() {
    if (this.closed) throw readerClosed();
    if (this.worker) {
      if (this.workerUnavailable) throw this.workerUnavailable;
      return this.worker;
    }
    const generation = ++this.workerGeneration;
    this.cacheMemory = { status: 'unknown', generation, reason: 'worker-starting' };
    const started = stamp();
    const epochOwner = createProcessEpochOwner({ sourceEpochs: this.sourceEpochs, sourceRewriteEpochs: this.sourceRewriteEpochs,
      ...(this.epochDirectory ? { directory: this.epochDirectory } : {}) });
    let worker;
    try { worker = this.createTransport({ ...this.config, memoryBudgetMb: this.getMemoryBudgetMb?.() || this.config.memoryBudgetMb || 400,
        diagnosticClientId: this.clientId, diagnosticGeneration: generation, diagnosticSlowMs: this.diagnosticSlowMs,
        ownership: getCodexProcessActionOwnershipSnapshot(), sourceEpochFile: epochOwner.filePath }); }
    catch (error) { // Factory contract: no returned handle means no launched child.
      try { epochOwner.disposeAfterExit(); } catch {}
      if (isHistoryReadUnavailable(error)) throw error;
      throw Object.assign(new Error('History reader process initialization unavailable'), {
        code: 'HISTORY_READER_TRANSPORT_UNKNOWN', cause: error });
    }
    this.worker = worker; this.epochOwner = epochOwner; this.workerUnavailable = null;
    this.diagnose('worker-start', { workerGeneration: generation, startAbs: started.abs, startPerf: started.perf,
      slowMs: this.diagnosticSlowMs, timing: 'elapsed-wall; worker phases nested in execution; never summed CPU',
      limits: { identityChars: 80, attempts: 3, invalidationHistory: 2048, phaseGroups: 16 },
      capabilities: ['request-correlation', 'session-queue', 'cold-admission', 'cache-phases', 'binary-byte-size', 'delivery'],
      structuredCloneBytes: 'unavailable-no-extra-serialization' });
    worker.on('message', message => {
      if (worker !== this.worker || this.workerUnavailable || this.closed) return;
      if (message.event === 'cache-memory') {
        const snapshot = message.snapshot;
        const valid = ['graphBytes', 'virtualBytes', 'indexBytes'].every(key =>
          Number.isSafeInteger(snapshot?.[key]) && snapshot[key] >= 0);
        this.cacheMemory = valid ? { status: 'ready', graphBytes: snapshot.graphBytes,
          virtualBytes: snapshot.virtualBytes, indexBytes: snapshot.indexBytes, generation, reason: 'cache-counters' }
          : { status: 'unknown', generation, reason: 'invalid-counters' };
        return;
      }
      if (message.event === 'diagnostic') {
        const received = stamp();
        this.diagnose(message.diagnostic.event, { ...message.diagnostic,
          mainReceivedAbs: received.abs, mainReceivedPerf: received.perf }); return;
      }
      if (message.event === 'source-epoch') {
        this.readPhase('source-epoch-registration-begin', message.diagnostic || {});
        if (worker !== this.worker) return;
        const slot = registerSourceEpochSlot(this.sourceEpochSlots, message.filePath);
        this.postWorkerEvent({ event: 'source-epoch', filePath: message.filePath, slot });
        this.readPhase('source-epoch-registration-posted', message.diagnostic || {}); return;
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
      if (!request) { if (message.id) this.postWorkerEvent({ event: 'reply-consumed', id: message.id }); return; }
      if (request.stream && message.event?.startsWith('stream-')) {
        request.stream.accept(message); return;
      }
      request.terminalReceived = true;
      const received = stamp();
      this.readPhase('rpc-received', { ...request.identity, receivedAbs: received.abs,
        receivedPerf: received.perf, resultBytes: message.diagnostic?.resultBytes ?? null });
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
      if (message.error) request.finish(Object.assign(new Error(message.error.message), { code: message.error.code,
        ...(typeof message.error.lineageReason === 'string' ? { lineageReason: message.error.lineageReason } : {}) }));
      else request.finish(null, { value: message.result, readProof: message.readProof,
        reader: { clientId: this.clientId, generation: request.identity.workerGeneration } });
    });
    const fail = (error, provenExit = false) => {
      if (provenExit) { try { epochOwner.disposeAfterExit(); } catch {} }
      if (worker !== this.worker) return;
      if (provenExit && !this.closed) this.count('workerDeaths');
      this.workerUnavailable = error;
      this.diagnose(provenExit ? (this.closed ? 'worker-closed' : 'worker-death') : 'worker-unavailable', { workerGeneration: generation,
        reason: provenExit && this.closed ? 'client-closed' : errorReason(error), pending: this.pending.size, provenExit });
      if (provenExit) { this.worker = null; this.epochOwner = null; }
      this.cacheMemory = { status: 'unknown', generation, reason: provenExit ? 'process-exited' : 'process-state-unknown' };
      for (const request of this.pending.values()) {
        this.count('failures');
        this.diagnose('request-failed', { ...request.identity, reason: errorReason(error), roundtripMs: performance.now() - request.posted.perf });
        request.finish(error);
      }
      this.pending.clear();
      if (provenExit) this.updatePreparation({ operations: [] });
    };
    this.failWorker = error => fail(error, false);
    worker.on('error', error => fail(error, false));
    worker.on('exit', code => fail(Object.assign(new Error('history_worker_exit:' + code), { code: 'HISTORY_READER_PROCESS_EXITED' }), true));
    worker.unref();
    return worker;
  }
  postWorkerEvent(message) {
    if (!this.worker || this.workerUnavailable) return;
    try { this.worker.postMessage(message); }
    catch (error) { this.failWorker?.(Object.assign(new Error('History reader transport unavailable'), {
      code: 'HISTORY_READER_TRANSPORT_UNKNOWN', cause: error })); }
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
    if (!event.filePath || event.sourceAppend !== true || event.readRefresh === true) {
      Atomics.add(this.sourceRewriteEpochs, 0, 1);
      if (slot) Atomics.add(this.sourceRewriteEpochs, slot, 1);
    }
    // Synchronous, authoritative fence first; a queued IPC invalidation is
    // merely cache maintenance and cannot stand in for a shared epoch.
    if (this.epochOwner) try { this.epochOwner.publish([0, ...(slot ? [slot] : [])]); }
    catch (error) { this.failWorker?.(error); }
    this.invalidations.push({ ...event, sequence: ++this.invalidationSequence });
    if (this.invalidations.length > 2048) this.invalidations.shift();
    this.count('invalidations');
    this.diagnose('source-epoch-invalidation', { epoch: Atomics.load(this.sourceEpochs, 0), slot: slot || 0,
      reason: event.sourceAppend ? 'source-append' : event.readRefresh ? 'read-refresh' : 'source-change',
      sequence: this.invalidationSequence, pending: this.pending.size, counters: { ...this.diagnosticCounters } });
    this.postWorkerEvent({ event: 'invalidate', ...event });
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
    this.postWorkerEvent({ event: 'lineage', sessionId });
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
  getReadDiagnosticHealth() {
    let processPid=null;try{const value=this.worker?.pid;if(Number.isSafeInteger(value)&&value>1)processPid=value;}catch{}
    return { clientId: this.clientId, generation: this.workerGeneration,processPid,
    processState: this.workerUnavailable && this.worker ? 'unknown' : this.worker ? (this.closed ? 'closing' : 'available') : this.closed ? 'closed' : 'not-running',
    pending: this.pending.size, counters: { ...this.diagnosticCounters }, readPhaseOmitted: this.readPhaseWindow.omitted,
    readPhaseLimitPerMinute: 240, coverage: 'worker messages forwarded by Main; silence is unknown' }; }
  async prepareCodexRewrite({ receipt, cwd }) {
    return this.call('prepareCodexRewrite', { toolType: 'codex', sessionId: receipt.sessionId, cwd,
      rewriteFrom: { sessionId: receipt.sourceSessionId } }, false, receipt);
  }
  async openStream(method, payload = {}, options = {}) {
    const limits = streamLimits(options);
    const format = options.format || 'json';
    if (!['json', 'ndjson'].includes(format)) throw new TypeError('history_stream_format_invalid');
    const projection = options.projection || null;
    if (projection !== null && projection !== 'history-entries') throw new TypeError('history_stream_projection_invalid');
    const inherited = options._readControl || options.control || currentReadControl();
    const control = inherited || createReadControl({ signal: options.signal });
    control.assertCurrent();
    if (options.signal?.aborted) throw historyReadCancelled();
    const worker = this.start(), generation = this.workerGeneration, id = ++this.sequence;
    const before = this.invalidationSequence;
    const posted = stamp();
    const httpRead = httpReadCorrelation();
    const identity = { callId: ++this.callSequence, requestId: id, attempt: 1, workerGeneration: generation,
      method: diagnosticIdentity(method), tool: diagnosticIdentity(payload.toolType),
      tab: diagnosticIdentity(payload.tabId), session: diagnosticIdentity(payload.sessionId), ...(httpRead ? { httpRead } : {}) };
    const request = { identity, posted, sent: false, done: false, stream: null };
    let removeSettled;
    const signals = [...new Set([options.signal, control.signal].filter(Boolean))];
    const cleanup = error => {
      if (request.done) return;
      request.done = true; for (const signal of signals) signal.removeEventListener('abort', abort); removeSettled?.();
      if (this.pending.get(id) === request) this.pending.delete(id);
      if (!this.pending.size) worker.unref();
      if (!inherited) control.finish();
      this.count(error ? 'failures' : 'responses');
      this.diagnose('stream-complete', { ...identity, outcome: error ? 'error' : 'success',
        reason: error ? errorReason(error) : undefined, elapsedMs: performance.now() - posted.perf,
        ...receiver.stats, transport: 'byte-credit-process-copy' });
    };
    const assertCurrent = () => {
      control.assertCurrent();
      if (signals.some(signal => signal.aborted)) throw historyReadCancelled();
      if (this.closed) throw readerClosed();
      if (this.workerUnavailable || this.epochOwner?.available === false) throw this.workerUnavailable
        || Object.assign(new Error('History source fence unavailable'), { code: 'HISTORY_READER_FENCE_UNAVAILABLE' });
      if (worker !== this.worker || generation !== this.workerGeneration) throw Object.assign(
        new Error('History reader process generation changed'), { code: 'HISTORY_READER_PROCESS_EXITED' });
      const dependencies = receiver.readProof;
      if (!Array.isArray(dependencies) || dependencies.some(source => !Number.isInteger(source?.slot)
        || source.slot < 0 || source.slot >= SLOTS || !Number.isInteger(source.epoch) || typeof source.filePath !== 'string')) {
        throw new Error('history_worker_read_proof_missing');
      }
      const snapshot = method === 'readSessionSnapshot', epochs = snapshot ? this.sourceRewriteEpochs : this.sourceEpochs;
      if (dependencies.some(source => source.epoch !== Atomics.load(epochs, source.slot))
        || this.invalidations.length && before < this.invalidations[0].sequence - 1
        || this.invalidations.some(event => event.sequence > before && (event.logicalSessionId !== undefined
          ? event.logicalSessionId === payload.sessionId : (!event.filePath || dependencies.some(source => source.filePath === event.filePath))
            && !(snapshot && event.filePath && event.sourceAppend === true && event.readRefresh !== true)))) {
        throw Object.assign(new Error('History stream source invalidated'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      }
    };
    const receiver = new HistoryByteReceiver({ id, ...limits, assertCurrent, onSettled: cleanup,
      send: message => {
        if (worker !== this.worker || this.workerUnavailable) throw this.workerUnavailable || readerClosed();
        worker.postMessage(message);
      } });
    receiver.assertCurrent = assertCurrent;
    receiver.reader = Object.freeze({ clientId: this.clientId, generation });
    request.stream = receiver;
    request.finish = error => {
      // Before stream-open, ordinary worker errors still use the terminal RPC
      // envelope and need the M1 reply-consumed acknowledgement.
      if (request.terminalReceived && worker === this.worker) this.postWorkerEvent({ event: 'reply-consumed', id });
      receiver.fail(error || Object.assign(new Error('Unexpected History stream reply'), { code: 'HISTORY_STREAM_PROTOCOL_INVALID' }));
    };
    const abort = () => { this.count('cancellations'); receiver.fail(historyReadCancelled()); };
    this.pending.set(id, request); worker.ref(); this.count('requests');
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    removeSettled = control.onSettled(() => receiver.close());
    try {
      control.assertCurrent();
      if (signals.some(signal => signal.aborted)) throw historyReadCancelled();
      const { _readControl, ...wirePayload } = payload;
      const rewriteReceipt = payload.rewriteFrom?.sessionId
        ? this.codexData?._api?.getCodexRewriteReceipt?.(payload.sessionId, payload.rewriteFrom.sessionId) : null;
      request.sent = true;
      worker.postMessage({ id, method, payload: wirePayload, rewriteReceipt, diagnostic: identity,
        stream: { ...limits, format, projection, payloadPolicy: options.payloadPolicy || null } });
      request.postMessageMs = performance.now() - posted.perf;
    } catch (error) { receiver.fail(error); }
    // No retry once a stream is created. Revocation/disconnect/UNKNOWN remain
    // distinct terminal observations; another read must have a live caller.
    return receiver.ready;
  }
  async call(method, payload = {}, binary = false, preparedRewriteReceipt = null, options = {}) {
    const control = options._readControl || options.control || (options.signal ? createReadControl({ signal: options.signal }) : currentReadControl());
    const retainToConsumer = options.signal && !options._readControl && !options.control ? null : control;
    control?.assertCurrent();
    // Trace stays exclusively in the existing RPC diagnostic envelope. The
    // business payload/fingerprint/readScope is never copied or amended.
    const httpRead = httpReadCorrelation();
    const call = { callId: ++this.callSequence, ...(httpRead ? { httpRead } : {}) };
    const started = stamp();
    const snapshot = method === 'readSessionSnapshot', attempts = snapshot ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      control?.assertCurrent();
      call.attempt = attempt + 1;
      const before = this.invalidationSequence;
      let envelope, admitted = false;
      try {
      try { envelope = await this.request(method, payload, binary, call, preparedRewriteReceipt, { control }); }
      catch (error) {
        control?.assertCurrent();
        if (!isHistoryReadCancelled(error) && attempt + 1 < attempts && error.code === 'CODEX_SOURCE_READ_INVALIDATED') {
          this.count('retries'); this.diagnose('request-retry', { ...call, reason: errorReason(error), nextAttempt: attempt + 2 }); continue;
        }
        this.count('callErrors');
        this.diagnose('call-complete', { ...call, outcome: 'error', reason: errorReason(error), elapsedMs: performance.now() - started.perf });
        throw error;
      }
      control?.assertCurrent();
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
        control?.assertCurrent();
        if (this.workerUnavailable || this.epochOwner?.available === false) throw this.workerUnavailable
          || Object.assign(new Error('History source fence unavailable'), { code: 'HISTORY_READER_FENCE_UNAVAILABLE' });
        if (snapshot && (this.workerGeneration !== envelope.reader?.generation || !this.worker)) return 'worker-generation-changed';
        const epochs = snapshot ? this.sourceRewriteEpochs : this.sourceEpochs;
        if (dependencies.some(source => source.epoch !== Atomics.load(epochs, source.slot))) return 'source-epoch-invalidated';
        if (this.invalidations.length && before < this.invalidations[0].sequence - 1) return 'invalidation-history-overflow';
        if (this.invalidations.some(e => e.sequence > before && (e.logicalSessionId !== undefined
          ? e.logicalSessionId === payload.sessionId : (!e.filePath || sources.has(e.filePath))
            && !(snapshot && e.filePath && e.sourceAppend === true && e.readRefresh !== true)))) return 'source-invalidation';
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
        if (!failure) {
          if (snapshot && result?.success) this.snapshotAdmissions.set(result, admissionFailure);
          // Timeline can legitimately be followed by a History read inside
          // one HTTP consumer. Only the terminal full History result retains
          // the cold lane to that consumer's transport settlement.
          admitted = true; envelope.retainReader?.(method === 'getHistory' ? retainToConsumer : null);
          return method === 'getHistory' && payload.freshnessProof === true && !binary && result?.success
            ? { ...result, freshnessReader: envelope.reader } : result;
        }
      }
      if (snapshot) throw Object.assign(new Error('History snapshot invalidated before publication'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      if (attempt < 2) this.count('retries');
      this.diagnose(attempt < 2 ? 'request-retry' : 'request-revoked', { ...call,
        reason: failure,
        nextAttempt: attempt < 2 ? attempt + 2 : null, dependencies: dependencies.length });
      } finally { if (!admitted) envelope?.releaseReader?.(); }
    }
    this.count('callErrors');
    this.diagnose('call-complete', { ...call, outcome: 'retry-exhausted', reason: 'source-changed-during-preparation', elapsedMs: performance.now() - started.perf });
    return { success: false, error: 'history_source_changed_during_preparation', entries: [] };
  }
  assertSnapshotCurrent(result) {
    const guard = this.snapshotAdmissions.get(result);
    if (!guard || guard()) throw Object.assign(new Error('History snapshot invalidated before publication'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  }
  request(method, payload, binary = false, call = { callId: ++this.callSequence, attempt: 1 }, preparedRewriteReceipt = null, options = {}) {
    const control = options.control || options._readControl || (options.signal ? createReadControl({ signal: options.signal }) : currentReadControl());
    try { control?.assertCurrent(); } catch (error) { return Promise.reject(error); }
    const worker = this.start(); const id = ++this.sequence;
    Object.assign(call, { requestId: id, workerGeneration: this.workerGeneration, method: diagnosticIdentity(method),
      tool: diagnosticIdentity(payload.toolType), tab: diagnosticIdentity(payload.tabId), session: diagnosticIdentity(payload.sessionId),
      diagnosticActionId: typeof payload.diagnosticActionId === 'string' && /^[a-z0-9-]{1,90}$/.test(payload.diagnosticActionId)
        ? payload.diagnosticActionId : undefined,
      diagnosticReadId: typeof payload.diagnosticReadId === 'string' && /^[a-z0-9-]{1,90}$/.test(payload.diagnosticReadId)
        ? payload.diagnosticReadId : undefined });
    const identity = { ...call };
    const rewriteReceipt = preparedRewriteReceipt || (payload.rewriteFrom?.sessionId
      ? this.codexData?._api?.getCodexRewriteReceipt?.(payload.sessionId, payload.rewriteFrom.sessionId) : null);
    return new Promise((resolve, reject) => {
      const posted = stamp(); const request = { identity, posted, sent: false, done: false };
      const signal = control?.signal;
      let acknowledged = false;
      const acknowledge = () => {
        if (acknowledged || !request.terminalReceived) return;
        acknowledged = true; signal?.removeEventListener('abort', acknowledge);
        if (worker === this.worker) this.postWorkerEvent({ event: 'reply-consumed', id });
      };
      request.finish = (error, value) => {
        if (request.done) return;
        request.done = true; signal?.removeEventListener('abort', abort);
        if (this.pending.get(id) === request) this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        if (error) { acknowledge(); reject(error); }
        else {
          resolve({ ...value, releaseReader: acknowledge, retainReader: owner => {
            if (owner?.onSettled) {
              owner.onSettled(acknowledge);
              if (!acknowledged) signal?.addEventListener('abort', acknowledge, { once: true });
              if (signal?.aborted) acknowledge();
            } else acknowledge();
          } });
        }
      };
      const abort = () => {
        if (request.done) return;
        this.count('cancellations');
        request.finish(historyReadCancelled());
        if (request.sent && worker === this.worker) this.postWorkerEvent({ event: 'cancel', id });
        this.diagnose('request-cancelled', { ...identity, reason: 'consumer-revoked',
          roundtripMs: performance.now() - posted.perf });
      };
      this.count('requests');
      this.pending.set(id, request); worker.ref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.readPhase('rpc-post', { ...identity, postedAbs: posted.abs, postedPerf: posted.perf, pending: this.pending.size });
      // A synchronous observer can close the client; it cannot grant a late post.
      if (worker !== this.worker || this.pending.get(id) !== request) {
        request.finish(readerClosed()); return;
      }
      try { control?.assertCurrent();
        // Internal capabilities never become structured-clone business data.
        const { _readControl, ...wirePayload } = payload;
        request.sent = true;
        worker.postMessage({ id, method, payload: wirePayload, rewriteReceipt, binary, diagnostic: identity });
        request.postMessageMs = performance.now() - posted.perf; }
      catch (error) {
        this.count('failures');
        this.diagnose('request-failed', { ...identity, reason: 'post-message-error', errorCode: errorReason(error) });
        request.finish(error);
      }
    });
  }
  async close() {
    this.closed = true;
    this.unsubscribe?.(); this.unsubscribeOwnership?.();
    const worker = this.worker;
    this.cacheMemory = { status: 'unknown', generation: this.workerGeneration, reason: worker ? 'process-closing' : 'client-closed' };
    for (const request of this.pending.values()) {
      this.count('cancellations'); this.diagnose('request-cancelled', { ...request.identity, reason: 'client-closed',
        roundtripMs: performance.now() - request.posted.perf });
      if (request.sent) this.postWorkerEvent({ event: 'cancel', id: request.identity.requestId });
      request.finish(readerClosed());
    }
    this.pending.clear();
    if (!worker) { this.updatePreparation({ operations: [] }); return; }
    // A requested kill/closed client is not proof of process death. Keep the
    // generation, epoch file and observed preparation until the exit event.
    try { await worker.terminate(); }
    catch (cause) {
      const error = Object.assign(new Error('History reader termination unproven'), {
        code: 'HISTORY_READER_TRANSPORT_UNKNOWN', cause });
      this.failWorker?.(error);
      throw error;
    }
  }
}

module.exports = { HistoryReadClient, splitHistoryReadBudget };
