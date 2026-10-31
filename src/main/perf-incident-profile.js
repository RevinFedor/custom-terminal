'use strict';

// Bounded incident recorder. Report completion is NOT profiler retirement.
// In particular a command deadline never releases the global tracing lane.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { issue, settled, timing } = require('./perf-profile-lifetime');
const { createLayoutRootCollector, collectIncidentUiMetadata, UI_METADATA_LIMIT } = require('./perf-incident-ui');
const LIMIT = 16 * 1024 * 1024;
const STOP_GRACE_MS = 10000, EXPORT_MS = 10000;
let inFlight = null;

function deadline(promise, label, ms = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ':timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}

async function saveJson(file, data, limit = LIMIT) {
  return require('./perf-profile-json').writeProfileJson(file, data, limit);
}

function attachRetirement(report, receipt, whenRetired = Promise.resolve(receipt)) {
  // Promises are process-local, never serialized into the immutable report.
  return Object.defineProperties(report, {
    retirement: { value: Promise.resolve(receipt) },
    whenRetired: { value: whenRetired },
  });
}
function refused(reason) {
  const receipt = { state: 'retired', confirmed: true, reason: 'no-capture-effect', leaseId: null };
  return attachRetirement({ outcome: 'refused', errors: [reason], leaseId: null, retirementState: receipt }, receipt);
}

async function captureIncidentProfile({ request, webContents, directory, log, durationMs = 10000,
  inspector = require('inspector'), commandDeadline = deadline, ownerGuard = null, onReady = () => {},
  captureOptions = null }) {
  if (!/^incident-\d+-\d+$/.test(request.id)) return refused('invalid-incident-id');
  const manual = request.kind === 'manual';
  // Internal mechanics only: no request.kind, public flag, quota or admission
  // changes. The private launcher caller must already own durable pilot/quota
  // admission. Manual cannot opt into this mode, even with these options.
  const armed = captureOptions?.mode === 'private-armed';
  if (captureOptions && (!armed || manual || !Number.isInteger(captureOptions.durationMs)
    || captureOptions.durationMs < 1 || captureOptions.durationMs > 40000
    || captureOptions.samplingIntervalUs !== 8000 || !ownerGuard?.isCurrent())) {
    return refused('invalid-private-capture-options');
  }
  if (armed) durationMs = captureOptions.durationMs;
  if (manual && (!ownerGuard?.isCurrent() || durationMs !== 10000 || request.durationMs !== 10000)) {
    log('[Perf:IncidentProfile] id=' + request.id + ' refused=stale-or-invalid-manual-owner');
    return refused('stale-or-invalid-manual-owner');
  }
  if (inFlight) {
    log('[Perf:IncidentProfile] id=' + request.id + ' skipped=capture-in-flight');
    try { await saveJson(path.join(directory, request.id + '.profile.json'), {
      requestedWallMs: request.requestedWallMs, receivedWallMs: Date.now(), skipped: 'capture-in-flight',
      coverage: 'not-recorded',
    }); } catch {}
    return refused('capture-in-flight');
  }
  const lease = { id: randomUUID() }; inFlight = lease;
  const now = () => performance.now();
  const abs = () => performance.timeOrigin + now();
  const file = suffix => path.join(directory, request.id + suffix);
  const status = { requestedWallMs: request.requestedWallMs, receivedWallMs: Date.now(),
    requestDelayMs: Date.now() - request.requestedWallMs, pid: request.pid, leaseId: lease.id,
    engines: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    intendedDurationMs: durationMs, samplingIntervalUs: armed ? 8000 : 1000, errors: [], artifacts: {},
    ...(manual ? { kind: 'manual', reason: request.reason, requestId: request.requestId } : {}),
    ...(armed ? { captureMode: 'private-armed' } : {}),
    ...(ownerGuard ? { originalOwner: manual ? request.owner : ownerGuard.owner, ownerAtStart: ownerGuard.current() } : {}),
    triggerStartAbs: Number.isFinite(request.startAbs) ? request.startAbs : null,
    triggerEndAbs: Number.isFinite(request.startAbs) && Number.isFinite(request.durationMs)
      ? request.startAbs + request.durationMs : null,
    actionId: typeof request.actionId === 'string' ? request.actionId.slice(0, 90) : null,
    coverage: armed ? 'prearmed; exact start/stop brackets per target; clock mapping uncalibrated'
      : manual ? 'manual-before-next-gesture; no synthetic slow-event; native sample remains independent'
        : 'after-trigger-only; native sample is captured independently' };
  let owned = false, detached = null, mainSession = null, mainOwned = false;
  let mainStart = null, mainStop = null, cpuStart = null, cpuStop = null;
  let traceStart = null, traceEnd = null, traceClose = null, traceResolved = null;
  let traceRoots = null, firstStartMonoMs = null, stopUntil = null, completionExpired = false;
  const traceClockMarkers = [];
  const clockSnapshot = () => { const tick = now(); return { now: tick, timeOrigin: performance.timeOrigin, epochMs: performance.timeOrigin + tick }; };
  let collecting = true, cleanupFlight = null, cleanupQueued = false, revision = 0, failedRevision = -1, retired = false;
  let resolveRetired, traceComplete;
  const whenRetired = new Promise(resolve => { resolveRetired = resolve; });
  const traceReady = new Promise(resolve => { traceComplete = resolve; });
  const operations = [];
  const attachmentGeneration = randomUUID();
  const dbg = webContents && !webContents.isDestroyed() ? webContents.debugger : null;
  const ownerCurrent = () => !ownerGuard || ownerGuard.isCurrent();
  const authority = () => { try { return owned && dbg.isAttached(); } catch { return false; } };
  const assertOwner = () => { if (!ownerCurrent()) throw new Error('original-owner-lost'); };
  const noteError = err => {
    const message = String(err?.message || err).slice(0, 180);
    if (!status.errors.includes(message) && status.errors.length < 32) status.errors.push(message);
  };
  const onDetach = (_e, reason) => {
    owned = false; detached = String(reason).slice(0, 100); revision++; requestCleanup();
  };
  const onMessage = (_e, method, params) => {
    if (!authority()) return;
    // A completion before our successful START + issued END is foreign. Even
    // a synchronous completion inside sendCommand(END) must have both proofs.
    if (method === 'Tracing.tracingComplete' && traceStart?.state === 'ok'
      && traceEnd?.sent && traceEnd.state !== 'refused' && !traceResolved) {
      traceResolved = { stream: typeof params?.stream === 'string' && params.stream.length <= 256 ? params.stream : null,
        dataLossOccurred: params?.dataLossOccurred, completedMonoMs: now() };
      revision++; traceComplete(traceResolved); requestCleanup();
    }
    if (method === 'Tracing.bufferUsage' && traceStart?.state === 'ok' && Number.isFinite(params?.percentFull) && collecting) {
      status.tracePeakBufferFraction = Math.max(status.tracePeakBufferFraction || 0, params.percentFull);
    }
  };
  const changed = op => {
    revision++;
    if (op.method === 'Profiler.stop' && op.state === 'ok') {
      const profile = op.value?.profile;
      op.profileStartTimeUs = Number.isFinite(profile?.startTime) ? profile.startTime : null;
      op.profileEndTimeUs = Number.isFinite(profile?.endTime) ? profile.endTime : null;
    }
    // Late profiles are cleanup evidence only. Never retain/save a new whole
    // CPU object in a report already returned to its caller.
    if (!collecting) {
      op.value = null;
      try { log('[Perf:IncidentProfile] id=' + request.id + ' phase=late-settle method=' + op.method
        + ' state=' + op.state + ' leaseId=' + lease.id + ' attachmentGeneration=' + attachmentGeneration); } catch {}
    }
    requestCleanup();
  };
  function command(method, invoke, allowed, isStart = false) {
    const op = issue(method, invoke, { now, allowed, onSettle: changed, onIssue: issued => {
      if (isStart && firstStartMonoMs === null) firstStartMonoMs = issued.issuedMonoMs;
    } });
    operations.push(op); return op;
  }
  const setupUntil = () => armed && firstStartMonoMs !== null ? firstStartMonoMs + 5000 : now() + 3000;
  const collectionAllowed = () => ownerCurrent() && (!armed || firstStartMonoMs === null
    || now() < firstStartMonoMs + Math.min(5000, durationMs));
  const wait = (op, until) => settled(op, { commandDeadline, until, now });
  const check = async (op, until) => {
    if (!await wait(op, until)) throw new Error(op.error || op.method + ':timeout');
    return op.value;
  };
  const send = async (method, params = {}, until = setupUntil(), setup = true) => {
    assertOwner();
    const op = command(method, () => dbg.sendCommand(method, params),
      () => authority() && (setup ? collectionAllowed() : ownerCurrent()));
    const result = await check(op, until); assertOwner();
    if (!authority()) throw new Error('debugger-ownership-lost');
    // Keep command settlement/ownership proof, not every raw export packet.
    if (method === 'IO.read') op.value = null;
    return result;
  };
  const post = (method, params = {}, isStart = false) => command(method, () => new Promise((resolve, reject) =>
    mainSession.post(method, params, (error, result) => error ? reject(error) : resolve(result))),
  () => mainOwned && (!isStart || collectionAllowed()), isStart);
  const cpuClean = (start, stop) => !start || start.state === 'refused' || stop?.state === 'ok';
  const traceClean = () => !traceStart || traceStart.state === 'refused'
    || (traceStart.state === 'ok' && traceEnd?.state === 'ok' && !!traceResolved && traceClose?.state === 'ok');
  const stopped = () => cpuClean(mainStart, mainStop) && cpuClean(cpuStart, cpuStop)
    && (!traceStart || traceStart.state === 'refused' || (traceEnd?.state === 'ok' && !!traceResolved));
  const stamps = () => ({ clockDomain: 'main-performance-now-ms', timeOriginWallMs: performance.timeOrigin,
    firstStartMonoMs, plannedStopMonoMs: armed && firstStartMonoMs !== null ? firstStartMonoMs + durationMs : null,
    main: { start: timing(mainStart), stop: timing(mainStop) },
    renderer: { start: timing(cpuStart), stop: timing(cpuStop) },
    trace: { start: timing(traceStart), stop: timing(traceEnd), completeMonoMs: traceResolved?.completedMonoMs ?? null,
      close: timing(traceClose) }, clockMapping: 'uncalibrated-issue-ack-brackets-only' });
  const receipt = confirmed => ({ state: confirmed ? 'retired' : 'unknown', confirmed,
    leaseId: lease.id, attachmentGeneration, revision, detached,
    reason: confirmed ? 'no-effect-or-stop-and-stream-close-confirmed' : 'capture-cleanup-unconfirmed',
    profiles: stamps() });

  async function stopCpu(which, until) {
    const start = which === 'main' ? mainStart : cpuStart;
    if (!start || start.state === 'refused') return;
    await wait(start, until);
    // STOP before a pending START's actual effect could leave the profiler
    // running. Keep the raw START and dispatch one STOP only after settlement.
    if (start.state === 'pending') return;
    let stop = which === 'main' ? mainStop : cpuStop;
    if (!stop) {
      if (which === 'main') {
        if (!mainOwned) return;
        stop = mainStop = post('Profiler.stop');
      } else {
        if (!authority()) return;
        stop = cpuStop = command('Profiler.stop', () => dbg.sendCommand('Profiler.stop'), authority);
      }
    }
    await wait(stop, until);
  }
  async function stopTrace(until) {
    if (!traceStart) return;
    await wait(traceStart, until);
    if (traceStart.state !== 'ok' || !authority()) return;
    if (!traceEnd) traceEnd = command('Tracing.end', () => dbg.sendCommand('Tracing.end'), authority);
    await wait(traceEnd, until);
    if (!traceResolved && !completionExpired) {
      const remaining = Math.min(5000, until - now());
      if (remaining > 0) try { await commandDeadline(traceReady, 'Tracing.complete', remaining); }
      catch { completionExpired = true; }
      else completionExpired = true;
    }
  }
  async function clockMarker(label, until) {
    if (!armed || !authority() || traceStart?.state !== 'ok' || traceEnd || traceClockMarkers.some(m => m.label === label)) return;
    const marker = { label, syncId: 'profile-' + lease.id + '-' + label, before: clockSnapshot(), after: null };
    traceClockMarkers.push(marker);
    const op = command('Tracing.recordClockSyncMarker', () => dbg.sendCommand('Tracing.recordClockSyncMarker', { syncId: marker.syncId }), authority);
    if (await wait(op, until)) marker.after = clockSnapshot();
    else noteError(new Error('trace-clock-marker-unconfirmed'));
  }
  async function closeTrace(until) {
    if (!traceResolved?.stream || !authority()) return;
    if (!traceClose) traceClose = command('IO.close', () => dbg.sendCommand('IO.close', { handle: traceResolved.stream }), authority);
    await wait(traceClose, until);
  }
  function retire() {
    if (retired || operations.some(op => op.state === 'pending')
      || !cpuClean(mainStart, mainStop) || !cpuClean(cpuStart, cpuStop) || !traceClean()) return false;
    // Never detach a replacement, even when every own STOP had already ACKed.
    if (owned) {
      if (!authority()) return false;
      try { dbg.detach(); owned = false; } catch { return false; }
    }
    if (mainOwned) {
      try { mainSession.disconnect(); mainOwned = false; } catch { return false; }
    }
    retired = true;
    dbg?.removeListener('detach', onDetach); dbg?.removeListener('message', onMessage);
    if (inFlight === lease) inFlight = null;
    resolveRetired(receipt(true));
    try { log('[Perf:IncidentProfile] id=' + request.id + ' retirement=retired leaseId=' + lease.id
      + ' attachmentGeneration=' + attachmentGeneration + ' revision=' + revision); } catch {}
    return true;
  }
  function requestCleanup() {
    if (collecting || retired || cleanupQueued || cleanupFlight) return;
    cleanupQueued = true;
    void Promise.resolve().then(async () => {
      cleanupQueued = false;
      const before = revision;
      cleanupFlight = (async () => {
        await Promise.all([stopCpu('main', stopUntil), stopCpu('renderer', stopUntil), stopTrace(stopUntil)]);
        await closeTrace(stopUntil); retire();
      })().catch(() => {});
      await cleanupFlight; cleanupFlight = null; failedRevision = before;
      // Event-driven catch-up only. No timer, polling, STOP/END replay or new
      // grace period when a late raw operation settles.
      if (!retired && revision !== failedRevision) requestCleanup();
    }).catch(() => {});
  }
  const saveCpu = async (suffix, profile) => {
    if (manual && (!profile || !Array.isArray(profile.nodes) || profile.nodes.length === 0)) throw new Error('cpu-profile-empty');
    return { file: file(suffix), bytes: await saveJson(file(suffix), profile) };
  };
  try {
    assertOwner();
    try {
      if (!inspector.url()) {
        mainSession = new inspector.Session(); mainSession.connect(); mainOwned = true;
        await check(post('Profiler.enable'), setupUntil());
        await check(post('Profiler.setSamplingInterval', { interval: status.samplingIntervalUs }), setupUntil());
        assertOwner();
        mainStart = post('Profiler.start', {}, true); await check(mainStart, setupUntil());
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
        cpuStart = command('Profiler.start', () => dbg.sendCommand('Profiler.start'), () => authority() && collectionAllowed(), true);
        await check(cpuStart, setupUntil()); assertOwner();
        if (!authority()) throw new Error('debugger-ownership-lost');
        status.rendererStartedWallMs = Date.now(); status.rendererStartedAbs = abs();
        status.triggerOverlap = status.triggerEndAbs === null ? 'unknown'
          : status.rendererStartedAbs <= status.triggerEndAbs ? 'partial' : 'trigger-already-finished';
      } catch (err) {
        noteError(err); status.rendererSetupFailed = true;
        await stopCpu('renderer', setupUntil());
      }
      if (status.rendererSetupFailed && !cpuClean(cpuStart, cpuStop)) {
        status.traceSkipped = 'renderer-cpu-stop-unconfirmed';
      } else if (authority()) try {
        assertOwner();
        // Broad all-thread task/blink/cc/gpu tracing filled the fixed 8MiB ring
        // after 7.6s of the real 40s pilot. Isolate CPU profiles and explicit
        // sync sites already cover executed code. Keep input and engine phases;
        // do not claim all scheduler tasks, raster/GPU work or arbitrary marks.
        const traceCategories = armed ? ['devtools.timeline', 'v8', 'input', 'latencyInfo']
          : ['toplevel', 'devtools.timeline', 'v8', 'blink', 'cc', 'gpu', 'input', 'latencyInfo', 'blink.user_timing'];
        if (armed) status.traceScope = 'input; JS callbacks; renderer style/layout/paint; GC; all-thread scheduler and GPU work unclaimed';
        traceStart = command('Tracing.start', () => dbg.sendCommand('Tracing.start', { transferMode: 'ReturnAsStream',
          bufferUsageReportingInterval: 1000,
          traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 8192,
            enableArgumentFilter: true, excludedCategories: ['*'], includedCategories: traceCategories } }),
        () => authority() && collectionAllowed(), true);
        await check(traceStart, setupUntil()); assertOwner();
        if (!authority()) throw new Error('debugger-ownership-lost');
        status.traceCategories = traceCategories; status.traceStartedWallMs = Date.now();
        await clockMarker('start', setupUntil());
      } catch (err) { noteError(err); }
      try { await send('Performance.enable'); status.metricsBefore = await send('Performance.getMetrics'); } catch (err) { noteError(err); }
    }
    if (armed && (mainStart?.state !== 'ok' || cpuStart?.state !== 'ok' || traceStart?.state !== 'ok'
      || !authority() || now() >= firstStartMonoMs + Math.min(5000, durationMs))) {
      throw new Error('armed-setup-incomplete');
    }
    if ((manual || armed) && status.rendererStartedWallMs && authority()) {
      assertOwner();
      status.readyWallMs = Date.now(); status.readyMonoMs = now();
      const owner = ownerGuard?.owner || (manual ? request.owner : null) || status.ownerAtStart;
      status.ready = { readyWallMs: status.readyWallMs, readyMonoMs: status.readyMonoMs,
        mainCpu: mainStart?.state === 'ok', rendererCpu: true, trace: traceStart?.state === 'ok',
        leaseId: lease.id, samplingIntervalUs: status.samplingIntervalUs,
        plannedStopMonoMs: armed ? firstStartMonoMs + durationMs : null,
        targets: [{ role: 'main', pid: process.pid, mainTimeOriginWallMs: performance.timeOrigin,
          osProcessStartIdentity: null, profileId: lease.id + ':main', start: timing(mainStart) },
          { role: 'renderer', pid: status.rendererPid, webContentsId: webContents.id ?? null,
            owner, attachmentGeneration, profileId: lease.id + ':renderer', start: timing(cpuStart) }],
        clockDomain: 'main-performance-now-ms', clockMapping: 'uncalibrated-issue-ack-brackets-only' };
      onReady(status.ready);
    }
    if ([mainStart, cpuStart, traceStart].some(op => op?.state === 'ok')) {
      let timer;
      try {
        const elapsed = new Promise(resolve => { timer = setTimeout(resolve,
          armed ? Math.max(0, firstStartMonoMs + durationMs - now()) : durationMs); });
        await (ownerGuard ? Promise.race([elapsed, ownerGuard.invalidated]) : elapsed); assertOwner();
      } finally { clearTimeout(timer); }
    }
  } catch (err) { noteError(err); }
  finally {
    // All targets share this one cleanup grace; exports have their own single
    // deadline. Late receipts advance the same operations outside this report.
    stopUntil = now() + STOP_GRACE_MS;
    await clockMarker('stop', stopUntil);
    if (armed) status.traceClockMarkers = traceClockMarkers;
    if (authority() && ownerCurrent()) try { status.metricsAfter = await send('Performance.getMetrics', {}, stopUntil, false); } catch {}
    await Promise.all([stopCpu('main', stopUntil), stopCpu('renderer', stopUntil), stopTrace(stopUntil)]);
    const exportUntil = now() + EXPORT_MS;
    for (const [name, stop, suffix] of [['main', mainStop, '.main.cpuprofile'], ['renderer', cpuStop, '.cpuprofile']]) {
      if (stop?.state !== 'ok') continue;
      status[name + 'StoppedWallMs'] = Date.now();
      try { assertOwner(); status.artifacts[name] = await saveCpu(suffix, stop.value?.profile); }
      catch (err) { noteError(err); }
      finally { stop.value = null; }
    }
    if (traceEnd?.state === 'ok' && traceResolved) {
      status.traceStoppedWallMs = Date.now(); status.traceDataLoss = traceResolved.dataLossOccurred;
      let fd, projection;
      try {
        if (!traceResolved.stream) throw new Error('trace-stream-missing');
        assertOwner();
        if (armed) {
          const { createTraceProjectionWriter, LIMITS } = require('./perf-trace-projection');
          const incidentDir = await fs.promises.realpath(directory);
          projection = createTraceProjectionWriter({ file: path.join(incidentDir, request.id + '.trace.json'),
            incidentDir, incidentId: request.id, mainPid: process.pid, rendererPid: status.rendererPid,
            deadlineAt: Math.floor(Date.now() + Math.max(0, exportUntil - now())),
            clockSyncIds: traceClockMarkers.map(marker => marker.syncId),
            packagedRoot: path.resolve(__dirname, '..', '..') });
          status.traceProjectionWorker = await projection.ready;
          let eof = false, chunks = 0, rawBytes = 0;
          while (!eof) {
            if (now() >= exportUntil) throw new Error('trace-export-time-limit');
            if (++chunks > LIMITS.rawBytes / LIMITS.chunkBytes) throw new Error('trace-export-chunk-limit');
            const part = await send('IO.read', { handle: traceResolved.stream, size: LIMITS.chunkBytes }, exportUntil, false);
            const data = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
            const ack = await projection.write(data);
            rawBytes += data.length; eof = part.eof === true;
            status.traceRawBytes = rawBytes; status.traceBytes = ack.projectedBytes;
            if (!ack.continue) break;
          }
          const projected = await projection.finish({ completeExport: eof, dataLoss: traceResolved.dataLossOccurred !== false });
          status.traceProjection = projected;
          status.traceNativeDataLoss = traceResolved.dataLossOccurred;
          status.traceDataLoss = projected.dataLoss;
          status.traceComplete = projected.complete;
          status.traceBytes = projected.projectedBytes;
          status.artifacts.trace = { file: file('.trace.json'), bytes: projected.projectedBytes,
            format: 'noted-trace-projection-v1', coverage: projected.claims };
          if (!projected.complete) noteError(new Error('trace-projection-incomplete'));
          if (projected.dataLoss) noteError(new Error('trace-projection-data-loss'));
        } else {
        fd = await fs.promises.open(file('.trace.json'), fs.constants.O_CREAT | fs.constants.O_WRONLY |
          fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        let bytes = 0, eof = false, chunks = 0;
        traceRoots = createLayoutRootCollector({ rendererPid: status.rendererPid });
        while (!eof) {
          if (++chunks > 256 || now() >= exportUntil) throw new Error('trace-export-time-limit');
          const part = await send('IO.read', { handle: traceResolved.stream, size: 65536 }, exportUntil, false);
          const data = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
          if (bytes + data.length > LIMIT) throw new Error('trace-export-size-limit');
          await fd.writeFile(data); bytes += data.length; status.traceBytes = bytes;
          traceRoots.write(data); eof = part.eof;
        }
        if (bytes === 0) throw new Error('trace-export-empty');
        status.traceComplete = true; status.artifacts.trace = { file: file('.trace.json'), bytes };
        }
      } catch (err) { noteError(err); status.traceComplete = false; }
      finally {
        if (projection) status.traceProjectionClose = await projection.abort();
        if (fd) await fd.close().catch(() => {});
      }
    }
    await closeTrace(exportUntil);
    for (const op of operations) if (op.error) noteError(op.error);
    if (!stopped() || !traceClean()) noteError(new Error('capture-cleanup-unconfirmed'));
    try {
      let zoomFactor;
      try { if (!webContents?.isDestroyed()) zoomFactor = webContents?.getZoomFactor?.(); } catch {}
      const ui = await collectIncidentUiMetadata({
        sendCommand: (method, params) => dbg.sendCommand(method, params),
        isOwned: () => authority() && ownerCurrent() && !webContents.isDestroyed(),
        traceRoots: traceRoots?.finish(status.traceComplete === true), captureStopped: stopped() && traceClean()
          && !(traceStart?.sent && traceStart.state === 'refused'),
        skipReason: status.rendererSkipped ? (dbg ? 'external-debugger' : 'renderer-unavailable') : undefined, zoomFactor,
      });
      await saveJson(file('.ui.json'), ui, UI_METADATA_LIMIT);
      status.uiMetadata = { file: request.id + '.ui.json', status: ui.status,
        source: ui.source, moment: ui.moment, elapsedMs: ui.elapsedMs,
        rootIds: ui.trace.roots.length, mappedRoots: ui.roots.filter(root => root.status === 'ok').length,
        animations: ui.animations.length, errors: ui.errors.length, ...(ui.reason ? { reason: ui.reason } : {}) };
      if (armed) status.uiMetadata.layoutRootCoverage = 'not-collected-in-safe-projection';
    } catch {
      noteError(new Error('ui-metadata-collection-or-save-failed'));
      status.uiMetadata = { file: request.id + '.ui.json', status: 'failed' };
    }
    // Collection/document lifetime ends here; cleanup authority remains exact.
    // Neither the returned report nor its on-disk copy is changed by late ACKs.
    collecting = false;
    for (const op of operations) op.value = null;
    retire();
    status.detached = detached; status.profiles = stamps(); status.retirementState = receipt(retired);
    status.finishedWallMs = Date.now();
    if (ownerGuard) { status.currentOwner = ownerGuard.current(); status.ownerCurrent = ownerCurrent(); }
    if (manual) {
      status.profileFile = file('.profile.json');
      status.outcome = status.ownerCurrent && status.readyWallMs && status.errors.length === 0 && retired
        && status.artifacts.main?.bytes > 0 && status.artifacts.renderer?.bytes > 0 && status.artifacts.trace?.bytes > 0
        && status.traceComplete === true && status.traceDataLoss === false ? 'completed' : 'incomplete';
    }
    try { await saveJson(file('.profile.json'), status); }
    catch (err) { noteError(err); if (manual) status.outcome = 'failed-status-save'; }
    log('[Perf:IncidentProfile] id=' + request.id + ' delayMs=' + status.requestDelayMs +
      ' durationMs=' + (status.finishedWallMs - status.receivedWallMs) + ' errors=' + status.errors.length +
      ' overlap=' + (status.triggerOverlap || 'unknown') + ' traceComplete=' + Number(status.traceComplete === true) +
      ' retirement=' + status.retirementState.state + ' leaseId=' + lease.id + ' file=' + file('.profile.json'));
    requestCleanup();
  }
  return attachRetirement(status, status.retirementState, whenRetired);
}

module.exports = { captureIncidentProfile, deadline };
