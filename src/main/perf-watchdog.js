// perf-watchdog.js — external freeze watchdog (runs OUTSIDE the Electron event loop).
//
// Why a separate OS process: every in-process probe ([Perf:MainLoopGap],
// renderer EventTiming/LongTask) is itself frozen during the freeze it is
// supposed to attribute — that is why gap logs ship `activeOps=0`. This child
// is fork()ed plain node with its own event loop, so heartbeat silence is
// observable in real time, and the live stack can be captured DURING the
// stall via macOS `sample <pid>` — the one signal in-process probes
// structurally cannot produce.
//
// Inputs (argv): [2] main pid, [3] log path (same dev.log/production.log the
// main console interceptor writes), [4] unix socket path for renderer
// heartbeats.
//
// Channels:
//   main     → fork IPC channel: {t:'hb', proc:'main', sentAbs, ops} every
//              250ms; {t:'bye'} on before-quit (lame duck, no false alarms).
//   renderer → unix socket NDJSON: {t:'hb', proc:'renderer', pid, abs, vis}.
//              Direct connection on purpose — routing via main would fake
//              renderer stalls whenever main itself is frozen.
//
// Output: [Watchdog] STALL / SAMPLING / SAMPLE-DONE / RESUMED lines appended
// to the shared log file. Field 1 stays HH:MM:SS.mmm (UTC) so the existing
// awk/grep workflows over dev.log keep working.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { performance } = require('perf_hooks');
const { buildChildProcessEnv } = require('./child-process-env');
const { createFlightRecorder } = require('./perf-flight-recorder');
const { createCausalJournal } = require('./perf-causal-journal');
const { createNativeStallSampler } = require('./perf-stall-sampler');
const { captureNativeSnapshot } = require('./process-metrics-source');

const MAIN_PID = parseInt(process.argv[2], 10) || 0;
const LOG_PATH = process.argv[3] || '';
const SOCKET_PATH = process.argv[4] || '';

const CHECK_INTERVAL_MS = 100;
// Renderer thresholds are looser: hidden/occluded windows get timer throttling
// (background throttling clamps setInterval to >=1s) — the vis flag in each
// heartbeat gates detection to visible windows only, thresholds add margin.
const THRESHOLDS = {
  main: { stallMs: 500 },
  renderer: { stallMs: 1500 },
};

const bootAt = Date.now();
const bootId = 'wd-' + bootAt.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
let logSeq = 0;

function wdLog(msg) {
  const iso = new Date().toISOString();
  const line = iso.slice(11, 23) +
    ' date=' + iso.slice(0, 10) +
    ' seq=' + (++logSeq) +
    ' boot=' + bootId +
    ' wdAbs=' + Date.now().toFixed(1) +
    ' ' + msg + '\n';
  try { if (LOG_PATH) fs.appendFileSync(LOG_PATH, line); } catch { /* log file gone — nothing useful to do */ }
}

function freezeSeverity(ms) {
  if (ms >= 2000) return 'critical';
  if (ms >= 1000) return 'major';
  if (ms >= 500) return 'noticeable';
  return 'minor';
}

let lameDuck = false;
let mainContext = { appPids: [], tabs: [] };
let mainContextAt = 0;
let flight = null;
let stallSampler = null;
let stallSequence = 0;
let causalJournal = null;
let lastCausalHealthAt = 0;
const causalSourceSequences = new Map();
function nextCausalSourceSeq(pid) {
  const next = (causalSourceSequences.get(pid) || 0) + 1;
  causalSourceSequences.set(pid, next);
  return next;
}
const watchdogAbs = () => performance.timeOrigin + performance.now();

// procKey → heartbeat, visibility and connection ownership (not lifecycle state).
const procs = new Map();
function readProcessIdentity(pid) {
  try {
    const result = captureNativeSnapshot({ includeCommandLine: false });
    if (!result.ok) return null;
    const found = result.processes.find(row => row.pid === pid);
    return found ? pid + ':' + found.startedAtTicks : null;
  } catch { return null; }
}

function ensureProc(key, pid, label) {
  let p = procs.get(key);
  if (!p) {
    p = { pid, label, lastHbAt: 0, lastOps: '', vis: 'visible', stalled: false,
      processIdentity: readProcessIdentity(pid) };
    procs.set(key, p);
    wdLog('[Watchdog] tracking proc=' + label + ' pid=' + pid);
  }
  return p;
}

