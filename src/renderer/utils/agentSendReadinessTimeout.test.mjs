import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
const require = createRequire(import.meta.url);
const target = require('../../shared/agent-send-target-precondition.cjs');
const source = fs.readFileSync(new URL('./agentSendPreparation.ts', import.meta.url), 'utf8');
const start = source.indexOf('export async function prepareAgentRuntimeForSend(');
const end = source.indexOf('\nexport ', start + 7);
assert.ok(start >= 0 && end > start);
const compiled = transformSync(source.slice(start, end).replace(/^export /, ''), { loader: 'ts' }).code;

test('real send readiness deadline yields exact before-paste failure, not delivery-unknown or a resend', async () => {
  let now = 100;
  let waits = 0, cleanup = 0;
  const context = vm.createContext({
    ...target, Date: { now: () => now }, console: { log() {}, warn() {} },
    isCoordinatedAgentSendCancellationRequested: () => false,
    createAgentReadyWait() {
      waits++;
      return { promise: Promise.resolve().then(() => { now += 31000; }), cancel() { cleanup++; } };
    },
  });
  vm.runInContext(compiled, context);
  await assert.rejects(context.prepareAgentRuntimeForSend({
    tabId: 'T', providerContract: { classifySubmitCapability: () => 'wait', startupGateOwnsComposer: () => false },
    runtime: { toolType: 'codex', label: 'Codex',
      getPresence: async () => ({ status: 'starting', inputReady: false,
        lastNotReady: { reason: 'no-composer-frame' } }),
      resume() { assert.fail('existing startup cannot launch again'); },
      sendPrompt() { assert.fail('timeout must happen before paste'); },
    },
  }), error => {
    assert.equal(error.code, 'agent_send_readiness_timeout');
    assert.equal(error.readinessReason, 'no-composer-frame');
    assert.equal(error.sendReceipt.submitted, false);
    assert.equal(error.sendReceipt.pasteWritten, false);
    assert.equal(error.sendReceipt.enterWritten, false);
    return true;
  });
  assert.equal(waits, 2);
  assert.equal(cleanup, 2);
});
