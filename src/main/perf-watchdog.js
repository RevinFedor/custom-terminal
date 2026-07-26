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
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { buildChildProcessEnv } = require('./child-process-env');

const MAIN_PID = parseInt(process.argv[2], 10) || 0;
const LOG_PATH = process.argv[3] || '';
const SOCKET_PATH = process.argv[4] || '';

const CHECK_INTERVAL_MS = 100;
// Renderer thresholds are looser: hidden/occluded windows get timer throttling
// (background throttling clamps setInterval to >=1s) — the vis flag in each
// heartbeat gates detection to visible windows only, thresholds add margin.
const THRESHOLDS = {
  main: { stallMs: 500, sampleMs: 1000 },
  renderer: { stallMs: 1500, sampleMs: 2500 },
};
const SAMPLE_MIN_GAP_MS = 20000; // per-process floor between samples
const SAMPLE_MAX_TOTAL = 10;     // per watchdog lifetime
const SAMPLE_BIN = '/usr/bin/sample';

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

const sampleSupported = process.platform === 'darwin' && fs.existsSync(SAMPLE_BIN);
let totalSamples = 0;
let sampleInFlight = false;
let lameDuck = false;
let sampleCapLogged = false;

// procKey → { pid, label, lastHbAt, lastOps, vis, stalled, sampledThisStall, lastSampleAt }
const procs = new Map();

function ensureProc(key, pid, label) {
  let p = procs.get(key);
  if (!p) {
    p = { pid, label, lastHbAt: 0, lastOps: '', vis: 'visible', stalled: false, sampledThisStall: false, lastSampleAt: 0 };
    procs.set(key, p);
    wdLog('[Watchdog] tracking proc=' + label + ' pid=' + pid);
  }
  return p;
}

function onHeartbeat(key, pid, label, payload) {
  const p = ensureProc(key, pid, label);
  const now = Date.now();
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
    if (typeof payload.ops === 'string') p.lastOps = payload.ops.slice(0, 600);
  }
}

// Top-of-stack extraction: `sample` ends with a "Sort by top of stack" section
// whose first lines are exactly the frames the process spent the stall in.
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

function maybeSample(p, silentMs) {
  if (!sampleSupported) {
    wdLog('[Watchdog] SAMPLE-SKIP proc=' + p.label + ' pid=' + p.pid + ' reason=unsupported-platform');
    return;
  }
  if (sampleInFlight) {
    wdLog('[Watchdog] SAMPLE-SKIP proc=' + p.label + ' pid=' + p.pid + ' reason=sample-in-flight');
    return;
  }
  if (totalSamples >= SAMPLE_MAX_TOTAL) {
    if (!sampleCapLogged) {
      sampleCapLogged = true;
      wdLog('[Watchdog] SAMPLE-SKIP reason=lifetime-cap total=' + totalSamples);
    }
    return;
  }
  const now = Date.now();
  if (p.lastSampleAt && now - p.lastSampleAt < SAMPLE_MIN_GAP_MS) {
    wdLog('[Watchdog] SAMPLE-SKIP proc=' + p.label + ' pid=' + p.pid + ' reason=rate-limited');
    return;
  }
  p.lastSampleAt = now;
  totalSamples++;
  sampleInFlight = true;
  const out = path.join(os.tmpdir(), 'noted-wd-sample-' + p.label + '-' + p.pid + '-' + now + '.txt');
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

setInterval(() => {
  if (lameDuck) return;
  const now = Date.now();
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
    if (!p.stalled && silentMs > thr.stallMs) {
      p.stalled = true;
      p.sampledThisStall = false;
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
    }
    if (p.stalled && !p.sampledThisStall && silentMs > thr.sampleMs) {
      p.sampledThisStall = true;
      maybeSample(p, silentMs);
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
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m || m.proc !== 'renderer' || !m.pid) continue;
        key = 'renderer-' + m.pid;
        onHeartbeat(key, m.pid, 'renderer', m);
      }
    });
    sock.on('close', () => {
      // Reload/quit closes the socket — deregister instead of alarming.
      if (key && procs.has(key)) {
        procs.delete(key);
        wdLog('[Watchdog] renderer-detached ' + key);
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => wdLog('[Watchdog] socket-server error=' + e.message));
  server.listen(SOCKET_PATH, () => wdLog('[Watchdog] listening sock=' + SOCKET_PATH));
}

// Orphan belt: fork channel close already exits us; this covers exotic cases
// where the channel object leaks but main is long gone.
setInterval(() => {
  if (lameDuck) return;
  const m = procs.get('main');
  const lastSeen = m && m.lastHbAt ? m.lastHbAt : bootAt;
  if (Date.now() - lastSeen > 180000) {
    wdLog('[Watchdog] no main heartbeat for 180s — assuming orphan, exit');
    cleanupAndExit(0);
  }
}, 30000);

wdLog(
  '[Watchdog] started mainPid=' + MAIN_PID +
  ' sampleSupported=' + (sampleSupported ? '1' : '0') +
  ' thresholds=main:' + THRESHOLDS.main.stallMs + '/' + THRESHOLDS.main.sampleMs +
  ',renderer:' + THRESHOLDS.renderer.stallMs + '/' + THRESHOLDS.renderer.sampleMs +
  ' log=' + LOG_PATH
);
