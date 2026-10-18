'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// A bounded transport for diagnostic artifacts. Raw buffers move to the worker;
// they are not JSON-stringified or cloned into an unbounded Promise queue.
function createTerminalRawWindowWriter({ directory, maxQueuedBytes = 8 * 1024 * 1024,
  maxQueuedMessages = 128, workerFactory, log = () => {} } = {}) {
  let worker = null, queuedBytes = 0, sequence = 0, failures = 0, omissions = 0, closed = false;
  const pending = new Map(), statuses = new Map(), drains = new Set(), staged = new Map(), losses = new Map();
  let stagedBytes = 0, closing = null;
  let publications = 0, suppressedPublications = 0, publicationAt = 0;
  const report = (phase, reason) => {
    try {
      const at = Date.now();
      if (at - publicationAt >= 60000) { publicationAt = at; publications = 0; }
      if (publications >= 8) { suppressedPublications++; return; }
      publications++; log({ phase, reason, failures, omissions,
        queuedBytes: queuedBytes + stagedBytes, queuedMessages: pending.size, suppressedPublications });
    } catch { /* A diagnostic sink may not affect the original terminal. */ }
  };
  const lose = (id, entries, reason) => {
    const value = losses.get(id) || { events: 0, codeUnits: 0, reason };
    value.events += entries.length; value.codeUnits += entries.reduce((n, e) => n + e.buffer.byteLength / 2, 0);
    value.reason = reason; losses.set(id, value); while (losses.size > 64) losses.delete(losses.keys().next().value);
  };
  const setStatus = (id, value) => {
    const previous = statuses.get(id);
    // A successful seal ACK describes publication, not recovery of an earlier
    // omitted/failed batch. Keep that incident's persistence failure visible.
    statuses.set(id, previous?.ok === false ? { ...value, ok: false, error: value.error || previous.error } : value);
    while (statuses.size > 64) statuses.delete(statuses.keys().next().value);
  };
  const flushDrains = () => { if (!pending.size) { for (const done of drains) done(); drains.clear(); } };
  const ensure = () => {
    if (worker) return;
    worker = workerFactory ? workerFactory() : new Worker(path.join(__dirname, 'terminal-raw-window-worker.js'), {
      workerData: { directory: typeof directory === 'function' ? directory() : directory },
    });
    worker.unref?.();
    worker.on('message', message => {
      const job = pending.get(message?.requestId); if (!job) return;
      pending.delete(message.requestId); queuedBytes -= job.charge;
      if (message.error) { failures++; report(job.kind, message.error); }
      setStatus(job.id, { phase: job.kind, ok: !message.error, error: message.error || null,
        state: message.state, manifestPath: message.manifestPath });
      flushDrains();
      if (!pending.size) worker?.unref?.();
    });
    worker.on('error', () => {
      failures++; for (const job of pending.values()) setStatus(job.id, { ok: false, error: 'worker-error' });
      pending.clear(); queuedBytes = 0; report('transport', 'worker-error'); flushDrains();
    });
    worker.on('exit', code => {
      if (pending.size) { failures++; for (const job of pending.values()) setStatus(job.id, { ok: false, error: 'worker-exit' }); report('transport', 'worker-exit'); }
      pending.clear(); queuedBytes = 0; worker = null; flushDrains();
    });
  };
  const post = (kind, id, payload) => {
    try {
      if (closed) { omissions++; return false; }
      const entries = payload.entries || [];
      const metadataCharge = Buffer.byteLength(JSON.stringify(payload.summary || {}), 'utf8') + 1024 + entries.length * 512;
      const charge = metadataCharge + entries.reduce((n, entry) => n + entry.buffer.byteLength, 0);
      const limit = kind === 'seal' ? maxQueuedBytes : Math.max(0, maxQueuedBytes - 256 * 1024);
      if (queuedBytes + stagedBytes + charge > limit || pending.size >= maxQueuedMessages) {
        omissions++; setStatus(id, { ok: false, error: 'worker-queue-budget', phase: kind });
        report(kind, 'worker-queue-budget'); return false;
      }
      ensure();
      const requestId = ++sequence;
      pending.set(requestId, { id, kind, charge }); queuedBytes += charge;
      try {
        worker.ref?.();
        worker.postMessage({ requestId, id, kind, ...payload }, entries.map(entry => entry.buffer.buffer));
      } catch (error) {
        pending.delete(requestId); queuedBytes -= charge; failures++; report(kind, 'worker-post-failed'); flushDrains(); return false;
      }
      return true;
    } catch { failures++; report(kind, 'worker-unavailable'); return false; }
  };
  const flush = id => {
    const batch = staged.get(id); if (!batch) return true;
    staged.delete(id); stagedBytes -= batch.charge;
    const accepted = post('append', id, { entries: batch.entries });
    if (!accepted) lose(id, batch.entries, 'worker-queue-budget');
    return accepted;
  };
  const append = (id, data) => {
    if (closed) { omissions++; return false; }
    const entries = data.entries || [];
    const charge = entries.reduce((n, e) => n + e.buffer.byteLength + 512, 0);
    if (queuedBytes + stagedBytes + charge + 1024 > maxQueuedBytes - 256 * 1024) {
      omissions++; lose(id, entries, 'worker-queue-budget'); report('append', 'worker-queue-budget'); return false;
    }
    const batch = staged.get(id) || { entries: [], charge: 0 };
    batch.entries.push(...entries); batch.charge += charge; stagedBytes += charge; staged.set(id, batch);
    // Event-driven batching avoids one worker message/Promise per tiny PTY
    // chunk. Seal/drain flush even the last incomplete batch; no polling timer.
    return batch.charge >= 64 * 1024 || batch.entries.length >= 32 ? flush(id) : true;
  };
  return {
    start: (id, data) => post('start', id, data), append,
    seal(id, data) {
      flush(id);
      const loss = losses.get(id);
      return post('seal', id, loss ? { ...data, summary: { ...data.summary, persistenceComplete: false, writerLoss: { ...loss } } } : data);
    },
    reference: id => path.join(typeof directory === 'function' ? directory() : directory, 'raw-' + id, 'manifest.json'),
    snapshot: () => ({ queuedBytes: queuedBytes + stagedBytes, transportBytes: queuedBytes, stagedBytes,
      queuedMessages: pending.size, stagedIncidents: staged.size, failures, omissions,
      suppressedPublications,
      maxQueuedBytes, maxQueuedMessages, statuses: [...statuses].map(([id, value]) => ({ id, ...value })) }),
    async drain() { for (const id of [...staged.keys()]) flush(id); if (pending.size) await new Promise(resolve => drains.add(resolve)); },
    close({ timeoutMs = 2000 } = {}) {
      if (closing) return closing;
      closing = (async () => {
        for (const id of [...staged.keys()]) flush(id);
        closed = true;
        const deadline = Date.now() + Math.max(1, Math.min(Number(timeoutMs) || 2000, 2000));
        const withinDeadline = work => new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
          Promise.resolve(work).then(() => { clearTimeout(timer); resolve(true); },
            () => { clearTimeout(timer); resolve(false); });
        });
        let timedOut = false;
        if (pending.size) {
          // A pending Promise alone does not keep Node alive. Close owns the
          // worker reference until ACK, failure or this single bounded deadline.
          worker?.ref?.();
          timedOut = !await withinDeadline(new Promise(resolve => drains.add(resolve)));
        }
        if (pending.size) {
          failures++;
          for (const job of pending.values()) setStatus(job.id, { ok: false, phase: job.kind, error: 'worker-close-timeout' });
          pending.clear(); queuedBytes = 0; report('close', 'worker-close-timeout'); flushDrains();
        }
        if (worker) {
          const owned = worker; worker = null;
          try { if (!await withinDeadline(owned.terminate())) timedOut = true; }
          catch { failures++; timedOut = true; }
        }
        return { drained: !timedOut, timedOut };
      })();
      return closing;
    },
  };
}
module.exports = { createTerminalRawWindowWriter };
