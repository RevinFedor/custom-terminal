import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
const strip = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'SpaceStrip.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(renderer, 'hooks', 'useHorizontalOrderPreview.ts'), 'utf8');
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');

test('project and workflow chips paint a live order before durable commit', () => {
  assert.match(app, /useHorizontalOrderPreview\([\s\S]{0,220}'\[data-project-id\]'/);
  assert.match(app, /onDrag\(\{ source, location \}\)[\s\S]{0,700}projectOrderPreview\.updatePreview/);
  assert.match(strip, /useHorizontalOrderPreview\([\s\S]{0,220}'\[data-space-chip\]'/);
  assert.match(strip, /onDrag: \(\{ source, location \}\)[\s\S]{0,700}horizontalPreview\.updatePreview/);
  assert.match(hook, /element\.animate\(/);
});

test('workflow reorder persists metadata without touching its layout', () => {
  assert.match(store, /reorderWorkspaceSpaces: \(orderedIds\) => \{/);
  assert.match(store, /reorderSpacesInList\(get\(\)\.spaces, orderedIds\)/);
  assert.match(store, /set\(\{ spaces: result\.spaces \}\)/);
});

test('pinned Inbox remains before reordered user projects', () => {
  assert.match(app, /const pinnedIds = currentIds\.filter\(\(id\) => isInboxProjectId\(id\)\)/);
  assert.match(app, /reorderProjects\(\[[\s\S]{0,180}\.\.\.pinnedIds,[\s\S]{0,120}\.\.\.preview/);
});
