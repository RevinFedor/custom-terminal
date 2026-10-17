import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Inbox, Check, ChevronDown } from 'lucide-react';
import { automationInventory } from '../../utils/runAfterInventory.mjs';
import { resolveWorkflowIcon } from '../../utils/workflowVisuals.mjs';
import { summarizeRunningAutoCompacts } from '../../utils/autoCompactActivityPresentation.mjs';
import { INBOX_WORKFLOW_ID } from '../../utils/workflowMembership.mjs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const chip = read('./WorkflowChip.tsx');
const strip = read('./SpaceStrip.tsx');
const global = read('./GlobalRunAfterControl.tsx');
const picker = read('./RunAfterTabPicker.tsx');
const inventory = read('../../hooks/useAutomationInventory.ts');
const bells = read('./TabNotificationControls.tsx');
const bellStyles = read('./workspaceControlStyles.css');
const sidebar = read('./TabBar.tsx');
const selectSource = read('./AutomationWorkflowSelect.tsx');

// Execute the actual TSX; the selector's hooks/portal are controlled so its
// open menu and handlers can be inspected without a browser or store writes.
const ast = (source) => ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = (source, name) => {
  const tree = ast(source);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(tree).replace(/^export /, '');
};
function execute(code, scope = {}) {
  const context = { React, ...scope };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText, context);
  return context.result;
}
const layout = execute(read('../../constants/layout.ts') + '\nglobalThis.result = exports;', { exports: {} });
const chipModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(chip, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText, { exports: chipModule.exports, require(id) {
  if (id === 'react') return React;
  if (id === '../../store/useUIStore') return { useUIStore: selector => selector({ projectTabsFontSize: 13 }) };
  if (id === '../../constants/layout') return layout;
  if (id === 'lucide-react') return { Inbox };
  if (id === '../../utils/workflowMembership.mjs') return { INBOX_WORKFLOW_ID };
  throw new Error('Unexpected shared chrome dependency: ' + id);
} });
const SharedChip = chipModule.exports.default;
const Counter = execute(declaration(global, 'AutoCompactRunningIndicator') + '\nglobalThis.result = AutoCompactRunningIndicator;');
const Select = execute(declaration(selectSource, 'AutomationWorkflowSelect') + '\nglobalThis.result = AutomationWorkflowSelect;', {
  useState: initial => [typeof initial === 'boolean' ? true : initial, () => {}],
  useRef: value => ({ current: value }), useEffect() {}, useLayoutEffect() {},
  createPortal: node => node, document: { body: {} }, WorkflowChip: SharedChip,
  Check, ChevronDown, markQueueChildDismiss() {}, notifyQueueClickChildClosed() {},
});
const descendants = node => {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!React.isValidElement(node)) return [];
  return [node, ...descendants(node.props.children)];
};
function autoCompactSelect(props) {
  const tree = ast(global), found = [];
  const visit = node => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'AutomationWorkflowSelect'
      && node.openingElement.attributes.properties.some(p => ts.isJsxAttribute(p)
        && p.name.text === 'name' && p.initializer?.text === 'Auto-compact')) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  // The current call is self-closing. Accept exactly that call, not any chip
  // somewhere else in the file or a second competing implementation.
  const selfClosing = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'AutomationWorkflowSelect'
      && node.attributes.properties.some(p => ts.isJsxAttribute(p)
        && p.name.text === 'name' && p.initializer?.text === 'Auto-compact')) found.push(node);
    ts.forEachChild(node, selfClosing);
  };
  selfClosing(tree); assert.equal(found.length, 1);
  return execute('globalThis.result = (' + found[0].getText(tree) + ');', {
    AutomationWorkflowSelect: Select, AutoCompactRunningIndicator: Counter,
    settingsOwner: 'settings-owner', hydrated: true, UNPLACED_AUTOMATION_WORKFLOW: '__unplaced__', ...props,
  });
}
function inventoryFixture() {
  const spaces = [
    { id: 'explicit', name: 'Explicit', icon: 'own.svg', projectIds: ['legacy'] },
    { id: 'legacy', name: 'Legacy', projectIds: ['legacy'] },
    { id: 'cleared', name: 'Cleared', icon: null, projectIds: ['legacy'] },
  ];
  const tabs = new Map(spaces.map((space, index) => ['tab-' + index, {
    id: 'tab-' + index, name: space.name, commandType: 'codex', codexSessionId: 'sid-' + index,
  }]));
  const workspace = { spaces, organizationReady: true,
    openProjects: new Map([['catalog', { projectPath: '/private/test', tabs }]]),
    tabWorkflowMembership: Object.fromEntries(spaces.map((space, index) => ['tab-' + index, { workflowId: space.id, revision: index + 1 }])),
  };
  const metadata = { legacy: { name: 'Legacy project', icon: 'legacy.svg' } };
  return { workspace, metadata, inventory: automationInventory(workspace, metadata) };
}

