import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');
const store = fs.readFileSync(path.join(here, '..', '..', 'store', 'useWorkspaceStore.ts'), 'utf8');
const groupHeader = tabBar.slice(
  tabBar.indexOf('const TabGroupHeader = memo'),
  tabBar.indexOf('const EmptyDropZone = memo'),
);
const groupMenu = tabBar.slice(
  tabBar.indexOf('{/* Group context menu */}'),
  tabBar.indexOf('{commandHistoryPopover &&'),
);

test('folder rows have no status marker or reserved status column', () => {
  assert.doesNotMatch(groupHeader, /group\.sessionStatus/);
  assert.doesNotMatch(groupHeader, /statusMarkerShape|statusMarkerSize|sessionStatuses/);
  assert.match(groupHeader, /padding: `\$\{tabGeo\.paddingY\}px \$\{tabGeo\.paddingX\}px`/);
  assert.match(groupHeader, /data-group-collapse-button/);
});

test('folder menu removes status assignment but keeps background color', () => {
  assert.doesNotMatch(groupMenu, /data-tab-group-context-action="status"/);
  assert.doesNotMatch(groupMenu, /setTabGroupSessionStatus/);
  assert.match(groupMenu, /data-tab-group-context-action="background"/);
  assert.match(groupMenu, /setTabGroupColor\(projectId, group\.id, c\.color\)/);
});

test('legacy group status data remains readable and is not destructively migrated', () => {
  assert.match(store, /setTabGroupSessionStatus:/);
  assert.match(store, /sessionStatus: status \|\| undefined/);
});
