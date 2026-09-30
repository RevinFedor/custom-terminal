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
const { execFile } = require('child_process');
const { buildChildProcessEnv } = require('./child-process-env');
const { createFlightRecorder } = require('./perf-flight-recorder');

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
const SAMPLE_BIN = '/usr/bin/sample';

const bootAt = Date.now();
let lastMainHeartbeatAt = performance.now();
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

const sampleSupported = process.platform === 'darwin' && fs.existsSync(SAMPLE_BIN);
let sampleInFlight = false;
let lameDuck = false;
let mainContext = { appPids: [], tabs: [] };
let mainContextAt = 0;
let flight = null;

// procKey → heartbeat, visibility and connection ownership (not lifecycle state).
const procs = new Map();

function ensureProc(key, pid, label) {
  let p = procs.get(key);
  if (!p) {
    p = { pid, label, lastHbAt: 0, lastOps: '', vis: 'visible', stalled: false };
    procs.set(key, p);
    wdLog('[Watchdog] tracking proc=' + label + ' pid=' + pid);
  }
  return p;
}

function onHeartbeat(key, pid, label, payload) {
  const p = ensureProc(key, pid, label);
  const now = performance.now();
  if (p.stalled) {
    p.stalled = false;
    const silentMs = now - p.lastHbAt;
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
  }
}

// Search hint only: this section includes waiting threads, and stripped
// Electron symbols can be the nearest export with a megabyte-scale offset.
// Neither the first line nor a symbol name proves the hot JS/C++ owner.
function extractTopOfStack(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('Sort by top of stack'));
  if (idx === -1) return '';
  const picked = [];
  for (let i = idx + 1; i < lines.length && picked.length < 4; i++) {
    const l = lines[i].trim();
    if (!l) { if (picked.length) break; continue; }
    picked.push(l.replace(/\s+/g, ' ').slice(0, 180));
  }
  return picked.join(' || ');
}

function maybeSample(p, silentMs, id) {
  if (!sampleSupported) {
    wdLog('[Watchdog] SAMPLE-SKIP proc=' + p.label + ' pid=' + p.pid + ' reason=unsupported-platform');
    return;
  }
  if (sampleInFlight) {
    wdLog('[Watchdog] SAMPLE-SKIP proc=' + p.label + ' pid=' + p.pid + ' reason=sample-in-flight');
    return;
  }
  sampleInFlight = true;
  const out = flight.artifacts.file(id + '.sample.txt');
  wdLog('[Watchdog] SAMPLING proc=' + p.label + ' pid=' + p.pid + ' silentMs=' + silentMs + ' file=' + out);
  // 1 second at 1ms interval — short enough to land inside 1-2s stalls.
  execFile(SAMPLE_BIN, [String(p.pid), '1', '1', '-file', out], {
    timeout: 20000,
    env: buildChildProcessEnv(),
  }, (err) => {
    sampleInFlight = false;
    if (err) {
      wdLog('[Watchdog] SAMPLE-FAILED proc=' + p.label + ' pid=' + p.pid + ' error=' + String(err.message || err).slice(0, 200));
      return;
    }
    let top = '';
    try {
      top = extractTopOfStack(fs.readFileSync(out, 'utf8'));
    } catch (e) {
      top = 'parse-failed: ' + e.message;
    }
    wdLog('[Watchdog] SAMPLE-DONE proc=' + p.label + ' pid=' + p.pid + ' file=' + out + (top ? ' top="' + top + '"' : ''));
    wdLog(
      '[Perf:FreezeSummary] layer=watchdog' +
      ' event=sample' +
      ' kind=processSample' +
      ' severity=major' +
      ' proc=' + p.label +
      ' pid=' + p.pid +
      ' file=' + out +
      (top ? ' top="' + top + '"' : '')
    );
  });
}

