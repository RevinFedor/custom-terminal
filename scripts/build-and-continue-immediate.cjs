#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const api = require('./noted-prod-api');
const maintenanceApi = require('./research-maintenance.cjs');
const ROOT = path.resolve(__dirname, '..');
const ENDPOINT = '/api/build-continue/operations';

async function runBuildContinue({ operationId = randomUUID(), resume = false, projectDir = ROOT,
  inspect = api.inspectProdServer, readToken = api.readToken, request = api.requestJson,
  wait = api.waitForProdServer, maintenance = maintenanceApi.createClient(),
  install, log = message => console.log('[build:i-c] ' + message), signal } = {}) {
  const found = await inspect();
  if (!['found', 'absent'].includes(found.status)) throw Error('Production app state is unknown; no build or Quit was started');
  const token = await readToken(), oldServer = found.server;
  if (oldServer && !token) throw Error('Production API token is unavailable; no Quit was requested');
  const call = async (server, method, requestPath, body) => {
    const response = await request({ port: server.port, token, method, requestPath, body, timeoutMs: 15000 });
    if (response.statusCode < 200 || response.statusCode >= 300 || response.body?.ok !== true) {
      throw Object.assign(Error(response.body?.error || response.body?.code || 'API HTTP ' + response.statusCode),
        { code: response.body?.code, operationId, httpStatus: response.statusCode });
    }
    return response.body;
  };
  if (oldServer) {
    const me = await call(oldServer, 'GET', '/api/me');
    if (me.capabilities?.buildContinue?.version !== 2 || me.capabilities.buildContinue.proofRevision !== 2) {
      throw Error('Installed Noted needs buildContinue v2/proofRevision2. Perform one coordinated normal update first; app was not closed.');
    }
  }
  log('operation=' + operationId);
  if (resume) {
    if (!oldServer) throw Error('Open the preserved app to recover operation=' + operationId + '; no replacement operation was created');
    return call(oldServer, 'POST', ENDPOINT + '/' + encodeURIComponent(operationId) + '/restore', { version: 2 });
  }
  if (!install) ({ buildInstallNotedTerminal: install } = await import('./build-install-noted-terminal.mjs'));
  const scope = maintenance.installScope('install:noted:continue:' + operationId, { log });
  log(oldServer ? 'capturing current work and closing now, before compilation' : 'app absent; no live continuations');
  const result = await install({ projectDir, signal, maintenance: scope, quitBeforePrepare: true, earlyQuitSource: found,
    beforeReplace: async () => {
      const current = await inspect();
      if (current.status !== 'absent') throw Error('A production app started or became unknown during build; replacement was not applied');
    },
    beforeQuit: oldServer ? async () => {
      let ack;
      try { ack = await call(oldServer, 'POST', ENDPOINT, { version: 2, action: 'capture-quit', operationId, expectedMainPid: oldServer.pid }); }
      catch (error) { if (error.httpStatus) error.quitRequested = false; throw error; }
      if (ack.operation?.id !== operationId || ack.operation?.sourceMainPid !== oldServer.pid) throw Error('Capture ACK changed owner');
      log('captured at ' + new Date(ack.operation.capturedAt).toISOString() + '; report=' + ack.reportUrl);
    } : async () => {},
  });
  if (!oldServer) return { ok: result.ok, install: result, continuation: null };
  if (!result.ok && result.recovery?.status !== 'previous-app-reopened') {
    return { ok: false, install: result, continuation: null, operationId };
  }
  // This wait is a bounded discovery fallback after a known process restart,
  // never a model-result poll. The restored Main owns all future delivery.
  const server = await wait({ token, previousPid: oldServer.pid });
  const continuation = await call(server, 'POST', ENDPOINT + '/' + encodeURIComponent(operationId) + '/restore', { version: 2 });
  log('restore registered; report=' + continuation.reportUrl + (result.ok ? '' : '; previous app reopened after build failure'));
  return { ok: result.ok, install: result, continuation, operationId };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--resume')) throw Error('Usage: npm run build:i-c [-- --resume <operationId>]');
  const controller = new AbortController(), cancel = () => controller.abort(Error('build:i-c cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runBuildContinue({ ...(args.length ? { resume: true, operationId: args[1] } : {}), signal: controller.signal });
    console.log('[build:i-c] ' + JSON.stringify({ ok: result.ok, operationId: result.operationId || result.operation?.id,
      installed: result.install?.installed, restorePhase: result.continuation?.operation?.phase || result.operation?.phase,
      reportUrl: result.continuation?.reportUrl || result.reportUrl, recovery: result.install?.recovery }));
    process.exitCode = result.ok === false ? 1 : 0;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
if (require.main === module) main().catch(error => {
  console.error('[build:i-c] ' + error.message + (error.operationId ? ' operation=' + error.operationId : ''));
  process.exitCode = 1;
});
module.exports = { runBuildContinue, ENDPOINT };
