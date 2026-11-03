#!/usr/bin/env node
'use strict';
// build-when-idle — run from a SEPARATE terminal (NOT inside Noted Terminal).
//
// Polls the PRODUCTION app's local web API (GET /api/install-eligibility) and waits
// until every tab across every project has gone idle — no live Claude (PTY or
// SDK), no busy Gemini, no restart-after-owned shell process. Then it runs
// `npm run build:install` prepares the candidate first. A second fresh idle
// observation approves its existing control-channel gate immediately before
// Quit, replacement and reopening.
//
// Main separates local runtime/input blockers from strictly persisted external
// SC waits. The latter retain their original job/source and future delivery.
// While blockers clear one by one, this prints each transition; when the last
// goes away, the build fires.
//
// Invoked by: npm run build:i-obs
//
// Env knobs:
//   POLL_MS=1000           poll interval
//   IDLE_CONFIRM=2         consecutive idle polls required before building
//                          (smooths short runtime-signal transitions)
//   NO_BUILD=1             just watch + report, never trigger the build
//   PORT=7878              select this verified production port (127.0.0.1)

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const {
  assertInstallerOutsideNoted,
  inspectProdServer: inspectDiscoveredProdServer,
  readToken,
} = require('./noted-prod-api');

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
// Find the live PRODUCTION web-server instance. The discovery dir accumulates
// hundreds of stale web-server-<pid>.json files (the app never deletes them on
// crash) — so we filter to: PID still alive AND its process command points at
// the installed /Applications app (excludes electron-vite dev instances on
// 7979). Discovery/ps errors remain unknown. Newest updatedAt wins if somehow
// more than one verified prod copy runs; PORT must still match that prod.
function inspectProdServer() {
  return inspectDiscoveredProdServer({ forcePort: FORCE_PORT });
}

// A dedicated sentinel for "this running build predates the feature": the old
// app has no /api/install-eligibility route → its catch-all returns 404 not-found.
// We must NOT treat that as idle (that would rebuild blindly); instead tell the
// user to run `build:install` once so the endpoint ships.
class EndpointMissingError extends Error {}

function getActiveLoaders(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/install-eligibility',
      headers: { Authorization: 'Bearer ' + token }, timeout: 4000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('unauthorized (token mismatch)'));
        if (res.statusCode === 404) return reject(new EndpointMissingError('endpoint missing'));
        if (res.statusCode >= 400) return reject(new Error('active-loaders HTTP ' + res.statusCode));
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch {
          return reject(new Error('bad JSON (HTTP ' + res.statusCode + '): ' + buf.slice(0, 80)));
        }
        // 503 is our own fail-safe ({idle:false}) — surface it as a real snap so
        // idleStreak resets and we keep waiting. Anything else with a boolean
        // `idle` is a normal answer.
        if (parsed.version === 1 && parsed.known === true && typeof parsed.eligible === 'boolean' && Array.isArray(parsed.blockers)) {
          return resolve({ ...parsed, idle: parsed.eligible, loaders: parsed.blockers, count: parsed.blockers.length });
        }
        return reject(new Error('unexpected response (HTTP ' + res.statusCode + ')'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
  });
}

const PASSIVE_RUN_AFTER_KINDS = new Set([
  'prompt-queue',
]);

// The install snapshot is distinct from general activity. Passive durable
// promises as well as work already in flight. `build:i-obs` has the narrower
// contract requested by the user: wait for work that is physically running,
// not for an armed Run after condition on an inactive tab. Keep this projection
// in the wrapper as well; unknown queue storage remains a blocker.
//
// Do not recompute a failed/unavailable response into idle. The endpoint's 5xx
// fail-safe has `idle:false` and no valid loader array; that state must continue
// waiting rather than green-lighting a blind rebuild.
function projectBuildInstallBlockers(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.loaders)) return snapshot;
  const loaders = snapshot.loaders.filter(
    (loader) => !PASSIVE_RUN_AFTER_KINDS.has(loader?.kind),
  );
  return {
    ...snapshot,
    idle: loaders.length === 0,
    count: loaders.length,
    loaders,
  };
}

