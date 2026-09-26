'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { SLOTS, registerSourceEpochSlot } = require('./history-worker-epochs');
const { historyPreparationActivity } = require('./history-preparation-activity');
const { publishHistoryResponseTimingBinding } = require('./history-response-timings');
const { observeCodexProcessActionOwnership, getCodexProcessActionOwnershipSnapshot } = require('./codex-process-action-ownership');

function splitHistoryReadBudget(totalBytes) {
  const total = Math.max(64 * 1024 * 1024, Number(totalBytes) || 400 * 1024 * 1024);
  const mainGraphBytes = Math.min(64 * 1024 * 1024, Math.floor(total / 4));
  const indexBytes = Math.min(32 * 1024 * 1024, Math.floor(total / 8));
  return { mainGraphBytes, indexBytes, workerGraphBytes: total - mainGraphBytes - indexBytes };
}

class HistoryReadClient {
  constructor({ codexData, getMemoryBudgetMb, onWindowEvent = () => {}, onAsset = () => {}, ...config }) {
    this.config = config; this.codexData = codexData; this.getMemoryBudgetMb = getMemoryBudgetMb;
    this.onWindowEvent = onWindowEvent; this.onAsset = onAsset;
    this.sequence = 0; this.pending = new Map(); this.leases = new Map();
    this.sourceEpochs = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
    this.sourceEpochSlots = new Map();
    this.invalidations = []; this.invalidationSequence = 0;
    this.unsubscribe = codexData?._api?.observeCodexReadInvalidation?.(event => this.invalidate(event));
    this.unsubscribeOwnership = observeCodexProcessActionOwnership(payload => this.worker?.postMessage({ event: 'ownership', payload }));
  }
  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, 'history-read-worker.js'), {
      workerData: { ...this.config, memoryBudgetMb: this.getMemoryBudgetMb?.() || this.config.memoryBudgetMb || 400,
        ownership: getCodexProcessActionOwnershipSnapshot(), sourceEpochBuffer: this.sourceEpochs.buffer },
    });
    this.worker = worker;
    worker.on('message', message => {
      if (worker !== this.worker) return;
      if (message.event === 'source-epoch') {
        const slot = registerSourceEpochSlot(this.sourceEpochSlots, message.filePath);
        worker.postMessage({ event: 'source-epoch', filePath: message.filePath, slot }); return;
      }
      if (message.event === 'log') {
        const level = ['log', 'warn', 'error'].includes(message.level) ? message.level : 'log';
        console[level]('[HistoryReadWorker] emitAbs=' + message.emittedAt + ' ' + message.text); return;
      }
      if (message.event === 'preparation') { this.updatePreparation(message.snapshot); return; }
      if (message.event === 'window') { this.onWindowEvent(message.channel, message.payload); return; }
      if (message.event === 'asset') { this.onAsset(message.ref); return; }
      if (message.event === 'assets') { for (const ref of message.refs) this.onAsset(ref); return; }
      if (message.event === 'timing-bound') { publishHistoryResponseTimingBinding(message.payload); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else request.resolve({ value: message.result, readProof: message.readProof });
      if (!this.pending.size) worker.unref();
    });
    const fail = error => {
      if (worker !== this.worker) return;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(error);
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
    this.worker?.postMessage({ event: 'invalidate', ...event });
  }
  lineageCommitted(sessionId) { this.worker?.postMessage({ event: 'lineage', sessionId }); }
  async call(method, payload = {}, binary = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = this.invalidationSequence;
      let envelope;
      try { envelope = await this.request(method, payload, binary); }
      catch (error) {
        if (attempt < 2 && (error.code === 'CODEX_SOURCE_READ_INVALIDATED'
          || error.code === 'ERR_WORKER_OUT_OF_MEMORY' || error.message.startsWith('history_worker_exit:'))) continue;
        throw error;
      }
      const result = envelope.value;
      const proof = result?.__notedHistoryTransport === 'v8-1' ? result.proof : result;
      if (proof?.error === 'history_source_changed_during_preparation') continue;
      const dependencies = envelope.readProof;
      if (!Array.isArray(dependencies)) throw new Error('history_worker_read_proof_missing');
      const sources = new Set(dependencies.map(source => source.filePath));
      const revoked = dependencies.some(source => source.epoch !== Atomics.load(this.sourceEpochs, source.slot));
      const logLost = this.invalidations.length && before < this.invalidations[0].sequence - 1;
      if (!revoked && !logLost && !this.invalidations.some(e => e.sequence > before && (!e.filePath || sources.has(e.filePath)))) return result;
    }
    return { success: false, error: 'history_source_changed_during_preparation', entries: [] };
  }
  request(method, payload, binary = false) {
    const worker = this.start(); const id = ++this.sequence;
    const rewriteReceipt = payload.rewriteFrom?.sessionId
      ? this.codexData?._api?.getCodexRewriteReceipt?.(payload.sessionId, payload.rewriteFrom.sessionId) : null;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); worker.ref();
      try { worker.postMessage({ id, method, payload, rewriteReceipt, binary }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    this.unsubscribe?.(); this.unsubscribeOwnership?.();
    const worker = this.worker;
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error('history_reader_closed'));
    this.pending.clear(); this.updatePreparation({ operations: [] });
    await worker?.terminate();
  }
}

module.exports = { HistoryReadClient, splitHistoryReadBudget };
