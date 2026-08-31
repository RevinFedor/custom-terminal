import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(renderer, ...parts), 'utf8');

const hook = read('hooks/useInlineRenameInput.ts');
const tabBar = read('components/Workspace/TabBar.tsx');
const paneChip = read('components/Workspace/PaneTabChip.tsx');
const spaceStrip = read('components/Workspace/SpaceStrip.tsx');
const projectHome = read('components/Workspace/ProjectHome.tsx');
const settings = read('components/UI/SettingsModal.tsx');
const projectSettings = read('components/UI/ProjectIconsSettings.tsx');
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');

test('one callback-ref contract focuses/selects names exactly when their input mounts', () => {
  assert.match(hook, /if \(selectedNodeRef\.current === node\) return/);
  assert.match(hook, /focusAndSelectInlineName\(node\)/);
  assert.doesNotMatch(hook, /requestAnimationFrame|setTimeout/);

  assert.match(tabBar, /useInlineRenameInputRef\(Boolean\(editingTabId \|\| editingGroupId\)\)/);
  assert.match(app, /useInlineRenameInputRef\(isEditing\)/);
  assert.match(projectHome, /useInlineRenameInputRef\(isDraft\)/);
  assert.match(projectHome, /useInlineRenameInputRef\(isEditingName\)/);
  assert.match(projectSettings, /useInlineRenameInputRef\(focusOnMount\)/);
  assert.match(settings, /useInlineRenameInputRef\(promptTreeRename !== null\)/);
  assert.match(paneChip, /useInlineRenameInputRef\(renaming\)/);
  assert.match(spaceStrip, /useInlineRenameInputRef\(renaming\)/);
});

test('group creation and delayed group rows use the same ref as tab rename', () => {
  assert.match(tabBar, /const handleCreateGroupWithRename = \(\) => \{[\s\S]{0,400}startGroupRename\(nextGroup\)/);
  const refRoutes = tabBar.match(/inputRef=\{inputRef\}/g) || [];
  assert.ok(refRoutes.length >= 5, 'all tab/group render paths receive the mount-driven rename ref');
  assert.doesNotMatch(tabBar, /inputRef\.current\.focus\(\)[\s\S]{0,80}inputRef\.current\.select\(\)/);
});
