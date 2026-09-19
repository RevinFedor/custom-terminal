import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import sendTargetContract from '../../shared/agent-send-target-precondition.cjs';

const source = fs.readFileSync(new URL('./agentSendPreparation.ts', import.meta.url), 'utf8');
const start = source.indexOf('export async function prepareAgentRuntimeForSend(');
const end = source.indexOf('\nexport ', start + 7);
assert.ok(start >= 0 && end > start);
const compiled = transformSync(source.slice(start, end).replace(/^export /, ''), { loader: 'ts' }).code;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function harness() {
  let now = 0;
  let presence = { status: 'starting', inputReady: false, sessionId: 'S',
    sendTarget: { toolType: 'claude', sessionId: 'S', launchId: 'L', lifecycleGeneration: 'G' } };
  const gate = deferred();
  let waitCancels = 0;
  const context = vm.createContext({
    ...sendTargetContract,
    Date: { now: () => now },
    console: { log() {}, warn() {} },
    terminalRegistry: { get: () => ({}) },
    isCoordinatedAgentSendCancellationRequested: () => false,
    createAgentReadyWait: () => ({ promise: new Promise(() => {}), cancel() { waitCancels += 1; } }),
  });
  vm.runInContext(compiled, context);
  const runtime = {
    toolType: 'claude', label: 'Claude',
    getPresence: async () => ({ ...presence }),
    resume: () => assert.fail('the accepted launch must not be repeated'),
  };
  const providerContract = {
    classifySubmitCapability: current => current?.status === 'active' && current?.inputReady
      ? 'direct'
      : 'blocked',
    startupGateOwnsComposer: current => current?.status === 'starting',
    waitForStartupGate: () => gate.promise,
  };
  return {
    start: () => context.prepareAgentRuntimeForSend({
      tabId: 'T', runtime, providerContract, sessionId: 'S', requestedStatusAtSend: 'starting',
    }),
    expireLocalDeadline: () => { now = 60_000; },
    ready: () => { presence = { ...presence, status: 'active', inputReady: true }; gate.resolve(); },
    fail: error => gate.reject(error),
    get waitCancels() { return waitCancels; },
  };
}

test('Claude Send survives a 60s local clock while the exact main startup gate is pending', async () => {
  const h = harness();
  const result = h.start();
  await tick();
  h.expireLocalDeadline();
  await tick();
  h.ready();
  assert.equal((await result).submitCapability, 'direct');
  assert.ok(h.waitCancels > 0);
});

test('exact main startup failure still stops Send before provider input', async () => {
  const h = harness();
  const result = h.start();
  await tick();
  h.fail(Object.assign(new Error('Claude model limit reached'), { code: 'claude_rate_limit' }));
  await assert.rejects(result, /model limit/);
  assert.ok(h.waitCancels > 0);
});
