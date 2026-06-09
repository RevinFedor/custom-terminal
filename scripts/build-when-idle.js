#!/usr/bin/env node
'use strict';
// build-when-idle — run from a SEPARATE terminal (NOT inside Noted Terminal).
//
// Polls the PRODUCTION app's local web API (GET /api/active-loaders) and waits
// until every tab across every project has gone idle — no live Claude (PTY or
// SDK), no busy Gemini, no running process (npm run dev counts). Then it runs
// `npm run build:install`, which gracefully quits the app, rebuilds, reinstalls
// and reopens it.
//
// "Active" reuses the EXACT live Maps that drive the per-tab UI loader
// (computeActiveLoaders() in src/main/main.js) — there is no second notion of
// busy. While you close tabs one by one, this prints each one going idle and
// updates the live list; when the last goes away, the build fires.
//
// Invoked by: npm run build:i-obs
//
// Env knobs:
//   POLL_MS=1000           poll interval
//   IDLE_CONFIRM=2         consecutive idle polls required before building
//                          (guards against a 1-tick gap between two turns)
//   NO_BUILD=1             just watch + report, never trigger the build
//   PORT=7878              skip discovery, force this port (127.0.0.1)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const HOME = os.homedir();
const DISCOVERY_DIR = path.join(HOME, '.noted-terminal');
const TOKEN_PATH = path.join(DISCOVERY_DIR, 'web-token.txt');
const PROD_APP_MARKER = '/Applications/Noted Terminal.app';

const POLL_MS = parseInt(process.env.POLL_MS || '', 10) || 1000;
const IDLE_CONFIRM = parseInt(process.env.IDLE_CONFIRM || '', 10) || 2;
const NO_BUILD = process.env.NO_BUILD === '1';
const FORCE_PORT = parseInt(process.env.PORT || '', 10) || null;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  red: '\x1b[31m', gray: '\x1b[90m', magenta: '\x1b[35m',
};

function now() { return new Date().toTimeString().slice(0, 8); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function pidCommand(pid) {
  try { return execSync('ps -p ' + pid + ' -o command=', { encoding: 'utf8', timeout: 1500 }).trim(); }
  catch { return ''; }
}

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return null; }
}

// Find the live PRODUCTION web-server instance. The discovery dir accumulates
// hundreds of stale web-server-<pid>.json files (the app never deletes them on
// crash) — so we filter to: PID still alive AND its process command points at
// the installed /Applications app (excludes electron-vite dev instances on
// 7979). Newest updatedAt wins if somehow more than one prod copy runs.
function findProdServer() {
  if (FORCE_PORT) return { port: FORCE_PORT, pid: null, cmd: '(forced)', forced: true };
  let files = [];
  try { files = fs.readdirSync(DISCOVERY_DIR).filter((f) => /^web-server-\d+\.json$/.test(f)); }
  catch { return null; }
  const candidates = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, f), 'utf8')); } catch { continue; }
    if (!j.pid || !j.port) continue;
    if (!pidAlive(j.pid)) continue;
    const cmd = pidCommand(j.pid);
    if (!cmd.includes(PROD_APP_MARKER)) continue; // dev / unrelated / dead-but-reused PID
    candidates.push({ port: j.port, pid: j.pid, updatedAt: j.updatedAt || 0, cmd });
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] || null;
}

// A dedicated sentinel for "this running build predates the feature": the old
// app has no /api/active-loaders route → its catch-all returns 404 not-found.
// We must NOT treat that as idle (that would rebuild blindly); instead tell the
// user to run `build:install` once so the endpoint ships.
class EndpointMissingError extends Error {}

function getActiveLoaders(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/active-loaders',
      headers: { Authorization: 'Bearer ' + token }, timeout: 4000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('unauthorized (token mismatch)'));
        if (res.statusCode === 404) return reject(new EndpointMissingError('endpoint missing'));
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch {
          return reject(new Error('bad JSON (HTTP ' + res.statusCode + '): ' + buf.slice(0, 80)));
        }
        // 503 is our own fail-safe ({idle:false}) — surface it as a real snap so
        // idleStreak resets and we keep waiting. Anything else with a boolean
        // `idle` is a normal answer.
        if (typeof parsed.idle === 'boolean') return resolve(parsed);
        return reject(new Error('unexpected response (HTTP ' + res.statusCode + ')'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
  });
}

const KIND_LABEL = {
  claude: C.cyan + 'claude' + C.reset,
  'claude-sdk': C.cyan + 'claude-sdk' + C.reset,
  gemini: C.magenta + 'gemini' + C.reset,
  process: C.yellow + 'process' + C.reset,
};
// Stable per-tab description used both in the live list and in the closed/idle
// announcements, so "what appeared" and "what went idle" read identically.
function loaderLabel(l) {
  const proj = l.project ? C.bold + l.project + C.reset : C.gray + '(no project)' + C.reset;
  const cmd = l.command ? C.gray + ' (' + l.command + ')' + C.reset : '';
  return (KIND_LABEL[l.kind] || l.kind) + C.gray + ' · ' + C.reset + proj + C.gray + ' · ' + C.reset + (l.name || '?') + cmd;
}
function dot(status) {
  return status === 'busy' ? C.green + '●' + C.reset
    : status === 'running' ? C.yellow + '●' + C.reset
    : C.cyan + '◐' + C.reset; // active / starting (alive but not actively streaming)
}

