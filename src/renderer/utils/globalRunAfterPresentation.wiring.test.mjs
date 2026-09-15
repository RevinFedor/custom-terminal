import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, '..', 'components', 'Workspace');
const globalPanel = fs.readFileSync(path.join(workspace, 'GlobalRunAfterControl.tsx'), 'utf8');
const queueOverlay = fs.readFileSync(path.join(workspace, 'PromptQueueOverlay.tsx'), 'utf8');

test('global overview uses natural height and a floating queue surface', () => {
  assert.match(globalPanel, /heightFixed: parsed\.heightFixed === true/,
    'legacy fixed canvas height must not survive as an intentional user choice');
  assert.match(globalPanel, /height: panelSize\.heightFixed \? position\.height : 'auto'/);
  assert.match(globalPanel, /data-global-run-after-floating-editor/);
  assert.match(globalPanel, /data-run-after-satellite="true"/);
  assert.doesNotMatch(globalPanel, /data-global-run-after-editor-area/,
    'opening one queue must not append a block to the overview flow');
  assert.match(globalPanel, /embeddedWidth=\{editorPosition\.width\}/);
  assert.match(globalPanel, /embeddedMaxHeight=\{Math\.max\(90, editorPosition\.maxHeight - 11\)\}/);
  assert.match(queueOverlay, /embeddedWidth\?: number/);
  assert.match(queueOverlay, /embeddedMaxHeight\?: number/);
  assert.match(globalPanel, /const ownerRect = trigger\.closest<HTMLElement>\('\[data-global-run-after-node\]'\)/);
  assert.match(globalPanel, /const left = clamp\(ownerRect\.right - width/,
    'floating editor must align to its whole owner node, not leave the next Play beside its edge');
  assert.match(globalPanel, /const gap = 3;/);
  assert.match(queueOverlay, /background: embedded \? '#141414' : PANEL_BG/,
    'covered graph controls must not show through the floating editor');
  assert.match(globalPanel, /const liveRect = panelRef\.current\?\.getBoundingClientRect\(\)/,
    'auto-height resize must start from the visible panel, not its stored ceiling');
});

test('project identity is outside the canonical opaque tab chip', () => {
  const icon = globalPanel.indexOf('data-global-run-after-project-icon');
  const tab = globalPanel.indexOf('data-global-run-after-tab-chip');
  assert.ok(icon >= 0 && tab > icon, 'project icon must be the tab chip sibling on its left');
  assert.match(globalPanel, /flattenRgbaOnTabbarPanel\(resolveTabCardBackground/);
  assert.match(globalPanel, /border: 'none'/);
  assert.match(globalPanel, /width: 12,\n\s+flex: '0 0 12px'/,
    'project icon slot must use the same 12px measure as PaneTabStrip');
  assert.match(globalPanel, /const nodeHeight = Math\.max\(1, resolveTabCardBoxHeight[\s\S]{0,120}- 2\)/,
    'graph node height removes the helper border reserve because the visible pane chip is borderless');
  assert.match(globalPanel, /const GRAPH_NODE_W = 270/);
  assert.ok((globalPanel.match(/width: 26,/g) || []).length >= 2,
    'count and Play/Pause use the compact local-control measure');
});

test('global resize owns only its handle and commits React state once', () => {
  assert.match(globalPanel, /usePointerGesture\(\)/);
  assert.doesNotMatch(globalPanel, /document\.body\.style\.(?:cursor|userSelect)/);
  const moveStart = globalPanel.indexOf('onMove: (moveEvent) => {', globalPanel.indexOf('const startResize'));
  const moveEnd = globalPanel.indexOf('onEnd: (reason) => {', moveStart);
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
