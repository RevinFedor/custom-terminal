'use strict';

// An incident-only recorder, not a permanent DevTools connection. It never
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
}

async function captureIncidentProfile({ request, webContents, directory, log, durationMs = 10000, inspector = require('inspector') }) {
  if (!/^incident-\d+-\d+$/.test(request.id) || inFlight) return;
  inFlight = true;
  const file = suffix => path.join(directory, request.id + suffix);
  const status = { requestedWallMs: request.requestedWallMs, receivedWallMs: Date.now(),
    requestDelayMs: Date.now() - request.requestedWallMs, pid: request.pid,
    engines: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    intendedDurationMs: durationMs, errors: [], coverage: 'after-trigger-only; native sample is captured independently' };
  let owned = false, cpuStarted = false, tracing = false, traceResolved = null;
  let mainSession = null, mainPost = null, mainStarted = false;
  let mainStopped = false, cpuStopped = false, traceStopped = false, traceRequested = false;
  let traceRoots = null;
  const dbg = webContents && !webContents.isDestroyed() ? webContents.debugger : null;
  const onDetach = (_e, reason) => { owned = false; status.detached = reason; };
  let traceComplete;
  const traceReady = new Promise(resolve => { traceComplete = resolve; });
  const onMessage = (_e, method, params) => {
    if (method === 'Tracing.tracingComplete' && tracing) { traceResolved = params; traceComplete(params); }
  };
  const send = (method, params = {}) => {
    if (!owned) return Promise.reject(new Error('debugger-ownership-lost'));
    return deadline(dbg.sendCommand(method, params), method);
  };
  const noteError = err => status.errors.push(String(err.message || err).slice(0, 180));
  try {
    // Main JS is profiled through an in-process inspector session; no port is
    // opened. Respect an already enabled external inspector/debugger.
    try {
      if (!inspector.url()) {
        mainSession = new inspector.Session(); mainSession.connect();
        mainPost = (method, params = {}) => deadline(new Promise((resolve, reject) =>
          mainSession.post(method, params, (err, result) => err ? reject(err) : resolve(result))), method);
        await mainPost('Profiler.enable');
        await mainPost('Profiler.setSamplingInterval', { interval: 10000 });
        mainStarted = true; await mainPost('Profiler.start');
        status.mainStartedWallMs = Date.now();
      } else status.mainSkipped = 'external-inspector';
    } catch (err) { noteError(err); }

    if (!dbg || dbg.isAttached() || webContents.isDevToolsOpened()) {
      status.rendererSkipped = 'no-renderer-or-external-debugger';
    } else {
      dbg.attach('1.3'); owned = true;
      dbg.on('detach', onDetach); dbg.on('message', onMessage);
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: 10000 });
      // Set before await so cleanup also covers a late reply after a timeout.
      cpuStarted = true;
      await send('Profiler.start');
      status.rendererPid = webContents.getOSProcessId();
      status.rendererStartedWallMs = Date.now();
      status.rendererStartedAbs = performance.timeOrigin + performance.now();
      try {
        // Unlike contentTracing.startRecording, CDP rejects an existing global
        // recording rather than silently adopting it. Never end another trace.
        if (!owned) throw new Error('debugger-ownership-lost');
        traceRequested = true;
        const start = dbg.sendCommand('Tracing.start', { transferMode: 'ReturnAsStream',
          traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 8192,
            enableArgumentFilter: true, excludedCategories: ['*'],
            includedCategories: ['toplevel', 'devtools.timeline', 'v8', 'blink', 'cc', 'gpu'] } });
        start.then(() => { if (owned) tracing = true; }, () => {});
        await deadline(start, 'Tracing.start');
        status.traceStartedWallMs = Date.now();
      } catch (err) { noteError(err); }
      try { await send('Performance.enable'); status.metricsBefore = await send('Performance.getMetrics'); } catch (err) { noteError(err); }
    }
    if (mainStarted || cpuStarted || tracing) await new Promise(resolve => setTimeout(resolve, durationMs));
  } catch (err) { noteError(err); }
  finally {
    if (mainStarted) {
      try {
        const result = await mainPost('Profiler.stop'); mainStopped = true;
        status.mainStoppedWallMs = Date.now();
        await saveJson(file('.main.cpuprofile'), result.profile);
      }
      catch (err) { noteError(err); }
    }
    try { mainSession?.disconnect(); } catch {}
    if (owned) {
      try { status.metricsAfter = await send('Performance.getMetrics'); } catch {}
      if (cpuStarted) {
        try {
          const result = await send('Profiler.stop'); cpuStopped = true;
          status.rendererStoppedWallMs = Date.now();
          await saveJson(file('.cpuprofile'), result.profile);
        }
        catch (err) { noteError(err); }
      }
      if (tracing) {
        let stream, fd;
        try {
          await send('Tracing.end');
          const result = traceResolved || await deadline(traceReady, 'Tracing.complete', 5000);
          traceStopped = true; status.traceStoppedWallMs = Date.now();
          status.traceDataLoss = result.dataLossOccurred;
          stream = result.stream;
          if (!stream) throw new Error('trace-stream-missing');
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
          status.traceBytes = bytes; status.traceComplete = true;
        } catch (err) { noteError(err); status.traceComplete = false; }
        finally {
          if (fd) await fd.close().catch(() => {});
          if (stream && owned) await send('IO.close', { handle: stream }).catch(() => {});
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
        isOwned: () => owned && !webContents.isDestroyed() && dbg.isAttached(),
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
    try { await saveJson(file('.profile.json'), status); } catch (err) { noteError(err); }
    log('[Perf:IncidentProfile] id=' + request.id + ' delayMs=' + status.requestDelayMs +
      ' durationMs=' + (status.finishedWallMs - status.receivedWallMs) + ' errors=' + status.errors.length +
      ' file=' + file('.profile.json'));
    inFlight = false;
  }
}

module.exports = { captureIncidentProfile, deadline };
