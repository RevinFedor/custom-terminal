const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

let compiled;
async function source() {
  compiled ||= esbuild.build({
    entryPoints: [path.join(__dirname, 'autoCompactRuntime.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'scenario-ports', setup(build) {
      build.onResolve({ filter: /historyAgentRuntimes|agentScenarios|agentSendSettingsContract/ }, (args) => ({ path: args.path, namespace: 'ports' }));
      build.onLoad({ filter: /.*/, namespace: 'ports' }, () => ({ contents: `
        export const getHistoryAgentRuntime = () => ({ toolType: 'codex' });
        export const AGENT_SETTINGS_INTENT_NONE = { kind: 'none' };
        export const sendAgentPromptScenario = (...args) => globalThis.testSend(...args);` }));
    } }],
  }).then((r) => r.outputFiles[0].text);
  return compiled;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function harness({ send, settled = [] } = {}) {
  const ipc = new EventEmitter();
  ipc.invoke = async (channel) => {
    assert.equal(channel, 'agent:get-operational-phase'); return { settled };
  };
  const module = { exports: {} };
  const calls = [];
  vm.runInNewContext(await source(), { module, exports: module.exports, console, setTimeout, clearTimeout,
    window: { require: () => ({ ipcRenderer: ipc }) }, testSend: async (args) => {
      calls.push(args); return send ? send(args) : { success: true, submitted: true };
    },
  });
  const target = { tabId: 'A', provider: 'codex', sessionId: 'S', projectId: 'P', workflowId: 'main' };
  return { run: () => module.exports.executeAutoCompact(target, 'OWN'), ipc, calls,
    outcome: (patch = {}) => ipc.emit('agent:operational-phase', null, {
      tabId: 'A', provider: 'codex', sessionId: 'S', handoffId: 'OWN', active: false, outcome: 'completed', ...patch,
    }),
  };
}
test('Enter acknowledgement and foreign compact do not finish this exact request', async () => {
  const h = await harness(); let done = false;
  const result = h.run().then(() => { done = true; }); await tick();
  assert.equal(done, false);
  h.outcome({ handoffId: 'OTHER' }); h.outcome({ sessionId: 'OTHER' }); h.outcome({ active: true });
  await tick(); assert.equal(done, false);
  h.outcome(); await result;
  assert.equal(h.calls[0].prompt, '/compact'); assert.equal(h.calls[0].requireLive, true);
  assert.equal(h.calls[0].returnDraftOnConflict, false); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('a fast matching completion before send IPC resolves is retained', async () => {
  let resolve;
  const h = await harness({ send: () => new Promise((done) => { resolve = done; }) });
  const result = h.run(); await tick(); h.outcome(); resolve({ submitted: true, success: true });
  await result; assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('cancelled provider operation fails without claiming completion', async () => {
  const h = await harness(); const result = h.run(); await tick();
  h.outcome({ outcome: 'aborted', reason: 'input-escape' });
  await assert.rejects(result, /input-escape/); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('pre-Enter refusal cleans up observer and returns its real cause', async () => {
  const h = await harness({ send: async () => ({ submitted: false, error: 'draft-conflict' }) });
  await assert.rejects(h.run(), /draft-conflict/); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('main settled ledger recovers an outcome missed by renderer event', async () => {
  const h = await harness({ settled: [{ tabId: 'A', provider: 'codex', sessionId: 'S', handoffId: 'OWN', active: false, outcome: 'completed' }] });
  await h.run(); assert.equal(h.calls.length, 1);
});
