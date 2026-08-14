'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAUDE_PROVIDER_FATAL_CODES,
  inspectClaudeProviderFatalFrame,
} = require('./claude-provider-fatal-state');

function committed(lines, overrides = {}) {
  return {
    success: true,
    authoritativeFrameCommitted: true,
    liveSynchronizedOutputOpen: false,
    writeSeq: 12,
    flushedSeq: 12,
    lines,
    ...overrides,
  };
}

test('exact red Claude context-limit response is a typed provider failure', () => {
  const result = inspectClaudeProviderFatalFrame(committed([{
    row: 40,
    text: '  ⎿  Context limit reached · /compact or /clear to continue',
    wrapped: false,
    hasNonDefaultFg: true,
  }]));

  assert.equal(result.fatal, true);
  assert.equal(result.code, CLAUDE_PROVIDER_FATAL_CODES.CONTEXT_LIMIT_REACHED);
  assert.equal(result.outcome, 'provider_error');
  assert.equal(result.startRow, 40);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('wrapped current frame is reconstructed before exact fatal classification', () => {
  const result = inspectClaudeProviderFatalFrame(committed([{
    row: 40,
    text: '  ⎿  Context limit reached · /compact or /clear ',
    wrapped: false,
    hasNonDefaultFg: true,
  }, {
    row: 41,
    text: 'to continue · upgrade available',
    wrapped: true,
    hasNonDefaultFg: true,
  }]));

  assert.equal(result.fatal, true);
  assert.equal(result.startRow, 40);
  assert.equal(result.endRow, 41);
});

test('same prose without Claude error styling is not lifecycle proof', () => {
  const result = inspectClaudeProviderFatalFrame(committed([{
    row: 10,
    text: 'Context limit reached · /compact or /clear to continue',
    wrapped: false,
    hasNonDefaultFg: false,
  }]));
  assert.deepEqual(result, {
    fatal: false,
    reason: 'fatal-style-unproven',
    candidateCode: CLAUDE_PROVIDER_FATAL_CODES.CONTEXT_LIMIT_REACHED,
  });
});

test('arbitrary red API or user prose cannot finish a Claude turn', () => {
  assert.equal(inspectClaudeProviderFatalFrame(committed([{
    row: 10,
    text: 'API Error: temporary capacity issue',
    hasNonDefaultFg: true,
  }])).fatal, false);
  assert.equal(inspectClaudeProviderFatalFrame(committed([{
    row: 10,
    text: 'I saw Context limit reached · /compact or /clear to continue yesterday',
    hasNonDefaultFg: true,
  }])).fatal, false);
});

test('open or unflushed screen is never a fatal lifecycle receipt', () => {
  const line = [{
    row: 10,
    text: 'Context limit reached · /compact or /clear to continue',
    hasNonDefaultFg: true,
  }];
  assert.equal(inspectClaudeProviderFatalFrame(committed(line, {
    liveSynchronizedOutputOpen: true,
  })).fatal, false);
  assert.equal(inspectClaudeProviderFatalFrame(committed(line, {
    flushedSeq: 11,
  })).fatal, false);
});