function onHeartbeat(key, pid, label, payload) {
  const p = ensureProc(key, pid, label);
  const now = performance.now();
  if (p.stalled) {
    stallSampler?.resumed({ stallId: p.stallId, pid: p.pid, processIdentity: p.processIdentity,
      resumedWallMs: Date.now() });
    p.stalled = false;
    p.nativeSampleDeferred = false;
    const silentMs = now - p.lastHbAt;
    causalJournal?.record({ sourceBoot: bootId, sourceSeq: nextCausalSourceSeq(pid), emittedAbs: watchdogAbs(),
      kind: 'resume', startAbs: p.stallStartedAbs, durationMs: silentMs,
      reason: label + '-heartbeat-resumed' }, { pid, kind: label }, { critical: true });
    wdLog(
      '[Watchdog] RESUMED proc=' + label +
      ' pid=' + pid +
      ' silentMs=' + silentMs +
      (payload && payload.sentAbs ? ' senderAbs=' + payload.sentAbs : '')
    );
    wdLog(
      '[Perf:FreezeSummary] layer=watchdog' +
      ' event=resumed' +
      ' kind=heartbeatSilence' +
      ' severity=' + freezeSeverity(silentMs) +
      ' proc=' + label +
      ' pid=' + pid +
      ' silentMs=' + silentMs +
      (payload && payload.sentAbs ? ' senderAbs=' + payload.sentAbs : '')
    );
  }
  p.lastHbAt = now;
  if (payload) {
    if (typeof payload.vis === 'string') p.vis = payload.vis;
    if (typeof payload.focused === 'boolean') p.focused = payload.focused;
    if (typeof payload.ops === 'string') p.lastOps = payload.ops.slice(0, 600);
    if (typeof payload.context === 'string') p.context = payload.context.slice(0, 800);
    if (payload.causal && label === 'main') {
      p.causal = payload.causal;
      causalJournal?.reconcile(payload.causal, { pid, kind: label });
    }
    if (payload.diagnosticHealth && typeof payload.diagnosticHealth === 'object') p.diagnosticHealth = payload.diagnosticHealth;
  }
}


try {
  if (LOG_PATH) flight = createFlightRecorder({
    directory: path.join(path.dirname(LOG_PATH), 'perf-incidents'), mainPid: MAIN_PID, log: wdLog,
    context: () => ({ ...mainContext, contextAgeMs: mainContextAt ? Math.round(performance.now() - mainContextAt) : null,
      causal: causalJournal?.snapshot() || null,
      observers: [...procs.values()].map(p => ({ pid: p.pid, label: p.label, focused: p.focused,
        vis: p.vis, context: p.context, lastOps: p.lastOps, causal: p.causal,
        diagnosticHealth: p.diagnosticHealth, heartbeatAgeMs: Math.round(performance.now() - p.lastHbAt) })) }),
    requestCapture: (request) => {
      // Main may be blocked: request/actual-start timestamps expose that gap.
      try { process.send?.({ t: 'capture', ...request }); } catch {}
      // Live native stacks have their own bounded admission at the stall edge.
      // Heavy quota affects only the CPU/trace request sent to Main above.
    },
  });
  let causalAckPending = 0;
  if (flight) causalJournal = createCausalJournal({ artifacts: flight.artifacts, now: watchdogAbs, log: wdLog,
    onPersisted: ack => {
      if (!process.connected || causalAckPending >= 8) return false;
      causalAckPending++;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; causalAckPending--; } };
      try { process.send({ t: 'causal-ack', ...ack }, finish); return true; }
      catch { finish(); return false; }
    },
  });
  if (flight) stallSampler = createNativeStallSampler({ artifacts: flight.artifacts, log: wdLog,
    env: buildChildProcessEnv(), verifyTarget: metadata => {
      const current = [...procs.values()].find(p => p.pid === metadata.pid && p.label === metadata.kind);
      if (!current || !current.stalled || current.stallId !== metadata.stallId ||
        (current.label === 'renderer' && (current.vis !== 'visible' || current.focused !== true))) return { state: 'unknown' };
      const identity = readProcessIdentity(current.pid);
      if (!identity) return { state: 'unknown' };
      return { state: 'found', pid: current.pid, processIdentity: identity };
    },
  });
} catch (err) { wdLog('[Perf:Incident] disabled error=' + String(err.message).slice(0, 160)); }

