'use strict';

// Owns only an input/latencyInfo ring, never the debugger attachment or profiler.
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { createTraceLineReader, parseTraceEventLine } = require('./perf-trace-events');
const LIMITS = Object.freeze({ bufferKiB: 2048, exportBytes: 4194304, chunkBytes: 65536,
  outputBytes: 262144, commandMs: 3000, exportMs: 5000, postMs: 100, clockMs: 5000, triggers: 16 });
const EVENTS = new Set(['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel']);
const KINDS = new Set(['event-timing', 'second-frame', 'input-delay']);
const SCOPE_FIELDS = ['mainPid', 'rendererPid', 'window', 'documentGeneration', 'frameProcessId', 'frameRoutingId'];
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const token = v => typeof v === 'string' && /^[\w:-]{1,96}$/.test(v);
const get = (o, k, fallback) => { try { return o?.[k] ?? fallback; } catch { return fallback; } };
const silence = value => { try { Promise.resolve(value).catch(() => {}); } catch {} };
const bounded = (v, fallback, low) => Number.isFinite(v) ? Math.max(low, Math.min(fallback, Math.floor(v))) : fallback;
function copyScope(raw) {
  try {
    const out = {};
    for (const key of SCOPE_FIELDS) {
      const v = raw[key]; if (!Number.isSafeInteger(v) || v < 0) return null; out[key] = v;
    }
    if (!out.mainPid || !out.rendererPid || out.mainPid === out.rendererPid || !token(raw.attachmentId)) return null;
    out.attachmentId = raw.attachmentId;
    const origin = raw.documentTimeOriginMs;
    if (number(origin)) out.documentTimeOriginMs = origin;
    return Object.freeze(out);
  } catch { return null; }
}
const validScope = raw => copyScope(raw) !== null;
const scopeKey = s => s && SCOPE_FIELDS.map(k => s[k]).concat(s.attachmentId).join(':');
function actionFields(raw) {
  try {
    if (!raw || !token(raw.id) || !EVENTS.has(raw.event) || !number(raw.startAbs)
      || !number(raw.durationMs) || raw.durationMs > 60000 || (raw.kind && !KINDS.has(raw.kind))) return null;
    const a = { id: raw.id, event: raw.event, startAbs: raw.startAbs, durationMs: raw.durationMs };
    if (number(raw.inputDelayMs) && raw.inputDelayMs <= 60000) a.inputDelayMs = raw.inputDelayMs;
    if (Number.isSafeInteger(raw.rendererPid) && raw.rendererPid > 0) a.rendererPid = raw.rendererPid;
    if (number(raw.documentTimeOriginMs)) a.documentTimeOriginMs = raw.documentTimeOriginMs;
    const n = raw.nativeOriginal;
    if (n && EVENTS.has(n.type) && number(n.timeStampMs)) {
      a.nativeOriginal = { type: n.type, timeStampMs: n.timeStampMs };
      if (['mouse', 'touch', 'pen'].includes(n.pointerType)) a.nativeOriginal.pointerType = n.pointerType;
      if (number(n.uncertaintyMs) && n.uncertaintyMs <= 2) a.nativeOriginal.uncertaintyMs = n.uncertaintyMs;
    }
    return a;
  } catch { return null; }
}
function failure(code, notSent = false) { return Object.assign(new Error(code), { notSent }); }
function refused(error, method) {
  try {
    return error?.notSent === true || (method === 'Tracing.start'
      && (error?.code === 'TRACING_ALREADY_STARTED'
        || /^Tracing (?:is already started|has already been started)\.?$/i.test(error?.message)));
  } catch { return false; }
}
function snapshotValue(value) {
  try {
    const { timeOrigin, now, epochMs } = value;
    return [timeOrigin, now, epochMs].every(number) && Math.abs(timeOrigin + now - epochMs) <= 0.001
      ? { timeOrigin, now, epochMs } : null;
  } catch { return null; }
}

