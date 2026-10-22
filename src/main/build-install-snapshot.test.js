'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBuildInstallSnapshot } = require('./build-install-snapshot');
test('forced snapshot records partial failures as UNKNOWN with a bound, never as idle or a reason to wait indefinitely', async () => {
  const capture = createBuildInstallSnapshot({ pid: 10, timeoutMs: 15,
    runtime: () => ({ idle: false, loaders: [{ tabId: 'T', kind: 'codex', status: 'busy' }] }),
    input: () => [{ tabId: 'T', kind: 'input', status: 'delivery-unknown' }],
    runs: () => [{ runId: 'R', runKind: 'external-research', externalResearchJobId: 'noted_R' }],
    mcp: () => new Promise(() => {}), startup: () => { throw Error('old owner'); },
    readTab: async () => ({ coherent: false, sessionId: 'S', processStatus: 'unknown' }) });
  const value = await capture(); assert.equal(value.mainPid, 10);
  assert.equal(value.runtime.value.idle, false); assert.equal(value.input.value[0].status, 'delivery-unknown');
  assert.equal(value.mcp.known, false); assert.match(value.mcp.error, /deadline/); assert.equal(value.startup.known, false);
  assert.equal(value.tabs[0].known, false); assert.equal(value.coverage.exactRpcOwners, false);
});