let lastCheckAt = performance.now();
function requestNativeStallSample(p, silentMs, stallMs) {
  const observedWallMs = Date.now();
  const decision = stallSampler?.request({ stallId: p.stallId, pid: p.pid, processIdentity: p.processIdentity,
    kind: p.label, state: 'stalled', stalledMs: silentMs,
    stallStartedWallMs: observedWallMs - silentMs, observedWallMs,
    focused: p.focused, thresholdMs: stallMs });
  p.nativeSampleDeferred = decision?.reason === 'native-reserved-for-critical-stall';
}

setInterval(() => {
  if (lameDuck) return;
  const now = performance.now();
  const observerGap = now - lastCheckAt;
  lastCheckAt = now;
  causalJournal?.flush();
  if (causalJournal && now - lastCausalHealthAt >= 30000) {
    lastCausalHealthAt = now;
    const { counts, limits, queued, flushLagMs } = causalJournal.snapshot();
    wdLog('[Perf:CausalHealth] ' + JSON.stringify({ counts, limits, queued, flushLagMs }));
  }
  // If the observer itself was descheduled/asleep, silence cannot prove that
  // every observed process froze independently. Re-arm on fresh heartbeats.
  if (observerGap > 2000) {
    wdLog('[Watchdog] observer-gap ms=' + observerGap.toFixed(1) + ' coverage=unknown');
    for (const p of procs.values()) { p.lastHbAt = 0; p.stalled = false; p.nativeSampleDeferred = false; }
    return;
  }
  for (const p of procs.values()) {
    if (!p.lastHbAt) continue;
    const thr = THRESHOLDS[p.label] || THRESHOLDS.renderer;
    if (p.label === 'renderer' && p.vis !== 'visible') {
      // Hidden window: heartbeat interval is legitimately throttled — silence
      // here is not a freeze. Reset without a RESUMED log to avoid noise.
      p.stalled = false;
      p.nativeSampleDeferred = false;
      continue;
    }
    const silentMs = now - p.lastHbAt;
    const stallMs = p.label === 'renderer' && p.focused ? 750 : thr.stallMs;
    if (!p.stalled && silentMs > stallMs) {
      p.stalled = true;
      p.stallId = bootId + ':' + (++stallSequence);
      p.stallStartedAbs = watchdogAbs() - silentMs;
      causalJournal?.record({ sourceBoot: bootId, sourceSeq: nextCausalSourceSeq(p.pid), emittedAbs: watchdogAbs(),
        kind: 'stall', startAbs: p.stallStartedAbs, durationMs: silentMs,
        reason: p.label + '-heartbeat-silence' }, { pid: p.pid, kind: p.label }, { critical: true });
      causalJournal?.flush(true);
      wdLog(
        '[Watchdog] STALL proc=' + p.label +
        ' pid=' + p.pid +
        ' silentMs=' + silentMs +
        ' lastActiveOps=' + (p.lastOps || 'none')
      );
      wdLog(
        '[Perf:FreezeSummary] layer=watchdog' +
        ' event=stall' +
        ' kind=heartbeatSilence' +
        ' severity=' + freezeSeverity(silentMs) +
        ' proc=' + p.label +
        ' pid=' + p.pid +
        ' silentMs=' + silentMs +
        ' lastActiveOps=' + (p.lastOps || 'none')
      );
      flight?.incident('heartbeat-silence', { pid: p.pid, proc: p.label, durationMs: silentMs });
      requestNativeStallSample(p, silentMs, stallMs);
    } else if (p.stalled && p.nativeSampleDeferred && silentMs >= 1000) {
      // Existing observer tick and same process/stall identity; no timer,
      // quota reset, extra incident or sample after a fresh heartbeat.
      requestNativeStallSample(p, silentMs, stallMs);
    }
  }
}, CHECK_INTERVAL_MS);