/** Integration contract (no attachment ownership here):
 * transport.scope/isCurrent/canCleanup/sendRaw/subscribe/runExclusive are owned
 * by the parent. Optional readRendererClock(scope) is nonce/frame-bound preload
 * IPC returning {rendererTimeOriginMs,rendererNowMs,rendererEpochMs,
 * parentBeforeAbs,parentAfterAbs}; its captured document origin is authoritative
 * after the parent's nonce/frame validation and the core's current-scope check.
 * Optional scope.documentTimeOriginMs is an additional equality guard. Missing proof
 * keeps native-only evidence. No Runtime.evaluate fallback.
 * start/resume/pause/dispose resolve booleans and never reject; observe returns a
 * boolean. pause(reason,{preserve:true,companionCaptureId?,actions?:[]}) snapshots
 * only an already-owned ring. Its boolean means cleanup/free tracing lane, NOT
 * artifact completeness or persistence ACK. Concurrent pauses share one flight
 * (first pause options own that flight). state() exposes those separate outcomes.
 * Optional onRetired(scope) fires once after session clear/unsubscribe, for
 * known-not-started/refused or confirmed END+stream-close retirement. It is not
 * a persistence ACK. The parent can release an exact retained attachment token.
 */
function createInputPreroll(options = {}) {
  const transport = get(options, 'transport'), createCollector = get(options, 'createCollector'), publish = get(options, 'publish');
  const log = get(options, 'log', console.warn), now = get(options, 'now', () => performance.timeOrigin + performance.now());
  const onRetired = get(options, 'onRetired');
  const schedule = get(options, 'schedule', setTimeout), cancel = get(options, 'cancel', clearTimeout);
  const supplied = get(options, 'limits', {});
  const limits = Object.freeze({ bufferKiB: LIMITS.bufferKiB, chunkBytes: LIMITS.chunkBytes,
    exportBytes: bounded(get(supplied, 'exportBytes'), LIMITS.exportBytes, 256),
    outputBytes: bounded(get(supplied, 'outputBytes'), LIMITS.outputBytes, 16384),
    commandMs: bounded(get(supplied, 'commandMs'), LIMITS.commandMs, 1),
    exportMs: bounded(get(supplied, 'exportMs'), LIMITS.exportMs, 1),
    postMs: bounded(get(supplied, 'postMs'), LIMITS.postMs, 0),
    clockMs: bounded(get(supplied, 'clockMs'), LIMITS.clockMs, 1000),
    triggers: bounded(get(supplied, 'triggers'), LIMITS.triggers, 1) });
  let disposed = false, paused = false, session = null, job = null, pauseFlight = null, postTimer = null;
  let sequence = 0, revision = 0, blockedScope = null, omittedTriggers = 0, retiredTriggers = 0, foreignTriggers = 0, lastError = null, lastPublication = null;
  const pending = new Map(), seenActions = new Set();
  const time = () => { try { const t = now(); if (number(t)) return t; } catch {} return performance.timeOrigin + performance.now(); };
  const snapshot = () => { const epochMs = time(); return snapshotValue({ epochMs, timeOrigin: performance.timeOrigin, now: epochMs - performance.timeOrigin }); };
  const say = (state, reason, detail = {}) => {
    try { silence(log('[Perf:InputPreroll] ' + JSON.stringify({ state, reason, recordingId: session?.id || null, ...detail }))); } catch {}
  };
  const markError = (s, code) => { lastError = code; if (s && !s.errors.includes(code) && s.errors.length < 16) s.errors.push(code); };
  function port(name, ...args) {
    let fn;
    try { fn = transport?.[name]; } catch { throw failure('input-transport-unavailable', true); }
    if (typeof fn !== 'function') throw failure('input-transport-unavailable', true);
    return Reflect.apply(fn, transport, args);
  }
  const booleanPort = (name, s) => { try {
    if (!s) return false; const value = port(name, s.scope);
    if (value !== true && value !== false) silence(value); return value === true;
  } catch { return false; } };
  const authority = s => booleanPort('canCleanup', s);
  const current = s => booleanPort('isCurrent', s);
  const cancelTimer = id => { try { silence(cancel(id)); } catch {} };
  function stopPost() { if (postTimer) cancelTimer(postTimer.id); postTimer = null; }
  // The original promise always has both handlers. A deadline observes UNKNOWN;
  // it does not replace the original operation or license a second mutation.
  function wait(promise, ms) {
    return new Promise(resolve => {
      let done = false, timer;
      const finish = value => { if (done) return; done = true; cancelTimer(timer); resolve(value); };
      Promise.resolve(promise).then(value => finish({ ok: true, value }), () => finish({ ok: false }));
      try { timer = schedule(() => finish({ ok: false, timeout: true }), ms); }
      catch { finish({ ok: false, timeout: true }); }
    });
  }
  // A broken transport wrapper must not execute the same callback twice or
  // discard a completed cleanup merely because it throws after the callback.
  async function exclusive(fn) {
    let invoked = false, closed = false, own;
    const once = () => {
      if (closed && !invoked) return Promise.resolve(false);
      if (!invoked) { invoked = true; own = Promise.resolve().then(fn).catch(() => false); }
      return own;
    };
    try { await port('runExclusive', once); } catch { markError(null, 'input-exclusive-unavailable'); }
    closed = true;
    return invoked ? own : false;
  }
  function issue(s, method, params = {}, cleanup = false, onOK) {
    const t = { state: 'pending', expired: false, sent: false, value: null };
    t.promise = Promise.resolve().then(() => {
      if (method === 'Tracing.start' && (paused || disposed || s.retired)) throw failure('input-start-cancelled-before-effect', true);
      if (!(cleanup ? authority(s) : current(s))) throw failure('input-owner-lost', true);
      t.sent = true;
      return port('sendRaw', method, params, s.scope, { cleanup });
    }).then(value => {
      t.state = 'ok'; t.value = value;
      try { onOK?.(value); } catch { markError(s, 'input-receipt-invalid'); }
      s.proofRevision++;
      if (s.retireRequested) requestCleanup(s);
      return t;
    }, error => {
      t.state = refused(error, method) ? 'refused' : 'unknown';
      s.proofRevision++;
      if (s.retireRequested) requestCleanup(s);
      return t;
    });
    return t;
  }
  async function settled(s, t) {
    if (t.state === 'pending' && t.expired) return false;
    if (t.state === 'pending') {
      const result = await wait(t.promise, limits.commandMs);
      if (!result.ok && t.state === 'pending') { t.expired = true; markError(s, 'input-command-unconfirmed'); }
    }
    return t.state === 'ok';
  }
  async function command(s, method, params, onOK) {
    const t = issue(s, method, params, false, onOK);
    if (!await settled(s, t)) throw failure('input-command-unconfirmed');
    return t.value;
  }
  function retire(s) {
    if (s.retired) return;
    stopClock(s);
    s.retired = true;
    if (session === s) session = null;
    try { silence(s.unsubscribe?.()); } catch { markError(s, 'input-unsubscribe-failed'); }
    s.unsubscribe = null;
    try { if (typeof onRetired === 'function') silence(onRetired(s.scope)); }
    catch { markError(s, 'input-retired-callback-failed'); }
  }
  const clean = s => !s || s.retired || s.start?.state === 'refused'
    || (s.start?.state === 'ok' && s.end?.sent && s.end.state !== 'refused' && s.complete && !!s.stream && s.close?.state === 'ok');
  async function end(s) {
    stopClock(s);
    if (s.end?.state === 'refused') { markError(s, 'input-trace-end-refused'); return false; }
    if (s.complete) return true;
    if (s.start?.state !== 'ok') return false;
    if (!s.end) {
      if (!authority(s)) { markError(s, 'input-cleanup-owner-lost'); return false; }
      // Reserve before invoking transport; a synchronous tracingComplete is valid.
      s.end = { reserved: true };
      s.end = issue(s, 'Tracing.end', {}, true);
    }
    await settled(s, s.end);
    if (s.end.state === 'refused') { markError(s, 'input-trace-end-refused'); return false; }
    if (!s.complete && !s.completionExpired) {
      const proof = await wait(s.completion, limits.commandMs);
      if (!proof.ok && !s.complete) s.completionExpired = true;
    }
    if (!s.complete) markError(s, 'input-trace-end-unconfirmed');
    return s.complete;
  }
  async function cleanup(s) {
    if (!s || s.retired) return true;
    if (s.cleanupFlight) return s.cleanupFlight;
    s.retireRequested = true;
    const failed = () => { s.failedCleanupRevision = s.proofRevision; return false; };
    s.cleanupFlight = (async () => {
      if (!s.start) { retire(s); return true; }
      await settled(s, s.start);
      if (s.start.state === 'refused') { retire(s); return true; }
      if (s.start.state !== 'ok') return failed();
      if (!await end(s) && !(s.complete && s.end?.sent && s.end.state !== 'refused')) return failed();
      if (!s.stream) { markError(s, 'input-stream-missing'); return failed(); }
      if (!s.close) {
        if (!authority(s)) { markError(s, 'input-cleanup-owner-lost'); return failed(); }
        s.close = issue(s, 'IO.close', { handle: s.stream }, true);
      }
      await settled(s, s.close);
      if (clean(s)) { retire(s); return true; }
      markError(s, 'input-stream-close-unconfirmed'); return failed();
    })().catch(() => { markError(s, 'input-cleanup-unconfirmed'); return failed(); });
    const flight = s.cleanupFlight;
    flight.then(() => {
      s.cleanupFlight = null;
      if (!s.retired && s.proofRevision !== s.failedCleanupRevision) requestCleanup(s);
    });
    return flight;
  }
  function requestCleanup(s) {
    if (s.retired || s.cleanupQueued || s.captureActive || s.startupActive || s.cleanupFlight) return;
    s.cleanupQueued = true;
    void Promise.resolve().then(() => exclusive(() => cleanup(s))).catch(() => false).finally(() => {
      s.cleanupQueued = false;
      if (!s.retired && s.failedCleanupRevision !== undefined && s.proofRevision !== s.failedCleanupRevision) requestCleanup(s);
    });
  }
  function subscribe(s) {
    s.unsubscribe = port('subscribe', (method, params, owner) => {
      try {
        if (s.retired || method !== 'Tracing.tracingComplete' || scopeKey(copyScope(owner)) !== scopeKey(s.scope)) return;
        // A foreign completion while START is refused/pending cannot give us a
        // stream. Only this owned START followed by our single END authorizes it.
        if (s.start?.state !== 'ok' || !s.end?.sent || s.end.state === 'refused' || s.complete) return;
        s.complete = true; s.dataLoss = typeof params?.dataLossOccurred === 'boolean' ? params.dataLossOccurred : null;
        const handle = params?.stream;
        if (typeof handle === 'string' && handle.length > 0 && handle.length <= 256) s.stream = handle;
        else markError(s, 'input-stream-missing');
        s.resolveCompletion(); s.proofRevision++;
        if (s.retireRequested) requestCleanup(s);
      } catch { markError(s, 'input-completion-invalid'); }
    });
    if (typeof s.unsubscribe !== 'function') { silence(s.unsubscribe); s.unsubscribe = null; throw failure('input-subscription-unavailable', true); }
  }
  async function clockMarker(s) {
    const before = snapshot();
    if (!before) { markError(s, 'input-clock-unavailable'); return false; }
    const marker = { syncId: 'input-sync-' + randomUUID(), before };
    s.markers.push(marker); s.issuedClockMarkers++;
    if (s.markers.length > 16) { s.markers.shift(); s.omittedClockMarkers++; }
    try { await command(s, 'Tracing.recordClockSyncMarker', { syncId: marker.syncId }, () => {
      const after = snapshot(); if (after) marker.after = after;
      if (!s.clockFlight) armClock(s); // late ACK permits a new sample, never a replay
    }); return true; } catch { markError(s, 'input-clock-unavailable'); return false; }
  }
  function stopClock(s) {
    if (s?.clockTimer) cancelTimer(s.clockTimer.id);
    if (s) s.clockTimer = null;
  }
  function armClock(s) {
    if (paused || disposed || s !== session || s.retired || !s.ready || s.end || s.retireRequested || s.clockTimer || s.clockFlight || !current(s)) return;
    const timer = s.clockTimer = { id: null };
    try { timer.id = schedule(() => {
      if (s.clockTimer !== timer) return; s.clockTimer = null;
      // Periodic clock calibration, not polling readiness or retrying START.
      // One in-flight sample, 16 receipts, and no timer while held/paused/ended.
      const issuedBefore = s.issuedClockMarkers;
      s.clockFlight = exclusive(() => !paused && !disposed && !s.end && !s.retired && current(s) ? clockMarker(s) : false);
      s.clockFlight.then(ok => {
        s.clockFlight = null;
        // Also cover a late positive ACK between the deadline and this settle.
        if (ok || s.issuedClockMarkers > issuedBefore && s.markers.at(-1)?.after) armClock(s);
      });
    }, limits.clockMs); } catch { s.clockTimer = null; markError(s, 'input-clock-unavailable'); }
  }
  async function rendererClock(s) {
    try {
      const result = await wait(Promise.resolve().then(() => {
        if (!current(s)) throw failure('input-trace-scope-changed', true);
        // Optional parent-owned, nonce/frame-bound preload IPC. No Runtime
        // evaluation or bootstrap change, including when this port is absent.
        return port('readRendererClock', s.scope);
      }), limits.commandMs);
      if (!result.ok || !current(s)) throw failure('input-renderer-clock-unavailable');
      const reply = result.value;
      const mainSnapshot = epochMs => snapshotValue({ epochMs, timeOrigin: performance.timeOrigin, now: epochMs - performance.timeOrigin });
      const before = mainSnapshot(reply.parentBeforeAbs), after = mainSnapshot(reply.parentAfterAbs);
      const renderer = snapshotValue({ timeOrigin: reply.rendererTimeOriginMs, epochMs: reply.rendererEpochMs, now: reply.rendererNowMs });
      if (!before || !after || !renderer || before.epochMs > after.epochMs
        || (s.scope.documentTimeOriginMs !== undefined && s.scope.documentTimeOriginMs !== renderer.timeOrigin)) throw failure('input-renderer-clock-unavailable');
      s.documentTimeOriginMs = renderer.timeOrigin;
      s.rendererClockRelation = { mainPid: s.scope.mainPid, rendererPid: s.scope.rendererPid, mainBefore: before, mainAfter: after, renderer };
    } catch { markError(s, 'input-renderer-clock-unavailable'); }
  }
  async function startup(s) {
    s.startupActive = true;
    try {
      if (s.retired || disposed || paused || !current(s)) { retire(s); return false; }
      try { subscribe(s); } catch { markError(s, 'input-subscription-unavailable'); blockedScope = scopeKey(s.scope); retire(s); return false; }
      s.start = issue(s, 'Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
        traceConfig: { recordMode: 'recordContinuously', traceBufferSizeInKb: limits.bufferKiB,
          enableArgumentFilter: true, excludedCategories: ['*'], includedCategories: ['input', 'latencyInfo'] } }, false,
      () => { s.startedAbs = time(); });
      if (!await settled(s, s.start)) {
        if (s.start.state === 'refused') { blockedScope = scopeKey(s.scope); markError(s, 'input-trace-start-refused'); retire(s); }
        else { s.retireRequested = true; markError(s, 'input-trace-start-unconfirmed'); }
        return false;
      }
      if (s.start.expired || disposed || (paused && !s.preserveRequested) || !current(s)) { s.retireRequested = true; return false; }
      // First marker precedes the future input, not just the eventual snapshot.
      await clockMarker(s); await rendererClock(s);
      dropForeign(pending, s); dropForeign(s.actions, s);
      if (!current(s) || disposed || (paused && !s.preserveRequested)) { s.retireRequested = true; return false; }
      s.ready = true; say('recording', 'input-events-only'); armClock(s); armPost(); return !paused;
    } finally {
      s.startupActive = false;
      if (s.retireRequested) requestCleanup(s);
    }
  }
  async function start() {
    try {
      if (disposed || paused || job || typeof createCollector !== 'function' || typeof publish !== 'function') return false;
      if (session) {
        if (!current(session)) { session.retireRequested = true; requestCleanup(session); return false; }
        return session.startupFlight || (!!session.ready && !session.end && !session.retireRequested);
      }
      const raw = port('scope'), scope = copyScope(raw);
      if (!scope) { silence(raw); return false; }
      if (scopeKey(scope) === blockedScope || !current({ scope })) return false;
      blockedScope = null; // a different, proven current scope revokes the old refusal park
      let complete;
      const s = session = { id: 'input-ring-' + scope.mainPid + '-' + (++sequence), scope, ready: false, retired: false,
        start: null, end: null, close: null, complete: false, stream: null, dataLoss: null, markers: [], errors: [],
        documentTimeOriginMs: scope.documentTimeOriginMs, issuedClockMarkers: 0, omittedClockMarkers: 0,
        proofRevision: 0, actions: new Map(), frozen: false, completion: new Promise(resolve => { complete = resolve; }) };
      s.resolveCompletion = complete;
      s.startupFlight = exclusive(() => startup(s)).then(value => {
        if (!s.start && !s.retired) retire(s);
        return value === true && !s.retired && !paused && !disposed && current(s) && !s.end;
      }).catch(() => { markError(s, 'input-start-unavailable'); return false; });
      const result = await s.startupFlight; s.startupFlight = null; return result;
    } catch { markError(null, 'input-scope-unavailable'); return false; }
  }
  function armPost() {
    if (paused || disposed || job || postTimer || !pending.size || !session?.ready) return;
    const timer = postTimer = { id: null };
    try { timer.id = schedule(() => {
      if (postTimer !== timer) return; postTimer = null;
      if (!paused && !disposed && !job && pending.size) launchCapture(session);
    }, limits.postMs); } catch { postTimer = null; retiredTriggers += pending.size; pending.clear(); markError(null, 'input-post-unavailable'); }
  }
  function addAction(target, action, gap = false) {
    if (target.has(action.id)) return true;
    if (target.size >= limits.triggers) { omittedTriggers++; return false; }
    target.set(action.id, { ...action, coverage: gap ? 'snapshot-gap' : 'ring-candidate' }); return true;
  }
  function foreignAction(s, action) {
    return !!s && ((action.rendererPid !== undefined && action.rendererPid !== s.scope.rendererPid)
      || (number(s.documentTimeOriginMs) && number(action.documentTimeOriginMs) && action.documentTimeOriginMs !== s.documentTimeOriginMs));
  }
  function dropForeign(target, s) {
    for (const [id, action] of target) if (foreignAction(s, action)) {
      target.delete(id); retiredTriggers++; foreignTriggers++; markError(null, 'input-action-foreign-scope');
    }
  }
  function observe(value) {
    try {
      const a = actionFields(value);
      if (!a || paused || disposed || Math.max(a.durationMs, a.inputDelayMs || 0) < 150) return false;
      const s = session;
      if (foreignAction(s, a)) { foreignTriggers++; markError(null, 'input-action-foreign-scope'); return false; }
      const key = scopeKey(s?.scope) + ':' + a.id;
      if (seenActions.has(key) && !pending.has(a.id) && !s?.actions.has(a.id)) return false;
      if (job) {
        if (!s || s.frozen || s.retired) { retiredTriggers++; markError(null, 'input-during-snapshot-gap'); return false; }
        const accepted = addAction(s.actions, a, !!s.end); if (accepted) rememberAction(key); return accepted;
      }
      if (!s || s.retireRequested || s.end || !current(s)) return false;
      const accepted = addAction(pending, a); if (accepted) rememberAction(key); armPost(); return accepted;
    } catch { return false; }
  }
  function rememberAction(key) {
    seenActions.add(key); if (seenActions.size > 64) seenActions.delete(seenActions.values().next().value);
  }
  async function publication(s, result) {
    if (s.published) return; s.published = true;
    const receipt = { recordingId: s.id, persisted: null };
    lastPublication = receipt;
    // The record is not mutated after the publisher sees it; ACK truth lives in
    // state/logs. A lost persistence ACK never causes a second publish.
    const original = Promise.resolve().then(() => publish(Object.freeze(result))).then(value => {
      receipt.persisted = value === true; return receipt.persisted;
    }, () => { receipt.persisted = null; markError(s, 'input-persistence-unconfirmed'); return null; });
    const observed = await wait(original, limits.commandMs);
    if (!observed.ok) { markError(s, 'input-persistence-unconfirmed'); receipt.persisted = null; }
  }
  function outputBound(result) {
    try {
      if (Buffer.byteLength(JSON.stringify(result)) <= limits.outputBytes) return result;
    } catch { /* An injected collector can fail during projection too. */ }
    result.evidence = null; result.status = 'partial';
    if (!result.errors.includes('input-summary-cap-or-invalid')) result.errors.push('input-summary-cap-or-invalid');
    return result;
  }
  async function exportSnapshot(s) {
    s.captureActive = true;
    const result = { version: 1, kind: 'input-native-preroll', recordingId: s.id, scope: s.scope,
      captureStartedAbs: time(), recordingStartedAbs: s.startedAbs || null, cpuProfiler: false,
      companionCaptureId: s.companionCaptureId || null, exportBytes: 0, exportComplete: false, dataLoss: null,
      errors: [], actions: [], multipleActions: [], evidence: null, cleanupConfirmed: false, status: 'partial' };
    const deadline = time() + limits.exportMs;
    let collector, clockReader, eof = false;
    const seenClockIds = new Set();
    try {
      if (!s.ready || !current(s)) throw failure('input-trace-scope-changed');
      await clockMarker(s);
      if (!await end(s)) throw failure('input-trace-end-unconfirmed');
      if (!s.stream) throw failure('input-stream-missing');
      collector = createCollector({ mainPid: s.scope.mainPid, rendererPid: s.scope.rendererPid,
        documentTimeOriginMs: s.documentTimeOriginMs, maxInputBytes: limits.exportBytes, maxCarryBytes: limits.chunkBytes,
        maxRetainedBytes: limits.exportBytes, maxOutputBytes: Math.max(4096, limits.outputBytes - 16384) });
      const retainedIds = new Set(s.markers.map(m => m.syncId));
      clockReader = createTraceLineReader({ maxBytes: limits.exportBytes, maxCarryBytes: limits.chunkBytes, traceEventsOnly: true,
        onLine(text) {
          if (!text.includes('"clock_sync"')) return;
          try {
            const e = parseTraceEventLine(text);
            if (e.name === 'clock_sync' && e.ph === 'c' && e.pid === s.scope.mainPid && retainedIds.has(e.args?.sync_id)) seenClockIds.add(e.args.sync_id);
          } catch { /* Collector independently reports malformed/truncated data. */ }
        } });
      for (let reads = 0; !eof; reads++) {
        if (time() >= deadline || reads > Math.ceil(limits.exportBytes / limits.chunkBytes)) throw failure('input-trace-export-deadline');
        // Core uses cleanup authority ONLY for END/CLOSE. Reads and the clock IPC
        // require the original current document, including during preserve pause.
        const part = await command(s, 'IO.read', { handle: s.stream, size: limits.chunkBytes });
        if (!current(s)) throw failure('input-trace-scope-changed');
        const data = part?.data, encoded = part?.base64Encoded;
        if (typeof data !== 'string' || (encoded !== undefined && typeof encoded !== 'boolean')
          || data.length > (encoded ? Math.ceil(limits.chunkBytes / 3) * 4 : limits.chunkBytes)
          || (encoded && (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)))) throw failure('input-trace-chunk-invalid');
        const chunk = Buffer.from(data, encoded ? 'base64' : 'utf8');
        if (chunk.length > limits.chunkBytes || result.exportBytes + chunk.length > limits.exportBytes) throw failure('input-trace-export-cap');
        result.exportBytes += chunk.length; clockReader.write(chunk); collector.write(chunk); eof = part.eof === true;
      }
      result.exportComplete = true;
    } catch (error) {
      const allowed = new Set(['input-trace-scope-changed', 'input-trace-end-unconfirmed', 'input-stream-missing',
        'input-trace-export-deadline', 'input-trace-chunk-invalid', 'input-trace-export-cap']);
      const code = get(error, 'message'); markError(s, allowed.has(code) ? code : 'input-trace-read-failed');
    } finally {
      s.captureActive = false;
      result.cleanupConfirmed = await cleanup(s);
      dropForeign(s.actions, s);
      s.frozen = true; result.actions = [...s.actions.values()]; s.actions.clear();
      try { clockReader?.finish(result.exportComplete); } catch { markError(s, 'input-clock-projection-failed'); }
      const clockMarkers = s.markers.filter(m => m.after && seenClockIds.has(m.syncId))
        .map(m => ({ syncId: m.syncId, before: m.before, after: m.after }));
      result.clockCoverage = { issued: s.issuedClockMarkers, receiptsRetained: s.markers.length,
        retiredReceipts: s.omittedClockMarkers, presentInExport: seenClockIds.size, usableReceipts: clockMarkers.length,
        missingFromExport: s.markers.filter(m => !seenClockIds.has(m.syncId)).length };
      const primary = result.actions.find(a => a.coverage === 'ring-candidate');
      // Only renderer-captured original metadata; no startAbs/origin arithmetic
      // fallback and no inferred mouse pointer for EventTiming-only actions.
      const mouseRelease = primary?.event === 'click' && primary.nativeOriginal?.type === 'click'
        && primary.nativeOriginal.pointerType === 'mouse';
      const trigger = primary ? { rendererPid: primary.rendererPid, documentTimeOriginMs: primary.documentTimeOriginMs,
        // Parent admits nativeOriginal only for isTrusted events. A real mouse
        // click's original timestamp identifies its release half, not a gesture.
        nativeOriginal: mouseRelease ? { ...primary.nativeOriginal, type: 'mouseup' } : primary.nativeOriginal } : undefined;
      result.triggerInterpretation = mouseRelease ? { actionId: primary.id, mapping: 'trusted-mouse-click-to-release',
        meaning: 'mouse-release-half-only', wholeGesture: false } : null;
      if (collector) try {
        result.evidence = collector.finish({ completeExport: result.exportComplete, dataLoss: s.dataLoss,
          clockMarkers,
          rendererClockRelation: s.rendererClockRelation, trigger });
      } catch { markError(s, 'input-trace-analysis-failed'); }
      result.multipleActions = result.actions.map(a => ({ id: a.id, binding: a === primary ? 'primary-evidence'
        : a.coverage === 'snapshot-gap' ? 'unknown-snapshot-gap' : 'unknown-additional-action',
        inputMeaning: a === primary && mouseRelease ? 'mouse-release-half-only' : 'native-event-only', exclusiveCpuClaim: false }));
      result.dataLoss = s.dataLoss; result.errors = [...s.errors]; result.omittedTriggers = omittedTriggers;
      result.rejectedForeignTriggers = foreignTriggers;
      result.captureFinishedAbs = time();
      try {
        if (result.exportComplete && result.dataLoss === false && result.cleanupConfirmed && !result.errors.length
          && result.evidence?.status === 'complete') result.status = 'complete';
      } catch { result.evidence = null; result.errors.push('input-trace-analysis-failed'); }
      outputBound(result);
      await publication(s, result);
      say(result.cleanupConfirmed ? 'snapshot-closed' : 'unknown', 'input-events-only', {
        exportComplete: result.exportComplete, dataLoss: result.dataLoss, cleanupConfirmed: result.cleanupConfirmed,
        persisted: lastPublication?.recordingId === s.id ? lastPublication.persisted : null, errors: result.errors });
    }
    return result.cleanupConfirmed;
  }
  function launchCapture(s) {
    if (job) return job;
    if (!s || s.retired || s.captureStarted) return Promise.resolve(false);
    dropForeign(pending, s); dropForeign(s.actions, s);
    if (!pending.size && !s.actions.size && !s.preserveRequested) return Promise.resolve(false);
    s.captureStarted = true;
    for (const action of pending.values()) addAction(s.actions, action); pending.clear();
    job = exclusive(() => exportSnapshot(s)).catch(() => { markError(s, 'input-snapshot-failed'); return false; });
    const flight = job;
    flight.then(() => {
      if (job === flight) job = null;
      if (!s.retired) { s.retireRequested = true; requestCleanup(s); }
      if (!paused && !disposed && !session) void start();
    });
    return flight;
  }
  function pause(_reason = 'pause', options) {
    paused = true; revision++; stopPost();
    const s = session;
    stopClock(s);
    const preserve = get(options, 'preserve') === true;
    if (pauseFlight) return pauseFlight;
    if (s) {
      s.preserveRequested = preserve;
      const companion = get(options, 'companionCaptureId'); if (token(companion)) s.companionCaptureId = companion;
      if (preserve) {
        const actions = get(options, 'actions', []);
        try { if (Array.isArray(actions)) {
          omittedTriggers += Math.max(0, actions.length - limits.triggers);
          for (const raw of actions.slice(0, limits.triggers)) { const a = actionFields(raw); if (a) addAction(pending, a); }
        } } catch { markError(s, 'input-actions-invalid'); }
      } else { retiredTriggers += pending.size; pending.clear(); s.retireRequested = true; }
    } else { retiredTriggers += pending.size; pending.clear(); }
    pauseFlight = (async () => {
      if (job) await job;
      else if (s) {
        if (s.startupFlight) await s.startupFlight;
        if (preserve && s.ready && !s.retired && !s.captureStarted) await launchCapture(s);
      }
      return exclusive(() => cleanup(session || s));
    })().then(value => value === true, () => { markError(s, 'input-pause-unconfirmed'); return false; });
    const flight = pauseFlight; flight.then(() => { if (pauseFlight === flight) pauseFlight = null; });
    return flight;
  }
  async function resume() {
    try {
      if (disposed) return false;
      const rev = revision, wasPaused = paused;
      if (pauseFlight && !await pauseFlight) return false;
      if (disposed || revision !== rev) return false;
      if (wasPaused) blockedScope = null;
      paused = false; return start();
    } catch { return false; }
  }
  function dispose() { disposed = true; return pause('dispose'); }
  function state() {
    const s = session;
    const unknown = s && ((s.start && (s.start.state === 'unknown' || s.start.expired && s.start.state === 'pending'))
      || (s.retireRequested && !s.cleanupFlight && !s.captureActive && !clean(s))
      || (s.close && s.close.state !== 'ok' && (s.close.expired || s.close.state !== 'pending')));
    return { disposed, paused, phase: !s ? 'idle' : unknown ? 'unknown' : s.end ? 'ending' : s.ready ? 'recording' : 'starting',
      recordingId: s?.id || null, pendingTriggers: pending.size, omittedTriggers, retiredTriggers, foreignTriggers, snapshotActive: !!job,
      blocked: !!blockedScope, lastError, publication: lastPublication ? { ...lastPublication } : null, limits: { ...limits } };
  }
  return { start, observe, pause, resume, dispose, state };
}

module.exports = { createInputPreroll, validScope, actionFields, LIMITS };
