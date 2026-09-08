'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClaudeSettingsSendRuntime } = require('./claude-settings-send');
const { classifyManualPtyInputAtBoundary } = require('./pty-input-ownership');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function actualPtyQueue() {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('const pasteInflight = new WeakMap();');
  const end = source.indexOf('\nfunction markActivePtySubmit(', start);
  assert(start > 0 && end > start);
  return vm.runInNewContext(source.slice(start, end)
    + '\n({ withPtyWriteLock, ptyActiveWriteOperation })');
}

function harness(overrides = {}) {
  const term = {};
  const queue = actualPtyQueue();
  const events = [];
  let model = 'before';
  let current = true;
  const runtime = createClaudeSettingsSendRuntime({
    getTerminal: () => term,
    withWriteLock: queue.withPtyWriteLock,
    captureRuntime: () => ({ term }),
    isRuntimeCurrent: () => current,
    readConfirmedSettings: async () => ({ success: true, sessionId: 'S', latestSessionId: 'S', model, modelProofAt: 1 }),
    sendCommand: async (_tab, command, options) => queue.withPtyWriteLock(term, async () => {
      if (command.startsWith('/model ')) model = command.slice('/model '.length);
      events.push('setting:' + (command.startsWith('/model ') ? model : command));
      return { success: true };
    }, { kind: 'safe-paste' }, options.ptyWriteOwner),
    readProof: async () => ({ success: true }),
    confirmDialog: async () => ({}),
    retryExactInput: async () => ({ submitted: false }),
    settleClaim: async () => {},
    toggleThinking: async (_tab, thinking) => ({ success: true, thinking }),
    paste: async (_term, content, options) => queue.withPtyWriteLock(term, () => {
      events.push('prompt:' + model + ':' + content);
      return { success: true, submitted: true, actualModel: model };
    }, { kind: 'safe-paste' }, options.ptyWriteOwner),
    ...overrides,
  });
  return { runtime, term, queue, events, cancel: () => { current = false; } };
}

test('actual PTY owner keeps explicit A + prompt together against independent ControlBar/API B', async () => {
  const proofReached = deferred();
  const proofMayFinish = deferred();
  let firstProof = true;
  const h = harness({ readProof: async () => {
    if (firstProof) {
      firstProof = false;
      proofReached.resolve();
      await proofMayFinish.promise;
    }
    return { success: true };
  } });
  const send = h.runtime.sendPrompt({ tabId: 'T', content: 'USER MESSAGE', model: 'A' });
  await proofReached.promise;
  const setting = h.runtime.applySetting({ tabId: 'T', kind: 'model', value: 'B', source: 'api-params' });
  await Promise.resolve();
  assert.deepEqual(h.events, ['setting:A']);
  proofMayFinish.resolve();
  const result = await send;
  await setting;
  assert.equal(result.actualModel, 'A');
  assert.deepEqual(h.events, ['setting:A', 'prompt:A:USER MESSAGE', 'setting:B']);
});

test('model/effort pair is one existing PTY owner against an external settings change', async () => {
  const proofReached = deferred();
  const finishProof = deferred();
  const activity = [];
  let first = true;
  const h = harness({
    readProof: async () => {
      if (first) { first = false; proofReached.resolve(); await finishProof.promise; }
      return { success: true };
    },
    beginSettingsActivity: (_tab, target) => { const token = {}; activity.push(['begin', target]); return token; },
    endSettingsActivity: () => activity.push(['end']),
  });
  const pair = h.runtime.applySettings({ tabId: 'T', model: 'model-A', effort: 'low', source: 'pair' });
  await proofReached.promise;
  const external = h.runtime.applySetting({ tabId: 'T', kind: 'effort', value: 'high', source: 'external' });
  await Promise.resolve();
  assert.deepEqual(h.events, ['setting:model-A']);
  finishProof.resolve();
  const result = await pair;
  await external;
  assert.deepEqual(result.appliedSettings, { model: 'model-A', effort: 'low' });
  assert.deepEqual(h.events, ['setting:model-A', 'setting:/effort low', 'setting:/effort high']);
  assert.equal(activity.filter(event => event[0] === 'begin').length, 2);
  assert.equal(activity.filter(event => event[0] === 'end').length, 2);
});

test('a pair failure reports the proved model without claiming the failed effort or sending a prompt', async () => {
  let proofs = 0;
  const h = harness({ readProof: async () => {
    if (++proofs === 2) throw new Error('effort proof failed');
    return { success: true };
  } });
  await assert.rejects(h.runtime.applySettings({ tabId: 'T', model: 'model-A', effort: 'low', source: 'pair' }), error => {
    assert.deepEqual(error.appliedSettings, { model: 'model-A' });
    return /effort proof failed/.test(error.message);
  });
  assert.equal(h.events.some(event => event.startsWith('prompt:')), false);
  await h.queue.withPtyWriteLock(h.term, () => h.events.push('released'));
  assert.equal(h.events.at(-1), 'released');
});

