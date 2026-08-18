#!/usr/bin/env node
'use strict';

// build:i-cont — rebuild/install Noted Terminal, then send the single prompt
// `continue` to every Claude/Codex PTY that this exact shutdown interrupted.
// Run from a terminal outside Noted Terminal: the app being rebuilt is closed.

const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  findProdServer,
  readToken,
  requestJson,
  sleep,
  waitForProdServer,
} = require('./noted-prod-api');

const CONTINUE_PROMPT = 'continue';
const TARGET_READY_TIMEOUT_MS = Number(process.env.CONTINUE_READY_TIMEOUT_MS) || 120_000;
const REPLACEMENT_APP_TIMEOUT_MS = Number(process.env.CONTINUE_APP_TIMEOUT_MS) || 180_000;

function runCanonicalBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:install'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error('build:install failed'
        + (code == null ? '' : ' with exit code ' + code)
        + (signal ? ' (' + signal + ')' : '')));
    });
  });
}

function validateTargetSnapshot(snapshot, { previousPid, buildStartedAt }) {
  if (!snapshot || !Array.isArray(snapshot.targets) || !Array.isArray(snapshot.unresolved)) {
    throw new Error('replacement app returned an invalid continuation snapshot');
  }
  if (snapshot.source === 'exact-shutdown-snapshot') {
    if (!Number.isFinite(Number(snapshot.shutdownPid)) || Number(snapshot.shutdownPid) !== Number(previousPid)) {
      throw new Error('continuation snapshot belongs to a different app process');
    }
    if (!Number.isFinite(Number(snapshot.capturedAt)) || Number(snapshot.capturedAt) < buildStartedAt - 10_000) {
      throw new Error('continuation snapshot predates this build');
    }
  } else if (snapshot.source !== 'legacy-interrupted-fallback') {
    throw new Error('continuation target proof unavailable: ' + String(snapshot.source || 'unknown'));
  }
  return {
    targets: snapshot.targets.filter((target) => target
      && typeof target.tabId === 'string'
      && (target.provider === 'claude' || target.provider === 'codex')
      && typeof target.sessionId === 'string'),
    unresolved: snapshot.unresolved,
    legacy: snapshot.source === 'legacy-interrupted-fallback',
  };
}

function classifyContinueSendResponse(response) {
  const statusCode = Number(response?.statusCode) || 0;
  const body = response?.body || {};
  if (statusCode >= 200 && statusCode < 300) {
    return {
      accepted: true,
      uncertain: statusCode === 202
        || body?.deliveryState === 'delivery-unknown'
        || body?.status === 'delivery_unknown'
        || body?.status === 'audit-pending',
      status: body?.status || body?.deliveryState || (statusCode === 202 ? 'accepted-unverified' : 'sent'),
    };
  }
  return {
    accepted: false,
    uncertain: false,
    status: body?.code || body?.error || 'HTTP ' + statusCode,
  };
}

async function waitForRestoredTarget(server, token, target) {
  const deadline = Date.now() + TARGET_READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson({
        port: server.port,
        token,
        requestPath: '/api/terminal-tabs/' + encodeURIComponent(target.tabId) + '/status',
        timeoutMs: 5000,
      });
      last = response;
      const body = response.body || {};
      const provider = body.toolType || body.commandType || null;
      const status = body.status || body.sessionStatus || 'unknown';
      if (response.statusCode === 200
        && provider === target.provider
        && status !== 'unknown'
        && status !== 'stopping') {
        return body;
      }
    } catch (error) {
      last = error;
    }
    await sleep(400);
  }
  const detail = last?.body?.error || last?.message || last?.body?.status || 'no restored status';
  throw new Error('tab did not restore before timeout: ' + detail);
}

async function sendContinue(server, token, target, operationId, index) {
  const status = await waitForRestoredTarget(server, token, target);
  const handoffId = 'build-continue:' + operationId + ':' + String(index + 1);
  const response = await requestJson({
    port: server.port,
    token,
    method: 'POST',
    requestPath: '/api/terminal-tabs/' + encodeURIComponent(target.tabId) + '/send',
    body: {
      prompt: CONTINUE_PROMPT,
      source: 'build-install-continue',
      handoffId,
      statusAtSend: status.status || status.sessionStatus || 'unknown',
      provider: target.provider,
    },
    timeoutMs: 90_000,
  });
  return { response, outcome: classifyContinueSendResponse(response), handoffId };
}

