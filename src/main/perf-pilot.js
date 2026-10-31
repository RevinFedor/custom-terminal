'use strict';

// One explicitly admitted isolated packaged scenario. No production endpoint,
// automatic quota change, provider action, or second attempt after UNKNOWN.
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
function installPerfPilot({ ipcMain, app, allowed, key, capture, pin, suspend, causal, directory, log, schedule = setTimeout }) {
  if (!allowed || typeof key !== 'string' || !/^[a-z0-9-]{16,80}$/.test(key)) return false;
  let original = null, report = null, ready = null, started = false, finished = false;
  const attemptedControls = new Set();
  let baselineSequence = 0, baselinePending = false;
  const cpuReader = require('./perf-thread-metrics').createThreadCpuReader();
  const exact = event => {
    const wc = event?.sender;
    if (!wc || wc.isDestroyed() || event.senderFrame !== wc.mainFrame) throw Error('pilot-owner-unavailable');
    return wc;
  };
  const authorize = (event, request) => {
    const wc = exact(event);
    if (request?.key !== key || original && (wc !== original.webContents || !original.isCurrent())) throw Error('pilot-owner-mismatch');
    return wc;
  };
  ipcMain.handle('perf:pilot', (event, request) => {
    const wc = authorize(event, request);
    if (request.op === 'baseline') {
      if (started || baselinePending || baselineSequence >= 4 || request.sequence !== baselineSequence
        || request.enabled !== (baselineSequence % 2 === 1)) throw Error('pilot-baseline-order');
      baselineSequence++; baselinePending = true;
      causal.setSyncRingEnabled(request.enabled);
      const start = performance.now(), memory = process.memoryUsage(), cpu = cpuReader.read();
      return new Promise((resolve, reject) => schedule(() => {
        try {
          authorize(event, request); const endCpu = cpuReader.read();
          resolve({ sequence: request.sequence, enabled: request.enabled, start, end: performance.now(),
            timeOrigin: performance.timeOrigin, threadCpuMs: cpu !== null && endCpu !== null ? (endCpu - cpu) / 1000 : null,
            cpuSource: cpuReader.source, memoryBefore: memory, memoryAfter: process.memoryUsage(),
            coverage: 'same private Main idle section; counters include ordinary concurrent app work' });
        } catch (error) { reject(error); }
        finally { baselinePending = false; causal.setSyncRingEnabled(true); }
      }, 2000)); // Fixed measurement section, never a readiness timer.
    }
    if (request.op === 'status') return { started, ready, finished, report,
      main: { pid: process.pid, timeOrigin: performance.timeOrigin, now: performance.now(),
        memory: process.memoryUsage(), heapLimit: require('node:v8').getHeapStatistics().heap_size_limit },
      sync: causal.syncSnapshot({ from: performance.timeOrigin + performance.now() - 60000,
        to: performance.timeOrigin + performance.now(), limit: 256 }) };
    if (request.op === 'start') {
      if (started || baselinePending) throw Error('pilot-already-attempted');
      original = pin(wc); started = true;
      const id = 'incident-' + Date.now() + '-' + process.pid;
      const resume = suspend();
      void Promise.resolve(resume.ready).then(() => capture({
        request: { id, kind: 'private-pilot', requestedWallMs: Date.now(), pid: process.pid },
        webContents: wc, directory, log, ownerGuard: original,
        captureOptions: { mode: 'private-armed', durationMs: 40000, samplingIntervalUs: 8000 },
        onReady: value => { ready = value; log('[Perf:Pilot] ' + JSON.stringify({ state: 'ready', id, ...value })); },
      })).then(value => {
        report = value; finished = true;
        const retire = value?.whenRetired;
        if (!retire) { log('[Perf:Pilot] state=unknown reason=missing-retirement'); return; }
        retire.then(r => { const confirmed = r?.confirmed === true && r.leaseId === value.leaseId;
          if (confirmed) { original.dispose(); resume(); }
          log('[Perf:Pilot] ' + JSON.stringify({ state: confirmed ? 'retired' : 'unknown', id }));
        }).catch(() => log('[Perf:Pilot] state=unknown reason=retirement-handler-failed'));
        log('[Perf:Pilot] ' + JSON.stringify({ state: 'finished', id, retirement: value?.retirementState,
          artifacts: value?.artifacts, errors: value?.errors }));
      }).catch(error => { finished = true; report = { errors: [String(error.message)], retirementState: { state: 'unknown' } };
        log('[Perf:Pilot] state=unknown reason=capture-failed'); });
      return { accepted: true, id, nonce: randomUUID(), durationMs: 40000, replay: false };
    }
    // Named finite controls in the SAME Main, no allocation/OOM stress.
    if (request.op === 'control') {
      if (!ready || finished || !['cpu', 'wait'].includes(request.kind)
        || attemptedControls.has(request.kind) || performance.now() >= ready.plannedStopMonoMs) throw Error('pilot-not-recording');
      attemptedControls.add(request.kind);
      const ms = request.kind === 'wait' ? 2200 : 220;
      return causal.syncWork('pilot.main.' + request.kind, { caller: 'isolated-pilot' }, () => {
        const start = performance.now();
        if (request.kind === 'wait') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        else { let value = 1; while (performance.now() - start < ms) value = Math.sqrt(value + 3.14); }
        return { kind: request.kind, startAbs: performance.timeOrigin + start,
          endAbs: performance.timeOrigin + performance.now(), requestedMs: ms };
      });
    }
    throw Error('pilot-operation-unavailable');
  });
  return true;
}
module.exports = { installPerfPilot };