test('proof failure and cancelled runtime release the original PTY owner without sending a prompt', async () => {
  for (const cancel of [false, true]) {
    const reached = deferred();
    const proceed = deferred();
    const h = harness({ readProof: async () => {
      reached.resolve();
      await proceed.promise;
      if (!cancel) throw new Error('proof failed');
      return { success: true };
    } });
    const send = h.runtime.sendPrompt({ tabId: 'T', content: 'NEVER SEND', model: 'A' });
    await reached.promise;
    const next = h.queue.withPtyWriteLock(h.term, () => h.events.push('next-owner'));
    if (cancel) h.cancel();
    proceed.resolve();
    const refusal = await send;
    assert.equal(refusal.submitted, false);
    assert.equal(refusal.pasteWritten, false);
    assert.equal(refusal.enterWritten, false);
    assert.match(refusal.error, cancel ? /runtime_changed/ : /proof failed/);
    await next;
    assert.deepEqual(h.events, ['setting:A', 'next-owner']);
  }
});

test('a token belongs to one exact active owner and expires at outer completion', async () => {
  const { withPtyWriteLock } = actualPtyQueue();
  const term = {};
  let oldOwner;
  await withPtyWriteLock(term, async owner => {
    oldOwner = owner;
    assert.equal(await withPtyWriteLock(term, () => 12, null, owner), 12);
    await assert.rejects(withPtyWriteLock({}, () => assert.fail('wrong PTY'), null, owner), /owner_expired/);
  });
  await assert.rejects(withPtyWriteLock(term, () => assert.fail('expired owner'), null, oldOwner), /owner_expired/);
  await withPtyWriteLock(term, async () => {
    await assert.rejects(withPtyWriteLock(term, () => assert.fail('borrow new owner'), null, oldOwner), /owner_expired/);
  });
});

test('post-Enter confirmation waits outside the settings/send PTY owner', async () => {
  const auditStarted = deferred();
  const audit = deferred();
  const h = harness({ paste: async () => ({ finishAfterPtyWrite: async () => {
    auditStarted.resolve();
    await audit.promise;
    return { success: true, submitted: true };
  } }) });
  const send = h.runtime.sendPrompt({ tabId: 'T', content: 'MESSAGE', model: 'A' });
  await auditStarted.promise;
  const setting = await h.runtime.applySetting({ tabId: 'T', kind: 'model', value: 'B', source: 'control-bar' });
  assert.equal(setting.value, 'B');
  audit.resolve();
  assert.equal((await send).submitted, true);
});

test('an exception after invoking paste does not fabricate a pre-Enter refusal', async () => {
  const h = harness({ paste: async () => { throw new Error('transport reply lost'); } });
  await assert.rejects(h.runtime.sendPrompt({ tabId: 'T', content: 'MESSAGE', model: 'A' }),
    /transport reply lost/);
});

test('queued physical Enter is suppressed only after the final user prompt, not a settings slash command', async () => {
  for (const submitted of [true, false, null]) {
    const reached = deferred();
    const proceed = deferred();
    const h = harness({ paste: async () => {
      reached.resolve();
      await proceed.promise;
      return { submitted, enterWritten: submitted === null };
    } });
    const send = h.runtime.sendPrompt({ tabId: 'T', content: 'MESSAGE', model: 'A' });
    await reached.promise;
    const precedingOperation = h.queue.ptyActiveWriteOperation.get(h.term);
    const manual = h.queue.withPtyWriteLock(h.term, () => classifyManualPtyInputAtBoundary({
      data: '\r', precedingOperation,
    }));
    proceed.resolve();
    await send;
    assert.equal((await manual).action, submitted !== false ? 'suppress' : 'deliver');
  }
});

test('explicit settings and all independent renderer settings use the shared main scenario', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/claudePtyActions.ts'), 'utf8');
  const send = source.slice(source.indexOf('export async function sendClaudePtyPrompt('), source.indexOf('export function interruptClaudePtyTurn('));
  assert.match(send, /invoke\('claude:send-prompt-with-settings',[\s\S]*model: options.model,[\s\S]*effort: options.effort/);
  assert.doesNotMatch(send, /await applyClaudePtySetting\(/);
  assert.match(source, /invoke\('claude:apply-setting', \{ tabId, kind, value, source \}\)/);
});