try {
  if (LOG_PATH) flight = createFlightRecorder({
    directory: path.join(path.dirname(LOG_PATH), 'perf-incidents'), mainPid: MAIN_PID, log: wdLog,
    context: () => ({ ...mainContext, contextAgeMs: mainContextAt ? Math.round(performance.now() - mainContextAt) : null,
      observers: [...procs.values()].map(p => ({ pid: p.pid, label: p.label, focused: p.focused,
        vis: p.vis, context: p.context, lastOps: p.lastOps, heartbeatAgeMs: Math.round(performance.now() - p.lastHbAt) })) }),
    requestCapture: (request) => {
      // Main may be blocked: request/actual-start timestamps expose that gap.
      try { process.send?.({ t: 'capture', ...request }); } catch {}
      const target = [...procs.values()].find(p => p.pid === request.pid) ||
        [...procs.values()].find(p => p.label === 'renderer' && p.focused) || procs.get('main');
      if (target) maybeSample(target, Math.round(performance.now() - target.lastHbAt), request.id);
    },
  });
} catch (err) { wdLog('[Perf:Incident] disabled error=' + String(err.message).slice(0, 160)); }

let lastCheckAt = performance.now();
setInterval(() => {
  if (lameDuck) return;
  const now = performance.now();
  const observerGap = now - lastCheckAt;
  lastCheckAt = now;
  // If the observer itself was descheduled/asleep, silence cannot prove that
  // every observed process froze independently. Re-arm on fresh heartbeats.
  if (observerGap > 2000) {
    wdLog('[Watchdog] observer-gap ms=' + observerGap.toFixed(1) + ' coverage=unknown');
    for (const p of procs.values()) { p.lastHbAt = 0; p.stalled = false; }
    return;
  }
  for (const p of procs.values()) {
    if (!p.lastHbAt) continue;
    const thr = THRESHOLDS[p.label] || THRESHOLDS.renderer;
    if (p.label === 'renderer' && p.vis !== 'visible') {
      // Hidden window: heartbeat interval is legitimately throttled — silence
      // here is not a freeze. Reset without a RESUMED log to avoid noise.
      p.stalled = false;
      continue;
    }
    const silentMs = now - p.lastHbAt;
    const stallMs = p.label === 'renderer' && p.focused ? 750 : thr.stallMs;
    if (!p.stalled && silentMs > stallMs) {
      p.stalled = true;
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
    }
  }
}, CHECK_INTERVAL_MS);

// ── main heartbeat channel ──────────────────────────────────────────────────
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'bye') {
    lameDuck = true;
    wdLog('[Watchdog] bye received — lame duck (no alarms during shutdown)');
    return;
  }
  if (m.t === 'hb' && m.proc === 'main') {
    lastMainHeartbeatAt = performance.now();
    if (m.context && Array.isArray(m.context.appPids) && Array.isArray(m.context.tabs)) {
      mainContext = { appPids: m.context.appPids.slice(0, 64), tabs: m.context.tabs.slice(0, 1024) };
      mainContextAt = performance.now();
    }
    onHeartbeat('main', MAIN_PID, 'main', m);
  }
});
process.on('disconnect', () => {
  wdLog('[Watchdog] main channel closed — exit');
  cleanupAndExit(0);
});
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));

function cleanupAndExit(code) {
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
        if (m.t === 'incident') {
          const owner = procs.get('renderer-' + m.pid);
          const kind = String(m.kind || '').slice(0, 64);
          if (owner?.vis === 'visible' && Number.isFinite(m.durationMs) && m.durationMs >= (kind.startsWith('ui-') ? 120 : 250)) {
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

// Orphan belt: fork channel close already exits us; this covers exotic cases
// where the channel object leaks but main is long gone.
setInterval(() => {
  if (lameDuck) return;
  if (performance.now() - lastMainHeartbeatAt > 180000) {
    wdLog('[Watchdog] no main heartbeat for 180s — assuming orphan, exit');
    cleanupAndExit(0);
  }
}, 30000);

wdLog(
  '[Watchdog] started mainPid=' + MAIN_PID +
  ' sampleSupported=' + (sampleSupported ? '1' : '0') +
  ' thresholds=main:500,renderer:750-focused/1500-background,ui:120 capture=4-per-rolling-day/background-max2' +
  ' log=' + LOG_PATH
);
