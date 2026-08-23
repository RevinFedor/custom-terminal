import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(workspaceDir, '..', '..');
const signals = readFileSync(join(workspaceDir, 'TabSignals.tsx'), 'utf8');
const sidebar = readFileSync(join(workspaceDir, 'TabBar.tsx'), 'utf8');
const pane = readFileSync(join(workspaceDir, 'PaneTabChip.tsx'), 'utf8');
const store = readFileSync(join(rendererDir, 'store/useWorkspaceStore.ts'), 'utf8');
const css = readFileSync(join(rendererDir, 'styles/globals.css'), 'utf8');

test('sidebar and pane chip render the same completion-bell visual contract', () => {
  assert.match(signals, /export function resolveTabCompletionNotificationShadow/);
  assert.match(signals, /export function useTabCompletionNotificationDismissing/);
  assert.match(signals, /export function TabCompletionNotificationAlert/);

  for (const source of [sidebar, pane]) {
    assert.match(source, /resolveTabCompletionNotificationShadow/);
    assert.match(source, /useTabCompletionNotificationDismissing/);
    assert.match(source, /<TabCompletionNotificationAlert/);
  }

  assert.match(pane, /completionNotificationArmed === true/);
  assert.match(pane, /completionNotificationFired === true/);
  assert.match(pane, /const chipBoxShadow = \[completionNotificationShadow, activeStripeShadow\]/);
  assert.match(css, /\.tab-completion-notification-alert \{/);
  assert.match(css, /\.tab-completion-notification-alert--dismiss \{/);
});

test('the two bells keep distinct one-shot and persistent semantics', () => {
  const menuStart = sidebar.indexOf('data-tab-context-action="notify-once"');
  const menuEnd = sidebar.indexOf('data-tab-context-action="notify-persistent"', menuStart);
  const oneShot = sidebar.slice(menuStart, menuEnd);
  const persistent = sidebar.slice(menuEnd, sidebar.indexOf('</Tooltip>', menuEnd));
  assert.match(oneShot, /setTabCompletionNotificationArmed\(projectId, contextMenu\.tabId, !oneShotActive\)/);
  assert.doesNotMatch(oneShot, /title=\{notificationTitle\}/, 'bell help must use the custom tooltip, never native title');
  assert.match(sidebar.slice(sidebar.lastIndexOf('<Tooltip', menuStart), menuEnd), /content=\{notificationTitle\}/);
  assert.match(persistent, /setTabCompletionNotificationPersistent\(projectId, contextMenu\.tabId, !isPersistent\)/);

  const persistentStore = store.slice(
    store.indexOf('setTabCompletionNotificationPersistent: (projectId, tabId, persistent) => {'),
    store.indexOf('\n\n  clearTabCompletionNotification:', store.indexOf('setTabCompletionNotificationPersistent:')),
  );
  assert.match(persistentStore, /tab\.completionNotificationPersistent = true/);
  assert.match(persistentStore, /tab\.completionNotificationArmed = true/);
  assert.match(persistentStore, /saveTabs\(workspace\.projectId, workspace\.tabs\)/);
});
