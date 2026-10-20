#!/usr/bin/env node
'use strict';
// Operator command. No app-data edits, model inputs, quota overrides or Send.
const { inspectProdServer, readToken, requestJson, waitForProdServer } = require('./noted-prod-api');
const endpoint = '/api/orchestrations/maintenance';
const { startupArguments } = require('../src/main/external-research-maintenance');
const failure = (code, message) => Object.assign(new Error(message), { code });
function createClient({ inspect = inspectProdServer, token = readToken, request = requestJson, wait = waitForProdServer } = {}) {
  async function server() {
    const found = await inspect();
    if (found.status !== 'found') throw failure('maintenance_app_unavailable', 'Production Noted API is ' + found.status);
    return found.server;
  }
  async function call(owner, method, body) {
    const bearer = await token();
    if (!bearer) throw failure('maintenance_auth_unavailable', 'Noted API token is unavailable');
    const result = await request({ port: owner.port, token: bearer, method, requestPath: endpoint, body });
    if (result.statusCode === 404) throw failure('maintenance_update_required', 'This Noted build does not support planned maintenance yet');
    if (result.statusCode !== 200 || result.body?.ok !== true || result.body?.maintenance?.version !== 1) {
      throw failure(result.body?.code || 'maintenance_request_failed', 'Maintenance API HTTP ' + result.statusCode);
    }
    return result.body.maintenance;
  }
  return {
    status: async () => call(await server(), 'GET'),
    transition: async (action, operationId) => call(await server(), 'POST', { version: 1, action, operationId }),
    installScope(operationId, { log = () => {} } = {}) {
      const launchArguments = startupArguments(operationId);
      let previousPid = null, bootstrap = false;
      return {
        operationId,
        launchArguments: () => [...launchArguments],
        async begin() {
          log('planned maintenance operation=' + operationId);
          const found = await inspect();
          if (found.status === 'absent') {
            bootstrap = true;
            return { operationId, preparedBeforeQuit: false, bootstrap: true, previousMainAbsent: true };
          }
          if (found.status !== 'found') throw failure('maintenance_app_unavailable', 'Production Noted API is ' + found.status);
          const owner = found.server; previousPid = owner.pid;
          try {
            const state = await call(owner, 'POST', { version: 1, action: 'begin', operationId });
            if (state.activeOperationId !== operationId || state.operation?.state !== 'active') {
              throw failure('maintenance_operation_spent', 'This install operation was already completed');
            }
            return { operationId, preparedBeforeQuit: true };
          } catch (error) {
            // One-time deployment of this very feature. The old Main cannot
            // claim a quiet ACK it does not implement. The new Main receives
            // this exact operation before restore; complete requires its
            // strict startup receipt. Never use an ambiguous POST here.
            if (error.code !== 'maintenance_update_required') throw error;
            bootstrap = true;
            log('legacy bootstrap: old Main has no quiet ACK; exact startup handover is required for the new Main');
            return { operationId, preparedBeforeQuit: false, bootstrap: true };
          }
        },
        async complete({ reopenedPrevious = false } = {}) {
          const owner = await wait({ token: await token(), previousPid: reopenedPrevious ? null : previousPid });
          if (bootstrap && !reopenedPrevious) {
            const state = await call(owner, 'GET');
            if (state.startup?.version !== 1 || state.startup.operationId !== operationId
              || state.startup.durable !== true || state.startup.beforeRestore !== true
              || state.activeOperationId !== operationId) {
              throw failure('maintenance_startup_unconfirmed', 'New Main did not confirm same-operation maintenance before restore');
            }
          } else if (bootstrap) {
            throw failure('maintenance_startup_unconfirmed', 'Legacy rollback cannot claim a new-Main quiet startup receipt');
          }
          const state = await call(owner, 'POST', { version: 1, action: 'complete', operationId });
          if (state.operation?.state !== 'completed' || state.activeOperationId) throw failure('maintenance_end_unconfirmed', 'Maintenance did not finish under its same identity');
          const readback = await call(owner, 'GET');
          if (readback.activeOperationId || !readback.operations.some(x => x.operationId === operationId && x.state === 'completed')) {
            throw failure('maintenance_end_unconfirmed', 'Maintenance readback is incomplete');
          }
          return { operationId, complete: true, bootstrap, preparedBeforeQuit: !bootstrap };
        },
      };
    },
  };
}
async function main() {
  const [action, operationId, ...extra] = process.argv.slice(2);
  if (extra.length || !['status', 'begin', 'complete'].includes(action) || (action !== 'status' && !operationId)
    || (action === 'status' && operationId)) {
    throw new Error('Usage: node scripts/research-maintenance.cjs status | begin <operationId> | complete <same-operationId>');
  }
  const client = createClient();
  const result = action === 'status' ? await client.status() : await client.transition(action, operationId);
  console.log('[ResearchMaintenance] ' + JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error('[ResearchMaintenance] ' + error.code + ': ' + error.message); process.exitCode = 1; });
module.exports = { createClient };
