import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTabProviderSnapshot, projectTabProviderSnapshot, codexSettingsIntentIsWaiting, codexSettingsSelection, settingsPresentation } from './agentSettingsPresentation.mjs';

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

test('an explicit choice while Fork is starting stays selected across late inherited observations', () => {
  const providerState = { codexSettingsIntentRevision: 1, codexSettingsIntentModel: 'chosen', codexSettingsIntentEffort: 'high' };
  const select = state => codexSettingsSelection({ isCommandRunning: true, providerState: state,
    effectiveSettings: { model: 'inherited', effort: 'max' } });
  assert.deepEqual(select(providerState), { model: 'chosen', effort: 'high' });
  assert.equal(codexSettingsIntentIsWaiting({ isCodex: true, isCommandRunning: true, providerState }), true);
  const older = mergeTabProviderSnapshot({ tabId: 'T', state: providerState }, 'T', {}).state;
  assert.deepEqual(select(older), { model: 'chosen', effort: 'high' });
  const applied = { ...providerState, codexSettingsIntentAppliedRevision: 1 };
  assert.deepEqual(select(applied), { model: 'inherited', effort: 'max' }, 'settled selection again follows actual proof, not an eternal desired override');
  assert.deepEqual(select({ ...providerState, codexSettingsIntentError: 'failed' }), { model: 'inherited', effort: 'max' });
});

test('source projection uses Main revision ordering before another Fork captures the choice', () => {
  const tab = { providerState: { codexSettingsIntentRevision: 2, codexSettingsIntentModel: 'B', codexSettingsIntentEffort: 'high' } };
  const tabs = new Map([['T', tab]]), projects = new Map([['P', { tabs }]]);
  assert.equal(projectTabProviderSnapshot(projects, 'T', { codexSettingsIntentRevision: 1, codexSettingsIntentModel: 'A' }), true);
  assert.equal(tab.providerState.codexSettingsIntentModel, 'B');
  assert.equal(projectTabProviderSnapshot(projects, 'gone', {}), false);
});

test('replaceable queued intent is still pending but does not pretend a physical write is busy', () => {
  const providerState = { codexSettingsIntentRevision: 19, codexSettingsIntentAppliedRevision: 18 };
  assert.equal(codexSettingsIntentIsWaiting({ isCodex: true, isCommandRunning: true, providerState }), true);
  assert.deepEqual(settingsPresentation({ intentWaiting: true, intentTarget: 'model',
    replaceQueuedIntent: true, activity: { busy: false } }), { busy: false, target: 'model' });
  assert.deepEqual(settingsPresentation({ intentWaiting: true, intentTarget: 'model',
    replaceQueuedIntent: true, activity: { busy: true, target: 'effort' } }), { busy: true, target: 'effort' });
  assert.deepEqual(settingsPresentation({ intentWaiting: true, localBusy: true, localTarget: 'quick',
    replaceQueuedIntent: true, activity: { busy: false } }), { busy: true, target: 'quick' });
});
