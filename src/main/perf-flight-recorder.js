'use strict';

// Runs in the external watchdog, never in a UI/IPC handler. No command-line
// arguments, terminal text, DOM, network payloads or executable paths are saved.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { captureNativeSnapshot } = require('./process-metrics-source');

const DAY = 86400000;
const RETENTION_MS = 7 * DAY;
const DISK_CAP = 256 * 1024 * 1024;
const OWN_FILE = /^(?:cpu-\d{10}\.ndjson|incident-\d+-\d+(?:\.json|\.sample\.txt|\.main\.cpuprofile|\.cpuprofile|\.trace\.json|\.profile\.json|\.capture\.json|\.ui\.json))$/;
const round = (n) => Math.round(n * 10) / 10;
const monoNow = () => performance.now();

function cpuFrame(before, after, elapsedMs, appPids, tabs, mainPid) {
  const previous = new Map((before?.processes || []).map(p => [p.pid, p]));
  const current = new Map((after.processes || []).map(p => [p.pid, p]));
  const direct = new Map(appPids.map(p => [p.pid, p.type]));
  direct.set(mainPid, 'Browser');
  const tabPids = new Map(tabs.map(t => [t.pid, t.tabId]));
  const rows = [];
  for (const p of current.values()) {
    const old = previous.get(p.pid);
    if (!old || old.startedAtTicks !== p.startedAtTicks || p.cpuNs < old.cpuNs || !(elapsedMs > 0)) continue;
    let owner = direct.has(p.pid) ? 'app' : 'external';
    let tabId = null;
    const seen = new Set();
    for (let parent = p; parent && !seen.has(parent.pid); parent = current.get(parent.ppid)) {
      seen.add(parent.pid);
      if (tabPids.has(parent.pid)) { owner = 'tab'; tabId = tabPids.get(parent.pid); break; }
      if (parent.pid === mainPid) { if (owner !== 'app') owner = 'app-child'; break; }
    }
    rows.push({ pid: p.pid, ppid: p.ppid, identity: p.startedAtTicks,
      name: String(p.name || 'unknown').slice(0, 80), type: direct.get(p.pid) || null,
      owner, tabId, cpu: round((p.cpuNs - old.cpuNs) / (elapsedMs * 1e4)),
      footprintMiB: round(p.footprintBytes / 1048576) });
  }
  rows.sort((a, b) => b.cpu - a.cpu);
  return { measured: rows.length, appCpu: round(rows.filter(p => p.owner === 'app').reduce((n, p) => n + p.cpu, 0)),
    ...(after.cpuTimeNormalization ? { cpuTimeNormalization: after.cpuTimeNormalization } : {}),
    tabCpu: round(rows.filter(p => p.owner === 'tab').reduce((n, p) => n + p.cpu, 0)),
    // Keep every Electron process and the top external/tab processes. Missing
    // inaccessible/system/short-lived processes are NOT inferred to be idle.
    rows: [...rows.filter(p => p.owner === 'app').slice(0, 12), ...rows.filter(p => p.owner !== 'app').slice(0, 12)] };
}