// Append-only feed (matches the user's mental model: tabs are announced as they
// appear, then each is announced again the moment it goes idle; finally "all
// idle"). No screen-clearing → survives scrollback, no cursor math to corrupt.
function feed(line) { process.stdout.write(line + '\n'); }
function printActiveList(snap) {
  feed(C.bold + String(snap.count) + ' active' + C.reset + C.gray + ' — build waits until 0:' + C.reset);
  for (const l of snap.loaders) feed('  ' + dot(l.status) + ' ' + loaderLabel(l));
}

function runBuild() {
  process.stdout.write('\n' + C.green + C.bold + '▶ all idle — running `npm run build:install`' + C.reset + '\n\n');
  const child = spawn('npm', ['run', 'build:install'], { stdio: 'inherit', cwd: process.cwd() });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
  child.on('error', (e) => { console.error(C.red + 'failed to start build: ' + e.message + C.reset); process.exit(1); });
}

async function main() {
  const token = readToken();
  if (!token) {
    console.error(C.red + 'No web token at ' + TOKEN_PATH + C.reset);
    console.error(C.gray + 'Is Noted Terminal installed and launched at least once?' + C.reset);
    process.exit(1);
  }

  let prevActive = new Map(); // tabId → loaderLabel (to diff appeared vs idle)
  let firstSnap = true;
  let idleStreak = 0;
  let lastErrShown = null;    // de-dupe repeated transient poll errors

  feed(C.bold + C.green + 'build:i-obs' + C.reset + C.gray + ' — waiting for Noted Terminal to go idle, then `npm run build:install`' + C.reset);
  if (NO_BUILD) feed(C.gray + 'NO_BUILD=1 — will report idle and exit without building.' + C.reset);
  feed(C.gray + 'Discovering production Noted Terminal…  (Ctrl+C to cancel)' + C.reset);

  const tick = async () => {
    const server = findProdServer();
    if (!server) {
      // No live prod instance. If it was running and is now gone, or never ran,
      // there is nothing left to wait for → idle by definition.
      feed(C.yellow + 'Noted Terminal (prod) is not running — nothing to wait for.' + C.reset);
      if (NO_BUILD) { feed(C.gray + 'NO_BUILD=1 — exiting.' + C.reset); process.exit(0); }
      return runBuild();
    }

    let snap = null, lastErr = null;
    try { snap = await getActiveLoaders(server.port, token); }
    catch (e) {
      if (e instanceof EndpointMissingError) {
        // The installed app is older than this feature. Bootstrap it once.
        feed(C.yellow + 'The installed Noted Terminal predates /api/active-loaders.' + C.reset);
        feed(C.gray + 'Run a one-time ' + C.reset + C.bold + 'npm run build:install' + C.reset + C.gray + ' to ship the endpoint,' + C.reset);
        feed(C.gray + 'then ' + C.reset + C.bold + 'npm run build:i-obs' + C.reset + C.gray + ' will work on every later rebuild.' + C.reset);
        process.exit(2);
      }
      lastErr = e.message;
    }

    if (lastErr) {
      // Transient (timeout / app reloading). Don't spam — print once per change.
      if (lastErr !== lastErrShown) { feed(C.yellow + '⚠ ' + now() + ' poll: ' + lastErr + ' (retrying)' + C.reset); lastErrShown = lastErr; }
      idleStreak = 0;              // a failed poll is NEVER idle — keep waiting
      return setTimeout(tick, POLL_MS);
    }
    lastErrShown = null;

    // First successful snapshot: print the full active list once as the baseline.
    if (firstSnap) {
      firstSnap = false;
      const pidStr = server.pid ? 'pid ' + server.pid : server.cmd;
      feed(C.gray + 'Connected — ' + pidStr + ' · port ' + server.port + C.reset);
      if (snap.idle) feed(C.green + '✓ already idle — nothing running' + C.reset);
      else printActiveList(snap);
    } else {
      // Delta announcements against the previous poll.
      const cur = new Map(snap.loaders.map((l) => [l.tabId, loaderLabel(l)]));
      for (const [tid, label] of cur) {
        if (!prevActive.has(tid)) feed(C.cyan + '＋ ' + now() + '  active  ' + C.reset + label); // a new loader appeared
      }
      for (const [tid, label] of prevActive) {
        if (!cur.has(tid)) feed(C.green + '✓ ' + now() + '  idle    ' + C.reset + label);        // went idle / closed
      }
      // When everything just cleared, say so explicitly (the moment the user
      // closes the last tab) — separate from the confirm/build step below.
      if (snap.idle && prevActive.size > 0) feed(C.green + C.bold + '✓ ' + now() + '  all tabs idle' + C.reset);
    }
    prevActive = new Map(snap.loaders.map((l) => [l.tabId, loaderLabel(l)]));

    // Build only after IDLE_CONFIRM consecutive confirmed-idle polls. Guards a
    // 1-tick gap between two queued turns (turn A ends → 0 for one poll → turn B
    // starts) from green-lighting a rebuild mid-session.
    if (snap.idle === true) idleStreak += 1;
    else idleStreak = 0;

    if (idleStreak >= IDLE_CONFIRM) {
      if (NO_BUILD) { feed(C.green + '✓ idle confirmed (NO_BUILD=1 — not building)' + C.reset); process.exit(0); }
      return runBuild();
    }

    setTimeout(tick, POLL_MS);
  };

  tick();
}

process.on('SIGINT', () => {
  process.stdout.write('\n' + C.gray + 'cancelled — no build triggered.' + C.reset + '\n');
  process.exit(130);
});

main().catch((e) => { console.error(C.red + String(e && e.stack || e) + C.reset); process.exit(1); });