// Main emits `kind:'input'` blockers with identity only (tabId/operationKey),
// so the feed printed "input · (no project) · ?" — and a tab that is busy shows
// up twice, once as `claude busy` and once as `input busy`. 01Nov: two such
// rows were delivery-unknown receipts from 29 Sep / 02 Oct on tabs with no
// process; their native Codex queue died with that lifecycle, yet they kept
// the wait from ever reaching zero.
//
// build:i-obs waits for work that is physically running (see above). A
// historical unknown delivery on a tab whose process is ABSENT cannot hold
// pending input, so it is a passive record here — reported, not waited for.
// A found or unknown process keeps it a blocker. The shared eligibility
// endpoint is unchanged for every other consumer.
const UNKNOWN_DELIVERY = new Set(['delivery-unknown', 'evicted-unknown']);

function describeTab(port, token, tabId) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/status',
      headers: { Authorization: 'Bearer ' + token }, timeout: 3000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(buf) : null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

async function enrichBuildInstallBlockers(snapshot, { describe } = {}) {
  if (!snapshot || !Array.isArray(snapshot.loaders) || typeof describe !== 'function') return snapshot;
  const labelled = new Map();
  for (const l of snapshot.loaders) {
    if (l?.tabId && (l.project || l.workflow || l.name) && !labelled.has(l.tabId)) {
      labelled.set(l.tabId, { project: l.project || null, workflow: l.workflow || null, name: l.name || null });
    }
  }
  const loaders = [], passiveInputs = [];
  for (const l of snapshot.loaders) {
    if (!l || l.kind !== 'input' || !l.tabId) { loaders.push(l); continue; }
    let label = labelled.get(l.tabId) || null;
    let status = null;
    if (!label || UNKNOWN_DELIVERY.has(l.status)) {
      status = await describe(l.tabId);
      if (status) {
        label = { project: label?.project || (status.cwd ? path.basename(status.cwd) : null),
          workflow: label?.workflow || status.workflow || null,
          name: label?.name || status.name || null };
      }
    }
    const next = { ...l, project: l.project || label?.project || null,
      workflow: l.workflow || label?.workflow || null, name: l.name || label?.name || null };
    if (UNKNOWN_DELIVERY.has(l.status) && status?.processStatus === 'absent') passiveInputs.push(next);
    else loaders.push(next);
  }
  return { ...snapshot, loaders, passiveInputs };
}

// One line per tab. A busy tab's `input` twin adds no information over its
// runtime row, so the runtime kind wins; an input-only blocker keeps its row.
function groupLoadersByTab(loaders) {
  const groups = new Map();
  for (const l of loaders || []) {
    const key = l?.tabId || ('~' + (l?.kind || '?') + ':' + (l?.status || '?'));
    const current = groups.get(key);
    if (!current || (current.kind === 'input' && l.kind !== 'input')) groups.set(key, l);
  }
  return [...groups.entries()].map(([key, loader]) => ({ key, loader }));
}

