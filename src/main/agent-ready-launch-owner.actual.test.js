'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { waitForAgentReadyTransition, agentAdmittedReadyOwner } = require('./agent-ready-wait');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const wrapperStart = source.indexOf('async function waitForMainAgentStartReady(');
const wrapperEnd = source.indexOf("\nipcMain.handle('agent:wait-start-ready'", wrapperStart);
assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
const wrapper = source.slice(wrapperStart, wrapperEnd);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Execute the exact MCP start_ai callsite and real Main readiness owner/wait.
// Only runtime snapshots and their interprocess completion order are controlled.
function startWait(engine, runResult, readStatus) {
  const launcher = engine === 'codex' ? 'runCodexCommandFromPayload' : 'runClaudeCommandSerialized';
  const launchAt = source.indexOf('const runResult = await ' + launcher + '(');
  const waitAt = source.indexOf('readyStatus = await waitForMainAgentStartReady(', launchAt);
  const callEnd = source.indexOf('\n                );', waitAt);
  assert.ok(launchAt >= 0 && waitAt > launchAt && callEnd > waitAt);
  const call = source.slice(waitAt + 'readyStatus = '.length, callEnd + '\n                );'.length);
  return vm.runInNewContext(wrapper + '\n(async () => { return ' + call + ' })()', {
    tabId: 'T', engine, runResult, startReadyTimeoutMs: 1000,
    waitForAgentReadyTransition, agentAdmittedReadyOwner, ipcMain: new EventEmitter(),
    readMainAgentStartReadiness: readStatus, console: { log() {} },
  });
}
const accepted = engine => ({ success: true, accepted: engine === 'claude',
  acceptancePending: engine === 'codex', launchId: 'L1', lifecycleGeneration: 'G1' });
const ready = (engine, patch = {}) => ({ tabId: 'T', toolType: engine, status: 'active',
  liveLifecycle: true, inputReady: true, launchId: 'L1', lifecycleGeneration: 'G1', sessionId: 'C', ...patch });

for (const engine of ['codex', 'claude']) {
  test(engine + ' MCP start cannot complete from a replacement seen by the first runtime read', async () => {
    await assert.rejects(startWait(engine, accepted(engine), async () => ready(engine, { launchId: 'L2' })),
      error => error.code === 'agent_ready_owner_changed');
  });
  test(engine + ' MCP start accepts the original launch child without treating its SID as replacement', async () => {
    const result = await startWait(engine, accepted(engine), async () => ready(engine));
    assert.equal(result.sessionId, 'C'); assert.equal(result.launchId, 'L1');
  });
  test(engine + ' MCP result missing launch identity fails before adopting any current runtime', async () => {
    let reads = 0;
    await assert.rejects(startWait(engine, { success: true, accepted: true }, async () => {
      reads++; return ready(engine, { launchId: 'L2' });
    }), error => error.code === 'agent_ready_owner_missing');
    assert.equal(reads, 0);
  });
  test(engine + ' MCP wait freezes the accepted result across an asynchronous first read', async () => {
    const hold = deferred(), runResult = accepted(engine);
    const result = startWait(engine, runResult, () => hold.promise);
    runResult.launchId = 'L2';
    hold.resolve(ready(engine, { launchId: 'L2' }));
    await assert.rejects(result, error => error.code === 'agent_ready_owner_changed');
  });
}

test('Claude keeps its own first OSC-B lifecycle transition under the admitted launch token', async () => {
  const result = await startWait('claude', accepted('claude'), async () => ready('claude', { lifecycleGeneration: 'G2' }));
  assert.equal(result.launchId, 'L1'); assert.equal(result.lifecycleGeneration, 'G2');
});

test('Codex keeps its stronger admitted lifecycle pin even when the launch ID matches', async () => {
  await assert.rejects(startWait('codex', accepted('codex'), async () => ready('codex', { lifecycleGeneration: 'G2' })),
    error => error.code === 'agent_ready_owner_changed');
});

test('unrelated generic readiness callers retain first-observed-owner behavior', async () => {
  const result = await waitForAgentReadyTransition({ tabId: 'T', eventBus: new EventEmitter(),
    readStatus: async () => ready('claude', { launchId: 'GENERIC' }) });
  assert.equal(result.launchId, 'GENERIC');
});
