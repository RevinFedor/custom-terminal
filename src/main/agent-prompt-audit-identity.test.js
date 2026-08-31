'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  agentPromptAuditMatchesHash,
  classifyAgentPromptAuditIdentity,
} = require('./agent-prompt-audit-identity');

test('exact transcript hash remains the operation identity for every provider', () => {
  const proof = classifyAgentPromptAuditIdentity({
    provider: 'claude',
    expectedHash: 'hash-a',
    actualHash: 'hash-a',
    canonicalized: true,
    canonicalReason: 'causal-canonical-claim',
  });
  assert.equal(proof.accepted, true);
  assert.equal(proof.identityHash, 'hash-a');
  assert.equal(proof.actualHash, 'hash-a');
});

test('only a declared provider canonical transformation may differ from the sent hash', () => {
  const accepted = agentPromptAuditMatchesHash('expected-hash', {
    provider: 'codex',
    expectedHash: 'expected-hash',
    actualHash: 'observed-hash',
    canonicalized: true,
    canonicalReason: 'codex_trimmed_boundary_whitespace',
  });
  assert.equal(accepted.matches, true);
  assert.equal(accepted.identityHash, 'expected-hash');
  assert.equal(accepted.actualHash, 'observed-hash');

  const claudeAccepted = agentPromptAuditMatchesHash('expected-hash', {
    provider: 'claude',
    expectedHash: 'expected-hash',
    actualHash: 'provider-transformed-hash',
    canonicalized: true,
    canonicalReason: 'claude_owned_composer_provider_transform',
  });
  assert.equal(claudeAccepted.matches, true);
  assert.equal(claudeAccepted.identityHash, 'expected-hash');
  assert.equal(claudeAccepted.actualHash, 'provider-transformed-hash');

  for (const rejected of [
    { provider: 'codex', canonicalized: false, canonicalReason: 'codex_trimmed_boundary_whitespace' },
    { provider: 'codex', canonicalized: true, canonicalReason: 'unknown-transform' },
    { provider: 'claude', canonicalized: true, canonicalReason: 'codex_trimmed_boundary_whitespace' },
    { provider: 'claude', canonicalized: false, canonicalReason: 'claude_owned_composer_provider_transform' },
    { provider: 'claude', canonicalized: true, canonicalReason: 'causal-canonical-claim' },
  ]) {
    assert.equal(agentPromptAuditMatchesHash('expected-hash', {
      expectedHash: 'expected-hash',
      actualHash: 'observed-hash',
      ...rejected,
    }).matches, false);
  }
});

test('a proven transform still cannot adopt a different operation hash', () => {
  assert.equal(agentPromptAuditMatchesHash('foreign-hash', {
    provider: 'codex',
    expectedHash: 'expected-hash',
    actualHash: 'observed-hash',
    canonicalized: true,
    canonicalReason: 'codex_image_placeholder_canonical',
  }).matches, false);
});

test('the exact Codex CRLF to double-LF transport proof keeps the sent operation identity', () => {
  const proof = agentPromptAuditMatchesHash('windows-prompt-hash', {
    provider: 'codex',
    expectedHash: 'windows-prompt-hash',
    actualHash: 'rollout-double-lf-hash',
    canonicalized: true,
    canonicalReason: 'codex_pty_crlf_materialized_as_double_lf',
  });

  assert.equal(proof.matches, true);
  assert.equal(proof.identityHash, 'windows-prompt-hash');
  assert.equal(proof.actualHash, 'rollout-double-lf-hash');
});
