'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCodexRewindMessageProof,
  hashCodexRewindTargetText,
} = require('./codex-rewind-target-proof');

test('native Rewind target proof uses one durable SHA-256 contract', () => {
  const boundaryHash = hashCodexRewindTargetText('  target prompt  ');
  const projected = buildCodexRewindMessageProof({
    text: 'target prompt',
    images: ['/tmp/image.png'],
    textElements: [{ type: 'text', text: 'target prompt' }],
  });

  assert.match(boundaryHash, /^[a-f0-9]{64}$/);
  assert.equal(projected.textHash, boundaryHash);
  assert.match(projected.signature, /^[a-f0-9]{64}$/);
});

test('message signature distinguishes non-text prompt identity', () => {
  const first = buildCodexRewindMessageProof({
    text: 'same text',
    images: ['/tmp/first.png'],
  });
  const second = buildCodexRewindMessageProof({
    text: 'same text',
    images: ['/tmp/second.png'],
  });

  assert.equal(first.textHash, second.textHash);
  assert.notEqual(first.signature, second.signature);
});