function systemCpu(before, after) {
  if (!before || before.length !== after.length) return null;
  let idle = 0, total = 0;
  for (let i = 0; i < after.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[i].times[key] - before[i].times[key];
      if (delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? round(100 * (1 - idle / total)) : null;
}

// Preserve a WHOLE checkpoint window, not a single instantaneous value every
// 30 seconds. A short CPU burst in between checkpoints remains represented.
function summarizeFrames(frames) {
  if (!frames.length) return null;
  const systemValues = frames.map(f => f.systemBusy).filter(Number.isFinite);
  const byIdentity = new Map();
  for (const f of frames) for (const p of f.rows) {
    const key = p.pid + ':' + p.identity;
    const acc = byIdentity.get(key) || { ...p, sum: 0, ms: 0, peak: 0 };
    acc.sum += p.cpu * f.elapsedMs; acc.ms += f.elapsedMs; acc.peak = Math.max(acc.peak, p.cpu);
    byIdentity.set(key, acc);
  }
  return { from: frames[0].wallMs - frames[0].elapsedMs, to: frames.at(-1).wallMs,
    ...(frames.at(-1).cpuTimeNormalization ? { cpuTimeNormalization: frames.at(-1).cpuTimeNormalization } : {}),
    samples: frames.length, systemPeak: systemValues.length ? Math.max(...systemValues) : null,
    appPeak: Math.max(...frames.map(f => f.appCpu)), maxProbeMs: Math.max(...frames.map(f => f.probeMs)),
    maxObserverGapMs: Math.max(...frames.map(f => f.observerGapMs)),
    // Average is over observed intervals for this identity, not a fabricated
    // zero for periods when it was outside the top list or not alive.
    rows: [...byIdentity.values()].sort((a, b) => b.peak - a.peak).slice(0, 24)
      .map(({ sum, ms, peak, cpu, ...p }) => ({ ...p, observedMs: round(ms), meanCpu: round(sum / ms), peakCpu: peak })) };
}

function createArtifactStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = name => {
    if (!OWN_FILE.test(name)) throw new Error('invalid perf artifact name');
    return path.join(directory, name);
  };
  const entries = () => fs.readdirSync(directory).filter(n => OWN_FILE.test(n)).flatMap(name => {
    try {
      const stat = fs.lstatSync(file(name));
      return stat.isFile() && !stat.isSymbolicLink() ? [{ name, size: stat.size, at: stat.mtimeMs }] : [];
    } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  });
  const write = (name, data, append = false) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error('perf artifact payload too large');
    const fd = fs.openSync(file(name), (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC) |
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  };
  return { directory, file, write,
    prune(now = Date.now()) {
      const all = entries().sort((a, b) => a.at - b.at);
      let bytes = all.reduce((sum, e) => sum + e.size, 0);
      // Under disk pressure evict large profiles before the cheap historical
      // CPU evidence the user may ask for days later. Quota receipts are tiny
      // but must survive for their full day, otherwise eviction resets quota.
      const ordered = [
        ...all.filter(e => now - e.at > RETENTION_MS),
        ...all.filter(e => now - e.at <= RETENTION_MS && /\.(?:cpuprofile|sample\.txt|trace\.json)$/.test(e.name)),
        ...all.filter(e => now - e.at <= RETENTION_MS && !/\.(?:cpuprofile|sample\.txt|trace\.json)$/.test(e.name)),
      ];
      for (const e of ordered) {
        // Never prune files still being captured (or the current hour bucket).
        if (now - e.at < 120000) continue;
        if (e.name.endsWith('.capture.json') && now - e.at < DAY) continue;
        if (now - e.at <= RETENTION_MS && bytes <= DISK_CAP) continue;
        fs.unlinkSync(file(e.name)); bytes -= e.size;
      }
    },
    reserveCapture(id, now = Date.now()) {
      const recent = entries().filter(e => e.name.endsWith('.capture.json') && now - e.at < DAY);
      if (recent.length >= 4 || recent.some(e => now - e.at < 10 * 60000)) return false;
      write(id + '.capture.json', { requestedAt: now });
      return true;
    },
  };
}

function createFlightRecorder({ directory, mainPid, log, requestCapture, context, snapshot = captureNativeSnapshot }) {
  const artifacts = createArtifactStore(directory);
  artifacts.prune();
  let previous = null, previousCpus = null, previousAt = monoNow();
  const startedAt = previousAt;
  let ring = [], checkpoint = [], active = null;
  let lastCheckpoint = previousAt, lastIncident = -Infinity, lastPrune = previousAt;
  let hotSince = null, timer = null, stopped = false, consecutiveFailures = 0;
  let lastWriteErrorAt = -Infinity;
  function persist() {
    try { if (active) artifacts.write(active.id + '.json', active); }
    catch (err) {
      if (monoNow() - lastWriteErrorAt > 30000) {
        lastWriteErrorAt = monoNow(); log('[Perf:Incident] write-failed error=' + String(err.message).slice(0, 160));
      }
    }
  }
  function incident(kind, detail = {}) {
    try { return beginIncident(kind, detail); }
    catch (err) { log('[Perf:Incident] unavailable error=' + String(err.message).slice(0, 160)); return null; }
  }
  function beginIncident(kind, detail) {
    const now = monoNow();
    if (active) {
      if (active.events.length < 24) active.events.push({ kind, ...detail, observedWallMs: Date.now() });
      return null;
    }
    if (now - lastIncident < 10 * 60000) return null;
    lastIncident = now;
    const id = 'incident-' + Date.now() + '-' + process.pid;
    active = { id, version: 1, startedWallMs: Date.now(), endsMono: now + 20000,
      coverage: 'current-user-processes; CPU100=one-core; systemBusy100=all-cores',
      complete: false, frames: ring.slice(-30), events: [{ kind, ...detail, observedWallMs: Date.now() }], context: context() };
    persist(); // survive a later kill without waiting for the post-window
    const heavy = now - startedAt >= 60000 && artifacts.reserveCapture(id);
    active.capture = { requested: !!heavy, skipReason: heavy ? null : now - startedAt < 60000 ? 'startup-warmup' : 'rolling-quota-or-cooldown' };
    persist();
    log('[Perf:Incident] id=' + id + ' kind=' + kind + ' capture=' + Number(heavy) +
      ' captureSkip=' + (active.capture.skipReason || 'none') + ' file=' + artifacts.file(id + '.json'));
    if (heavy) requestCapture({ id, requestedWallMs: Date.now(), kind, ...detail });
    return heavy ? id : null;
  }
  function tick() {
    if (stopped) return;
    const start = monoNow(), elapsedMs = start - previousAt;
    let delayMs = 2000;
    try {
      const nowCpus = os.cpus();
      const now = snapshot({ includeCommandLine: false });
      if (!now.ok) throw new Error(now.reason || 'native snapshot failed');
      const ctx = context();
      if (previous && elapsedMs > 0 && elapsedMs < 10000) {
        const cpu = cpuFrame(previous, now, elapsedMs, ctx.appPids || [], ctx.tabs || [], mainPid);
        const frame = { ...cpu, wallMs: Date.now(), absMs: performance.timeOrigin + start, monoMs: start, elapsedMs: round(elapsedMs),
          systemBusy: systemCpu(previousCpus, nowCpus), cores: nowCpus.length, loadAvg: os.loadavg(),
          probeMs: round(monoNow() - start), observerGapMs: round(Math.max(0, elapsedMs - 2000)),
          inaccessible: now.skipped, contextAgeMs: ctx.contextAgeMs };
        ring.push(frame); if (ring.length > 30) ring.shift();
        checkpoint.push(frame);
        if (checkpoint.length > 60) checkpoint.shift(); // bounded even on disk-full/write failures
        if (active) { active.frames.push(frame); if (active.frames.length > 45) active.frames.shift(); persist(); }
        const hot = frame.appCpu >= 80 || (frame.systemBusy !== null && frame.systemBusy >= 90);
        hotSince = hot ? (hotSince ?? start) : null;
        if (hotSince !== null && start - hotSince >= 6000) incident('sustained-cpu', {
          pid: frame.rows.find(p => p.owner === 'app')?.pid,
          appCpu: frame.appCpu, systemBusy: frame.systemBusy });
      } else if (previous) {
        log('[Perf:CpuWindow] coverage-gap elapsedMs=' + round(elapsedMs) + ' reason=observer-delayed-or-sleep');
        hotSince = null;
      }
      previous = now; previousCpus = nowCpus; previousAt = start;
      if (active && start >= active.endsMono) {
        active.complete = true; active.completedWallMs = Date.now(); persist(); active = null;
      }
      if (start - lastCheckpoint >= 30000) {
        const summary = summarizeFrames(checkpoint);
        if (summary) {
          const bucket = 'cpu-' + new Date().toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
          artifacts.write(bucket, JSON.stringify(summary) + '\n', true);
          log('[Perf:CpuWindow] from=' + summary.from + ' to=' + summary.to + ' appPeak=' + summary.appPeak +
            ' systemPeak=' + summary.systemPeak + ' probeMaxMs=' + summary.maxProbeMs +
            (summary.cpuTimeNormalization ? ' cpuUnit=' + summary.cpuTimeNormalization.outputUnit +
              ' timebase=' + summary.cpuTimeNormalization.numer + '/' + summary.cpuTimeNormalization.denom : '') +
            ' file=' + artifacts.file(bucket));
        }
        checkpoint = []; lastCheckpoint = start;
      }
      if (start - lastPrune > 60000) { artifacts.prune(); lastPrune = start; }
      consecutiveFailures = 0;
      // Don't turn expensive native diagnostics into a new permanent load.
      if (monoNow() - start > 100) delayMs = 10000;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures === 1 || consecutiveFailures % 30 === 0) log('[Perf:CpuWindow] unavailable error=' + String(err.message).slice(0, 160));
      previous = null; previousAt = monoNow(); delayMs = 10000;
    }
    timer = setTimeout(tick, delayMs); timer.unref?.();
  }
  timer = setTimeout(tick, 2000); timer.unref?.();
  return { artifacts, incident, stop() { stopped = true; clearTimeout(timer); persist(); } };
}

module.exports = { cpuFrame, systemCpu, summarizeFrames, createArtifactStore, createFlightRecorder };
