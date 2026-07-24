import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stopAiBeforeTerminalKill,
} from './terminalCloseLifecycle.mjs';

test('Codex close never hard-kills before a structured Stop lookup beyond the old 1.8s boundary settles', async () => {
  let finishStop;
  let stopStarted = false;
  let killed = false;
  const delayedStop = new Promise((resolve) => {
    finishStop = resolve;
  });

  const closePromise = stopAiBeforeTerminalKill({
    shouldStopAiProcess: true,
    stopAiProcess: async () => {
      stopStarted = true;
      return delayedStop;
    },
    killTerminal: () => {
      killed = true;
    },
  });

  await Promise.resolve();
  assert.equal(stopStarted, true);
  assert.equal(killed, false, 'legacy 1.8s timeout cannot race the in-flight process lookup');

  finishStop({
    success: true,
    processName: 'codex',
    lookupDurationMs: 2001,
    graceful: 'ctrl-c',
  });
  const result = await closePromise;

  assert.equal(result.stopResult.lookupDurationMs, 2001);
  assert.equal(result.terminalKilled, true);
  assert.equal(killed, true);
});

test('structured Stop failure preserves the PTY and blocks tab close hard-kill', async () => {
  let killed = false;
  const result = await stopAiBeforeTerminalKill({
    shouldStopAiProcess: true,
    stopAiProcess: async () => ({
      success: false,
      error: 'process_lookup_failed',
      lookupUnknown: true,
    }),
    killTerminal: () => {
      killed = true;
    },
  });

  assert.equal(result.stopResult.lookupUnknown, true);
  assert.equal(result.terminalKilled, false);
  assert.equal(killed, false);
});

test('thrown Stop failure preserves the PTY', async () => {
  let killed = false;
  const result = await stopAiBeforeTerminalKill({
    shouldStopAiProcess: true,
    stopAiProcess: async () => {
      throw new Error('ipc unavailable');
    },
    killTerminal: () => {
      killed = true;
    },
  });

  assert.equal(result.stopError.message, 'ipc unavailable');
  assert.equal(result.terminalKilled, false);
  assert.equal(killed, false);
});

test('idle terminal without an AI Stop requirement still closes immediately', async () => {
  let killed = false;
  const result = await stopAiBeforeTerminalKill({
    shouldStopAiProcess: false,
    killTerminal: () => {
      killed = true;
    },
  });

  assert.equal(result.terminalKilled, true);
  assert.equal(killed, true);
});
