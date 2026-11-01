// The Send-scoped startup wait must treat a FAILED transaction as settled.
//
// The Send guard stopped refusing on a failed startup setting, but the same
// Send then called `waitStartupGate()` → `waitForClaudeStartupDefaultsReady`,
// which throws on `status === 'failed'`. So the tab still refused input, only
// one step later. The earlier test replaced this wait with a no-op stub and
// could not see it; this one runs the REAL gate cache and wait modules, with
// only the Electron IPC and the terminal registry replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const here = new URL('.', import.meta.url).pathname;

function loadWaitModule(mainGate) {
  // Bundle the real modules; only the leaf collaborators are external.
  const out = buildSync({
    entryPoints: [here + 'claudeStartupDefaultsReady.ts'],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['./terminalRegistry'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const warnings = [];
  const ipcRenderer = {
    invoke: async (channel) => {
      if (channel === 'claude:get-startup-defaults-gate') {
        return { success: true, revision: 1, gate: mainGate };
      }
      if (channel === 'claude:copy-input') return { success: true, text: '' };
      if (channel === 'claude:get-presence') return { status: 'active', inputReady: true };
      return null;
    },
    on() {}, removeListener() {}, send() {},
  };
  const window = {
    require: () => ({ ipcRenderer }),
    dispatchEvent() {},
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, window, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {} },
    setTimeout, clearTimeout,
    require: (id) => id === './terminalRegistry'
      ? { terminalRegistry: { getVisibleText: () => '' } }
      : require(id),
  });
  vm.runInContext(out, context);
  return { api: module.exports, warnings };
}

const gate = (status, extra = {}) => ({
  status, generation: 'L', attemptId: 'A', revision: 1,
  error: status === 'failed' ? "API error: 429 This request would exceed your account's rate limit. · model not changed" : null,
  errorCode: status === 'failed' ? 'claude_rate_limit' : null,
  failedCommand: '/model claude-opus-5[1m]', proofOutcome: status === 'failed' ? 'found' : null,
  ...extra,
});

test('a FAILED startup transaction lets the waiting Send continue', async () => {
  const { api, warnings } = loadWaitModule(gate('failed'));
  await assert.doesNotReject(api.waitForClaudeStartupDefaultsReadyUntilSettled('T', 'agent-send'),
    'the Send must not be refused over a setting that simply was not applied');
  assert.ok(warnings.some(w => w.includes('settled=failed action=continue-without-setting')),
    'the decision is logged');
});

test('the bounded diagnostic wait still reports the failure (unchanged)', async () => {
  const { api } = loadWaitModule(gate('failed'));
  await assert.rejects(api.waitForClaudeStartupDefaultsReadyWithVisibleFallback('T', 1000, 'diag'),
    /429|model not changed/);
});

test('a ready transaction resolves as before', async () => {
  const { api } = loadWaitModule(gate('ready'));
  await assert.doesNotReject(api.waitForClaudeStartupDefaultsReadyUntilSettled('T', 'agent-send'));
});

test('the Send contract really uses this settled wait', () => {
  const contract = fs.readFileSync(here + 'agentSendProviderContract.ts', 'utf8');
  assert.ok(contract.includes('waitForClaudeStartupDefaultsReadyUntilSettled(tabId, purpose)'));
});
