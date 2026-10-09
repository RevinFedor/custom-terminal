'use strict';

// External watchdog helper: no heavy-capture policy, app IPC, process discovery,
// UI, or provider work here. One watchdog owns an artifact directory. The gate
// also prevents two helper instances in that watchdog from sampling together.
const fs = require('fs');
const path = require('path');
const { spawn: nativeSpawn } = require('child_process');
const { performance } = require('perf_hooks');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SAMPLE_BIN = '/usr/bin/sample';
const RECEIPT = /^stall-(\d+)-(\d+)-(\d+)\.sample-capture\.json$/;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
// Preserve the previous helper's symbolication allowance. Sampling is still
// one second; producing the full report can take longer than that interval.
const TIMEOUT_MS = 20000;
const gates = new Map();
let sequence = 0;
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
const wallTime = value => Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const errorText = error => String(error?.message || error).slice(0, 200);

function nativeCaptureDecision(recent, now, target) {
  if (recent.some(r => !wallTime(r.requestedWallMs) || r.requestedWallMs > now)) {
    return { allowed: false, reason: 'quota-clock-unknown' };
  }
  const day = recent.filter(r => now - r.requestedWallMs < DAY);
  const hour = day.filter(r => now - r.requestedWallMs < HOUR);
  const remaining = { hour: Math.max(0, 8 - hour.length), day: Math.max(0, 24 - day.length) };
  const duplicate = day.find(r => r.pid === target.pid && r.processIdentity === target.processIdentity && r.stallId === target.stallId);
  if (duplicate) return { allowed: false, reason: 'stall-already-requested', id: duplicate.id, remaining };
  const expiry = (rows, limit, span) => rows.map(r => r.requestedWallMs).sort((a, b) => a - b)[rows.length - limit] + span;
  if (day.length >= 24 || hour.length >= 8) {
    return { allowed: false, reason: day.length >= 24 ? 'native-day-quota-exhausted' : 'native-hour-quota-exhausted', remaining,
      nextEligibleWallMs: Math.max(day.length >= 24 ? expiry(day, 24, DAY) : 0, hour.length >= 8 ? expiry(hour, 8, HOUR) : 0) };
  }
  // Initial 500ms alarms often resume before sampling begins. Keep two hourly
  // and six daily slots for an observed, still-running >=1s stall. Total caps
  // remain8/hour and24/day; the watchdog retries this SAME stall on its tick.
  const critical = Number(target.stalledMs) >= 1000;
  const initialHour = hour.filter(r => r.admissionClass !== 'critical');
  const initialDay = day.filter(r => r.admissionClass !== 'critical');
  if (!critical && (initialHour.length >= 6 || initialDay.length >= 18)) {
    return { allowed: false, reason: 'native-reserved-for-critical-stall', remaining, retryAtStalledMs: 1000,
      nextEligibleWallMs: Math.max(initialHour.length >= 6 ? expiry(initialHour, 6, HOUR) : 0,
        initialDay.length >= 18 ? expiry(initialDay, 18, DAY) : 0) };
  }
  const own = day.filter(r => r.pid === target.pid && r.processIdentity === target.processIdentity);
  const last = own.length ? Math.max(...own.map(r => r.requestedWallMs)) : -Infinity;
  if (now - last < 30000) return { allowed: false, reason: 'native-process-cooldown', remaining, nextEligibleWallMs: last + 30000 };
  return { allowed: true, reason: 'reserved', admissionClass: critical ? 'critical' : 'initial',
    remaining: { hour: remaining.hour - 1, day: remaining.day - 1 } };
}

