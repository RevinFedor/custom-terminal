import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceStore = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');

function block(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('tab completion bell waits when own loader ends before orchestration completion', () => {
  const setAiBusy = block(
    workspaceStore,
    'setAiBusy: (tabId, busy, reason) => {',
    '\n\n  setSdkProcessAlive:',
  );
  const blockedAt = setAiBusy.indexOf('isOrchestrationCompletionBlocked(tabId)');
  const settleAt = setAiBusy.indexOf('settleTabCompletionNotification({');

  assert.ok(blockedAt >= 0 && settleAt > blockedAt);
  assert.match(setAiBusy, /reason=orchestration-blocked/);
});

test('purple inherited activity rearms persistent bells and clears stale fired state', () => {
  const orchestrationState = block(
    workspaceStore,
    'applyTabCompletionOrchestrationState: (tabId, phase) => {',
    '\n\n  setTabRestartAfterTarget:',
  );

  assert.match(orchestrationState, /phase === 'active'/);
  assert.match(orchestrationState, /completionNotificationPersistent && !tab\.completionNotificationArmed/);
  assert.match(orchestrationState, /delete tab\.completionNotificationFired/);
  assert.match(app, /inheritedBusyTabIds[\s\S]*applyTabCompletionOrchestrationState\(tabId, 'active'\)/);
});

test('only a successful orchestration release emits the existing completion notification', () => {
  const orchestrationState = block(
    workspaceStore,
    'applyTabCompletionOrchestrationState: (tabId, phase) => {',
    '\n\n  setTabRestartAfterTarget:',
  );

  assert.match(app, /releaseKind === 'success'[\s\S]*applyTabCompletionOrchestrationState\(change\.sourceTabId, 'success'\)/);
  assert.match(app, /releaseKind === 'abnormal'[\s\S]*applyTabCompletionOrchestrationState\(change\.sourceTabId, 'abnormal'\)/);
  assert.match(orchestrationState, /successful: phase === 'success'/);
  assert.match(orchestrationState, /if \(settled\.detail\) emitTabCompletionNotification\(settled\.detail\)/);
});
