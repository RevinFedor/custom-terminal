import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import preparation from '../../main/agent-launch-preparation.js';
import { rememberAgentLaunchFence } from './agentLaunchFence.mjs';

let order = 0;
// Controlled IPC/provider replies around the actual registry and renderer
// admission helper. This port is not Main source/CAS/PTY or a ready:true owner.
export function createLaunchFixture(reply = async () => ({ success: true, accepted: true })) {
  const ipcRenderer = new EventEmitter();
  const registry = preparation.createAgentLaunchPreparationRegistry();
  const fence = Object.freeze({ terminalInstanceId: 'fixture-pty', stopRevision: 0, order: ++order });
  rememberAgentLaunchFence('T', fence); // the existing terminal:create ACK consumer
  const calls = [];
  ipcRenderer.invoke = async (channel, request = {}) => {
    calls.push({ channel, request });
    const identity = { ...request, senderId: 1 };
    if (channel === 'agent:begin-launch-intent') {
      assert.deepEqual(request.launchFence, fence, 'first begin retains the observed physical fence');
      const { state } = registry.beginIntent(identity);
      assert.equal(state.revoked, false);
      return { success: true, protocolVersion: 1, launchIntent: registry.intentIdentity(state) };
    }
    if (channel === 'agent:cancel-launch-intent') return registry.cancelIntent(identity, request.reason);
    if (channel === 'agent:finish-launch-intent') return registry.finishIntent(identity);
    if (channel === 'codex:run-command' || channel === 'claude:run-command') {
      const intent = registry.getIntent(request.launchIntent?.token);
      assert.ok(intent && !intent.revoked, 'provider port receives only the original live intent');
      assert.deepEqual(request.launchFence, fence);
      const { launchIntent, launchFence, launchAttempt, ...payload } = request;
      const admitted = registry.beginIntentAttempt(intent.token, launchAttempt, JSON.stringify(payload), 1);
      assert.equal(admitted.allowed, true);
      const result = { ...(await reply(channel, request)), protocolVersion: 1,
        launchIntent, launchFence, launchAttempt };
      registry.settleIntentAttempt(intent.token, launchAttempt, result);
      return result;
    }
    return reply(channel, request);
  };
  return { ipcRenderer, calls, registry, fence };
}

export function assertOnlyFenceObservers(ipcRenderer) {
  assert.deepEqual(ipcRenderer.eventNames().sort(), ['agent:launch-fence-revoked', 'terminal:exit']);
  for (const name of ipcRenderer.eventNames()) assert.equal(ipcRenderer.listenerCount(name), 1,
    'only the shared fence cache observer survives; each intent/readiness listener retires');
}
