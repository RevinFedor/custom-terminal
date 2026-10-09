'use strict';

const { performance, PerformanceObserver } = require('node:perf_hooks');

// Electron28 embeds Node18, which has no process.threadCpuUsage(). The Darwin
// clock is the calling thread's CPU time, not proc_pid_rusage's task total.
// CLOCK_THREAD_CPUTIME_ID=16 is defined by the macOS SDK's _time.h.
function createThreadCpuReader({ runtime = process, loadKoffi = () => require('koffi') } = {}) {
  try {
    if (typeof runtime.threadCpuUsage === 'function') return {
      source: 'node-threadCpuUsage', read() { const v = runtime.threadCpuUsage(); return v.user + v.system; },
    };
    if (runtime.platform !== 'darwin') return { source: null, reason: 'thread-clock-unsupported', read: () => null };
    const lib = loadKoffi().load('/usr/lib/libSystem.B.dylib');
    const clock = lib.func('int clock_gettime(int clock_id, _Out_ uint8_t *value)');
    const buffer = Buffer.alloc(16);
    const read = () => {
      if (clock(16, buffer) !== 0) return null;
      const seconds = buffer.readBigInt64LE(0), nanos = buffer.readBigInt64LE(8);
      if (seconds < 0n || nanos < 0n || nanos >= 1000000000n) return null;
      return Number(seconds * 1000000n + nanos / 1000n);
    };
    if (read() === null) throw new Error('thread-clock-probe-failed');
    return { source: 'darwin-clock-thread-cputime', read };
  } catch { return { source: null, reason: 'thread-clock-unavailable', read: () => null }; }
}

function createThreadMetrics({ now = () => performance.timeOrigin + performance.now(),
  reader = createThreadCpuReader(), cpu = () => process.cpuUsage(), Observer = PerformanceObserver,
  origin = performance.timeOrigin, onGC = () => {} } = {}) {
  let observer = null, dropped = 0, sequence = 0;
  const gc = [];
  const accept = entries => {
    for (const entry of entries) {
      if (entry.entryType !== 'gc') continue;
      const record = { gcId: ++sequence, startAbs: origin + entry.startTime, durationMs: entry.duration,
        gcKind: entry.detail?.kind ?? null, gcFlags: entry.detail?.flags ?? null, observedAbs: now() };
      gc.push(record); if (gc.length > 64) { gc.shift(); dropped++; }
      try { onGC(record); } catch { /* diagnostics never affect collection */ }
    }
  };
  try { observer = new Observer(list => accept(list.getEntries())); observer.observe({ entryTypes: ['gc'] }); }
  catch { observer = null; }
  const read = () => {
    let threadUs = null, processCpu = null;
    try { threadUs = reader.read(); } catch {}
    try { processCpu = cpu(); } catch {}
    return { at: now(), threadUs, processCpu };
  };
  const between = (before, after = read()) => {
    // takeRecords prevents an already queued observer delivery being missed;
    // GC entries that are not published yet are still explicitly unknown.
    try { if (observer?.takeRecords) accept(observer.takeRecords()); } catch {}
    const valid = Number.isFinite(before?.threadUs) && Number.isFinite(after.threadUs) && after.threadUs >= before.threadUs;
    const overlap = gc.filter(e => e.startAbs < after.at && e.startAbs + e.durationMs > before.at);
    return { threadCpuMs: valid ? (after.threadUs - before.threadUs) / 1000 : null,
      threadCpuSource: reader.source, threadCpuUnavailableReason: valid ? null : (reader.reason || 'counter-unavailable-or-reset'),
      processCpuUserMs: before.processCpu && after.processCpu ? (after.processCpu.user - before.processCpu.user) / 1000 : null,
      processCpuSystemMs: before.processCpu && after.processCpu ? (after.processCpu.system - before.processCpu.system) / 1000 : null,
      gcObservedOverlapMs: observer ? overlap.reduce((n, e) => n + Math.max(0,
        Math.min(after.at, e.startAbs + e.durationMs) - Math.max(before.at, e.startAbs)), 0) : null,
      gcEntries: overlap.length, gcDropped: dropped,
      gcCoverage: observer ? 'delivered-entries-only; late-events-correlate-by-startAbs' : 'observer-unavailable' };
  };
  return { read, between, close() { observer?.disconnect(); }, gcSnapshot: () => gc.slice() };
}

module.exports = { createThreadCpuReader, createThreadMetrics };
