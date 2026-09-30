'use strict';

// Cheap Chromium counters bridge the gap left by JS LongTask attribution.
// No DOM traversal, geometry reads, Runtime.evaluate, profiler or trace here.
// Samples describe an interval containing an action, never exclusive CPU cost.
const { performance } = require('node:perf_hooks');
const COUNTERS = ['ThreadTime', 'TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration',
  'RecalcStyleCount', 'LayoutCount'];
const round = value => Math.round(value * 10) / 10;
const absoluteNow = () => performance.timeOrigin + performance.now();

function metricsDelta(before, after) {
  const values = Object.fromEntries((after?.metrics || []).map(m => [m.name, m.value]));
  const prior = Object.fromEntries((before?.metrics || []).map(m => [m.name, m.value]));
  const delta = {};
  for (const key of COUNTERS) {
    if (!Number.isFinite(values[key]) || !Number.isFinite(prior[key]) || values[key] < prior[key]) continue;
    delta[key.endsWith('Count') ? key : key + 'Ms'] = round((values[key] - prior[key]) * (key.endsWith('Count') ? 1 : 1000));
  }
  const intervalWallMs = Number.isFinite(values.Timestamp) && Number.isFinite(prior.Timestamp) && values.Timestamp >= prior.Timestamp
    ? round((values.Timestamp - prior.Timestamp) * 1000) : null;
  return { nativeFromSeconds: prior.Timestamp ?? null, nativeToSeconds: values.Timestamp ?? null, intervalWallMs, ...delta,
    rendererThreadCpuPercent: intervalWallMs >= 20 && Number.isFinite(delta.ThreadTimeMs) ? round(100 * delta.ThreadTimeMs / intervalWallMs) : null,
    cpuPercentUnavailableReason: intervalWallMs === null || !Number.isFinite(delta.ThreadTimeMs) ? 'missing-baseline-or-counter'
      : intervalWallMs < 20 ? 'interval-too-short' : null,
    nodes: values.Nodes ?? null, documents: values.Documents ?? null, frames: values.Frames ?? null,
    heapMiB: Number.isFinite(values.JSHeapUsedSize) ? round(values.JSHeapUsedSize / 1048576) : null };
}

