'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const sourcePath = path.join(__dirname, 'agentSendSettingsContract.ts');

async function loadContract() {
  const built = await esbuild.build({
    entryPoints: [sourcePath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  const loaded = new Module(path.join(__dirname, 'agent-send-settings-contract.cjs'), module);
  loaded.filename = path.join(__dirname, 'agent-send-settings-contract.cjs');
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(built.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}

let contract;
test.before(async () => { contract = await loadContract(); });

test('external loose values cross the boundary as one explicit intent', () => {
  assert.deepEqual(contract.createAgentSettingsIntent({}), { kind: 'none' });
  assert.deepEqual(contract.createAgentSettingsIntent({
    provider: 'claude',
    model: ' claude-opus-5[1m] ',
    effort: 'max',
    thinking: 'adaptive',
  }), {
    kind: 'explicit-change',
    model: 'claude-opus-5[1m]',
    effort: 'max',
    thinking: 'adaptive',
  });
  assert.deepEqual(contract.createAgentSettingsIntent({
    provider: 'codex',
    thinking: 'adaptive',
  }), { kind: 'none' });
  assert.deepEqual(contract.createAgentSettingsIntent({
    provider: 'claude',
    thinking: 'none',
  }), { kind: 'none' });
  assert.deepEqual(contract.createAgentSettingsIntent({
    provider: 'claude',
    model: 'opus',
    thinking: 'NONE',
  }), { kind: 'explicit-change', model: 'opus' });
});

test('runtime proof and launch settings remain different restart variants', () => {
  assert.deepEqual(contract.createAgentHistoryRestartSettings({
    source: 'exact-session-proof',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    ownerKind: 'writer',
    ownerId: 'writer-a',
    proofAt: 123,
  }), {
    kind: 'codex-runtime-proof',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    owner: { kind: 'writer', id: 'writer-a' },
    proofAt: 123,
  });
  assert.deepEqual(contract.createAgentHistoryRestartSettings({
    source: 'launch-intent',
    model: 'gpt-5.6-sol',
    effort: 'max',
    modelSource: 'global',
    effortSource: 'tab',
  }), {
    kind: 'codex-launch-settings',
    model: 'gpt-5.6-sol',
    effort: 'max',
    modelSource: 'global',
    effortSource: 'tab',
  });
  assert.equal(contract.createAgentHistoryRestartSettings({
    source: 'launch-intent',
    model: 'gpt-5.6-sol',
  }), undefined);
  assert.deepEqual(contract.createAgentHistoryRestartSettings({
    source: 'unavailable',
    reason: 'model-migration-pending',
  }), {
    kind: 'codex-settings-unavailable',
    reason: 'model-migration-pending',
  });
});

test('cross-wired settings are rejected before runtime work', () => {
  assert.match(contract.agentSendSettingsContractError({
    toolType: 'codex',
    settingsIntent: { kind: 'none' },
    historyRestartSettings: {
      kind: 'codex-launch-settings',
      model: 'gpt-5.6-sol',
      effort: 'max',
    },
  }), /only valid for record-without-reply/);
  assert.match(contract.agentSendSettingsContractError({
    toolType: 'claude',
    recordWithoutReply: true,
    settingsIntent: { kind: 'explicit-change', model: 'opus' },
  }), /cannot also request/);
  assert.match(contract.agentSendSettingsContractError({
    toolType: 'codex',
    settingsIntent: { kind: 'explicit-change' },
  }), /empty/);
  assert.match(contract.agentSendSettingsContractError({
    toolType: 'codex',
    recordWithoutReply: true,
    settingsIntent: { kind: 'none' },
    historyRestartSettings: {
      kind: 'codex-runtime-proof',
      model: 'gpt-5.6-sol',
      effort: 'max',
      owner: { kind: 'writer', id: '' },
      proofAt: 0,
    },
  }), /incomplete/);
  assert.match(contract.agentSendSettingsContractError({
    toolType: 'claude',
    settingsIntent: { kind: 'explicit-change', thinking: 'none' },
  }), /invalid/);
});

test('main stop-captured settings require complete generation authority', () => {
  const proof = {
    kind: 'codex-stop-captured-settings',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    scope: 'conversation-only',
    owner: { kind: 'writer', id: 'writer-a' },
    observedAt: 100,
    authority: {
      lifecycleGeneration: 'lifecycle-a',
      runSeq: 1,
      inputRevision: 0,
      mirrorGeneration: 'mirror-a',
      committedFrameGeneration: 1,
      writeSeq: 2,
    },
  };
  assert.equal(contract.isCodexStopCapturedSettingsProof(proof), true);
  assert.equal(contract.isCodexStopCapturedSettingsProof({
    ...proof,
    authority: { ...proof.authority, inputRevision: -1 },
  }), false);
});
