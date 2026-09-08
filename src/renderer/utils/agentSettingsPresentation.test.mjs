import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTabProviderSnapshot, codexSettingsIntentIsWaiting, settingsPresentation } from './agentSettingsPresentation.mjs';

test('provider revisions belong to a tab, not to a reused ControlBar component', () => {
  const previous = { tabId: 'A', state: { codexSettingsIntentRevision: 99, codexSettingsIntentEffort: 'ultra' } };
  const next = mergeTabProviderSnapshot(previous, 'B', { codexSettingsIntentRevision: 1, codexSettingsIntentEffort: 'max' });
  assert.equal(next.state.codexSettingsIntentEffort, 'max');
  assert.equal(next.state.codexSettingsIntentRevision, 1);
});

test('late save reply cannot clear a newer selection or its applied proof', () => {
  const applied = { tabId: 'T', state: { codexSettingsIntentRevision: 4, codexSettingsIntentEffort: 'max',
    codexSettingsIntentAppliedRevision: 4, codexSettingsIntentAppliedOwnerId: 'S' } };
  assert.equal(mergeTabProviderSnapshot(applied, 'T', { codexSettingsIntentRevision: 3, codexSettingsIntentEffort: 'ultra' })
    .state.codexSettingsIntentEffort, 'max');
  const next = mergeTabProviderSnapshot(applied, 'T', { codexSettingsIntentRevision: 4, codexSettingsIntentEffort: 'max' });
  assert.equal(next.state.codexSettingsIntentAppliedRevision, 4);
});

test('saved intent is pending, applied proof settles; stopped choices do not spin forever', () => {
  const args = { isCodex: true, isCommandRunning: true,
    providerState: { codexSettingsIntentRevision: 4, codexSettingsIntentAppliedRevision: 3 } };
  assert.equal(codexSettingsIntentIsWaiting(args), true);
  assert.equal(codexSettingsIntentIsWaiting({ ...args, isCommandRunning: false }), false);
  assert.equal(codexSettingsIntentIsWaiting({ ...args, providerState: { ...args.providerState, codexSettingsIntentError: 'not-confirmed' } }), false);
  assert.equal(codexSettingsIntentIsWaiting({ ...args, providerState: { ...args.providerState, codexSettingsIntentAppliedRevision: 4 } }), false);
});

test('empty input, paste end and component unmount are not application completion', () => {
  const active = { busy: true, target: 'effort' };
  assert.deepEqual(settingsPresentation({ localBusy: false, activity: active }), { busy: true, target: 'effort' });
  assert.deepEqual(settingsPresentation({ localBusy: true, localTarget: 'model', activity: active }), { busy: true, target: 'model' });
  assert.deepEqual(settingsPresentation({ activity: { busy: false }, intentWaiting: true, intentTarget: 'quick' }), { busy: true, target: 'quick' });
});
