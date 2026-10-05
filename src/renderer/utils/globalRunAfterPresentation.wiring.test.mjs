import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, '..', 'components', 'Workspace');
const globalPanel = fs.readFileSync(path.join(workspace, 'GlobalRunAfterControl.tsx'), 'utf8');
const queueOverlay = fs.readFileSync(path.join(workspace, 'PromptQueueOverlay.tsx'), 'utf8');

test('global overview has natural height and uses the shared editor in normal flow', () => {
  assert.match(globalPanel, /resizeEnabled: parsed\.resizeEnabled === true/);
  assert.doesNotMatch(globalPanel, /parsed\.heightFixed/);
  assert.match(globalPanel, /height: panelSize\.resizeEnabled \? position\.height : 'auto'/);
  assert.match(globalPanel, /width: panelSize\.resizeEnabled \? position\.width : fittedWidth/);
  assert.match(globalPanel, /data-global-run-after-resize-toggle/);
  assert.match(globalPanel, /\{panelSize\.resizeEnabled && <>/);
  assert.match(globalPanel, /data-global-run-after-inline-editor/);
  assert.match(globalPanel, /embedded overview/);
  assert.doesNotMatch(globalPanel, /data-global-run-after-floating-editor|data-global-run-after-editor-trigger/);
  assert.match(queueOverlay, /overflowY: overview \? 'visible' : 'auto'/);
  assert.match(globalPanel, /const liveRect = panelRef\.current\?\.getBoundingClientRect\(\)/);
});

test('global owner uses the whole content-sized TabCard without redundant step count or task lane', () => {
  const icon = globalPanel.indexOf('data-global-run-after-project-icon');
  const tab = globalPanel.indexOf('data-global-run-after-tab-chip');
  assert.ok(icon >= 0 && tab > icon);
  assert.match(globalPanel, /<TabCard as="button"/);
  assert.doesNotMatch(globalPanel, /data-global-run-after-step-count/);
  assert.match(globalPanel, /showTaskMarkers=\{false\}/);
  assert.doesNotMatch(globalPanel, /active=\{active\} fullWidth/);
  assert.match(globalPanel, /data-global-run-after-condition-mark/);
  assert.doesNotMatch(globalPanel, /function QueueStatusMarks/);
});

test('global resize owns only its handle and commits React state once', () => {
  assert.match(globalPanel, /usePointerGesture\(\)/);
  assert.doesNotMatch(globalPanel, /document\.body\.style\.(?:cursor|userSelect)/);
  const moveStart = globalPanel.indexOf('onMove: (moveEvent) => {', globalPanel.indexOf('const startResize'));
  const moveEnd = globalPanel.indexOf('onEnd: (reason, endEvent) => {', moveStart);
  assert.ok(moveStart >= 0 && moveEnd > moveStart);
  const moveBody = globalPanel.slice(moveStart, moveEnd);
  assert.match(moveBody, /panelRef\.current\.style\.width/);
  assert.match(moveBody, /panelRef\.current\.style\.height/);
  assert.doesNotMatch(moveBody, /setPanelSize\(/,
    'pointermove must not rerender the whole graph');
  const endBody = globalPanel.slice(moveEnd, globalPanel.indexOf('});', moveEnd) + 3);
  assert.match(endBody, /setPanelSize\(/);
});

test('active autocompact is visible globally, by workflow, and on the collapsed trigger', () => {
  assert.match(globalPanel, /summarizeRunningAutoCompacts\(activities, inventory\.tabs\)/);
  assert.match(globalPanel, /data-auto-compact-running-scope=\{scope\}/,
    'the page tab and each workflow use the same numbered loader');
  assert.match(globalPanel, /running\.workflowCounts\.get\(group\.id\)/,
    'workflow badges must reflect only their own running compacts');
  assert.match(globalPanel, /mode === 'hidden' && runningCompacts\.total > 0/,
    'the compact global trigger marker belongs to the collapsed presentation');
  assert.match(globalPanel, /data-global-run-after-auto-compact-edge/);
  assert.match(globalPanel, /width: 1, overflow: 'hidden'/,
    'the collapsed marker stays a thin left edge instead of adding another count');
});