const KIND_LABEL = {
  input: C.yellow + 'ввод' + C.reset,
  claude: C.cyan + 'claude' + C.reset,
  'claude-sdk': C.cyan + 'claude-sdk' + C.reset,
  gemini: C.magenta + 'gemini' + C.reset,
  process: C.yellow + 'process' + C.reset,
  'restart-after': C.yellow + 'restart-after' + C.reset,
};
// Stable per-tab description used both in the live list and in the closed/idle
// announcements, so "what appeared" and "what went idle" read identically.
function loaderLabel(l) {
  // WHERE the user can find this tab comes first: the workflow, as it is
  // named in the sidebar. The execution directory is a different fact and is
  // shown after it, in parentheses, ONLY when the two differ — a tab moved
  // between workflows keeps its old cwd, and printing just that sent the
  // user looking in a workflow the tab had already left (reported 02Nov).
  const where = l.workflow
    ? C.bold + l.workflow + C.reset + (l.project && l.project !== l.workflow ? C.gray + ' (' + l.project + ')' + C.reset : '')
    : l.project ? C.bold + l.project + C.reset : C.gray + '(no workflow)' + C.reset;
  const cmd = l.command ? C.gray + ' (' + l.command + ')' + C.reset : '';
  const why = l.kind === 'input' && l.status ? C.gray + ' [' + l.status + ']' + C.reset : '';
  return (KIND_LABEL[l.kind] || l.kind) + C.gray + ' · ' + C.reset + where + C.gray + ' · ' + C.reset
    + (l.name || (l.tabId ? 'tab ' + String(l.tabId).slice(-6) : '?')) + cmd + why;
}
function dot(status) {
  return status === 'busy' ? C.green + '●' + C.reset
    : status === 'running' ? C.yellow + '●' + C.reset
    : status === 'queued' ? C.magenta + '◌' + C.reset // owed, not running
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

function cancelledError() { return Object.assign(new Error('observer cancelled'), { code: 'INSTALL_CANCELLED' }); }

function waitForIdle(token, { inspect = inspectProdServer, read = getActiveLoaders,
  enrich = enrichBuildInstallBlockers, describe = describeTab,
  pollMs = POLL_MS, idleConfirm = IDLE_CONFIRM, report = feed, progress = () => {}, signal,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let passiveReported = false;
  return new Promise((resolve, reject) => {
    let previous = new Map(), first = true, streak = 0, lastError = null, serverKey = null, timer, settled = false;
    const finish = (error, proof) => {
      if (settled) return; settled = true; clearTimer(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(proof);
    };
    const abort = () => finish(cancelledError());
    signal?.addEventListener('abort', abort, { once: true });
    const retry = () => { if (!settled) timer = setTimer(() => tick().catch(error => finish(error)), pollMs); };
    const unknown = reason => {
      streak = 0;
      if (reason !== lastError) report(C.yellow + '⚠ ' + now() + ' poll: ' + reason + ' (retrying)' + C.reset);
      lastError = reason; progress({ status: 'unknown', reason }); retry();
    };
    const tick = async () => {
      if (settled || signal?.aborted) return abort();
      let observed;
      try { observed = inspect(); } catch { return unknown('process discovery failed'); }
      if (observed?.status === 'absent') {
        report(C.yellow + 'Noted Terminal (prod) is not running — nothing to wait for.' + C.reset);
        return finish(null, { status: 'absent' });
      }
      if (observed?.status !== 'found' || !observed.server) return unknown(observed?.reason || 'process state unknown');
      const server = observed.server;
      const key = String(server.pid) + ':' + server.port;
      if (serverKey !== key) { streak = 0; serverKey = key; }
      let snap;
      try { snap = await read(server.port, token); }
      catch (error) {
        if (settled || signal?.aborted) return abort();
        if (error instanceof EndpointMissingError) return finish(Object.assign(error, { exitCode: 2 }));
        return unknown(error.message);
      }
      if (settled || signal?.aborted) return abort();
      if (snap?.error) return unknown('active-loaders unavailable');
      snap = await enrich(snap, { describe: tabId => describe(server.port, token, tabId) });
      if (settled || signal?.aborted) return abort();
      snap = projectBuildInstallBlockers(snap);
      if (!snap || typeof snap.idle !== 'boolean' || !Array.isArray(snap.loaders)) return unknown('active-loaders unavailable');
      lastError = null;
      const grouped = groupLoadersByTab(snap.loaders);
      const current = new Map(grouped.map(({ key, loader }) => [key, loaderLabel(loader)]));
      if (first) {
        first = false; report(C.gray + 'Connected — ' + (server.pid ? 'pid ' + server.pid : server.cmd) + ' · port ' + server.port + C.reset);
        if (snap.idle) report(C.green + '✓ no install blockers' + C.reset);
        else { report(C.bold + String(grouped.length) + ' active' + C.reset + C.gray + ' — build waits until 0:' + C.reset);
          for (const { loader } of grouped) report('  ' + dot(loader.status) + ' ' + loaderLabel(loader)); }
      } else {
        for (const [id, label] of current) if (!previous.has(id)) report(C.yellow + '＋ ' + now() + '  active  ' + C.reset + label);
        for (const [id, label] of previous) if (!current.has(id)) report(C.green + '✓ ' + now() + '  idle    ' + C.reset + label);
      }
      if (!passiveReported && snap.passiveInputs?.length) {
        passiveReported = true;
        report(C.gray + 'not waited for (unknown old delivery, tab has no process):' + C.reset);
        for (const loader of snap.passiveInputs) report(C.gray + '  · ' + C.reset + loaderLabel(loader));
      }
      previous = current;
      streak = snap.idle === true ? streak + 1 : 0;
      progress({ status: snap.idle ? 'idle' : 'busy', pid: server.pid, count: snap.count });
      if (streak >= idleConfirm) return finish(null, { status: 'idle', pid: server.pid, port: server.port });
      retry();
    };
    void tick().catch(error => finish(error));
  });
}

function runBuild(token, { spawnBuild = spawn, observe = waitForIdle, report = feed,
  stdout = process.stdout, stderr = process.stderr, signal, nonce = 'build-i-obs-' + randomUUID(), cwd = process.cwd(), env = process.env } = {}) {
  report('▶ initial idle confirmed — preparing `npm run build:install`; neighbours are checked again before Quit');
  return new Promise((resolve, reject) => {
    const child = spawnBuild('npm', ['run', 'build:install'], {
      stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...env, NOTED_INSTALL_IDLE_ACK_ID: nonce },
    });
    let buffer = '', prepared = false, completed = false;
    const stage = new AbortController();
    const abort = () => {
      stage.abort();
      child.stdin?.end('cancel ' + nonce + '\n');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin?.on('error', error => { stage.abort(); report('Install control channel failed: ' + error.message); });
    child.stderr?.on('data', chunk => stderr.write(chunk));
    child.stdout?.on('data', chunk => {
      stdout.write(chunk); buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (line !== '[NotedInstall:ready-to-quit] ' + nonce || prepared || completed || signal?.aborted) continue;
        prepared = true;
        report('▶ candidate ready — rechecking active sessions before Quit');
        void observe(token, { signal: stage.signal, progress: () => {
          if (!completed && !stage.signal.aborted && !child.stdin?.destroyed) child.stdin.write('waiting ' + nonce + '\n');
        } }).then(proof => {
          if (completed || stage.signal.aborted || child.stdin?.destroyed) return;
          if (!['idle', 'absent'].includes(proof?.status)) throw new Error('idle not confirmed');
          report('▶ final install approval: ' + proof.status + (proof.pid ? ' · pid ' + proof.pid : ''));
          child.stdin.write('install ' + nonce + '\n');
        }).catch(error => {
          report('Install not approved: ' + error.message); child.stdin?.end();
        });
      }
      if (buffer.length > 16384) buffer = buffer.slice(-16384);
    });
    child.once('error', error => { completed = true; stage.abort(); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('exit', code => { completed = true; stage.abort(); signal?.removeEventListener('abort', abort); resolve(code == null ? 1 : code); });
  });
}

async function main() {
  const token = readToken();
  if (!token) throw new Error('No Noted Terminal web token found.');
  const controller = new AbortController();
  const cancel = () => { controller.abort(); feed('cancellation requested'); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    feed(C.bold + C.green + 'build:i-obs' + C.reset + ' — waiting for running work (Ctrl+C to cancel)');
    await waitForIdle(token, { signal: controller.signal });
    if (NO_BUILD) { feed('idle confirmed (NO_BUILD=1 — not building)'); return; }
    process.exitCode = await runBuild(token, { signal: controller.signal });
  } catch (error) {
    if (error instanceof EndpointMissingError) console.error('Installed app lacks /api/install-eligibility. A one-time explicit build:install is required.');
    else if (error.code !== 'INSTALL_CANCELLED') console.error(String(error.stack || error));
    process.exitCode = error.code === 'INSTALL_CANCELLED' ? 130 : error.exitCode || 1;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

module.exports = { waitForIdle, runBuild, projectBuildInstallBlockers, enrichBuildInstallBlockers,
  groupLoadersByTab, loaderLabel, EndpointMissingError };
if (require.main === module) {
  // Fail before the idle wait: its build:install child would quit this host.
  let refused = null;
  try { assertInstallerOutsideNoted('build:i-obs'); } catch (error) { refused = error; }
  if (refused) { console.error('[build:i-obs] ' + refused.message); process.exitCode = 1; }
  else void main();
}