// ── main heartbeat channel ──────────────────────────────────────────────────
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'causal') {
    // Frequent minor-GC records must not consume the evidence allowance for a
    // real Main freeze. Use the existing bounded critical lane, not more IO.
    const critical = m.record?.kind === 'main-gap' && Number.isFinite(m.record.durationMs)
      && m.record.durationMs >= 500;
    causalJournal?.record(m.record, { pid: MAIN_PID, kind: 'main' }, { critical });
    return;
  }
  if (m.t === 'bye') {
    lameDuck = true;
    wdLog('[Watchdog] bye received — lame duck (no alarms during shutdown)');
    return;
  }
  if (m.t === 'hb' && m.proc === 'main') {
    if (m.context && Array.isArray(m.context.appPids) && Array.isArray(m.context.tabs)) {
      mainContext = { appPids: m.context.appPids.slice(0, 64), tabs: m.context.tabs.slice(0, 1024) };
      mainContextAt = performance.now();
    }
    const first = !procs.has('main');
    onHeartbeat('main', MAIN_PID, 'main', m);
    if (first) {
      try { process.send?.({ t: 'watchdog-observed', proc: 'main', pid: MAIN_PID, schema: 2 }); } catch {}
    }
  }
});
// Main and the standalone diagnostic fixture both fork us with IPC ownership.
// Heartbeat silence is the stall being observed, however long it lasts; only
// channel closure proves that this owner is gone. Shutdown signals also retain
// their explicit cleanup path below.
process.on('disconnect', () => {
  wdLog('[Watchdog] main channel closed — exit');
  cleanupAndExit(0);
});
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));

function cleanupAndExit(code) {
  try { stallSampler?.stop(); } catch {}
  try { causalJournal?.flush(true); } catch {}
  try { flight?.stop(); } catch {}
  try { if (SOCKET_PATH) fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(code);
}

// ── renderer heartbeat socket (direct, bypasses main) ───────────────────────
if (SOCKET_PATH) {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  const server = net.createServer((sock) => {
    let buf = '';
    let key = null;
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 65536) { sock.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m || m.proc !== 'renderer' || !Number.isInteger(m.pid) || m.pid <= 0) continue;
        // Heartbeats and incidents share the renderer sequence. Observe both,
        // including filtered incidents, without persisting every heartbeat.
        if (m.t === 'hb' || m.t === 'incident') causalJournal?.observeSequence(m, { pid: m.pid, kind: 'renderer' });
        if (m.t === 'incident') {
          const owner = procs.get('renderer-' + m.pid);
          const kind = String(m.kind || '').slice(0, 64);
          if (owner?.vis === 'visible' && Number.isFinite(m.durationMs) && m.durationMs >= (kind.startsWith('ui-') ? 120 : 250)) {
            causalJournal?.record({ ...m, kind: 'ui-action', event: kind,
              emittedAbs: Number.isFinite(m.emittedAbs) ? m.emittedAbs : watchdogAbs(),
              sourceBoot: m.sourceBoot || 'legacy-renderer-' + m.pid }, { pid: m.pid, kind: 'renderer' });
            flight?.incident(kind, { pid: m.pid, startAbs: m.startAbs, durationMs: m.durationMs,
              actionId: /^ui-[a-z0-9-]{1,80}$/.test(m.actionId || '') ? m.actionId : undefined });
          }
          continue;
        }
        if (m.t !== 'hb') continue;
        key = 'renderer-' + m.pid;
        onHeartbeat(key, m.pid, 'renderer', m);
        procs.get(key).socket = sock;
      }
    });
    sock.on('close', () => {
      // Reload/quit closes the socket — deregister instead of alarming.
      if (key && procs.get(key)?.socket === sock) {
        procs.delete(key);
        wdLog('[Watchdog] renderer-detached ' + key);
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => wdLog('[Watchdog] socket-server error=' + e.message));
  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    wdLog('[Watchdog] listening sock=' + SOCKET_PATH);
  });
}

wdLog(
  '[Watchdog] started mainPid=' + MAIN_PID +
  ' sampleSupported=' + (process.platform === 'darwin' && fs.existsSync('/usr/bin/sample') ? '1' : '0') +
  ' thresholds=main:500,renderer:750-focused/1500-background,ui:120 capture=4-per-rolling-day/background-max2' +
  ' log=' + LOG_PATH
);
