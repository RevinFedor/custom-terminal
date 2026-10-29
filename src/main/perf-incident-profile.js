'use strict';

// Bounded incident recorder (automatic or native manual), not a permanent DevTools connection. It never
// focuses/reloads a window, enables remote debugging, or takes over DevTools.
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createLayoutRootCollector, collectIncidentUiMetadata, UI_METADATA_LIMIT } = require('./perf-incident-ui');
const LIMIT = 16 * 1024 * 1024;
let inFlight = false;

function deadline(promise, label, ms = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ':timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}

async function saveJson(file, data, limit = LIMIT) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > limit) throw new Error('profile-size-limit');
  const fd = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_WRONLY |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(text); } finally { await fd.close(); }
  return Buffer.byteLength(text);
}

async function captureIncidentProfile({ request, webContents, directory, log, durationMs = 10000,
  inspector = require('inspector'), commandDeadline = deadline, ownerGuard = null, onReady = () => {} }) {
  if (!/^incident-\d+-\d+$/.test(request.id)) return;
  const manual = request.kind === 'manual';
  if (manual) {
    if (!ownerGuard?.isCurrent() || durationMs !== 10000 || request.durationMs !== 10000) {
      log('[Perf:IncidentProfile] id=' + request.id + ' refused=stale-or-invalid-manual-owner');
      return { outcome: 'refused', errors: ['stale-or-invalid-manual-owner'] };
    }
  }
  if (inFlight) {
    log('[Perf:IncidentProfile] id=' + request.id + ' skipped=capture-in-flight');
    try { await saveJson(path.join(directory, request.id + '.profile.json'), {
      requestedWallMs: request.requestedWallMs, receivedWallMs: Date.now(), skipped: 'capture-in-flight',
      coverage: 'not-recorded',
    }); } catch {}
    return { outcome: 'refused', errors: ['capture-in-flight'] };
  }
  inFlight = true;
  const file = suffix => path.join(directory, request.id + suffix);
  const status = { requestedWallMs: request.requestedWallMs, receivedWallMs: Date.now(),
    requestDelayMs: Date.now() - request.requestedWallMs, pid: request.pid,
    engines: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    intendedDurationMs: durationMs, samplingIntervalUs: 1000, errors: [], artifacts: {},
    ...(manual ? { kind: 'manual', reason: request.reason, requestId: request.requestId,
      originalOwner: request.owner, ownerAtStart: ownerGuard.current() } : {}),
    triggerStartAbs: Number.isFinite(request.startAbs) ? request.startAbs : null,
    triggerEndAbs: Number.isFinite(request.startAbs) && Number.isFinite(request.durationMs)
      ? request.startAbs + request.durationMs : null,
    actionId: typeof request.actionId === 'string' ? request.actionId.slice(0, 90) : null,
    coverage: manual ? 'manual-before-next-gesture; no synthetic slow-event; native sample remains independent'
      : 'after-trigger-only; native sample is captured independently' };
  let owned = false, cpuStarted = false, tracing = false, traceResolved = null;
  let mainSession = null, mainPost = null, mainStarted = false;
  let mainStopped = false, cpuStopped = false, rendererStopAttempted = false, traceStopped = false, traceRequested = false;
  let traceRoots = null;
  const dbg = webContents && !webContents.isDestroyed() ? webContents.debugger : null;
  const ownerCurrent = () => !ownerGuard || ownerGuard.isCurrent();
  const assertOwner = () => { if (!ownerCurrent()) throw new Error('original-owner-lost'); };
  const onDetach = (_e, reason) => { owned = false; status.detached = reason; };
  let traceComplete;
  const traceReady = new Promise(resolve => { traceComplete = resolve; });
  const onMessage = (_e, method, params) => {
    if (method === 'Tracing.tracingComplete' && tracing) { traceResolved = params; traceComplete(params); }
    if (method === 'Tracing.bufferUsage' && Number.isFinite(params?.percentFull)) {
      status.tracePeakBufferFraction = Math.max(status.tracePeakBufferFraction || 0, params.percentFull);
    }
  };
  const send = async (method, params = {}) => {
    assertOwner();
    if (!owned) return Promise.reject(new Error('debugger-ownership-lost'));
    const result = await commandDeadline(dbg.sendCommand(method, params), method);
    assertOwner();
    if (!owned) throw new Error('debugger-ownership-lost');
    return result;
  };
  // Document validity controls collection, not the lifetime of our debugger
  // attachment. Only cleanup commands may use the still-owned attachment after
  // navigation; a detach event revokes this proof even if another client attaches.
  const cleanupSend = async (method, params = {}) => {
    if (!owned || !dbg.isAttached()) throw new Error('debugger-ownership-lost');
    const result = await commandDeadline(dbg.sendCommand(method, params), method);
    if (!owned || !dbg.isAttached()) throw new Error('debugger-ownership-lost');
    return result;
  };
  const noteError = err => status.errors.push(String(err.message || err).slice(0, 180));
  const saveCpu = async (suffix, profile) => {
    if (manual && (!profile || !Array.isArray(profile.nodes) || profile.nodes.length === 0)) throw new Error('cpu-profile-empty');
    return { file: file(suffix), bytes: await saveJson(file(suffix), profile) };
  };
  const stopRendererCpu = async () => {
    rendererStopAttempted = true;
    const result = await cleanupSend('Profiler.stop'); cpuStopped = true;
    status.rendererStoppedWallMs = Date.now();
    assertOwner();
    status.artifacts.renderer = await saveCpu('.cpuprofile', result.profile);
  };
  try {
    assertOwner();
    // Main JS is profiled through an in-process inspector session; no port is
    // opened. Respect an already enabled external inspector/debugger.
    try {
      if (!inspector.url()) {
        mainSession = new inspector.Session(); mainSession.connect();
        mainPost = (method, params = {}) => commandDeadline(new Promise((resolve, reject) =>
          mainSession.post(method, params, (err, result) => err ? reject(err) : resolve(result))), method);
        await mainPost('Profiler.enable');
        await mainPost('Profiler.setSamplingInterval', { interval: status.samplingIntervalUs });
        mainStarted = true; await mainPost('Profiler.start');
        status.mainStartedWallMs = Date.now();
      } else status.mainSkipped = 'external-inspector';
    } catch (err) { noteError(err); }

    assertOwner();
    if (!dbg || dbg.isAttached() || webContents.isDevToolsOpened()) {
      status.rendererSkipped = 'no-renderer-or-external-debugger';
    } else {
      dbg.attach('1.3'); owned = true;
      dbg.on('detach', onDetach); dbg.on('message', onMessage);
      status.rendererPid = webContents.getOSProcessId();
      try {
        await send('Profiler.enable');
        await send('Profiler.setSamplingInterval', { interval: status.samplingIntervalUs });
        // Set before await so cleanup also covers a late reply after a timeout.
        cpuStarted = true;
        await send('Profiler.start');
        assertOwner();
        if (!owned) throw new Error('debugger-ownership-lost');
        status.rendererStartedWallMs = Date.now();
        status.rendererStartedAbs = performance.timeOrigin + performance.now();
        status.triggerOverlap = status.triggerEndAbs === null ? 'unknown'
          : status.rendererStartedAbs <= status.triggerEndAbs ? 'partial' : 'trigger-already-finished';
      } catch (err) {
        noteError(err); status.rendererSetupFailed = true;
        // A timeout does not prove Profiler.start had no effect. Settle this
        // same attempt once before starting another independent measurement.
        if (cpuStarted && owned) {
          try { await stopRendererCpu(); } catch (stopError) { noteError(stopError); }
        }
      }
      if (status.rendererSetupFailed && cpuStarted && !cpuStopped) {
        status.traceSkipped = 'renderer-cpu-stop-unconfirmed';
      } else if (owned) try {
        // Unlike contentTracing.startRecording, CDP rejects an existing global
        // recording rather than silently adopting it. Never end another trace.
        assertOwner();
        if (!owned) throw new Error('debugger-ownership-lost');
        traceRequested = true;
        // Chromium's wheel queue/ACK lives in `input`, not JS profiling. Keep
        // the existing privacy filter, capture quota and byte limits unchanged.
        const traceCategories = ['toplevel', 'devtools.timeline', 'v8', 'blink', 'cc', 'gpu', 'input', 'latencyInfo', 'blink.user_timing'];
        const start = dbg.sendCommand('Tracing.start', { transferMode: 'ReturnAsStream',
          bufferUsageReportingInterval: 1000,
          traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 8192,
            enableArgumentFilter: true, excludedCategories: ['*'],
            includedCategories: traceCategories } });
        start.then(() => { if (owned) tracing = true; }, () => {});
        await commandDeadline(start, 'Tracing.start');
        assertOwner();
        if (!owned) throw new Error('debugger-ownership-lost');
        status.traceCategories = traceCategories;
        status.traceStartedWallMs = Date.now();
      } catch (err) { noteError(err); }
      try { await send('Performance.enable'); status.metricsBefore = await send('Performance.getMetrics'); } catch (err) { noteError(err); }
    }
    if (manual && status.rendererStartedWallMs && owned) {
      assertOwner();
      status.readyWallMs = Date.now();
      onReady({ readyWallMs: status.readyWallMs, mainCpu: !!status.mainStartedWallMs,
        rendererCpu: true, trace: !!status.traceStartedWallMs });
    }
    if (mainStarted || cpuStarted || tracing) {
      let timer;
      try {
        const elapsed = new Promise(resolve => { timer = setTimeout(resolve, durationMs); });
        await (ownerGuard ? Promise.race([elapsed, ownerGuard.invalidated]) : elapsed);
        assertOwner();
      } finally { clearTimeout(timer); }
    }
  } catch (err) { noteError(err); }
  finally {
    if (mainStarted) {
      try {
        const result = await mainPost('Profiler.stop'); mainStopped = true;
        status.mainStoppedWallMs = Date.now();
        status.artifacts.main = await saveCpu('.main.cpuprofile', result.profile);
      }
      catch (err) { noteError(err); }
    }
    try { mainSession?.disconnect(); } catch {}
    if (owned) {
      try { status.metricsAfter = await send('Performance.getMetrics'); } catch {}
      if (cpuStarted && !rendererStopAttempted) {
        try { await stopRendererCpu(); }
        catch (err) { noteError(err); }
      }
      if (tracing) {
        let stream, fd;
        try {
          await cleanupSend('Tracing.end');
          const result = traceResolved || await commandDeadline(traceReady, 'Tracing.complete', 5000);
          traceStopped = true; status.traceStoppedWallMs = Date.now();
          status.traceDataLoss = result.dataLossOccurred;
          stream = result.stream;
          if (!stream) throw new Error('trace-stream-missing');
          assertOwner();
          fd = await fs.promises.open(file('.trace.json'), fs.constants.O_CREAT | fs.constants.O_WRONLY |
            fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          let bytes = 0, eof = false, chunks = 0;
          traceRoots = createLayoutRootCollector({ rendererPid: status.rendererPid });
          const exportStarted = performance.now();
          while (!eof) {
            if (++chunks > 128 || performance.now() - exportStarted > 15000) throw new Error('trace-export-time-limit');
            const part = await send('IO.read', { handle: stream, size: 262144 });
            const data = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
            if (bytes + data.length > LIMIT) throw new Error('trace-export-size-limit');
            await fd.writeFile(data); bytes += data.length; status.traceBytes = bytes;
            traceRoots.write(data); eof = part.eof;
          }
          if (bytes === 0) throw new Error('trace-export-empty');
          status.traceBytes = bytes; status.traceComplete = true;
          status.artifacts.trace = { file: file('.trace.json'), bytes };
        } catch (err) { noteError(err); status.traceComplete = false; }
        finally {
          if (fd) await fd.close().catch(() => {});
          if (stream && owned) await cleanupSend('IO.close', { handle: stream }).catch(noteError);
        }
      }
    }
    // The observer is outside BOTH CPU profiles and the browser trace. A
    // rejected/late trace start or unconfirmed stop must not contaminate an
    // existing recording. Even on loss of ownership, preserve prefix root IDs.
    try {
      let zoomFactor;
      try { if (!webContents?.isDestroyed()) zoomFactor = webContents?.getZoomFactor?.(); } catch {}
      const ui = await collectIncidentUiMetadata({
        sendCommand: (method, params) => dbg.sendCommand(method, params),
        isOwned: () => owned && ownerCurrent() && !webContents.isDestroyed() && dbg.isAttached(),
        traceRoots: traceRoots?.finish(status.traceComplete === true),
        captureStopped: (!mainStarted || mainStopped) && (!cpuStarted || cpuStopped) && (!traceRequested || traceStopped),
        skipReason: status.rendererSkipped ? (dbg ? 'external-debugger' : 'renderer-unavailable') : undefined,
        zoomFactor,
      });
      await saveJson(file('.ui.json'), ui, UI_METADATA_LIMIT);
      status.uiMetadata = { file: request.id + '.ui.json', status: ui.status,
        source: ui.source, moment: ui.moment, elapsedMs: ui.elapsedMs,
        rootIds: ui.trace.roots.length, mappedRoots: ui.roots.filter(root => root.status === 'ok').length,
        animations: ui.animations.length, errors: ui.errors.length,
        ...(ui.reason ? { reason: ui.reason } : {}) };
    } catch {
      noteError(new Error('ui-metadata-collection-or-save-failed'));
      status.uiMetadata = { file: request.id + '.ui.json', status: 'failed' };
    }
    if (owned) { try { dbg.detach(); } catch {} }
    dbg?.removeListener('detach', onDetach); dbg?.removeListener('message', onMessage);
    status.finishedWallMs = Date.now();
    if (manual) {
      status.profileFile = file('.profile.json');
      status.currentOwner = ownerGuard.current(); status.ownerCurrent = ownerCurrent();
      status.outcome = status.ownerCurrent && status.readyWallMs && status.errors.length === 0
        && status.artifacts.main?.bytes > 0 && status.artifacts.renderer?.bytes > 0 && status.artifacts.trace?.bytes > 0
        && status.traceComplete === true && status.traceDataLoss === false ? 'completed' : 'incomplete';
    }
    try { await saveJson(file('.profile.json'), status); }
    catch (err) { noteError(err); if (manual) status.outcome = 'failed-status-save'; }
    log('[Perf:IncidentProfile] id=' + request.id + ' delayMs=' + status.requestDelayMs +
      ' durationMs=' + (status.finishedWallMs - status.receivedWallMs) + ' errors=' + status.errors.length +
      ' overlap=' + (status.triggerOverlap || 'unknown') + ' traceComplete=' + Number(status.traceComplete === true) +
      ' dataLoss=' + String(status.traceDataLoss ?? 'unknown') + ' peakBuffer=' + String(status.tracePeakBufferFraction ?? 'unknown') +
      ' file=' + file('.profile.json') + (manual ? ' outcome=' + status.outcome + ' ownerCurrent=' + status.ownerCurrent : ''));
    inFlight = false;
  }
  return status;
}

module.exports = { captureIncidentProfile, deadline };
