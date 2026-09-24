import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlay = fs.readFileSync(path.join(renderer, 'components/Workspace/PromptQueueOverlay.tsx'), 'utf8');
const runner = fs.readFileSync(path.join(renderer, 'hooks/usePromptQueueRunner.ts'), 'utf8');
const main = fs.readFileSync(path.join(renderer, '..', 'main/main.js'), 'utf8');

test('item context menu arms an exact main-process restart condition', () => {
  assert.match(main, /appRuntimeIdentity = Object\.freeze/);
  assert.match(main, /ipcMain\.handle\('app:get-runtime-identity'/);
  assert.match(overlay, /scheduleChipAfterAppRestart/);
  assert.match(overlay, /kind: 'app-restart',[\s\S]{0,100}armedInstanceId: identity\.instanceId/);
  assert.match(overlay, />after app restart</);
  assert.match(overlay, /shouldArmQueueForTrigger\(\{ trigger: head\?\.trigger, isHead: head\?\.id === id \}\)/,
    'the next executable item arms; a later item cannot release the current head');
});

test('restored restart trigger is revisited once workspace and queue hydration finish', () => {
  assert.match(runner, /await getAppRuntimeIdentity\(\)/);
  assert.match(runner, /forceAppRestartTriggers: true/);
  assert.match(runner, /queueItemTriggerCanFire\(head\)/);
  assert.match(runner, /appRestartTriggerIsSatisfied\(item\.trigger, queueAppRuntimeInstanceId\)/);
});
