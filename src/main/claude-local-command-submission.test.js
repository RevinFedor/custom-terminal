'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  submitWithClaudeLocalCommandLifecycle,
} = require('./claude-local-command-submission');

test('local command stays inert through admission and activates only after Enter proof', async () => {
  const calls = [];
  let active = false;

  const result = await submitWithClaudeLocalCommandLifecycle({
    command: '/compact',
    prepare: (command) => {
      calls.push('prepare');
      return { command, offset: 123 };
    },
    submit: async () => {
      calls.push('admission');
      assert.equal(active, false, 'preparation must not make admission see an active command');
      calls.push('enter');
      return { success: true, submitted: true };
    },
    activate: (preparation) => {
      calls.push('activate');
      active = true;
      assert.equal(preparation.offset, 123);
    },
    discard: () => calls.push('discard'),
  });

  assert.equal(result.success, true);
  assert.equal(active, true);
  assert.deepEqual(calls, ['prepare', 'admission', 'enter', 'activate']);
});

test('deferred admission discards preparation without publishing local busy', async () => {
  const calls = [];

  const result = await submitWithClaudeLocalCommandLifecycle({
    command: '/compact',
    prepare: () => {
      calls.push('prepare');
      return { command: '/compact', offset: 456 };
    },
    submit: async () => {
      calls.push('admission-refused');
      return {
        success: false,
        submitted: false,
        deferred: true,
        error: 'claude_input_not_ready',
      };
    },
    activate: () => calls.push('activate'),
    discard: (_preparation, detail) => {
      calls.push('discard:' + detail.reason);
    },
  });

  assert.equal(result.deferred, true);
  assert.deepEqual(calls, [
    'prepare',
    'admission-refused',
    'discard:submit-deferred-before-enter',
  ]);
});

test('submitted-but-unverified result still activates observer', async () => {
  const calls = [];

  const result = await submitWithClaudeLocalCommandLifecycle({
    command: '/compact',
    prepare: () => ({ command: '/compact' }),
    submit: async () => ({
      success: false,
      submitted: true,
      error: 'post_enter_proof_pending',
    }),
    activate: () => calls.push('activate'),
    discard: () => calls.push('discard'),
  });

  assert.equal(result.submitted, true);
  assert.deepEqual(calls, ['activate']);
});

test('throw before submit proof discards inert preparation and rethrows', async () => {
  const calls = [];

  await assert.rejects(
    submitWithClaudeLocalCommandLifecycle({
      command: '/compact',
      prepare: () => ({ command: '/compact' }),
      submit: async () => {
        throw new Error('transport failed');
      },
      activate: () => calls.push('activate'),
      discard: (_preparation, detail) => calls.push('discard:' + detail.reason),
    }),
    /transport failed/,
  );

  assert.deepEqual(calls, ['discard:submit-threw-before-proof']);
});

test('untracked commands pass through without lifecycle side effects', async () => {
  const calls = [];
  const result = await submitWithClaudeLocalCommandLifecycle({
    command: '/model opus',
    prepare: () => null,
    submit: async () => ({ success: true, submitted: true }),
    activate: () => calls.push('activate'),
    discard: () => calls.push('discard'),
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
});
