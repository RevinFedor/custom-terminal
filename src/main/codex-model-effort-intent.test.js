'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  codexModelEffortIntentApplicationProven,
  nextCodexModelEffortIntent,
  planCodexModelEffortIntentOwnerHandoff,
  planCodexModelEffortIntentReconcile,
} = require('./codex-model-effort-intent');

test('a proven native pair settles its intent even when restoring the user draft failed', () => {
  const intent = { model: 'gpt-6-astra', effort: 'max' };
  const result = {
    ...intent, success: false, applied: true, draftRestoreFailed: true,
    applicationProofSource: 'config:verified-write',
    draftTransfer: { id: 'RECOVERY', text: 'full original input' },
  };
  assert.equal(codexModelEffortIntentApplicationProven(intent, result), true);
  for (const change of [
    { applied: false },
    { applicationProofSource: '' },
    { applicationProofSource: 'tab-or-explicit' },
    { model: 'other-model' },
    { effort: 'high' },
    { effortSkipped: true },
  ]) assert.equal(codexModelEffortIntentApplicationProven(intent, { ...result, ...change }), false);
  assert.equal(codexModelEffortIntentApplicationProven(intent, { ...intent, success: true }), false,
    'success plus caller-shaped fields alone is not native application proof');
});

test('actual background reconciliation publishes recovery and does not rerun a proven picker', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function scheduleCodexModelEffortIntentReconcile(');
  const end = source.indexOf("\nipcMain.handle('codex:set-model-effort-intent'", start);
  for (const proven of [true, false]) {
    const events = [];
    const presentation = [];
    const intent = { model: 'gpt-6-astra', effort: 'max', revision: 4, providerState: {} };
    const transfer = { id: 'codex-native-stash:C1', tabId: 'T', text: 'full original', images: 1, imagePaths: [{ id: 1, path: '/durable/image.png' }] };
    let pickerCalls = 0;
    const schedule = vm.runInNewContext(source.slice(start, end) + '\nscheduleCodexModelEffortIntentReconcile', {
      codexModelEffortIntentApplicationProven,
      planCodexModelEffortIntentReconcile,
      codexModelEffortIntentReconcileInflight: new Map(),
      codexModelEffortIntentReconcileRequested: new Set(),
      getCodexModelEffortIntentRecord: () => intent,
      updateCodexSettingsIntentError: (_tab, revision, error) => {
        assert.equal(revision, intent.revision);
        intent.providerState.codexSettingsIntentError = error;
      },
      getCodexWriterProofSnapshot: () => ({ sessionId: 'writer' }),
      getCodexProvisionalSettingsSnapshot: () => null,
      terminalCommandState: new Map([['T', { isRunning: true }]]),
      codexHasLivePtySubmitEvidence: () => true,
      isCodexTuiEffectivelyReady: () => true,
      mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (event, payload) => {
        events.push({ event, payload });
        if (event === 'codex:model-effort-intent-applied') presentation.push('applied-values');
      } } },
      broadcastProviderState: () => presentation.push('release-pending'),
      executeCodexSelectModelEffortRequest: async () => {
        pickerCalls++;
        return { ...intent, success: false, applied: proven, draftRestoreFailed: true,
          applicationProofSource: proven ? 'config:verified-write' : null,
          draftTransfer: transfer, error: 'restore failed' };
      },
      markCodexModelEffortIntentApplied: (_tab, _intent, owner, _source, options) => {
        assert.equal(options.publish, false, 'do not unlock before publishing actual values');
        intent.appliedRevision = intent.revision;
        intent.appliedOwnerId = owner;
        return { applied: true, providerState: {} };
      },
      console: { log() {}, warn() {} },
    });
    const result = await schedule('T');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, proven ? 'codex:model-effort-intent-applied' : 'codex:model-effort-intent-deferred');
    assert.equal(events[0].payload.result.draftTransfer, transfer);
    assert.equal(result.success, false, 'settings proof does not conceal the input restoration error');
    assert.equal(result.intentPending, !proven);
    if (proven) {
      assert.deepEqual(presentation, ['applied-values', 'release-pending']);
      assert.equal((await schedule('T')).applied, true);
      assert.equal(pickerCalls, 1, 'next readiness edge must not open the already-applied picker again');
    }
  }
});

test('model/effort intent is a complete revisioned last-click-wins pair', () => {
  assert.deepEqual(nextCodexModelEffortIntent({ model: 'sol', effort: '' }), {
    valid: false,
    reason: 'model-effort-intent-incomplete',
  });
  assert.deepEqual(nextCodexModelEffortIntent({
    currentModel: 'terra',
    currentEffort: 'max',
    currentRevision: 3,
    model: 'sol',
    effort: 'MAX',
  }), {
    valid: true,
    changed: true,
    model: 'sol',
    effort: 'max',
    revision: 4,
  });
  assert.equal(nextCodexModelEffortIntent({
    currentModel: 'sol',
    currentEffort: 'max',
    currentRevision: 4,
    model: 'sol',
    effort: 'max',
  }).revision, 4);
});

test('starting queues until an exact launch or writer owner is ready', () => {
  const base = { model: 'sol', effort: 'max', revision: 4 };
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: true,
  }).reason, 'writer-not-adopted');
  assert.deepEqual(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'launch:fresh-1',
  }), {
    action: 'apply',
    reason: 'intent-awaits-current-writer',
    model: 'sol',
    effort: 'max',
    revision: 4,
    writerOwnerId: 'launch:fresh-1',
  });
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: false,
    writerOwnerId: 'writer-a',
  }).reason, 'tui-not-ready');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-a',
  }).action, 'apply');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    appliedRevision: 4,
    appliedOwnerId: 'writer-a',
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-a',
  }).action, 'settled');
  assert.equal(planCodexModelEffortIntentReconcile({
    ...base,
    appliedRevision: 4,
    appliedOwnerId: 'writer-a',
    processRunning: true,
    tuiReady: true,
    writerOwnerId: 'writer-b',
  }).action, 'apply', 'a replacement writer must prove/apply the pair again');
});

test('an applied launch intent transfers to its exact first writer without a second picker', () => {
  const base = {
    model: 'gpt-5.6-sol',
    effort: 'max',
    revision: 7,
    appliedRevision: 7,
    appliedOwnerId: 'launch:launch-7',
    launchOwnerId: 'launch:launch-7',
    writerOwnerId: 'writer-7',
    provenModel: 'gpt-5.6-sol',
    provenEffort: 'max',
  };
  assert.deepEqual(planCodexModelEffortIntentOwnerHandoff(base), {
    transfer: true,
    reason: 'exact-launch-owner-adopted-by-writer',
    fromOwnerId: 'launch:launch-7',
    toOwnerId: 'writer-7',
  });
  assert.equal(planCodexModelEffortIntentOwnerHandoff({
    ...base,
    provenEffort: 'xhigh',
  }).transfer, false);
  assert.equal(planCodexModelEffortIntentOwnerHandoff({
    ...base,
    appliedRevision: 6,
  }).transfer, false);
});
