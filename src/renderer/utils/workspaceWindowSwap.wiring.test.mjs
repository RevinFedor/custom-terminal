import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const chrome = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'SplitPaneChrome.tsx'), 'utf8');
const picker = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'MoveToWindowMenu.tsx'), 'utf8');
const spaces = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'SpaceStrip.tsx'), 'utf8');
const store = fs.readFileSync(path.join(renderer, 'store', 'useWorkspaceStore.ts'), 'utf8');

test('ellipsis opens a click-pinned cross-workflow window swap picker', () => {
  assert.match(chrome, /data-split-strip-menu-item="swap-workspace-window"/);
  assert.match(chrome, /beginWorkspaceWindowSwapPicker\(\{[\s\S]{0,180}sourceSpaceId: activeSpaceId/);
  assert.match(chrome, /<WorkspaceWindowSwapPicker anchorRef=\{stripMenuButtonRef\}/);
  assert.match(picker, /data-workspace-window-swap-picker/);
  assert.match(picker, /side="left"/);
});

test('workflow click changes picker scope before the normal navigation branch', () => {
  const click = spaces.slice(spaces.indexOf('onClick={(e) => {', spaces.indexOf('data-space-chip=')));
  assert.match(click, /if \(windowSwapPicker\.active\)[\s\S]{0,260}selectWorkspaceWindowSwapTarget\(id\)[\s\S]{0,260}return;/);
  assert.ok(
    click.indexOf('selectWorkspaceWindowSwapTarget(id)') < click.indexOf('switchWorkspaceSpace(id)'),
    'picker interception must happen before normal workflow navigation',
  );
  assert.match(spaces, /data-workspace-swap-target=\{windowSwapTarget/);
});

test('cross-workflow commit swaps two snapshots without switching active workflow', () => {
  const actionStart = store.indexOf('swapWorkspaceWindows: (');
  const actionEnd = store.indexOf('\n\n  reorderSplitPaneTab:', actionStart);
  const action = store.slice(actionStart, actionEnd);
  assert.match(action, /swapWorkspaceLayoutWindows\(/);
  assert.match(action, /if \(space\.id === sourceSpaceId\)/);
  assert.match(action, /if \(space\.id === targetSpaceId\)/);
  assert.match(action, /set\(\{[\s\S]*spaces,[\s\S]*splitPanes:/);
  assert.doesNotMatch(action, /switchWorkspaceSpace\(/);
  assert.match(picker, /spacesWithLiveLayout\(st\.spaces, st\.activeSpaceId, st\)/);
});
