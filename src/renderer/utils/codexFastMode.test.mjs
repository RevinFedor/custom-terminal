import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCodexServiceTier,
  resolveCodexFastModeState,
} from './codexFastMode.mjs';

const SESSION_ID = '019f8a92-9093-76d1-9865-3dc131fdc209';

test('normalizes the persisted fast spelling to the live priority tier', () => {
  assert.equal(normalizeCodexServiceTier(' Fast '), 'priority');
});

test('shows Fast on only for an exact priority-tier session owner', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: SESSION_ID,
    serviceTierSessionId: SESSION_ID,
    serviceTier: 'priority',
  }), {
    known: true,
    active: true,
    state: 'on',
    serviceTier: 'priority',
  });
});

test('shows Fast off for the exact default tier', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: SESSION_ID,
    serviceTierSessionId: SESSION_ID,
    serviceTier: 'default',
  }), {
    known: true,
    active: false,
    state: 'off',
    serviceTier: 'default',
  });
});

test('accepts an exact launch owner before Codex has a session id', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: 'launch:L2',
    serviceTierSessionId: 'launch:L2',
    serviceTier: 'priority',
  }), {
    known: true,
    active: true,
    state: 'on',
    serviceTier: 'priority',
  });
});

test('keeps an older launch proof neutral under a replacement launch', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: 'launch:L2',
    serviceTierSessionId: 'launch:L1',
    serviceTier: 'priority',
  }), {
    known: false,
    active: false,
    state: 'unknown',
    serviceTier: null,
  });
});

test('does not reuse a proven tier after the tab binds to another session', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: SESSION_ID,
    serviceTierSessionId: '019f8aa7-f7de-7b33-9555-087737667395',
    serviceTier: 'priority',
  }), {
    known: false,
    active: false,
    state: 'unknown',
    serviceTier: null,
  });
});

test('keeps an unknown future service tier neutral instead of inventing Fast off', () => {
  assert.deepEqual(resolveCodexFastModeState({
    currentSessionId: SESSION_ID,
    serviceTierSessionId: SESSION_ID,
    serviceTier: 'flex',
  }), {
    known: false,
    active: false,
    state: 'unknown',
    serviceTier: null,
  });
});
