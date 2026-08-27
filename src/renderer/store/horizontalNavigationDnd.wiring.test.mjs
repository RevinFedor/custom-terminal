import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
const strip = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'SpaceStrip.tsx'), 'utf8');
const tabBar = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'TabBar.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(renderer, 'hooks', 'useHorizontalOrderPreview.ts'), 'utf8');
const coordinator = fs.readFileSync(path.join(renderer, 'hooks', 'useConstrainedHorizontalReorder.ts'), 'utf8');
const nativePreview = fs.readFileSync(path.join(renderer, 'utils', 'horizontalRowDragPreview.ts'), 'utf8');
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');

test('project and workflow chips paint a live order before durable commit', () => {
  assert.match(app, /useHorizontalOrderPreview\([\s\S]{0,220}'\[data-project-reorder-item\]'/);
  assert.match(app, /sourceType: 'PROJECT_TAB'[\s\S]{0,260}preview: projectOrderPreview/);
  assert.match(strip, /useHorizontalOrderPreview\([\s\S]{0,220}'\[data-space-chip\]'/);
  assert.match(strip, /'data-space-chip',[\s\S]{0,80}\{ animate: false \}/);
  assert.match(strip, /sourceType: 'WORKSPACE_SPACE_CHIP'[\s\S]{0,260}preview: horizontalPreview/);
  assert.match(coordinator, /previewRef\.current\.updatePreview\(next\)/);
  assert.match(hook, /element\.animate\(/);
  assert.match(hook, /firstRectsRef\.current = animate \? capture\(\) : null/);
});

test('horizontal navigation reorder has one X-only owner and no insertion line', () => {
  assert.match(coordinator, /createHorizontalDragGeometryCache\(\)/);
  assert.match(coordinator, /excludedIds: \[sourceId\],[\s\S]{0,80}clientX,/);
  assert.match(coordinator, /pointerY=\$\{clientY[\s\S]{0,220}rowCenterY=\$\{rowCenterY[\s\S]{0,220}yIgnored=1/);
  assert.match(coordinator, /dropTargetForElements\([\s\S]{0,220}CONSTRAINED_HORIZONTAL_ROW/);
  assert.match(coordinator, /onDrop: \(\{ source \}\) => \{[\s\S]{0,80}finish/);
  assert.doesNotMatch(app, /ProjectDropIndicator|forceRightIndicator|attachClosestEdge/);
  assert.doesNotMatch(strip, /data-space-drop-edge|attachClosestEdge|extractClosestEdge/);
});

test('native ghost is hidden while the real chip stays in its row', () => {
  assert.match(app, /setHorizontalRowDragPreview\(nativeSetDragImage\)/);
  assert.match(strip, /setHorizontalRowDragPreview\(nativeSetDragImage\)/);
  assert.match(nativePreview, /width: '1px'[\s\S]{0,100}opacity: '0'/);
  assert.match(app, /opacity: isDragging \? 0\.72 : 1/);
  assert.match(strip, /opacity: dragging \? 0\.72 : 1/);
  assert.match(tabBar, /if \(!tabDndSourceDataRef\.current && !verticalDragGeometryRef\.current && !dragPreviewRef\.current\) return/,
    'inactive project TabBars must ignore project/workflow native dragend');
});

test('workflow reorder persists metadata without touching its layout', () => {
  assert.match(store, /reorderWorkspaceSpaces: \(orderedIds\) => \{/);
  assert.match(store, /reorderSpacesInList\(get\(\)\.spaces, orderedIds\)/);
  assert.match(store, /set\(\{ spaces: result\.spaces \}\)/);
});

test('pinned Inbox remains before reordered user projects', () => {
  assert.match(app, /const pinnedIds = currentIds\.filter\(\(id\) => isInboxProjectId\(id\)\)/);
  assert.match(app, /reorderProjects\(\[[\s\S]{0,180}\.\.\.pinnedIds,[\s\S]{0,120}\.\.\.nextIds/);
});