// Parse only timezone-qualified header dates. A report's Date/Time, sample
// count, requested duration and spawn/exit times do NOT supply an actual end.
function parseNativeSampleHeader(text) {
  const header = String(text).slice(0, HEADER_BYTES).split(/^Call graph:/m)[0];
  const date = label => {
    const rows = [...header.matchAll(new RegExp('^' + label + ':\\s*([^\\r\\n]+)', 'gmi'))];
    if (rows.length !== 1) return null;
    const value = rows[0][1].trim();
    const parts = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?\s*(?:Z|[+-](\d\d):?(\d\d))$/.exec(value);
    if (!parts || +parts[2] < 1 || +parts[2] > 12 || +parts[3] < 1 ||
      +parts[3] > new Date(Date.UTC(+parts[1], +parts[2], 0)).getUTCDate() ||
      +parts[4] > 23 || +parts[5] > 59 || +parts[6] > 59 || +(parts[7] || 0) > 23 || +(parts[8] || 0) > 59) return null;
    const ms = Date.parse(value.replace(' ', 'T').replace(/\s+(?=Z|[+-]\d\d:?\d\d$)/, ''));
    return wallTime(ms) ? ms : null;
  };
  const start = date('(?:Sample start time|Start time)');
  const end = date('(?:Sample end time|End time)');
  const pids = [...header.matchAll(/^Process:\s*[^\r\n]*\[(\d+)\]\s*$/gm)];
  const pid = pids.length === 1 ? Number(pids[0][1]) : null;
  const actual = start !== null && end !== null && end > start;
  return { pid, reportedWallMs: date('Date/Time'), actualStartWallMs: actual ? start : null,
    actualEndWallMs: actual ? end : null, source: actual ? 'native-header-explicit-bounds' : null,
    reason: actual ? null : 'native-actual-bounds-unavailable' };
}

function sampleOverlap(record) {
  const capture = record.capture;
  const basis = 'native-header-vs-heartbeat-silence-window';
  if (!capture?.source) {
    // macOS sample v7 supplies Date/Time but no actual end timestamp. Do not
    // invent end=Date/Time+1s. A complete verified report was necessarily
    // sampled inside its child-lifecycle envelope; a phase marker can narrow
    // the upper bound before potentially expensive symbolication finishes.
    const from = record.spawnRequestedWallMs;
    const to = record.samplingCompletedObservedWallMs ?? record.childClosedWallMs;
    if (record.status === 'complete' && record.output?.hasCallGraph && capture?.reason === 'native-actual-bounds-unavailable' && capture?.pid === record.stall.pid &&
      wallTime(from) && wallTime(to) && to >= from && record.resumeObservedWallMs !== null) {
      if (from >= record.stall.startedWallMs && to <= record.resumeObservedWallMs) return {
        status: 'overlap', overlapMs: null, actualBoundsKnown: false,
        basis: 'verified-native-capture-envelope-contained-in-heartbeat-silence',
        envelopeStartWallMs: from, envelopeEndWallMs: to,
      };
      if (from >= record.resumeObservedWallMs) return { status: 'no-overlap', overlapMs: 0,
        actualBoundsKnown: false, basis: 'native-child-started-after-resume' };
    }
    return { status: 'unknown', reason: capture?.reason || 'native-actual-bounds-unavailable', basis };
  }
  const start = record.stall.startedWallMs;
  const end = record.resumeObservedWallMs ?? record.stall.observedWallMs;
  const ms = Math.max(0, Math.min(capture.actualEndWallMs, end) - Math.max(capture.actualStartWallMs, start));
  if (ms > 0) return { status: 'overlap', overlapMs: ms, lowerBound: record.resumeObservedWallMs === null, basis };
  if (capture.actualEndWallMs <= start || record.resumeObservedWallMs !== null) {
    return { status: 'no-overlap', overlapMs: 0, basis };
  }
  return { status: 'unknown', reason: 'resume-not-observed', basis };
}

/**
 * request({stallId, pid, processIdentity, kind:'main'|'renderer', state:'stalled',
 *   stalledMs, stallStartedWallMs, observedWallMs, focused?, thresholdMs?})
 * returns {allowed, reason, id?, done?}. done always resolves, never rejects.
 * processIdentity is an exact process generation/start token, NOT a bare PID.
 * verifyTarget(meta) must synchronously recheck current ownership + identity and
 * return {state:'found', pid, processIdentity}; absent/unknown/errors cannot run.
 * Renderer threshold is supplied by watchdog, and only focused renderers qualify.
 * resumed({stallId,pid,processIdentity,resumedWallMs?}) records the observed
 * heartbeat return, including after capture has ended. No resume is fabricated.
 * stop() kills only the ChildProcess this helper spawned. A missing close keeps
 * the gate closed (unknown child state), even after the bounded done resolves.
 * Injectable clocks/timers/spawn exist for unit tests, not alternative binaries.
 */
