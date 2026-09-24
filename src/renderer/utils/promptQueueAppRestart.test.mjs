import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appRestartTriggerIsSatisfied,
  normalizeAppRestartTrigger,
} from './promptQueueAppRestart.mjs';

test('app restart trigger ignores renderer reloads inside the same main process', () => {
  const trigger = { kind: 'app-restart', armedInstanceId: 'main-A' };
  assert.equal(appRestartTriggerIsSatisfied(trigger, 'main-A'), false);
});

test('app restart trigger latches after a different main process starts', () => {
  const trigger = { kind: 'app-restart', armedInstanceId: 'main-A' };
  assert.equal(appRestartTriggerIsSatisfied(trigger, 'main-B'), true);
  assert.equal(appRestartTriggerIsSatisfied(trigger, 'main-C'), true,
    'another restart must not erase an already satisfied one-shot condition');
});

test('malformed or unknown runtime identity fails closed', () => {
  assert.equal(normalizeAppRestartTrigger({ kind: 'app-restart', armedInstanceId: '  ' }), null);
  assert.equal(appRestartTriggerIsSatisfied({ kind: 'app-restart', armedInstanceId: 'main-A' }, null), false);
  assert.equal(appRestartTriggerIsSatisfied({ kind: 'timer', seconds: 1 }, 'main-B'), false);
});