test('navbar, compact scope and dependency picker share the workflow visual owner', () => {
  assert.match(strip, /<WorkflowChip[\s\S]{0,250}as="span"/);
  assert.match(picker, /<WorkflowChipPresentation workflowId=\{workflowId\}/);
  const { inventory } = inventoryFixture();
  const element = autoCompactSelect({ inventory, scope: { allWorkflows: false, workflowIds: ['explicit'], includeUnplaced: false },
    running: { workflowCounts: new Map() }, update() {} });
  assert.equal(element.type, Select); assert.equal(element.props.groups, inventory.groups);
  const rows = descendants(Select(element.props)).filter(node => node.props['data-automation-workflow-option']);
  assert.equal(rows.length, inventory.groups.length);
  for (const row of rows) {
    const shared = descendants(row).filter(node => node.type === SharedChip);
    assert.equal(shared.length, 1, 'each option must use the actual shared visual owner');
    assert.equal(shared[0].props.as, 'span');
    assert.equal(shared[0].props.workflowId, row.props['data-automation-workflow-option']);
    assert.equal(shared[0].props.icon, inventory.groups.find(group => group.id === shared[0].props.workflowId).icon);
  }
  assert.doesNotMatch(strip, /data-workflow-icon=|background: windowSwapTarget/);
  assert.doesNotMatch(picker, /workflowFallbackColor\(workflowId\)/);
  assert.match(chip, /height: PROJECT_CARD_MAX_H/);
  assert.match(chip, /useUIStore\(s => s\.projectTabsFontSize\)/);
  assert.match(chip, /data-workflow-icon=\{workflowId\}/);
  assert.match(chip, /width: 16, height: 16/);
  assert.match(chip, /transition: 'none'/);
});

test('compact inventory applies the same explicit/legacy/null icon resolver', () => {
  const fixture = inventoryFixture();
  assert.deepEqual(fixture.inventory.groups.map(group => group.icon), ['own.svg', 'legacy.svg', null]);
  const scoped = automationInventory(fixture.workspace, fixture.metadata, new Set(['tab-1']));
  assert.deepEqual(scoped.tabs.map(tab => tab.id), ['tab-1']);
  assert.deepEqual(scoped.groups.map(group => group.icon), ['own.svg', 'legacy.svg', null], 'counter-only filtering cannot change workflow icons');
  assert.match(inventory, /return automationInventory\(useWorkspaceStore\.getState\(\), useProjectsStore\.getState\(\)\.projects, tabIds\)/);
  const markup = fixture.inventory.groups.map(group => renderToStaticMarkup(React.createElement(SharedChip, {
    as: 'span', workflowId: group.id, label: group.name, icon: group.icon, selected: false,
  })));
  assert.match(markup[0], /src="own\.svg"/); assert.match(markup[1], /src="legacy\.svg"/);
  assert.doesNotMatch(markup[2], /<img/); assert.match(markup[2], /data-workflow-fallback-icon="cleared"/);
  assert.equal(resolveWorkflowIcon({ icon: undefined, projectIds: ['legacy'] }, () => 'legacy.svg'), 'legacy.svg');
  assert.match(strip, /resolveWorkflowIcon\(/);
  assert.match(picker, /resolveWorkflowIcon\(space/);
});

test('shared chrome cannot switch/remove a workflow or borrow navigation counters', () => {
  assert.doesNotMatch(chip, /useWorkspaceStore|switchWorkspaceSpace|removeWorkspaceSpace|processStatus|WorkflowActivityBadges/);
  const { inventory } = inventoryFixture();
  const running = summarizeRunningAutoCompacts({ 'tab-0': { phase: 'compacting' }, 'tab-1': { phase: 'idle' } }, inventory.tabs);
  const patches = [];
  const element = autoCompactSelect({ inventory, running,
    scope: { allWorkflows: false, workflowIds: ['explicit'], includeUnplaced: false }, update: patch => patches.push(patch) });
  const rows = descendants(Select(element.props)).filter(node => node.props['data-automation-workflow-option']);
  const explicit = rows.find(row => row.props['data-automation-workflow-option'] === 'explicit');
  const legacy = rows.find(row => row.props['data-automation-workflow-option'] === 'legacy');
  const ownCounter = descendants(explicit).find(node => node.type === Counter);
  assert.equal(ownCounter.props.count, 1); assert.equal(ownCounter.props.scope, 'explicit');
  assert.equal(descendants(legacy).filter(node => node.type === Counter).length, 0, 'another workflow cannot borrow its running count');
  legacy.props.onClick();
  assert.equal(JSON.stringify(patches), JSON.stringify([{ enabled: true, scopeInitialized: true, allWorkflows: false,
    workflowIds: ['explicit', 'legacy'], includeUnplaced: false }]));
  assert.equal(element.props.selectedIds.join(','), 'explicit', 'the caller owns selection publication');
  assert.equal(ownCounter.props.scope, 'explicit', 'selection must not retarget another workflow counter');
  assert.match(strip, /switchWorkspaceSpace\(id\)/);
  assert.match(strip, /<WorkflowActivityBadges/);
});

test('both bells have instant whole-button hover above their unchanged state tint', () => {
  assert.match(bells, /import '\.\/workspaceControlStyles\.css'/);
  assert.match(bellStyles, /\.tab-notification-control:hover\s*\{\s*background-image: linear-gradient/);
  assert.match(bellStyles, /\.tab-notification-control \{ transition: none; \}/);
  assert.match(bells, /onOnce\(!oneShotActive\); onAction\(\)/);
  assert.match(bells, /onPersistent\(!persistent\); onAction\(\)/);
  assert.match(sidebar, /<TabNotificationControls armed=\{isArmed\} fired=\{isFired\} persistent=\{isPersistent\}/);
  assert.match(sidebar, /setTabCompletionNotificationArmed\(projectId, contextMenu\.tabId, enabled\)/);
  assert.match(sidebar, /setTabCompletionNotificationPersistent\(projectId, contextMenu\.tabId, enabled\)/);
});