function createNativePerfMonitor({ webContents, log = console.warn, now = absoluteNow, intervalMs = 1000,
  timeoutMs = 1500, schedule = setTimeout, cancel = clearTimeout, autoStart = true }) {
  const dbg = webContents.debugger;
  let disposed = false, owned = false, suspended = 0, generation = 0;
  let timer = null, pending = null, baseline = null, baselineAt = null, lastHealth = -Infinity;
  let health = '', samples = 0, coalesced = 0;
  const recent = [], reportedActions = new Set();
  const identity = () => ({ window: webContents.id, rendererPid: webContents.isDestroyed() ? null : webContents.getOSProcessId() });
  const reportHealth = (state, reason = '') => {
    if (health === state + reason && now() - lastHealth < 30000) return;
    health = state + reason; lastHealth = now();
    log('[Perf:NativeStatus] ' + JSON.stringify({ ...identity(), state, reason, samples, coalesced,
      intervalMs, coverage: 'counter-interval; nested-times-not-additive' }));
  };
  const detachOwn = () => {
    const detach = owned; owned = false;
    if (detach && !webContents.isDestroyed() && dbg.isAttached()) { try { dbg.detach(); } catch {} }
  };
  const onDetach = (_event, reason) => {
    owned = false; generation++; baseline = null; baselineAt = null;
    recent.length = 0;
    if (!disposed && !suspended) reportHealth('paused', String(reason || 'debugger-detached').slice(0, 80));
  };
  const resetRenderer = reason => {
    generation++; baseline = null; baselineAt = null; recent.length = 0;
    reportHealth('waiting-for-baseline', reason);
  };
  const onNavigation = (_event, _url, inPlace, mainFrame) => {
    if (!inPlace && mainFrame !== false) resetRenderer('main-frame-navigation');
  };
  const onRendererGone = () => resetRenderer('render-process-gone');
  webContents.on('did-start-navigation', onNavigation);
  webContents.on('render-process-gone', onRendererGone);
  dbg.on('detach', onDetach);
  const command = async (method, params) => {
    let timeout;
    try {
      return await Promise.race([dbg.sendCommand(method, params), new Promise((_, reject) => {
        timeout = schedule(() => reject(new Error('native-metrics-timeout')), timeoutMs);
      })]);
    } finally { if (timeout) cancel(timeout); }
  };
  const correlate = action => {
    if (!action?.id || reportedActions.has(action.id)) return;
    reportedActions.add(action.id);
    if (reportedActions.size > 96) reportedActions.delete(reportedActions.values().next().value);
    const end = action.startAbs + action.durationMs;
    const intervals = recent.filter(item => item.nativeFromSeconds !== null && item.queryEndAbs >= action.startAbs
      && (item.previousQueryStartAbs ?? item.queryStartAbs) <= end).slice(-6);
    log('[Perf:NativeAction] ' + JSON.stringify({ ...identity(), action, intervals,
      coverage: intervals.length ? 'overlapping-sample-bounds; not-exclusive; nested-counters' : 'no-covering-counter-interval' }));
  };
  const sample = (reason = 'periodic', action = null) => {
    if (disposed || suspended || webContents.isDestroyed()) return Promise.resolve(null);
    if (pending) { coalesced++; return pending.then(record => { if (action) correlate(action); return record; }); }
    const version = generation;
    const startedAt = now();
    pending = (async () => {
      try {
        if (!owned) {
          if (dbg.isAttached() || webContents.isDevToolsOpened()) { reportHealth('paused', 'external-debugger'); return null; }
          dbg.attach('1.3'); owned = true;
          await command('Performance.enable', { timeDomain: 'threadTicks' });
          if (!owned || version !== generation || suspended || disposed) return null;
          reportHealth('active');
        }
        const current = await command('Performance.getMetrics');
        if (!owned || version !== generation || suspended || disposed) return null;
        const endedAt = now();
        const delta = metricsDelta(baseline, current);
        samples++;
        const record = { ...identity(), reason, action, queryStartAbs: round(startedAt), queryEndAbs: round(endedAt),
          queryMs: round(endedAt - startedAt), previousSampleAbs: baselineAt,
          counterGeneration: generation, previousQueryStartAbs: baseline ? recent.at(-1)?.queryStartAbs ?? null : null, ...delta };
        recent.push(record); if (recent.length > 32) recent.shift();
        if (!baseline || reason !== 'periodic' || (delta.TaskDurationMs || 0) >= 40
          || (delta.RecalcStyleDurationMs || 0) >= 12 || endedAt - startedAt >= 40) {
          log('[Perf:NativeWindow] ' + JSON.stringify(record));
        }
        baseline = current; baselineAt = round(endedAt);
        if (action) correlate(action);
        reportHealth('active');
        return record;
      } catch (error) {
        if (!disposed && !suspended && version === generation) {
          reportHealth('failed', String(error.message || error).slice(0, 100)); detachOwn();
        }
        return null;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  const tick = async () => {
    timer = null;
    await sample();
    if (!disposed) { timer = schedule(tick, intervalMs); timer?.unref?.(); }
  };
  const suspend = (reason = 'incident-profile') => {
    suspended++; generation++; baseline = null; baselineAt = null;
    detachOwn(); reportHealth('suspended', reason);
    let released = false;
    return () => {
      if (released) return; released = true; suspended = Math.max(0, suspended - 1);
      if (!disposed && !suspended) void sample('resume');
    };
  };
  const dispose = () => {
    if (disposed) return; disposed = true; generation++;
    if (timer) cancel(timer);
    detachOwn(); dbg.removeListener('detach', onDetach);
    webContents.removeListener('did-start-navigation', onNavigation);
    webContents.removeListener('render-process-gone', onRendererGone);
  };
  webContents.once('destroyed', dispose);
  if (autoStart) { timer = schedule(tick, 0); timer?.unref?.(); }
  return { sample, suspend, dispose };
}

module.exports = { createNativePerfMonitor, metricsDelta };
