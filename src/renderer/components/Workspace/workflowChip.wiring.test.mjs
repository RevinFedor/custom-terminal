import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const chip = read('./WorkflowChip.tsx');
const strip = read('./SpaceStrip.tsx');
const global = read('./GlobalRunAfterControl.tsx');
const picker = read('./RunAfterTabPicker.tsx');
const inventory = read('../../hooks/useAutomationInventory.ts');
const bells = read('./TabNotificationControls.tsx');
const sidebar = read('./TabBar.tsx');

test('navbar, compact scope and dependency picker share the workflow visual owner', () => {
  assert.match(strip, /<WorkflowChip[\s\S]{0,250}as="span"/);
  assert.match(global, /<WorkflowChip key=\{group\.id\}/);
  assert.match(picker, /<WorkflowChipPresentation workflowId=\{workflowId\}/);
  assert.doesNotMatch(strip, /data-workflow-icon=|background: windowSwapTarget/);
  assert.doesNotMatch(picker, /workflowFallbackColor\(workflowId\)/);
  assert.match(chip, /height: PROJECT_CARD_MAX_H/);
  assert.match(chip, /useUIStore\(s => s\.projectTabsFontSize\)/);
  assert.match(chip, /data-workflow-icon=\{workflowId\}/);
  assert.match(chip, /width: 16, height: 16/);
  assert.match(chip, /transition: 'none'/);
});

test('compact inventory applies the same explicit/legacy/null icon resolver', () => {
  assert.match(inventory, /resolveWorkflowIcon\(s, \(id: string\) => metadata\.get\(id\)\?\.\[1\] \|\| null\)/);
  assert.match(strip, /resolveWorkflowIcon\(/);
  assert.match(picker, /resolveWorkflowIcon\(space/);
  assert.match(global, /icon=\{group\.icon\}/);
});

test('shared chrome cannot switch/remove a workflow or borrow navigation counters', () => {
  assert.doesNotMatch(chip, /useWorkspaceStore|switchWorkspaceSpace|removeWorkspaceSpace|processStatus|WorkflowActivityBadges/);
  assert.match(global, /workflowIds: policy\.workflowIds\.includes\(group\.id\)/);
  assert.match(strip, /switchWorkspaceSpace\(id\)/);
  assert.match(strip, /<WorkflowActivityBadges/);
  assert.match(global, /AutoCompactRunningIndicator count=\{runningCount\} scope=\{group\.id\}/);
});

test('both bells have instant whole-button hover above their unchanged state tint', () => {
  assert.match(bells, /\.tab-notification-control:hover\s*\{\s*background-image: linear-gradient/);
  assert.match(bells, /\.tab-notification-control \{ transition: none; \}/);
  assert.match(bells, /onOnce\(!oneShotActive\); onAction\(\)/);
  assert.match(bells, /onPersistent\(!persistent\); onAction\(\)/);
  assert.match(sidebar, /<TabNotificationControls armed=\{isArmed\} fired=\{isFired\} persistent=\{isPersistent\}/);
  assert.match(sidebar, /setTabCompletionNotificationArmed\(projectId, contextMenu\.tabId, enabled\)/);
  assert.match(sidebar, /setTabCompletionNotificationPersistent\(projectId, contextMenu\.tabId, enabled\)/);
});
