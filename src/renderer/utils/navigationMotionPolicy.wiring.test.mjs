import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, '..', 'components', 'Workspace');
const read = (file) => fs.readFileSync(path.join(workspace, file), 'utf8');

const spaces = read('SpaceStrip.tsx');
const chrome = read('SplitPaneChrome.tsx');
const area = read('TerminalArea.tsx');
const history = read('HistoryPanel.tsx');
const pendingOperation = read('TabPendingOperation.tsx');
const workflowBadges = read('WorkflowActivityBadges.tsx');

test('workflow, pane hover/focus, and composer focus are immediate state', () => {
  const spaceStyle = spaces.slice(
    spaces.indexOf("transform: pointerHeld ? 'scale(0.985)'"),
    spaces.indexOf('opacity: dragging', spaces.indexOf("transform: pointerHeld ? 'scale(0.985)'")),
  );
  assert.match(spaceStyle, /transition: 'none'/);
  assert.doesNotMatch(spaceStyle, /\d+m?s\s+ease/);

  const focusFrame = chrome.slice(
    chrome.indexOf('export function SplitPaneFocusFrame'),
    chrome.indexOf('// ── Resizable dividers', chrome.indexOf('export function SplitPaneFocusFrame')),
  );
  assert.match(focusFrame, /transition: 'none'/);

  const hoverFrame = area.slice(
    area.indexOf('data-split-pane-hover-frame'),
    area.indexOf('/>', area.indexOf('data-split-pane-hover-frame')),
  );
  assert.match(hoverFrame, /transition: 'none'/);

  const composerCss = history.slice(
    history.indexOf('.hp-history-composer-frame {'),
    history.indexOf('.hp-history-composer-frame .cb-composer-main'),
  );
  assert.match(composerCss, /transition: none;/);
  assert.doesNotMatch(composerCss, /120ms|ease/);
});

test('workflow DnD keeps its resolver/commit while dropping visual fades', () => {
  assert.match(spaces, /useHorizontalOrderPreview\(/);
  assert.match(spaces, /'data-space-chip',[\s\S]{0,80}\{ animate: false \}/);
  assert.match(spaces, /useConstrainedHorizontalReorder\(\{/);
  assert.match(spaces, /onCommit: commitSpaceOrder/);
  assert.match(spaces, /onDragStart: \(\) => \{[\s\S]{0,180}setDragging\(true\)/);
  assert.match(spaces, /onDrop: \(\) => setDragging\(false\)/);
  assert.doesNotMatch(spaces, /background 90ms|border-color 90ms|color 90ms/);
});

test('pending operation is a static orange fact, not a frozen spinner', () => {
  assert.match(pendingOperation, /data-tab-pending-operation-indicator/);
  assert.match(pendingOperation, /background: '#f59e0b'/);
  assert.match(pendingOperation, /animation: 'none'/);
  assert.doesNotMatch(pendingOperation, /tab-dot-spin|borderTopColor/);
  assert.match(workflowBadges, /boxShadow: 'inset 0 0 0 1\.5px #f59e0b'/);
  assert.doesNotMatch(workflowBadges, /noted-shape-ring/);
});
