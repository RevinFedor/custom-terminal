'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { decideCodexBinaryOverride } = require('./codex-semantic-channel');

const CODEX_BIN = '/home/u/.noted-terminal/bin/codex';
const HOST_BIN = '/home/u/.noted-terminal/bin/codex-code-mode-host';

function fileExistsIn(paths) {
  const present = new Set(paths);
  return (candidate) => present.has(candidate);
}

test('patched binary is used when its code-mode host sits beside it', () => {
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([CODEX_BIN, HOST_BIN]),
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.hostPath, HOST_BIN);
});

test('patched binary is skipped when the code-mode host is missing', () => {
  // Codex >= 0.147 resolves the host relative to its own executable. Exporting
  // a lone patched binary makes every Code Mode tool call fail closed with
  // "host executable was not found", and models the server marks
  // `code_mode_only` have no direct-tool fallback — the whole tab dies.
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([CODEX_BIN]),
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'missing-code-mode-host');
  assert.equal(decision.hostPath, HOST_BIN, 'reports the exact path the installer must fill');
});

test('a working session outranks the semantic side-channel', () => {
  // Regression guard for the trade-off itself: losing Timeline enrichment is
  // recoverable, an unusable Codex tab is not.
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([CODEX_BIN]),
  });

  assert.equal(decision.enabled, false);
});

test('no override without a semantic channel', () => {
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: false,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([CODEX_BIN, HOST_BIN]),
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'no-semantic-channel');
});

test('no override when the patched codex itself is absent', () => {
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([]),
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'missing-codex-binary');
});

test('windows keeps the stock Codex until a named-pipe producer exists', () => {
  const codexBin = path.join('C:\\noted', 'bin', 'codex.exe');
  const hostBin = path.join('C:\\noted', 'bin', 'codex-code-mode-host.exe');

  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: codexBin,
    platform: 'win32',
    fileExists: fileExistsIn([codexBin, hostBin]),
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'unsupported-platform');
  assert.equal(decision.hostPath, null);
});

test('an unrelated host elsewhere on PATH does not satisfy the sibling rule', () => {
  // The CLI never searches PATH for the host, so a system-wide copy is not a
  // substitute for the sibling it actually spawns.
  const decision = decideCodexBinaryOverride({
    hasSemanticChannel: true,
    codexBinPath: CODEX_BIN,
    platform: 'darwin',
    fileExists: fileExistsIn([CODEX_BIN, '/usr/local/bin/codex-code-mode-host']),
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'missing-code-mode-host');
});
