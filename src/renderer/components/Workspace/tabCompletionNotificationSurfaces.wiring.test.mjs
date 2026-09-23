import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

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

test('turning off persistent notifications also cancels the pending or unread one-shot alert', () => {
  const ast = ts.createSourceFile('useWorkspaceStore.ts', store, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let actionSource = null;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)
      && node.name.getText(ast) === 'setTabCompletionNotificationPersistent') {
      actionSource = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(actionSource, 'execute the actual Zustand action');

  for (const initial of [
    { completionNotificationPersistent: true, completionNotificationArmed: true },
    { completionNotificationPersistent: true, completionNotificationFired: true, completionNotificationFiredAt: 123 },
  ]) {
    const tab = { ...initial };
    const workspace = { projectId: 'project', tabs: new Map([['tab', tab]]) };
    const openProjects = new Map([['project', workspace]]);
    const cleared = [];
    const saved = [];
    const published = [];
    const action = vm.runInNewContext(`(${actionSource})`, {
      get: () => ({ openProjects }),
      set: (value) => published.push(value),
      emitTabCompletionNotificationCleared: (value) => cleared.push(value),
      logRestartAfterState: () => {},
      saveTabs: (...args) => saved.push(args),
      console: { warn: () => {} },
    });

    action('project', 'tab', false);
    assert.equal(tab.completionNotificationPersistent, undefined);
    assert.equal(tab.completionNotificationArmed, undefined, 'no final one-shot bell remains');
    assert.equal(tab.completionNotificationFired, undefined, 'old unread signal is cleared');
    assert.equal(tab.completionNotificationFiredAt, undefined);
    assert.equal(cleared.length, 1, 'native unread mirror receives the clear');
    assert.equal(published.length, 1);
    assert.equal(saved.length, 1, 'persistent setting is saved');

    action('project', 'tab', true);
    assert.equal(tab.completionNotificationPersistent, true);
    assert.equal(tab.completionNotificationArmed, true, 'explicit re-enable arms the next completion');
    assert.equal(tab.completionNotificationFired, undefined);
    assert.equal(saved.length, 2);
  }
});

test('focusing a tab acknowledges only a fired alert and preserves a waiting one-shot bell', () => {
  const switchStart = store.indexOf('switchTab: (projectId, tabId) => {');
  const switchEnd = store.indexOf('\n\n  switchTabByIndex:', switchStart);
  const switchTab = store.slice(switchStart, switchEnd);
  const notificationStart = switchTab.indexOf('if (targetTab?.completionNotificationFired)');
  assert.ok(notificationStart >= 0, 'tab activation has an explicit fired-only acknowledgement');
  const acknowledgement = switchTab.slice(notificationStart, notificationStart + 900);
  assert.match(acknowledgement, /delete targetTab\.completionNotificationFired/);
  assert.match(acknowledgement, /delete targetTab\.completionNotificationFiredAt/);
  assert.doesNotMatch(acknowledgement, /delete targetTab\.completionNotificationArmed/);
  assert.match(acknowledgement, /source=tab-activation/);
});
