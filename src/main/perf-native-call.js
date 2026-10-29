'use strict';

const { performance } = require('node:perf_hooks');

// Caller is a fixed site identifier, never data from the getter or its arguments.
const CALLERS = new Set(['heartbeat', 'collectAppPids']);
const NAME = 'native.getAppMetrics';

function observeNativeCall({ causal, beginPerfOp, endPerfOp, caller, target, getter, args = [], clock = performance, log = console.log }) {
  const site = CALLERS.has(caller) ? caller : 'other';
  let called = false, failed = false, value, thrown, opId, startedOp = false;
  let start, end;
  const invokeOnce = () => {
    if (called) { if (failed) throw thrown; return value; }
    called = true;
    try { start = clock.now(); } catch {}
    try { value = Reflect.apply(getter, target, args); return value; }
    catch (error) { failed = true; thrown = error; throw error; }
    finally { try { end = clock.now(); } catch {} }
  };
  try { opId = beginPerfOp(NAME, { caller: site, source: site }); startedOp = true; } catch {}
  try { causal.syncWork(NAME, { caller: site }, invokeOnce); } catch {}
  // A broken observer may throw before calling us; never repeat a completed call.
  if (!called) { try { invokeOnce(); } catch {} }
  if (startedOp) { try { endPerfOp(opId); } catch {} }
  try {
    const duration = end - start;
    if (Number.isFinite(duration) && duration >= 16) {
      const origin = Number.isFinite(clock.timeOrigin) ? clock.timeOrigin : performance.timeOrigin;
      log(`[Perf:NativeCall] name=${NAME} caller=${site} status=${failed ? 'error' : 'success'} durationMs=${duration.toFixed(1)}`
        + ` startAbs=${(origin + start).toFixed(1)} endAbs=${(origin + end).toFixed(1)} coverage=sync-call-wall`);
    }
  } catch {}
  if (failed) throw thrown;
  return value;
}

module.exports = { observeNativeCall };
