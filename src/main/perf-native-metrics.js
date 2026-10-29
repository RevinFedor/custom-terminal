'use strict';

// Cheap Chromium counters bridge the gap left by JS LongTask attribution.
// No DOM traversal, geometry reads, Runtime.evaluate, profiler or trace here.
// Samples describe an interval containing an action, never exclusive CPU cost.
const { performance } = require('node:perf_hooks');
const { randomBytes } = require('node:crypto');
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
  let disposed = false, owned = false, enabled = false, suspended = 0, generation = 0, rendererGone = false;
  let deferredOwnDetach = false;
  // Document identity survives counter suspension/detachment. Raw native work
  // survives caller deadlines and every lifecycle revocation until it settles.
  let documentGeneration = 0, document = null, rawOperation = null;
  let timer = null, pending = null, baseline = null, baselineAt = null, lastHealth = -Infinity;
  let health = '', samples = 0, coalesced = 0;
  const recent = [], reportedActions = new Set(), methods = [];
  let methodSequence = 0, generationMethods = 0;
  const identity = () => {
    let rendererPid = null;
    try { if (!webContents.isDestroyed()) rendererPid = webContents.getOSProcessId(); } catch {}
    return { window: webContents.id, rendererPid };
  };
  let lastRendererPid = identity().rendererPid;
  const frameIdentity = frame => {
    try {
      if (!frame || frame.parent !== null || !Number.isSafeInteger(frame.processId) || frame.processId < 0
        || !Number.isSafeInteger(frame.routingId) || frame.routingId < 0) return null;
      return { frameProcessId: frame.processId, frameRoutingId: frame.routingId, rendererPid: frame.osProcessId };
    } catch { return null; }
  };
  const currentDocument = (candidate = document) => {
    if (!candidate || candidate !== document || disposed || rendererGone || webContents.isDestroyed()) return false;
    let frame;
    try { frame = frameIdentity(webContents.mainFrame); } catch { return false; }
    return Number.isSafeInteger(candidate.rendererPid) && candidate.rendererPid > 0
      && identity().rendererPid === candidate.rendererPid && frame?.rendererPid === candidate.rendererPid
      && frame.frameProcessId === candidate.frameProcessId && frame.frameRoutingId === candidate.frameRoutingId;
  };
  const currentRenderer = (version, pid) => !suspended && version === generation
    && currentDocument() && document.bootNonce !== null && document.rendererPid === pid;
  const currentOwner = (version, pid) => owned && currentRenderer(version, pid)
    && dbg.isAttached() && !webContents.isDevToolsOpened();
  const methodEvent = (context, phase, extra = {}) => {
    const record = { ...context, phase, atAbs: round(now()), ...extra };
    methods.push(record); if (methods.length > 48) methods.shift();
    if (context.bootRecord || extra.late || phase === 'deadline' || phase === 'rejected'
      || (phase === 'settled' && record.durationMs >= 40)) {
      log('[Perf:NativeMethod] ' + JSON.stringify(record));
    }
  };
  const methodContext = (method, version, pid) => ({ window: webContents.id, rendererPid: pid,
    counterGeneration: version, documentGeneration: document?.documentGeneration ?? null,
    frameProcessId: document?.frameProcessId ?? null, frameRoutingId: document?.frameRoutingId ?? null,
    operationId: ++methodSequence, method, issuedAtAbs: round(now()),
    bootRecord: ++generationMethods <= 4 });
  const reportHealth = (state, reason = '') => {
    if (health === state + reason && now() - lastHealth < 30000) return;
    health = state + reason; lastHealth = now();
    log('[Perf:NativeStatus] ' + JSON.stringify({ ...identity(), state, reason, samples, coalesced,
      intervalMs, coverage: 'counter-interval; nested-times-not-additive' }));
  };
  const pauseForDevTools = () => {
    if (!webContents.isDevToolsOpened()) return false;
    // DevTools can coexist with our debugger attachment without a detach
    // event. Visibility is a reason to stop sending commands, not evidence
    // that another owner replaced this attachment. onDetach remains the
    // authority that revokes it. Discard the interval across DevTools.
    enabled = false; baseline = null; baselineAt = null; recent.length = 0;
    reportHealth('paused', 'external-debugger');
    return true;
  };
  const detachOwn = () => {
    enabled = false;
    if (owned && !webContents.isDestroyed() && dbg.isAttached() && webContents.isDevToolsOpened()) {
      deferredOwnDetach = true;
      return;
    }
    const detach = owned; owned = false; deferredOwnDetach = false;
    if (detach && !webContents.isDestroyed() && dbg.isAttached()) { try { dbg.detach(); } catch {} }
    finishDisposedAttachment();
  };
  const onDetach = (_event, reason) => {
    owned = false; enabled = false; deferredOwnDetach = false; generation++; baseline = null; baselineAt = null;
    recent.length = 0;
    if (!disposed && !suspended && !rendererGone) reportHealth('paused', String(reason || 'debugger-detached').slice(0, 80));
    finishDisposedAttachment();
  };
  const onDevToolsOpened = () => {
    // Also revoke an in-flight successful result if DevTools opens and closes
    // before that result settles. Visibility sampling alone can miss it.
    generation++; enabled = false; baseline = null; baselineAt = null; recent.length = 0;
    if (!disposed) reportHealth('paused', 'external-debugger');
  };
  const onDevToolsClosed = () => {
    if (deferredOwnDetach) detachOwn();
    finishDisposedAttachment();
  };
  const onDestroyed = () => {
    owned = false; deferredOwnDetach = false;
    dispose(); finishDisposedAttachment();
  };
  function finishDisposedAttachment() {
    if (!disposed || deferredOwnDetach) return;
    dbg.removeListener('detach', onDetach);
    webContents.removeListener('devtools-closed', onDevToolsClosed);
    webContents.removeListener('destroyed', onDestroyed);
  }
  const resetRenderer = reason => {
    generation++; generationMethods = 0; baseline = null; baselineAt = null; recent.length = 0;
    reportHealth('waiting-for-baseline', reason);
  };
  let bootstrapHealth = '', bootstrapHealthAt = -Infinity;
  const bootstrapEvent = (state, reason) => {
    const key = state + reason + documentGeneration;
    if (bootstrapHealth === key && now() - bootstrapHealthAt < 30000) return;
    bootstrapHealth = key; bootstrapHealthAt = now();
    log('[Perf:NativeBootstrap] ' + JSON.stringify({ ...identity(), documentGeneration,
      frameProcessId: document?.frameProcessId ?? null, frameRoutingId: document?.frameRoutingId ?? null,
      state, reason, atAbs: round(now()) }));
  };
  const revokeDocument = reason => {
    document = null; documentGeneration++;
    // Detach only our attachment. Neither detachment nor navigation cancels an
    // outstanding sendCommand; rawOperation is deliberately left intact.
    detachOwn(); resetRenderer(reason); bootstrapEvent('revoked', reason);
  };
  const onNavigation = (event, _url, inPlace, mainFrame) => {
    if (!(event?.isSameDocument ?? inPlace) && (event?.isMainFrame ?? mainFrame) === true) {
      revokeDocument('main-frame-navigation');
    }
  };
  const sendChallenge = () => {
    if (!currentDocument()) return false;
    try {
      // Never event.reply()/senderFrame.send(): an old hello can only wake the
      // SAME current challenge on Main's CURRENT committed main frame.
      webContents.mainFrame.send('perf:native-bootstrap-challenge', {
        wcId: webContents.id, rendererPid: document.rendererPid,
        frameProcessId: document.frameProcessId, frameRoutingId: document.frameRoutingId,
        documentGeneration: document.documentGeneration, challenge: document.challenge,
      });
      bootstrapEvent('challenge-sent', 'current-main-frame');
      return true;
    } catch { bootstrapEvent('unavailable', 'challenge-send-failed'); return false; }
  };
  const onCommit = (_event, _url, _code, _status, mainFrame, frameProcessId, frameRoutingId) => {
    if (mainFrame !== true || disposed || webContents.isDestroyed()) return;
    revokeDocument('main-frame-commit');
    let frame;
    try { frame = frameIdentity(webContents.mainFrame); } catch {}
    const pid = identity().rendererPid;
    if (!frame || !Number.isSafeInteger(pid) || pid <= 0 || frame.rendererPid !== pid
      || frame.frameProcessId !== frameProcessId || frame.frameRoutingId !== frameRoutingId) {
      bootstrapEvent('unavailable', 'committed-frame-unavailable'); return;
    }
    rendererGone = false; lastRendererPid = pid;
    document = { ...frame, documentGeneration, challenge: randomBytes(16).toString('hex'), bootNonce: null,
      domReady: false, finished: false };
    bootstrapEvent('committed', 'awaiting-loaded-proof'); sendChallenge();
    if (autoStart && !suspended && !timer) { timer = schedule(tick, 0); timer?.unref?.(); }
  };
  const senderIsMain = event => {
    if (disposed || webContents.isDestroyed() || event?.sender !== webContents) return false;
    let frame, current;
    try { frame = frameIdentity(event.senderFrame); current = frameIdentity(webContents.mainFrame); } catch { return false; }
    return !!frame && !!current && frame.rendererPid === identity().rendererPid
      && frame.rendererPid === current.rendererPid && frame.frameProcessId === current.frameProcessId
      && frame.frameRoutingId === current.frameRoutingId;
  };
  const bootstrapAvailable = event => {
    if (!senderIsMain(event)) { bootstrapEvent('rejected', 'availability-sender'); return false; }
    // Availability carries no authority and is not bound to a document. Even a
    // delayed same-PID/reused-frame hello only sends to the current main frame.
    return sendChallenge();
  };
  const bootstrapAck = (event, payload) => {
    if (!senderIsMain(event) || !currentDocument()) {
      bootstrapEvent('rejected', 'ack-sender-or-document'); return false;
    }
    if (!payload || payload.challenge !== document.challenge
      || payload.wcId !== webContents.id || payload.rendererPid !== document.rendererPid
      || payload.frameProcessId !== document.frameProcessId || payload.frameRoutingId !== document.frameRoutingId
      || payload.documentGeneration !== document.documentGeneration
      || typeof payload.bootNonce !== 'string' || !/^[a-f0-9]{32}$/.test(payload.bootNonce)) {
      bootstrapEvent('rejected', 'ack-binding'); return false;
    }
    if (document.bootNonce !== null) {
      if (document.bootNonce === payload.bootNonce) return true; // Idempotent; no sample/retry.
      bootstrapEvent('rejected', 'ack-boot-nonce'); return false;
    }
    document.bootNonce = payload.bootNonce;
    bootstrapEvent('accepted', 'process-loaded');
    if (autoStart) void sample('bootstrap-loaded');
    return true;
  };
  const onRendererGone = () => {
    rendererGone = true;
    if (timer) cancel(timer); timer = null;
    log('[Perf:NativeMethodWindow] ' + JSON.stringify({ ...identity(), previousRendererPid: lastRendererPid,
      counterGeneration: generation, reason: 'render-process-gone', operations: methods.slice(-8),
      coverage: 'method issue/settlement receipts; not native cancellation or crash attribution' }));
    revokeDocument('render-process-gone');
  };
  const onDomReady = () => {
    if (currentDocument() && !document.domReady) {
      document.domReady = true; bootstrapEvent('dom-ready', 'ordering-only');
    }
  };
  const onFinish = () => {
    if (currentDocument() && !document.finished) {
      document.finished = true; bootstrapEvent('did-finish-load', 'ordering-only');
    }
  };
  webContents.on('did-start-navigation', onNavigation);
  webContents.on('did-frame-navigate', onCommit);
  webContents.on('render-process-gone', onRendererGone);
  webContents.on('dom-ready', onDomReady);
  webContents.on('did-finish-load', onFinish);
  dbg.on('detach', onDetach);
  const command = async (method, params, version, pid) => {
    if (rawOperation || !currentOwner(version, pid)) throw new Error('native-metrics-owner-changed-before-command');
    const context = methodContext(method, version, pid);
    const operation = { context, expired: false };
    // Reserve synchronously, before calling Electron, including synchronous throws.
    rawOperation = operation;
    methodEvent(context, 'issue');
    let timeout;
    const settle = (phase) => {
      const ownerCurrent = currentOwner(version, pid);
      methodEvent(context, phase, { durationMs: round(now() - context.issuedAtAbs),
        ownerCurrent, late: operation.expired || !ownerCurrent,
        ...(phase === 'rejected' ? { reason: 'native-command-rejected' } : {}) });
      if (rawOperation === operation) rawOperation = null;
    };
    try {
      let request;
      try {
        if (!currentOwner(version, pid)) throw new Error('native-metrics-owner-changed-before-command');
        request = dbg.sendCommand(method, params);
      } catch (error) { settle('rejected'); throw error; }
      const native = Promise.resolve(request).then(value => {
        settle('settled'); return value;
      }, error => { settle('rejected'); throw error; });
      return await Promise.race([native, new Promise((_, reject) => {
        timeout = schedule(() => {
          operation.expired = true;
          methodEvent(context, 'deadline', { nativeSettlement: 'unobserved', ownerCurrent: currentOwner(version, pid) });
          // Never publish the late result or bridge its baseline to a later sample.
          // This invalidates counters, not the document or the native lane.
          resetRenderer('native-command-deadline');
          reject(new Error('native-metrics-timeout'));
        }, timeoutMs);
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
    if (disposed || webContents.isDestroyed()) return Promise.resolve(null);
    const actionDocument = document;
    const correlateCurrentAction = () => {
      if (action && currentDocument(actionDocument)) correlate(action);
    };
    if (rawOperation) {
      coalesced++; reportHealth('unavailable', rawOperation.expired ? 'native-command-unsettled-after-deadline' : 'native-command-unsettled');
      if (action && pending && !rawOperation.expired) return pending.then(record => { correlateCurrentAction(); return record; });
      correlateCurrentAction();
      return Promise.resolve(null);
    }
    if (suspended) return Promise.resolve(null);
    if (pauseForDevTools()) return Promise.resolve(null);
    const pid = identity().rendererPid;
    if (rendererGone || !Number.isSafeInteger(pid) || pid <= 0) {
      reportHealth('waiting-for-renderer', rendererGone ? 'render-process-gone' : 'renderer-pid-unavailable');
      return Promise.resolve(null);
    }
    if (!currentDocument() || document.bootNonce === null) {
      reportHealth('waiting-for-bootstrap', 'committed-loaded-proof-required'); return Promise.resolve(null);
    }
    if (pending) { coalesced++; return pending.then(record => { correlateCurrentAction(); return record; }); }
    const version = generation;
    const startedAt = now();
    pending = (async () => {
      try {
        if (!owned) {
          if (dbg.isAttached() || webContents.isDevToolsOpened()) { reportHealth('paused', 'external-debugger'); return null; }
          if (rawOperation || !currentRenderer(version, pid)) return null;
          const attach = methodContext('Debugger.attach', version, pid); methodEvent(attach, 'issue');
          try { dbg.attach('1.3'); owned = true; enabled = false; methodEvent(attach, 'settled', { durationMs: round(now() - attach.issuedAtAbs), ownerCurrent: currentRenderer(version, pid) }); }
          catch (error) { methodEvent(attach, 'rejected', { reason: 'native-attach-rejected' }); throw error; }
          lastRendererPid = pid;
        }
        if (!enabled) {
          await command('Performance.enable', { timeDomain: 'threadTicks' }, version, pid);
          if (!currentOwner(version, pid)) return null;
          enabled = true; reportHealth('active');
        }
        const current = await command('Performance.getMetrics', undefined, version, pid);
        if (!currentOwner(version, pid)) return null;
        const endedAt = now();
        const delta = metricsDelta(baseline, current);
        samples++;
        const record = { ...identity(), reason, action, queryStartAbs: round(startedAt), queryEndAbs: round(endedAt),
          queryMs: round(endedAt - startedAt), previousSampleAbs: baselineAt,
          counterGeneration: generation, documentGeneration: document.documentGeneration, previousQueryStartAbs: baseline ? recent.at(-1)?.queryStartAbs ?? null : null, ...delta };
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
        if (error?.message === 'native-metrics-timeout') {
          if (!disposed) reportHealth('unavailable', 'native-command-unsettled-after-deadline');
          return null;
        }
        if (!disposed && !suspended && version === generation) {
          // DevTools may have opened while sendCommand was outstanding.
          // Keep a still-owned attachment until its real detach event;
          // otherwise close would leave it permanently classified external.
          if (pauseForDevTools()) return null;
          reportHealth('failed', 'native-command-rejected'); detachOwn();
        }
        return null;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  const tick = async () => {
    timer = null;
    await sample();
    if (!disposed && !rendererGone && !timer) { timer = schedule(tick, intervalMs); timer?.unref?.(); }
  };
  const suspend = (reason = 'incident-profile') => {
    suspended++; generation++; baseline = null; baselineAt = null; recent.length = 0;
    detachOwn(); reportHealth('suspended', reason);
    let released = false;
    return () => {
      if (released) return; released = true; suspended = Math.max(0, suspended - 1);
      if (!disposed && !suspended) void sample('resume');
    };
  };
  const dispose = () => {
    if (disposed) return; disposed = true; generation++; document = null; documentGeneration++;
    if (timer) cancel(timer);
    detachOwn(); finishDisposedAttachment();
    webContents.removeListener('did-start-navigation', onNavigation);
    webContents.removeListener('render-process-gone', onRendererGone);
    webContents.removeListener('did-frame-navigate', onCommit);
    webContents.removeListener('dom-ready', onDomReady);
    webContents.removeListener('did-finish-load', onFinish);
    webContents.removeListener('devtools-opened', onDevToolsOpened);
  };
  webContents.on('devtools-opened', onDevToolsOpened);
  webContents.on('devtools-closed', onDevToolsClosed);
  webContents.once('destroyed', onDestroyed);
  if (autoStart) { timer = schedule(tick, 0); timer?.unref?.(); }
  return { sample, suspend, dispose, bootstrapAvailable, bootstrapAck };
}

module.exports = { createNativePerfMonitor, metricsDelta };