function createNativeStallSampler({ artifacts, verifyTarget, log = () => {}, env,
  platform = process.platform, spawn = nativeSpawn, sampleAvailable = () => fs.existsSync(SAMPLE_BIN),
  now = Date.now, monoNow = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  const directoryKey = artifacts?.directory ? path.resolve(artifacts.directory) : null;
  const records = new Map();
  let stopped = false, active = null;
  const validBounds = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS &&
    Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= MAX_OUTPUT_BYTES;
  function emit(event, detail) {
    try { log('[Perf:NativeStall] ' + JSON.stringify({ event, ...detail })); } catch { /* diagnostics cannot crash the app */ }
  }
  function skip(reason, detail = {}) {
    const result = { allowed: false, reason, ...detail };
    emit('decision', result);
    return result;
  }
  function save(run) {
    run.record.overlap = sampleOverlap(run.record);
    try { artifacts.write(run.record.id + '.sample.json', run.record); return true; }
    catch (error) { emit('write-failed', { id: run.record.id, error: errorText(error) }); return false; }
  }
  function release(run) {
    if (active === run) active = null;
    if (gates.get(directoryKey) === run) gates.delete(directoryKey);
  }
  function closeOutput(run) {
    if (run.fd === null) return;
    const fd = run.fd; run.fd = null;
    try { fs.closeSync(fd); } catch (error) { emit('close-failed', { id: run.record.id, error: errorText(error) }); }
  }
  function finish(run, reason, childClosed = false) {
    if (childClosed) {
      run.record.childClosedWallMs = now();
      run.record.childState = 'closed';
      release(run);
    }
    if (run.finished) { save(run); return; }
    run.finished = true;
    clearTimer(run.timer);
    closeOutput(run);
    const record = run.record;
    record.finishedWallMs = now(); record.finishedMonoMs = monoNow();
    reason = run.failureReason || reason;
    record.status = reason ? 'failed' : 'complete'; record.reason = reason;
    record.output.complete = !reason;
    record.capture = parseNativeSampleHeader(run.header.toString('utf8'));
    if (record.capture.pid !== record.stall.pid) {
      record.capture = { ...record.capture, source: null, actualStartWallMs: null, actualEndWallMs: null, reason: 'sample-target-unproven' };
      if (!reason) { record.status = 'failed'; record.reason = 'invalid-sample-report'; record.output.complete = false; }
    } else if (record.capture.source && (record.capture.actualStartWallMs < record.spawnRequestedWallMs ||
      record.capture.actualEndWallMs > record.finishedWallMs ||
      Math.abs((record.finishedWallMs - record.requestedWallMs) - (record.finishedMonoMs - record.requestedMonoMs)) > 1000)) {
      record.capture = { ...record.capture, source: null, actualStartWallMs: null, actualEndWallMs: null, reason: 'native-bounds-outside-lifecycle-or-clock-change' };
    }
    // This is a hint only. The full, unmodified report (including binary images,
    // addresses and UUIDs) is the symbolication artifact; failures mark partials.
    const hint = run.tail.toString('utf8').split(/^Sort by top of stack[^\n]*\n/m)[1];
    record.topStackHint = hint ? hint.trim().split(/\r?\n/).slice(0, 4).map(s => s.trim().slice(0, 180)).join(' || ') : null;
    run.header = Buffer.alloc(0); run.tail = Buffer.alloc(0);
    save(run);
    emit('finish', { id: record.id, status: record.status, reason: record.reason, childState: record.childState,
      bytes: record.output.bytes, overlap: record.overlap });
    run.resolve(record);
  }
  function abort(run, reason) {
    if (run.finished) return;
    run.failureReason = reason;
    run.record.termination = { reason, requestedWallMs: now(), signal: 'SIGKILL', sent: false };
    if (run.child) {
      try { run.record.termination.sent = run.child.kill('SIGKILL'); }
      catch (error) { run.record.termination.error = errorText(error); }
    }
    // Do not declare a process absent because a kill was requested or a timer
    // elapsed. Release only on close, or when spawn itself failed synchronously.
    finish(run, reason, !run.child);
  }
  function checkTarget(meta) {
    let proof;
    try { proof = verifyTarget?.(meta); } catch (error) { return { reason: 'target-state-unknown', error: errorText(error) }; }
    if (proof?.then) {
      // An accidental async verifier grants no admission, and its rejection
      // must not become an unhandled exception in the diagnostic observer.
      Promise.resolve(proof).catch(() => {});
      return { reason: 'target-state-unknown' };
    }
    if (proof?.state === 'absent') return { reason: 'target-absent' };
    if (proof?.state !== 'found') return { reason: 'target-state-unknown' };
    if (proof.pid !== meta.pid || proof.processIdentity !== meta.processIdentity) return { reason: 'target-identity-changed' };
    return null;
  }
  function recentReceipts(at) {
    const entries = artifacts.entries().filter(e => RECEIPT.test(e.name));
    const recent = [];
    for (const entry of entries) {
      const match = RECEIPT.exec(entry.name), requestedWallMs = Number(match[1]);
      if (at - Math.max(entry.at, requestedWallMs) >= DAY) continue;
      const value = JSON.parse(artifacts.read(entry.name, 16384));
      if (value.version !== 1 || value.requestedWallMs !== requestedWallMs || value.pid !== Number(match[2]) ||
        value.id + '.sample-capture.json' !== entry.name || !textId(value.processIdentity) || !textId(value.stallId)) {
        throw new Error('invalid native quota receipt');
      }
      recent.push(value);
    }
    return recent;
  }
  function request(meta = {}) {
    let run = null;
    try {
      if (stopped) return skip('sampler-stopped');
      if (platform !== 'darwin') return skip('unsupported-platform');
      if (!validBounds || !directoryKey) return skip('sampler-configuration-invalid');
      if (gates.has(directoryKey)) return skip('sample-in-flight', { activeId: gates.get(directoryKey).record.id });
      if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0 || !textId(meta.processIdentity)) return skip('invalid-target');
      if (!textId(meta.stallId)) return skip('invalid-stall-identity');
      if (meta.state !== 'stalled') return skip('stall-state-unknown');
      if (!['main', 'renderer'].includes(meta.kind)) return skip('unsupported-target-kind');
      if (meta.kind === 'renderer' && meta.focused !== true) return skip('renderer-not-focused');
      const threshold = meta.kind === 'main' ? 500 : meta.thresholdMs;
      if (!Number.isFinite(threshold) || threshold <= 0) return skip('stall-threshold-unknown');
      if (!Number.isFinite(meta.stalledMs) || meta.stalledMs < threshold) return skip('stall-below-threshold');
      const at = now();
      if (!Number.isSafeInteger(at) || !wallTime(at) || !wallTime(meta.observedWallMs) || !wallTime(meta.stallStartedWallMs) ||
        meta.stallStartedWallMs > meta.observedWallMs || meta.observedWallMs > at || at - meta.observedWallMs > 1000 ||
        Math.abs(meta.observedWallMs - meta.stallStartedWallMs - meta.stalledMs) > 2) return skip('stall-observation-stale-or-invalid');
      if (!sampleAvailable()) return skip('sample-binary-unavailable');
      const invalidTarget = checkTarget(meta);
      if (invalidTarget) return skip(invalidTarget.reason, invalidTarget);
      try { artifacts.prune(at); } catch (error) { return skip('artifact-prune-failed', { error: errorText(error) }); }
      let recent;
      try { recent = recentReceipts(at); } catch (error) { return skip('quota-state-unknown', { error: errorText(error) }); }
      const decision = nativeCaptureDecision(recent, at, meta);
      if (!decision.allowed) return skip(decision.reason, decision);
      const id = 'stall-' + at + '-' + meta.pid + '-' + (++sequence);
      const record = { version: 1, id, requestedWallMs: at, requestedMonoMs: monoNow(),
        stall: { id: meta.stallId, pid: meta.pid, processIdentity: meta.processIdentity, kind: meta.kind,
          startedWallMs: meta.stallStartedWallMs, observedWallMs: meta.observedWallMs, stalledMs: meta.stalledMs,
          thresholdMs: threshold, focused: meta.kind === 'renderer' ? true : null },
        spawnRequestedWallMs: null, spawnedWallMs: null, spawnedMonoMs: null, finishedWallMs: null,
        samplingCompletedObservedWallMs: null,
        requestedDurationMs: 1000, requestedIntervalMs: 1, targetVerifiedWallMs: null,
        childPid: null, childState: 'not-spawned', childClosedWallMs: null,
        resumeObservedWallMs: null, resumeReceivedWallMs: null,
        capture: { source: null, actualStartWallMs: null, actualEndWallMs: null, reason: 'native-actual-bounds-unavailable' },
        output: { file: id + '.sample.txt', bytes: 0, maxBytes: maxOutputBytes, complete: false, hasCallGraph: false },
        status: 'reserved', reason: null };
      let resolve;
      const done = new Promise(r => { resolve = r; });
      run = { record, resolve, done, child: null, fd: null, timer: null, finished: false, header: Buffer.alloc(0), tail: Buffer.alloc(0) };
      active = run; gates.set(directoryKey, run);
      // Immutable own receipt is fsynced before spawn. A failed/partial receipt
      // is never removed to refund quota; an unreadable one makes quota unknown.
      try { artifacts.writeExclusive(id + '.sample-capture.json', { version: 1, id, requestedWallMs: at,
        pid: meta.pid, processIdentity: meta.processIdentity, stallId: meta.stallId, admissionClass: decision.admissionClass }); }
      catch (error) {
        record.error = errorText(error); finish(run, 'receipt-write-failed', true);
        return skip('receipt-write-failed', { id });
      }
      for (const [key, old] of records) if (at - old.record.requestedWallMs >= DAY) records.delete(key);
      records.set(id, run);
      while (records.size > 32) records.delete(records.keys().next().value);
      if (!save(run)) { finish(run, 'metadata-write-failed', true); return skip('metadata-write-failed', { id }); }
      run.fd = artifacts.openExclusive(record.output.file);
      record.spawnRequestedWallMs = now(); record.spawnRequestedMonoMs = monoNow();
      if (!save(run)) { finish(run, 'metadata-write-failed', true); return skip('metadata-write-failed', { id }); }
      // Receipt fsync/disk work may have delayed us. Recheck the exact process
      // at the spawn boundary; a PID or stall observation can already be stale.
      const changedTarget = checkTarget(meta);
      if (changedTarget) {
        record.error = changedTarget.error || null; finish(run, changedTarget.reason, true);
        return skip(changedTarget.reason, { id });
      }
      record.targetVerifiedWallMs = now();
      if (now() - meta.observedWallMs > 1000 || now() < meta.observedWallMs) {
        finish(run, 'stall-observation-stale-or-invalid', true);
        return skip('stall-observation-stale-or-invalid', { id });
      }
      // Pipe the explicit report destination so its full bytes have a hard cap.
      // Letting sample write an arbitrary disk path cannot enforce that cap.
      run.child = spawn(SAMPLE_BIN, [String(meta.pid), '1', '1', '-file', '/dev/stdout'], {
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...(env ? { env } : {}),
      });
      record.childState = 'pending'; record.childPid = run.child.pid || null;
      run.child.once('spawn', () => {
        if (run.finished || record.spawnedWallMs !== null) return;
        record.spawnedWallMs = now(); record.spawnedMonoMs = monoNow();
        record.childPid = run.child.pid; record.childState = 'running'; record.status = 'sampling';
        save(run); emit('spawn', { id, pid: record.stall.pid, childPid: record.childPid });
      });
      run.child.stdout.on('data', chunk => {
        if (run.finished) return;
        try {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const keep = data.subarray(0, Math.max(0, maxOutputBytes - record.output.bytes));
          if (keep.length) {
            fs.writeFileSync(run.fd, keep); record.output.bytes += keep.length;
            if (run.header.length < HEADER_BYTES) run.header = Buffer.concat([run.header, keep.subarray(0, HEADER_BYTES - run.header.length)]);
            record.output.hasCallGraph ||= /(?:^|\n)Call graph:/.test(run.header.toString('utf8'));
            if (record.samplingCompletedObservedWallMs === null && /(?:^|\n)Sampling completed, processing symbols/.test(run.header.toString('utf8'))) {
              record.samplingCompletedObservedWallMs = now();
            }
            run.tail = Buffer.concat([run.tail, keep.subarray(-HEADER_BYTES)]).subarray(-HEADER_BYTES);
          }
          if (keep.length !== data.length) abort(run, 'sample-output-limit');
        } catch (error) { record.error = errorText(error); abort(run, 'sample-output-write-failed'); }
      });
      // Consume stderr without retaining an unbounded diagnostic stream.
      let stderrBytes = 0;
      run.child.stderr.on('data', chunk => {
        if (run.finished) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.length;
        if ((record.stderrHint || '').length < 512) record.stderrHint = (record.stderrHint || '') + bytes.toString('utf8', 0, 512).slice(0, 512 - (record.stderrHint || '').length);
        if (record.samplingCompletedObservedWallMs === null && /(?:^|\n)Sampling completed, processing symbols/.test(record.stderrHint || '')) {
          record.samplingCompletedObservedWallMs = now();
        }
        if (stderrBytes > HEADER_BYTES) abort(run, 'sample-stderr-limit');
      });
      for (const stream of [run.child.stdout, run.child.stderr]) stream.on('error', error => {
        record.error = errorText(error); abort(run, 'sample-stream-error');
      });
      run.child.once('error', error => {
        record.error = errorText(error);
        if (!run.child.pid) finish(run, 'sample-spawn-failed', true);
        else abort(run, 'sample-child-error');
      });
      run.child.once('close', (code, signal) => {
        record.exitCode = code; record.exitSignal = signal;
        finish(run, code === 0 && !signal ? (record.output.bytes ? null : 'sample-output-empty') : 'sample-exit-failed', true);
      });
      run.timer = setTimer(() => abort(run, 'sample-timeout'), timeoutMs);
      run.timer.unref?.();
      emit('decision', { ...decision, id, pid: meta.pid });
      return { ...decision, id, done };
    } catch (error) {
      if (run) { run.record.error = errorText(error); abort(run, 'sample-start-failed'); }
      return skip('sample-start-failed', { error: errorText(error), ...(run ? { id: run.record.id } : {}) });
    }
  }
  function resumed(meta = {}) {
    try {
      const run = [...records.values()].find(r => r.record.stall.id === meta.stallId && r.record.stall.pid === meta.pid &&
        r.record.stall.processIdentity === meta.processIdentity);
      if (!run) return { recorded: false, reason: 'stall-identity-not-found' };
      const at = meta.resumedWallMs ?? now();
      if (!wallTime(at) || at < run.record.stall.observedWallMs || at > now()) return { recorded: false, reason: 'resume-time-invalid' };
      if (run.record.resumeObservedWallMs !== null) return { recorded: false, reason: 'resume-already-recorded' };
      run.record.resumeObservedWallMs = at; run.record.resumeReceivedWallMs = now();
      const saved = save(run);
      emit('resume', { id: run.record.id, at, overlap: run.record.overlap });
      return { recorded: saved, id: run.record.id, overlap: run.record.overlap };
    } catch (error) { emit('resume-failed', { error: errorText(error) }); return { recorded: false, reason: 'resume-write-failed' }; }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (!active) return;
    if (!active.finished) { abort(active, 'sampler-shutdown'); return; }
    // A timeout/error may have failed to kill. Shutdown still tries to clean up
    // our own unresolved child; it never signals a bare PID or another owner.
    if (active.child && active.record.childState !== 'closed') {
      const run = active;
      run.record.shutdownKill = { requestedWallMs: now(), sent: false };
      try { run.record.shutdownKill.sent = run.child.kill('SIGKILL'); }
      catch (error) { run.record.shutdownKill.error = errorText(error); }
      save(run);
    }
  }
  return { request, resumed, stop };
}

module.exports = { createNativeStallSampler, nativeCaptureDecision, parseNativeSampleHeader, sampleOverlap };