function targetLabel(target) {
  const project = target.projectName || target.projectId || 'project';
  const tab = target.tabName || target.tabId.slice(-12);
  return target.provider + ' · ' + project + ' · ' + tab;
}

async function main() {
  const oldServer = findProdServer();
  const token = readToken();
  if (oldServer && !token) {
    throw new Error('Noted Terminal is running, but its web token is unavailable; build was not started');
  }

  const buildStartedAt = Date.now();
  const operationId = crypto.randomUUID();
  console.log('[build:i-cont] canonical build/install starts now');
  console.log('[build:i-cont] post-install prompt: ' + JSON.stringify(CONTINUE_PROMPT));
  if (!oldServer) {
    console.log('[build:i-cont] production app is not running — no live tabs can be continuation targets');
  } else {
    console.log('[build:i-cont] source app pid=' + oldServer.pid + ' port=' + oldServer.port);
  }

  await runCanonicalBuild();
  if (!oldServer) {
    console.log('[build:i-cont] build installed; 0 stopped AI tabs, nothing to send');
    return;
  }

  console.log('[build:i-cont] waiting for replacement app API…');
  const newServer = await waitForProdServer({
    token,
    previousPid: oldServer.pid,
    timeoutMs: REPLACEMENT_APP_TIMEOUT_MS,
  });
  console.log('[build:i-cont] replacement app ready pid=' + newServer.pid + ' port=' + newServer.port);

  const snapshotResponse = await requestJson({
    port: newServer.port,
    token,
    requestPath: '/api/build-continue-targets',
    timeoutMs: 5000,
  });
  if (snapshotResponse.statusCode !== 200 || snapshotResponse.body?.ok !== true) {
    throw new Error('replacement app did not expose continuation targets (HTTP '
      + snapshotResponse.statusCode + ')');
  }
  const plan = validateTargetSnapshot(snapshotResponse.body.snapshot, {
    previousPid: oldServer.pid,
    buildStartedAt,
  });
  if (plan.legacy) {
    console.warn('[build:i-cont] first-run compatibility: targets came from unambiguous interrupted session bindings');
  }
  if (plan.unresolved.length > 0) {
    for (const item of plan.unresolved) {
      console.warn('[build:i-cont] skipped unresolved tab=' + String(item.tabId || '?')
        + ' reason=' + String(item.reason || 'unknown'));
    }
  }
  if (plan.targets.length === 0) {
    console.log('[build:i-cont] build installed; 0 proven stopped Claude/Codex tabs');
    if (plan.unresolved.length > 0) process.exitCode = 2;
    return;
  }

  console.log('[build:i-cont] sending sequential startup admissions to ' + plan.targets.length + ' tab(s)…');
  let accepted = 0;
  let uncertain = 0;
  let failed = 0;
  for (let index = 0; index < plan.targets.length; index += 1) {
    const target = plan.targets[index];
    const label = targetLabel(target);
    try {
      console.log('[build:i-cont] [' + (index + 1) + '/' + plan.targets.length + '] ' + label + ' — waiting for restore');
      const result = await sendContinue(newServer, token, target, operationId, index);
      if (!result.outcome.accepted) {
        failed += 1;
        console.error('[build:i-cont] FAILED ' + label + ' — ' + result.outcome.status);
        continue;
      }
      accepted += 1;
      if (result.outcome.uncertain) uncertain += 1;
      console.log('[build:i-cont] ' + (result.outcome.uncertain ? 'ACCEPTED/VERIFYING ' : 'SENT ')
        + label + ' handoff=' + result.handoffId);
    } catch (error) {
      failed += 1;
      console.error('[build:i-cont] FAILED ' + label + ' — ' + (error?.message || error));
    }
  }

  console.log('[build:i-cont] done accepted=' + accepted
    + ' verifying=' + uncertain
    + ' failed=' + failed
    + ' unresolved=' + plan.unresolved.length);
  if (failed > 0 || plan.unresolved.length > 0) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[build:i-cont] ' + (error?.stack || error?.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  CONTINUE_PROMPT,
  classifyContinueSendResponse,
  validateTargetSnapshot,
};
