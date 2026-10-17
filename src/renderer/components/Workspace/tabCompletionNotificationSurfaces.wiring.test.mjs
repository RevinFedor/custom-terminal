import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bell } from 'lucide-react';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(workspaceDir, '..', '..');
const signals = readFileSync(join(workspaceDir, 'TabSignals.tsx'), 'utf8');
const sidebar = readFileSync(join(workspaceDir, 'TabBar.tsx'), 'utf8');
const menuControls = readFileSync(join(workspaceDir, 'TabNotificationControls.tsx'), 'utf8');
const pane = readFileSync(join(workspaceDir, 'PaneTabChip.tsx'), 'utf8');
const card = readFileSync(join(workspaceDir, 'TabCard.tsx'), 'utf8');
const store = readFileSync(join(rendererDir, 'store/useWorkspaceStore.ts'), 'utf8');
const css = readFileSync(join(rendererDir, 'styles/globals.css'), 'utf8');

test('sidebar and pane chip share an unread completion ring and notification-mode bell', () => {
  assert.match(signals, /export function useTabCompletionNotificationDismissing/);
  assert.match(signals, /export function TabCompletionNotificationBadge/);
  assert.match(signals, /export function TabCompletionNotificationAlert/);

  assert.match(pane, /<TabCard/);
  for (const source of [sidebar, card]) {
    assert.match(source, /<TabCompletionNotificationAlert fired=\{(?:completionNotificationFired|fired)\}/);
    assert.match(source, /<TabCompletionNotificationBadge armed=\{(?:completionNotificationArmed|armed)\}/);
    assert.match(source, /persistent=\{(?:completionNotificationPersistent|persistent)\}/);
  }

  assert.match(card, /completionNotificationArmed === true/);
  assert.match(card, /completionNotificationFired === true/);
  assert.match(card, /completionNotificationPersistent === true/);
  assert.match(card, /showShownStripe && \(shown \|\| pressed\)/);
  assert.match(css, /\.tab-completion-notification-alert \{/);
  assert.match(css, /\.tab-completion-notification-alert--dismiss \{/);
});

test('the unread overlay preserves error, availability and selection visuals', () => {
  assert.match(card, /border: hiddenErrors > 0 \? '1px solid #f87171'/);
  assert.match(card, /sessionAvailabilityRailShadow\(availability\)/);
  assert.match(sidebar, /sessionAvailabilityRailShadow\(sessionAvailability\)/);
  assert.match(sidebar, /isDragBlockedTarget \? 'inset 0 0 0 1\.5px rgba\(248, 113, 113, 0\.86\)'/);
  assert.match(sidebar, /if \(isSelected\)/);
  assert.match(sidebar, /return '2px dashed rgba\(255,255,255,0\.3\)'/);
});

test('the shared frame follows unread and dismissal without changing layout or hit targets', () => {
  const ast = ts.createSourceFile('TabSignals.tsx', signals, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'TabCompletionNotificationAlert');
  assert.ok(declaration);
  let dismissing = false;
  const context = vm.createContext({ React, useTabCompletionNotificationDismissing: () => dismissing });
  vm.runInContext(ts.transpile(declaration.getText(ast).replace(/^export /, ''), {
    jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022,
  }) + '\nthis.Alert = TabCompletionNotificationAlert;', context);
  const render = fired => renderToStaticMarkup(React.createElement(context.Alert, { fired }));
  assert.equal(render(false), '', 'armed/persistent without unread adds no frame');
  const unread = render(true);
  assert.match(unread, /data-tab-completion-notification-ring/);
  assert.match(unread, /class="tab-completion-notification-alert"/);
  assert.match(unread, /position:absolute;inset:0;border-radius:inherit;z-index:4/);
  assert.match(unread, /aria-hidden="true"/);
  dismissing = true;
  assert.match(render(false), /tab-completion-notification-alert--dismiss/);
  assert.doesNotMatch(render(true), /tab-completion-notification-alert--dismiss/,
    'a new unread completion takes precedence over an old fade');
  dismissing = false;
  assert.equal(render(false), '', 'the expired fade leaves no overlay');
  assert.match(css, /\.tab-completion-notification-alert \{[^}]*pointer-events: none;/);
  const workflow = readFileSync(join(workspaceDir, 'WorkflowActivityBadges.tsx'), 'utf8');
  assert.match(workflow, /className=\{`tab-completion-notification-alert/,
    'the exact same CSS owns the workflow and tab animation');
  const pause = readFileSync(join(rendererDir, 'styles/presentationAnimations.css'), 'utf8');
  assert.match(pause, /\.tab-completion-notification-alert,/);
  assert.match(pause, /\.tab-completion-notification-alert\.tab-completion-notification-alert--dismiss \{\s*animation-play-state: paused, running !important;/);
});

test('the two bells keep distinct one-shot and persistent semantics', () => {
  const menuStart = menuControls.indexOf('data-tab-context-action="notify-once"');
  const menuEnd = menuControls.indexOf('data-tab-context-action="notify-persistent"', menuStart);
  const oneShot = menuControls.slice(menuStart, menuEnd);
  const persistent = menuControls.slice(menuEnd, menuControls.indexOf('</Tooltip>', menuEnd));
  assert.match(oneShot, /onOnce\(!oneShotActive\)/);
  assert.match(sidebar, /onOnce=\{enabled => setTabCompletionNotificationArmed\(projectId, contextMenu\.tabId, enabled\)\}/);
  assert.doesNotMatch(oneShot, /title=\{notificationTitle\}/, 'bell help must use the custom tooltip, never native title');
  assert.match(menuControls.slice(menuControls.lastIndexOf('<Tooltip', menuStart), menuEnd), /content=\{notificationTitle\}/);
  assert.match(persistent, /onPersistent\(!persistent\)/);
  assert.match(sidebar, /onPersistent=\{enabled => setTabCompletionNotificationPersistent\(projectId, contextMenu\.tabId, enabled\)\}/);
  assert.match(oneShot, /<TabCompletionNotificationIcon color=\{tint\}/);
  assert.match(persistent, /<TabCompletionNotificationIcon persistent/);
  assert.doesNotMatch(oneShot + persistent, /<BellRing/);

  const persistentStore = store.slice(
    store.indexOf('setTabCompletionNotificationPersistent: (projectId, tabId, persistent) => {'),
    store.indexOf('\n\n  clearTabCompletionNotification:', store.indexOf('setTabCompletionNotificationPersistent:')),
  );
  assert.match(persistentStore, /tab\.completionNotificationPersistent = true/);
  assert.match(persistentStore, /tab\.completionNotificationArmed = true/);
  assert.match(persistentStore, /saveTabs\(workspace\.projectId, workspace\.tabs\)/);
});

test('bell silhouette names the mode independently of its active color', () => {
  const ast = ts.createSourceFile('TabSignals.tsx', signals, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['TabCompletionNotificationIcon', 'TabCompletionNotificationBadge', 'tabFastBadgeOutsidePx'];
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  const js = ts.transpile(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n'), {
    jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022,
  });
  const context = vm.createContext({ React, Bell, TAB_PROCESS_BAR_W_PX: 3,
    TAB_FAST_BADGE_SIZE_PX: 11, TAB_FAST_BADGE_OUTSIDE_RATIO: 0.3,
    useUIStore: select => select({ tabGeometry: { gap: 4 } }),
  });
  vm.runInContext(js + '\nthis.Icon = TabCompletionNotificationIcon; this.Badge = TabCompletionNotificationBadge;', context);
  for (const color of ['#888', '#f87171']) {
    assert.match(renderToStaticMarkup(React.createElement(context.Icon, { color })), /fill="none"/);
    assert.match(renderToStaticMarkup(React.createElement(context.Icon, { persistent: true, color })), /fill="currentColor"/);
  }
  const render = props => renderToStaticMarkup(React.createElement(context.Badge, props));
  assert.equal(render({ armed: false, persistent: false, fired: false }), '');
  const once = render({ armed: true, persistent: false, fired: false });
  assert.match(once, /data-tab-notification-mode="once"/);
  assert.match(once, /right:0;top:-2px/);
  assert.match(once, /width:3px;height:11px/, 'the anchor stays inside the rail to avoid scroll overflow');
  assert.match(once, /width="3" height="11"/);
  assert.match(once, /preserveAspectRatio="xMidYMid slice"/);
  assert.match(once, /overflow:visible/, 'the full-size bell extends as vector ink, not an oversized HTML box');
  assert.match(once, /color:#f87171/);
  assert.match(once, /fill="none"/);
  const persistent = render({ armed: false, persistent: true, fired: false });
  assert.match(persistent, /data-tab-notification-mode="persistent"/);
  assert.match(persistent, /fill="currentColor"/);
  assert.match(persistent, /color:#f87171/);
  const fired = render({ armed: false, persistent: false, fired: true });
  assert.match(fired, /color:#ef4444/);
  assert.match(fired, /fill="none"/, 'a fired one-shot is not reclassified as persistent');
  assert.doesNotMatch(once + persistent, /animation|animate-spin/);
});

test('turning off persistent notifications also cancels the pending or unread one-shot alert', async () => {
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
    const action = vm.runInNewContext(ts.transpileModule(`(${actionSource})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      get: () => ({ openProjects }),
      set: (value) => published.push(value),
      emitTabCompletionNotificationCleared: (value) => cleared.push(value),
      emitTabCompletionNotificationStateChanged: () => {},
      logRestartAfterState: () => {},
      saveTabs: (...args) => { saved.push(args); return Promise.resolve({success:true}); },
      console: { warn: () => {} },
    });

    await action('project', 'tab', false);
    assert.equal(tab.completionNotificationPersistent, undefined);
    assert.equal(tab.completionNotificationArmed, undefined, 'no final one-shot bell remains');
    assert.equal(tab.completionNotificationFired, undefined, 'old unread signal is cleared');
    assert.equal(tab.completionNotificationFiredAt, undefined);
    assert.equal(cleared.length, 1, 'native unread mirror receives the clear');
    assert.equal(published.length, 1);
    assert.equal(saved.length, 1, 'persistent setting is saved');

    await action('project', 'tab', true);
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
